// @ts-nocheck
/**
 * Capture the module set and readable post-loader sources for an ECMA target
 * comparison. The capture is scoped to the exact appJs asset selection used by
 * the size metric; it intentionally does not record stats module.size.
 *
 * Minimal wiring (keep it env-gated and use one output file per compiler):
 *
 *   const { EcmaModuleCapturePlugin } = require('./ecma-module-capture-plugin.cjs');
 *   if (process.env.RSPACK_ECMA_CAPTURE === '1') {
 *     config.plugins ||= [];
 *     config.plugins.push(new EcmaModuleCapturePlugin({
 *       runId: process.env.RSPACK_AUDIT_RUN_ID,
 *       variant: process.env.RSPACK_ECMA_VARIANT,
 *       compilerId: 'web',
 *       outFile: process.env.RSPACK_ECMA_INVENTORY,
 *       appJsRuleId: 'all-web-js-v1',
 *       appJsAssetFilter: name => /\.(?:m?js|cjs)$/.test(name),
 *     }));
 *   }
 *
 * Instead of appJsAssetFilter, pass appJsAssets: string[] or
 * appJsAssetManifest: <json path>. A manifest may be an array or contain the
 * list at appJsAssets, assets, includedAssets, appJs.assets, or
 * scope.appJsAssets.
 */

