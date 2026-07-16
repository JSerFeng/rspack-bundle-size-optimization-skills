#!/usr/bin/env node
// Run Rollup against a loader-processed graph captured from Rspack. This is a
// diagnostic export-usage comparator; its byte totals are not production saving.

const {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { dirname, isAbsolute, resolve } = require('path');
const { pathToFileURL } = require('url');

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

async function importProjectPackage(name, projectRoot, required = true) {
  try {
    const resolved = require.resolve(name, { paths: [projectRoot] });
    return await import(pathToFileURL(resolved).href);
  } catch (error) {
    if (!required) return null;
    throw new Error(`Cannot resolve project-local ${name} from ${projectRoot}: ${error.message}`);
  }
}

function sanitizeName(value, index) {
  const safe = String(value || `entry-${index + 1}`).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || `entry-${index + 1}`;
}

function buildEntryInput(graph) {
  const entries = [];
  const seen = new Set();
  for (const entrypoint of graph.entrypoints || []) {
    for (const id of entrypoint.moduleIds || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({ name: entrypoint.name, id });
    }
  }
  for (const id of graph.entryModuleIds || []) {
    if (!seen.has(id)) { seen.add(id); entries.push({ name: 'entry', id }); }
  }
  if (entries.length === 0) throw new Error('Captured graph has no entry modules');
  if (entries.length === 1) return entries[0].id;
  return Object.fromEntries(entries.map((entry, index) => [`${sanitizeName(entry.name, index)}-${index + 1}`, entry.id]));
}

function fatalGraphIssues(graph) {
  const fatalTypes = new Set(['missing-source', 'captured-edge-target-missing', 'captured-edge-request-missing']);
  return (graph.dataQuality || []).filter((issue) => fatalTypes.has(issue.type));
}

function makeVirtualPlugin(graph, diagnostics) {
  const moduleById = new Map((graph.modules || []).map((module) => [module.id, module]));
  const targetsByEdge = new Map();
  for (const edge of graph.edges || []) {
    if (edge.active === false || edge.weak || !edge.request) continue;
    const key = `${edge.importerId}\0${edge.request}`;
    const targets = targetsByEdge.get(key) || new Set();
    targets.add(edge.targetId);
    targetsByEdge.set(key, targets);
  }
  return {
    name: 'rspack-materialized-graph',
    resolveId(source, importer) {
      if (source.startsWith('\0')) return null;
      if (!importer && moduleById.has(source)) return source;
      if (moduleById.has(source) && !importer) return source;
      if (!importer) return null;
      const targets = targetsByEdge.get(`${importer}\0${source}`);
      if (!targets || targets.size === 0) {
        diagnostics.unresolved.push({ importer, request: source });
        throw new Error(`No captured Rspack edge for ${importer} -> ${source}`);
      }
      if (targets.size > 1) {
        diagnostics.ambiguous.push({ importer, request: source, targets: [...targets] });
        throw new Error(`Ambiguous captured Rspack edge for ${importer} -> ${source}`);
      }
      return [...targets][0];
    },
    load(id) {
      if (id.startsWith('\0')) return null;
      const module = moduleById.get(id);
      if (!module) return null;
      if (typeof module.source !== 'string') throw new Error(`Captured source is missing for ${id}`);
      return { code: module.source, map: null };
    },
  };
}

function collectRollupModules(output) {
  const result = new Map();
  for (const item of output) {
    if (item.type !== 'chunk') continue;
    for (const [id, info] of Object.entries(item.modules || {})) {
      const row = result.get(id) || {
        id,
        chunks: [],
        renderedLength: 0,
        originalLength: 0,
        renderedExports: new Set(),
        removedExports: new Set(),
      };
      row.chunks.push(item.fileName);
      row.renderedLength += Number(info.renderedLength || 0);
      row.originalLength += Number(info.originalLength || 0);
      for (const name of info.renderedExports || []) row.renderedExports.add(name);
      for (const name of info.removedExports || []) row.removedExports.add(name);
      result.set(id, row);
    }
  }
  return result;
}

function upstreamEvidence(graph, targetId, maxChains = 20, maxDepth = 20) {
  const incoming = new Map();
  for (const edge of graph.edges || []) {
    if (edge.active === false || edge.weak) continue;
    const list = incoming.get(edge.targetId) || [];
    list.push(edge);
    incoming.set(edge.targetId, list);
  }
  const entryIds = new Set(graph.entryModuleIds || []);
  const chains = [];
  const walk = (current, reversedNodes, reversedEdges, seen) => {
    if (chains.length >= maxChains) return;
    const parents = incoming.get(current) || [];
    if (entryIds.has(current) || parents.length === 0 || reversedEdges.length >= maxDepth) {
      chains.push({
        complete: entryIds.has(current),
        capped: reversedEdges.length >= maxDepth,
        moduleIds: [...reversedNodes, current].reverse(),
        edges: [...reversedEdges].reverse(),
      });
      return;
    }
    for (const edge of parents) {
      if (seen.has(edge.importerId)) {
        chains.push({ complete: false, capped: false, cycle: true, moduleIds: [...reversedNodes, current, edge.importerId].reverse(), edges: [...reversedEdges, edge].reverse() });
        continue;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(edge.importerId);
      walk(edge.importerId, [...reversedNodes, current], [...reversedEdges, edge], nextSeen);
      if (chains.length >= maxChains) break;
    }
  };
  walk(targetId, [], [], new Set([targetId]));
  return {
    quality: 'module-level-coarse; merge with export-usage roots for export-specific proof',
    directReferences: incoming.get(targetId) || [],
    chains,
    capped: chains.length >= maxChains,
  };
}

function compareExports(graph, rollupModules) {
  const rows = [];
  const gaps = [];
  for (const module of graph.modules || []) {
    const rollup = rollupModules.get(module.id);
    const rspackUsed = module.usedExports || { kind: 'unknown', names: [] };
    const rspackNames = rspackUsed.kind === 'names'
      ? rspackUsed.names || []
      : rspackUsed.kind === 'all' && module.providedExports?.kind === 'names'
        ? module.providedExports.names || []
        : [];
    const removed = rollup ? [...rollup.removedExports] : rspackNames;
    const moduleGaps = rspackNames.filter((name) => !rollup || rollup.removedExports.has(name));
    const row = {
      moduleId: module.id,
      resource: module.resource,
      rspackUsedExports: rspackUsed,
      rollupIncluded: Boolean(rollup),
      rollupRenderedExports: rollup ? [...rollup.renderedExports].sort() : [],
      rollupRemovedExports: removed.sort(),
      rollupRenderedLength: rollup?.renderedLength || 0,
      gapExports: moduleGaps.sort(),
    };
    rows.push(row);
    const evidence = moduleGaps.length ? upstreamEvidence(graph, module.id) : null;
    for (const exportName of moduleGaps) gaps.push({ moduleId: module.id, resource: module.resource, exportName, ...evidence });
  }
  return { rows, gaps };
}

function writeGeneratedOutput(output, outputDir) {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  for (const item of output) {
    const file = resolve(outputDir, item.fileName);
    if (file !== outputDir && !file.startsWith(`${outputDir}${require('path').sep}`)) {
      throw new Error(`Rollup emitted an unsafe output path: ${item.fileName}`);
    }
    mkdirSync(dirname(file), { recursive: true });
    if (item.type === 'asset') writeFileSync(file, typeof item.source === 'string' ? item.source : Buffer.from(item.source));
    else {
      writeFileSync(file, item.code);
      if (item.map) writeFileSync(`${file}.map`, item.map.toString());
    }
  }
}

async function runComparison({ graphPath, outDir, projectRoot }) {
  if (!existsSync(graphPath)) throw new Error(`Missing captured graph: ${graphPath}`);
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  const fatalIssues = fatalGraphIssues(graph);
  mkdirSync(outDir, { recursive: true });
  if (fatalIssues.length > 0) {
    const blocked = { version: 1, status: 'blocked', reason: 'captured graph has fatal data-quality issues', fatalIssues };
    writeFileSync(resolve(outDir, 'rollup-export-diff.json'), JSON.stringify(blocked, null, 2) + '\n');
    throw new Error(`Captured graph is incomplete (${fatalIssues.length} fatal issue(s)); see rollup-export-diff.json`);
  }

  const rollupModule = await importProjectPackage('rollup', projectRoot, true);
  const rollup = rollupModule.rollup || rollupModule.default?.rollup;
  if (typeof rollup !== 'function') throw new Error('Project-local Rollup package does not export rollup()');
  const commonjsModule = await importProjectPackage('@rollup/plugin-commonjs', projectRoot, false);
  const commonjs = commonjsModule ? (commonjsModule.default || commonjsModule.commonjs) : null;
  const diagnostics = { warnings: [], unresolved: [], ambiguous: [], commonjsPluginAvailable: Boolean(commonjs) };
  const plugins = [makeVirtualPlugin(graph, diagnostics)];
  if (typeof commonjs === 'function') plugins.push(commonjs({ extensions: ['.js', '.cjs', '.mjs'] }));

  let bundle;
  try {
    bundle = await rollup({
      input: buildEntryInput(graph),
      plugins,
      preserveEntrySignatures: false,
      treeshake: true,
      onwarn(warning) { diagnostics.warnings.push({ code: warning.code || null, message: warning.message, id: warning.id || null, loc: warning.loc || null }); },
    });
    const generated = await bundle.generate({ format: 'es', preserveModules: true, sourcemap: true, entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' });
    writeGeneratedOutput(generated.output, resolve(outDir, 'rollup-output'));
    const rollupModules = collectRollupModules(generated.output);
    const comparison = compareExports(graph, rollupModules);
    const result = {
      version: 1,
      generatedAt: new Date().toISOString(),
      status: 'completed',
      graphPath,
      projectRoot,
      diagnostics,
      summary: {
        capturedModuleCount: graph.modules.length,
        rollupIncludedModuleCount: rollupModules.size,
        rspackUsedButRollupRemovedExportCount: comparison.gaps.length,
      },
      warning: 'Export gaps are diagnostic hypotheses. Only a source-backed production Rspack A/B can establish emitted-byte savings.',
      gaps: comparison.gaps,
      modules: comparison.rows,
    };
    writeFileSync(resolve(outDir, 'rollup-export-diff.json'), JSON.stringify(result, null, 2) + '\n');
    const markdown = [
      '# Rollup vs Rspack Export Diff', '',
      `Status: ${result.status}`, '',
      `Captured modules: ${result.summary.capturedModuleCount}`, '',
      `Rspack-used exports removed by Rollup: ${result.summary.rspackUsedButRollupRemovedExportCount}`, '',
      '> These rows are diagnostic hypotheses, not removable bytes or confirmed savings.', '',
      '| module | export |', '| --- | --- |',
      ...result.gaps.map((gap) => `| ${String(gap.resource || gap.moduleId).replace(/\|/g, '\\|')} | ${String(gap.exportName).replace(/\|/g, '\\|')} |`),
    ].join('\n');
    writeFileSync(resolve(outDir, 'rollup-export-diff.md'), markdown + '\n');
    return result;
  } finally {
    if (bundle) await bundle.close();
  }
}

function selfTest() {
  const graph = { modules: [{ id: '/a.js', resource: '/a.js', usedExports: { kind: 'names', names: ['kept', 'gap'] } }] };
  const rollupModules = new Map([['/a.js', { renderedExports: new Set(['kept']), removedExports: new Set(['gap']), renderedLength: 4 }]]);
  const comparison = compareExports(graph, rollupModules);
  if (comparison.gaps.length !== 1 || comparison.gaps[0].exportName !== 'gap') throw new Error('self-test assertion failed');
  console.log('run-rollup-export-diff self-test passed');
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const projectRoot = resolve(args['project-root'] || process.cwd());
  const graphPath = resolve(args.graph || 'rspack-materialized-graph.json');
  const outDir = resolve(args['out-dir'] || dirname(graphPath));
  const result = await runComparison({ graphPath, outDir, projectRoot });
  console.log(`status=${result.status} gaps=${result.summary.rspackUsedButRollupRemovedExportCount}`);
  console.log(`wrote ${resolve(outDir, 'rollup-export-diff.json')}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
module.exports = { buildEntryInput, compareExports, fatalGraphIssues, makeVirtualPlugin, runComparison, upstreamEvidence };
