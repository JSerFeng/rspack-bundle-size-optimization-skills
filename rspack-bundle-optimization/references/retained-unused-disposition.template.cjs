#!/usr/bin/env node
// Per-module disposition for EVERY usedExports=[] module.
//
// The retained-unused plugin lists modules with usedExports=[] that are still
// in the bundle, plus their optimization bailouts. That list alone does not say
// whether each module is genuinely dead (safe to drop / mark sideEffects:false)
// or kept for a real runtime side effect. This post-processor gives every module
// a verdict backed by evidence (the bailout statement's source snippet), so the
// analysis is complete and per-module rather than a sampled candidate list.
//
// Input:  the plugin's retained-unused-side-effects-summary.json (has
//         retainedUnusedEntries[].{relResource,resource,size,bailouts,isEntryModule})
// Output: retained-unused-disposition.{json,md}
//
// Usage: node retained-unused-disposition.template.cjs \
//   --summary retained-unused-side-effects-summary.json --out-dir . --context "$PWD"

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { resolve, dirname } = require('path');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (!n || n.startsWith('--')) a[k] = true;
    else { a[k] = n; i++; }
  }
  return a;
}

const args = parseArgs(process.argv);
const summaryPath = resolve(args.summary || 'retained-unused-side-effects-summary.json');
const outDir = resolve(args['out-dir'] || dirname(summaryPath));
const context = resolve(args.context || process.cwd());

const SIDE_EFFECT_RE = /side[_ ]effects in source code/i;
const LOC_RE = /at\s+(.+?):(\d+):/; // "...source code at ./path:LINE:COL..."

const KEEP = 'keep';
const REMOVABLE = 'likely-removable';
const CONFIRM = 'confirm-by-source';
const INVESTIGATE = 'investigate';

// Read a few source lines around the bailout location for evidence.
function snippetFor(resource, line) {
  if (!resource || !line || !existsSync(resource)) return '';
  try {
    const lines = readFileSync(resource, 'utf8').split('\n');
    const start = Math.max(0, line - 1);
    return lines.slice(start, start + 2).map((l, i) => `${start + i + 1}| ${l.trim()}`.slice(0, 160)).join('  ⏎ ');
  } catch {
    return '';
  }
}

function dispositionOf(entry) {
  const r = entry.relResource || entry.resource || '';
  const inNodeModules = /node_modules/.test(r);
  const sideEffectBailout = (entry.bailouts || []).find((b) => SIDE_EFFECT_RE.test(b));
  const hasAnyBailout = (entry.bailouts || []).length > 0;

  // role-based keepers (genuine module-level side effects)
  if (entry.isEntryModule) return { disposition: KEEP, kind: 'entry', reason: 'entry module; its top-level statements are the app bootstrap' };
  if (/[\\/](core-js|regenerator-runtime|tslib|@swc[\\/]helpers)[\\/]/.test(r)) return { disposition: KEEP, kind: 'polyfill', reason: 'polyfill/runtime-helper; pure side effect by design, sideEffects:false would break it' };
  if (/\.css\.[jt]sx?$|[\\/]vanilla-extract[\\/]|\.css$/.test(r)) return { disposition: KEEP, kind: 'style', reason: 'CSS-in-JS / style module; the side effect injects styles' };
  if (/[\\/]bootstrap[\\/]|[\\/]effects?\.[jt]sx?$|[\\/]register|[\\/]contribution|[\\/]setup\.[jt]sx?$|polyfill/i.test(r)) return { disposition: KEEP, kind: 'bootstrap/registration', reason: 'bootstrap / effect-registration / setup module; runs real registration on import' };

  if (sideEffectBailout && inNodeModules) {
    return { disposition: REMOVABLE, kind: 'pkg-missing-sideEffects', reason: 'node_modules ESM with usedExports=[] retained only by a side-effect bailout — the package likely lacks `"sideEffects": false`; override via a module rule or patch and re-measure' };
  }
  if (sideEffectBailout) {
    return { disposition: CONFIRM, kind: 'app-side-effect', reason: 'app source with a side-effect statement; usually a real effect — read the snippet to confirm before marking sideEffects:false' };
  }
  if (!hasAnyBailout) {
    return { disposition: INVESTIGATE, kind: 'retained-no-bailout', reason: 'usedExports=[] but no bailout — retained by chunk membership / concatenation / a re-export; investigate why it is still emitted' };
  }
  return { disposition: CONFIRM, kind: 'other-bailout', reason: 'retained by a non-side-effect bailout; inspect the bailout reason' };
}

