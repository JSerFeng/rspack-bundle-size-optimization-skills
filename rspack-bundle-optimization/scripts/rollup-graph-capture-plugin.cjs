// @ts-nocheck
// Capture Rspack's loader-processed JavaScript module graph for a Rollup
// diagnostic comparison. The output is intentionally explicit: missing source
// or unresolved dependency metadata is a data-quality error, not an external.

const { mkdirSync, writeFileSync } = require('fs');
const { dirname, isAbsolute, relative, resolve } = require('path');

function safe(getter, fallback = undefined) {
  try { const value = getter(); return value === undefined ? fallback : value; } catch { return fallback; }
}

function stringSource(module) {
  const source = safe(() => module.originalSource());
  if (!source) return null;
  const value = safe(() => source.source());
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return typeof value === 'string' ? value : value == null ? null : String(value);
}

function moduleId(module, context) {
  const resource = module?.resource || safe(() => module.nameForCondition());
  if (typeof resource === 'string' && resource) return isAbsolute(resource) ? resource : resolve(context, resource);
  return String(safe(() => module.identifier(), 'unknown-module'));
}

function normalizeExportState(value) {
  if (value === true) return { kind: 'all', names: [] };
  if (value === false) return { kind: 'none', names: [] };
  if (value == null) return { kind: 'unknown', names: [] };
  if (typeof value[Symbol.iterator] === 'function') return { kind: 'names', names: [...value].map(String).sort() };
  return { kind: 'unknown', names: [] };
}

function normalizeLoc(loc) {
  if (!loc) return null;
  if (typeof loc === 'string') return { raw: loc };
  const normalizePoint = (point) => point && typeof point === 'object'
    ? { line: Number(point.line || 0), column: Number(point.column || 0) }
    : null;
  return { start: normalizePoint(loc.start), end: normalizePoint(loc.end), index: loc.index ?? null };
}

function sourceQuality(source) {
  if (source == null) return { available: false, lineCount: 0, maxLineLength: 0, probablyMinified: false };
  const lines = source.split('\n');
  const maxLineLength = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return { available: true, lineCount: lines.length, maxLineLength, probablyMinified: lines.length <= 5 && maxLineLength > 2000 };
}

function captureGraph(compilation, compiler, options = {}) {
  const context = compiler.context || process.cwd();
  const moduleGraph = compilation.moduleGraph;
  const chunkGraph = compilation.chunkGraph;
  const modules = [...(compilation.modules || [])].filter((module) => String(module?.type || '').startsWith('javascript'));
  const moduleSet = new Set(modules);
  const idByModule = new Map(modules.map((module) => [module, moduleId(module, context)]));
  const entryIds = new Set();
  const entrypoints = [];

  for (const [name, entrypoint] of compilation.entrypoints || []) {
    const ids = new Set();
    for (const chunk of entrypoint.chunks || []) {
      for (const module of safe(() => chunkGraph.getChunkEntryModulesIterable(chunk), []) || []) {
        if (moduleSet.has(module)) ids.add(idByModule.get(module));
      }
    }
    for (const id of ids) entryIds.add(id);
    entrypoints.push({ name: String(name), moduleIds: [...ids] });
  }

  const dataQuality = [];
  const records = modules.map((module) => {
    const id = idByModule.get(module);
    const source = stringSource(module);
    const exportsInfo = safe(() => moduleGraph.getExportsInfo(module));
    const usedExports = normalizeExportState(safe(() => exportsInfo.getUsedExports(undefined)));
    const providedExports = normalizeExportState(safe(() => exportsInfo.getProvidedExports()));
    const chunks = [...(safe(() => chunkGraph.getModuleChunksIterable(module), []) || [])].map((chunk) => ({ id: chunk.id ?? null, name: chunk.name ?? null }));
    if (source == null) dataQuality.push({ type: 'missing-source', moduleId: id });
    return {
      id,
      identifier: String(safe(() => module.identifier(), id)),
      resource: module?.resource || safe(() => module.nameForCondition(), null),
      relativeResource: module?.resource ? relative(context, module.resource) : null,
      moduleType: module?.type || null,
      isEntry: entryIds.has(id),
      chunks,
      usedExports,
      providedExports,
      source,
      sourceQuality: sourceQuality(source),
    };
  });

  const edges = [];
  for (const module of modules) {
    const importerId = idByModule.get(module);
    for (const connection of safe(() => moduleGraph.getOutgoingConnections(module), []) || []) {
      const target = connection.module;
      const dependency = connection.dependency || {};
      const request = dependency.request || dependency.userRequest || dependency.options?.request || null;
      if (!target || !moduleSet.has(target)) {
        if (request && !safe(() => connection.weak, false)) {
          dataQuality.push({ type: 'captured-edge-target-missing', importerId, request, dependencyType: dependency.type || null });
        }
        continue;
      }
      if (!request) dataQuality.push({ type: 'captured-edge-request-missing', importerId, targetId: idByModule.get(target), dependencyType: dependency.type || null });
      edges.push({
        importerId,
        targetId: idByModule.get(target),
        request,
        dependencyId: dependency.id ?? dependency._id ?? null,
        dependencyType: dependency.type || null,
        category: dependency.category || null,
        loc: normalizeLoc(dependency.loc),
        weak: Boolean(dependency.weak || connection.weak),
        active: safe(() => connection.isActive(undefined), null),
      });
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    context,
    compilationHash: compilation.hash || null,
    entrypoints,
    entryModuleIds: [...entryIds],
    modules: records,
    edges,
    dataQuality,
    options: { includeCommonJs: options.includeCommonJs !== false },
  };
}

class RollupGraphCapturePlugin {
  constructor(options = {}) { this.options = options; }

  apply(compiler) {
    compiler.hooks.thisCompilation.tap('RollupGraphCapturePlugin', (compilation) => {
      const stage = compiler.webpack?.Compilation?.PROCESS_ASSETS_STAGE_REPORT ?? 5000;
      compilation.hooks.processAssets.tap({ name: 'RollupGraphCapturePlugin', stage }, () => {
        const graph = captureGraph(compilation, compiler, this.options);
        const graphPath = resolve(compiler.context, this.options.graphPath || './tmp/rollup-diff/rspack-materialized-graph.json');
        mkdirSync(dirname(graphPath), { recursive: true });
        writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n');
        console.log(`[RollupGraphCapture] modules=${graph.modules.length} edges=${graph.edges.length} issues=${graph.dataQuality.length}`);
        console.log(`[RollupGraphCapture] wrote ${graphPath}`);
      });
    });
  }
}

if (require.main === module && process.argv.includes('--self-test')) {
  const named = normalizeExportState(new Set(['b', 'a']));
  if (named.kind !== 'names' || named.names.join(',') !== 'a,b' || normalizeExportState(true).kind !== 'all') throw new Error('self-test failed');
  console.log('rollup-graph-capture-plugin self-test passed');
}

module.exports = { RollupGraphCapturePlugin, captureGraph, normalizeExportState, normalizeLoc, sourceQuality };
