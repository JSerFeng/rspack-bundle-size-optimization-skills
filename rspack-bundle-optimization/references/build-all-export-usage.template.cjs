#!/usr/bin/env node
// Transform rspack builtin Rsdoctor exportUsageEdges -> skill's rsdoctor-all-export-usage.json
// Edge: [originUkey, originExports[]|null, targetUkey, targetExports[]|null]  (origin=consumer, target=provider)
//   originExports===null  => origin consumes at module level => terminal root
//   targetExports===null  => namespace usage: keeps EVERY export of target alive
//
// Output: { usages: [ { resource, exportName, chains: [ { terminal, terminalKind, edges:[{from,to,originExport,targetExport}] } ] } ] }
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

function main() {
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const modules = raw.modules || [];
  const edges = raw.edges || [];

  // ukey -> module
  const modByUkey = new Map();
  for (const m of modules) modByUkey.set(m.ukey, m);
  const pathOf = u => { const m = modByUkey.get(u); return m ? m.path : `ukey:${u}`; };

  // incoming edges grouped by provider (target) ukey
  const incomingByTarget = new Map();
  for (const e of edges) {
    const tU = e[2];
    if (!incomingByTarget.has(tU)) incomingByTarget.set(tU, []);
    incomingByTarget.get(tU).push(e);
  }

  // enumerate concrete used exports: (tU, e) for every edge whose targetExports != null
  const usedExports = new Set(); // key `${tU}\n${exp}`
  const namespaceOnlyTargets = new Set();
  for (const e of edges) {
    const tU = e[2];
    const tExports = e[3];
    if (tExports && tExports.length) {
      for (const ex of tExports) usedExports.add(`${tU}\n${ex}`);
    } else {
      namespaceOnlyTargets.add(tU);
    }
  }
  // For namespace-only providers with no concrete export usage, emit a '*' record.
  for (const tU of namespaceOnlyTargets) {
    let hasConcrete = false;
    for (const k of usedExports) { if (k.startsWith(`${tU}\n`)) { hasConcrete = true; break; } }
    if (!hasConcrete) usedExports.add(`${tU}\n*`);
  }

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
    const visited = new Set(); // `${ukey}\n${exp}`
    let expand = 0;
    let cappedHere = false;
    // stack frames: { node:[ukey,exp], edges:[...], depth }
    const stack = [{ ukey: M, exp: E, edges: [], depth: 0 }];
    while (stack.length) {
      if (chains.length >= MAX_CHAINS) { cappedHere = true; break; }
      const fr = stack.pop();
      const vkey = `${fr.ukey}\n${fr.exp}`;
      if (visited.has(vkey)) continue;
      visited.add(vkey);
      if (fr.depth > MAX_DEPTH) { cappedHere = true; continue; }
      if (++expand > MAX_EXPAND) { cappedHere = true; break; }

      const incoming = incomingByTarget.get(fr.ukey) || [];
      // edges whose target export set includes fr.exp, OR is namespace (null => keeps all alive),
      // OR fr.exp === '*' (namespace provider record): match all incoming.
      const matching = incoming.filter(e => {
        const tExports = e[3];
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
        const [oU, oExports, , tExports] = e;
        const edgeRec = {
          from: pathOf(oU),
          to: pathOf(fr.ukey),
          originExport: oExports === null ? null : oExports,
          targetExport: fr.exp === '*' ? (tExports === null ? null : tExports) : fr.exp,
          // viaNamespace: the provider was consumed as a whole-module / `import *`
          // (targetExports === null in the raw edge). Such retention is conservative:
          // the export is kept alive even if no concrete specifier references it.
          viaNamespace: tExports === null,
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
  for (const key of usedExports) {
    const [uStr, exp] = key.split('\n');
    const M = Number(uStr);
    const m = modByUkey.get(M);
    if (!m) continue;
    const { chains } = chainsFor(M, exp);
    // dedupe terminals (keep one chain per terminal root, plus keep first few samples)
    const seenTerminal = new Set();
    const deduped = [];
    for (const c of chains) {
      if (seenTerminal.has(c.terminal)) continue;
      seenTerminal.add(c.terminal);
      deduped.push(c);
    }
    usages.push({ resource: m.path, exportName: exp, chains: deduped });
  }

  const out = {
    generatedFrom: rawPath,
    moduleCount: modules.length,
    edgeCount: edges.length,
    usageCount: usages.length,
    capsInfo: caps,
    usages,
  };
  writeFileSync(outPath, JSON.stringify(out));
  console.log(`usages=${usages.length} modules=${modules.length} edges=${edges.length} exportsCapped=${caps.exportsCapped}`);
  console.log(`wrote ${outPath}`);
}

main();
