#!/usr/bin/env node
// Render normalized bundle-audit data as a polished, dependency-free HTML
// report. Large details and source are sharded and loaded only on selection.

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { createHash } = require('crypto');
const { basename, dirname, isAbsolute, relative, resolve, sep } = require('path');
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

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sha256DirectoryFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  const hash = createHash('sha256');
  const rows = files.map((file) => ({ file, path: relative(root, file).split(sep).join('/') }));
  rows.sort((a, b) => a.path < b.path ? -1 : (a.path > b.path ? 1 : 0));
  for (const row of rows) {
    hash.update(row.path);
    hash.update('\0');
    hash.update(sha256File(row.file));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function optimizationGroup(item) {
  const explicit = item.group || item.section;
  if (explicit === 'optimization' || explicit === 'experiment') return explicit;
  const status = item.status || item.class || 'candidate';
  return ['completed-no-op', 'diagnostic', 'rejected'].includes(status) ? 'experiment' : 'optimization';
}

function toArray(value) {
  return value == null || value === '' ? [] : (Array.isArray(value) ? value : [value]);
}

function mergeEvidence(left, right) {
  const rows = [...toArray(left), ...toArray(right)];
  const seen = new Set();
  return rows.filter((row) => {
    const key = typeof row === 'string' ? row : JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeText(left, right) {
  if (!left) return right || '';
  if (!right || left === right) return left;
  return `${left}\n${right}`;
}

function hasEvidence(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
}

function normalizeChecks(inputChecks) {
  const byId = new Map((inputChecks || []).map((check) => [check.id, check]));
  return CHECKS.map(([id, name]) => {
    const value = byId.get(id);
    if (!value) return {
      id,
      name,
      state: 'blocked',
      result: '报告输入缺少该检查',
      evidence: null,
      command: null,
      attemptedCommand: null,
      error: 'missing normalized check row',
      missingPrerequisite: 'normalized check row',
      nextCommand: null,
    };
    let state = STATES.has(value.state) ? value.state : 'blocked';
    const evidence = value.evidence ?? value.artifact ?? null;
    let error = value.error || value.exactError || null;
    let missingPrerequisite = value.missingPrerequisite || null;
    const attemptedCommand = value.attemptedCommand || value.command || null;
    const nextCommand = value.nextCommand || null;
    if (state === 'completed-no-op' && !hasEvidence(evidence)) {
      state = 'blocked';
      error = error || 'completed-no-op requires fresh evidence';
      missingPrerequisite = missingPrerequisite || 'fresh evidence artifact for the no-op conclusion';
    }
    return {
      id,
      name: value.name || name,
      state,
      result: value.result || (state === 'blocked' ? '缺少明确结果' : ''),
      evidence,
      // Kept for old consumers. New reports distinguish what was attempted
      // from the exact command that should be run next.
      command: attemptedCommand || nextCommand,
      attemptedCommand,
      error,
      missingPrerequisite,
      nextCommand,
    };
  });
}

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function finiteNumberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ecmaDelta(source, deltaKeys, reductionKeys) {
  const delta = finiteNumberOrNull(firstDefined(source, deltaKeys));
  if (delta !== null) return delta;
  const reduction = finiteNumberOrNull(firstDefined(source, reductionKeys));
  return reduction === null ? null : -reduction;
}

function normalizeEcmaCategory(row, index) {
  if (typeof row === 'string') return {
    id: `category-${index + 1}`,
    label: row,
    removedCount: null,
    addedCount: null,
    netModuleDelta: null,
    description: '',
    evidence: [],
  };
  return {
    ...row,
    id: row.id || row.category || `category-${index + 1}`,
    label: row.label || row.name || row.category || row.id || `Category ${index + 1}`,
    removedCount: finiteNumberOrNull(firstDefined(row, ['removedCount', 'removedModules', 'removed'])),
    addedCount: finiteNumberOrNull(firstDefined(row, ['addedCount', 'addedModules', 'added'])),
    netModuleDelta: finiteNumberOrNull(firstDefined(row, ['netModuleDelta', 'netDelta', 'delta'])),
    description: row.description || row.conclusion || row.reason || '',
    evidence: toArray(row.evidence || row.artifacts),
  };
}

function countFromCategory(categories, ids) {
  const aliases = new Set(ids.map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')));
  const row = categories.find((category) => {
    const values = [category.id, category.label, category.category]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ''));
    return values.some((value) => aliases.has(value));
  });
  return row ? row.removedCount : null;
}

function normalizeRemovedBreakdown(source, categories) {
  const raw = {
    ...source,
    ...(source.removedBreakdown || source.removalSummary || source.removedModuleSummary || {}),
  };
  const pick = (keys, categoryAliases) => {
    const direct = finiteNumberOrNull(firstDefined(raw, keys));
    return direct !== null ? direct : countFromCategory(categories, categoryAliases);
  };
  return {
    apiPolyfillCount: pick(
      ['apiPolyfillCount', 'apiPolyfillRemovedCount', 'polyfillCount', 'polyfillRemovedCount'],
      ['api-polyfill', 'api polyfill', 'core-js', 'polyfill'],
    ),
    transformHelperCount: pick(
      ['transformHelperCount', 'transformHelperRemovedCount', 'helperCount', 'helperRemovedCount'],
      ['transform-helper', 'transform helper', 'swc-helper', '@swc/helpers'],
    ),
    firstPartyCount: pick(
      ['firstPartyCount', 'firstPartyRemovedCount', 'businessCount', 'businessRemovedCount'],
      ['first-party', 'first party', 'business', 'application'],
    ),
    ordinaryThirdPartyCount: pick(
      ['ordinaryThirdPartyCount', 'ordinaryThirdPartyRemovedCount', 'thirdPartyCount', 'thirdPartyRemovedCount'],
      ['ordinary-third-party', 'ordinary third party', 'third-party', 'vendor'],
    ),
    runtimeCount: pick(
      ['runtimeCount', 'runtimeRemovedCount'],
      ['runtime', 'rspack-runtime'],
    ),
    otherCount: pick(
      ['otherCount', 'otherRemovedCount', 'unclassifiedCount'],
      ['other', 'unclassified'],
    ),
  };
}

function materialEcmaChange(attribution, check) {
  if (attribution?.material !== undefined) return attribution.material === true;
  if (check?.material !== undefined) return check.material === true;
  const rawDelta = Number(firstDefined(attribution, ['appJsRawDeltaBytes', 'rawDeltaBytes', 'appJsRawReductionBytes', 'rawReductionBytes'])
    ?? firstDefined(attribution?.byteAttribution, ['appJsRawDeltaBytes', 'rawDeltaBytes', 'appJsRawReductionBytes', 'rawReductionBytes'])
    ?? firstDefined(check, ['appJsRawDeltaBytes', 'rawDeltaBytes', 'appJsRawReductionBytes', 'rawReductionBytes']) ?? 0);
  const baselineRaw = Number(firstDefined(attribution, ['baselineAppJsRawBytes', 'baselineRawBytes'])
    ?? firstDefined(check, ['baselineAppJsRawBytes', 'baselineRawBytes']) ?? 0);
  const graphFlags = [
    'unexpectedGraphChange',
    'unexpectedModuleIdentityChange',
    'unexpectedModuleCountChange',
    'unexpectedChunkChange',
    'unexpectedPolyfillChange',
  ];
  const unexpectedGraphChange = graphFlags.some((key) => attribution?.[key] === true || check?.[key] === true);
  return Math.abs(rawDelta) >= 50 * 1024 || (baselineRaw > 0 && Math.abs(rawDelta) / baselineRaw >= 0.01) || unexpectedGraphChange;
}

function normalizeEcmaAttribution(input, checks) {
  const rawCheck = (input.checks || []).find((check) => check.id === 'ecma') || {};
  const raw = input.ecmaAttribution || rawCheck.attribution || null;
  const material = materialEcmaChange(raw, rawCheck);
  if (!raw && !material) return null;
  const source = raw || {};
  const rawModuleCategories = firstDefined(source, [
    'moduleCategories',
    'removedModuleCategories',
    'categorySummary',
  ]);
  const moduleCategoryRows = rawModuleCategories && !Array.isArray(rawModuleCategories)
    && typeof rawModuleCategories === 'object'
    ? Object.entries(rawModuleCategories).map(([id, value]) => (
      typeof value === 'object'
        ? { id, ...value }
        : { id, label: id, removedCount: value }
    ))
    : toArray(rawModuleCategories);
  const moduleCategories = moduleCategoryRows.map(normalizeEcmaCategory);
  const byteAttributionSource = source.byteAttribution || {};
  const normalized = {
    ...source,
    material,
    conclusion: firstDefined(source, ['conclusion', 'plainLanguageConclusion', 'summary']) || '',
    comparisonScope: firstDefined(source, ['comparisonScope', 'scope', 'targetDescription']) || '',
    diagnosticOnly: firstDefined(source, ['diagnosticOnly', 'isDiagnosticOnly']) === true,
    baselineModuleCount: firstDefined(source, ['baselineModuleCount']),
    experimentModuleCount: firstDefined(source, ['experimentModuleCount']),
    addedModules: firstDefined(source, ['addedModules']),
    removedModules: firstDefined(source, ['removedModules']),
    partitionSummary: toArray(firstDefined(source, ['partitionSummary', 'partitions', 'compilationPartitions'])),
    moduleCategories,
    removedBreakdown: normalizeRemovedBreakdown(source, moduleCategories),
    retainedShrunkSources: firstDefined(source, ['retainedShrunkSources', 'retainedShrunkModules', 'retainedShrunk']),
    retainedGrownSources: firstDefined(source, ['retainedGrownSources', 'retainedGrownModules', 'retainedGrown']),
    topGeneratedByteContributors: firstDefined(source, ['topGeneratedByteContributors', 'topByteContributors']),
    postLoaderDiffs: toArray(firstDefined(source, ['postLoaderDiffs', 'postLoaderSourceDiffs', 'loaderSourceDiffs'])),
    postLoaderSourceDiffConclusion: firstDefined(source, ['postLoaderSourceDiffConclusion', 'postLoaderConclusion']),
    rootCause: firstDefined(source, ['rootCause', 'rootCauseConclusion']),
    mappedBytes: firstDefined(source, ['mappedBytes', 'mappedDeltaBytes'])
      ?? firstDefined(byteAttributionSource, ['mappedDeltaBytes', 'mappedBytes']),
    unmappedBytes: firstDefined(source, ['unmappedBytes', 'unmappedDeltaBytes'])
      ?? firstDefined(byteAttributionSource, ['unmappedDeltaBytes', 'unmappedBytes']),
    byteAttribution: {
      ...byteAttributionSource,
      rawDeltaBytes: ecmaDelta(
        { ...source, ...byteAttributionSource },
        ['rawDeltaBytes', 'appJsRawDeltaBytes'],
        ['rawReductionBytes', 'appJsRawReductionBytes'],
      ),
      gzipDeltaBytes: ecmaDelta(
        { ...source, ...byteAttributionSource },
        ['gzipDeltaBytes', 'appJsGzipDeltaBytes'],
        ['gzipReductionBytes', 'appJsGzipReductionBytes'],
      ),
      mappedDeltaBytes: finiteNumberOrNull(firstDefined(byteAttributionSource, ['mappedDeltaBytes']))
        ?? finiteNumberOrNull(firstDefined(source, ['mappedDeltaBytes', 'mappedBytes'])),
      unmappedDeltaBytes: finiteNumberOrNull(firstDefined(byteAttributionSource, ['unmappedDeltaBytes']))
        ?? finiteNumberOrNull(firstDefined(source, ['unmappedDeltaBytes', 'unmappedBytes'])),
    },
    failureLedger: toArray(firstDefined(source, ['failureLedger', 'attempts', 'failures'])),
    artifacts: firstDefined(source, ['artifacts', 'links']),
  };
  const required = [
    ['baselineModuleCount', Number.isFinite(Number(normalized.baselineModuleCount))],
    ['experimentModuleCount', Number.isFinite(Number(normalized.experimentModuleCount))],
    ['addedModules', Array.isArray(normalized.addedModules)],
    ['removedModules', Array.isArray(normalized.removedModules)],
    ['retainedShrunkSources', Array.isArray(normalized.retainedShrunkSources)],
    ['retainedGrownSources', Array.isArray(normalized.retainedGrownSources)],
    ['topGeneratedByteContributors', Array.isArray(normalized.topGeneratedByteContributors)],
    ['postLoaderSourceDiffConclusion', typeof normalized.postLoaderSourceDiffConclusion === 'string' && normalized.postLoaderSourceDiffConclusion.trim().length > 0],
    ['rootCause', typeof normalized.rootCause === 'string' && normalized.rootCause.trim().length > 0],
    ['mappedBytes', Number.isFinite(Number(normalized.mappedBytes))],
    ['unmappedBytes', Number.isFinite(Number(normalized.unmappedBytes))],
    ['artifacts', hasEvidence(normalized.artifacts)],
  ];
  normalized.missingFields = material ? required.filter(([, present]) => !present).map(([field]) => field) : [];
  normalized.complete = !material || normalized.missingFields.length === 0;

  if (material && !normalized.complete) {
    const check = checks.find((row) => row.id === 'ecma');
    check.state = 'blocked';
    check.result = 'ECMA 实验产生显著变化，但结构化归因不完整';
    const attributionError = `ECMA 显著变化归因不完整，缺少字段：${normalized.missingFields.join(', ')}`;
    const attributionPrerequisite = `必须补齐的结构化 ECMA 字段：${normalized.missingFields.join(', ')}`;
    check.error = check.error
      ? `${check.error}\n${attributionError}`
      : attributionError;
    check.missingPrerequisite = check.missingPrerequisite
      ? `${check.missingPrerequisite}\n${attributionPrerequisite}`
      : attributionPrerequisite;
    check.nextCommand = source.nextCommand || rawCheck.nextCommand || check.nextCommand || '补齐 ecmaAttribution 后重新渲染报告';
    check.command = check.attemptedCommand || check.nextCommand;
  }
  return normalized;
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
  const ecmaAttribution = normalizeEcmaAttribution(input, checks);
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
  const moduleRows = input.modules || [];
  const normalizeItem = (item, index, fallbackPrefix = 'item') => {
    const path = item.modulePath || item.path || item.resource || item.title || item.name || `item-${index + 1}`;
    const id = item.detailItemId || item.id || stableId(path, fallbackPrefix);
    const sourceId = item.sourceId || (sourceIds.has(item.id) ? item.id : null);
    return {
      id,
      title: item.title || item.name || basename(path),
      modulePath: path,
      status: item.status || item.class || 'candidate',
      classification: item.classification || item.class || item.status || '',
      group: item.group || item.section || null,
      unusedBytes: Number(item.unusedBytes || item.retainedUnusedBytes || 0),
      totalBytes: Number(item.totalBytes || item.moduleSize || 0),
      rawSavingBytes: Number(item.rawSavingBytes || item.confirmedRawSavingBytes || 0),
      gzipSavingBytes: Number(item.gzipSavingBytes || item.confirmedGzipSavingBytes || 0),
      why: item.why || item.reason || '',
      sourceId,
      detail: {
        result: item.result || null,
        why: item.why || item.reason || '',
        classification: item.classification || item.class || item.status || '',
        evidence: toArray(item.evidence),
        code: item.code || null,
        risk: item.risk || '',
        validation: item.validation || item.nextValidation || '',
        links: toArray(item.links),
        sourceId,
      },
    };
  };
  const items = moduleRows.map((item, index) => normalizeItem(item, index));
  const optimizationRows = input.optimizations?.length ? input.optimizations : moduleRows;
  const optimizations = optimizationRows.map((item, index) => ({
    id: item.id || stableId(item.title || item.name || item.path || index, 'optimization'),
    detailItemId: item.detailItemId || item.itemId || null,
    title: item.title || item.name || item.path || `Optimization ${index + 1}`,
    path: item.modulePath || item.path || item.resource || item.title || item.name || `optimization-${index + 1}`,
    status: item.status || item.class || 'candidate',
    classification: item.classification || item.class || item.status || 'candidate',
    group: optimizationGroup(item),
    rawSavingBytes: Number(item.rawSavingBytes || item.confirmedRawSavingBytes || 0),
    gzipSavingBytes: Number(item.gzipSavingBytes || item.confirmedGzipSavingBytes || 0),
    result: item.result || null,
    why: item.why || item.reason || '',
    risk: item.risk || '',
    evidence: toArray(item.evidence),
    code: item.code || null,
    links: toArray(item.links),
    sourceId: item.sourceId || null,
    validation: item.validation || item.nextValidation || '',
  })).sort((a, b) => b.rawSavingBytes - a.rawSavingBytes || a.title.localeCompare(b.title));

  const itemById = new Map(items.map((item) => [item.id, item]));
  const itemByTitle = new Map(items.map((item) => [item.title, item]));
  for (const optimization of optimizations) {
    const existing = (optimization.detailItemId && itemById.get(optimization.detailItemId))
      || itemById.get(optimization.id)
      || itemByTitle.get(optimization.title);
    if (existing) {
      optimization.detailItemId = existing.id;
      existing.optimizationId = optimization.id;
      existing.group = optimization.group;
      existing.status = optimization.status || existing.status;
      existing.classification = optimization.classification || existing.classification;
      existing.rawSavingBytes = optimization.rawSavingBytes;
      existing.gzipSavingBytes = optimization.gzipSavingBytes;
      existing.detail.classification = optimization.classification || existing.detail.classification;
      existing.detail.result = mergeText(existing.detail.result, optimization.result);
      existing.detail.why = mergeText(existing.detail.why, optimization.why);
      existing.detail.risk = mergeText(existing.detail.risk, optimization.risk);
      existing.detail.validation = mergeText(existing.detail.validation, optimization.validation);
      existing.detail.evidence = mergeEvidence(existing.detail.evidence, optimization.evidence);
      existing.detail.code = existing.detail.code || optimization.code;
      existing.detail.links = mergeEvidence(existing.detail.links, optimization.links);
      if (!existing.sourceId && optimization.sourceId) {
        existing.sourceId = optimization.sourceId;
        existing.detail.sourceId = optimization.sourceId;
      }
      continue;
    }
    const detailItem = normalizeItem({
      ...optimization,
      id: optimization.detailItemId || optimization.id,
      modulePath: optimization.path,
    }, items.length, 'optimization-item');
    detailItem.optimizationId = optimization.id;
    detailItem.group = optimization.group;
    optimization.detailItemId = detailItem.id;
    items.push(detailItem);
    itemById.set(detailItem.id, detailItem);
    itemByTitle.set(detailItem.title, detailItem);
  }
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
    ecmaAttribution,
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
.content{min-width:0;padding:22px 26px 80px}.content-inner{max-width:1380px;margin:0 auto}.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;padding:18px 0 22px;border-bottom:1px solid var(--line);scroll-margin-top:110px}.hero h2{margin:0 0 6px;font-family:"DIN Alternate","Avenir Next Condensed",sans-serif;font-size:36px;line-height:1.05;letter-spacing:-.04em}.hero p{max-width:760px;margin:6px 0;color:var(--muted)}.next-action{max-width:340px;padding:14px;border-left:3px solid var(--amber);background:#15130e}.next-action b{display:block;margin-bottom:4px;color:var(--amber);font:10px "SFMono-Regular",Consolas,monospace;letter-spacing:.12em}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;margin:20px 0;background:var(--line);border:1px solid var(--line)}.metric{min-height:96px;padding:14px;background:var(--panel)}.metric span{display:block;color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace;letter-spacing:.08em}.metric strong{display:block;margin-top:10px;font:700 24px "SFMono-Regular",Consolas,monospace}.metric.primary strong{color:var(--green)}.metric.candidate strong{color:var(--amber)}.metric.diagnostic strong{color:var(--muted)}
.section{margin-top:28px;scroll-margin-top:110px}.section-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:10px}.section h3{margin:0;font-family:"DIN Alternate","Avenir Next Condensed",sans-serif;font-size:21px}.section-kicker{color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace}.table-wrap{overflow:auto;border:1px solid var(--line);background:var(--panel)}table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;border-bottom:1px solid #202930;text-align:left;vertical-align:top}th{position:sticky;top:0;z-index:1;background:#141b22;color:var(--muted);font:700 10px "SFMono-Regular",Consolas,monospace;letter-spacing:.06em;text-transform:uppercase}td.num{text-align:right;font-family:"SFMono-Regular",Consolas,monospace;white-space:nowrap}.chip{display:inline-flex;align-items:center;min-height:20px;padding:2px 7px;border:1px solid var(--line);border-radius:99px;font:700 9px "SFMono-Regular",Consolas,monospace;letter-spacing:.04em;white-space:nowrap}.chip.completed,.chip.confirmed{border-color:#2e7153;color:var(--green)}.chip.completed-no-op{border-color:#456a70;color:var(--cyan)}.chip.blocked,.chip.rejected{border-color:#74414b;color:#ff98a8}.chip.candidate,.chip.unquantified{border-color:#725c2b;color:var(--amber)}.chip.diagnostic{border-color:#46515a;color:var(--muted)}
.detail-shell{border:1px solid var(--line);background:var(--panel)}.detail-empty,.loading,.error-state{padding:36px;color:var(--muted);text-align:center}.detail-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:18px;border-bottom:1px solid var(--line)}.detail-header h4{margin:0;font:700 18px "SFMono-Regular",Consolas,monospace}.detail-path{margin-top:6px;color:var(--muted);font:11px "SFMono-Regular",Consolas,monospace;word-break:break-all}.detail-body{min-width:0;padding:18px}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.fact{padding:13px;border:1px solid var(--line);background:#11171d}.fact h5{margin:0 0 7px;color:var(--muted);font:700 10px "SFMono-Regular",Consolas,monospace;text-transform:uppercase}.fact p{margin:0;white-space:pre-wrap}.evidence-list{margin:0;padding-left:18px}.evidence-list li{overflow-wrap:anywhere}.artifact-links{display:flex;flex-wrap:wrap;gap:8px}.artifact-links a{padding:6px 9px;border:1px solid var(--line);border-radius:4px;overflow-wrap:anywhere}
.code-panel{margin-top:14px;border:1px solid var(--line);background:#080b0e}.code-toolbar{display:grid;grid-template-columns:minmax(160px,1fr) auto auto auto;gap:8px;align-items:center;padding:9px;border-bottom:1px solid var(--line);background:#11171d}.code-toolbar input{min-width:0;height:32px;padding:0 9px;border:1px solid #34414b;border-radius:4px;background:#080b0e;color:var(--text)}.code-toolbar button{height:32px;padding:0 10px;border:1px solid var(--line);border-radius:4px;background:#172029;color:var(--text);cursor:pointer}.code-toolbar button:hover{border-color:var(--cyan)}.source-title{padding:8px 12px;border-bottom:1px solid var(--line);color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace;word-break:break-all}.source-quality{padding:8px 12px;border-bottom:1px solid #5e4725;background:#17130c;color:#f0c56f;font-size:11px}.code-viewport{position:relative;height:480px;overflow:auto;contain:strict;font:12px/var(--code-line) "SFMono-Regular",Menlo,Consolas,monospace}.code-spacer{position:relative;min-width:100%}.code-line{position:absolute;left:0;right:0;height:var(--code-line);display:grid;grid-template-columns:72px minmax(max-content,1fr);white-space:pre}.code-line.unused{background:#3b141b}.code-line.search-hit{background:#4b2027}.line-no{position:sticky;left:0;padding-right:12px;border-right:1px solid #202930;background:#0b0f13;color:#56636d;text-align:right;user-select:none}.line-code{padding-left:12px}.search-status{color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace;white-space:nowrap}
.perf-note,.link-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.perf-note div,.link-card{padding:12px;border:1px solid var(--line);background:var(--panel)}.perf-note b,.link-card b{display:block;font:12px "SFMono-Regular",Consolas,monospace}.perf-note span,.link-card span{display:block;margin-top:5px;color:var(--muted);font-size:11px}.link-card.missing{border-color:#74414b}.empty-row{padding:18px;color:var(--muted);text-align:center}.check-block{display:grid;gap:7px;min-width:260px}.check-block div{display:grid;grid-template-columns:68px minmax(0,1fr);gap:8px}.check-block b{color:var(--muted);font:700 9px "SFMono-Regular",Consolas,monospace}.check-block code,.check-block span{white-space:pre-wrap;word-break:break-word}.check-summary-row.has-detail td{border-bottom:0}.check-detail-pointer{color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace;white-space:nowrap}.check-detail-row td{padding:0 12px 12px;background:#0b1014}.check-detail-row .check-block{min-width:0;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 18px;padding:12px;border:1px solid #303b44;background:#0d1318}.check-detail-row .check-block>div{align-content:start}
.ecma-verdict{padding:18px;border:1px solid #34515a;background:#0d171b}.ecma-verdict-top{display:flex;align-items:center;justify-content:space-between;gap:12px}.ecma-verdict h4{margin:0;font:700 18px/1.3 "DIN Alternate","Avenir Next Condensed",sans-serif}.ecma-verdict p{max-width:960px;margin:8px 0 0;color:var(--muted);white-space:pre-wrap}.ecma-answer-grid,.ecma-byte-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin-top:12px;border:1px solid var(--line);background:var(--line)}.ecma-byte-grid{grid-template-columns:repeat(5,minmax(0,1fr))}.ecma-answer,.ecma-byte{min-height:92px;padding:12px;background:var(--panel)}.ecma-answer span,.ecma-byte span{display:block;color:var(--muted);font:10px "SFMono-Regular",Consolas,monospace;letter-spacing:.05em}.ecma-answer strong,.ecma-byte strong{display:block;margin-top:9px;font:700 23px "SFMono-Regular",Consolas,monospace}.ecma-answer.zero strong{color:var(--green)}.ecma-answer.unknown strong{color:var(--amber);font-size:14px}.ecma-byte strong{font-size:17px}.ecma-root-cause{display:grid;grid-template-columns:88px minmax(0,1fr);gap:12px;margin-top:12px;padding:13px;border-left:3px solid var(--cyan);background:#10171c}.ecma-root-cause b{color:var(--cyan);font:700 10px "SFMono-Regular",Consolas,monospace;letter-spacing:.08em}.ecma-root-cause p{margin:0;white-space:pre-wrap}.ecma-evidence{margin-top:12px;border:1px solid var(--line);background:var(--panel)}.ecma-evidence>summary{cursor:pointer;padding:12px 14px;background:#121920;font-weight:700;list-style-position:inside}.ecma-evidence>summary span{margin-left:8px;color:var(--muted);font:400 11px "SFMono-Regular",Consolas,monospace}.ecma-evidence[open]>summary{border-bottom:1px solid var(--line)}.ecma-evidence-body{padding:12px}.ecma-note{margin:0 0 10px;color:var(--muted)}.ecma-table td code{white-space:pre-wrap;overflow-wrap:anywhere}.ecma-table .reason{min-width:260px;white-space:pre-wrap}.ecma-table .path{min-width:300px;overflow-wrap:anywhere}.ecma-code-diff{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.ecma-code-diff:first-child{margin-top:0;padding-top:0;border-top:0}.ecma-code-diff h5{margin:0;font:700 13px "SFMono-Regular",Consolas,monospace}.ecma-code-diff p{margin:6px 0;color:var(--muted);white-space:pre-wrap}.ecma-code-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.ecma-code-grid>div{min-width:0}.ecma-code-label{display:block;margin:0 0 5px;color:var(--muted);font:700 9px "SFMono-Regular",Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}.ecma-code-grid pre{max-height:360px;margin:0;padding:12px;overflow:auto;border:1px solid var(--line);background:#080b0e;color:#dce5e7;font:11px/1.55 "SFMono-Regular",Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.ecma-artifacts{display:flex;flex-wrap:wrap;gap:8px}.ecma-code-diff .ecma-artifacts{margin-top:8px}.ecma-artifacts a,.ecma-artifacts span{display:inline-flex;padding:7px 9px;border:1px solid var(--line);border-radius:4px;overflow-wrap:anywhere}.ecma-artifacts span{color:var(--muted)}.attempt-recovered,.attempt-success{color:var(--green)}.attempt-failed,.attempt-abandoned,.attempt-blocked{color:#ff98a8}.attempt-running{color:var(--amber)}
@media(max-width:1180px){.metrics{grid-template-columns:repeat(3,1fr)}.ecma-answer-grid,.ecma-byte-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:980px){.masthead{height:auto;grid-template-columns:1fr}.mast-metrics{margin-top:12px}.shell{grid-template-columns:1fr}.sidebar{position:relative;top:auto;height:520px;border-right:0;border-bottom:1px solid var(--line)}.content{padding:18px}.hero{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}.check-detail-row .check-block{grid-template-columns:1fr}.ecma-code-grid{grid-template-columns:1fr}}@media(max-width:620px){.masthead{padding:12px 14px}.mast-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px}.mast-metric{text-align:left}.mast-metric:last-child{grid-column:1/-1}.mast-metric:last-child strong{font-size:12px;line-height:1.2;word-break:break-all}.privacy-banner{padding:8px 14px}.sidebar{height:300px}.content{padding:14px}.hero,.section{scroll-margin-top:230px}.hero h2{font-size:29px}.metrics{grid-template-columns:1fr}.detail-grid,.perf-note,.link-grid,.ecma-answer-grid,.ecma-byte-grid{grid-template-columns:1fr}.ecma-root-cause{grid-template-columns:1fr;gap:4px}.ecma-verdict-top{align-items:flex-start;flex-direction:column}.code-toolbar{grid-template-columns:1fr 1fr}.code-toolbar input{grid-column:1/-1}.code-viewport{height:390px}.check-detail-row td{padding:0 8px 10px}.check-detail-row .check-block{padding:10px}.check-detail-row .check-block div{grid-template-columns:1fr;gap:3px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
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
function stateLabel(state){return {'completed':'已完成','completed-no-op':'已检查，无可执行候选','blocked':'受阻','candidate':'候选','confirmed':'已确认','diagnostic':'诊断','unquantified':'待量化','rejected':'已拒绝'}[state]||state}
function safeRegex(pattern){if(pattern.length>120)return '正则最长 120 个字符';if(/\\[1-9]/.test(pattern))return '不支持反向引用';if(/\(\?<([=!])/.test(pattern))return '不支持 lookbehind';if(/(?:\([^)]*[+*][^)]*\)|\[[^\]]+\]|\.)[+*{]/.test(pattern))return '拒绝嵌套量词';try{new RegExp(pattern,'i')}catch(error){return error.message}return null}
function makeWorker(){var code="onmessage=function(e){var p=e.data;try{if(p.type==='filter'){var rx=p.regex?new RegExp(p.query,'i'):null,q=p.query.toLowerCase(),out=[];for(var i=0;i<p.rows.length;i++){var h=p.rows[i];if(!p.query||(rx?rx.test(h):h.indexOf(q)!==-1))out.push(i)}postMessage({ok:true,result:out})}else{var lines=p.text.split('\\n'),matches=[],rx=p.regex?new RegExp(p.query,'gi'):null,q=p.query.toLowerCase();for(var l=0;l<lines.length&&matches.length<5000;l++){var line=lines[l];if(rx){rx.lastIndex=0;var m;while((m=rx.exec(line))){matches.push({line:l+1,start:m.index,end:m.index+Math.max(m[0].length,1)});if(m[0].length===0)rx.lastIndex++}}else{var lower=line.toLowerCase(),at=0;while(q&&(at=lower.indexOf(q,at))!==-1){matches.push({line:l+1,start:at,end:at+q.length});at+=Math.max(q.length,1);if(matches.length>=5000)break}}}postMessage({ok:true,result:matches})}}catch(error){postMessage({ok:false,error:error.message})}}";return new Worker(URL.createObjectURL(new Blob([code],{type:'text/javascript'})))}
function workerRequest(kind,payload,timeout){return new Promise(function(resolve,reject){var worker=makeWorker(),done=false,timer=setTimeout(function(){if(done)return;done=true;worker.terminate();reject(new Error('搜索超时，已取消'))},timeout);if(kind==='filter'){if(filterWorker)filterWorker.terminate();filterWorker=worker}else{if(sourceWorker)sourceWorker.terminate();sourceWorker=worker}worker.onmessage=function(event){if(done)return;done=true;clearTimeout(timer);worker.terminate();if(event.data.ok)resolve(event.data.result);else reject(new Error(event.data.error))};worker.onerror=function(){if(done)return;done=true;clearTimeout(timer);worker.terminate();reject(new Error('搜索 Worker 失败'))};worker.postMessage(payload)})}
function debounce(fn,wait){var timer;return function(){var args=arguments;clearTimeout(timer);timer=setTimeout(function(){fn.apply(null,args)},wait)}}
function cacheSet(key,value){var size=JSON.stringify(value).length;if(size>CACHE_LIMIT)return;while(cacheBytes+size>CACHE_LIMIT&&cache.size){var first=cache.keys().next().value;cacheBytes-=cache.get(first).size;cache.delete(first)}cache.set(key,{value:value,size:size});cacheBytes+=size}
async function loadShard(kind,id,signal){var key=kind+'/'+id;if(cache.has(key)){var hit=cache.get(key);cache.delete(key);cache.set(key,hit);return hit.value}if(embedded[key]){cacheSet(key,embedded[key]);return embedded[key]}var response=await fetch('data/'+kind+'/'+encodeURIComponent(id)+'.json',{signal:signal,cache:'no-store'});if(!response.ok)throw new Error('加载失败 HTTP '+response.status);var value=await response.json();if(value.runId!==core.runId)throw new Error('数据 runId 与报告不一致，拒绝混用旧产物');cacheSet(key,value);return value}
function renderHeader(){document.title=core.title;$('#report-title').textContent=core.title;$('#run-id').textContent=core.runId;$('#overall-state').textContent=core.overallStatus==='complete'?'完整':'不完整';$('#module-count').textContent=core.items.length.toLocaleString();$('#hero-headline').textContent=core.summary.headline;$('#hero-statement').textContent=core.summary.statement||'未提供总结';$('#next-action-text').textContent=core.summary.nextAction||'查看检查矩阵与候选明细';$('#metric-raw').textContent=fmtBytes(core.summary.confirmedRawSavingBytes);$('#metric-gzip').textContent=fmtBytes(core.summary.confirmedGzipSavingBytes);$('#metric-unquantified').textContent=Number(core.summary.unquantifiedCount||0).toLocaleString();$('#metric-candidate').textContent=fmtBytes(core.summary.candidateRawBytes);$('#metric-diagnostic').textContent=fmtBytes(core.summary.diagnosticRawBytes);$('#perf-core').textContent=fmtBytes(core.performance.coreJsonBytes);$('#perf-source').textContent=fmtBytes(core.performance.sourceBytes);$('#perf-mode').textContent=core.performance.useServer?'本地服务器 / 按需分片':'小报告 / file:// 可用';if(core.performance.useServer&&location.protocol==='file:'){$('#server-warning').classList.add('visible');$('#server-command').textContent=core.performance.serveCommand}}
function checkEvidence(value){if(value==null||value==='')return '未生成';return typeof value==='string'?value:JSON.stringify(value)}
function checkBlockHtml(c){var rows=[];if(c.attemptedCommand)rows.push('<div><b>已尝试</b><code>'+esc(c.attemptedCommand)+'</code></div>');if(c.error)rows.push('<div><b>精确错误</b><code>'+esc(c.error)+'</code></div>');if(c.missingPrerequisite)rows.push('<div><b>缺失前置</b><span>'+esc(c.missingPrerequisite)+'</span></div>');if(c.nextCommand)rows.push('<div><b>下一命令</b><code>'+esc(c.nextCommand)+'</code></div>');return rows.length?'<div class="check-block">'+rows.join('')+'</div>':'—'}
function renderChecks(){var tbody=$('#checks-body');tbody.innerHTML=core.checks.map(function(c){var hasBlockedDetail=Boolean(c.error||c.missingPrerequisite||c.nextCommand),summary='<tr class="check-summary-row'+(hasBlockedDetail?' has-detail':'')+'"><td>'+esc(c.name)+'</td><td><span class="chip '+esc(c.state)+'">'+esc(stateLabel(c.state))+'</span></td><td>'+esc(c.result)+'</td><td><code>'+esc(checkEvidence(c.evidence))+'</code></td><td>'+(hasBlockedDetail?'<span class="check-detail-pointer">失败原因与补跑命令如下</span>':checkBlockHtml(c))+'</td></tr>';return hasBlockedDetail?summary+'<tr class="check-detail-row"><td colspan="5">'+checkBlockHtml(c)+'</td></tr>':summary}).join('')}
function optimizationTableHtml(rows,emptyText){return rows.length?rows.map(function(row){var title=row.detailItemId?'<a href="#item='+encodeURIComponent(row.detailItemId)+'">'+esc(row.title)+'</a>':esc(row.title);return '<tr><td>'+title+'</td><td><span class="chip '+esc(row.status||'candidate')+'">'+esc(stateLabel(row.status||'candidate'))+'</span></td><td>'+esc(row.classification||'')+'</td><td class="num">'+fmtBytes(row.rawSavingBytes)+'</td><td class="num">'+fmtBytes(row.gzipSavingBytes)+'</td><td>'+esc(row.why||'')+'</td><td><code>'+esc(row.validation||'')+'</code></td></tr>'}).join(''):'<tr><td class="empty-row" colspan="7">'+esc(emptyText)+'</td></tr>'}
function rowByteSuffix(row){if(!row||typeof row==='string')return '';var value=row.deltaBytes;if(value==null)value=row.bytes;if(value==null&&row.savedBytes!=null)value=-Number(row.savedBytes);return value==null?'':' · '+fmtBytes(value)}
function listSummary(value){if(!Array.isArray(value))return '未提供';if(!value.length)return '0 项';return value.length+' 项：'+value.slice(0,4).map(function(row){return typeof row==='string'?row:(row.modulePath||row.path||row.name||row.label||JSON.stringify(row))+rowByteSuffix(row)}).join('；')+(value.length>4?'…':'')}
function sourceAttributionSummary(value){if(!Array.isArray(value))return '未提供';if(!value.length)return '0 项';return value.length+' 项：'+value.slice(0,4).map(function(row){if(typeof row==='string')return row;var source=(row.sourcePath||row.source||row.path||row.name||row.label||JSON.stringify(row))+rowByteSuffix(row);if(row.joinKind==='one-to-one'&&(row.modulePath||row.module)){return source+' → '+(row.modulePath||row.module)+'（一对一'+(row.confidence!=null?'，置信度 '+row.confidence:'')+'）'}return source+(row.joinKind?'（'+row.joinKind+'）':'')}).join('；')+(value.length>4?'…':'')}
function optionalCount(value){return value==null?'未提供':Number(value).toLocaleString()}
function optionalBytes(value){return value==null?'未提供':fmtBytes(value)}
function ecmaCountTile(label,value,detail){var className=value==null?'unknown':(Number(value)===0?'zero':'');return '<div class="ecma-answer '+className+'"><span>'+esc(label)+'</span><strong>'+esc(optionalCount(value))+'</strong><span>'+esc(detail)+'</span></div>'}
function ecmaByteTile(label,value,detail){return '<div class="ecma-byte"><span>'+esc(label)+'</span><strong>'+esc(optionalBytes(value))+'</strong><span>'+esc(detail)+'</span></div>'}
function ecmaCountValueTile(label,value,detail){return '<div class="ecma-byte"><span>'+esc(label)+'</span><strong>'+esc(optionalCount(value))+'</strong><span>'+esc(detail)+'</span></div>'}
function rowValue(row,keys){for(var i=0;i<keys.length;i++){if(row&&row[keys[i]]!=null)return row[keys[i]]}return null}
function displayCell(value,fallback){if(value==null||value==='')return fallback||'—';if(Array.isArray(value))return value.join('，');if(typeof value==='object')return JSON.stringify(value);return String(value)}
function artifactLinksHtml(value){var rows;if(Array.isArray(value))rows=value;else if(value&&typeof value==='object'&&!value.href&&!value.path&&!value.file&&!value.label&&!value.title)rows=Object.keys(value).map(function(label){return {label:label,href:value[label]}});else rows=value==null?[]:[value];if(!rows.length)return '<span>未提供 artifact</span>';return rows.map(function(row){if(typeof row==='string')return '<a href="'+esc(safeHref(row))+'">'+esc(row)+'</a>';var href=row.href||row.path||row.file||'',label=row.label||row.title||row.path||row.file||'artifact';return href?'<a href="'+esc(safeHref(href))+'">'+esc(label)+'</a>':'<span>'+esc(label)+'</span>'}).join('')}
function evidenceCell(value){if(value==null||value==='')return '—';if(Array.isArray(value))return value.map(function(row){return typeof row==='string'?row:(row.label||row.path||JSON.stringify(row))}).join('；');return typeof value==='object'?JSON.stringify(value):String(value)}
function ecmaCategoryRows(a){var rows=Array.isArray(a.moduleCategories)?a.moduleCategories.slice():[],b=a.removedBreakdown||{},definitions=[['api-polyfill','API polyfill',b.apiPolyfillCount,'目标环境不再需要的 core-js 等 API 补丁'],['transform-helper','Transform helper',b.transformHelperCount,'现代语法保留后不再需要的 @swc/helpers'],['first-party','业务代码',b.firstPartyCount,'项目自身源码模块'],['ordinary-third-party','普通第三方',b.ordinaryThirdPartyCount,'排除 polyfill/helper 的第三方模块'],['runtime','Rspack runtime',b.runtimeCount,'编译器 runtime 逻辑模块']];function categoryKey(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'')}definitions.forEach(function(definition){var key=categoryKey(definition[0]),present=rows.some(function(row){return categoryKey(row.id||row.category)===key});if(!present)rows.push({id:definition[0],label:definition[1],removedCount:definition[2],description:definition[3]})});return rows}
function renderCategoryTable(a){var rows=ecmaCategoryRows(a);return '<div class="table-wrap"><table class="ecma-table"><thead><tr><th>模块类别</th><th>移除</th><th>新增</th><th>净变化</th><th>解释</th><th>证据</th></tr></thead><tbody>'+rows.map(function(row){var removed=row.removedCount,added=row.addedCount,net=row.netModuleDelta;if(net==null&&removed!=null&&added!=null)net=Number(added)-Number(removed);return '<tr><td><code>'+esc(row.label||row.name||row.id||'未分类')+'</code></td><td class="num">'+esc(optionalCount(removed))+'</td><td class="num">'+esc(optionalCount(added))+'</td><td class="num">'+esc(optionalCount(net))+'</td><td class="reason">'+esc(row.description||row.conclusion||row.reason||'—')+'</td><td>'+esc(evidenceCell(row.evidence||row.artifacts))+'</td></tr>'}).join('')+'</tbody></table></div>'}
function renderPartitionTable(a){var rows=Array.isArray(a.partitionSummary)?a.partitionSummary:[];if(!rows.length)return '<p class="ecma-note">未提供 compilation partition 数据；不能据此声称所有 child compiler 都已覆盖。</p>';return '<div class="table-wrap"><table class="ecma-table"><thead><tr><th>Partition</th><th>基线模块</th><th>实验模块</th><th>移除</th><th>新增</th><th>保留</th><th>RAW Δ</th><th>GZIP Δ</th><th>结论</th></tr></thead><tbody>'+rows.map(function(row,index){return '<tr><td><code>'+esc(displayCell(rowValue(row,['name','label','partitionId','id']),'partition '+(index+1)))+'</code></td><td class="num">'+esc(optionalCount(rowValue(row,['baselineModuleCount','baselineModules'])))+'</td><td class="num">'+esc(optionalCount(rowValue(row,['experimentModuleCount','experimentModules','targetModuleCount'])))+'</td><td class="num">'+esc(optionalCount(rowValue(row,['removedCount','removedModuleCount'])))+'</td><td class="num">'+esc(optionalCount(rowValue(row,['addedCount','addedModuleCount'])))+'</td><td class="num">'+esc(optionalCount(rowValue(row,['retainedCount','retainedModuleCount'])))+'</td><td class="num">'+esc(optionalBytes(rowValue(row,['rawDeltaBytes','appJsRawDeltaBytes'])))+'</td><td class="num">'+esc(optionalBytes(rowValue(row,['gzipDeltaBytes','appJsGzipDeltaBytes'])))+'</td><td class="reason">'+esc(displayCell(rowValue(row,['conclusion','result','note','status'])))+'</td></tr>'}).join('')+'</tbody></table></div>'}
function moduleIdentity(row){if(typeof row==='string')return row;return displayCell(rowValue(row,['canonicalIdentity','canonicalId','modulePath','resource','path','name','id']))}
function renderRemovedModules(a){var rows=Array.isArray(a.removedModules)?a.removedModules:[];if(!rows.length)return '<p class="ecma-note">完整清单为 0 项。</p>';return '<p class="ecma-note">以下为 inventory diff 的完整移除清单，共 '+rows.length.toLocaleString()+' 项；没有用 source map 缺失反推模块移除。</p><div class="table-wrap"><table class="ecma-table"><thead><tr><th>#</th><th>Canonical module identity</th><th>类别</th><th>Partition / chunk</th><th>为什么移除</th></tr></thead><tbody>'+rows.map(function(row,index){var category=typeof row==='string'?'—':displayCell(rowValue(row,['categoryLabel','category','kind','moduleCategory']));var partition=typeof row==='string'?'—':displayCell(rowValue(row,['partition','partitionId','compiler','chunks','baselineChunks']));var reason=typeof row==='string'?'—':displayCell(rowValue(row,['reason','rootCause','conclusion','evidence']));return '<tr><td class="num">'+(index+1)+'</td><td class="path"><code>'+esc(moduleIdentity(row))+'</code></td><td>'+esc(category)+'</td><td><code>'+esc(partition)+'</code></td><td class="reason">'+esc(reason)+'</td></tr>'}).join('')+'</tbody></table></div>'}
function renderAddedModules(a){var rows=Array.isArray(a.addedModules)?a.addedModules:[];if(!rows.length)return '<p class="ecma-note">完整新增清单为 0 项。</p>';return '<p class="ecma-note">以下为 inventory diff 的完整新增清单，共 '+rows.length.toLocaleString()+' 项。</p><div class="table-wrap"><table class="ecma-table"><thead><tr><th>#</th><th>Canonical module identity</th><th>类别</th><th>Partition / chunk</th><th>为什么新增</th></tr></thead><tbody>'+rows.map(function(row,index){var category=typeof row==='string'?'—':displayCell(rowValue(row,['categoryLabel','category','kind','moduleCategory']));var partition=typeof row==='string'?'—':displayCell(rowValue(row,['partition','partitionId','compiler','chunks','experimentChunks']));var reason=typeof row==='string'?'—':displayCell(rowValue(row,['reason','rootCause','conclusion','evidence']));return '<tr><td class="num">'+(index+1)+'</td><td class="path"><code>'+esc(moduleIdentity(row))+'</code></td><td>'+esc(category)+'</td><td><code>'+esc(partition)+'</code></td><td class="reason">'+esc(reason)+'</td></tr>'}).join('')+'</tbody></table></div>'}
function retainedRowsHtml(rows){if(!Array.isArray(rows)||!rows.length)return '<p class="ecma-note">0 项。</p>';return '<div class="table-wrap"><table class="ecma-table"><thead><tr><th>Source</th><th>生成字节 Δ</th><th>模块归属</th><th>Join</th><th>Chunk membership</th><th>原因</th></tr></thead><tbody>'+rows.map(function(row){if(typeof row==='string')return '<tr><td class="path"><code>'+esc(row)+'</code></td><td colspan="5">未提供结构化字段</td></tr>';var path=row.sourcePath||row.source||row.path||row.name||'—',delta=rowValue(row,['deltaBytes','generatedByteDelta','bytes']),module=(row.joinKind==='one-to-one'?(row.modulePath||row.module):null),join=row.joinKind||row.joinConfidence||'未证明一对一',membership=rowValue(row,['membershipDelta','chunkMembershipDelta','memberships','chunkMemberships']),reason=row.reason||row.rootCause||row.conclusion||'';return '<tr><td class="path"><code>'+esc(path)+'</code></td><td class="num">'+esc(optionalBytes(delta))+'</td><td class="path">'+esc(module||'未作 module 归属')+'</td><td>'+esc(join+(row.confidence!=null?' · '+row.confidence:''))+'</td><td>'+esc(displayCell(membership))+'</td><td class="reason">'+esc(reason||'—')+'</td></tr>'}).join('')+'</tbody></table></div>'}
function renderPostLoaderDiffs(a){var rows=Array.isArray(a.postLoaderDiffs)?a.postLoaderDiffs:[];var intro='<p class="ecma-note">'+esc(a.postLoaderSourceDiffConclusion||'未提供 loader 后源码总结合论。')+'</p>';if(!rows.length)return intro+'<p class="ecma-note">未提供逐模块 before / after 代码片段；完整性要求仍由 ECMA check 的结构化 gate 决定。</p>';return intro+rows.map(function(row,index){var title=row.title||row.modulePath||row.path||row.name||('Diff '+(index+1)),before=row.baselineSnippet||row.before||row.baselineSource||row.oldSource||'',after=row.experimentSnippet||row.after||row.experimentSource||row.newSource||'',reason=row.reason||row.rootCause||row.conclusion||'',removed=row.removedHelpers||row.removedModules||row.disappearedHelpers||[],labels=row.labels||{};return '<article class="ecma-code-diff"><h5>'+esc(title)+'</h5><p>'+esc(reason||'未提供差异原因')+(Array.isArray(removed)&&removed.length?'\n消失的 helper/module：'+esc(removed.join('，')):'')+'</p><div class="ecma-code-grid"><div><span class="ecma-code-label">'+esc(labels.baseline||row.baselineLabel||'Baseline · loader 后')+'</span><pre><code>'+esc(before||'未提供代码片段')+'</code></pre></div><div><span class="ecma-code-label">'+esc(labels.experiment||row.experimentLabel||'提高 ECMA 后 · loader 后')+'</span><pre><code>'+esc(after||'未提供代码片段')+'</code></pre></div></div>'+(row.artifacts||row.links?'<div class="ecma-artifacts">'+artifactLinksHtml(row.artifacts||row.links)+'</div>':'')+'</article>'}).join('')}
function attemptStatusLabel(status){return {'recovered':'已解决','success':'成功','failed':'失败','abandoned':'已放弃','running':'处理中','blocked':'受阻'}[status]||status||'未标记'}
function renderFailureLedger(a){var rows=Array.isArray(a.failureLedger)?a.failureLedger:[];if(!rows.length)return '<p class="ecma-note">没有登记 ECMA 专项失败/重试记录。若分析命令失败，必须补充失败原因、已尝试修复和最终处置。</p>';return '<div class="table-wrap"><table class="ecma-table"><thead><tr><th>分析 / 尝试</th><th>状态</th><th>命令</th><th>失败原因</th><th>修复 / 重试</th><th>最终处置或下一步</th></tr></thead><tbody>'+rows.map(function(row,index){var status=row.status||row.outcome||'failed';return '<tr><td>'+esc(displayCell(rowValue(row,['analysis','name','stage','id']),'Attempt '+(index+1)))+(row.attempt!=null?' · #'+esc(row.attempt):'')+'</td><td><b class="attempt-'+esc(status)+'">'+esc(attemptStatusLabel(status))+'</b></td><td><code>'+esc(displayCell(rowValue(row,['command','attemptedCommand'])))+'</code></td><td class="reason">'+esc(displayCell(rowValue(row,['error','failureReason','reason'])))+'</td><td class="reason">'+esc(displayCell(rowValue(row,['resolution','retry','fix','recovery'])))+'</td><td class="reason">'+esc(displayCell(rowValue(row,['nextAction','nextCommand','finalDisposition','result'])))+'</td></tr>'}).join('')+'</tbody></table></div>'}
function ecmaDetails(title,meta,body,open){return '<details class="ecma-evidence"'+(open?' open':'')+'><summary>'+esc(title)+(meta?'<span>'+esc(meta)+'</span>':'')+'</summary><div class="ecma-evidence-body">'+body+'</div></details>'}
function renderEcmaAttribution(){
  var section=$('#ecma-attribution'),body=$('#ecma-attribution-body'),a=core.ecmaAttribution;
  if(!a){section.hidden=true;return}
  section.hidden=false;
  var b=a.removedBreakdown||{},bytes=a.byteAttribution||{},baseline=Number(a.baselineModuleCount),experiment=Number(a.experimentModuleCount),moduleDelta=Number.isFinite(baseline)&&Number.isFinite(experiment)?experiment-baseline:null;
  var knownCounts=[b.apiPolyfillCount,b.transformHelperCount,b.firstPartyCount,b.ordinaryThirdPartyCount].every(function(value){return value!=null});
  var directAnswer=a.conclusion||('模块移除直答：API polyfill '+optionalCount(b.apiPolyfillCount)+'，transform helper '+optionalCount(b.transformHelperCount)+'，业务代码 '+optionalCount(b.firstPartyCount)+'，普通第三方 '+optionalCount(b.ordinaryThirdPartyCount)+'。');
  var completeness=Array.isArray(a.missingFields)&&a.missingFields.length?'<p class="ecma-note">结构化归因仍缺：'+esc(a.missingFields.join(', '))+'；ECMA 检查已按规则标记为受阻。</p>':'';
  var verdict='<div class="ecma-verdict"><div class="ecma-verdict-top"><h4>'+esc(directAnswer)+'</h4><span class="chip '+(a.diagnosticOnly?'diagnostic':(a.complete?'completed':'blocked'))+'">'+esc(a.diagnosticOnly?'仅诊断，不计入生产收益':(a.complete?'归因完整':'归因不完整'))+'</span></div><p>'+esc(a.comparisonScope||'对比范围未单独说明；请以数字说明和 ECMA check 的构建变量为准。')+'</p></div>';
  var answers='<div class="ecma-answer-grid">'+ecmaCountTile('移除 API polyfill',b.apiPolyfillCount,'core-js 等环境 API 补丁')+ecmaCountTile('移除 transform helper',b.transformHelperCount,'@swc/helpers 等语法降级辅助')+ecmaCountTile('移除业务模块',b.firstPartyCount,'项目自身源码')+ecmaCountTile('移除普通第三方模块',b.ordinaryThirdPartyCount,'排除 polyfill/helper 的 vendor')+'</div>';
  var byteGrid='<div class="ecma-byte-grid">'+ecmaByteTile('appJs RAW Δ',bytes.rawDeltaBytes,'负数表示实验产物更小')+ecmaByteTile('appJs GZIP Δ',bytes.gzipDeltaBytes,'次指标')+ecmaCountValueTile('模块数净变化',moduleDelta,'inventory：'+optionalCount(a.baselineModuleCount)+' → '+optionalCount(a.experimentModuleCount))+ecmaByteTile('Mapped Δ',bytes.mappedDeltaBytes,'source map 可归因生成字节')+ecmaByteTile('Unmapped Δ',bytes.unmappedDeltaBytes,'runtime / wrapper / 无 map 残差')+'</div>';
  var root='<div class="ecma-root-cause"><b>为什么变小</b><p>'+esc(a.rootCause||'未提供根因结论')+'\nLoader 后源码：'+esc(a.postLoaderSourceDiffConclusion||'未提供')+'</p></div>';
  var categories=ecmaDetails('模块类别核对','先区分 API polyfill、语法 helper、业务和普通第三方',renderCategoryTable(a),true);
  var partitions=ecmaDetails('Compilation partition 覆盖',Array.isArray(a.partitionSummary)?a.partitionSummary.length+' 个 partition':'未提供',renderPartitionTable(a),false);
  var removedCount=Array.isArray(a.removedModules)?a.removedModules.length:null,addedCount=Array.isArray(a.addedModules)?a.addedModules.length:null;
  var removed=ecmaDetails('完整 removed modules 与 added modules',(removedCount==null?'removed 未提供':removedCount+' removed')+' · '+(addedCount==null?'added 未提供':addedCount+' added'),'<h5>完整 removed modules</h5>'+renderRemovedModules(a)+'<h5>完整 added modules</h5>'+renderAddedModules(a),false);
  var retained=ecmaDetails('Retained source：缩小 / 变大',(Array.isArray(a.retainedShrunkSources)?a.retainedShrunkSources.length:0)+' shrink · '+(Array.isArray(a.retainedGrownSources)?a.retainedGrownSources.length:0)+' grow','<h5>缩小的 retained source</h5>'+retainedRowsHtml(a.retainedShrunkSources)+'<h5>变大的 retained source</h5>'+retainedRowsHtml(a.retainedGrownSources)+'<h5>Top generated-byte contributors</h5>'+retainedRowsHtml(a.topGeneratedByteContributors),false);
  var loader=ecmaDetails('逐模块 loader 后源码差异',Array.isArray(a.postLoaderDiffs)?a.postLoaderDiffs.length+' 组 before / after':'未提供',renderPostLoaderDiffs(a),false);
  var mapping=ecmaDetails('Mapped / unmapped 字节对账','RAW 为主指标；source map 只做归因','<div class="table-wrap"><table class="ecma-table"><thead><tr><th>范围</th><th>Baseline</th><th>Experiment</th><th>Δ</th><th>说明</th></tr></thead><tbody><tr><td>Mapped</td><td class="num">'+esc(optionalBytes(rowValue(bytes,['mappedBaselineBytes','baselineMappedBytes'])))+'</td><td class="num">'+esc(optionalBytes(rowValue(bytes,['mappedExperimentBytes','experimentMappedBytes'])))+'</td><td class="num">'+esc(optionalBytes(bytes.mappedDeltaBytes))+'</td><td>'+esc(bytes.mappedConclusion||'source map 可归因生成字节')+'</td></tr><tr><td>Unmapped</td><td class="num">'+esc(optionalBytes(rowValue(bytes,['unmappedBaselineBytes','baselineUnmappedBytes'])))+'</td><td class="num">'+esc(optionalBytes(rowValue(bytes,['unmappedExperimentBytes','experimentUnmappedBytes'])))+'</td><td class="num">'+esc(optionalBytes(bytes.unmappedDeltaBytes))+'</td><td>'+esc(bytes.unmappedConclusion||'runtime、wrapper 或经人工审查的无 map 资产')+'</td></tr></tbody></table></div><p class="ecma-note">资产级初步证据：'+esc(listSummary(a.preliminaryAssetEvidence))+'</p>',false);
  var failures=ecmaDetails('失败与重试记录',Array.isArray(a.failureLedger)?a.failureLedger.length+' 条':'未提供',renderFailureLedger(a),false);
  var artifacts=ecmaDetails('Backing artifacts','完整 JSON / Markdown / source diff','<div class="ecma-artifacts">'+artifactLinksHtml(a.artifacts)+'</div>',false);
  body.innerHTML=verdict+answers+byteGrid+root+completeness+(!knownCounts?'<p class="ecma-note">有分类计数未提供；“未提供”与 0 严格区分，不能据此声称没有模块移除。</p>':'')+categories+partitions+removed+retained+loader+mapping+failures+artifacts;
}
function renderSupplementary(){var measurement=$('#measurement-body');measurement.innerHTML=Object.keys(core.measurement||{}).map(function(key){return '<tr><td><code>'+esc(key)+'</code></td><td>'+esc(core.measurement[key])+'</td></tr>'}).join('');var rows=core.optimizations||[],optimizations=rows.filter(function(row){return row.group!=='experiment'}),experiments=rows.filter(function(row){return row.group==='experiment'});$('#optimizations-body').innerHTML=optimizationTableHtml(optimizations,'没有可执行优化条目。');$('#experiments-body').innerHTML=optimizationTableHtml(experiments,'没有诊断实验、已拒绝项或 no-op 实验。');renderEcmaAttribution();var analyses=$('#analysis-links'),analysisRows=core.analyses||[];analyses.innerHTML=analysisRows.length?analysisRows.map(function(row){var missing=row.status==='missing'||!row.href;return '<div class="link-card'+(missing?' missing':'')+'"><b>'+(missing?esc(row.title):'<a href="'+esc(safeHref(row.href))+'">'+esc(row.title)+'</a>')+'</b><span>'+esc(missing?'未生成；报告必须给出补跑命令。':(row.why||row.status))+'</span></div>'}).join(''):'<div class="link-card missing"><b>相关分析页面未登记</b><span>请列出未生成页面及补跑命令，不要静默省略。</span></div>';var actions=$('#actions-body'),actionRows=core.actions||[];actions.innerHTML=actionRows.length?actionRows.map(function(row){return '<tr><td><code>'+esc(row.priority)+'</code></td><td>'+esc(row.action)+'</td><td>'+esc(row.upside)+'</td><td>'+esc(row.risk)+'</td><td><code>'+esc(row.validation)+'</code></td><td>'+esc(row.owner)+'</td></tr>'}).join(''):'<tr><td class="empty-row" colspan="6">没有后续动作；若审计无候选，应在十项检查中保留 no-op 证据。</td></tr>'}
function sortItems(items){var mode=$('#sort-mode').value;return items.sort(function(a,b){if(mode==='name')return a.modulePath.localeCompare(b.modulePath);if(mode==='raw-desc')return b.rawSavingBytes-a.rawSavingBytes||b.unusedBytes-a.unusedBytes;if(mode==='status')return a.status.localeCompare(b.status)||b.unusedBytes-a.unusedBytes;return b.unusedBytes-a.unusedBytes||b.rawSavingBytes-a.rawSavingBytes})}
function highlightText(value,query){if(!query||$('#regex-mode').checked)return esc(value);var text=String(value),i=text.toLowerCase().indexOf(query.toLowerCase());if(i<0)return esc(text);return esc(text.slice(0,i))+'<mark>'+esc(text.slice(i,i+query.length))+'</mark>'+esc(text.slice(i+query.length))}
function renderList(){var viewport=$('#module-list'),spacer=$('#module-spacer'),scrollTop=viewport.scrollTop,height=viewport.clientHeight,start=Math.max(0,Math.floor(scrollTop/ROW_HEIGHT)-OVERSCAN),end=Math.min(filtered.length,Math.ceil((scrollTop+height)/ROW_HEIGHT)+OVERSCAN),query=$('#module-search').value.trim();spacer.style.height=(filtered.length*ROW_HEIGHT)+'px';spacer.innerHTML='';for(var pos=start;pos<end;pos++){var item=core.items[filtered[pos]],button=document.createElement('button');button.className='module-row'+(item.id===selectedId?' selected':'');button.style.transform='translateY('+(pos*ROW_HEIGHT)+'px)';button.dataset.itemId=item.id;button.setAttribute('aria-pressed',item.id===selectedId?'true':'false');button.innerHTML='<div class="module-top"><span class="module-title">'+highlightText(item.title,query)+'</span><span class="chip '+esc(item.status)+'">'+esc(stateLabel(item.status))+'</span></div><div class="module-path">'+highlightText(item.modulePath,query)+'</div><div class="module-foot"><span>unused <strong>'+fmtBytes(item.unusedBytes)+'</strong></span><span>raw save '+fmtBytes(item.rawSavingBytes)+'</span></div>';spacer.appendChild(button)}$('#visible-count').textContent=filtered.length.toLocaleString()+' / '+core.items.length.toLocaleString()}
async function applyFilter(){var query=$('#module-search').value.trim(),regex=$('#regex-mode').checked,error=$('#search-error');error.textContent='';if(regex){var unsafe=safeRegex(query);if(unsafe){error.textContent=unsafe;return}}var rows=core.items.map(function(item){return (item.title+'\n'+item.modulePath+'\n'+item.why).toLowerCase()});try{var found=await workerRequest('filter',{type:'filter',query:query,regex:regex,rows:rows},500);var sorted=sortItems(found.map(function(index){return core.items[index]}));var indexById=new Map(core.items.map(function(item,index){return [item.id,index]}));filtered=sorted.map(function(item){return indexById.get(item.id)});$('#module-list').scrollTop=0;renderList()}catch(err){error.textContent=err.message}}
function evidenceHtml(evidence){if(!Array.isArray(evidence)||!evidence.length)return '<p>未提供结构化证据。</p>';return '<ul class="evidence-list">'+evidence.map(function(row){return '<li>'+esc(typeof row==='string'?row:(row.label||row.path||JSON.stringify(row)))+'</li>'}).join('')+'</ul>'}
async function selectItem(id){var item=core.items.find(function(row){return row.id===id});if(!item)return;selectedId=id;history.replaceState(null,'','#item='+encodeURIComponent(id));renderList();requestVersion++;var version=requestVersion;if(detailController)detailController.abort();detailController=new AbortController();$('#selected-detail').innerHTML='<div class="loading">正在按需加载明细…</div>';try{var shard=await loadShard('details',id,detailController.signal);if(version!==requestVersion)return;var d=shard.detail||{},links=Array.isArray(d.links)?d.links:[];$('#selected-detail').innerHTML='<div class="detail-header"><div><h4>'+esc(item.title)+'</h4><div class="detail-path">'+esc(item.modulePath)+'</div></div><span class="chip '+esc(item.status)+'">'+esc(stateLabel(item.status))+'</span></div><div class="detail-body"><div class="detail-grid"><div class="fact"><h5>结果</h5><p>'+esc(d.result||('unused '+fmtBytes(item.unusedBytes)+' / raw save '+fmtBytes(item.rawSavingBytes)))+'</p></div><div class="fact"><h5>分类</h5><p>'+esc(d.classification||item.classification||'未分类')+'</p></div><div class="fact"><h5>为什么</h5><p>'+esc(d.why||'未提供')+'</p></div><div class="fact"><h5>风险</h5><p>'+esc(d.risk||'未标注')+'</p></div><div class="fact"><h5>怎么验证</h5><p>'+esc(d.validation||'未提供')+'</p></div></div><div class="section"><div class="section-head"><h3>证据</h3></div>'+evidenceHtml(d.evidence)+'</div>'+(links.length?'<div class="artifact-links">'+links.map(function(link){return '<a href="'+esc(safeHref(link.href||link.path||'#'))+'">'+esc(link.label||link.path||'artifact')+'</a>'}).join('')+'</div>':'')+'<div id="source-host"></div></div>';if(d.sourceId)await loadSource(d.sourceId,version);else if(d.code)mountSource({runId:core.runId,id:'inline',path:item.modulePath,source:d.code,ranges:[]});else $('#source-host').innerHTML='<div class="detail-empty">该条目没有源码分片。</div>'}catch(error){if(error.name==='AbortError')return;$('#selected-detail').innerHTML='<div class="error-state">'+esc(error.message)+(location.protocol==='file:'?'<br>大型报告请运行本地服务器。':'')+'</div>'}}
async function loadSource(sourceId,version){var source=await loadShard('sources',sourceId,detailController.signal);if(version!==requestVersion)return;mountSource(source)}
function mountSource(source){sourceState={data:source,lines:String(source.source||'').split('\n')};sourceMatches=[];sourceMatchIndex=-1;var host=$('#source-host');host.innerHTML='<div class="code-panel"><div class="source-title">'+esc(source.path||source.id)+'</div>'+(source.quality&&source.quality.probablyMinified?'<div class="source-quality">源码疑似被压成极少长行；重新捕获可读的 loader 后源码后再作结论。</div>':'')+'<div class="code-toolbar"><input id="source-search" placeholder="搜索源码并跳转高亮…" aria-label="搜索源码"><label class="regex-toggle"><input id="source-regex" type="checkbox"> Regex</label><button id="source-prev" type="button">↑ 上一个</button><button id="source-next" type="button">↓ 下一个</button><span id="source-search-status" class="search-status"></span></div><div id="code-viewport" class="code-viewport" tabindex="0"><div id="code-spacer" class="code-spacer"></div></div></div>';$('#code-viewport').addEventListener('scroll',renderCode);$('#source-search').addEventListener('input',debounce(searchSource,170));$('#source-search').addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();moveSourceMatch(event.shiftKey?-1:1)}});$('#source-prev').addEventListener('click',function(){moveSourceMatch(-1)});$('#source-next').addEventListener('click',function(){moveSourceMatch(1)});renderCode()}
function unusedLine(line){return (sourceState.data.ranges||[]).some(function(range){var start=Number(range.startLine||range.start||0),end=Number(range.endLine||range.end||start);return (range.class==='unused'||range.status==='unused')&&line>=start&&line<=end})}
function matchForLine(line){if(sourceMatchIndex<0)return null;var active=sourceMatches[sourceMatchIndex];return active&&active.line===line?active:null}
function renderCode(){if(!sourceState)return;var viewport=$('#code-viewport'),spacer=$('#code-spacer'),lines=sourceState.lines,top=viewport.scrollTop,height=viewport.clientHeight,start=Math.max(0,Math.floor(top/CODE_LINE_HEIGHT)-OVERSCAN),end=Math.min(lines.length,Math.ceil((top+height)/CODE_LINE_HEIGHT)+OVERSCAN);spacer.style.height=(lines.length*CODE_LINE_HEIGHT)+'px';spacer.innerHTML='';for(var i=start;i<end;i++){var lineNo=i+1,text=lines[i],hit=matchForLine(lineNo),row=document.createElement('div');row.className='code-line'+(unusedLine(lineNo)?' unused':'')+(hit?' search-hit':'');row.style.transform='translateY('+(i*CODE_LINE_HEIGHT)+'px)';var code=hit?esc(text.slice(0,hit.start))+'<mark>'+esc(text.slice(hit.start,hit.end))+'</mark>'+esc(text.slice(hit.end)):esc(text);row.innerHTML='<span class="line-no">'+lineNo+'</span><code class="line-code">'+code+'</code>';spacer.appendChild(row)}}
async function searchSource(){if(!sourceState)return;var input=$('#source-search'),query=input.value,regex=$('#source-regex').checked,status=$('#source-search-status');status.textContent='';if(!query){sourceMatches=[];sourceMatchIndex=-1;renderCode();return}if(regex){var unsafe=safeRegex(query);if(unsafe){status.textContent=unsafe;return}}status.textContent='搜索中…';try{sourceMatches=await workerRequest('source',{type:'source',query:query,regex:regex,text:sourceState.data.source},700);sourceMatchIndex=sourceMatches.length?0:-1;status.textContent=sourceMatches.length?(sourceMatchIndex+1)+' / '+sourceMatches.length:'无匹配';jumpToActiveMatch()}catch(error){status.textContent=error.message}}
function moveSourceMatch(direction){if(!sourceMatches.length)return;sourceMatchIndex=(sourceMatchIndex+direction+sourceMatches.length)%sourceMatches.length;$('#source-search-status').textContent=(sourceMatchIndex+1)+' / '+sourceMatches.length;jumpToActiveMatch()}
function jumpToActiveMatch(){var hit=sourceMatches[sourceMatchIndex];if(!hit){renderCode();return}var viewport=$('#code-viewport');viewport.scrollTop=Math.max(0,(hit.line-5)*CODE_LINE_HEIGHT);renderCode()}
function bind(){var viewport=$('#module-list'),moduleSearch=$('#module-search');viewport.addEventListener('scroll',renderList);viewport.addEventListener('click',function(event){var row=event.target.closest('[data-item-id]');if(row)selectItem(row.dataset.itemId)});moduleSearch.addEventListener('input',debounce(applyFilter,160));moduleSearch.addEventListener('keydown',function(event){if(event.key==='Enter'&&filtered.length){event.preventDefault();selectItem(core.items[filtered[0]].id)}});$('#regex-mode').addEventListener('change',applyFilter);$('#sort-mode').addEventListener('change',applyFilter);document.addEventListener('click',function(event){var link=event.target.closest('a[href^="#item="]');if(!link)return;var requested=decodeURIComponent(link.getAttribute('href').slice(6));if(!core.items.some(function(item){return item.id===requested}))return;event.preventDefault();selectItem(requested);$('#selection').scrollIntoView({block:'start'})});window.addEventListener('hashchange',function(){var hash=new URLSearchParams(location.hash.replace(/^#/,'')),requested=hash.get('item');if(requested&&requested!==selectedId&&core.items.some(function(item){return item.id===requested}))selectItem(requested)});document.addEventListener('keydown',function(event){if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();moduleSearch.focus()}})}
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
<div class="shell"><aside class="sidebar"><nav class="section-nav" aria-label="报告章节"><a href="#conclusion">结论</a><a href="#measurement">数字说明</a><a href="#optimizations">优化</a><a href="#experiments">实验项</a><a href="#coverage">检查</a><a href="#ecma-attribution">ECMA 归因</a><a href="#analyses">分析页面</a><a href="#selection">源码</a><a href="#actions">验证队列</a><a href="#performance">附录</a></nav><div class="sidebar-head"><div class="search-wrap"><input id="module-search" placeholder="搜索模块路径或优化项…" aria-label="搜索模块"><span class="key">⌘ K</span></div><div class="filters"><select id="sort-mode" aria-label="排序"><option value="unused-desc">最大未使用优先</option><option value="raw-desc">最大 raw 收益优先</option><option value="status">按状态</option><option value="name">按路径</option></select><label class="regex-toggle"><input id="regex-mode" type="checkbox"> Regex</label></div><div id="search-error" class="search-status"></div></div><div class="list-meta"><span id="visible-count">—</span><span>点击选中 · 右侧按需加载</span></div><div id="module-list" class="list-viewport"><div id="module-spacer" class="list-spacer"></div></div></aside>
<main class="content"><div class="content-inner"><section class="hero" id="conclusion"><div><div class="eyebrow">decision first</div><h2 id="hero-headline"></h2><p id="hero-statement"></p></div><div class="next-action"><b>NEXT ACTION</b><span id="next-action-text"></span></div></section>
<section class="metrics"><div class="metric primary"><span>已确认 RAW 节省</span><strong id="metric-raw">—</strong></div><div class="metric"><span>已确认 GZIP 节省</span><strong id="metric-gzip">—</strong></div><div class="metric"><span>已落地待量化</span><strong id="metric-unquantified">—</strong></div><div class="metric candidate"><span>候选 RAW 范围</span><strong id="metric-candidate">—</strong></div><div class="metric diagnostic"><span>仅诊断 RAW 范围</span><strong id="metric-diagnostic">—</strong></div></section>
<section class="section" id="measurement"><div class="section-head"><h3>数字说明</h3><span class="section-kicker">raw first / production comparable</span></div><div class="table-wrap"><table><thead><tr><th>术语</th><th>本次定义</th></tr></thead><tbody id="measurement-body"></tbody></table></div></section>
<section class="section" id="optimizations"><div class="section-head"><h3>优化</h3><span class="section-kicker">actionable / sorted by confirmed raw</span></div><div class="table-wrap"><table><thead><tr><th>条目</th><th>状态</th><th>类别</th><th>RAW</th><th>GZIP</th><th>为什么</th><th>怎么验证</th></tr></thead><tbody id="optimizations-body"></tbody></table></div></section>
<section class="section" id="experiments"><div class="section-head"><h3>实验项</h3><span class="section-kicker">diagnostic / rejected / completed-no-op</span></div><div class="table-wrap"><table><thead><tr><th>条目</th><th>状态</th><th>类别</th><th>RAW</th><th>GZIP</th><th>为什么</th><th>怎么验证</th></tr></thead><tbody id="experiments-body"></tbody></table></div></section>
<section class="section" id="coverage"><div class="section-head"><h3>十项检查覆盖</h3><span class="section-kicker">fresh artifact required</span></div><div class="table-wrap"><table><thead><tr><th>检查</th><th>状态</th><th>结论</th><th>证据</th><th>命令 / 阻塞</th></tr></thead><tbody id="checks-body"></tbody></table></div></section>
<section class="section" id="ecma-attribution" hidden><div class="section-head"><h3>提高 ECMA 等级：体积下降归因</h3><span class="section-kicker">先看模块是否消失，再展开 loader 与产物证据</span></div><div id="ecma-attribution-body"></div></section>
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
    ecmaAttribution: normalized.ecmaAttribution,
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
  const renderedAt = new Date().toISOString();
  const corePath = resolve(outDir, 'report-core.json');
  const manifestPath = resolve(outDir, 'report-manifest.json');
  const htmlSha256 = sha256File(htmlPath);
  const coreSha256 = sha256File(corePath);
  const cssSha256 = sha256File(resolve(outDir, 'report.css'));
  const clientSha256 = sha256File(resolve(outDir, 'report.js'));
  const dataSha256 = sha256DirectoryFiles(dataDir);
  writeFileSync(manifestPath, JSON.stringify({
    version: 2,
    runId: core.runId,
    generatedAt: renderedAt,
    html: basename(htmlPath),
    useServer,
    auditStatus: core.overallStatus,
    overallStatus: 'incomplete',
    deliveryStatus: 'pending-readability-review',
    readabilityReview: {
      required: true,
      status: 'pending',
      path: 'readability-review.md',
      generatedAt: renderedAt,
      htmlSha256,
      coreSha256,
      cssSha256,
      clientSha256,
      dataSha256,
      finalizeCommand: `node ${JSON.stringify(__filename)} --finalize-readability --out-dir ${JSON.stringify(outDir)}`,
    },
    performance: core.performance,
    privacy: 'local-only; redact source, paths, commands, and package metadata before publishing',
  }, null, 2) + '\n');
  return { htmlPath, useServer, core, outDir };
}

function reviewFields(text) {
  const fields = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

function resolveReviewArtifact(root, value, label) {
  if (!value) throw new Error(`Readability review is missing ${label}`);
  const absolute = isAbsolute(value);
  const file = absolute ? resolve(value) : resolve(root, value);
  if (!absolute) {
    const fromRoot = relative(root, file);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`${label} relative path must stay inside the report directory`);
  }
  if (!existsSync(file)) throw new Error(`${label} does not exist: ${file}`);
  return file;
}

function parseViewport(value, label) {
  const match = /^(\d+)x(\d+)$/.exec(value || '');
  if (!match) throw new Error(`${label} must use WIDTHxHEIGHT`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function notApplicable(value) {
  return /^not-applicable:\s*\S(?:.*\S)?$/.test(value || '');
}

function finalizeReadabilityReview({ outDir, reviewPath }) {
  const root = resolve(outDir);
  const manifestPath = resolve(root, 'report-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Missing report manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const review = manifest.readabilityReview || {};
  const reviewFile = reviewPath ? resolve(reviewPath) : resolve(root, review.path || 'readability-review.md');
  try {
    if (!existsSync(reviewFile)) throw new Error(`Missing readability review: ${reviewFile}`);
    const htmlPath = resolve(root, manifest.html || 'bundle-optimization-report.html');
    const corePath = resolve(root, 'report-core.json');
    const cssPath = resolve(root, 'report.css');
    const clientPath = resolve(root, 'report.js');
    const dataPath = resolve(root, 'data');
    if (!existsSync(htmlPath) || !existsSync(corePath) || !existsSync(cssPath) || !existsSync(clientPath) || !existsSync(dataPath)) throw new Error('Final HTML, core, CSS, client, or data directory is missing');
    const actualHtmlSha256 = sha256File(htmlPath);
    const actualCoreSha256 = sha256File(corePath);
    const actualCssSha256 = sha256File(cssPath);
    const actualClientSha256 = sha256File(clientPath);
    const actualDataSha256 = sha256DirectoryFiles(dataPath);
    if (actualHtmlSha256 !== review.htmlSha256) throw new Error('Final HTML hash differs from the rendered artifact recorded in the manifest');
    if (actualCoreSha256 !== review.coreSha256) throw new Error('report-core.json hash differs from the rendered artifact recorded in the manifest');
    if (actualCssSha256 !== review.cssSha256) throw new Error('report.css hash differs from the rendered artifact recorded in the manifest');
    if (actualClientSha256 !== review.clientSha256) throw new Error('report.js hash differs from the rendered artifact recorded in the manifest');
    if (actualDataSha256 !== review.dataSha256) throw new Error('data shard hash differs from the rendered artifact recorded in the manifest');

    const text = readFileSync(reviewFile, 'utf8');
    const fields = reviewFields(text);
    const finalNonemptyLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    const required = [
      'runId', 'generatedAt', 'htmlSha256', 'coreSha256', 'cssSha256', 'clientSha256', 'dataSha256',
      'browser', 'reportUrl', 'desktopViewport', 'narrowViewport', 'desktopScreenshot', 'narrowScreenshot',
      'consoleErrors', 'highImpactItemId', 'noOpOrRejectedItemId', 'sourceQuery', 'sourceMatchLocation', 'reviewedAt',
    ];
    const missing = required.filter((field) => !fields[field]);
    if (missing.length) throw new Error(`Readability review is missing metadata: ${missing.join(', ')}`);
    if (fields.runId !== manifest.runId) throw new Error('Readability review runId does not match the final report');
    if (fields.generatedAt !== manifest.generatedAt) throw new Error('Readability review generatedAt does not match the final rendered artifact');
    if (fields.htmlSha256 !== actualHtmlSha256) throw new Error('Readability review htmlSha256 does not match the final HTML');
    if (fields.coreSha256 !== actualCoreSha256) throw new Error('Readability review coreSha256 does not match report-core.json');
    if (fields.cssSha256 !== actualCssSha256) throw new Error('Readability review cssSha256 does not match report.css');
    if (fields.clientSha256 !== actualClientSha256) throw new Error('Readability review clientSha256 does not match report.js');
    if (fields.dataSha256 !== actualDataSha256) throw new Error('Readability review dataSha256 does not match the detail/source shards');
    const desktop = parseViewport(fields.desktopViewport, 'desktopViewport');
    const narrow = parseViewport(fields.narrowViewport, 'narrowViewport');
    if (desktop.width < 1280 || desktop.height < 720) throw new Error('desktopViewport must be at least 1280x720');
    if (narrow.width > 480 || narrow.height < 720) throw new Error('narrowViewport must be at most 480px wide and at least 720px high');
    if (desktop.width === narrow.width && desktop.height === narrow.height) throw new Error('desktopViewport and narrowViewport must be different');
    const desktopScreenshot = resolveReviewArtifact(root, fields.desktopScreenshot, 'desktopScreenshot');
    const narrowScreenshot = resolveReviewArtifact(root, fields.narrowScreenshot, 'narrowScreenshot');
    if (desktopScreenshot === narrowScreenshot) throw new Error('desktopScreenshot and narrowScreenshot must be different files');
    if (fields.consoleErrors !== '0') throw new Error('consoleErrors must be exactly 0');
    let reportUrl;
    try { reportUrl = new URL(fields.reportUrl); } catch { throw new Error('reportUrl must be an absolute file://, http://, or https:// URL'); }
    if (!['file:', 'http:', 'https:'].includes(reportUrl.protocol)) throw new Error('reportUrl must use file://, http://, or https://');
    if (decodeURIComponent(basename(reportUrl.pathname)) !== basename(htmlPath)) throw new Error('reportUrl must point to the final HTML artifact');
    const core = JSON.parse(readFileSync(corePath, 'utf8'));
    const detailFiles = readdirSync(resolve(dataPath, 'details')).filter((name) => name.endsWith('.json'));
    if (notApplicable(fields.highImpactItemId)) {
      if (detailFiles.length || core.items.length) throw new Error('highImpactItemId cannot be not-applicable when detail items exist');
    } else if (!core.items.some((item) => item.id === fields.highImpactItemId)) {
      throw new Error('highImpactItemId does not exist in the final report');
    }
    const noOpOrRejectedItems = core.items.filter((item) => ['completed-no-op', 'rejected'].includes(item.status));
    if (notApplicable(fields.noOpOrRejectedItemId)) {
      if (noOpOrRejectedItems.length) throw new Error('noOpOrRejectedItemId cannot be not-applicable when no-op/rejected items exist');
    } else if (!noOpOrRejectedItems.some((item) => item.id === fields.noOpOrRejectedItemId)) {
      throw new Error('noOpOrRejectedItemId must identify a completed-no-op or rejected detail item');
    }
    const sourceFiles = readdirSync(resolve(dataPath, 'sources')).filter((name) => name.endsWith('.json'));
    if (notApplicable(fields.sourceQuery)) {
      if (!notApplicable(fields.sourceMatchLocation)) throw new Error('sourceMatchLocation must also be not-applicable:<reason> when sourceQuery is not applicable');
      if (sourceFiles.length) throw new Error('sourceQuery cannot be not-applicable when source shards exist');
    } else {
      if (notApplicable(fields.sourceMatchLocation)) throw new Error('sourceMatchLocation cannot be not-applicable when sourceQuery is present');
      const sourceLocation = /^([^:]+):(\d+)(?::(\d+))?$/.exec(fields.sourceMatchLocation);
      if (!sourceLocation) throw new Error('sourceMatchLocation must use SOURCE_ID:LINE or SOURCE_ID:LINE:COLUMN');
      const sourceFile = resolve(root, 'data', 'sources', `${sourceLocation[1]}.json`);
      if (!existsSync(sourceFile)) throw new Error('sourceMatchLocation source ID does not exist');
      const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
      const sourceLine = String(source.source || '').split('\n')[Number(sourceLocation[2]) - 1];
      if (sourceLine === undefined || !sourceLine.includes(fields.sourceQuery)) throw new Error('sourceQuery is not present at sourceMatchLocation');
      if (sourceLocation[3] && !sourceLine.startsWith(fields.sourceQuery, Number(sourceLocation[3]) - 1)) throw new Error('sourceQuery does not start at the recorded source column');
    }
    const generatedTime = Date.parse(fields.generatedAt);
    const reviewedTime = Date.parse(fields.reviewedAt);
    if (!Number.isFinite(reviewedTime) || !Number.isFinite(generatedTime) || reviewedTime < generatedTime) throw new Error('Readability review reviewedAt must be a valid time at or after generatedAt');
    if (finalNonemptyLine !== 'verdict: pass') throw new Error('Readability review final non-empty line must be exactly "verdict: pass"');

    const auditStatus = manifest.auditStatus || core.overallStatus || 'incomplete';
    manifest.readabilityReview = {
      ...review,
      status: 'passed',
      verdict: 'pass',
      path: basename(reviewFile),
      reviewSha256: sha256File(reviewFile),
      browser: fields.browser,
      reportUrl: fields.reportUrl,
      desktopScreenshot: fields.desktopScreenshot,
      narrowScreenshot: fields.narrowScreenshot,
      reviewedAt: fields.reviewedAt,
      validatedAt: new Date().toISOString(),
    };
    manifest.auditStatus = auditStatus;
    manifest.deliveryStatus = auditStatus === 'complete' ? 'ready' : 'incomplete-checks';
    manifest.overallStatus = auditStatus === 'complete' ? 'complete' : 'incomplete';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } catch (error) {
    manifest.overallStatus = 'incomplete';
    manifest.deliveryStatus = 'readability-review-failed';
    manifest.readabilityReview = {
      ...review,
      status: 'failed',
      failureReason: error.message,
      validatedAt: new Date().toISOString(),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    throw error;
  }
}

function selfTest() {
  const root = mkdtempSync(resolve(tmpdir(), 'bundle-report-render-'));
  try {
    const assert = (condition, message) => { if (!condition) throw new Error(`self-test assertion failed: ${message}`); };
    // Compile the generated client separately; node --check on this renderer
    // cannot see syntax mistakes inside the String.raw payload.
    new Function(CLIENT_JS);
    const inputPath = resolve(root, 'input.json');
    const checks = CHECKS.map(([id]) => ({ id, state: 'completed-no-op', result: 'fixture proof', evidence: `${id}.json` }));
    const fixture = {
      runId: 'fixture-run',
      title: 'Fixture Bundle Report',
      summary: { headline: '0 B confirmed', confirmedRawSavingBytes: 0 },
      checks,
      modules: [{ id: 'module-a', path: 'src/a.js', unusedBytes: 120, sourceId: 'source-a', reason: 'fixture' }],
      optimizations: [
        {
          id: 'optimization-a',
          detailItemId: 'module-a',
          title: 'Export usage root cause',
          path: 'src/a.js',
          status: 'unquantified',
          classification: 'export-root-cause',
          rawSavingBytes: 2048,
          result: 'implemented; production measurement pending',
          why: 'high retained-unused bytes',
          risk: 'runtime export access',
          evidence: 'export-usage.json',
          validation: 'pnpm build',
        },
        {
          id: 'optimization-b',
          title: 'Rejected package metadata edit',
          path: 'node_modules/pkg/index.js',
          status: 'rejected',
          classification: 'unsafe-side-effect-removal',
          why: 'top-level registration is observable',
          risk: 'runtime regression',
          evidence: ['side-effects-review.json'],
          validation: 'keep rejected',
        },
      ],
      ecmaAttribution: {
        appJsRawDeltaBytes: -60000,
        appJsGzipDeltaBytes: -9000,
        baselineAppJsRawBytes: 1000000,
        conclusion: 'API polyfill 2 项、transform helper 1 项被移除；业务与普通第三方模块均为 0。',
        comparisonScope: 'fixture baseline → modern target；diagnostic only',
        diagnosticOnly: true,
        baselineModuleCount: 4,
        experimentModuleCount: 1,
        addedModules: [],
        removedModules: [
          { canonicalIdentity: 'core-js/modules/es.promise.js', category: 'api-polyfill', partition: 'web', reason: 'target supports Promise' },
          { canonicalIdentity: 'core-js/modules/es.array.iterator.js', category: 'api-polyfill', partition: 'web', reason: 'target supports iterator' },
          { canonicalIdentity: '@swc/helpers/_extends', category: 'transform-helper', partition: 'web', reason: 'native object spread retained' },
        ],
        moduleCategories: [
          { id: 'api-polyfill', label: 'API polyfill', removedCount: 2, addedCount: 0, netModuleDelta: -2, description: 'API support' },
          { id: 'transform-helper', label: 'Transform helper', removedCount: 1, addedCount: 0, netModuleDelta: -1, description: 'syntax lowering' },
          { id: 'first-party', label: '业务代码', removedCount: 0, addedCount: 0, netModuleDelta: 0 },
          { id: 'ordinary-third-party', label: '普通第三方', removedCount: 0, addedCount: 0, netModuleDelta: 0 },
        ],
        partitionSummary: [{ id: 'web', baselineModuleCount: 4, experimentModuleCount: 1, removedCount: 3, addedCount: 0, retainedCount: 1, rawDeltaBytes: -60000, gzipDeltaBytes: -9000, conclusion: 'complete' }],
        retainedShrunkSources: [{ sourcePath: 'src/a.js', joinKind: 'one-to-one', modulePath: 'src/a.js', confidence: 1 }],
        retainedGrownSources: [],
        topGeneratedByteContributors: [{ sourcePath: 'src/a.js', bytes: -60000 }],
        postLoaderSourceDiffConclusion: 'loader output is unchanged',
        postLoaderDiffs: [{
          title: 'src/a.js',
          reason: 'native object spread is retained',
          removedHelpers: ['@swc/helpers/_extends'],
          baselineSnippet: 'var a = _extends({}, input);',
          experimentSnippet: 'const a = { ...input };',
        }],
        rootCause: 'minifier output changed for the retained source',
        byteAttribution: {
          rawDeltaBytes: -60000,
          gzipDeltaBytes: -9000,
          mappedBaselineBytes: 900000,
          mappedExperimentBytes: 840000,
          mappedDeltaBytes: -60000,
          unmappedBaselineBytes: 100000,
          unmappedExperimentBytes: 100000,
          unmappedDeltaBytes: 0,
        },
        failureLedger: [{ analysis: 'module diff', status: 'recovered', command: 'node ecma-module-diff.cjs', error: 'fixture RangeError', resolution: 'stream arrays', result: 'rerun succeeded' }],
        artifacts: ['ecma-attribution.json'],
      },
      sources: [{ id: 'source-a', path: 'src/a.js', source: 'export const a = 1;\n', ranges: [{ startLine: 1, endLine: 1, status: 'unused' }] }],
    };
    writeFileSync(inputPath, JSON.stringify(fixture));

    const normalized = normalizeReport(fixture);
    assert(normalized.overallStatus === 'complete', 'complete material ECMA attribution should pass');
    assert(normalized.ecmaAttribution?.material === true, 'negative material ECMA delta should be detected by absolute magnitude');
    assert(normalized.ecmaAttribution.removedBreakdown.apiPolyfillCount === 2
      && normalized.ecmaAttribution.removedBreakdown.transformHelperCount === 1
      && normalized.ecmaAttribution.removedBreakdown.firstPartyCount === 0
      && normalized.ecmaAttribution.removedBreakdown.ordinaryThirdPartyCount === 0,
    'ECMA module-category counts should distinguish polyfills, helpers, first-party, and ordinary third-party modules');
    assert(normalized.ecmaAttribution.partitionSummary.length === 1
      && normalized.ecmaAttribution.postLoaderDiffs.length === 1
      && normalized.ecmaAttribution.failureLedger.length === 1,
    'ECMA partition, loader diff, and failure-ledger rows should survive normalization');
    assert(normalized.ecmaAttribution.byteAttribution.mappedDeltaBytes === -60000
      && normalized.ecmaAttribution.mappedBytes === -60000,
    'new byte-attribution fields should satisfy the legacy mapped/unmapped completeness gate');
    assert(materialEcmaChange({ byteAttribution: { rawDeltaBytes: -60000 } }, {}) === true,
      'nested byte attribution should trigger the material ECMA gate');
    const legacyEcma = normalizeReport({
      runId: 'legacy-ecma-fixture',
      checks,
      ecmaAttribution: {
        appJsRawDeltaBytes: -60000,
        baselineAppJsRawBytes: 1000000,
        baselineModuleCount: 1,
        experimentModuleCount: 1,
        addedModules: [],
        removedModules: [],
        retainedShrunkSources: [],
        retainedGrownSources: [],
        topGeneratedByteContributors: [],
        postLoaderSourceDiffConclusion: 'legacy conclusion',
        rootCause: 'legacy root cause',
        mappedBytes: -50000,
        unmappedBytes: -10000,
        artifacts: ['legacy.json'],
      },
    });
    assert(legacyEcma.overallStatus === 'complete'
      && legacyEcma.ecmaAttribution.removedBreakdown.apiPolyfillCount === null,
    'legacy ECMA schema should remain valid while omitted category counts stay unknown');
    assert(normalized.items.length === 2, 'each optimization should have exactly one detail item');
    const merged = normalized.items.find((item) => item.id === 'module-a');
    assert(merged.status === 'unquantified' && merged.classification === 'export-root-cause', 'optimization status and classification should reach its detail item');
    assert(merged.detail.risk.includes('runtime export access') && merged.detail.evidence.includes('export-usage.json'), 'optimization risk and evidence should survive detail merge');
    const rejected = normalized.optimizations.find((row) => row.id === 'optimization-b');
    assert(rejected.group === 'experiment' && rejected.detailItemId === 'optimization-b', 'rejected optimization should be an experiment with a detail item');

    const preservedBlocked = normalizeChecks([{
      id: 'baseline',
      state: 'blocked',
      result: 'failed',
      attemptedCommand: 'pnpm build',
      error: 'exit 1: fixture',
      missingPrerequisite: 'BUILD_TOKEN',
      nextCommand: 'BUILD_TOKEN=x pnpm build',
    }])[0];
    assert(preservedBlocked.attemptedCommand === 'pnpm build'
      && preservedBlocked.error === 'exit 1: fixture'
      && preservedBlocked.missingPrerequisite === 'BUILD_TOKEN'
      && preservedBlocked.nextCommand === 'BUILD_TOKEN=x pnpm build', 'blocked check should retain all four failure fields');
    const unsupportedNoOp = normalizeChecks([{ id: 'baseline', state: 'completed-no-op', result: 'nothing found' }])[0];
    assert(unsupportedNoOp.state === 'blocked' && /fresh evidence/.test(unsupportedNoOp.error), 'completed-no-op without evidence should be blocked');

    const materialWithoutAttribution = normalizeReport({
      runId: 'material-missing-attribution',
      checks: checks.map((check) => check.id === 'ecma' ? { ...check, appJsRawDeltaBytes: -60000 } : check),
    });
    const gatedEcma = materialWithoutAttribution.checks.find((check) => check.id === 'ecma');
    assert(gatedEcma.state === 'blocked' && gatedEcma.missingPrerequisite.includes('retainedShrunkSources'), 'material ECMA regression without structured attribution should be blocked');

    const result = renderReport({ inputPath, outDir: resolve(root, 'report') });
    const html = readFileSync(result.htmlPath, 'utf8');
    const reportJs = readFileSync(resolve(root, 'report', 'report.js'), 'utf8');
    const detail = JSON.parse(readFileSync(resolve(root, 'report', 'data', 'details', 'module-a.json'), 'utf8'));
    assert(html.includes('module-search') && html.includes('selected-detail') && html.includes('experiments-body') && html.includes('ecma-attribution-body'), 'HTML should contain search, detail, experiment, and ECMA sections');
    assert(reportJs.includes("'unquantified':'待量化'") && reportJs.includes("'rejected':'已拒绝'"), 'Chinese status labels should be emitted');
    assert(reportJs.includes('移除 API polyfill')
      && reportJs.includes('完整 removed modules')
      && reportJs.includes('逐模块 loader 后源码差异')
      && reportJs.includes('失败与重试记录'),
    'ECMA report should lead with direct category answers and expose complete evidence drill-downs');
    assert(detail.detail.risk.includes('runtime export access') && detail.detail.classification === 'export-root-cause', 'detail shard should retain optimization review fields');
    assert(existsSync(resolve(root, 'report', 'data', 'sources', 'source-a.json')), 'source shard should be emitted');

    const manifestPath = resolve(root, 'report', 'report-manifest.json');
    let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert(manifest.auditStatus === 'complete' && manifest.overallStatus === 'incomplete' && manifest.deliveryStatus === 'pending-readability-review', 'rendered report should remain incomplete until readability review passes');
    const reviewPath = resolve(root, 'report', 'readability-review.md');
    writeFileSync(resolve(root, 'report', 'desktop.png'), 'desktop fixture');
    writeFileSync(resolve(root, 'report', 'narrow.png'), 'narrow fixture');
    const reviewedAt = new Date(Date.parse(manifest.generatedAt) + 1000).toISOString();
    const reviewText = (htmlSha256) => [
      `runId: ${manifest.runId}`,
      `generatedAt: ${manifest.generatedAt}`,
      `htmlSha256: ${htmlSha256}`,
      `coreSha256: ${manifest.readabilityReview.coreSha256}`,
      `cssSha256: ${manifest.readabilityReview.cssSha256}`,
      `clientSha256: ${manifest.readabilityReview.clientSha256}`,
      `dataSha256: ${manifest.readabilityReview.dataSha256}`,
      'browser: Chromium',
      `reportUrl: file://${result.htmlPath}`,
      'desktopViewport: 1440x900',
      'narrowViewport: 390x844',
      'desktopScreenshot: desktop.png',
      'narrowScreenshot: narrow.png',
      'consoleErrors: 0',
      'highImpactItemId: module-a',
      'noOpOrRejectedItemId: optimization-b',
      'sourceQuery: export const a',
      'sourceMatchLocation: source-a:1:1',
      `reviewedAt: ${reviewedAt}`,
      '',
      'Checked overview, both tables, detail card, and source panel.',
      '',
      'verdict: pass',
      '',
    ].join('\n');
    writeFileSync(reviewPath, reviewText('0'.repeat(64)));
    let staleReviewRejected = false;
    try { finalizeReadabilityReview({ outDir: resolve(root, 'report') }); } catch { staleReviewRejected = true; }
    assert(staleReviewRejected, 'stale readability review should be rejected');
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert(manifest.readabilityReview.status === 'failed' && manifest.deliveryStatus === 'readability-review-failed', 'failed review reason should be machine visible');

    writeFileSync(reviewPath, reviewText(manifest.readabilityReview.htmlSha256));
    manifest = finalizeReadabilityReview({ outDir: resolve(root, 'report') });
    assert(manifest.readabilityReview.status === 'passed' && manifest.overallStatus === 'complete' && manifest.deliveryStatus === 'ready', 'matching readability review should complete delivery');

    const emptyInputPath = resolve(root, 'empty-input.json');
    writeFileSync(emptyInputPath, JSON.stringify({ runId: 'empty-fixture-run', checks, optimizations: [], modules: [], sources: [] }));
    const emptyResult = renderReport({ inputPath: emptyInputPath, outDir: resolve(root, 'empty-report') });
    const emptyManifestPath = resolve(root, 'empty-report', 'report-manifest.json');
    const emptyManifest = JSON.parse(readFileSync(emptyManifestPath, 'utf8'));
    writeFileSync(resolve(root, 'empty-report', 'desktop.png'), 'desktop fixture');
    writeFileSync(resolve(root, 'empty-report', 'narrow.png'), 'narrow fixture');
    writeFileSync(resolve(root, 'empty-report', 'readability-review.md'), [
      `runId: ${emptyManifest.runId}`,
      `generatedAt: ${emptyManifest.generatedAt}`,
      `htmlSha256: ${emptyManifest.readabilityReview.htmlSha256}`,
      `coreSha256: ${emptyManifest.readabilityReview.coreSha256}`,
      `cssSha256: ${emptyManifest.readabilityReview.cssSha256}`,
      `clientSha256: ${emptyManifest.readabilityReview.clientSha256}`,
      `dataSha256: ${emptyManifest.readabilityReview.dataSha256}`,
      'browser: Chromium',
      `reportUrl: file://${emptyResult.htmlPath}`,
      'desktopViewport: 1440x900',
      'narrowViewport: 390x844',
      'desktopScreenshot: desktop.png',
      'narrowScreenshot: narrow.png',
      'consoleErrors: 0',
      'highImpactItemId: not-applicable:no detail items',
      'noOpOrRejectedItemId: not-applicable:no no-op or rejected detail items',
      'sourceQuery: not-applicable:no source shards',
      'sourceMatchLocation: not-applicable:no source shards',
      `reviewedAt: ${new Date(Date.parse(emptyManifest.generatedAt) + 1000).toISOString()}`,
      '',
      'verdict: pass',
      '',
    ].join('\n'));
    const emptyFinal = finalizeReadabilityReview({ outDir: resolve(root, 'empty-report') });
    assert(emptyFinal.deliveryStatus === 'ready', 'truthful not-applicable review fields should allow an empty report to pass');
    console.log('render-bundle-report self-test passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  if (args['finalize-readability']) {
    const outDir = resolve(args['out-dir'] || 'report');
    const manifest = finalizeReadabilityReview({ outDir, reviewPath: args['readability-review'] });
    console.log(`readability=${manifest.readabilityReview.status}`);
    console.log(`delivery=${manifest.deliveryStatus}`);
    return manifest;
  }
  const inputPath = resolve(args.input || 'bundle-report-data.json');
  const outDir = resolve(args['out-dir'] || resolve(dirname(inputPath), 'report'));
  const result = renderReport({ inputPath, outDir, title: args.title, forceServer: Boolean(args['force-server']) });
  console.log(`wrote ${result.htmlPath}`);
  console.log(`mode=${result.useServer ? 'local-server-required' : 'standalone-file-supported'}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { CHECKS, finalizeReadabilityReview, normalizeChecks, normalizeEcmaAttribution, normalizeReport, renderReport, stableId };
