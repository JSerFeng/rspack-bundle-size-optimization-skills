// @ts-nocheck
/**
 * Capture the normalized Rspack options used by a real compilation.
 *
 * Output:
 *   <outDir>/optimization-config.<safe-run-id>.<safe-compiler-id>.json
 *
 * Direct Rspack wiring (keep it env-gated):
 *   const { OptimizationConfigCheckPlugin } = require('./optimization-config-check-plugin.cjs');
 *   if (process.env.RSPACK_OPT_CONFIG === '1') {
 *     config.plugins ||= [];
 *     config.plugins.push(new OptimizationConfigCheckPlugin({
 *       runId: process.env.RSPACK_AUDIT_RUN_ID,
 *       compilerId: 'web',
 *       outDir: process.env.RSPACK_OPT_CONFIG_OUT_DIR,
 *     }));
 *   }
 *
 * Rsbuild wiring:
 *   tools: {
 *     rspack(config, { appendPlugins }) {
 *       if (process.env.RSPACK_OPT_CONFIG === '1') {
 *         appendPlugins(new OptimizationConfigCheckPlugin({
 *           runId: process.env.RSPACK_AUDIT_RUN_ID,
 *           compilerId: 'web',
 *           outDir: process.env.RSPACK_OPT_CONFIG_OUT_DIR,
 *         }));
 *       }
 *       return config;
 *     }
 *   }
 */
const { existsSync, mkdirSync, writeFileSync } = require('fs');
const assert = require('assert');
const { basename, resolve } = require('path');

const PLUGIN_NAME = 'OptimizationConfigCheckPlugin';

const OPTIMIZATION_KEYS = [
  'nodeEnv',
  'providedExports',
  'usedExports',
  'sideEffects',
  'innerGraph',
  'concatenateModules',
  'inlineExports',
  'minimize',
  'mangleExports',
  'mergeDuplicateChunks',
  'removeEmptyChunks',
  'runtimeChunk',
  'chunkIds',
  'moduleIds',
  'avoidEntryIife',
];

const SPLIT_CHUNKS_KEYS = [
  'chunks',
  'defaultSizeTypes',
  'minSize',
  'minSizeReduction',
  'minRemainingSize',
  'minChunks',
  'maxAsyncRequests',
  'maxInitialRequests',
  'enforceSizeThreshold',
  'maxSize',
  'maxAsyncSize',
  'maxInitialSize',
  'hidePathInfo',
];