function main() {
  if (!existsSync(summaryPath)) throw new Error(`Missing summary: ${summaryPath}`);
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const entries = summary.retainedUnusedEntries || [];

  const rows = entries.map((e) => {
    const seBailout = (e.bailouts || []).find((b) => SIDE_EFFECT_RE.test(b)) || (e.bailouts || [])[0] || '';
    const m = LOC_RE.exec(seBailout);
    const line = m ? Number(m[2]) : 0;
    const snippet = snippetFor(e.resource, line);
    const d = dispositionOf(e);
    return {
      resource: e.relResource || e.resource,
      size: e.size || 0,
      disposition: d.disposition,
      kind: d.kind,
      reason: d.reason,
      bailout: seBailout ? seBailout.slice(0, 140) : '(none)',
      snippet,
    };
  });

  const byDisposition = {};
  for (const row of rows) {
    const b = (byDisposition[row.disposition] ||= { count: 0, bytes: 0, kinds: {} });
    b.count += 1;
    b.bytes += row.size;
    b.kinds[row.kind] = (b.kinds[row.kind] || 0) + 1;
  }
  const likelyRemovableBytes = (byDisposition[REMOVABLE]?.bytes) || 0;

  const result = {
    generatedAt: new Date().toISOString(),
    moduleCount: rows.length,
    likelyRemovableBytes,
    byDisposition,
    modules: rows.sort((a, b) => b.size - a.size),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'retained-unused-disposition.json'), JSON.stringify(result, null, 2));

  const lines = [];
  lines.push('# Retained-Unused Per-Module Disposition');
  lines.push('');
  lines.push(`Every usedExports=[] module is dispositioned (complete, not sampled). Modules: ${rows.length}.`);
  lines.push('');
  lines.push('| disposition | modules | bytes (source) | kinds |');
  lines.push('| --- | ---: | ---: | --- |');
  for (const [disp, s] of Object.entries(byDisposition).sort((a, b) => b[1].count - a[1].count)) {
    const kinds = Object.entries(s.kinds).map(([k, c]) => `${k}:${c}`).join(', ');
    lines.push(`| ${disp} | ${s.count} | ${s.bytes} | ${kinds} |`);
  }
  lines.push('');
  lines.push(`**True removable upper bound (likely-removable only): ${likelyRemovableBytes} B source.** This is the only set worth a \`sideEffects:false\` experiment; keepers are real side effects, confirm-by-source need a read, investigate are retained for a non-bailout reason.`);
  lines.push('');
  lines.push('## Every module');
  lines.push('');
  lines.push('| module | size | disposition | kind | reason | bailout / snippet |');
  lines.push('| --- | ---: | --- | --- | --- | --- |');
  for (const row of rows) {
    const evidence = `${row.bailout}${row.snippet ? '<br>`' + row.snippet.replace(/\|/g, '\\|') + '`' : ''}`;
    lines.push(`| ${row.resource} | ${row.size} | ${row.disposition} | ${row.kind} | ${row.reason} | ${evidence} |`);
  }
  writeFileSync(resolve(outDir, 'retained-unused-disposition.md'), lines.join('\n') + '\n');

  console.log(`modules=${rows.length} likelyRemovableBytes=${likelyRemovableBytes}`);
  console.log('byDisposition:', Object.fromEntries(Object.entries(byDisposition).map(([k, v]) => [k, v.count])));
  console.log(`wrote ${resolve(outDir, 'retained-unused-disposition.md')}`);
}

main();
