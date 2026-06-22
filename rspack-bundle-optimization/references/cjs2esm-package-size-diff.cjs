#!/usr/bin/env node
/*
 * Compare baseline vs CJS-to-ESM experiment stats at npm package granularity.
 *
 * Required inputs:
 *   --baseline-stats path/to/baseline-stats.json
 *   --experiment-stats path/to/cjs2esm-stats.json
 *
 * Recommended input:
 *   --loader-report path/to/transpiled-cjs-to-esm-loader-report.jsonl
 *
 * Optional inputs:
 *   --baseline-dist dist-baseline
 *   --experiment-dist dist-cjs2esm
 *   --out package-size-diff.json
 *   --markdown-out package-size-diff.md
 *
 * Notes:
 * - moduleSize deltas come from stats module sizes and are directly attributable.
 * - attributedEmittedRaw/Gzip deltas are estimates: each JS asset is distributed
 *   to packages by their module-size share inside the chunk.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') {
      args.selfTest = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readLoaderReport(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed.records)) {
      return parsed.records;
    }
    return [parsed];
  } catch {
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\?.*$/, '')
    .replace(/\s+\+\s+\d+\s+modules$/, '');
}

function stripLoaderPrefix(value) {
  const normalized = normalizePath(value);
  const parts = normalized.split('!');
  return parts[parts.length - 1] || normalized;
}

function inferPnpmVersion(cleanPath, packageName) {
  const normalized = normalizePath(cleanPath);
  const encodedName = packageName.replace('/', '+');
  const marker = '/node_modules/.pnpm/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const afterMarker = normalized.slice(markerIndex + marker.length);
  const storeSegment = afterMarker.split('/')[0];
  if (!storeSegment || !storeSegment.startsWith(`${encodedName}@`)) {
    return undefined;
  }
  const rest = storeSegment.slice(encodedName.length + 1);
  return rest.split('_')[0] || undefined;
}

function packageFromPath(value) {
  const cleanPath = stripLoaderPrefix(value);
  const marker = '/node_modules/';
  const markerIndex = cleanPath.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const rest = cleanPath.slice(markerIndex + marker.length);
  const segments = rest.split('/').filter(Boolean);
  if (segments.length === 0 || segments[0] === '.pnpm') {
    return undefined;
  }
  const packageName = segments[0].startsWith('@') && segments.length >= 2
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
  const version = inferPnpmVersion(cleanPath, packageName);
  return {
    packageName,
    version,
    packageId: version ? `${packageName}@${version}` : packageName,
  };
}

function packageFromModule(module) {
  const candidates = [
    module.resource,
    module.nameForCondition,
    module.identifier,
    module.moduleIdentifier,
    module.name,
  ];
  for (const candidate of candidates) {
    const pkg = packageFromPath(candidate);
    if (pkg) {
      return pkg;
    }
  }
  return undefined;
}

function getModuleSize(module) {
  if (typeof module.size === 'number') {
    return module.size;
  }
  if (module.sizes && typeof module.sizes === 'object') {
    return Object.values(module.sizes).reduce((sum, value) => {
      return sum + (typeof value === 'number' ? value : 0);
    }, 0);
  }
  return 0;
}

function addToSetMap(map, key, values) {
  const set = map.get(key) || new Set();
  for (const value of values || []) {
    set.add(String(value));
  }
  map.set(key, set);
}

function flattenModules(modules, inheritedChunks = [], output = []) {
  for (const module of modules || []) {
    const chunks = Array.isArray(module.chunks) && module.chunks.length > 0
      ? module.chunks.map(String)
      : inheritedChunks;
    const nested = Array.isArray(module.modules) ? module.modules : [];
    if (nested.length > 0) {
      flattenModules(nested, chunks, output);
      continue;
    }
    output.push({
      module,
      chunks,
      size: getModuleSize(module),
      pkg: packageFromModule(module),
    });
  }
  return output;
}

function collectStatsModules(stats) {
  const modules = flattenModules(stats.modules || []);
  for (const child of stats.children || []) {
    flattenModules(child.modules || [], [], modules);
  }
  return modules;
}

function collectStatsAssets(stats) {
  const assets = [];
  for (const asset of stats.assets || []) {
    assets.push(asset);
  }
  for (const child of stats.children || []) {
    for (const asset of child.assets || []) {
      assets.push(asset);
    }
  }
  return assets;
}

function readAssetBytes(distDir, assetName) {
  if (!distDir || !assetName) {
    return undefined;
  }
  const filePath = path.resolve(distDir, assetName);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return fs.readFileSync(filePath);
}

function aggregateStats(stats, distDir) {
  const packageMap = new Map();
  const chunkPackageSizes = new Map();
  const chunkTotalSizes = new Map();

  for (const item of collectStatsModules(stats)) {
    if (!item.pkg) {
      continue;
    }
    const packageId = item.pkg.packageId;
    const record = packageMap.get(packageId) || {
      packageId,
      packageName: item.pkg.packageName,
      version: item.pkg.version,
      moduleCount: 0,
      moduleSize: 0,
      chunks: new Set(),
    };
    record.moduleCount += 1;
    record.moduleSize += item.size;
    for (const chunkId of item.chunks || []) {
      record.chunks.add(String(chunkId));
    }
    packageMap.set(packageId, record);

    for (const chunkId of item.chunks || []) {
      const key = String(chunkId);
      const packageSizes = chunkPackageSizes.get(key) || new Map();
      packageSizes.set(packageId, (packageSizes.get(packageId) || 0) + item.size);
      chunkPackageSizes.set(key, packageSizes);
      chunkTotalSizes.set(key, (chunkTotalSizes.get(key) || 0) + item.size);
    }
  }

  const assetRecords = collectStatsAssets(stats)
    .filter(asset => asset && typeof asset.name === 'string')
    .filter(asset => asset.name.endsWith('.js') && !asset.name.endsWith('.map'))
    .map(asset => {
      const assetBytes = readAssetBytes(distDir, asset.name);
      return {
        name: asset.name,
        chunks: (asset.chunks || asset.chunkNames || []).map(String),
        rawSize: typeof asset.size === 'number'
          ? asset.size
          : assetBytes
            ? assetBytes.length
            : 0,
        gzipSize: assetBytes ? zlib.gzipSync(assetBytes).length : undefined,
      };
    });

  for (const asset of assetRecords) {
    for (const chunkId of asset.chunks) {
      const totalSize = chunkTotalSizes.get(String(chunkId)) || 0;
      const packageSizes = chunkPackageSizes.get(String(chunkId));
      if (!totalSize || !packageSizes) {
        continue;
      }
      for (const [packageId, packageSize] of packageSizes) {
        const record = packageMap.get(packageId);
        if (!record) {
          continue;
        }
        const ratio = packageSize / totalSize;
        record.attributedEmittedRaw = (record.attributedEmittedRaw || 0) + asset.rawSize * ratio;
        if (typeof asset.gzipSize === 'number') {
          record.attributedEmittedGzip = (record.attributedEmittedGzip || 0) + asset.gzipSize * ratio;
        }
      }
    }
  }

  return packageMap;
}

function aggregateLoaderReport(records) {
  const map = new Map();
  for (const record of records || []) {
    const pkg = packageFromPath(record.resourcePath);
    if (!pkg) {
      continue;
    }
    const entry = map.get(pkg.packageId) || {
      packageId: pkg.packageId,
      packageName: pkg.packageName,
      version: pkg.version,
      transformedModules: 0,
      skippedModules: 0,
      skipReasons: {},
      moduleTypes: {},
    };
    if (record.transformed || record.action === 'transformed') {
      entry.transformedModules += 1;
    } else {
      entry.skippedModules += 1;
      const reason = record.skipReason || 'unknown';
      entry.skipReasons[reason] = (entry.skipReasons[reason] || 0) + 1;
    }
    const moduleType = record.moduleType || 'unknown';
    entry.moduleTypes[moduleType] = (entry.moduleTypes[moduleType] || 0) + 1;
    map.set(pkg.packageId, entry);
  }
  return map;
}

function pct(delta, base) {
  return base ? delta / base : 0;
}

function comparePackages(baselineMap, experimentMap, loaderMap) {
  const ids = new Set([
    ...baselineMap.keys(),
    ...experimentMap.keys(),
    ...loaderMap.keys(),
  ]);
  const packages = [];

  for (const id of ids) {
    const before = baselineMap.get(id);
    const after = experimentMap.get(id);
    const loader = loaderMap.get(id);
    const packageName = before?.packageName || after?.packageName || loader?.packageName || id;
    const version = before?.version || after?.version || loader?.version;
    const baselineModuleSize = before?.moduleSize || 0;
    const experimentModuleSize = after?.moduleSize || 0;
    const moduleSizeDelta = experimentModuleSize - baselineModuleSize;
    const baselineAttributedRaw = before?.attributedEmittedRaw;
    const experimentAttributedRaw = after?.attributedEmittedRaw;
    const baselineAttributedGzip = before?.attributedEmittedGzip;
    const experimentAttributedGzip = after?.attributedEmittedGzip;

    packages.push({
      packageId: id,
      packageName,
      version,
      transformedModules: loader?.transformedModules || 0,
      skippedModules: loader?.skippedModules || 0,
      skipReasons: loader?.skipReasons || {},
      moduleTypes: loader?.moduleTypes || {},
      baselineModuleCount: before?.moduleCount || 0,
      experimentModuleCount: after?.moduleCount || 0,
      moduleCountDelta: (after?.moduleCount || 0) - (before?.moduleCount || 0),
      baselineModuleSize,
      experimentModuleSize,
      moduleSizeDelta,
      moduleSizeDeltaPct: pct(moduleSizeDelta, baselineModuleSize),
      baselineAttributedEmittedRaw: baselineAttributedRaw,
      experimentAttributedEmittedRaw: experimentAttributedRaw,
      attributedEmittedRawDelta: typeof baselineAttributedRaw === 'number' && typeof experimentAttributedRaw === 'number'
        ? experimentAttributedRaw - baselineAttributedRaw
        : undefined,
      attributedEmittedRawDeltaPct: typeof baselineAttributedRaw === 'number' && typeof experimentAttributedRaw === 'number'
        ? pct(experimentAttributedRaw - baselineAttributedRaw, baselineAttributedRaw)
        : undefined,
      baselineAttributedEmittedGzip: baselineAttributedGzip,
      experimentAttributedEmittedGzip: experimentAttributedGzip,
      attributedEmittedGzipDelta: typeof baselineAttributedGzip === 'number' && typeof experimentAttributedGzip === 'number'
        ? experimentAttributedGzip - baselineAttributedGzip
        : undefined,
      attributedEmittedGzipDeltaPct: typeof baselineAttributedGzip === 'number' && typeof experimentAttributedGzip === 'number'
        ? pct(experimentAttributedGzip - baselineAttributedGzip, baselineAttributedGzip)
        : undefined,
      baselineChunks: [...(before?.chunks || [])].sort(),
      experimentChunks: [...(after?.chunks || [])].sort(),
    });
  }

  packages.sort((a, b) => {
    const aDelta = typeof a.attributedEmittedRawDelta === 'number'
      ? a.attributedEmittedRawDelta
      : a.moduleSizeDelta;
    const bDelta = typeof b.attributedEmittedRawDelta === 'number'
      ? b.attributedEmittedRawDelta
      : b.moduleSizeDelta;
    return aDelta - bDelta;
  });
  return packages;
}

function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '';
  }
  return `${Math.round(value)}`;
}

function formatPct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '';
  }
  return `${(value * 100).toFixed(2)}%`;
}

function writeMarkdown(report, outPath) {
  const rows = report.packages
    .filter(pkg => pkg.transformedModules > 0 || pkg.moduleSizeDelta !== 0 || pkg.attributedEmittedRawDelta)
    .slice(0, 50);
  const lines = [
    '# CJS-to-ESM Package Size Diff',
    '',
    'Package-level `moduleSizeDelta` is directly attributed from stats module sizes.',
    '`attributedRawDelta` and `attributedGzipDelta` are estimated by distributing each JS asset to packages by module-size share inside the chunk.',
    '',
    '| Package | Transformed | Skipped | Module delta | Module % | Attributed raw delta | Attributed gzip delta |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const pkg of rows) {
    lines.push([
      pkg.packageId,
      pkg.transformedModules,
      pkg.skippedModules,
      formatBytes(pkg.moduleSizeDelta),
      formatPct(pkg.moduleSizeDeltaPct),
      formatBytes(pkg.attributedEmittedRawDelta),
      formatBytes(pkg.attributedEmittedGzipDelta),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
}

function buildReport(options) {
  const baselineStats = readJson(options.baselineStats);
  const experimentStats = readJson(options.experimentStats);
  const loaderRecords = readLoaderReport(options.loaderReport);
  const baselineMap = aggregateStats(baselineStats, options.baselineDist);
  const experimentMap = aggregateStats(experimentStats, options.experimentDist);
  const loaderMap = aggregateLoaderReport(loaderRecords);
  const packages = comparePackages(baselineMap, experimentMap, loaderMap);
  const packagesWithTransforms = packages.filter(pkg => pkg.transformedModules > 0);
  const packagesWithShrink = packages.filter(pkg => pkg.moduleSizeDelta < 0 || (pkg.attributedEmittedRawDelta ?? 0) < 0);

  return {
    generatedAt: new Date().toISOString(),
    inputs: {
      baselineStats: options.baselineStats,
      experimentStats: options.experimentStats,
      loaderReport: options.loaderReport,
      baselineDist: options.baselineDist,
      experimentDist: options.experimentDist,
    },
    notes: [
      'moduleSizeDelta is directly attributable from stats module sizes.',
      'attributedEmittedRaw/Gzip deltas are estimates based on per-chunk module-size share.',
      'If concatenateModules hides nested modules, rerun stats with concatenateModules:false for attribution fidelity.',
    ],
    summary: {
      packagesInBaseline: baselineMap.size,
      packagesInExperiment: experimentMap.size,
      packagesInLoaderReport: loaderMap.size,
      packagesWithTransforms: packagesWithTransforms.length,
      packagesWithShrink: packagesWithShrink.length,
      transformedModules: packages.reduce((sum, pkg) => sum + pkg.transformedModules, 0),
      skippedModules: packages.reduce((sum, pkg) => sum + pkg.skippedModules, 0),
      totalModuleSizeDelta: packages.reduce((sum, pkg) => sum + pkg.moduleSizeDelta, 0),
      totalAttributedEmittedRawDelta: packages.reduce((sum, pkg) => {
        return sum + (typeof pkg.attributedEmittedRawDelta === 'number' ? pkg.attributedEmittedRawDelta : 0);
      }, 0),
      totalAttributedEmittedGzipDelta: packages.reduce((sum, pkg) => {
        return sum + (typeof pkg.attributedEmittedGzipDelta === 'number' ? pkg.attributedEmittedGzipDelta : 0);
      }, 0),
    },
    packages,
  };
}

function runSelfTest() {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cjs2esm-package-size-diff-'));
  const baselineStats = {
    assets: [{ name: 'main.js', size: 1000, chunks: [1] }],
    modules: [
      {
        name: '/repo/node_modules/.pnpm/@scope+pkg-a@1.2.3/node_modules/@scope/pkg-a/index.js',
        size: 700,
        chunks: [1],
      },
      {
        name: '/repo/node_modules/pkg-b/index.js',
        size: 300,
        chunks: [1],
      },
    ],
  };
  const experimentStats = {
    assets: [{ name: 'main.js', size: 900, chunks: [1] }],
    modules: [
      {
        name: '/repo/node_modules/.pnpm/@scope+pkg-a@1.2.3/node_modules/@scope/pkg-a/index.js',
        size: 600,
        chunks: [1],
      },
      {
        name: '/repo/node_modules/pkg-b/index.js',
        size: 300,
        chunks: [1],
      },
    ],
  };
  const loaderReport = [
    JSON.stringify({
      action: 'transformed',
      transformed: true,
      resourcePath: '/repo/node_modules/.pnpm/@scope+pkg-a@1.2.3/node_modules/@scope/pkg-a/index.js',
      moduleType: 'javascript/auto',
    }),
    JSON.stringify({
      action: 'skipped',
      transformed: false,
      resourcePath: '/repo/node_modules/pkg-b/index.js',
      moduleType: 'javascript/auto',
      skipReason: 'not-rewritable',
    }),
  ].join('\n');
  const baselinePath = path.join(tmpDir, 'baseline.json');
  const experimentPath = path.join(tmpDir, 'experiment.json');
  const loaderPath = path.join(tmpDir, 'loader.jsonl');
  fs.writeFileSync(baselinePath, JSON.stringify(baselineStats));
  fs.writeFileSync(experimentPath, JSON.stringify(experimentStats));
  fs.writeFileSync(loaderPath, loaderReport);

  const report = buildReport({
    baselineStats: baselinePath,
    experimentStats: experimentPath,
    loaderReport: loaderPath,
  });
  const scoped = report.packages.find(pkg => pkg.packageId === '@scope/pkg-a@1.2.3');
  const plain = report.packages.find(pkg => pkg.packageId === 'pkg-b');
  if (!scoped || scoped.moduleSizeDelta !== -100 || scoped.transformedModules !== 1) {
    throw new Error(`self-test failed for scoped package: ${JSON.stringify(scoped)}`);
  }
  if (!plain || plain.skippedModules !== 1 || plain.skipReasons['not-rewritable'] !== 1) {
    throw new Error(`self-test failed for plain package: ${JSON.stringify(plain)}`);
  }
  if (Math.round(scoped.attributedEmittedRawDelta) !== -100) {
    throw new Error(`self-test failed for attributed raw delta: ${scoped.attributedEmittedRawDelta}`);
  }
  console.log('self-test passed');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }
  if (!options.baselineStats || !options.experimentStats) {
    throw new Error('Missing --baseline-stats or --experiment-stats');
  }
  const report = buildReport(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, json);
  } else {
    process.stdout.write(json);
  }
  if (options.markdownOut) {
    writeMarkdown(report, options.markdownOut);
  }
}

main();
