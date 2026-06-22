#!/usr/bin/env node
// Usage-kind / artifact analysis: WHY is an export used?
//
// rspack marks an export "used" if anything references it — but the reference may be
// an ARTIFACT, not real runtime use. The classic case: with `emitDecoratorMetadata`,
// a class imported only as a TYPE on a decorated member/param is emitted as a runtime
// `_ts_metadata("design:type", X)` reference, so rspack keeps the whole class even
// though it is functionally type-only. This pass reads each marker module's POST-LOADER
// source (captured via module.originalSource()) and, for every imported binding,
// classifies whether it is referenced genuinely or ONLY inside decorator-metadata emit.
//
// Input:  rsdoctor-marker-sources.json  ({ modules: [{path, source}] })  from the capture plugin.
// Output: usage-kind-analysis.{json,md}
//
// Usage:  node usage-kind-analysis.template.cjs --sources rsdoctor-marker-sources.json --out-dir . --context "$PWD"
//         node usage-kind-analysis.template.cjs --self-test   # prove the detector fires on a synthetic fixture

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
const { resolve, dirname, relative } = require('path');

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

// JS built-in / structural type names that decorator metadata emits but are not imports.
const BUILTIN_TYPES = new Set([
  'Object', 'Function', 'Array', 'Promise', 'String', 'Number', 'Boolean', 'Symbol',
  'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'void', 'undefined',
  'null', 'BigInt', 'ArrayBuffer', 'Uint8Array', 'Int8Array', 'Float32Array',
]);

const IDENT = /[A-Za-z_$][\w$]*/g;

// Extract the argument text of every `_ts_metadata(...)` / `__metadata(...)` call,
// walking balanced parens so nested array/generic args (`[HeavyType]`) are captured.
function metadataCallArgs(src) {
  const args = [];
  const callRe = /\b(?:_ts_metadata|__metadata)\(/g;
  let m;
  while ((m = callRe.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
    }
    const inner = src.slice(start, i - 1);
    // 2nd argument = everything after the first top-level comma (the "design:*" string is arg 1)
    const comma = inner.indexOf(',');
    args.push(comma >= 0 ? inner.slice(comma + 1) : inner);
    callRe.lastIndex = i;
  }
  return args;
}

// Parse ESM import bindings from post-loader source. Returns Map<localName, {from, imported}>.
function parseImports(src) {
  const bindings = new Map();
  const importRe = /import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+))?\s*from\s*["']([^"']+)["']/g;
  let m;
  while ((m = importRe.exec(src))) {
    const [, def, named, ns, from] = m;
    if (def) bindings.set(def, { from, imported: 'default' });
    if (ns) bindings.set(ns, { from, imported: '*' });
    if (named) {
      for (const part of named.split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        const asM = seg.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        if (asM) bindings.set(asM[2], { from, imported: asM[1] });
        else bindings.set(seg.replace(/^type\s+/, ''), { from, imported: seg.replace(/^type\s+/, '') });
      }
    }
  }
  return bindings;
}

function isFirstParty(p) {
  return !/[\\/]node_modules[\\/]/.test(p);
}

function analyzeModule(path, source) {
  const bindings = parseImports(source);
  if (bindings.size === 0) return null;

  // collect identifiers referenced inside decorator-metadata calls
  const metaRefs = new Map(); // localName -> count
  for (const arg of metadataCallArgs(source)) {
    const ids = arg.match(IDENT) || [];
    for (const id of ids) {
      if (BUILTIN_TYPES.has(id)) continue;
      metaRefs.set(id, (metaRefs.get(id) || 0) + 1);
    }
  }
  if (metaRefs.size === 0) return null;

  const findings = [];
  for (const [local, meta] of metaRefs) {
    if (!bindings.has(local)) continue; // only imported symbols are artifacts worth flagging
    // total whole-word occurrences
    const all = (source.match(new RegExp('\\b' + local.replace(/[$]/g, '\\$') + '\\b', 'g')) || []).length;
    // occurrences inside metadata calls (already counted) + 1 for the import declaration
    const nonGenuine = meta + 1;
    const genuine = all - nonGenuine;
    if (genuine <= 0) {
      const b = bindings.get(local);
      findings.push({
        symbol: local,
        importedFrom: b.from,
        importedName: b.imported,
        metadataRefs: meta,
        kind: 'decorator-metadata-only',
        fix: `import type { ${b.imported === local ? local : b.imported + ' as ' + local} } from '${b.from}'  (or disable emitDecoratorMetadata on this path)`,
      });
    }
  }
  return findings.length ? { path, firstParty: isFirstParty(path), findings } : null;
}

