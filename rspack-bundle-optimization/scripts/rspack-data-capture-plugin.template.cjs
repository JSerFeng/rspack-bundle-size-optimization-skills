// @ts-nocheck
// Capture raw facts from a successful Rspack compilation.
// This plugin does not classify, rank, recommend, or conclude.

const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('fs');
const { createHash } = require('crypto');
const { resolve } = require('path');

const PLUGIN_NAME = 'RspackBundleDataCapturePlugin';

function safeCall(getter, fallback = null) {
  try {
    const value = getter();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

function summarize(value, depth = 0, seen = new WeakSet()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (value === undefined) return '[undefined]';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') {
    return `[Function${value.name ? `: ${value.name}` : ''}]`;
  }
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= 4) return `[${value.constructor?.name || 'Object'}]`;

  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.slice(0, 1000).map((item) =>
      summarize(item, depth + 1, seen));
  } else {
    result = {};
    for (const key of Object.keys(value).sort().slice(0, 1000)) {
      result[key] = summarize(value[key], depth + 1, seen);
    }
  }
  seen.delete(value);
  return result;
}

function normalizeIterable(value) {
  if (value == null) return [];
  try {
    return Array.from(value);
  } catch {
    return [];
  }
}

function normalizeExports(value) {
  if (
    value === true
    || value === false
    || value === null
    || value === undefined
  ) {
    return value ?? null;
  }
  try {
    return Array.from(value, (item) => String(item)).sort();
  } catch {
    return summarize(value);
  }
}

function captureIdentity(options, compiler) {
  const runId = String(
    options.runId || process.env.RSPACK_BUNDLE_RUN_ID || '',
  ).trim();
  const compilerId = String(options.compilerId || '').trim();
  const requestedOutDir =
    options.outDir || process.env.RSPACK_BUNDLE_CAPTURE_DIR;
  if (!runId) throw new Error(`${PLUGIN_NAME}: runId is required`);
  if (!compilerId) throw new Error(`${PLUGIN_NAME}: compilerId is required`);
  if (!requestedOutDir) throw new Error(`${PLUGIN_NAME}: outDir is required`);
  return {
    runId,
    compilerId,
    safeRunId: safeFilePart(runId),
    safeCompilerId: safeFilePart(compilerId),
    outDir: resolve(compiler.context || process.cwd(), requestedOutDir),
  };
}

function moduleIdentifier(module) {
  return String(
    safeCall(() => module.identifier())
    || module.resource
    || safeCall(() => module.nameForCondition())
    || 'unknown-module',
  );
}

function moduleResource(module) {
  return module.resource
    || safeCall(() => module.nameForCondition())
    || null;
}

function chunkIdentifier(chunk) {
  if (chunk.id !== null && chunk.id !== undefined) return String(chunk.id);
  if (chunk.name) return `name:${chunk.name}`;
  return `debug:${chunk.debugId ?? 'unknown'}`;
}

function makeModuleRecord(compilation, module, entryModules) {
  const moduleGraph = compilation.moduleGraph;
  const chunkGraph = compilation.chunkGraph;
  const chunks = normalizeIterable(
    safeCall(() => chunkGraph.getModuleChunksIterable(module), []),
  ).map(chunkIdentifier).sort();
  return {
    identifier: moduleIdentifier(module),
    resource: moduleResource(module),
    type: module.type || null,
    layer: module.layer || null,
    size: safeCall(() => module.size(), null),
    chunks,
    entry: entryModules.has(module),
    providedExports: normalizeExports(
      safeCall(() => moduleGraph.getProvidedExports(module), null),
    ),
    usedExports: normalizeExports(
      safeCall(() => moduleGraph.getUsedExports(module), null),
    ),
  };
}

function makeConnectionRecord(connection) {
  const dependency = connection.dependency || null;
  return {
    origin: connection.originModule
      ? moduleIdentifier(connection.originModule)
      : null,
    target: connection.module ? moduleIdentifier(connection.module) : null,
    dependency: dependency
      ? {
          type: dependency.type || dependency.constructor?.name || null,
          request: dependency.request || dependency.userRequest || null,
          weak: dependency.weak ?? null,
          optional: dependency.optional ?? null,
          loc: summarize(dependency.loc),
        }
      : null,
    explanation: connection.explanation || null,
  };
}

