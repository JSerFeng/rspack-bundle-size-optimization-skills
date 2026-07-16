#!/usr/bin/env node
// Render normalized bundle-audit data as a polished, dependency-free HTML
// report. Large details and source are sharded and loaded only on selection.

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { createHash } = require('crypto');
const { basename, dirname, resolve } = require('path');
const { tmpdir } = require('os');

const CHECKS = [
  ['baseline', '生产基线'],
  ['reachability', 'Chunk 可达性'],
  ['retained-unused', '保留的未使用模块'],
  ['side-effects', '副作用源码审查'],
  ['export-usage', 'Export 使用根因'],
  ['rollup-diff', 'Rollup 对比'],
  ['cjs2esm', 'CJS → ESM'],
  ['splitchunks', 'splitChunks'],
  ['ecma', 'ECMA 目标'],
  ['post-loader', 'Loader 后源码质量'],
];
const STATES = new Set(['completed', 'completed-no-op', 'blocked']);
const EMBED_LIMIT = 2 * 1024 * 1024;
const SOURCE_SERVER_THRESHOLD = 5 * 1024 * 1024;
const CORE_ROW_THRESHOLD = 2000;

function parseArgs(argv) {
  const result = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else { result[key] = next; i += 1; }
  }
  return result;
}

function stableId(value, prefix) {
  const readable = String(value || prefix).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  const hash = createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
  return `${prefix}-${readable || 'item'}-${hash}`;
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function normalizeChecks(inputChecks) {
  const byId = new Map((inputChecks || []).map((check) => [check.id, check]));
  return CHECKS.map(([id, name]) => {
    const value = byId.get(id);
    if (!value) return { id, name, state: 'blocked', result: '报告输入缺少该检查', evidence: null, command: null, error: 'missing normalized check row' };
    const state = STATES.has(value.state) ? value.state : 'blocked';
    return {
      id,
      name: value.name || name,
      state,
      result: value.result || (state === 'blocked' ? '缺少明确结果' : ''),
      evidence: value.evidence || value.artifact || null,
      command: value.command || value.nextCommand || null,
      error: value.error || null,
    };
  });
}

function sourceTextOf(source) {
  if (typeof source.source === 'string') return source.source;
  if (source.sourceFile) return readFileSync(resolve(source.sourceFile), 'utf8');
  return '';
}

function normalizeReport(input, title) {
  if (!input || typeof input !== 'object') throw new Error('Report input must be a JSON object');
  if (!input.runId) throw new Error('Report input must contain runId for stale-artifact rejection');
  const checks = normalizeChecks(input.checks);
  const sourceRows = input.sources || [];
  const sources = sourceRows.map((source, index) => {
    const path = source.path || source.resource || `source-${index + 1}`;
    const id = source.id || stableId(path, 'source');
    return {
      id,
      path,
      language: source.language || 'javascript',
      quality: source.quality || null,
      ranges: source.ranges || source.highlights || [],
      source: sourceTextOf(source),
    };
  });
  const sourceIds = new Set(sources.map((source) => source.id));
  const rawItems = input.modules?.length ? input.modules : (input.optimizations || []);
  const items = rawItems.map((item, index) => {
    const path = item.modulePath || item.path || item.resource || item.title || item.name || `item-${index + 1}`;
    const id = item.id || stableId(path, 'item');
    const sourceId = item.sourceId || (sourceIds.has(item.id) ? item.id : null);
    return {
      id,
      title: item.title || item.name || basename(path),
      modulePath: path,
      status: item.status || item.class || 'candidate',
      unusedBytes: Number(item.unusedBytes || item.retainedUnusedBytes || 0),
      totalBytes: Number(item.totalBytes || item.moduleSize || 0),
      rawSavingBytes: Number(item.rawSavingBytes || item.confirmedRawSavingBytes || 0),
      gzipSavingBytes: Number(item.gzipSavingBytes || item.confirmedGzipSavingBytes || 0),
      why: item.why || item.reason || '',
      sourceId,
      detail: {
        result: item.result || null,
        why: item.why || item.reason || '',
        evidence: item.evidence || [],
        code: item.code || null,
        risk: item.risk || '',
        validation: item.validation || item.nextValidation || '',
        links: item.links || [],
        sourceId,
      },
    };
  });
  const optimizationRows = input.optimizations?.length ? input.optimizations : rawItems;
  const optimizations = optimizationRows.map((item, index) => ({
    id: item.id || stableId(item.title || item.name || item.path || index, 'optimization'),
    title: item.title || item.name || item.path || `Optimization ${index + 1}`,
    status: item.status || item.class || 'candidate',
    classification: item.classification || item.class || item.status || 'candidate',
    rawSavingBytes: Number(item.rawSavingBytes || item.confirmedRawSavingBytes || 0),
    gzipSavingBytes: Number(item.gzipSavingBytes || item.confirmedGzipSavingBytes || 0),
    why: item.why || item.reason || '',
    validation: item.validation || item.nextValidation || '',
  })).sort((a, b) => b.rawSavingBytes - a.rawSavingBytes || a.title.localeCompare(b.title));
  const measurement = {
    raw: '产物文件未压缩字节数；报告排序和结论的主指标',
    gzip: '同一产物的 gzip 传输代理；仅作为次指标',
    appJs: '由本次 run 明确列出的业务 JavaScript 资产集合',
    minify: '生产可比构建必须与基线保持一致',
    concatenateModules: '生产可比构建必须与基线保持一致；仅诊断构建可临时关闭',
    ...(input.measurement || {}),
  };
  const analyses = (input.analyses || input.relatedPages || []).map((row, index) => ({
    id: row.id || stableId(row.title || row.label || row.path || index, 'analysis'),
    title: row.title || row.label || row.name || `Analysis ${index + 1}`,
    href: row.href || row.path || null,
    status: row.status || (row.href || row.path ? 'generated' : 'missing'),
    why: row.why || row.description || '',
  }));
  const actions = (input.actions || input.actionQueue || []).map((row, index) => ({
    priority: row.priority || `P${index}`,
    action: row.action || row.title || '',
    upside: row.upside || row.expectedUpside || '',
    risk: row.risk || '',
    validation: row.validation || row.command || '',
    owner: row.owner || row.ownerArea || '',
  }));
  return {
    runId: input.runId,
    generatedAt: input.generatedAt || new Date().toISOString(),
    title: title || input.title || 'Rspack Bundle Forensics',
    summary: {
      headline: input.summary?.headline || 'Bundle audit',
      statement: input.summary?.statement || '',
      nextAction: input.summary?.nextAction || '',
      confirmedRawSavingBytes: Number(input.summary?.confirmedRawSavingBytes || 0),
      confirmedGzipSavingBytes: Number(input.summary?.confirmedGzipSavingBytes || 0),
      unquantifiedCount: Number(input.summary?.unquantifiedCount || input.summary?.unquantifiedCommittedCount || 0),
      candidateRawBytes: Number(input.summary?.candidateRawBytes || 0),
      diagnosticRawBytes: Number(input.summary?.diagnosticRawBytes || 0),
    },
    measurement,
    checks,
    overallStatus: checks.some((check) => check.state === 'blocked') ? 'incomplete' : 'complete',
    items,
    sources,
    optimizations,
    analyses,
    actions,
    privacy: input.privacy || 'local-only',
  };
}

const REPORT_CSS = String.raw`
:root{--canvas:#090c0f;--panel:#0e1318;--panel-2:#141b22;--line:#26313a;--text:#eef2f3;--muted:#8c9aa4;--hot:#ff4d6d;--amber:#ffca5c;--cyan:#65d8df;--green:#65d29b;--red:#ff6b6b;--row-h:82px;--code-line:22px;--radius:6px;color-scheme:dark}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--canvas);color:var(--text);font-family:"Avenir Next","Helvetica Neue",sans-serif;font-size:14px;line-height:1.45}button,input,select{font:inherit}button,input,select,a{outline-offset:3px}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--cyan)}a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}
.masthead{position:sticky;top:0;z-index:20;height:86px;display:grid;grid-template-columns:minmax(260px,1fr) auto;align-items:center;padding:14px 24px;border-bottom:1px solid var(--line);background:#090c0ff2;backdrop-filter:blur(14px)}.eyebrow{font:700 10px/1.2 "SFMono-Regular",Consolas,monospace;letter-spacing:.24em;color:var(--hot);text-transform:uppercase}.masthead h1{margin:5px 0 0;font-family:"DIN Alternate","Avenir Next Condensed",sans-serif;font-size:26px;letter-spacing:-.025em}.mast-metrics{display:flex;gap:26px}.mast-metric{text-align:right}.mast-metric strong{display:block;font:700 20px/1 "SFMono-Regular",Consolas,monospace}.mast-metric span{font:700 9px/1.3 "SFMono-Regular",Consolas,monospace;letter-spacing:.15em;color:var(--muted);text-transform:uppercase}
.privacy-banner{display:flex;gap:12px;align-items:center;padding:8px 24px;border-bottom:1px solid #5e4725;background:#17130c;color:#f0c56f;font-size:12px}.privacy-banner b{font:700 10px "SFMono-Regular",Consolas,monospace;letter-spacing:.12em}.server-warning{display:none;padding:10px 16px;margin:14px;border:1px solid #704147;background:#211015;color:#ffb4bf}.server-warning.visible{display:block}.shell{display:grid;grid-template-columns:380px minmax(0,1fr);min-height:calc(100vh - 119px)}
.sidebar{position:sticky;top:119px;height:calc(100vh - 119px);display:grid;grid-template-rows:auto auto auto minmax(0,1fr);border-right:1px solid var(--line);background:var(--panel)}.section-nav{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;border-bottom:1px solid var(--line)}.section-nav a{padding:3px 6px;border:1px solid transparent;color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace}.section-nav a:hover{border-color:var(--line);color:var(--text);text-decoration:none}.sidebar-head{padding:16px;border-bottom:1px solid var(--line)}.search-wrap{position:relative}.search-wrap input{width:100%;height:40px;padding:0 34px 0 12px;border:1px solid #34414b;border-radius:var(--radius);background:#090d11;color:var(--text)}.search-wrap .key{position:absolute;right:10px;top:11px;color:var(--muted);font:11px "SFMono-Regular",Consolas,monospace}.filters{display:flex;gap:8px;margin-top:10px}.filters select{min-width:0;flex:1;height:32px;border:1px solid var(--line);border-radius:4px;background:#111820;color:var(--text);padding:0 8px}.regex-toggle{display:flex;align-items:center;gap:5px;color:var(--muted);font:11px "SFMono-Regular",Consolas,monospace}.list-meta{display:flex;justify-content:space-between;padding:9px 16px;border-bottom:1px solid var(--line);color:var(--muted);font:11px "SFMono-Regular",Consolas,monospace}.list-viewport{position:relative;overflow:auto;contain:strict}.list-spacer{position:relative;width:100%}.module-row{position:absolute;left:0;right:0;height:var(--row-h);padding:12px 14px;border:0;border-bottom:1px solid #1c252c;background:transparent;color:inherit;text-align:left;cursor:pointer}.module-row:hover{background:#141b21}.module-row.selected{background:#1a222a;box-shadow:inset 3px 0 0 var(--hot)}.module-top{display:flex;align-items:center;gap:8px}.module-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 13px "SFMono-Regular",Consolas,monospace}.module-path{margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace}.module-foot{display:flex;justify-content:space-between;margin-top:7px;color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace}.module-foot strong{color:var(--hot)}mark{background:#ff4d6d;color:#fff;padding:0 1px}
.content{min-width:0;padding:22px 26px 80px}.content-inner{max-width:1380px;margin:0 auto}.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;padding:18px 0 22px;border-bottom:1px solid var(--line)}.hero h2{margin:0 0 6px;font-family:"DIN Alternate","Avenir Next Condensed",sans-serif;font-size:36px;line-height:1.05;letter-spacing:-.04em}.hero p{max-width:760px;margin:6px 0;color:var(--muted)}.next-action{max-width:340px;padding:14px;border-left:3px solid var(--amber);background:#15130e}.next-action b{display:block;margin-bottom:4px;color:var(--amber);font:10px "SFMono-Regular",Consolas,monospace;letter-spacing:.12em}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;margin:20px 0;background:var(--line);border:1px solid var(--line)}.metric{min-height:96px;padding:14px;background:var(--panel)}.metric span{display:block;color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace;letter-spacing:.08em}.metric strong{display:block;margin-top:10px;font:700 24px "SFMono-Regular",Consolas,monospace}.metric.primary strong{color:var(--green)}.metric.candidate strong{color:var(--amber)}.metric.diagnostic strong{color:var(--muted)}
.section{margin-top:28px;scroll-margin-top:110px}.section-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:10px}.section h3{margin:0;font-family:"DIN Alternate","Avenir Next Condensed",sans-serif;font-size:21px}.section-kicker{color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace}.table-wrap{overflow:auto;border:1px solid var(--line);background:var(--panel)}table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;border-bottom:1px solid #202930;text-align:left;vertical-align:top}th{position:sticky;top:0;z-index:1;background:#141b22;color:var(--muted);font:700 10px "SFMono-Regular",Consolas,monospace;letter-spacing:.06em;text-transform:uppercase}td.num{text-align:right;font-family:"SFMono-Regular",Consolas,monospace;white-space:nowrap}.chip{display:inline-flex;align-items:center;min-height:20px;padding:2px 7px;border:1px solid var(--line);border-radius:99px;font:700 9px "SFMono-Regular",Consolas,monospace;letter-spacing:.04em;white-space:nowrap}.chip.completed,.chip.confirmed{border-color:#2e7153;color:var(--green)}.chip.completed-no-op{border-color:#456a70;color:var(--cyan)}.chip.blocked{border-color:#74414b;color:#ff98a8}.chip.candidate{border-color:#725c2b;color:var(--amber)}.chip.diagnostic{border-color:#46515a;color:var(--muted)}
.detail-shell{border:1px solid var(--line);background:var(--panel)}.detail-empty,.loading,.error-state{padding:36px;color:var(--muted);text-align:center}.detail-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:18px;border-bottom:1px solid var(--line)}.detail-header h4{margin:0;font:700 18px "SFMono-Regular",Consolas,monospace}.detail-path{margin-top:6px;color:var(--muted);font:11px "SFMono-Regular",Consolas,monospace;word-break:break-all}.detail-body{padding:18px}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.fact{padding:13px;border:1px solid var(--line);background:#11171d}.fact h5{margin:0 0 7px;color:var(--muted);font:700 10px "SFMono-Regular",Consolas,monospace;text-transform:uppercase}.fact p{margin:0;white-space:pre-wrap}.evidence-list{margin:0;padding-left:18px}.artifact-links{display:flex;flex-wrap:wrap;gap:8px}.artifact-links a{padding:6px 9px;border:1px solid var(--line);border-radius:4px}
.code-panel{margin-top:14px;border:1px solid var(--line);background:#080b0e}.code-toolbar{display:grid;grid-template-columns:minmax(160px,1fr) auto auto auto;gap:8px;align-items:center;padding:9px;border-bottom:1px solid var(--line);background:#11171d}.code-toolbar input{min-width:0;height:32px;padding:0 9px;border:1px solid #34414b;border-radius:4px;background:#080b0e;color:var(--text)}.code-toolbar button{height:32px;padding:0 10px;border:1px solid var(--line);border-radius:4px;background:#172029;color:var(--text);cursor:pointer}.code-toolbar button:hover{border-color:var(--cyan)}.source-title{padding:8px 12px;border-bottom:1px solid var(--line);color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace;word-break:break-all}.source-quality{padding:8px 12px;border-bottom:1px solid #5e4725;background:#17130c;color:#f0c56f;font-size:11px}.code-viewport{position:relative;height:480px;overflow:auto;contain:strict;font:12px/var(--code-line) "SFMono-Regular",Menlo,Consolas,monospace}.code-spacer{position:relative;min-width:100%}.code-line{position:absolute;left:0;right:0;height:var(--code-line);display:grid;grid-template-columns:72px minmax(max-content,1fr);white-space:pre}.code-line.unused{background:#3b141b}.code-line.search-hit{background:#4b2027}.line-no{position:sticky;left:0;padding-right:12px;border-right:1px solid #202930;background:#0b0f13;color:#56636d;text-align:right;user-select:none}.line-code{padding-left:12px}.search-status{color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace;white-space:nowrap}
.perf-note,.link-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.perf-note div,.link-card{padding:12px;border:1px solid var(--line);background:var(--panel)}.perf-note b,.link-card b{display:block;font:12px "SFMono-Regular",Consolas,monospace}.perf-note span,.link-card span{display:block;margin-top:5px;color:var(--muted);font-size:11px}.link-card.missing{border-color:#74414b}.empty-row{padding:18px;color:var(--muted);text-align:center}
@media(max-width:1180px){.metrics{grid-template-columns:repeat(3,1fr)}}@media(max-width:980px){.masthead{height:auto;grid-template-columns:1fr}.mast-metrics{margin-top:12px}.shell{grid-template-columns:1fr}.sidebar{position:relative;top:auto;height:520px;border-right:0;border-bottom:1px solid var(--line)}.content{padding:18px}.hero{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}}@media(max-width:620px){.masthead{padding:12px 14px}.mast-metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.mast-metric{text-align:left}.privacy-banner{padding:8px 14px}.content{padding:14px}.hero h2{font-size:29px}.metrics{grid-template-columns:1fr}.detail-grid,.perf-note,.link-grid{grid-template-columns:1fr}.code-toolbar{grid-template-columns:1fr 1fr}.code-toolbar input{grid-column:1/-1}.code-viewport{height:390px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

const CLIENT_JS = String.raw`
(function(){
'use strict';
var core=null, embedded=window.__BUNDLE_REPORT_EMBEDDED_SHARDS__||{}, filtered=[], selectedId=null, detailController=null, requestVersion=0, filterWorker=null, sourceWorker=null, sourceState=null, sourceMatches=[], sourceMatchIndex=-1;
var ROW_HEIGHT=82, CODE_LINE_HEIGHT=22, OVERSCAN=7, CACHE_LIMIT=16*1024*1024;
var cache=new Map(), cacheBytes=0;
var $=function(selector){return document.querySelector(selector)};
function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function safeHref(value){var href=String(value||'#').trim();if(!href)return '#';if(/^[a-z][a-z0-9+.-]*:/i.test(href)&&!/^(https?|file):/i.test(href))return '#';return href}
function fmtBytes(value){var n=Number(value||0), sign=n<0?'-':'';n=Math.abs(n);if(n>=1048576)return sign+(n/1048576).toFixed(2)+' MB';if(n>=1024)return sign+(n/1024).toFixed(1)+' KB';return sign+n+' B'}
function stateLabel(state){return {'completed':'已完成','completed-no-op':'已检查，无可执行候选','blocked':'受阻','candidate':'候选','confirmed':'已确认','diagnostic':'诊断'}[state]||state}
function safeRegex(pattern){if(pattern.length>120)return '正则最长 120 个字符';if(/\\[1-9]/.test(pattern))return '不支持反向引用';if(/\(\?<([=!])/.test(pattern))return '不支持 lookbehind';if(/(?:\([^)]*[+*][^)]*\)|\[[^\]]+\]|\.)[+*{]/.test(pattern))return '拒绝嵌套量词';try{new RegExp(pattern,'i')}catch(error){return error.message}return null}
function makeWorker(){var code="onmessage=function(e){var p=e.data;try{if(p.type==='filter'){var rx=p.regex?new RegExp(p.query,'i'):null,q=p.query.toLowerCase(),out=[];for(var i=0;i<p.rows.length;i++){var h=p.rows[i];if(!p.query||(rx?rx.test(h):h.indexOf(q)!==-1))out.push(i)}postMessage({ok:true,result:out})}else{var lines=p.text.split('\\n'),matches=[],rx=p.regex?new RegExp(p.query,'gi'):null,q=p.query.toLowerCase();for(var l=0;l<lines.length&&matches.length<5000;l++){var line=lines[l];if(rx){rx.lastIndex=0;var m;while((m=rx.exec(line))){matches.push({line:l+1,start:m.index,end:m.index+Math.max(m[0].length,1)});if(m[0].length===0)rx.lastIndex++}}else{var lower=line.toLowerCase(),at=0;while(q&&(at=lower.indexOf(q,at))!==-1){matches.push({line:l+1,start:at,end:at+q.length});at+=Math.max(q.length,1);if(matches.length>=5000)break}}}postMessage({ok:true,result:matches})}}catch(error){postMessage({ok:false,error:error.message})}}";return new Worker(URL.createObjectURL(new Blob([code],{type:'text/javascript'})))}
function workerRequest(kind,payload,timeout){return new Promise(function(resolve,reject){var worker=makeWorker(),done=false,timer=setTimeout(function(){if(done)return;done=true;worker.terminate();reject(new Error('搜索超时，已取消'))},timeout);if(kind==='filter'){if(filterWorker)filterWorker.terminate();filterWorker=worker}else{if(sourceWorker)sourceWorker.terminate();sourceWorker=worker}worker.onmessage=function(event){if(done)return;done=true;clearTimeout(timer);worker.terminate();if(event.data.ok)resolve(event.data.result);else reject(new Error(event.data.error))};worker.onerror=function(){if(done)return;done=true;clearTimeout(timer);worker.terminate();reject(new Error('搜索 Worker 失败'))};worker.postMessage(payload)})}
function debounce(fn,wait){var timer;return function(){var args=arguments;clearTimeout(timer);timer=setTimeout(function(){fn.apply(null,args)},wait)}}
function cacheSet(key,value){var size=JSON.stringify(value).length;if(size>CACHE_LIMIT)return;while(cacheBytes+size>CACHE_LIMIT&&cache.size){var first=cache.keys().next().value;cacheBytes-=cache.get(first).size;cache.delete(first)}cache.set(key,{value:value,size:size});cacheBytes+=size}
async function loadShard(kind,id,signal){var key=kind+'/'+id;if(cache.has(key)){var hit=cache.get(key);cache.delete(key);cache.set(key,hit);return hit.value}if(embedded[key]){cacheSet(key,embedded[key]);return embedded[key]}var response=await fetch('data/'+kind+'/'+encodeURIComponent(id)+'.json',{signal:signal,cache:'no-store'});if(!response.ok)throw new Error('加载失败 HTTP '+response.status);var value=await response.json();if(value.runId!==core.runId)throw new Error('数据 runId 与报告不一致，拒绝混用旧产物');cacheSet(key,value);return value}
function renderHeader(){document.title=core.title;$('#report-title').textContent=core.title;$('#run-id').textContent=core.runId;$('#overall-state').textContent=core.overallStatus==='complete'?'完整':'不完整';$('#module-count').textContent=core.items.length.toLocaleString();$('#hero-headline').textContent=core.summary.headline;$('#hero-statement').textContent=core.summary.statement||'未提供总结';$('#next-action-text').textContent=core.summary.nextAction||'查看检查矩阵与候选明细';$('#metric-raw').textContent=fmtBytes(core.summary.confirmedRawSavingBytes);$('#metric-gzip').textContent=fmtBytes(core.summary.confirmedGzipSavingBytes);$('#metric-unquantified').textContent=Number(core.summary.unquantifiedCount||0).toLocaleString();$('#metric-candidate').textContent=fmtBytes(core.summary.candidateRawBytes);$('#metric-diagnostic').textContent=fmtBytes(core.summary.diagnosticRawBytes);$('#perf-core').textContent=fmtBytes(core.performance.coreJsonBytes);$('#perf-source').textContent=fmtBytes(core.performance.sourceBytes);$('#perf-mode').textContent=core.performance.useServer?'本地服务器 / 按需分片':'小报告 / file:// 可用';if(core.performance.useServer&&location.protocol==='file:'){$('#server-warning').classList.add('visible');$('#server-command').textContent=core.performance.serveCommand}}
function renderChecks(){var tbody=$('#checks-body');tbody.innerHTML=core.checks.map(function(c){return '<tr><td>'+esc(c.name)+'</td><td><span class="chip '+esc(c.state)+'">'+esc(stateLabel(c.state))+'</span></td><td>'+esc(c.result)+'</td><td><code>'+esc(c.evidence||'未生成')+'</code></td><td><code>'+esc(c.error||c.command||'—')+'</code></td></tr>'}).join('')}
function renderSupplementary(){var measurement=$('#measurement-body');measurement.innerHTML=Object.keys(core.measurement||{}).map(function(key){return '<tr><td><code>'+esc(key)+'</code></td><td>'+esc(core.measurement[key])+'</td></tr>'}).join('');var optimizations=$('#optimizations-body'),rows=core.optimizations||[];optimizations.innerHTML=rows.length?rows.map(function(row){return '<tr><td>'+esc(row.title)+'</td><td><span class="chip '+esc(row.status||'candidate')+'">'+esc(stateLabel(row.status||'candidate'))+'</span></td><td>'+esc(row.classification||'')+'</td><td class="num">'+fmtBytes(row.rawSavingBytes)+'</td><td class="num">'+fmtBytes(row.gzipSavingBytes)+'</td><td>'+esc(row.why||'')+'</td><td><code>'+esc(row.validation||'')+'</code></td></tr>'}).join(''):'<tr><td class="empty-row" colspan="7">没有优化条目；请在输入中明确记录 completed-no-op 或 blocked 结论。</td></tr>';var analyses=$('#analysis-links'),analysisRows=core.analyses||[];analyses.innerHTML=analysisRows.length?analysisRows.map(function(row){var missing=row.status==='missing'||!row.href;return '<div class="link-card'+(missing?' missing':'')+'"><b>'+(missing?esc(row.title):'<a href="'+esc(safeHref(row.href))+'">'+esc(row.title)+'</a>')+'</b><span>'+esc(missing?'未生成；报告必须给出补跑命令。':(row.why||row.status))+'</span></div>'}).join(''):'<div class="link-card missing"><b>相关分析页面未登记</b><span>请列出未生成页面及补跑命令，不要静默省略。</span></div>';var actions=$('#actions-body'),actionRows=core.actions||[];actions.innerHTML=actionRows.length?actionRows.map(function(row){return '<tr><td><code>'+esc(row.priority)+'</code></td><td>'+esc(row.action)+'</td><td>'+esc(row.upside)+'</td><td>'+esc(row.risk)+'</td><td><code>'+esc(row.validation)+'</code></td><td>'+esc(row.owner)+'</td></tr>'}).join(''):'<tr><td class="empty-row" colspan="6">没有后续动作；若审计无候选，应在十项检查中保留 no-op 证据。</td></tr>'}
function sortItems(items){var mode=$('#sort-mode').value;return items.sort(function(a,b){if(mode==='name')return a.modulePath.localeCompare(b.modulePath);if(mode==='raw-desc')return b.rawSavingBytes-a.rawSavingBytes||b.unusedBytes-a.unusedBytes;if(mode==='status')return a.status.localeCompare(b.status)||b.unusedBytes-a.unusedBytes;return b.unusedBytes-a.unusedBytes||b.rawSavingBytes-a.rawSavingBytes})}
function highlightText(value,query){if(!query||$('#regex-mode').checked)return esc(value);var text=String(value),i=text.toLowerCase().indexOf(query.toLowerCase());if(i<0)return esc(text);return esc(text.slice(0,i))+'<mark>'+esc(text.slice(i,i+query.length))+'</mark>'+esc(text.slice(i+query.length))}
function renderList(){var viewport=$('#module-list'),spacer=$('#module-spacer'),scrollTop=viewport.scrollTop,height=viewport.clientHeight,start=Math.max(0,Math.floor(scrollTop/ROW_HEIGHT)-OVERSCAN),end=Math.min(filtered.length,Math.ceil((scrollTop+height)/ROW_HEIGHT)+OVERSCAN),query=$('#module-search').value.trim();spacer.style.height=(filtered.length*ROW_HEIGHT)+'px';spacer.innerHTML='';for(var pos=start;pos<end;pos++){var item=core.items[filtered[pos]],button=document.createElement('button');button.className='module-row'+(item.id===selectedId?' selected':'');button.style.transform='translateY('+(pos*ROW_HEIGHT)+'px)';button.dataset.itemId=item.id;button.setAttribute('aria-pressed',item.id===selectedId?'true':'false');button.innerHTML='<div class="module-top"><span class="module-title">'+highlightText(item.title,query)+'</span><span class="chip '+esc(item.status)+'">'+esc(stateLabel(item.status))+'</span></div><div class="module-path">'+highlightText(item.modulePath,query)+'</div><div class="module-foot"><span>unused <strong>'+fmtBytes(item.unusedBytes)+'</strong></span><span>raw save '+fmtBytes(item.rawSavingBytes)+'</span></div>';spacer.appendChild(button)}$('#visible-count').textContent=filtered.length.toLocaleString()+' / '+core.items.length.toLocaleString()}
async function applyFilter(){var query=$('#module-search').value.trim(),regex=$('#regex-mode').checked,error=$('#search-error');error.textContent='';if(regex){var unsafe=safeRegex(query);if(unsafe){error.textContent=unsafe;return}}var rows=core.items.map(function(item){return (item.title+'\n'+item.modulePath+'\n'+item.why).toLowerCase()});try{var found=await workerRequest('filter',{type:'filter',query:query,regex:regex,rows:rows},500);var sorted=sortItems(found.map(function(index){return core.items[index]}));var indexById=new Map(core.items.map(function(item,index){return [item.id,index]}));filtered=sorted.map(function(item){return indexById.get(item.id)});$('#module-list').scrollTop=0;renderList()}catch(err){error.textContent=err.message}}
function evidenceHtml(evidence){if(!Array.isArray(evidence)||!evidence.length)return '<p>未提供结构化证据。</p>';return '<ul class="evidence-list">'+evidence.map(function(row){return '<li>'+esc(typeof row==='string'?row:(row.label||row.path||JSON.stringify(row)))+'</li>'}).join('')+'</ul>'}
async function selectItem(id){var item=core.items.find(function(row){return row.id===id});if(!item)return;selectedId=id;history.replaceState(null,'','#item='+encodeURIComponent(id));renderList();requestVersion++;var version=requestVersion;if(detailController)detailController.abort();detailController=new AbortController();$('#selected-detail').innerHTML='<div class="loading">正在按需加载明细…</div>';try{var shard=await loadShard('details',id,detailController.signal);if(version!==requestVersion)return;var d=shard.detail||{},links=Array.isArray(d.links)?d.links:[];$('#selected-detail').innerHTML='<div class="detail-header"><div><h4>'+esc(item.title)+'</h4><div class="detail-path">'+esc(item.modulePath)+'</div></div><span class="chip '+esc(item.status)+'">'+esc(stateLabel(item.status))+'</span></div><div class="detail-body"><div class="detail-grid"><div class="fact"><h5>结果</h5><p>'+esc(d.result||('unused '+fmtBytes(item.unusedBytes)+' / raw save '+fmtBytes(item.rawSavingBytes)))+'</p></div><div class="fact"><h5>为什么</h5><p>'+esc(d.why||'未提供')+'</p></div><div class="fact"><h5>风险</h5><p>'+esc(d.risk||'未标注')+'</p></div><div class="fact"><h5>怎么验证</h5><p>'+esc(d.validation||'未提供')+'</p></div></div><div class="section"><div class="section-head"><h3>证据</h3></div>'+evidenceHtml(d.evidence)+'</div>'+(links.length?'<div class="artifact-links">'+links.map(function(link){return '<a href="'+esc(safeHref(link.href||link.path||'#'))+'">'+esc(link.label||link.path||'artifact')+'</a>'}).join('')+'</div>':'')+'<div id="source-host"></div></div>';if(d.sourceId)await loadSource(d.sourceId,version);else if(d.code)mountSource({runId:core.runId,id:'inline',path:item.modulePath,source:d.code,ranges:[]});else $('#source-host').innerHTML='<div class="detail-empty">该条目没有源码分片。</div>'}catch(error){if(error.name==='AbortError')return;$('#selected-detail').innerHTML='<div class="error-state">'+esc(error.message)+(location.protocol==='file:'?'<br>大型报告请运行本地服务器。':'')+'</div>'}}
async function loadSource(sourceId,version){var source=await loadShard('sources',sourceId,detailController.signal);if(version!==requestVersion)return;mountSource(source)}
function mountSource(source){sourceState={data:source,lines:String(source.source||'').split('\n')};sourceMatches=[];sourceMatchIndex=-1;var host=$('#source-host');host.innerHTML='<div class="code-panel"><div class="source-title">'+esc(source.path||source.id)+'</div>'+(source.quality&&source.quality.probablyMinified?'<div class="source-quality">源码疑似被压成极少长行；重新捕获可读的 loader 后源码后再作结论。</div>':'')+'<div class="code-toolbar"><input id="source-search" placeholder="搜索源码并跳转高亮…" aria-label="搜索源码"><label class="regex-toggle"><input id="source-regex" type="checkbox"> Regex</label><button id="source-prev" type="button">↑ 上一个</button><button id="source-next" type="button">↓ 下一个</button><span id="source-search-status" class="search-status"></span></div><div id="code-viewport" class="code-viewport" tabindex="0"><div id="code-spacer" class="code-spacer"></div></div></div>';$('#code-viewport').addEventListener('scroll',renderCode);$('#source-search').addEventListener('input',debounce(searchSource,170));$('#source-search').addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();moveSourceMatch(event.shiftKey?-1:1)}});$('#source-prev').addEventListener('click',function(){moveSourceMatch(-1)});$('#source-next').addEventListener('click',function(){moveSourceMatch(1)});renderCode()}
function unusedLine(line){return (sourceState.data.ranges||[]).some(function(range){var start=Number(range.startLine||range.start||0),end=Number(range.endLine||range.end||start);return (range.class==='unused'||range.status==='unused')&&line>=start&&line<=end})}
function matchForLine(line){if(sourceMatchIndex<0)return null;var active=sourceMatches[sourceMatchIndex];return active&&active.line===line?active:null}
function renderCode(){if(!sourceState)return;var viewport=$('#code-viewport'),spacer=$('#code-spacer'),lines=sourceState.lines,top=viewport.scrollTop,height=viewport.clientHeight,start=Math.max(0,Math.floor(top/CODE_LINE_HEIGHT)-OVERSCAN),end=Math.min(lines.length,Math.ceil((top+height)/CODE_LINE_HEIGHT)+OVERSCAN);spacer.style.height=(lines.length*CODE_LINE_HEIGHT)+'px';spacer.innerHTML='';for(var i=start;i<end;i++){var lineNo=i+1,text=lines[i],hit=matchForLine(lineNo),row=document.createElement('div');row.className='code-line'+(unusedLine(lineNo)?' unused':'')+(hit?' search-hit':'');row.style.transform='translateY('+(i*CODE_LINE_HEIGHT)+'px)';var code=hit?esc(text.slice(0,hit.start))+'<mark>'+esc(text.slice(hit.start,hit.end))+'</mark>'+esc(text.slice(hit.end)):esc(text);row.innerHTML='<span class="line-no">'+lineNo+'</span><code class="line-code">'+code+'</code>';spacer.appendChild(row)}}
async function searchSource(){if(!sourceState)return;var input=$('#source-search'),query=input.value,regex=$('#source-regex').checked,status=$('#source-search-status');status.textContent='';if(!query){sourceMatches=[];sourceMatchIndex=-1;renderCode();return}if(regex){var unsafe=safeRegex(query);if(unsafe){status.textContent=unsafe;return}}status.textContent='搜索中…';try{sourceMatches=await workerRequest('source',{type:'source',query:query,regex:regex,text:sourceState.data.source},700);sourceMatchIndex=sourceMatches.length?0:-1;status.textContent=sourceMatches.length?(sourceMatchIndex+1)+' / '+sourceMatches.length:'无匹配';jumpToActiveMatch()}catch(error){status.textContent=error.message}}
function moveSourceMatch(direction){if(!sourceMatches.length)return;sourceMatchIndex=(sourceMatchIndex+direction+sourceMatches.length)%sourceMatches.length;$('#source-search-status').textContent=(sourceMatchIndex+1)+' / '+sourceMatches.length;jumpToActiveMatch()}
function jumpToActiveMatch(){var hit=sourceMatches[sourceMatchIndex];if(!hit){renderCode();return}var viewport=$('#code-viewport');viewport.scrollTop=Math.max(0,(hit.line-5)*CODE_LINE_HEIGHT);renderCode()}
function bind(){var viewport=$('#module-list'),moduleSearch=$('#module-search');viewport.addEventListener('scroll',renderList);viewport.addEventListener('click',function(event){var row=event.target.closest('[data-item-id]');if(row)selectItem(row.dataset.itemId)});moduleSearch.addEventListener('input',debounce(applyFilter,160));moduleSearch.addEventListener('keydown',function(event){if(event.key==='Enter'&&filtered.length){event.preventDefault();selectItem(core.items[filtered[0]].id)}});$('#regex-mode').addEventListener('change',applyFilter);$('#sort-mode').addEventListener('change',applyFilter);document.addEventListener('keydown',function(event){if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();moduleSearch.focus()}})}
async function boot(){try{core=window.__BUNDLE_REPORT_CORE__;if(!core){if(location.protocol==='file:')throw new Error('该大型报告需要本地服务器，不能从 file:// 读取索引');var response=await fetch('report-core.json',{cache:'no-store'});if(!response.ok)throw new Error('无法加载 report-core.json');core=await response.json()}if(core.runId!==window.__BUNDLE_REPORT_EXPECTED_RUN_ID__)throw new Error('核心索引 runId 与 HTML 不一致，拒绝显示混合运行产物');renderHeader();renderChecks();renderSupplementary();bind();filtered=core.items.map(function(_,index){return index});await applyFilter();var hash=new URLSearchParams(location.hash.replace(/^#/,'')),requested=hash.get('item');if(requested&&core.items.some(function(item){return item.id===requested}))selectItem(requested);else if(filtered.length)selectItem(core.items[filtered[0]].id)}catch(error){document.body.innerHTML='<div class="error-state"><h2>报告启动失败</h2><p>'+esc(error.message)+'</p></div>'}}
boot();
})();
`;

function htmlDocument(core, embeddedCore, embeddedShards) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${htmlEscape(core.title)}</title><link rel="stylesheet" href="report.css"></head>
<body><header class="masthead"><div><div class="eyebrow">coverage / graph / emitted bytes</div><h1 id="report-title"></h1></div><div class="mast-metrics"><div class="mast-metric"><strong id="module-count">—</strong><span>observed rows</span></div><div class="mast-metric"><strong id="overall-state">—</strong><span>audit state</span></div><div class="mast-metric"><strong id="run-id">—</strong><span>run id</span></div></div></header>
<div class="privacy-banner"><b>LOCAL EVIDENCE</b><span>报告可能包含专有源码、包路径和构建命令；默认仅限本机，发布前必须脱敏。</span></div>
<div id="server-warning" class="server-warning">该报告超过静态性能预算，请运行：<code id="server-command"></code></div>
<div class="shell"><aside class="sidebar"><nav class="section-nav" aria-label="报告章节"><a href="#conclusion">结论</a><a href="#measurement">数字说明</a><a href="#optimizations">所有优化</a><a href="#coverage">检查</a><a href="#analyses">分析页面</a><a href="#selection">源码</a><a href="#actions">验证队列</a><a href="#performance">附录</a></nav><div class="sidebar-head"><div class="search-wrap"><input id="module-search" placeholder="搜索模块路径或优化项…" aria-label="搜索模块"><span class="key">⌘ K</span></div><div class="filters"><select id="sort-mode" aria-label="排序"><option value="unused-desc">最大未使用优先</option><option value="raw-desc">最大 raw 收益优先</option><option value="status">按状态</option><option value="name">按路径</option></select><label class="regex-toggle"><input id="regex-mode" type="checkbox"> Regex</label></div><div id="search-error" class="search-status"></div></div><div class="list-meta"><span id="visible-count">—</span><span>点击选中 · 右侧按需加载</span></div><div id="module-list" class="list-viewport"><div id="module-spacer" class="list-spacer"></div></div></aside>
<main class="content"><div class="content-inner"><section class="hero" id="conclusion"><div><div class="eyebrow">decision first</div><h2 id="hero-headline"></h2><p id="hero-statement"></p></div><div class="next-action"><b>NEXT ACTION</b><span id="next-action-text"></span></div></section>
<section class="metrics"><div class="metric primary"><span>已确认 RAW 节省</span><strong id="metric-raw">—</strong></div><div class="metric"><span>已确认 GZIP 节省</span><strong id="metric-gzip">—</strong></div><div class="metric"><span>已落地待量化</span><strong id="metric-unquantified">—</strong></div><div class="metric candidate"><span>候选 RAW 范围</span><strong id="metric-candidate">—</strong></div><div class="metric diagnostic"><span>仅诊断 RAW 范围</span><strong id="metric-diagnostic">—</strong></div></section>
<section class="section" id="measurement"><div class="section-head"><h3>数字说明</h3><span class="section-kicker">raw first / production comparable</span></div><div class="table-wrap"><table><thead><tr><th>术语</th><th>本次定义</th></tr></thead><tbody id="measurement-body"></tbody></table></div></section>
<section class="section" id="optimizations"><div class="section-head"><h3>所有优化</h3><span class="section-kicker">sorted by confirmed raw</span></div><div class="table-wrap"><table><thead><tr><th>条目</th><th>状态</th><th>类别</th><th>RAW</th><th>GZIP</th><th>为什么</th><th>怎么验证</th></tr></thead><tbody id="optimizations-body"></tbody></table></div></section>
<section class="section" id="coverage"><div class="section-head"><h3>十项检查覆盖</h3><span class="section-kicker">fresh artifact required</span></div><div class="table-wrap"><table><thead><tr><th>检查</th><th>状态</th><th>结论</th><th>证据</th><th>命令 / 阻塞</th></tr></thead><tbody id="checks-body"></tbody></table></div></section>
<section class="section" id="analyses"><div class="section-head"><h3>相关分析页面</h3><span class="section-kicker">generated or explicitly missing</span></div><div id="analysis-links" class="link-grid"></div></section>
<section class="section" id="selection"><div class="section-head"><h3>选中项与源码</h3><span class="section-kicker">lazy detail / visible lines only</span></div><div id="selected-detail" class="detail-shell"><div class="detail-empty">从左侧选择一个条目。</div></div></section>
<section class="section" id="actions"><div class="section-head"><h3>验证队列</h3><span class="section-kicker">impact × confidence</span></div><div class="table-wrap"><table><thead><tr><th>优先级</th><th>动作</th><th>预期收益</th><th>风险</th><th>验证</th><th>负责区域</th></tr></thead><tbody id="actions-body"></tbody></table></div></section>
<section class="section" id="performance"><div class="section-head"><h3>报告性能契约</h3><span class="section-kicker">measured at render time</span></div><div class="perf-note"><div><b id="perf-core">—</b><span>核心索引；大型索引通过服务器加载</span></div><div><b id="perf-source">—</b><span>源码总量；始终按选择加载并使用可视行渲染</span></div><div><b id="perf-mode">—</b><span>列表虚拟化、160ms 防抖、Worker 超时取消、16 MB LRU</span></div></div></section>
</div></main></div><script>window.__BUNDLE_REPORT_EXPECTED_RUN_ID__=${scriptJson(core.runId)};window.__BUNDLE_REPORT_CORE__=${scriptJson(embeddedCore)};window.__BUNDLE_REPORT_EMBEDDED_SHARDS__=${scriptJson(embeddedShards)};</script><script src="report.js"></script></body></html>`;
}

function renderReport({ inputPath, outDir, title, forceServer = false }) {
  if (!existsSync(inputPath)) throw new Error(`Missing normalized report data: ${inputPath}`);
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  const normalized = normalizeReport(input, title);
  const dataDir = resolve(outDir, 'data');
  const detailDir = resolve(dataDir, 'details');
  const sourceDir = resolve(dataDir, 'sources');
  mkdirSync(detailDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });

  const embeddedShards = {};
  let shardBytes = 0;
  for (const item of normalized.items) {
    const shard = { version: 1, runId: normalized.runId, id: item.id, detail: item.detail };
    const json = JSON.stringify(shard);
    shardBytes += Buffer.byteLength(json);
    writeFileSync(resolve(detailDir, `${item.id}.json`), json + '\n');
    embeddedShards[`details/${item.id}`] = shard;
  }
  let sourceBytes = 0;
  for (const source of normalized.sources) {
    const shard = { version: 1, runId: normalized.runId, ...source };
    const json = JSON.stringify(shard);
    sourceBytes += Buffer.byteLength(source.source);
    shardBytes += Buffer.byteLength(json);
    writeFileSync(resolve(sourceDir, `${source.id}.json`), json + '\n');
    embeddedShards[`sources/${source.id}`] = shard;
  }

  const core = {
    version: 1,
    runId: normalized.runId,
    generatedAt: normalized.generatedAt,
    title: normalized.title,
    summary: normalized.summary,
    measurement: normalized.measurement,
    checks: normalized.checks,
    overallStatus: normalized.overallStatus,
    privacy: normalized.privacy,
    items: normalized.items.map(({ detail, ...item }) => item),
    optimizations: normalized.optimizations,
    analyses: normalized.analyses,
    actions: normalized.actions,
  };
  let coreJson = JSON.stringify(core);
  const useServer = forceServer || normalized.items.length > CORE_ROW_THRESHOLD || shardBytes > EMBED_LIMIT || sourceBytes > SOURCE_SERVER_THRESHOLD || Buffer.byteLength(coreJson) > EMBED_LIMIT;
  core.performance = {
    useServer,
    coreJsonBytes: 0,
    sourceBytes,
    shardBytes,
    rowCount: normalized.items.length,
    thresholds: { coreRows: CORE_ROW_THRESHOLD, embedBytes: EMBED_LIMIT, sourceBytes: SOURCE_SERVER_THRESHOLD },
    serveCommand: `node ${JSON.stringify(resolve(__dirname, 'serve-bundle-report.cjs'))} --root ${JSON.stringify(outDir)} --host 127.0.0.1 --port 4173`,
  };
  for (let index = 0; index < 4; index++) {
    coreJson = JSON.stringify(core);
    core.performance.coreJsonBytes = Buffer.byteLength(coreJson);
  }
  coreJson = JSON.stringify(core);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'report-core.json'), coreJson + '\n');
  writeFileSync(resolve(outDir, 'report.css'), REPORT_CSS);
  writeFileSync(resolve(outDir, 'report.js'), CLIENT_JS);
  const html = htmlDocument(core, useServer ? null : core, useServer ? {} : embeddedShards);
  const htmlPath = resolve(outDir, 'bundle-optimization-report.html');
  writeFileSync(htmlPath, html);
  writeFileSync(resolve(outDir, 'report-manifest.json'), JSON.stringify({
    version: 1,
    runId: core.runId,
    generatedAt: new Date().toISOString(),
    html: basename(htmlPath),
    useServer,
    performance: core.performance,
    privacy: 'local-only; redact source, paths, commands, and package metadata before publishing',
  }, null, 2) + '\n');
  return { htmlPath, useServer, core, outDir };
}