function render(result, outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'usage-kind-analysis.json'), JSON.stringify(result, null, 2));
  const L = [];
  L.push('# Usage-Kind / Decorator-Metadata Artifact Analysis');
  L.push('');
  L.push(`Marker modules scanned (decorator/metadata emit present): ${result.markerModuleCount}`);
  L.push(`Modules with decorator-metadata-ONLY imports (artifacts): ${result.modulesWithArtifacts} (app: ${result.appModulesWithArtifacts}, vendor: ${result.vendorModulesWithArtifacts})`);
  L.push(`Distinct artifact imports: ${result.totalArtifactImports}`);
  L.push('');
  L.push('An "artifact" import is a symbol referenced ONLY inside `_ts_metadata("design:*", …)` emit — kept alive by `emitDecoratorMetadata`, not real runtime use. Fix: `import type` (or turn off metadata emit on that path).');
  L.push('');
  if (result.appArtifacts.length) {
    L.push('## App / first-party (actionable — change to `import type`)');
    L.push('');
    L.push('| module | symbol | from | fix |');
    L.push('| --- | --- | --- | --- |');
    for (const a of result.appArtifacts) L.push(`| ${a.module} | ${a.symbol} | ${a.importedFrom} | ${a.fix} |`);
    L.push('');
  } else {
    L.push('_No app/first-party decorator-metadata artifacts found. (If the project uses TC39 `2022-03` decorators rather than legacy `experimentalDecorators` + `emitDecoratorMetadata`, no `design:*` metadata is emitted from app code — this is expected.)_');
    L.push('');
  }
  if (result.vendorArtifacts.length) {
    L.push('## Vendor (node_modules — not app-fixable; patch upstream or accept)');
    L.push('');
    L.push('| package module | symbol | from |');
    L.push('| --- | --- | --- |');
    for (const a of result.vendorArtifacts.slice(0, 40)) L.push(`| ${a.module} | ${a.symbol} | ${a.importedFrom} |`);
    if (result.vendorArtifacts.length > 40) L.push(`| … and ${result.vendorArtifacts.length - 40} more | | |`);
    L.push('');
  }
  writeFileSync(resolve(outDir, 'usage-kind-analysis.md'), L.join('\n') + '\n');
}

function selfTest() {
  // synthetic post-loader source: HeavyType imported ONLY for a decorated ctor param (metadata-only),
  // RealDep imported and actually called.
  const fixture = `
import { HeavyType } from './heavy';
import { RealDep } from './real';
let Svc = class Svc {
  constructor(dep) { this.dep = dep; RealDep(dep); }
};
Svc = _ts_decorate([
  Injectable(),
  _ts_metadata("design:paramtypes", [HeavyType])
], Svc);
export { Svc };
`;
  const r = analyzeModule('/proj/src/svc.ts', fixture);
  const ok = r && r.findings.some(f => f.symbol === 'HeavyType') && !r.findings.some(f => f.symbol === 'RealDep');
  console.log('[self-test]', ok ? 'PASS' : 'FAIL', '— HeavyType flagged metadata-only, RealDep not flagged');
  console.log(JSON.stringify(r, null, 2));
  process.exit(ok ? 0 : 1);
}

function main() {
  const args = parseArgs(process.argv);
  if (args['self-test']) return selfTest();

  const sourcesPath = resolve(args.sources || 'rsdoctor-marker-sources.json');
  const context = resolve(args.context || process.cwd());
  const outDir = resolve(args['out-dir'] || dirname(sourcesPath));
  if (!existsSync(sourcesPath)) throw new Error(`Missing ${sourcesPath} (run the capture plugin first)`);
  const data = JSON.parse(readFileSync(sourcesPath, 'utf8'));
  const mods = data.modules || [];

  const perModule = [];
  for (const { path, source } of mods) {
    const r = analyzeModule(path, source);
    if (r) perModule.push(r);
  }
  const appArtifacts = [];
  const vendorArtifacts = [];
  for (const m of perModule) {
    const rel = m.path.startsWith(context) ? relative(context, m.path) : m.path.replace(/^.*[\\/]node_modules[\\/]/, 'node_modules/');
    for (const f of m.findings) {
      (m.firstParty ? appArtifacts : vendorArtifacts).push({ module: rel, ...f });
    }
  }
  const result = {
    generatedAt: new Date().toISOString(),
    markerModuleCount: data.markerModuleCount ?? mods.length,
    modulesWithArtifacts: perModule.length,
    appModulesWithArtifacts: perModule.filter((m) => m.firstParty).length,
    vendorModulesWithArtifacts: perModule.filter((m) => !m.firstParty).length,
    totalArtifactImports: appArtifacts.length + vendorArtifacts.length,
    appArtifacts,
    vendorArtifacts,
  };
  render(result, outDir);
  console.log(`marker modules: ${result.markerModuleCount} | artifact imports: ${result.totalArtifactImports} (app ${appArtifacts.length}, vendor ${vendorArtifacts.length})`);
  console.log(`wrote ${resolve(outDir, 'usage-kind-analysis.md')}`);
}

main();
