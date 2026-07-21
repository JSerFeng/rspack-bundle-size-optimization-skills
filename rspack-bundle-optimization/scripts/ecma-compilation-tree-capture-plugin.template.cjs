// @ts-nocheck
/**
 * Capture appJs modules across a top-level compilation and every child
 * compilation that owns one of the selected assets. Each compilation remains
 * a separate identity partition; the aggregate index proves exact asset
 * ownership and union coverage without merging canonical module identities.
 */

const { createHash } = require('crypto');
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { basename, dirname, join, relative, resolve } = require('path');

const {
  canonicalIdentity,
  captureInventory,
  normalizeIdentifier,
} = require('./ecma-module-capture-plugin.template.cjs');

const PLUGIN_NAME = 'EcmaCompilationTreeCapturePlugin';

function safe(getter, fallback = undefined) {
  try {
    const value = getter();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function slash(value) {
  return String(value).replace(/\\/g, '/');
}

function normalizeAssetName(value) {
  return slash(value).replace(/^\.\//, '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeFilePart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'partition';
}

function normalizedCompilerName(compilation, compiler) {
  const context = resolve(compiler?.context || process.cwd());
  return normalizeIdentifier(
    compiler?.name || compilation?.name || 'unnamed-child',
    context,
  );
}

function collectCompilationTree(root) {
  const result = [];
  const seen = new Set();
  function visit(compilation, depth, registration = null) {
    if (!compilation || seen.has(compilation)) return;
    seen.add(compilation);
    result.push({ compilation, depth, registration });
    const children = [...(compilation.children || [])];
    const occurrences = new Map();
    const childRows = children.map((child, childIndex) => {
      const compiler = child?.compiler || null;
      const compilerName = normalizedCompilerName(child, compiler);
      const compilerNameOccurrenceIndex = occurrences.get(compilerName) || 0;
      occurrences.set(compilerName, compilerNameOccurrenceIndex + 1);
      return { child, childIndex, compilerName, compilerNameOccurrenceIndex };
    });
    for (const row of childRows) {
      visit(row.child, depth + 1, {
        parentCompilation: compilation,
        childIndex: row.childIndex,
        compilerName: row.compilerName,
        compilerNameOccurrenceIndex: row.compilerNameOccurrenceIndex,
        sameNameSiblingCount: occurrences.get(row.compilerName),
      });
    }
  }
  visit(root, 0);
  return result;
}

function selectedAppJsAssets(compilation, options) {
  const assets = safe(() => compilation.getAssets(), []) || [];
  if (typeof options.appJsAssetFilter !== 'function') {
    throw new Error('appJsAssetFilter is required for compilation-tree capture');
  }
  const selected = assets
    .filter((asset) => options.appJsAssetFilter(asset.name, asset.info || {}, asset))
    .map((asset) => normalizeAssetName(asset.name))
    .sort();
  if (selected.length === 0) throw new Error('appJs selection is empty');
  return [...new Set(selected)];
}

function entryRootKeys(compilation, compiler) {
  const context = resolve(compiler.context || process.cwd());
  const roots = [];
  for (const chunk of compilation.chunks || []) {
    for (const module of safe(
      () => compilation.chunkGraph.getChunkEntryModulesIterable(chunk),
      [],
    ) || []) {
      roots.push(canonicalIdentity(module, context).canonicalKey);
    }
  }
  return [...new Set(roots)].sort();
}

function partitionSignature(compilation, compiler, isRoot) {
  const compilerName = normalizedCompilerName(compilation, compiler);
  const entryRoots = entryRootKeys(compilation, compiler);
  return {
    kind: isRoot ? 'root' : 'child',
    compilerName,
    entryRoots,
  };
}

function partitionIdFor(stableIdentity, rootCompilerId) {
  if (stableIdentity.kind === 'root') return rootCompilerId;
  const digest = sha256(JSON.stringify(stableIdentity)).slice(0, 12);
  return `${rootCompilerId}-child-${digest}`;
}

function rspackVersionRecord(compiler) {
  const candidates = [
    ['compiler.rspack.rspackVersion', safe(() => compiler.rspack.rspackVersion, null)],
    ['compiler.webpack.rspackVersion', safe(() => compiler.webpack.rspackVersion, null)],
  ];
  for (const [source, value] of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return { version: value.trim(), source, verifiedRspackField: true };
    }
  }
  const compatibilityCandidates = [
    ['compiler.rspack.version', safe(() => compiler.rspack.version, null)],
    ['compiler.webpack.version', safe(() => compiler.webpack.version, null)],
  ];
  for (const [source, value] of compatibilityCandidates) {
    if (typeof value === 'string' && value.trim()) {
      return { version: value.trim(), source, verifiedRspackField: false };
    }
  }
  return { version: null, source: null, verifiedRspackField: false };
}

function ownedChunkAssets(compilation, selectedSet) {
  const owned = new Set();
  for (const chunk of compilation.chunks || []) {
    for (const file of chunk.files || []) {
      const name = normalizeAssetName(file);
      if (selectedSet.has(name)) owned.add(name);
    }
  }
  return [...owned].sort();
}

function sourceSinkFor(inventoryFile) {
  const fileName = basename(inventoryFile).replace(/\.json$/i, '');
  const sourceDir = resolve(dirname(inventoryFile), `${fileName}-sources`);
  mkdirSync(sourceDir, { recursive: true });
  return ({ source, sha256: hash }) => {
    const file = resolve(sourceDir, `${hash}.txt`);
    if (!existsSync(file)) writeFileSync(file, source, 'utf8');
    return slash(relative(dirname(inventoryFile), file));
  };
}

function captureCompilationTree(rootCompilation, rootCompiler, options = {}) {
  const runId = String(options.runId || process.env.RSPACK_AUDIT_RUN_ID || '').trim();
  const variant = String(options.variant || process.env.RSPACK_ECMA_VARIANT || '').trim();
  const rootCompilerId = String(options.compilerId || rootCompiler.name || 'web').trim();
  const appJsRuleId = String(options.appJsRuleId || '').trim();
  if (!runId) throw new Error('runId is required');
  if (!variant) throw new Error('variant is required');
  if (!rootCompilerId) throw new Error('compilerId is required');
  if (!appJsRuleId) throw new Error('appJsRuleId is required');

  const selected = selectedAppJsAssets(rootCompilation, options);
  const selectedSet = new Set(selected);
  const nodes = collectCompilationTree(rootCompilation);
  const rootVersion = rspackVersionRecord(rootCompiler);
  const partitionByCompilation = new Map();
  const partitions = [];
  for (const { compilation, depth, registration } of nodes) {
    const compiler = compilation.compiler || (depth === 0 ? rootCompiler : null);
    if (!compiler) throw new Error(`compilation at depth ${depth} has no compiler`);
    const signature = partitionSignature(compilation, compiler, depth === 0);
    const parentPartition = depth === 0
      ? null
      : partitionByCompilation.get(registration?.parentCompilation);
    if (depth > 0 && !parentPartition) {
      throw new Error(`compilation at depth ${depth} has no registered parent partition`);
    }
    const stableIdentity = depth === 0
      ? { kind: 'root', compilerId: rootCompilerId }
      : {
          kind: 'child-registration-v1',
          parentPartitionId: parentPartition.partitionId,
          compilerName: signature.compilerName,
          compilerNameOccurrenceIndex: registration.compilerNameOccurrenceIndex,
        };
    let version = rspackVersionRecord(compiler);
    if (!version.verifiedRspackField && rootVersion.verifiedRspackField) {
      version = {
        ...rootVersion,
        source: `root-compiler:${rootVersion.source}`,
        inheritedFromRootCompiler: true,
      };
    }
    const partition = {
      compilation,
      compiler,
      depth,
      registration: depth === 0 ? null : {
        childIndex: registration.childIndex,
        compilerNameOccurrenceIndex: registration.compilerNameOccurrenceIndex,
        sameNameSiblingCount: registration.sameNameSiblingCount,
      },
      stableIdentity,
      signature,
      signatureHash: sha256(JSON.stringify(signature)),
      partitionId: partitionIdFor(stableIdentity, rootCompilerId),
      rspackVersion: version,
      appJsAssets: ownedChunkAssets(compilation, selectedSet),
    };
    partitions.push(partition);
    partitionByCompilation.set(compilation, partition);
  }

  const dataQuality = [];
  if (!rootVersion.verifiedRspackField) {
    dataQuality.push({
      type: 'rspack-version-unverified',
      compilerId: rootCompilerId,
      value: rootVersion.version,
      source: rootVersion.source,
    });
  }
  for (const partition of partitions) {
    if (!partition.rspackVersion.verifiedRspackField) {
      dataQuality.push({
        type: 'rspack-version-unverified',
        compilerId: partition.partitionId,
        value: partition.rspackVersion.version,
        source: partition.rspackVersion.source,
      });
    }
  }
  const signatureGroups = new Map();
  for (const partition of partitions) {
    const key = JSON.stringify(partition.signature);
    const list = signatureGroups.get(key) || [];
    list.push(partition);
    signatureGroups.set(key, list);
  }
  for (const [signature, list] of signatureGroups) {
    if (list.length > 1) {
      dataQuality.push({
        type: 'ambiguous-compilation-partition-signature',
        signature: JSON.parse(signature),
        count: list.length,
      });
    }
  }

  const ownerMap = new Map(selected.map((asset) => [asset, []]));
  for (const partition of partitions) {
    for (const asset of partition.appJsAssets) ownerMap.get(asset).push(partition.partitionId);
  }
  for (const [asset, owners] of ownerMap) {
    if (owners.length === 0) dataQuality.push({ type: 'app-js-asset-without-compilation-owner', asset });
    else if (owners.length > 1) dataQuality.push({ type: 'app-js-asset-with-multiple-compilation-owners', asset, owners });
  }

  const active = partitions
    .filter((partition) => partition.appJsAssets.length > 0)
    .sort((a, b) => a.partitionId.localeCompare(b.partitionId));
  const inactive = partitions
    .filter((partition) => partition.appJsAssets.length === 0)
    .sort((a, b) => a.partitionId.localeCompare(b.partitionId));
  const partitionIds = new Set();
  for (const partition of partitions) {
    if (partitionIds.has(partition.partitionId)) {
      dataQuality.push({ type: 'duplicate-partition-id', partitionId: partition.partitionId });
    }
    partitionIds.add(partition.partitionId);
  }

  const outDir = resolve(
    rootCompiler.context || process.cwd(),
    options.outDir || dirname(options.indexFile || './tmp/rspack-ecma/module-inventory.index.json'),
  );
  mkdirSync(outDir, { recursive: true });

  const inventories = [];
  for (const partition of active) {
    const inventoryFile = resolve(
      outDir,
      `module-inventory.${safeFilePart(partition.partitionId)}.json`,
    );
    const inventory = captureInventory(
      partition.compilation,
      partition.compiler,
      {
        runId,
        variant,
        compilerId: partition.partitionId,
        appJsRuleId: `${appJsRuleId}:partition-v1`,
        appJsAssets: partition.appJsAssets,
      },
      sourceSinkFor(inventoryFile),
    );
    inventory.compiler.rspackVersion = partition.rspackVersion.version;
    inventory.compiler.rspackVersionSource = partition.rspackVersion.source;
    writeFileSync(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
    if (!inventory.complete) {
      dataQuality.push({
        type: 'incomplete-partition-inventory',
        partitionId: partition.partitionId,
        issues: inventory.dataQuality,
      });
    }
    inventories.push({ partition, inventory, inventoryFile });
  }

  const union = [...new Set(inventories.flatMap(({ inventory }) => inventory.scope.appJsAssets))].sort();
  if (JSON.stringify(union) !== JSON.stringify(selected)) {
    dataQuality.push({ type: 'partition-asset-union-mismatch', selected, union });
  }

  const partitionIndexRecord = (partition, activePartition, extra = {}) => ({
    partitionId: partition.partitionId,
    depth: partition.depth,
    active: activePartition,
    stableIdentity: partition.stableIdentity,
    registration: partition.registration,
    signature: partition.signature,
    signatureHash: partition.signatureHash,
    appJsAssets: partition.appJsAssets,
    ...extra,
  });

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId,
    variant,
    compiler: {
      id: rootCompilerId,
      name: rootCompiler.name || rootCompiler.options?.name || null,
      context: resolve(rootCompiler.context || process.cwd()),
      rspackVersion: rootVersion.version,
      rspackVersionSource: rootVersion.source,
    },
    scope: {
      kind: 'modules-connected-to-app-js-assets-across-compilation-tree',
      appJsRuleId,
      appJsAssets: selected,
    },
    counts: {
      compilationsVisited: partitions.length,
      activePartitions: inventories.length,
      inactivePartitions: inactive.length,
      appJsAssets: selected.length,
      logicalModulesByPartition: Object.fromEntries(
        inventories.map(({ partition, inventory }) => [partition.partitionId, inventory.counts.logicalModules]),
      ),
    },
    partitions: inventories.map(({ partition, inventory, inventoryFile }) => partitionIndexRecord(partition, true, {
      inventoryFile: slash(relative(dirname(options.indexFile || outDir), inventoryFile)),
      logicalModules: inventory.counts.logicalModules,
      complete: inventory.complete,
    })),
    inactivePartitions: inactive.map((partition) => partitionIndexRecord(partition, false, {
      inventoryFile: null,
      logicalModules: null,
      complete: null,
      captureStatus: 'inactive-no-selected-app-js-assets',
    })),
    visitedPartitions: partitions
      .map((partition) => partitionIndexRecord(partition, partition.appJsAssets.length > 0))
      .sort((a, b) => a.partitionId.localeCompare(b.partitionId)),
    complete: dataQuality.length === 0,
    dataQuality,
    identityWarning: 'Canonical module identities are local to partitionId. Compare matching partitions independently; never deduplicate the same canonicalKey across parent and child compilations.',
  };
  return { index, inventories };
}

class EcmaCompilationTreeCapturePlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      const stage = compiler.webpack?.Compilation?.PROCESS_ASSETS_STAGE_REPORT ?? 5000;
      compilation.hooks.processAssets.tap({ name: PLUGIN_NAME, stage }, () => {
        const indexFile = resolve(
          compiler.context || process.cwd(),
          this.options.indexFile || './tmp/rspack-ecma/module-inventory.index.json',
        );
        const result = captureCompilationTree(compilation, compiler, {
          ...this.options,
          indexFile,
          outDir: this.options.outDir || dirname(indexFile),
        });
        mkdirSync(dirname(indexFile), { recursive: true });
        writeFileSync(indexFile, `${JSON.stringify(result.index, null, 2)}\n`, 'utf8');
        console.log(`[${PLUGIN_NAME}] partitions=${result.index.counts.activePartitions} assets=${result.index.counts.appJsAssets} issues=${result.index.dataQuality.length}`);
        console.log(`[${PLUGIN_NAME}] wrote ${indexFile}`);
        if (!result.index.complete) {
          throw new Error(`${PLUGIN_NAME} incomplete; inspect ${indexFile}`);
        }
      });
    });
  }
}

