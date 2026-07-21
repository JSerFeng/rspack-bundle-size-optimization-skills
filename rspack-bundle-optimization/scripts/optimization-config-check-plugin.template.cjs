// @ts-nocheck
/**
 * Capture the normalized Rspack options used by a real compilation.
 *
 * Default output:
 *   tmp/rspack-optimization/optimization-config[.<compiler-name>].json
 *
 * Direct Rspack wiring (keep it env-gated):
 *   const { OptimizationConfigCheckPlugin } = require('./optimization-config-check-plugin.cjs');
 *   if (process.env.RSPACK_OPT_CONFIG === '1') {
 *     config.plugins ||= [];
 *     config.plugins.push(new OptimizationConfigCheckPlugin());
 *   }
 *
 * Rsbuild wiring:
 *   tools: {
 *     rspack(config, { appendPlugins }) {
 *       if (process.env.RSPACK_OPT_CONFIG === '1') {
 *         appendPlugins(new OptimizationConfigCheckPlugin());
 *       }
 *       return config;
 *     }
 *   }
 */
const { mkdirSync, readFileSync, writeFileSync } = require('fs');
const assert = require('assert');
const { resolve } = require('path');

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

function captureOptions(compilation, fallbackCompiler) {
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
    source: 'compilation.options',
    rspackVersion: version.value,
    rspackVersionSource: version.source,
    compiler: {
      name: activeCompiler.name || options.name || null,
      context: activeCompiler.context || options.context || null,
      mode: options.mode ?? null,
      target: summarize(options.target),
      output: {
        module: options.output?.module ?? null,
        libraryType: options.output?.library?.type ?? null,
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
  }, compiler);
  assert.equal(snapshot.rspackVersion, '2.1.4');
  assert.equal(snapshot.rspackVersionSource, 'compiler.rspack.rspackVersion');
  assert.equal(snapshot.optimization.splitChunks.minSizeReduction, 400_000);
  assert.equal(snapshot.optimization.splitChunks.cacheGroups.default.minSizeReduction, 400_000);
  process.stdout.write('optimization-config-check-plugin self-test passed\n');
}

function safeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

class OptimizationConfigCheckPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      try {
        const snapshot = captureOptions(compilation, compiler);
        const compilerName = safeFilePart(snapshot.compiler.name);
        const fileName = this.options.fileName ||
          `optimization-config${compilerName ? `.${compilerName}` : ''}.json`;
        const baseDir = compiler.context || process.cwd();
        const outDir = this.options.outDir
          ? resolve(baseDir, this.options.outDir)
          : resolve(baseDir, 'tmp/rspack-optimization');
        const outPath = resolve(outDir, fileName);
        const contents = `${JSON.stringify(snapshot, null, 2)}\n`;

        let previous = null;
        try { previous = readFileSync(outPath, 'utf8'); } catch {}
        if (previous === contents) return;

        mkdirSync(outDir, { recursive: true });
        writeFileSync(outPath, contents);
        console.log(`[${PLUGIN_NAME}] ${outPath}`);
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] failed`, error?.stack || error);
      }
    });
  }
}

module.exports = {
  OptimizationConfigCheckPlugin,
  captureOptions,
};

if (require.main === module && process.argv.includes('--self-test')) selfTest();
