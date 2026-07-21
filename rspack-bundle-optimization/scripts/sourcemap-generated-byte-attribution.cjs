#!/usr/bin/env node
// Attribute actual generated JavaScript bytes to original sources using emitted
// source maps, then compare baseline and experiment outputs.

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('fs');
const { createHash } = require('crypto');
const { gzipSync } = require('zlib');
const { tmpdir } = require('os');
const { dirname, extname, isAbsolute, join, relative, resolve } = require('path');
const { fileURLToPath } = require('url');

const GZIP_OPTIONS = Object.freeze({ level: 9 });

function gzipSize(value) {
  return gzipSync(value, GZIP_OPTIONS).length;
}

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

function pathIsWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('../') && !isAbsolute(rel));
}

function parseSemver(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareSemverDescending(a, b) {
  const av = parseSemver(a.version);
  const bv = parseSemver(b.version);
  if (!av || !bv) return av ? -1 : bv ? 1 : a.version.localeCompare(b.version);
  for (const key of ['major', 'minor', 'patch']) {
    if (av[key] !== bv[key]) return bv[key] - av[key];
  }
  if (av.prerelease.length === 0 && bv.prerelease.length > 0) return -1;
  if (bv.prerelease.length === 0 && av.prerelease.length > 0) return 1;
  const length = Math.max(av.prerelease.length, bv.prerelease.length);
  for (let index = 0; index < length; index++) {
    const ai = av.prerelease[index];
    const bi = bv.prerelease[index];
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    if (ai === bi) continue;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) return Number(bi) - Number(ai);
    if (an !== bn) return an ? 1 : -1;
    return bi.localeCompare(ai);
  }
  return a.packageRoot.localeCompare(b.packageRoot);
}

function findPackageMetadata(entryPath, nodeModulesRoot) {
  let current = dirname(entryPath);
  while (pathIsWithin(nodeModulesRoot, current)) {
    const packageJsonPath = resolve(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const realPackageJsonPath = realpathSync(packageJsonPath);
        if (!pathIsWithin(current, realPackageJsonPath)) throw new Error('package.json escapes package root');
        const pkg = JSON.parse(readFileSync(realPackageJsonPath, 'utf8'));
        if (pkg.name === '@jridgewell/trace-mapping') {
          return { packageRoot: current, packageJsonPath: realPackageJsonPath, version: String(pkg.version || 'unknown') };
        }
      } catch {}
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveTraceMapping(projectRoot) {
  const normalizedProjectRoot = realpathSync(resolve(projectRoot));
  const nodeModulesRoot = resolve(normalizedProjectRoot, 'node_modules');
  let nodeResolveError = null;
  let isolatedResolveError = null;
  try {
    const entry = realpathSync(require.resolve('@jridgewell/trace-mapping', { paths: [normalizedProjectRoot] }));
    const realNodeModulesRoot = realpathSync(nodeModulesRoot);
    if (!pathIsWithin(realNodeModulesRoot, entry)) {
      throw new Error(`resolved outside project node_modules: ${entry}`);
    }
    const metadata = findPackageMetadata(entry, realNodeModulesRoot);
    if (!metadata) throw new Error(`could not find @jridgewell/trace-mapping package.json for ${entry}`);
    return {
      traceMapping: require(entry),
      resolution: {
        package: '@jridgewell/trace-mapping',
        method: 'node-project-local',
        version: metadata.version,
        resolvedPath: entry,
        packageRoot: metadata.packageRoot,
        selectionRule: 'Node require.resolve from projectRoot, accepted only when the real path stays inside projectRoot/node_modules',
        candidates: [{ version: metadata.version, packageRoot: metadata.packageRoot, resolvedPath: entry }],
      },
    };
  } catch (error) {
    nodeResolveError = error;
  }

  if (process.env.RSPACK_AUDIT_TOOL_ROOT) {
    try {
      const isolatedToolRoot = realpathSync(resolve(process.env.RSPACK_AUDIT_TOOL_ROOT));
      const isolatedNodeModulesRoot = realpathSync(resolve(isolatedToolRoot, 'node_modules'));
      const entry = realpathSync(require.resolve('@jridgewell/trace-mapping', { paths: [isolatedToolRoot] }));
      if (!pathIsWithin(isolatedNodeModulesRoot, entry)) {
        throw new Error(`resolved outside isolated audit node_modules: ${entry}`);
      }
      const metadata = findPackageMetadata(entry, isolatedNodeModulesRoot);
      if (!metadata) throw new Error(`could not find isolated @jridgewell/trace-mapping package.json for ${entry}`);
      return {
        traceMapping: require(entry),
        resolution: {
          package: '@jridgewell/trace-mapping',
          method: 'isolated-audit-tool',
          version: metadata.version,
          resolvedPath: entry,
          packageRoot: metadata.packageRoot,
          selectionRule: 'Isolated run-local tool selected only after project-local Node resolution failed',
          candidates: [{ version: metadata.version, packageRoot: metadata.packageRoot, resolvedPath: entry }],
          nodeResolveError: nodeResolveError.message,
        },
      };
    } catch (error) {
      isolatedResolveError = error;
    }
  }

  const pnpmRoot = resolve(nodeModulesRoot, '.pnpm');
  const candidates = [];
  try {
    const realPnpmRoot = realpathSync(pnpmRoot);
    for (const entry of readdirSync(realPnpmRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('@jridgewell+trace-mapping@')) continue;
      const packageRoot = resolve(realPnpmRoot, entry.name, 'node_modules/@jridgewell/trace-mapping');
      const packageJsonPath = resolve(packageRoot, 'package.json');
      if (!existsSync(packageJsonPath)) continue;
      const realPackageRoot = realpathSync(packageRoot);
      if (!pathIsWithin(realPnpmRoot, realPackageRoot)) continue;
      let pkg;
      try {
        const realPackageJsonPath = realpathSync(packageJsonPath);
        if (!pathIsWithin(realPackageRoot, realPackageJsonPath)) continue;
        pkg = JSON.parse(readFileSync(realPackageJsonPath, 'utf8'));
      } catch { continue; }
      if (pkg.name !== '@jridgewell/trace-mapping' || !parseSemver(pkg.version)) continue;
      let resolvedPath;
      try { resolvedPath = realpathSync(require.resolve(realPackageRoot)); } catch { continue; }
      if (!pathIsWithin(realPackageRoot, resolvedPath) || !pathIsWithin(realPnpmRoot, resolvedPath)) continue;
      candidates.push({ version: String(pkg.version), packageRoot: realPackageRoot, resolvedPath });
    }
  } catch (error) {
    throw new Error(`sourcemap attribution requires project-local or isolated @jridgewell/trace-mapping; Node resolution failed: ${nodeResolveError.message}; isolated resolution failed: ${isolatedResolveError?.message || 'not configured'}; pnpm fallback failed: ${error.message}`);
  }
  candidates.sort(compareSemverDescending);
  if (candidates.length === 0) {
    throw new Error(`sourcemap attribution requires project-local or isolated @jridgewell/trace-mapping; Node resolution failed: ${nodeResolveError.message}; isolated resolution failed: ${isolatedResolveError?.message || 'not configured'}; no valid installed package found under ${pnpmRoot}`);
  }
  const selected = candidates[0];
  return {
    traceMapping: require(selected.resolvedPath),
    resolution: {
      package: '@jridgewell/trace-mapping',
      method: 'pnpm-store-fallback',
      version: selected.version,
      resolvedPath: selected.resolvedPath,
      packageRoot: selected.packageRoot,
      selectionRule: 'Highest valid semantic version installed under projectRoot/node_modules/.pnpm; packageRoot lexical order breaks an exact-version tie',
      candidates,
      nodeResolveError: nodeResolveError.message,
    },
  };
}

function normalizeAssetName(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeReviewedUnmappedManifest(value, { manifestPath = null, side } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('reviewed-unmapped manifest must be a JSON object');
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`reviewed-unmapped manifest schemaVersion must be 1, got ${JSON.stringify(value.schemaVersion)}`);
  }
  if (value.kind !== 'reviewed-unmapped-app-js') {
    throw new Error(`reviewed-unmapped manifest kind must be "reviewed-unmapped-app-js", got ${JSON.stringify(value.kind)}`);
  }
  if (!['baseline', 'experiment'].includes(side)) {
    throw new Error(`reviewed-unmapped manifest loader requires side baseline or experiment, got ${JSON.stringify(side)}`);
  }
  if (value.side !== side) {
    throw new Error(`reviewed-unmapped manifest side must be ${side}, got ${JSON.stringify(value.side)}`);
  }
  const reviewer = typeof value.reviewer === 'string' ? value.reviewer.trim() : '';
  if (!reviewer) throw new Error('reviewed-unmapped manifest reviewer must be a non-empty string');
  const reviewedAt = typeof value.reviewedAt === 'string' ? value.reviewedAt.trim() : '';
  if (!reviewedAt || !Number.isFinite(Date.parse(reviewedAt))) {
    throw new Error('reviewed-unmapped manifest reviewedAt must be a valid date-time string');
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    throw new Error('reviewed-unmapped manifest assets must be a non-empty array');
  }
  const seen = new Set();
  const assets = value.assets.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`reviewed-unmapped manifest assets[${index}] must be an object`);
    }
    if (typeof item.asset !== 'string' || !item.asset.trim()) {
      throw new Error(`reviewed-unmapped manifest assets[${index}].asset must be a non-empty string`);
    }
    const asset = normalizeAssetName(item.asset.trim());
    if (!asset || isAbsolute(asset) || asset.split('/').includes('..')) {
      throw new Error(`reviewed-unmapped manifest asset must stay inside the output directory: ${item.asset}`);
    }
    if (asset !== item.asset.trim().replace(/\\/g, '/')) {
      throw new Error(`reviewed-unmapped manifest asset must use normalized output-relative form: ${item.asset}`);
    }
    if (seen.has(asset)) throw new Error(`reviewed-unmapped manifest contains duplicate asset: ${asset}`);
    seen.add(asset);
    if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) {
      throw new Error(`reviewed-unmapped manifest ${asset} sha256 must be 64 lowercase hex characters`);
    }
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    if (!reason) throw new Error(`reviewed-unmapped manifest ${asset} reason must be a non-empty string`);
    if (item.rawBytes !== undefined && (!Number.isSafeInteger(item.rawBytes) || item.rawBytes < 0)) {
      throw new Error(`reviewed-unmapped manifest ${asset} rawBytes must be a non-negative safe integer when provided`);
    }
    return {
      asset,
      sha256: item.sha256,
      reason,
      ...(item.rawBytes === undefined ? {} : { rawBytes: item.rawBytes }),
    };
  });
  return {
    schemaVersion: 1,
    kind: value.kind,
    side,
    reviewer,
    reviewedAt,
    manifestPath,
    manifestSha256: value.manifestSha256 || null,
    assets,
  };
}