function selfTest() {
  const makeModule = (resource, source) => ({
    resource,
    type: 'javascript/auto',
    layer: null,
    identifier: () => resource,
    originalSource: () => ({ source: () => source }),
  });
  const makeConcatenatedEntry = (identifier, inner) => ({
    type: 'javascript/esm',
    layer: null,
    modules: [inner],
    identifier: () => identifier,
    originalSource: () => ({ source: () => 'export const entry = 1;' }),
  });
  const mainModule = makeModule('/repo/src/main.js', 'export const main = 1;');
  const workerModule = makeModule('/repo/src/worker.js', 'export const worker = 1;');
  const inactiveModule = makeModule('/repo/src/inactive.js', 'export const inactive = 1;');
  const makeCompilation = (compiler, asset, module, children = [], entryModule = module) => {
    const chunk = { id: asset, name: asset, files: new Set([asset]) };
    const compilation = {
      compiler,
      children,
      chunks: new Set([chunk]),
      entrypoints: new Map([['entry', { chunks: [chunk] }]]),
      getAssets: () => [{ name: asset, info: {} }],
      chunkGraph: {
        getChunkModulesIterable: () => [compilation.module],
        getChunkEntryModulesIterable: () => [compilation.entryModule],
      },
      moduleGraph: {
        getIncomingConnections: () => [],
        getIssuer: () => null,
      },
      module,
      entryModule,
    };
    return compilation;
  };
  const rspackApi = { rspackVersion: '2.1.4', version: '5.75.0' };
  const rootCompiler = { context: '/repo', name: 'web', webpack: rspackApi };
  const childCompiler = { context: '/repo', name: 'web|worker-loader /repo/src/worker.js', webpack: rspackApi };
  const child = makeCompilation(
    childCompiler,
    'static/js/worker.aaa.worker.js',
    workerModule,
    [],
    makeConcatenatedEntry('javascript/esm|/repo/src/worker.js|old-target-hash', workerModule),
  );
  const inactive = makeCompilation(childCompiler, 'other/inactive.js', inactiveModule);
  const root = makeCompilation(rootCompiler, 'static/js/main.aaa.js', mainModule, [child, inactive]);
  const temp = mkdtempSync(join(tmpdir(), 'ecma-tree-self-test-'));
  try {
    root.getAssets = () => [
      { name: 'static/js/main.aaa.js', info: {} },
      { name: 'static/js/worker.aaa.worker.js', info: {} },
      { name: 'other/inactive.js', info: {} },
    ];
    const firstDir = resolve(temp, 'baseline');
    const first = captureCompilationTree(root, rootCompiler, {
      runId: 'run-test',
      variant: 'baseline',
      compilerId: 'web',
      appJsRuleId: 'static-js-v1',
      appJsAssetFilter: (name) => name.startsWith('static/js/') && name.endsWith('.js'),
      outDir: firstDir,
      indexFile: resolve(firstDir, 'index.json'),
    });
    if (!first.index.complete || first.index.counts.activePartitions !== 2 || first.index.counts.compilationsVisited !== 3) throw new Error('tree partition self-test failed');
    if (first.index.counts.inactivePartitions !== 1 || first.index.inactivePartitions.length !== 1 || first.index.visitedPartitions.length !== 3) throw new Error('inactive partition self-test failed');
    if (first.index.partitions.flatMap((partition) => partition.appJsAssets).length !== 2) throw new Error('asset union self-test failed');
    if (first.index.compiler.rspackVersion !== '2.1.4' || first.index.compiler.rspackVersionSource !== 'compiler.webpack.rspackVersion') throw new Error('real Rspack version self-test failed');
    if (first.inventories.some(({ inventory }) => inventory.compiler.rspackVersion !== '2.1.4')) throw new Error('partition Rspack version self-test failed');
    const firstChild = first.index.partitions.find((partition) => partition.depth === 1);
    if (!firstChild || firstChild.registration.sameNameSiblingCount !== 2 || firstChild.stableIdentity.compilerNameOccurrenceIndex !== 0) throw new Error('child registration identity self-test failed');

    child.chunks = new Set([{ id: 'worker', name: 'worker', files: new Set(['static/js/worker.bbb.worker.js']) }]);
    child.entrypoints = new Map([['entry', { chunks: [...child.chunks] }]]);
    child.entryModule = makeConcatenatedEntry('javascript/esm|/repo/src/worker.js|new-target-hash', workerModule);
    child.getAssets = () => [{ name: 'static/js/worker.bbb.worker.js', info: {} }];
    root.getAssets = () => [
      { name: 'static/js/main.aaa.js', info: {} },
      { name: 'static/js/worker.bbb.worker.js', info: {} },
      { name: 'other/inactive.js', info: {} },
    ];
    const secondDir = resolve(temp, 'target-policy');
    const second = captureCompilationTree(root, rootCompiler, {
      runId: 'run-test',
      variant: 'target-policy',
      compilerId: 'web',
      appJsRuleId: 'static-js-v1',
      appJsAssetFilter: (name) => name.startsWith('static/js/') && name.endsWith('.js'),
      outDir: secondDir,
      indexFile: resolve(secondDir, 'index.json'),
    });
    const secondChild = second.index.partitions.find((partition) => partition.depth === 1);
    if (!secondChild || secondChild.partitionId !== firstChild.partitionId) throw new Error('stable child partition id self-test failed');
    if (JSON.stringify(secondChild.stableIdentity) !== JSON.stringify(firstChild.stableIdentity)) throw new Error('stable child identity drift self-test failed');
    if (secondChild.signatureHash === firstChild.signatureHash) throw new Error('actual signature drift evidence self-test failed');
    console.log('ecma-compilation-tree-capture-plugin self-test passed');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module && process.argv.includes('--self-test')) selfTest();

module.exports = {
  EcmaCompilationTreeCapturePlugin,
  captureCompilationTree,
  collectCompilationTree,
  entryRootKeys,
  normalizedCompilerName,
  ownedChunkAssets,
  partitionIdFor,
  partitionSignature,
  rspackVersionRecord,
};