const { createHash } = require('crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { dirname, isAbsolute, relative, resolve } = require('path');

const PLUGIN_NAME = 'EcmaModuleCapturePlugin';
const JS_ASSET_RE = /\.(?:m?js|cjs)$/i;

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

function splitResourceSuffix(value) {
  const text = String(value || '');
  const query = text.indexOf('?');
  const fragment = text.indexOf('#');
  const indexes = [query, fragment].filter((index) => index >= 0);
  const splitAt = indexes.length ? Math.min(...indexes) : text.length;
  return { path: text.slice(0, splitAt), suffix: text.slice(splitAt) };
}

function normalizeResource(resource, context) {
  if (typeof resource !== 'string' || !resource) return null;
  const { path, suffix } = splitResourceSuffix(resource);
  const normalizedPath = slash(path.replace(/^file:\/\//, ''));
  if (isAbsolute(normalizedPath)) {
    const rel = slash(relative(context, normalizedPath));
    if (rel && !rel.startsWith('../') && !isAbsolute(rel)) return `project:${rel}${suffix}`;
    if (!rel) return `project:.${suffix}`;
    return `absolute:${normalizedPath}${suffix}`;
  }
  return `request:${normalizedPath.replace(/^\.\//, '')}${suffix}`;
}

function normalizeIdentifier(identifier, context) {
  const normalized = slash(identifier || 'unknown-module');
  const normalizedContext = slash(resolve(context));
  return normalized.split(normalizedContext).join('<project>');
}

function rawIdentifier(module) {
  return String(safe(() => module.identifier(), 'unknown-module'));
}

function rawResource(module) {
  const resource = module?.resource;
  if (typeof resource === 'string' && resource) return resource;
  const resolvedResource = safe(() => module?.resourceResolveData?.resource, null);
  return typeof resolvedResource === 'string' && resolvedResource ? resolvedResource : null;
}

function innerModules(module) {
  const value = safe(() => module?.modules, null);
  if (!value || typeof value === 'string' || typeof value[Symbol.iterator] !== 'function') return [];
  return [...value].filter(Boolean);
}

function moduleCategory(module) {
  const ctor = String(module?.constructor?.name || '');
  const type = String(module?.type || '');
  const identifier = rawIdentifier(module);
  if (innerModules(module).length > 0 || /ConcatenatedModule/i.test(ctor)) return 'concatenated-container';
  if (/RuntimeModule/i.test(ctor) || /^runtime(?:\/|$)/.test(type)) return 'runtime';
  if (/ExternalModule/i.test(ctor) || /^external\b/.test(identifier)) return 'external';
  if (/ContextModule/i.test(ctor) || /context module/i.test(identifier)) return 'context';
  if (rawResource(module)) return 'normal';
  return 'virtual';
}

function canonicalIdentity(module, context) {
  const resource = rawResource(module);
  const type = String(module?.type || 'unknown');
  const layer = module?.layer == null ? null : String(module.layer);
  const category = moduleCategory(module);
  if (resource) {
    return {
      canonicalKey: JSON.stringify(['resource', normalizeResource(resource, context), type, layer]),
      canonicalKeyKind: 'resource-type-layer',
      canonicalResource: normalizeResource(resource, context),
      category,
      type,
      layer,
    };
  }
  return {
    canonicalKey: JSON.stringify(['non-resource', category, normalizeIdentifier(rawIdentifier(module), context), type, layer]),
    canonicalKeyKind: 'category-identifier-type-layer',
    canonicalResource: null,
    category,
    type,
    layer,
  };
}

function sourceText(module) {
  const original = safe(() => module.originalSource(), null);
  if (!original) return null;
  const value = safe(() => original.source(), null);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value == null ? null : String(value);
}

function sourceQuality(source) {
  if (source == null) {
    return {
      available: false,
      lineCount: 0,
      nonEmptyLineCount: 0,
      averageLineLength: 0,
      maxLineLength: 0,
      probablyMinified: false,
    };
  }
  const lines = source.split(/\r?\n/);
  let total = 0;
  let nonEmpty = 0;
  let max = 0;
  let long = 0;
  for (const line of lines) {
    total += line.length;
    if (line.trim()) nonEmpty++;
    if (line.length > max) max = line.length;
    if (line.length > 240) long++;
  }
  const average = Math.round(total / Math.max(1, lines.length));
  return {
    available: true,
    lineCount: lines.length,
    nonEmptyLineCount: nonEmpty,
    averageLineLength: average,
    maxLineLength: max,
    longLineCount: long,
    probablyMinified:
      (source.length > 1000 && lines.length <= 3) ||
      (source.length > 5000 && average > 400) ||
      max > 1200,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeAssetName(value) {
  return slash(value).replace(/^\.\//, '');
}

function extractAssetNames(value) {
  const candidates = Array.isArray(value)
    ? value
    : value?.appJsAssets ?? value?.assets ?? value?.includedAssets ?? value?.appJs?.assets ?? value?.scope?.appJsAssets;
  if (!Array.isArray(candidates)) {
    throw new Error('appJs asset manifest must be an array or contain appJsAssets/assets/includedAssets/appJs.assets/scope.appJsAssets');
  }
  const names = candidates.map((item) => typeof item === 'string' ? item : item?.name ?? item?.asset).filter(Boolean).map(normalizeAssetName);
  if (names.length !== candidates.length) throw new Error('appJs asset manifest contains an entry without a string name/asset');
  return [...new Set(names)].sort();
}

function selectAppJsAssets(compilation, compiler, options) {
  const context = compiler.context || process.cwd();
  const emitted = new Map((safe(() => compilation.getAssets(), []) || []).map((asset) => [normalizeAssetName(asset.name), asset]));
  let selected;
  let source;
  if (Array.isArray(options.appJsAssets)) {
    selected = extractAssetNames(options.appJsAssets);
    source = 'plugin-option:appJsAssets';
  } else if (options.appJsAssetManifest) {
    const manifestPath = resolve(context, options.appJsAssetManifest);
    selected = extractAssetNames(JSON.parse(readFileSync(manifestPath, 'utf8')));
    source = manifestPath;
  } else if (typeof options.appJsAssetFilter === 'function') {
    selected = [...emitted.values()]
      .filter((asset) => options.appJsAssetFilter(asset.name, asset.info || {}, asset))
      .map((asset) => normalizeAssetName(asset.name))
      .sort();
    source = 'plugin-option:appJsAssetFilter';
  } else {
    throw new Error('provide appJsAssets, appJsAssetManifest, or appJsAssetFilter; implicit all-JS scope is forbidden');
  }
  if (selected.length === 0) throw new Error('appJs selection is empty');
  const nonJs = selected.filter((name) => !JS_ASSET_RE.test(name));
  if (nonJs.length) throw new Error(`appJs selection contains non-JavaScript assets: ${nonJs.join(', ')}`);
  const missing = selected.filter((name) => !emitted.has(name));
  if (missing.length) throw new Error(`appJs assets were not emitted by compiler ${options.compilerId || compiler.name || 'default'}: ${missing.join(', ')}`);
  return { names: selected, source };
}

function chunkIdentity(chunk) {
  if (chunk?.name != null) return `name:${String(chunk.name)}`;
  if (chunk?.id != null) return `id:${String(chunk.id)}`;
  const files = [...(chunk?.files || [])].map(normalizeAssetName).sort();
  return `files:${files.join(',')}`;
}

function sourceMapKeys(canonicalResource) {
  if (!canonicalResource) return [];
  const prefixes = ['project:', 'request:', 'absolute:'];
  const prefix = prefixes.find((candidate) => canonicalResource.startsWith(candidate));
  const value = prefix ? canonicalResource.slice(prefix.length) : canonicalResource;
  return [...new Set([value, value.replace(/^\.\//, '')])].filter(Boolean).sort();
}

function captureInventory(compilation, compiler, options = {}, sourceSink = () => null) {
  const context = resolve(compiler.context || process.cwd());
  const runId = String(options.runId || process.env.RSPACK_AUDIT_RUN_ID || '').trim();
  const variant = String(options.variant || process.env.RSPACK_ECMA_VARIANT || '').trim();
  const compilerId = String(options.compilerId || compiler.name || compiler.options?.name || 'default').trim();
  const appJsRuleId = String(options.appJsRuleId || '').trim();
  if (!runId) throw new Error('runId is required');
  if (!variant) throw new Error('variant is required');
  if (!compilerId) throw new Error('compilerId is required');
  if (!appJsRuleId) throw new Error('appJsRuleId is required and must identify the persisted appJs inclusion rule');

  const appJs = selectAppJsAssets(compilation, compiler, options);
  const appJsSet = new Set(appJs.names);
  const chunkGraph = compilation.chunkGraph;
  const moduleGraph = compilation.moduleGraph;
  if (!chunkGraph || !moduleGraph) throw new Error('chunkGraph and moduleGraph are required');

  const memberships = new Map();
  const selectedChunks = new Map();
  const associatedAssets = new Set();

  function addMembership(module, chunkRecord, kind, container = null) {
    if (!module) return;
    let membership = memberships.get(module);
    if (!membership) {
      membership = { chunks: new Map(), kinds: new Set(), containers: new Set() };
      memberships.set(module, membership);
    }
    membership.chunks.set(chunkRecord.key, chunkRecord);
    membership.kinds.add(kind);
    if (container) membership.containers.add(container);
  }

  for (const chunk of compilation.chunks || []) {
    const files = [...(chunk.files || [])].map(normalizeAssetName).sort();
    const matchedAssets = files.filter((file) => appJsSet.has(file));
    if (matchedAssets.length === 0) continue;
    for (const asset of matchedAssets) associatedAssets.add(asset);
    const chunkRecord = {
      key: chunkIdentity(chunk),
      id: chunk.id == null ? null : String(chunk.id),
      name: chunk.name == null ? null : String(chunk.name),
      files,
      appJsAssets: matchedAssets,
      entrypoints: [],
    };
    selectedChunks.set(chunk, chunkRecord);
    for (const module of safe(() => chunkGraph.getChunkModulesIterable(chunk), []) || []) {
      addMembership(module, chunkRecord, 'direct');
      for (const inner of innerModules(module)) addMembership(inner, chunkRecord, 'concatenated-inner', module);
    }
  }

  const chunkEntrypoints = new Map();
  const entryModuleFor = new Map();
  for (const [name, entrypoint] of compilation.entrypoints || []) {
    const entryName = String(name);
    for (const chunk of entrypoint.chunks || []) {
      if (!selectedChunks.has(chunk)) continue;
      if (!chunkEntrypoints.has(chunk)) chunkEntrypoints.set(chunk, new Set());
      chunkEntrypoints.get(chunk).add(entryName);
      selectedChunks.get(chunk).entrypoints = [...chunkEntrypoints.get(chunk)].sort();
      for (const module of safe(() => chunkGraph.getChunkEntryModulesIterable(chunk), []) || []) {
        if (!entryModuleFor.has(module)) entryModuleFor.set(module, new Set());
        entryModuleFor.get(module).add(entryName);
      }
    }
  }

  const dataQuality = [];
  for (const name of appJs.names) {
    if (!associatedAssets.has(name)) dataQuality.push({ type: 'app-js-asset-without-chunk', asset: name });
  }

  const records = [];
  for (const [module, membership] of memberships) {
    const identity = canonicalIdentity(module, context);
    const source = sourceText(module);
    const sourceHash = source == null ? null : sha256(Buffer.from(source, 'utf8'));
    const artifact = source == null ? null : sourceSink({ source, sha256: sourceHash, module, identity });
    const chunks = [...membership.chunks.values()].map((chunk) => ({ ...chunk })).sort((a, b) => a.key.localeCompare(b.key));

    const issuers = [];
    const issuerSeen = new Set();
    const incoming = safe(() => moduleGraph.getIncomingConnections(module), []) || [];
    const issuerModules = incoming.map((connection) => connection?.originModule).filter(Boolean);
    const primaryIssuer = safe(() => moduleGraph.getIssuer(module), null);
    if (primaryIssuer) issuerModules.push(primaryIssuer);
    for (const issuer of issuerModules) {
      if (!issuer || issuer === module) continue;
      const issuerIdentity = canonicalIdentity(issuer, context);
      const key = `${issuerIdentity.canonicalKey}\0${rawIdentifier(issuer)}`;
      if (issuerSeen.has(key)) continue;
      issuerSeen.add(key);
      issuers.push({
        canonicalKey: issuerIdentity.canonicalKey,
        rawIdentifier: rawIdentifier(issuer),
        resource: rawResource(issuer),
        canonicalResource: issuerIdentity.canonicalResource,
        category: issuerIdentity.category,
      });
    }
    issuers.sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey) || a.rawIdentifier.localeCompare(b.rawIdentifier));

    const entrypoints = [...new Set(chunks.flatMap((chunk) => chunk.entrypoints))].sort();
    const record = {
      canonicalKey: identity.canonicalKey,
      canonicalKeyKind: identity.canonicalKeyKind,
      identityStatus: 'unique',
      rawIdentifier: rawIdentifier(module),
      resource: rawResource(module),
      canonicalResource: identity.canonicalResource,
      sourceMapKeys: sourceMapKeys(identity.canonicalResource),
      type: identity.type,
      layer: identity.layer,
      category: identity.category,
      logicalModule: identity.category !== 'concatenated-container',
      membershipKinds: [...membership.kinds].sort(),
      concatenatedContainers: [...membership.containers].map((container) => rawIdentifier(container)).sort(),
      chunks,
      entrypoints,
      entryModuleFor: [...(entryModuleFor.get(module) || [])].sort(),
      issuers,
      originalSource: {
        available: source != null,
        sha256: sourceHash,
        utf8Bytes: source == null ? 0 : Buffer.byteLength(source, 'utf8'),
        metricKind: 'post-loader-source-diagnostic',
        quality: sourceQuality(source),
        artifact,
      },
    };
    if (record.logicalModule && record.category === 'normal' && source == null) {
      dataQuality.push({ type: 'missing-post-loader-source', canonicalKey: record.canonicalKey, rawIdentifier: record.rawIdentifier });
    }
    records.push(record);
  }

  records.sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey) || a.rawIdentifier.localeCompare(b.rawIdentifier));
  const groups = new Map();
  for (const record of records) {
    const list = groups.get(record.canonicalKey) || [];
    list.push(record);
    groups.set(record.canonicalKey, list);
  }
  const collisions = [];
  for (const [canonicalKey, list] of groups) {
    if (list.length <= 1) continue;
    for (const record of list) record.identityStatus = 'collision';
    collisions.push({
      canonicalKey,
      count: list.length,
      logicalModuleCount: list.filter((record) => record.logicalModule).length,
      records: list.map((record) => ({ rawIdentifier: record.rawIdentifier, resource: record.resource, category: record.category })),
    });
    dataQuality.push({ type: 'canonical-key-collision', canonicalKey, count: list.length });
  }

  const logical = records.filter((record) => record.logicalModule);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId,
    variant,
    compiler: {
      id: compilerId,
      name: compiler.name || compiler.options?.name || null,
      context,
      compilationHash: compilation.hash || null,
      rspackVersion: compiler.rspack?.version || compiler.webpack?.version || null,
    },
    scope: {
      kind: 'modules-connected-to-app-js-assets',
      appJsRuleId,
      appJsAssetSelectionSource: appJs.source,
      appJsAssets: appJs.names,
      chunks: [...selectedChunks.values()].sort((a, b) => a.key.localeCompare(b.key)),
    },
    counts: {
      records: records.length,
      logicalModules: logical.length,
      concatenatedContainers: records.filter((record) => !record.logicalModule).length,
      sourceBackedLogicalModules: logical.filter((record) => record.originalSource.available).length,
      canonicalCollisions: collisions.length,
    },
    complete: dataQuality.length === 0,
    collisions,
    dataQuality,
    modules: records,
    metricWarning: 'No stats module.size is recorded. originalSource.utf8Bytes is post-loader diagnostic scope, not minified emitted size or saving.',
  };
}

function safeFilePart(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

class EcmaModuleCapturePlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      const stage = compiler.webpack?.Compilation?.PROCESS_ASSETS_STAGE_REPORT ?? 5000;
      compilation.hooks.processAssets.tap({ name: PLUGIN_NAME, stage }, () => {
        const runId = this.options.runId || process.env.RSPACK_AUDIT_RUN_ID;
        const variant = this.options.variant || process.env.RSPACK_ECMA_VARIANT;
        const compilerId = this.options.compilerId || compiler.name || compiler.options?.name || 'default';
        const defaultFile = `module-inventory-${safeFilePart(variant)}.${safeFilePart(compilerId)}.json`;
        const outFile = resolve(compiler.context || process.cwd(), this.options.outFile || `./tmp/rspack-ecma/${defaultFile}`);
        const sourceDir = resolve(dirname(outFile), this.options.sourceDir || `${defaultFile.replace(/\.json$/i, '')}-sources`);
        mkdirSync(sourceDir, { recursive: true });
        const sink = ({ source, sha256: hash }) => {
          const file = resolve(sourceDir, `${hash}.txt`);
          if (!existsSync(file)) writeFileSync(file, source, 'utf8');
          return slash(relative(dirname(outFile), file));
        };
        const inventory = captureInventory(compilation, compiler, { ...this.options, runId, variant, compilerId }, sink);
        mkdirSync(dirname(outFile), { recursive: true });
        writeFileSync(outFile, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
        console.log(`[${PLUGIN_NAME}] logicalModules=${inventory.counts.logicalModules} collisions=${inventory.counts.canonicalCollisions} issues=${inventory.dataQuality.length}`);
        console.log(`[${PLUGIN_NAME}] wrote ${outFile}`);
      });
    });
  }
}

function selfTest() {
  const makeModule = (resource, identifier, source, layer = null) => ({
    resource,
    type: 'javascript/auto',
    layer,
    identifier: () => identifier,
    nameForCondition: () => resource,
    originalSource: () => source == null ? null : { source: () => source },
  });
  const a = makeModule('/repo/src/a.js?raw', 'loader-a!/repo/src/a.js?raw', 'export const pi = "π";');
  const b = makeModule('/repo/src/a.js?worker', 'loader-b!/repo/src/a.js?worker', 'export default 1;');
  const c = makeModule('/repo/src/c.js', 'loader-a!/repo/src/c.js', 'export const c = 1;');
  const d = makeModule('/repo/src/c.js', 'loader-b!/repo/src/c.js', 'export const c = 2;');
  const container = {
    type: 'javascript/esm',
    modules: [a],
    identifier: () => 'concatenated|/repo/src/a.js?raw',
    nameForCondition: () => '/repo/src/a.js?raw',
    originalSource: () => null,
  };
  const chunk = { id: 'main', name: 'main', files: new Set(['main.js']) };
  const modules = [container, b, c, d];
  const compilation = {
    hash: 'test-hash',
    chunks: [chunk],
    entrypoints: new Map([['main', { chunks: [chunk] }]]),
    getAssets: () => [{ name: 'main.js', info: {} }],
    chunkGraph: {
      getChunkModulesIterable: () => modules,
      getChunkEntryModulesIterable: () => [a],
    },
    moduleGraph: {
      getIncomingConnections: (module) => module === b ? [{ originModule: a }] : [],
      getIssuer: () => null,
    },
  };
  const compiler = { context: '/repo', name: 'web', rspack: { version: 'test' } };
  const inventory = captureInventory(compilation, compiler, {
    runId: 'run-test',
    variant: 'baseline',
    compilerId: 'web',
    appJsRuleId: 'test-js-v1',
    appJsAssets: ['main.js'],
  }, ({ sha256: hash }) => `sources/${hash}.txt`);
  const aRecord = inventory.modules.find((record) => record.resource?.endsWith('a.js?raw'));
  const bRecord = inventory.modules.find((record) => record.resource?.endsWith('a.js?worker'));
  if (!aRecord || !bRecord || aRecord.canonicalKey === bRecord.canonicalKey) throw new Error('query/fragment identity self-test failed');
  if (aRecord.originalSource.utf8Bytes !== Buffer.byteLength('export const pi = "π";', 'utf8')) throw new Error('UTF-8 byte self-test failed');
  if (bRecord.issuers.length !== 1 || bRecord.issuers[0].canonicalKey !== aRecord.canonicalKey) throw new Error('issuer self-test failed');
  if (inventory.collisions.length !== 1 || inventory.collisions[0].logicalModuleCount !== 2) throw new Error('collision self-test failed');
  if (inventory.counts.concatenatedContainers !== 1 || inventory.modules.find((record) => record.category === 'concatenated-container')?.canonicalKey === aRecord.canonicalKey) throw new Error('concatenated-container identity self-test failed');
  console.log('ecma-module-capture-plugin self-test passed');
}

if (require.main === module && process.argv.includes('--self-test')) {
  selfTest();
}

module.exports = {
  EcmaModuleCapturePlugin,
  canonicalIdentity,
  captureInventory,
  extractAssetNames,
  normalizeIdentifier,
  normalizeResource,
  sourceQuality,
  splitResourceSuffix,
};