function loadReviewedUnmappedManifest(manifestPath, side) {
  if (!manifestPath) return null;
  const absolutePath = resolve(manifestPath);
  const bytes = readFileSync(absolutePath);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid reviewed-unmapped manifest JSON at ${absolutePath}: ${error.message}`);
  }
  const manifest = normalizeReviewedUnmappedManifest(value, { manifestPath: absolutePath, side });
  manifest.manifestSha256 = sha256(bytes);
  return manifest;
}

function extractAssetNames(value) {
  const candidates = Array.isArray(value)
    ? value
    : value?.appJsAssets ?? value?.assets ?? value?.includedAssets ?? value?.appJs?.assets ?? value?.scope?.appJsAssets;
  if (!Array.isArray(candidates)) {
    throw new Error('asset manifest must be an array or contain appJsAssets/assets/includedAssets/appJs.assets/scope.appJsAssets');
  }
  const names = candidates
    .map((item) => typeof item === 'string' ? item : item?.name ?? item?.asset)
    .filter(Boolean)
    .map(normalizeAssetName);
  if (names.length !== candidates.length) throw new Error('asset manifest contains an entry without a string name/asset');
  return [...new Set(names)].sort();
}

function extractAssetManifest(value, { manifestPath = null } = {}) {
  const assetNames = extractAssetNames(value);
  const rawCompilerContext = Array.isArray(value) ? null : value?.compiler?.context;
  let compilerContext = null;
  if (rawCompilerContext !== undefined && rawCompilerContext !== null) {
    if (typeof rawCompilerContext !== 'string' || !rawCompilerContext.trim()) {
      throw new Error('asset manifest compiler.context must be a non-empty absolute path when provided');
    }
    if (!isAbsolute(rawCompilerContext)) {
      throw new Error(`asset manifest compiler.context must be absolute: ${rawCompilerContext}`);
    }
    compilerContext = resolve(rawCompilerContext);
  }
  return {
    assetNames,
    compilerContext,
    manifestPath,
  };
}

function loadAssetManifest(manifestPath) {
  const absolutePath = resolve(manifestPath);
  let value;
  try {
    value = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`invalid asset manifest JSON at ${absolutePath}: ${error.message}`);
  }
  return extractAssetManifest(value, { manifestPath: absolutePath });
}

function walkJsFiles(root, include, exclude, assetNames) {
  const result = [];
  if (assetNames) {
    for (const name of assetNames) {
      const normalized = normalizeAssetName(name);
      const file = resolve(root, normalized);
      const rel = relative(root, file).replace(/\\/g, '/');
      if (rel.startsWith('../') || isAbsolute(rel)) throw new Error(`Asset escapes output directory: ${name}`);
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Missing selected JavaScript asset: ${file}`);
      if (!['.js', '.mjs', '.cjs'].includes(extname(file))) throw new Error(`Selected appJs asset is not JavaScript: ${name}`);
      if ((!include || include.test(rel)) && (!exclude || !exclude.test(rel))) result.push(file);
    }
    return [...new Set(result)].sort();
  }
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && ['.js', '.mjs', '.cjs'].includes(extname(entry.name))) {
        const rel = relative(root, file).replace(/\\/g, '/');
        if ((!include || include.test(rel)) && (!exclude || !exclude.test(rel))) result.push(file);
      }
    }
  };
  visit(root);
  return result.sort();
}

