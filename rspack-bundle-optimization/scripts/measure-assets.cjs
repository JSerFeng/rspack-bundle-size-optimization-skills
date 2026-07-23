#!/usr/bin/env node
// Capture exact asset bytes or compare two captures.
// This tool reports arithmetic only and never interprets a delta.

const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('fs');
const { createHash } = require('crypto');
const { gzipSync } = require('zlib');
const { dirname, isAbsolute, relative, resolve, sep } = require('path');
const { tmpdir } = require('os');

function parseArgs(argv) {
  const values = { _: [] };
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      values._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) values[key] = true;
    else {
      values[key] = next;
      index++;
    }
  }
  return values;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeAssetName(value) {
  return String(value).split(sep).join('/').replace(/^\.\//, '');
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function readAssetManifest(path) {
  const absolute = resolve(path);
  const body = readFileSync(absolute);
  const value = JSON.parse(body.toString('utf8'));
  const rows = Array.isArray(value)
    ? value
    : value.assets
      || value.appJsAssets
      || value.includedAssets
      || value.scope?.appJsAssets;
  if (!Array.isArray(rows)) {
    throw new Error(
      'Asset manifest must be an array or contain assets, appJsAssets, '
      + 'includedAssets, or scope.appJsAssets',
    );
  }
  const assets = rows.map((row) =>
    normalizeAssetName(typeof row === 'string' ? row : row.name || row.asset));
  if (assets.some((asset) => !asset || asset === 'undefined')) {
    throw new Error('Asset manifest contains an entry without a name');
  }
  if (new Set(assets).size !== assets.length) {
    throw new Error('Asset manifest contains duplicate names');
  }
  return {
    assets: assets.sort(),
    path: absolute,
    bytes: body.length,
    sha256: sha256(body),
  };
}

function selectAssets(root, args) {
  const files = listFiles(root);
  const available = new Map(
    files.map((path) => [normalizeAssetName(relative(root, path)), path]),
  );
  if (args.manifest) {
    const manifest = readAssetManifest(args.manifest);
    const missing = manifest.assets.filter((asset) => !available.has(asset));
    if (missing.length) {
      throw new Error(`Selected assets are missing from output: ${missing.join(', ')}`);
    }
    return {
      rule: {
        type: 'manifest',
        path: manifest.path,
        bytes: manifest.bytes,
        sha256: manifest.sha256,
      },
      rows: manifest.assets.map((name) => ({ name, path: available.get(name) })),
    };
  }
  if (!args.include) {
    throw new Error('Provide --manifest <json> or --include <regular-expression>');
  }
  let include;
  try {
    include = new RegExp(String(args.include));
  } catch (error) {
    throw new Error(`Invalid --include regular expression: ${error.message}`);
  }
  const rows = [...available.entries()]
    .filter(([name]) => include.test(name))
    .map(([name, path]) => ({ name, path }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!rows.length) throw new Error('The asset inclusion rule selected no files');
  return {
    rule: { type: 'regular-expression', source: String(args.include) },
    rows,
  };
}

function writeFresh(path, value) {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`Refusing to overwrite: ${absolute}`);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
  return absolute;
}

function measure(args) {
  if (!args.dir) throw new Error('--dir is required');
  if (!args.out) throw new Error('--out is required');
  const root = resolve(args.dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Missing output directory: ${root}`);
  }
  const selection = selectAssets(root, args);
  const assets = selection.rows.map(({ name, path }) => {
    const body = readFileSync(path);
    return {
      name,
      rawBytes: body.length,
      gzipBytes: gzipSync(body, { level: 9 }).length,
      sha256: sha256(body),
    };
  });
  const value = {
    schemaVersion: 1,
    kind: 'rspack-bundle-asset-measurement',
    generatedAt: new Date().toISOString(),
    runId: args['run-id'] || null,
    label: args.label || null,
    outputDirectory: root,
    inclusionRule: selection.rule,
    gzip: {
      implementation: 'node:zlib.gzipSync',
      level: 9,
      aggregation: 'compress each asset independently, then sum',
    },
    totals: {
      assets: assets.length,
      rawBytes: assets.reduce((sum, asset) => sum + asset.rawBytes, 0),
      gzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    },
    assets,
  };
  const out = writeFresh(args.out, value);
  return { out, ...value.totals };
}

function loadMeasurement(path, label) {
  const absolute = resolve(path);
  const value = JSON.parse(readFileSync(absolute, 'utf8'));
  if (
    value.schemaVersion !== 1
    || value.kind !== 'rspack-bundle-asset-measurement'
  ) {
    throw new Error(`${label} has an unsupported or missing measurement schema`);
  }
  if (!Array.isArray(value.assets) || !value.totals) {
    throw new Error(`${label} is missing assets or totals`);
  }
  return { absolute, value };
}

function inclusionRuleKey(rule) {
  if (!rule || typeof rule !== 'object') return JSON.stringify(rule);
  if (rule.type === 'manifest') {
    return JSON.stringify({ type: rule.type, sha256: rule.sha256 });
  }
  return JSON.stringify(rule);
}

function compare(args) {
  if (!args.baseline || !args.experiment || !args.out) {
    throw new Error('compare requires --baseline, --experiment, and --out');
  }
  const baseline = loadMeasurement(args.baseline, 'baseline');
  const experiment = loadMeasurement(args.experiment, 'experiment');
  const baselineByName = new Map(
    baseline.value.assets.map((asset) => [asset.name, asset]),
  );
  const experimentByName = new Map(
    experiment.value.assets.map((asset) => [asset.name, asset]),
  );
  const names = [...new Set([
    ...baselineByName.keys(),
    ...experimentByName.keys(),
  ])].sort();
  const assets = names.map((name) => {
    const before = baselineByName.get(name) || null;
    const after = experimentByName.get(name) || null;
    return {
      name,
      baselineRawBytes: before?.rawBytes ?? 0,
      experimentRawBytes: after?.rawBytes ?? 0,
      rawDeltaBytes: (after?.rawBytes ?? 0) - (before?.rawBytes ?? 0),
      baselineGzipBytes: before?.gzipBytes ?? 0,
      experimentGzipBytes: after?.gzipBytes ?? 0,
      gzipDeltaBytes: (after?.gzipBytes ?? 0) - (before?.gzipBytes ?? 0),
      baselineSha256: before?.sha256 ?? null,
      experimentSha256: after?.sha256 ?? null,
    };
  });
  const value = {
    schemaVersion: 1,
    kind: 'rspack-bundle-asset-comparison',
    generatedAt: new Date().toISOString(),
    baseline: {
      path: baseline.absolute,
      runId: baseline.value.runId,
      label: baseline.value.label,
      inclusionRule: baseline.value.inclusionRule,
      totals: baseline.value.totals,
    },
    experiment: {
      path: experiment.absolute,
      runId: experiment.value.runId,
      label: experiment.value.label,
      inclusionRule: experiment.value.inclusionRule,
      totals: experiment.value.totals,
    },
    inclusionRulesEquivalent:
      inclusionRuleKey(baseline.value.inclusionRule)
      === inclusionRuleKey(experiment.value.inclusionRule),
    totals: {
      rawDeltaBytes:
        experiment.value.totals.rawBytes - baseline.value.totals.rawBytes,
      gzipDeltaBytes:
        experiment.value.totals.gzipBytes - baseline.value.totals.gzipBytes,
      assetCountDelta:
        experiment.value.totals.assets - baseline.value.totals.assets,
    },
    assetSet: {
      added: names.filter((name) =>
        !baselineByName.has(name) && experimentByName.has(name)),
      removed: names.filter((name) =>
        baselineByName.has(name) && !experimentByName.has(name)),
      retained: names.filter((name) =>
        baselineByName.has(name) && experimentByName.has(name)),
    },
    assets,
  };
  const out = writeFresh(args.out, value);
  return { out, ...value.totals };
}

function selfTest() {
  const assert = require('assert');
  const root = mkdtempSync(resolve(tmpdir(), 'measure-assets-'));
  try {
    const baselineDir = resolve(root, 'baseline');
    const experimentDir = resolve(root, 'experiment');
    mkdirSync(baselineDir);
    mkdirSync(experimentDir);
    writeFileSync(resolve(baselineDir, 'main.js'), 'const value = 1;\n'.repeat(20));
    writeFileSync(resolve(baselineDir, 'ignored.css'), 'body{}\n');
    writeFileSync(resolve(experimentDir, 'main.js'), 'const value = 1;\n'.repeat(10));
    const baselineOut = resolve(root, 'baseline.json');
    const experimentOut = resolve(root, 'experiment.json');
    const comparisonOut = resolve(root, 'comparison.json');
    measure({
      dir: baselineDir,
      include: '\\.js$',
      out: baselineOut,
      'run-id': 'run',
      label: 'baseline',
    });
    measure({
      dir: experimentDir,
      include: '\\.js$',
      out: experimentOut,
      'run-id': 'run',
      label: 'experiment',
    });
    compare({
      baseline: baselineOut,
      experiment: experimentOut,
      out: comparisonOut,
    });
    const result = JSON.parse(readFileSync(comparisonOut, 'utf8'));
    assert.equal(result.assets.length, 1);
    assert.equal(result.totals.rawDeltaBytes, -170);
    assert.equal(result.inclusionRulesEquivalent, true);
    assert.equal(result.baseline.totals.assets, 1);
    assert.throws(
      () => measure({ dir: baselineDir, include: '\\.wasm$', out: 'unused' }),
      /selected no files/,
    );
    process.stdout.write('measure-assets self-test passed\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const mode = args._[0] || 'measure';
  const result = mode === 'compare' ? compare(args) : measure(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = {
  compare,
  inclusionRuleKey,
  measure,
  normalizeAssetName,
  readAssetManifest,
  selectAssets,
};