const CACHE_GROUP_KEYS = [
  'test',
  'type',
  'chunks',
  'name',
  'filename',
  'priority',
  'minSize',
  'minSizeReduction',
  'minRemainingSize',
  'minChunks',
  'maxAsyncRequests',
  'maxInitialRequests',
  'maxSize',
  'maxAsyncSize',
  'maxInitialSize',
  'reuseExistingChunk',
  'enforce',
];

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function summarize(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value === undefined) return '[undefined]';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';

  const typeName = value.constructor?.name || 'Object';
  if (depth >= 3) return `[${typeName}]`;

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, 100).map((item) => summarize(item, depth + 1, seen));
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const key of Object.keys(value).sort().slice(0, 100)) {
    result[key] = summarize(value[key], depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function pick(value, keys) {
  if (!value || typeof value !== 'object') return summarize(value);
  const result = {};
  for (const key of keys) {
    if (hasOwn(value, key)) result[key] = summarize(value[key]);
  }
  return result;
}

function summarizePlugin(plugin) {
  if (plugin === '...') return '...';
  if (plugin === null || plugin === undefined) return summarize(plugin);
  if (typeof plugin === 'function') {
    return { name: plugin.name || 'anonymous-function', kind: 'function' };
  }
  if (typeof plugin !== 'object') return summarize(plugin);

  const result = {
    name: plugin.constructor?.name || plugin.name || 'anonymous-plugin',
  };
  const options = plugin.options ?? plugin._options ?? plugin.minimizerOptions ?? plugin.terserOptions;
  if (options !== undefined) result.options = summarize(options);
  return result;
}

function summarizeSplitChunks(splitChunks) {
  if (splitChunks === false || splitChunks === undefined || splitChunks === null) {
    return summarize(splitChunks);
  }
  if (typeof splitChunks !== 'object') return summarize(splitChunks);

  const result = pick(splitChunks, SPLIT_CHUNKS_KEYS);
  const cacheGroups = splitChunks.cacheGroups;
  if (cacheGroups && typeof cacheGroups === 'object') {
    result.cacheGroups = {};
    for (const name of Object.keys(cacheGroups).sort()) {
      const group = cacheGroups[name];
      result.cacheGroups[name] = group && typeof group === 'object'
        ? pick(group, CACHE_GROUP_KEYS)
        : summarize(group);
    }
  }
  return result;
}

function rspackVersionInfo(activeCompiler, fallbackCompiler) {
  const candidates = [
    ['compiler.rspack.rspackVersion', activeCompiler?.rspack?.rspackVersion],
    ['fallbackCompiler.rspack.rspackVersion', fallbackCompiler?.rspack?.rspackVersion],
    ['compiler.rspack.version', activeCompiler?.rspack?.version],
    ['fallbackCompiler.rspack.version', fallbackCompiler?.rspack?.version],
  ];
  const row = candidates.find(([, value]) => typeof value === 'string' && value.length > 0);
  return row ? { value: row[1], source: row[0] } : { value: null, source: null };
}

function captureOptions(compilation, fallbackCompiler, identity = {}) {
  const activeCompiler = compilation.compiler || fallbackCompiler || {};
  const options = compilation.options || activeCompiler.options || {};
  const optimization = options.optimization || {};
  const capturedOptimization = {};

  for (const key of OPTIMIZATION_KEYS) {
    capturedOptimization[key] = hasOwn(optimization, key)
      ? summarize(optimization[key])
      : '[unavailable]';
  }
  capturedOptimization.minimizer = Array.isArray(optimization.minimizer)
    ? optimization.minimizer.map(summarizePlugin)
    : summarize(optimization.minimizer);
  capturedOptimization.splitChunks = summarizeSplitChunks(optimization.splitChunks);
  const version = rspackVersionInfo(activeCompiler, fallbackCompiler);

  return {
    schemaVersion: 1,
    kind: 'rspack-resolved-optimization-config',
    generatedAt: new Date().toISOString(),
    runId: identity.runId || null,
    source: 'compilation.options',
    rspackVersion: version.value,
    rspackVersionSource: version.source,
    compiler: {
      id: identity.compilerId || null,
      name: activeCompiler.name || options.name || null,
      context: activeCompiler.context || options.context || null,
      mode: options.mode ?? null,
      target: summarize(options.target),
      output: {
        module: options.output?.module ?? null,
        libraryType: options.output?.library?.type ?? null,
        environment: summarize(options.output?.environment),
      },
    },
    optimization: capturedOptimization,
  };
}

function selfTest() {
  const compiler = {
    name: 'web',
    context: '/fixture',
    rspack: { rspackVersion: '2.1.4', version: '5.75.0' },
  };
  const snapshot = captureOptions({
    compiler,
    options: {
      name: 'web',
      context: '/fixture',
      mode: 'production',
      optimization: {
        splitChunks: {
          minSize: 100_000,
          minSizeReduction: 400_000,
          enforceSizeThreshold: 50_000,
          cacheGroups: {
            default: { minSize: 100_000, minSizeReduction: 400_000 },
          },
        },
      },
    },
  }, compiler, { runId: 'run-test', compilerId: 'web' });
  assert.equal(snapshot.rspackVersion, '2.1.4');
  assert.equal(snapshot.rspackVersionSource, 'compiler.rspack.rspackVersion');
  assert.equal(snapshot.runId, 'run-test');
  assert.equal(snapshot.compiler.id, 'web');
  assert.equal(snapshot.optimization.splitChunks.minSizeReduction, 400_000);
  assert.equal(snapshot.optimization.splitChunks.cacheGroups.default.minSizeReduction, 400_000);
  assert.throws(() => captureIdentity({}, compiler), /runId is required/);
  assert.throws(() => captureIdentity({ runId: 'run', compilerId: 'web', outDir: 'tmp/audit', fileName: '../escape.json' }, compiler), /plain filename/);
  const identity = captureIdentity({ runId: 'run/test', compilerId: 'web:client', outDir: 'tmp/audit' }, compiler);
  assert.equal(identity.fileName, 'optimization-config.run-test.web-client.json');
  process.stdout.write('optimization-config-check-plugin self-test passed\n');
}

function safeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

function captureIdentity(options, compiler) {
  const runId = String(options.runId || process.env.RSPACK_AUDIT_RUN_ID || '').trim();
  const compilerId = String(options.compilerId || '').trim();
  const requestedOutDir = options.outDir || process.env.RSPACK_OPT_CONFIG_OUT_DIR;
  if (!runId) throw new Error(`${PLUGIN_NAME}: runId is required`);
  if (!compilerId) throw new Error(`${PLUGIN_NAME}: compilerId is required and must be unique per top-level compiler`);
  if (!requestedOutDir) throw new Error(`${PLUGIN_NAME}: outDir is required and must point inside the isolated audit run`);
  const baseDir = compiler.context || process.cwd();
  const outDir = resolve(baseDir, requestedOutDir);
  const fileName = options.fileName || `optimization-config.${safeFilePart(runId)}.${safeFilePart(compilerId)}.json`;
  if (basename(fileName) !== fileName || fileName === '.' || fileName === '..' || !/^[a-zA-Z0-9_.-]+$/.test(fileName)) {
    throw new Error(`${PLUGIN_NAME}: fileName must be a plain filename without directory components`);
  }
  return { runId, compilerId, outDir, fileName };
}

class OptimizationConfigCheckPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    const identity = captureIdentity(this.options, compiler);
    compiler.hooks.done.tap(PLUGIN_NAME, (stats) => {
      if (typeof stats.hasErrors === 'function' && stats.hasErrors()) {
        throw new Error(`${PLUGIN_NAME}: refusing to write a resolved-config artifact for a failed compilation`);
      }
      const snapshot = captureOptions(stats.compilation, compiler, identity);
      const outPath = resolve(identity.outDir, identity.fileName);
      if (existsSync(outPath)) {
        throw new Error(`${PLUGIN_NAME}: refusing to overwrite an existing audit artifact: ${outPath}`);
      }
      mkdirSync(identity.outDir, { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(`[${PLUGIN_NAME}] ${outPath}`);
    });
  }
}

module.exports = {
  OptimizationConfigCheckPlugin,
  captureIdentity,
  captureOptions,
};

if (require.main === module && process.argv.includes('--self-test')) selfTest();