function selfTest() {
  const root = mkdtempSync(resolve(tmpdir(), 'bundle-report-render-'));
  try {
    const inputPath = resolve(root, 'input.json');
    const checks = CHECKS.map(([id]) => ({ id, state: 'completed-no-op', result: 'fixture proof', evidence: `${id}.json` }));
    writeFileSync(inputPath, JSON.stringify({
      runId: 'fixture-run',
      title: 'Fixture Bundle Report',
      summary: { headline: '0 B confirmed', confirmedRawSavingBytes: 0 },
      checks,
      modules: [{ id: 'module-a', path: 'src/a.js', unusedBytes: 120, sourceId: 'source-a', reason: 'fixture' }],
      sources: [{ id: 'source-a', path: 'src/a.js', source: 'export const a = 1;\n', ranges: [{ startLine: 1, endLine: 1, status: 'unused' }] }],
    }));
    const result = renderReport({ inputPath, outDir: resolve(root, 'report') });
    const html = readFileSync(result.htmlPath, 'utf8');
    if (!html.includes('module-search') || !html.includes('selected-detail') || !existsSync(resolve(root, 'report', 'data', 'sources', 'source-a.json'))) throw new Error('self-test assertion failed');
    console.log('render-bundle-report self-test passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const inputPath = resolve(args.input || 'bundle-report-data.json');
  const outDir = resolve(args['out-dir'] || resolve(dirname(inputPath), 'report'));
  const result = renderReport({ inputPath, outDir, title: args.title, forceServer: Boolean(args['force-server']) });
  console.log(`wrote ${result.htmlPath}`);
  console.log(`mode=${result.useServer ? 'local-server-required' : 'standalone-file-supported'}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { CHECKS, normalizeChecks, normalizeReport, renderReport, stableId };
