#!/usr/bin/env node
// Transform rspack builtin Rsdoctor exportUsageEdges -> skill's rsdoctor-all-export-usage.json
// Edge: [originUkey, originExports[]|null, targetUkey, targetExports[]|null]
// or [originUkey, originExports[]|null, targetUkey, targetExports[]|null, dependencyId, loc, request]
// or object-shaped edge with equivalent fields plus optional loc/request/dependencyId.
// origin=consumer, target=provider.
//   originExports===null  => origin consumes at module level => terminal root
//   targetExports===null  => namespace usage: keeps EVERY export of target alive
//
// Output:
// {
//   usages: [ { resource, exportName, chains: [ { terminal, terminalKind, edges:[{from,to,originExport,targetExport,loc}] } ] } ],
//   moduleLevelImports: [ { targetResource, originResource, originExport, loc, request, dependencyId } ]
// }
//
// Usage: node build-all-export-usage.cjs --raw rsdoctor-export-usage-raw.json --out rsdoctor-all-export-usage.json

const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');

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
const rawPath = resolve(args.raw || 'rsdoctor-export-usage-raw.json');
const outPath = resolve(args.out || 'rsdoctor-all-export-usage.json');
const MAX_DEPTH = Number(args['max-depth'] || 16);
const MAX_CHAINS = Number(args['max-chains'] || 40);
const MAX_EXPAND = Number(args['max-expand'] || 4000); // node expansions per export

const SIDE_EFFECT_RE = /side[_ ]?effect/i;