function extractSourceMappingUrls(code) {
  return [...code.matchAll(/[#@]\s*sourceMappingURL=([^\s*]+)\s*/g)].map((match) => match[1]);
}

function parseSourceMap(code, asset) {
  const adjacent = `${asset}.map`;
  if (existsSync(adjacent)) return { map: JSON.parse(readFileSync(adjacent, 'utf8')), mapPath: adjacent };
  const urls = extractSourceMappingUrls(code);
  if (urls.length === 0) return null;
  const url = urls[urls.length - 1];
  if (/^data:application\/json[^,]*,/.test(url)) {
    const [meta, body] = url.split(',', 2);
    const text = /;base64/i.test(meta) ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
    return { map: JSON.parse(text), mapPath: `${asset}#inline` };
  }
  const mapPath = resolve(dirname(asset), decodeURIComponent(url.split(/[?#]/)[0]));
  if (!existsSync(mapPath)) return null;
  return { map: JSON.parse(readFileSync(mapPath, 'utf8')), mapPath };
}

function normalizeSource(source, projectRoot) {
  if (!source) return '<unmapped>';
  let value = String(source).replace(/\\/g, '/').replace(/^file:\/\//, '');
  value = value.replace(/^webpack:\/\/\/?/, '');
  value = value.replace(/^rspack:\/\/\/?/, '');
  const query = value.indexOf('?');
  const fragment = value.indexOf('#');
  const indexes = [query, fragment].filter((index) => index >= 0);
  const splitAt = indexes.length ? Math.min(...indexes) : value.length;
  const path = value.slice(0, splitAt);
  const suffix = value.slice(splitAt);
  if (isAbsolute(path)) {
    const rel = relative(projectRoot, path).replace(/\\/g, '/');
    if (!rel.startsWith('../') && !isAbsolute(rel)) return `${rel || '.'}${suffix}`;
  }
  return `${path.replace(/^\.\//, '')}${suffix}`;
}

function splitSourceSuffix(source) {
  const value = String(source || '').replace(/\\/g, '/');
  const query = value.indexOf('?');
  const fragment = value.indexOf('#');
  const indexes = [query, fragment].filter((index) => index >= 0);
  const splitAt = indexes.length ? Math.min(...indexes) : value.length;
  return { path: value.slice(0, splitAt), suffix: value.slice(splitAt) };
}

function decodeSourcePath(value) {
  try {
    return { value: decodeURIComponent(value), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function verifiedAbsoluteSourceCandidate(rawSource, compilerContext) {
  if (typeof rawSource !== 'string' || !rawSource) {
    return { candidate: null, reason: 'raw source is empty' };
  }
  const { path: rawPath, suffix } = splitSourceSuffix(rawSource);
  let candidatePath = null;
  let provenance = null;

  if (/^file:\/\//i.test(rawPath)) {
    try {
      candidatePath = fileURLToPath(rawPath);
      provenance = 'raw-file-url';
    } catch (error) {
      return { candidate: null, reason: `invalid file URL: ${error.message}` };
    }
  } else if (isAbsolute(rawPath)) {
    const decoded = decodeSourcePath(rawPath);
    if (decoded.error) return { candidate: null, reason: `invalid percent encoding: ${decoded.error}` };
    candidatePath = decoded.value;
    provenance = 'raw-absolute-path';
  } else {
    const bundlerUrl = rawPath.match(/^(webpack|rspack):\/\/([^/]*)(\/.*)?$/i);
    if (!bundlerUrl) {
      return { candidate: null, reason: 'raw source is neither an absolute path, file URL, nor webpack/rspack URL' };
    }
    const sourcePath = (bundlerUrl[3] || '').replace(/^\//, '');
    if (!/^\.\.?\//.test(sourcePath)) {
      return { candidate: null, reason: 'webpack/rspack URL path is not explicitly relative (./ or ../)' };
    }
    if (!compilerContext) {
      return { candidate: null, reason: 'compiler.context is unavailable' };
    }
    const decoded = decodeSourcePath(sourcePath);
    if (decoded.error) return { candidate: null, reason: `invalid percent encoding: ${decoded.error}` };
    candidatePath = resolve(compilerContext, decoded.value);
    provenance = 'raw-bundler-url-relative-to-compiler-context';
  }

  let filesystemVerified = false;
  try {
    filesystemVerified = existsSync(candidatePath) && statSync(candidatePath).isFile();
  } catch {}
  if (!filesystemVerified) {
    return { candidate: null, reason: `resolved filesystem path is not an existing file: ${candidatePath}` };
  }
  return {
    candidate: {
      kind: 'absolute-path',
      value: `${candidatePath.replace(/\\/g, '/')}${suffix}`,
      provenance,
      rawSource,
      compilerContext: compilerContext || null,
      filesystemVerified: true,
    },
    reason: null,
  };
}

function createTraceSourceIdentityIndex(trace, { compilerContext = null, asset = null, dataQuality = [] } = {}) {
  const rawSources = Array.isArray(trace.sources) ? trace.sources : [];
  const resolvedSources = Array.isArray(trace.resolvedSources) ? trace.resolvedSources : [];
  if (rawSources.length !== resolvedSources.length) {
    dataQuality.push({
      type: 'source-map-source-array-length-mismatch',
      asset,
      rawSourceCount: rawSources.length,
      resolvedSourceCount: resolvedSources.length,
    });
  }
  const pairsByResolved = new Map();
  const length = Math.max(rawSources.length, resolvedSources.length);
  for (let index = 0; index < length; index++) {
    const rawSource = rawSources[index] == null ? null : String(rawSources[index]);
    const resolvedSource = resolvedSources[index] == null
      ? rawSource
      : String(resolvedSources[index]);
    if (!resolvedSource) continue;
    const pairs = pairsByResolved.get(resolvedSource) || [];
    pairs.push({ rawSource, resolvedSource });
    pairsByResolved.set(resolvedSource, pairs);
  }

  const identities = new Map();
  for (const [resolvedSource, pairs] of pairsByResolved) {
    const uniqueRawSources = [...new Set(pairs.map((pair) => pair.rawSource).filter(Boolean))].sort();
    const candidateRecords = [];
    const unresolvedReasons = [];
    for (const rawSource of uniqueRawSources) {
      const result = verifiedAbsoluteSourceCandidate(rawSource, compilerContext);
      if (result.candidate) {
        candidateRecords.push({ ...result.candidate, resolvedSource });
      } else {
        unresolvedReasons.push({ rawSource, resolvedSource, reason: result.reason });
      }
    }
    const candidateByValue = new Map();
    for (const candidate of candidateRecords) {
      const key = `${candidate.kind}\0${candidate.value}`;
      if (!candidateByValue.has(key)) candidateByValue.set(key, candidate);
    }
    const canonicalCandidates = [...candidateByValue.values()].sort((a, b) => a.value.localeCompare(b.value));
    let status = 'unresolved';
    if (uniqueRawSources.length > 1 || canonicalCandidates.length > 1) status = 'ambiguous';
    else if (uniqueRawSources.length === 1 && canonicalCandidates.length === 1 && unresolvedReasons.length === 0) status = 'canonical';
    if (status === 'ambiguous') {
      dataQuality.push({
        type: 'ambiguous-resolved-source-identity',
        asset,
        resolvedSource,
        rawSources: uniqueRawSources,
        canonicalCandidates: canonicalCandidates.map((candidate) => candidate.value),
      });
    }
    identities.set(resolvedSource, {
      status,
      rawSources: uniqueRawSources,
      resolvedSources: [resolvedSource],
      canonicalCandidates,
      unresolvedReasons,
    });
  }
  return identities;
}

function unresolvedMappingIdentity(resolvedSource) {
  return {
    status: 'unresolved',
    rawSources: [],
    resolvedSources: resolvedSource ? [resolvedSource] : [],
    canonicalCandidates: [],
    unresolvedReasons: [{
      rawSource: null,
      resolvedSource: resolvedSource || null,
      reason: 'mapping source is absent from TraceMap sources/resolvedSources',
    }],
  };
}

function mergeSourceIdentityEvidence(target, source, identity, asset) {
  if (!source || source === '<unmapped>') return;
  const entry = target.get(source) || {
    statuses: new Set(),
    rawSources: new Set(),
    resolvedSources: new Set(),
    canonicalCandidates: new Map(),
    unresolvedReasons: new Map(),
    assets: new Set(),
  };
  entry.statuses.add(identity.status);
  for (const value of identity.rawSources || []) entry.rawSources.add(value);
  for (const value of identity.resolvedSources || []) entry.resolvedSources.add(value);
  for (const candidate of identity.canonicalCandidates || []) {
    const key = `${candidate.kind}\0${candidate.value}`;
    if (!entry.canonicalCandidates.has(key)) entry.canonicalCandidates.set(key, candidate);
  }
  for (const reason of identity.unresolvedReasons || []) {
    const key = JSON.stringify(reason);
    if (!entry.unresolvedReasons.has(key)) entry.unresolvedReasons.set(key, reason);
  }
  if (asset) entry.assets.add(asset);
  target.set(source, entry);
}

function finalizeSourceIdentities(evidence, dataQuality) {
  const result = {};
  for (const [source, entry] of [...evidence.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rawSources = [...entry.rawSources].sort();
    const resolvedSources = [...entry.resolvedSources].sort();
    const canonicalCandidates = [...entry.canonicalCandidates.values()].sort((a, b) => a.value.localeCompare(b.value));
    const statuses = [...entry.statuses].sort();
    const hasConflictingEvidence = statuses.includes('ambiguous')
      || statuses.length > 1
      || rawSources.length > 1
      || resolvedSources.length > 1
      || canonicalCandidates.length > 1;
    const status = hasConflictingEvidence
      ? 'ambiguous'
      : statuses.length === 1 && statuses[0] === 'canonical' && canonicalCandidates.length === 1
        ? 'canonical'
        : 'unresolved';
    if (status === 'ambiguous' && !statuses.includes('ambiguous')) {
      dataQuality.push({
        type: 'ambiguous-aggregated-source-identity',
        source,
        assets: [...entry.assets].sort(),
        rawSources,
        resolvedSources,
        canonicalCandidates: canonicalCandidates.map((candidate) => candidate.value),
        evidenceStatuses: statuses,
      });
    }
    result[source] = {
      status,
      rawSources,
      resolvedSources,
      canonicalCandidates,
      unresolvedReasons: [...entry.unresolvedReasons.values()],
      assets: [...entry.assets].sort(),
    };
  }
  return result;
}

function splitGeneratedLines(code) {
  const lines = [];
  let start = 0;
  while (start < code.length) {
    const newline = code.indexOf('\n', start);
    if (newline === -1) { lines.push({ text: code.slice(start), newline: '' }); break; }
    lines.push({ text: code.slice(start, newline), newline: '\n' });
    start = newline + 1;
  }
  return lines;
}

function addBytes(target, source, bytes) {
  if (bytes <= 0) return;
  target.set(source, (target.get(source) || 0) + bytes);
}

function attributeCode(code, mappings, projectRoot) {
  const byLine = new Map();
  for (const mapping of mappings) {
    const line = Number(mapping.generatedLine || 0);
    if (line <= 0) continue;
    const list = byLine.get(line) || [];
    list.push({
      column: Number(mapping.generatedColumn || 0),
      source: mapping.attributionSource || normalizeSource(mapping.source, projectRoot),
    });
    byLine.set(line, list);
  }
  const attributed = new Map();
  const lines = splitGeneratedLines(code);
  lines.forEach((line, index) => {
    const rawPoints = (byLine.get(index + 1) || []).sort((a, b) => a.column - b.column);
    const points = [];
    for (const point of rawPoints) {
      const column = Math.max(0, Math.min(line.text.length, point.column));
      if (points.length && points[points.length - 1].column === column) points[points.length - 1] = { ...point, column };
      else points.push({ ...point, column });
    }
    let cursor = 0;
    let lastSource = '<unmapped>';
    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
      const point = points[pointIndex];
      if (point.column > cursor) addBytes(attributed, lastSource, Buffer.byteLength(line.text.slice(cursor, point.column)));
      const nextColumn = points[pointIndex + 1]?.column ?? line.text.length;
      lastSource = point.source || '<unmapped>';
      addBytes(attributed, lastSource, Buffer.byteLength(line.text.slice(point.column, nextColumn)));
      cursor = nextColumn;
    }
    if (points.length === 0) addBytes(attributed, '<unmapped>', Buffer.byteLength(line.text));
    else if (cursor < line.text.length) addBytes(attributed, lastSource, Buffer.byteLength(line.text.slice(cursor)));
    addBytes(attributed, lastSource, Buffer.byteLength(line.newline));
  });
  return attributed;
}

function analyzeDirectory({
  directory,
  projectRoot,
  traceMapping,
  include,
  exclude,
  assetNames,
  compilerContext = null,
  assetManifestPath = null,
  reviewedUnmappedManifest = null,
}) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`Missing output directory: ${directory}`);
  const { TraceMap, eachMapping } = traceMapping;
  const sources = new Map();
  const sourceIdentityEvidence = new Map();
  const assets = [];
  const dataQuality = [];
  const selectedAssets = walkJsFiles(directory, include, exclude, assetNames);
  const selectedAssetNames = new Set(selectedAssets.map((asset) => relative(directory, asset).replace(/\\/g, '/')));
  const reviewedByAsset = new Map((reviewedUnmappedManifest?.assets || []).map((item) => [item.asset, item]));
  for (const reviewedAsset of reviewedByAsset.keys()) {
    if (!selectedAssetNames.has(reviewedAsset)) {
      throw new Error(`reviewed-unmapped manifest contains an asset outside the selected appJs scope or missing from output: ${reviewedAsset}`);
    }
  }
  const consumedReviewedAssets = new Set();
  const reviewedUnmappedAssets = [];
  for (const asset of selectedAssets) {
    const assetName = relative(directory, asset).replace(/\\/g, '/');
    const codeBytes = readFileSync(asset);
    const code = codeBytes.toString('utf8');
    const actualSha256 = sha256(codeBytes);
    const reviewed = reviewedByAsset.get(assetName) || null;
    if (reviewed && reviewed.sha256 !== actualSha256) {
      throw new Error(`reviewed-unmapped manifest hash mismatch for ${assetName}: expected ${reviewed.sha256}, actual ${actualSha256}`);
    }
    if (reviewed && reviewed.rawBytes !== undefined && reviewed.rawBytes !== codeBytes.length) {
      throw new Error(`reviewed-unmapped manifest rawBytes mismatch for ${assetName}: expected ${reviewed.rawBytes}, actual ${codeBytes.length}`);
    }
    const sourceMappingUrls = extractSourceMappingUrls(code);
    const mapRecord = parseSourceMap(code, asset);
    let attributed;
    if (!mapRecord) {
      attributed = new Map([['<unmapped>', codeBytes.length]]);
      if (reviewed) {
        if (sourceMappingUrls.length > 0) {
          throw new Error(`reviewed-unmapped manifest cannot excuse a missing referenced source map for ${assetName}: ${sourceMappingUrls[sourceMappingUrls.length - 1]}`);
        }
        consumedReviewedAssets.add(assetName);
        reviewedUnmappedAssets.push({
          asset: assetName,
          sha256: actualSha256,
          rawBytes: codeBytes.length,
          gzipBytes: gzipSize(codeBytes),
          reason: reviewed.reason,
          reviewer: reviewedUnmappedManifest.reviewer,
          reviewedAt: reviewedUnmappedManifest.reviewedAt,
        });
      } else {
        dataQuality.push({
          type: sourceMappingUrls.length > 0 ? 'missing-referenced-source-map' : 'missing-source-map',
          asset: assetName,
          sha256: actualSha256,
          rawBytes: codeBytes.length,
          sourceMappingUrl: sourceMappingUrls[sourceMappingUrls.length - 1] || null,
        });
      }
    } else {
      if (reviewed) {
        throw new Error(`reviewed-unmapped manifest entry is stale because a source map exists for ${assetName}: ${mapRecord.mapPath}`);
      }
      try {
        const trace = new TraceMap(mapRecord.map, mapRecord.mapPath);
        const identityIndex = createTraceSourceIdentityIndex(trace, {
          compilerContext,
          asset: assetName,
          dataQuality,
        });
        const mappings = [];
        const pendingIdentities = [];
        const seenIdentityEvidence = new Set();
        const missingMappingSources = new Set();
        eachMapping(trace, (mapping) => {
          const resolvedSource = mapping.source == null ? null : String(mapping.source);
          const attributionSource = normalizeSource(resolvedSource, projectRoot);
          mappings.push({ ...mapping, attributionSource });
          if (!resolvedSource) return;
          const identity = identityIndex.get(resolvedSource) || unresolvedMappingIdentity(resolvedSource);
          if (!identityIndex.has(resolvedSource) && !missingMappingSources.has(resolvedSource)) {
            missingMappingSources.add(resolvedSource);
            dataQuality.push({
              type: 'mapping-source-missing-from-trace-source-index',
              asset: assetName,
              resolvedSource,
            });
          }
          const evidenceKey = `${attributionSource}\0${resolvedSource}`;
          if (!seenIdentityEvidence.has(evidenceKey)) {
            seenIdentityEvidence.add(evidenceKey);
            pendingIdentities.push({ attributionSource, identity });
          }
        });
        attributed = attributeCode(code, mappings, projectRoot);
        for (const { attributionSource, identity } of pendingIdentities) {
          mergeSourceIdentityEvidence(sourceIdentityEvidence, attributionSource, identity, assetName);
        }
      } catch (error) {
        attributed = new Map([['<unmapped>', codeBytes.length]]);
        dataQuality.push({ type: 'invalid-source-map', asset: relative(directory, asset), error: error.message });
      }
    }
    const rawBytes = codeBytes.length;
    const attributedBytes = [...attributed.values()].reduce((sum, value) => sum + value, 0);
    if (attributedBytes !== rawBytes) dataQuality.push({ type: 'attribution-byte-mismatch', asset: assetName, rawBytes, attributedBytes });
    for (const [source, bytes] of attributed) addBytes(sources, source, bytes);
    assets.push({
      asset: assetName,
      sha256: actualSha256,
      rawBytes,
      gzipBytes: gzipSize(codeBytes),
      sourceMap: mapRecord?.mapPath || null,
      sourceMapStatus: mapRecord ? 'present' : reviewed ? 'reviewed-unmapped' : 'missing',
      mappedBytes: rawBytes - (attributed.get('<unmapped>') || 0),
      unmappedBytes: attributed.get('<unmapped>') || 0,
      reviewedUnmapped: reviewed ? {
        reason: reviewed.reason,
        reviewer: reviewedUnmappedManifest.reviewer,
        reviewedAt: reviewedUnmappedManifest.reviewedAt,
      } : null,
    });
  }
  for (const reviewedAsset of reviewedByAsset.keys()) {
    if (!consumedReviewedAssets.has(reviewedAsset)) {
      throw new Error(`reviewed-unmapped manifest entry was not consumed as a missing-source-map asset: ${reviewedAsset}`);
    }
  }
  const reviewedUnmappedRawBytes = reviewedUnmappedAssets.reduce((sum, asset) => sum + asset.rawBytes, 0);
  const reviewedUnmappedGzipBytes = reviewedUnmappedAssets.reduce((sum, asset) => sum + asset.gzipBytes, 0);
  const totalUnmappedBytes = sources.get('<unmapped>') || 0;
  const sourceIdentities = finalizeSourceIdentities(sourceIdentityEvidence, dataQuality);
  return {
    directory,
    assetSelection: {
      kind: assetNames ? 'explicit-app-js-manifest' : 'recursive-js-scan',
      manifestPath: assetManifestPath,
      compilerContext,
      assets: assets.map((asset) => asset.asset),
    },
    rawBytes: assets.reduce((sum, asset) => sum + asset.rawBytes, 0),
    gzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    mappedBytes: [...sources.entries()].filter(([source]) => source !== '<unmapped>').reduce((sum, [, bytes]) => sum + bytes, 0),
    unmappedBytes: totalUnmappedBytes,
    reviewedUnmapped: {
      status: reviewedUnmappedManifest ? 'provided-and-validated' : 'not-provided',
      manifestPath: reviewedUnmappedManifest?.manifestPath || null,
      manifestSha256: reviewedUnmappedManifest?.manifestSha256 || null,
      side: reviewedUnmappedManifest?.side || null,
      reviewer: reviewedUnmappedManifest?.reviewer || null,
      reviewedAt: reviewedUnmappedManifest?.reviewedAt || null,
      assetCount: reviewedUnmappedAssets.length,
      rawBytes: reviewedUnmappedRawBytes,
      gzipBytes: reviewedUnmappedGzipBytes,
      assets: reviewedUnmappedAssets,
    },
    unmappedBreakdown: {
      totalBytes: totalUnmappedBytes,
      reviewedMissingSourceMapBytes: reviewedUnmappedRawBytes,
      otherUnmappedBytes: totalUnmappedBytes - reviewedUnmappedRawBytes,
    },
    assets,
    sources: Object.fromEntries([...sources.entries()].sort((a, b) => b[1] - a[1])),
    sourceIdentities,
    dataQuality,
  };
}

function compareAnalyses(baseline, experiment) {
  const names = new Set([...Object.keys(baseline.sources), ...Object.keys(experiment.sources)]);
  const sources = [...names].map((source) => {
    const baselineBytes = baseline.sources[source] || 0;
    const experimentBytes = experiment.sources[source] || 0;
    const deltaBytes = experimentBytes - baselineBytes;
    const classification = baselineBytes > 0 && experimentBytes === 0 ? 'removed'
      : baselineBytes === 0 && experimentBytes > 0 ? 'added'
        : deltaBytes < 0 ? 'shrunk'
          : deltaBytes > 0 ? 'grown'
            : 'unchanged';
    return {
      source,
      baselineBytes,
      experimentBytes,
      deltaBytes,
      savedBytes: baselineBytes - experimentBytes,
      classification,
      sourceIdentity: {
        baseline: baseline.sourceIdentities?.[source] || null,
        experiment: experiment.sourceIdentities?.[source] || null,
      },
    };
  }).sort((a, b) => b.savedBytes - a.savedBytes || a.source.localeCompare(b.source));
  return {
    rawDeltaBytes: experiment.rawBytes - baseline.rawBytes,
    gzipDeltaBytes: experiment.gzipBytes - baseline.gzipBytes,
    mappedDeltaBytes: experiment.mappedBytes - baseline.mappedBytes,
    unmappedDeltaBytes: experiment.unmappedBytes - baseline.unmappedBytes,
    reviewedUnmappedRawDeltaBytes: (experiment.reviewedUnmapped?.rawBytes || 0) - (baseline.reviewedUnmapped?.rawBytes || 0),
    reviewedUnmappedGzipDeltaBytes: (experiment.reviewedUnmapped?.gzipBytes || 0) - (baseline.reviewedUnmapped?.gzipBytes || 0),
    otherUnmappedDeltaBytes: (experiment.unmappedBreakdown?.otherUnmappedBytes ?? experiment.unmappedBytes) - (baseline.unmappedBreakdown?.otherUnmappedBytes ?? baseline.unmappedBytes),
    sources,
  };
}

function selfTest() {
  const expectThrow = (fn, pattern, label) => {
    let error = null;
    try { fn(); } catch (caught) { error = caught; }
    if (!error || !pattern.test(error.message)) {
      throw new Error(`${label} self-test failed: ${error ? error.message : 'did not throw'}`);
    }
  };
  const code = 'const a = 1;\nconsole.log(a);\n';
  const gzipProbe = Buffer.from(Array.from({ length: 5000 }, (_, index) => `const v${index % 97}=${index % 13};`).join('\n'));
  const gzipProbeLevel9Bytes = gzipSync(gzipProbe, { level: 9 }).length;
  const gzipProbeDefaultBytes = gzipSync(gzipProbe).length;
  if (gzipProbeLevel9Bytes === gzipProbeDefaultBytes) throw new Error('gzip level self-test fixture does not distinguish default from level 9');
  if (gzipSize(gzipProbe) !== gzipProbeLevel9Bytes) throw new Error('gzip level 9 helper self-test failed');
  const attributed = attributeCode(code, [
    { generatedLine: 1, generatedColumn: 0, source: '/project/src/a.js' },
    { generatedLine: 2, generatedColumn: 0, source: '/project/src/b.js' },
  ], '/project');
  const total = [...attributed.values()].reduce((sum, value) => sum + value, 0);
  if (total !== Buffer.byteLength(code) || !attributed.has('src/a.js') || !attributed.has('src/b.js')) throw new Error('self-test assertion failed');
  if (normalizeSource('/project/src/a.js?raw#part', '/project') !== 'src/a.js?raw#part') throw new Error('source query/fragment self-test failed');
  const names = extractAssetNames({ scope: { appJsAssets: ['main.js', { name: 'async.mjs' }] } });
  if (names.join(',') !== 'async.mjs,main.js') throw new Error('asset manifest self-test failed');
  const temp = mkdtempSync(join(tmpdir(), 'sourcemap-attribution-'));
  try {
    const output = resolve(temp, 'dist');
    const compilerContext = resolve(temp, 'project/apps/web');
    const sourceFile = resolve(compilerContext, 'src/a.js');
    mkdirSync(output, { recursive: true });
    mkdirSync(dirname(sourceFile), { recursive: true });
    writeFileSync(sourceFile, 'export const a = 1;\n');
    const assetManifest = extractAssetManifest({
      compiler: { context: compilerContext },
      scope: { appJsAssets: ['main.js', { name: 'tiny.js' }] },
    });
    if (assetManifest.compilerContext !== compilerContext || assetManifest.assetNames.join(',') !== 'main.js,tiny.js') {
      throw new Error('asset manifest compiler.context self-test failed');
    }
    expectThrow(
      () => extractAssetManifest({ compiler: { context: './relative' }, scope: { appJsAssets: ['main.js'] } }),
      /must be absolute/,
      'relative compiler.context rejection',
    );
    const mainCode = 'const π=1;\n';
    const rawMainSource = 'webpack://web/./src/a.js?raw#part';
    const resolvedMainSource = 'webpack://web/src/a.js?raw#part';
    writeFileSync(resolve(output, 'main.js'), mainCode);
    writeFileSync(resolve(output, 'main.js.map'), JSON.stringify({
      testRawSources: [rawMainSource],
      testResolvedSources: [resolvedMainSource],
      testMappings: [{ generatedLine: 1, generatedColumn: 0, source: resolvedMainSource }],
    }));
    const tinyCode = gzipProbe.toString('utf8');
    writeFileSync(resolve(output, 'tiny.js'), tinyCode);
    writeFileSync(resolve(output, 'stray.js'), 'throw new Error("must not count");\n');
    const traceMapping = {
      TraceMap: class TraceMap {
        constructor(map) {
          this.map = map;
          this.sources = map.testRawSources || [];
          this.resolvedSources = map.testResolvedSources || [];
        }
      },
      eachMapping(trace, callback) { for (const mapping of trace.map.testMappings || []) callback(mapping); },
    };
    const reviewedManifestValue = {
      schemaVersion: 1,
      kind: 'reviewed-unmapped-app-js',
      side: 'baseline',
      reviewer: 'self-test agent',
      reviewedAt: '2026-01-02T03:04:05.000Z',
      assets: [{
        asset: 'tiny.js',
        sha256: sha256(Buffer.from(tinyCode)),
        rawBytes: Buffer.byteLength(tinyCode),
        reason: 'Rspack-generated empty registration chunk has no original source segments.',
      }],
    };
    const reviewedManifestPath = resolve(temp, 'reviewed-unmapped-baseline.json');
    const reviewedManifestBytes = Buffer.from(`${JSON.stringify(reviewedManifestValue, null, 2)}\n`);
    writeFileSync(reviewedManifestPath, reviewedManifestBytes);
    const reviewedUnmappedManifest = loadReviewedUnmappedManifest(reviewedManifestPath, 'baseline');
    if (reviewedUnmappedManifest.manifestSha256 !== sha256(reviewedManifestBytes) || reviewedUnmappedManifest.manifestPath !== reviewedManifestPath) {
      throw new Error('reviewed-unmapped manifest file hash self-test failed');
    }
    const analysis = analyzeDirectory({
      directory: output,
      projectRoot: temp,
      traceMapping,
      include: null,
      exclude: null,
      assetNames: ['main.js', 'tiny.js'],
      compilerContext,
      reviewedUnmappedManifest,
    });
    const mainSourceKey = 'web/src/a.js?raw#part';
    if (analysis.assets.length !== 2 || analysis.assets[0].asset !== 'main.js' || analysis.sources[mainSourceKey] !== Buffer.byteLength('const π=1;\n')) {
      throw new Error('explicit appJs attribution self-test failed');
    }
    const mainIdentity = analysis.sourceIdentities[mainSourceKey];
    if (mainIdentity?.status !== 'canonical'
      || mainIdentity.rawSources[0] !== rawMainSource
      || mainIdentity.resolvedSources[0] !== resolvedMainSource
      || mainIdentity.canonicalCandidates.length !== 1
      || mainIdentity.canonicalCandidates[0].value !== `${sourceFile.replace(/\\/g, '/')}?raw#part`
      || mainIdentity.canonicalCandidates[0].filesystemVerified !== true) {
      throw new Error('compiler.context raw/resolved source identity self-test failed');
    }
    const comparisonIdentity = compareAnalyses(analysis, analysis).sources.find((row) => row.source === mainSourceKey)?.sourceIdentity;
    if (comparisonIdentity?.baseline?.status !== 'canonical' || comparisonIdentity?.experiment?.status !== 'canonical') {
      throw new Error('comparison source identity propagation self-test failed');
    }
    if (analysis.dataQuality.length !== 0 || analysis.reviewedUnmapped.assetCount !== 1 || analysis.reviewedUnmapped.rawBytes !== Buffer.byteLength(tinyCode)) {
      throw new Error('reviewed missing-source-map acceptance self-test failed');
    }
    const expectedMainGzipBytes = gzipSync(Buffer.from(mainCode), { level: 9 }).length;
    const tinyAsset = analysis.assets.find((asset) => asset.asset === 'tiny.js');
    const mainAsset = analysis.assets.find((asset) => asset.asset === 'main.js');
    if (!tinyAsset || !mainAsset || tinyAsset.gzipBytes !== gzipProbeLevel9Bytes || mainAsset.gzipBytes !== expectedMainGzipBytes) {
      throw new Error('per-asset gzip level 9 self-test failed');
    }
    if (tinyAsset.gzipBytes === gzipProbeDefaultBytes || analysis.reviewedUnmapped.gzipBytes !== gzipProbeLevel9Bytes) {
      throw new Error('reviewed-unmapped gzip level 9 self-test failed');
    }
    if (analysis.gzipBytes !== expectedMainGzipBytes + gzipProbeLevel9Bytes) {
      throw new Error('directory gzip level 9 aggregation self-test failed');
    }
    if (analysis.unmappedBreakdown.reviewedMissingSourceMapBytes !== Buffer.byteLength(tinyCode) || analysis.unmappedBreakdown.otherUnmappedBytes !== 0) {
      throw new Error('reviewed unmapped byte breakdown self-test failed');
    }
    const ambiguousCode = 'let ambiguous=1;\n';
    const ambiguousResolvedSource = 'webpack://web/src/a.js?raw#part';
    writeFileSync(resolve(output, 'ambiguous.js'), ambiguousCode);
    writeFileSync(resolve(output, 'ambiguous.js.map'), JSON.stringify({
      testRawSources: [rawMainSource, 'webpack://web/../web/src/a.js?raw#part'],
      testResolvedSources: [ambiguousResolvedSource, ambiguousResolvedSource],
      testMappings: [{ generatedLine: 1, generatedColumn: 0, source: ambiguousResolvedSource }],
    }));
    const ambiguous = analyzeDirectory({
      directory: output,
      projectRoot: temp,
      traceMapping,
      include: null,
      exclude: null,
      assetNames: ['ambiguous.js'],
      compilerContext,
    });
    if (ambiguous.dataQuality.length !== 1
      || ambiguous.dataQuality[0].type !== 'ambiguous-resolved-source-identity'
      || ambiguous.sourceIdentities[mainSourceKey]?.status !== 'ambiguous'
      || ambiguous.sourceIdentities[mainSourceKey]?.rawSources.length !== 2) {
      throw new Error('ambiguous resolved-source identity gate self-test failed');
    }
    const unreviewed = analyzeDirectory({ directory: output, projectRoot: '/project', traceMapping, include: null, exclude: null, assetNames: ['tiny.js'] });
    if (unreviewed.dataQuality.length !== 1 || unreviewed.dataQuality[0].type !== 'missing-source-map') {
      throw new Error('unreviewed missing-source-map gate self-test failed');
    }
    const withManifestAsset = (asset, hash = sha256(readFileSync(resolve(output, asset)))) => normalizeReviewedUnmappedManifest({
      ...reviewedManifestValue,
      assets: [{ asset, sha256: hash, reason: 'Reviewed test reason.' }],
    }, { side: 'baseline' });
    expectThrow(
      () => analyzeDirectory({ directory: output, projectRoot: '/project', traceMapping, include: null, exclude: null, assetNames: ['tiny.js'], reviewedUnmappedManifest: withManifestAsset('tiny.js', '0'.repeat(64)) }),
      /hash mismatch/,
      'reviewed-unmapped hash mismatch',
    );
    expectThrow(
      () => analyzeDirectory({ directory: output, projectRoot: '/project', traceMapping, include: null, exclude: null, assetNames: ['main.js'], reviewedUnmappedManifest: withManifestAsset('main.js') }),
      /source map exists/,
      'stale reviewed-unmapped entry',
    );
    expectThrow(
      () => analyzeDirectory({ directory: output, projectRoot: '/project', traceMapping, include: null, exclude: null, assetNames: ['main.js'], reviewedUnmappedManifest: reviewedUnmappedManifest }),
      /outside the selected appJs scope/,
      'reviewed-unmapped scope mismatch',
    );
    const danglingCode = 'export{};\n//# sourceMappingURL=missing.js.map\n';
    writeFileSync(resolve(output, 'dangling.js'), danglingCode);
    expectThrow(
      () => analyzeDirectory({
        directory: output,
        projectRoot: '/project',
        traceMapping,
        include: null,
        exclude: null,
        assetNames: ['dangling.js'],
        reviewedUnmappedManifest: withManifestAsset('dangling.js'),
      }),
      /cannot excuse a missing referenced source map/,
      'reviewed-unmapped dangling reference',
    );
    expectThrow(
      () => normalizeReviewedUnmappedManifest({ ...reviewedManifestValue, side: 'experiment' }, { side: 'baseline' }),
      /side must be baseline/,
      'reviewed-unmapped side mismatch',
    );
    expectThrow(
      () => normalizeReviewedUnmappedManifest({ ...reviewedManifestValue, assets: [{ asset: 'tiny.js', sha256: sha256(Buffer.from(tinyCode)), reason: '' }] }, { side: 'baseline' }),
      /reason must be a non-empty string/,
      'reviewed-unmapped missing reason',
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const resolverTemp = mkdtempSync(join(tmpdir(), 'trace-mapping-pnpm-resolution-'));
  try {
    const makePackage = (directoryName, version) => {
      const packageRoot = resolve(resolverTemp, 'node_modules/.pnpm', directoryName, 'node_modules/@jridgewell/trace-mapping');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({ name: '@jridgewell/trace-mapping', version, main: 'index.js' }));
      writeFileSync(resolve(packageRoot, 'index.js'), `module.exports = { marker: ${JSON.stringify(version)} };\n`);
      return realpathSync(packageRoot);
    };
    makePackage('@jridgewell+trace-mapping@0.3.9', '0.3.9');
    const tieA = makePackage('@jridgewell+trace-mapping@0.3.31_peer-a', '0.3.31');
    const tieB = makePackage('@jridgewell+trace-mapping@0.3.31_peer-b', '0.3.31');
    const resolvedTraceMapping = resolveTraceMapping(resolverTemp);
    const expectedTieWinner = [tieA, tieB].sort()[0];
    if (resolvedTraceMapping.resolution.method !== 'pnpm-store-fallback' || resolvedTraceMapping.resolution.version !== '0.3.31') {
      throw new Error('pnpm fallback version selection self-test failed');
    }
    if (resolvedTraceMapping.resolution.packageRoot !== expectedTieWinner || resolvedTraceMapping.resolution.candidates.length !== 3) {
      throw new Error('pnpm fallback deterministic tie/candidate disclosure self-test failed');
    }
    if (resolvedTraceMapping.traceMapping.marker !== '0.3.31') throw new Error('pnpm fallback require self-test failed');
  } finally {
    rmSync(resolverTemp, { recursive: true, force: true });
  }
  console.log('sourcemap-generated-byte-attribution self-test passed');
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const projectRoot = resolve(args['project-root'] || process.cwd());
  const baselineDir = resolve(args['baseline-dir'] || 'baseline');
  const experimentDir = resolve(args['experiment-dir'] || 'experiment');
  const outPath = resolve(args.out || 'generated-byte-attribution.json');
  const include = args.include ? new RegExp(args.include) : null;
  const exclude = args.exclude ? new RegExp(args.exclude) : null;
  const baselineManifest = args['baseline-asset-manifest'];
  const experimentManifest = args['experiment-asset-manifest'];
  const baselineReviewedUnmappedPath = args['baseline-reviewed-unmapped-manifest'];
  const experimentReviewedUnmappedPath = args['experiment-reviewed-unmapped-manifest'];
  if (Boolean(baselineManifest) !== Boolean(experimentManifest)) {
    throw new Error('provide both --baseline-asset-manifest and --experiment-asset-manifest');
  }
  if (baselineManifest && (include || exclude)) {
    throw new Error('--include/--exclude cannot be combined with explicit asset manifests');
  }
  if ((baselineReviewedUnmappedPath || experimentReviewedUnmappedPath) && !baselineManifest) {
    throw new Error('reviewed-unmapped manifests require explicit --baseline-asset-manifest and --experiment-asset-manifest');
  }
  const baselineAssetManifest = baselineManifest ? loadAssetManifest(baselineManifest) : null;
  const experimentAssetManifest = experimentManifest ? loadAssetManifest(experimentManifest) : null;
  const baselineReviewedUnmappedManifest = loadReviewedUnmappedManifest(baselineReviewedUnmappedPath, 'baseline');
  const experimentReviewedUnmappedManifest = loadReviewedUnmappedManifest(experimentReviewedUnmappedPath, 'experiment');
  const traceMappingRecord = resolveTraceMapping(projectRoot);
  const traceMapping = traceMappingRecord.traceMapping;
  const baseline = analyzeDirectory({
    directory: baselineDir,
    projectRoot,
    traceMapping,
    include,
    exclude,
    assetNames: baselineAssetManifest?.assetNames || null,
    compilerContext: baselineAssetManifest?.compilerContext || null,
    assetManifestPath: baselineAssetManifest?.manifestPath || null,
    reviewedUnmappedManifest: baselineReviewedUnmappedManifest,
  });
  const experiment = analyzeDirectory({
    directory: experimentDir,
    projectRoot,
    traceMapping,
    include,
    exclude,
    assetNames: experimentAssetManifest?.assetNames || null,
    compilerContext: experimentAssetManifest?.compilerContext || null,
    assetManifestPath: experimentAssetManifest?.manifestPath || null,
    reviewedUnmappedManifest: experimentReviewedUnmappedManifest,
  });
  const comparison = compareAnalyses(baseline, experiment);
  const result = {
    version: 3,
    generatedAt: new Date().toISOString(),
    metric: 'actual generated UTF-8 bytes attributed by source-map segment spans',
    warning: 'Total raw/gzip deltas are exact for included assets; per-source attribution is a diagnostic source-map allocation, not per-module size or a standalone saving claim.',
    gzipMetric: { implementation: 'node:zlib.gzipSync', level: GZIP_OPTIONS.level, aggregation: 'compress each selected asset independently, then sum bytes' },
    dependencyResolution: traceMappingRecord.resolution,
    baseline,
    experiment,
    comparison,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  const mdPath = outPath.replace(/\.json$/i, '') + '.md';
  const markdownCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const reviewedRows = [
    ...baseline.reviewedUnmapped.assets.map((asset) => ({ side: 'baseline', ...asset })),
    ...experiment.reviewedUnmapped.assets.map((asset) => ({ side: 'experiment', ...asset })),
  ];
  const markdown = [
    '# Generated-Byte Attribution', '',
    `Raw delta: ${comparison.rawDeltaBytes} B`, '',
    `Gzip delta: ${comparison.gzipDeltaBytes} B`, '',
    `Mapped delta: ${comparison.mappedDeltaBytes} B`, '',
    `Unmapped delta: ${comparison.unmappedDeltaBytes} B`, '',
    `Reviewed missing-map delta: ${comparison.reviewedUnmappedRawDeltaBytes} B`, '',
    `Other unmapped delta: ${comparison.otherUnmappedDeltaBytes} B`, '',
    '> Per-source rows depend on source-map quality; raw/gzip totals are the actual included asset sizes.', '',
    '## Reviewed missing-source-map assets', '',
    '> These bytes remain unmapped. The listed exception only says an agent inspected the exact hash and accepted the absence of a source map; it does not turn these bytes into mapped attribution.', '',
    '| side | asset | raw | gzip | SHA-256 | reviewer | reviewed at | reason |',
    '| --- | --- | ---: | ---: | --- | --- | --- | --- |',
    ...(reviewedRows.length
      ? reviewedRows.map((row) => `| ${row.side} | ${markdownCell(row.asset)} | ${row.rawBytes} | ${row.gzipBytes} | ${row.sha256} | ${markdownCell(row.reviewer)} | ${markdownCell(row.reviewedAt)} | ${markdownCell(row.reason)} |`)
      : ['| _none_ |  | 0 | 0 |  |  |  |  |']),
    '',
    '## Per-source allocation', '',
    '| source | baseline | experiment | delta | saved | class |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...comparison.sources.map((row) => `| ${row.source.replace(/\|/g, '\\|')} | ${row.baselineBytes} | ${row.experimentBytes} | ${row.deltaBytes} | ${row.savedBytes} | ${row.classification} |`),
  ].join('\n');
  writeFileSync(mdPath, markdown + '\n');
  console.log(`rawDeltaBytes=${comparison.rawDeltaBytes} gzipDeltaBytes=${comparison.gzipDeltaBytes}`);
  console.log(`reviewedUnmapped baseline=${baseline.reviewedUnmapped.assetCount} asset(s)/${baseline.reviewedUnmapped.rawBytes} B experiment=${experiment.reviewedUnmapped.assetCount} asset(s)/${experiment.reviewedUnmapped.rawBytes} B`);
  console.log(`traceMapping=${traceMappingRecord.resolution.version} method=${traceMappingRecord.resolution.method} path=${traceMappingRecord.resolution.resolvedPath}`);
  console.log(`wrote ${outPath}`);
  if (args['require-complete-maps']) {
    const issues = [
      ...baseline.dataQuality.map((issue) => ({ ...issue, side: 'baseline' })),
      ...experiment.dataQuality.map((issue) => ({ ...issue, side: 'experiment' })),
    ];
    if (issues.length) throw new Error(`source-map data-quality gate failed with ${issues.length} issue(s); inspect ${outPath}`);
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = {
  analyzeDirectory,
  attributeCode,
  compareAnalyses,
  compareSemverDescending,
  createTraceSourceIdentityIndex,
  extractAssetManifest,
  extractSourceMappingUrls,
  extractAssetNames,
  finalizeSourceIdentities,
  gzipSize,
  loadAssetManifest,
  loadReviewedUnmappedManifest,
  normalizeReviewedUnmappedManifest,
  normalizeSource,
  parseSourceMap,
  resolveTraceMapping,
  sha256,
  splitSourceSuffix,
  splitGeneratedLines,
  verifiedAbsoluteSourceCandidate,
  walkJsFiles,
};