function makeChunkRecord(compilation, chunk) {
  const chunkGraph = compilation.chunkGraph;
  const modules = normalizeIterable(
    safeCall(() => chunkGraph.getChunkModulesIterable(chunk), []),
  ).map(moduleIdentifier).sort();
  const entryModules = normalizeIterable(
    safeCall(() => chunkGraph.getChunkEntryModulesIterable(chunk), []),
  ).map(moduleIdentifier).sort();
  return {
    id: chunkIdentifier(chunk),
    name: chunk.name || null,
    files: normalizeIterable(chunk.files).map(String).sort(),
    auxiliaryFiles: normalizeIterable(chunk.auxiliaryFiles).map(String).sort(),
    canBeInitial: safeCall(() => chunk.canBeInitial(), null),
    hasRuntime: safeCall(() => chunk.hasRuntime(), null),
    runtime: summarize(chunk.runtime),
    modules,
    entryModules,
  };
}

function makeChunkGroupRecord(group, index) {
  const origins = Array.isArray(group.origins)
    ? group.origins.map((origin) => ({
        module: origin.module ? moduleIdentifier(origin.module) : null,
        request: origin.request || null,
        loc: summarize(origin.loc),
      }))
    : [];
  return {
    index,
    name: group.name || null,
    initial: safeCall(() => group.isInitial(), null),
    chunks: normalizeIterable(group.chunks).map(chunkIdentifier),
    parents: normalizeIterable(safeCall(() => group.getParents(), []))
      .map((parent) => parent.name || null),
    children: normalizeIterable(safeCall(() => group.getChildren(), []))
      .map((child) => child.name || null),
    origins,
  };
}

function sourceRecord(module) {
  const originalSource = safeCall(() => module.originalSource(), null);
  if (!originalSource) return null;
  const raw = safeCall(() => originalSource.source(), null);
  if (raw === null || raw === undefined) return null;
  const source = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!source) return null;
  const identifier = moduleIdentifier(module);
  return {
    identifier,
    resource: moduleResource(module),
    bytes: Buffer.byteLength(source, 'utf8'),
    sha256: sha256(source),
    source,
  };
}

function resolvedConfig(compilation, compiler) {
  const options = compilation.options || compiler.options || {};
  return {
    mode: options.mode ?? null,
    target: summarize(options.target),
    devtool: summarize(options.devtool),
    context: options.context || compiler.context || null,
    entry: summarize(options.entry),
    output: summarize(options.output),
    optimization: summarize(options.optimization),
    experiments: summarize(options.experiments),
    module: summarize(options.module),
  };
}

function artifactRecord(path) {
  const body = readFileSync(path);
  return {
    path,
    bytes: body.length,
    sha256: sha256(body),
  };
}

function writeFresh(path, body) {
  if (existsSync(path)) {
    throw new Error(`${PLUGIN_NAME}: refusing to overwrite ${path}`);
  }
  writeFileSync(path, body);
}

class RspackBundleDataCapturePlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    const identity = captureIdentity(this.options, compiler);
    const captureExportUsage = this.options.captureExportUsage === true;
    let exportUsage = null;
    let exportUsageAvailability = {
      requested: captureExportUsage,
      available: false,
      reason: captureExportUsage ? 'capture hook not initialized' : 'not requested',
    };

    if (captureExportUsage) {
      const rspack = this.options.rspack;
      const RsdoctorPlugin = rspack?.experiments?.RsdoctorPlugin;
      if (!RsdoctorPlugin || typeof RsdoctorPlugin.getCompilationHooks !== 'function') {
        exportUsageAvailability = {
          requested: true,
          available: false,
          reason:
            'Rspack Rsdoctor exportUsageGraph API is unavailable; pass the active '
            + 'rspack instance from a compatible compiler',
        };
        if (this.options.requireExportUsage === true) {
          throw new Error(
            `${PLUGIN_NAME}: ${exportUsageAvailability.reason}`,
          );
        }
      } else {
        new RsdoctorPlugin({
          moduleGraphFeatures: ['graph'],
          chunkGraphFeatures: false,
          exportUsageGraph: true,
        }).apply(compiler);
        compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
          const hooks = RsdoctorPlugin.getCompilationHooks(compilation);
          hooks.moduleGraph.tapPromise(PLUGIN_NAME, async (graph) => {
            if (
              !Array.isArray(graph.modules)
              || !Array.isArray(graph.exportUsageEdges)
            ) {
              throw new Error(
                `${PLUGIN_NAME}: Rsdoctor graph is missing modules or exportUsageEdges`,
              );
            }
            exportUsage = {
              schemaVersion: 1,
              kind: 'rspack-export-usage-data',
              runId: identity.runId,
              compilerId: identity.compilerId,
              modules: graph.modules,
              edges: graph.exportUsageEdges,
            };
            exportUsageAvailability = {
              requested: true,
              available: true,
              reason: null,
            };
          });
        });
      }
    }

    compiler.hooks.done.tap(PLUGIN_NAME, (stats) => {
      if (typeof stats.hasErrors === 'function' && stats.hasErrors()) {
        throw new Error(
          `${PLUGIN_NAME}: refusing to write a complete capture for a failed build`,
        );
      }

      const compilation = stats.compilation;
      const modules = normalizeIterable(compilation.modules);
      const chunks = normalizeIterable(compilation.chunks);
      const entryModules = new Set();
      for (const chunk of chunks) {
        for (const module of normalizeIterable(
          safeCall(
            () => compilation.chunkGraph.getChunkEntryModulesIterable(chunk),
            [],
          ),
        )) {
          entryModules.add(module);
        }
      }

      const moduleRecords = modules
        .map((module) => makeModuleRecord(compilation, module, entryModules))
        .sort((left, right) => left.identifier.localeCompare(right.identifier));
      const connections = [];
      for (const module of modules) {
        for (const connection of normalizeIterable(
          safeCall(
            () => compilation.moduleGraph.getOutgoingConnections(module),
            [],
          ),
        )) {
          connections.push(makeConnectionRecord(connection));
        }
      }
      connections.sort((left, right) =>
        `${left.origin}\0${left.target}\0${left.dependency?.request || ''}`
          .localeCompare(
            `${right.origin}\0${right.target}\0${right.dependency?.request || ''}`,
          ));

      const assets = normalizeIterable(
        safeCall(() => compilation.getAssets(), []),
      ).map((asset) => ({
        name: asset.name,
        size: safeCall(() => asset.source.size(), null),
        info: summarize(asset.info),
      })).sort((left, right) => left.name.localeCompare(right.name));

      const entrypoints = [];
      for (const [name, group] of compilation.entrypoints || []) {
        entrypoints.push({
          name,
          chunks: normalizeIterable(group.chunks).map(chunkIdentifier),
          files: normalizeIterable(
            safeCall(() => group.getFiles(), []),
          ).map(String).sort(),
        });
      }
      entrypoints.sort((left, right) => left.name.localeCompare(right.name));

      const statsData = stats.toJson({
        all: false,
        hash: true,
        errors: true,
        warnings: true,
        assets: true,
        chunks: true,
        chunkGroups: true,
        entrypoints: true,
        modules: true,
        nestedModules: true,
        chunkModules: true,
        reasons: true,
        ids: true,
        usedExports: true,
        providedExports: true,
        optimizationBailout: true,
        source: false,
      });

      const compilationData = {
        schemaVersion: 1,
        kind: 'rspack-compilation-data',
        complete: true,
        generatedAt: new Date().toISOString(),
        runId: identity.runId,
        compilerId: identity.compilerId,
        compiler: {
          name: compiler.name || compilation.name || null,
          context: compiler.context || null,
          rspackVersion:
            compiler.rspack?.rspackVersion
            || compiler.webpack?.rspackVersion
            || null,
        },
        resolvedConfig: resolvedConfig(compilation, compiler),
        assets,
        entrypoints,
        chunks: chunks.map((chunk) =>
          makeChunkRecord(compilation, chunk)),
        chunkGroups: normalizeIterable(compilation.chunkGroups)
          .map((group, index) => makeChunkGroupRecord(group, index)),
        modules: moduleRecords,
        connections,
        stats: statsData,
        exportUsageAvailability,
      };

      mkdirSync(identity.outDir, { recursive: true });
      const compilationPath = resolve(identity.outDir, 'compilation-data.json');
      const sourcePath = resolve(identity.outDir, 'post-loader-sources.jsonl');
      const sourceIndexPath = resolve(identity.outDir, 'post-loader-index.json');
      const exportUsagePath = resolve(identity.outDir, 'export-usage.json');
      const manifestPath = resolve(identity.outDir, 'capture-manifest.json');
      for (const path of [
        compilationPath,
        sourcePath,
        sourceIndexPath,
        manifestPath,
        ...(exportUsage ? [exportUsagePath] : []),
      ]) {
        if (existsSync(path)) {
          throw new Error(`${PLUGIN_NAME}: refusing to overwrite ${path}`);
        }
      }

      writeFresh(
        compilationPath,
        `${JSON.stringify(compilationData, null, 2)}\n`,
      );

      const sourceRows = this.options.captureSources === false
        ? []
        : modules.map(sourceRecord).filter(Boolean);
      writeFresh(
        sourcePath,
        sourceRows.length
          ? `${sourceRows.map((row) => JSON.stringify(row)).join('\n')}\n`
          : '',
      );
      writeFresh(
        sourceIndexPath,
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'rspack-post-loader-source-index',
          runId: identity.runId,
          compilerId: identity.compilerId,
          sources: sourceRows.map((row, line) => ({
            line,
            identifier: row.identifier,
            resource: row.resource,
            bytes: row.bytes,
            sha256: row.sha256,
          })),
        }, null, 2)}\n`,
      );
      if (exportUsage) {
        writeFresh(exportUsagePath, `${JSON.stringify(exportUsage)}\n`);
      }

      const artifactPaths = [
        compilationPath,
        sourcePath,
        sourceIndexPath,
        ...(exportUsage ? [exportUsagePath] : []),
      ];
      writeFresh(
        manifestPath,
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'rspack-bundle-capture-manifest',
          complete: true,
          generatedAt: new Date().toISOString(),
          runId: identity.runId,
          compilerId: identity.compilerId,
          counts: {
            assets: assets.length,
            chunks: chunks.length,
            chunkGroups: compilationData.chunkGroups.length,
            modules: moduleRecords.length,
            connections: connections.length,
            postLoaderSources: sourceRows.length,
            exportUsageModules: exportUsage?.modules?.length ?? null,
            exportUsageEdges: exportUsage?.edges?.length ?? null,
          },
          exportUsageAvailability,
          artifacts: artifactPaths.map(artifactRecord),
        }, null, 2)}\n`,
      );
      console.log(
        `[${PLUGIN_NAME}] compiler=${identity.compilerId} `
        + `modules=${moduleRecords.length} chunks=${chunks.length} `
        + `assets=${assets.length} -> ${identity.outDir}`,
      );
    });
  }
}