function normalizeExportList(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  return [value];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLoc(value) {
  if (value == null) return null;
  if (isPlainObject(value)) return value.loc || value.location || value.dependencyLoc || value;
  return value;
}

function normalizeRawEdge(edge) {
  if (Array.isArray(edge)) {
    const meta = isPlainObject(edge[4]) ? edge[4] : null;
    const locMeta = isPlainObject(edge[5]) ? edge[5] : null;
    return {
      originUkey: edge[0],
      originExports: normalizeExportList(edge[1]),
      targetUkey: edge[2],
      targetExports: normalizeExportList(edge[3]),
      loc: normalizeLoc(firstDefined(meta?.loc, meta?.location, meta?.dependencyLoc, locMeta?.loc, locMeta?.location, locMeta?.dependencyLoc, edge[5])),
      request: firstDefined(meta?.request, meta?.dependencyRequest, locMeta?.request, locMeta?.dependencyRequest, edge[6]) || null,
      dependencyId: firstDefined(meta?.dependencyId, meta?.depId, locMeta?.dependencyId, locMeta?.depId, meta ? undefined : edge[4]) || null,
    };
  }
  return {
    originUkey: firstDefined(edge.originUkey, edge.origin, edge.fromUkey, edge.from, edge.originModuleUkey),
    originExports: normalizeExportList(firstDefined(edge.originExports, edge.originExport, edge.fromExports, edge.fromExport)),
    targetUkey: firstDefined(edge.targetUkey, edge.target, edge.toUkey, edge.to, edge.targetModuleUkey),
    targetExports: normalizeExportList(firstDefined(edge.targetExports, edge.targetExport, edge.toExports, edge.toExport)),
    loc: edge.loc || edge.location || edge.dependencyLoc || null,
    request: edge.request || edge.dependencyRequest || null,
    dependencyId: edge.dependencyId || edge.depId || null,
  };
}

function validateRawCapture(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('export-usage capture must be a JSON object');
  if (raw.schemaVersion !== 1 || raw.kind !== 'rspack-export-usage-capture') {
    throw new Error('export-usage capture has an unsupported or missing schema');
  }
  if (raw.complete !== true) throw new Error('export-usage capture is not marked complete');
  if (typeof raw.generatedAt !== 'string' || !Number.isFinite(Date.parse(raw.generatedAt))) {
    throw new Error('export-usage capture is missing a valid generatedAt timestamp');
  }
  if (typeof raw.runId !== 'string' || !raw.runId.trim()) throw new Error('export-usage capture is missing runId');
  if (typeof raw.compilerId !== 'string' || !raw.compilerId.trim()) throw new Error('export-usage capture is missing compilerId');
  if (!Array.isArray(raw.modules) || !Array.isArray(raw.edges)) throw new Error('export-usage capture must contain modules and edges arrays');
  if (raw.moduleCount !== raw.modules.length || raw.edgeCount !== raw.edges.length) {
    throw new Error('export-usage capture counts do not match its arrays');
  }
  const moduleKeys = new Set();
  for (const module of raw.modules) {
    if (module?.ukey === null || module?.ukey === undefined || typeof module?.path !== 'string' || !module.path) {
      throw new Error('export-usage capture contains a module without ukey or path');
    }
    if (moduleKeys.has(module.ukey)) throw new Error(`export-usage capture contains duplicate module ukey ${module.ukey}`);
    moduleKeys.add(module.ukey);
  }
  for (const edge of raw.edges) {
    const normalized = normalizeRawEdge(edge);
    if (normalized.originUkey === null || normalized.originUkey === undefined || normalized.targetUkey === null || normalized.targetUkey === undefined) {
      throw new Error('export-usage capture contains an edge without origin or target');
    }
    if (!moduleKeys.has(normalized.originUkey) || !moduleKeys.has(normalized.targetUkey)) {
      throw new Error('export-usage capture contains an edge whose module is absent from the module inventory');
    }
  }
  return raw;
}

function collectUsedExports(edges) {
  const usedExports = new Map();
  const namespaceOnlyTargets = new Set();
  const addUsedExport = (ukey, exportName) => {
    if (!usedExports.has(ukey)) usedExports.set(ukey, new Set());
    usedExports.get(ukey).add(exportName);
  };
  for (const edge of edges) {
    const targetExports = edge.targetExports;
    if (targetExports && targetExports.length) {
      for (const exportName of targetExports) addUsedExport(edge.targetUkey, exportName);
    } else {
      namespaceOnlyTargets.add(edge.targetUkey);
    }
  }
  for (const targetUkey of namespaceOnlyTargets) {
    if (!usedExports.has(targetUkey) || usedExports.get(targetUkey).size === 0) {
      addUsedExport(targetUkey, '*');
    }
  }
  return usedExports;
}

function main() {
  if (args['self-test']) return selfTest();
  const raw = validateRawCapture(JSON.parse(readFileSync(rawPath, 'utf8')));
  const modules = raw.modules || [];
  const edges = raw.edges.map(normalizeRawEdge);

  // ukey -> module
  const modByUkey = new Map();
  for (const m of modules) modByUkey.set(m.ukey, m);
  const pathOf = u => { const m = modByUkey.get(u); return m ? m.path : `ukey:${u}`; };

  // incoming edges grouped by provider (target) ukey
  const incomingByTarget = new Map();
  for (const e of edges) {
    const tU = e.targetUkey;
    if (!incomingByTarget.has(tU)) incomingByTarget.set(tU, []);
    incomingByTarget.get(tU).push(e);
  }

  // Preserve the original module-key type. Serializing a ukey and export name
  // into one delimiter-based string can silently drop valid string keys or
  // misparse an export name containing a newline.
  const usedExports = collectUsedExports(edges);

  // Whole-module provider consumption is the root cause behind many
  // stats-level `usedExports: true` modules. Preserve it as a first-class index
  // so reports can name the import site that made the provider namespace live.
  const moduleLevelImports = edges
    .filter(e => e.targetExports === null)
    .map(e => ({
      targetUkey: e.targetUkey,
      targetResource: pathOf(e.targetUkey),
      originUkey: e.originUkey,
      originResource: pathOf(e.originUkey),
      originExport: e.originExports === null ? null : e.originExports,
      loc: e.loc || null,
      request: e.request || null,
      dependencyId: e.dependencyId || null,
      importShape: e.originExports === null ? 'module-level-consumer' : 'export-propagation',
    }));

  const terminalKindOf = u => {
    const m = modByUkey.get(u);
    if (m && Array.isArray(m.bailoutReason) && m.bailoutReason.some(r => SIDE_EFFECT_RE.test(r))) {
      return 'module-side-effect-or-unknown-export';
    }
    return 'no-export-incoming';
  };

  const caps = { depth: 0, chains: 0, expand: 0, exportsCapped: 0 };

  // reverse-BFS from a provider (M, E) up to terminal roots (origin with originExports===null)
  function chainsFor(M, E) {
    const chains = [];
    const visited = new Map(); // ukey -> Set<export name>
    const markVisited = (ukey, exportName) => {
      const exports = visited.get(ukey) || new Set();
      if (exports.has(exportName)) return false;
      exports.add(exportName);
      visited.set(ukey, exports);
      return true;
    };
    let expand = 0;
    let cappedHere = false;
    // stack frames: { node:[ukey,exp], edges:[...], depth }
    const stack = [{ ukey: M, exp: E, edges: [], depth: 0 }];
    while (stack.length) {
      if (chains.length >= MAX_CHAINS) { cappedHere = true; break; }
      const fr = stack.pop();
      if (!markVisited(fr.ukey, fr.exp)) continue;
      if (fr.depth > MAX_DEPTH) { cappedHere = true; continue; }
      if (++expand > MAX_EXPAND) { cappedHere = true; break; }

      const incoming = incomingByTarget.get(fr.ukey) || [];
      // edges whose target export set includes fr.exp, OR is namespace (null => keeps all alive),
      // OR fr.exp === '*' (namespace provider record): match all incoming.
      const matching = incoming.filter(e => {
        const tExports = e.targetExports;
        if (fr.exp === '*') return true;
        if (tExports === null) return true;          // namespace usage keeps every export alive
        return tExports.indexOf(fr.exp) !== -1;
      });

      if (matching.length === 0) {
        // no consumer above: (fr.ukey, fr.exp) is itself a top-level used terminal
        chains.push({
          terminal: pathOf(fr.ukey),
          terminalKind: terminalKindOf(fr.ukey),
          edges: fr.edges.slice(),
        });
        continue;
      }

      for (const e of matching) {
        const oU = e.originUkey;
        const oExports = e.originExports;
        const tExports = e.targetExports;
        const edgeRec = {
          from: pathOf(oU),
          to: pathOf(fr.ukey),
          originExport: oExports === null ? null : oExports,
          targetExport: fr.exp === '*' ? (tExports === null ? null : tExports) : fr.exp,
          // viaNamespace: the provider was consumed as a whole-module / `import *`
          // (targetExports === null in the raw edge). Such retention is conservative:
          // the export is kept alive even if no concrete specifier references it.
          viaNamespace: tExports === null,
          loc: e.loc || null,
          request: e.request || null,
          dependencyId: e.dependencyId || null,
        };
        const nextEdges = fr.edges.concat([edgeRec]);
        if (oExports === null) {
          // origin consumes at module level => terminal root
          chains.push({
            terminal: pathOf(oU),
            terminalKind: terminalKindOf(oU),
            edges: nextEdges,
          });
        } else {
          // continue upward through each origin export
          for (const oe of oExports) {
            stack.push({ ukey: oU, exp: oe, edges: nextEdges, depth: fr.depth + 1 });
          }
        }
      }
    }
    caps.expand += expand;
    if (cappedHere) caps.exportsCapped++;
    return { chains, capped: cappedHere };
  }

  const usages = [];
  for (const [M, exportNames] of usedExports) {
    const m = modByUkey.get(M);
    if (!m) continue;
    for (const exp of exportNames) {
      const { chains, capped } = chainsFor(M, exp);
      // dedupe terminals (keep one chain per terminal root, plus keep first few samples)
      const seenTerminal = new Set();
      const deduped = [];
      for (const c of chains) {
        if (seenTerminal.has(c.terminal)) continue;
        seenTerminal.add(c.terminal);
        deduped.push(c);
      }
      usages.push({ resource: m.path, exportName: exp, capped, chains: deduped });
    }
  }

  const out = {
    schemaVersion: 1,
    kind: 'rspack-export-usage-expanded',
    complete: true,
    generatedAt: new Date().toISOString(),
    runId: raw.runId,
    compilerId: raw.compilerId,
    generatedFrom: rawPath,
    moduleCount: modules.length,
    edgeCount: edges.length,
    usageCount: usages.length,
    capsInfo: caps,
    moduleLevelImportCount: moduleLevelImports.length,
    moduleLevelImports,
    usages,
  };
  writeFileSync(outPath, JSON.stringify(out));
  console.log(`usages=${usages.length} modules=${modules.length} edges=${edges.length} exportsCapped=${caps.exportsCapped}`);
  console.log(`wrote ${outPath}`);
}

function selfTest() {
  const assert = require('assert');
  assert.throws(() => validateRawCapture({}), /unsupported or missing schema/);
  const valid = {
    schemaVersion: 1,
    kind: 'rspack-export-usage-capture',
    complete: true,
    generatedAt: '2026-01-02T03:04:05.000Z',
    runId: 'run-test',
    compilerId: 'web',
    moduleCount: 0,
    edgeCount: 0,
    modules: [],
    edges: [],
  };
  assert.equal(validateRawCapture(valid), valid);
  assert.throws(() => validateRawCapture({ ...valid, moduleCount: 1 }), /counts do not match/);
  const stringKeys = collectUsedExports([
    { targetUkey: 'provider-a', targetExports: ['named'] },
    { targetUkey: 'provider-b', targetExports: null },
  ]);
  assert.deepEqual([...stringKeys.get('provider-a')], ['named']);
  assert.deepEqual([...stringKeys.get('provider-b')], ['*']);
  console.log('build-all-export-usage self-test passed');
}

if (require.main === module) main();

module.exports = { collectUsedExports, normalizeRawEdge, validateRawCapture };