function selfTest() {
  const assert = require('assert');
  const compiler = { context: '/fixture' };
  assert.throws(() => captureIdentity({}, compiler), /runId is required/);
  assert.throws(
    () => captureIdentity({ runId: 'run' }, compiler),
    /compilerId is required/,
  );
  const identity = captureIdentity({
    runId: 'run/id',
    compilerId: 'web:client',
    outDir: 'data',
  }, compiler);
  assert.equal(identity.outDir, resolve('/fixture/data'));
  assert.equal(identity.safeRunId, 'run-id');
  assert.deepEqual(normalizeExports(new Set(['b', 'a'])), ['a', 'b']);
  const module = {
    resource: '/fixture/a.js?raw',
    identifier: () => 'javascript/auto|/fixture/a.js?raw',
    originalSource: () => ({ source: () => 'export const a = 1;\n' }),
  };
  const source = sourceRecord(module);
  assert.equal(source.resource, '/fixture/a.js?raw');
  assert.equal(source.bytes, Buffer.byteLength('export const a = 1;\n'));
  assert.equal(source.sha256.length, 64);
  const summarized = summarize({ fn() {}, regex: /x/, nested: { value: 1 } });
  assert.equal(summarized.regex, '/x/');
  process.stdout.write('rspack-data-capture-plugin self-test passed\n');
}

if (require.main === module && process.argv.includes('--self-test')) selfTest();

module.exports = {
  RspackBundleDataCapturePlugin,
  captureIdentity,
  makeConnectionRecord,
  makeModuleRecord,
  normalizeExports,
  sourceRecord,
  summarize,
};
