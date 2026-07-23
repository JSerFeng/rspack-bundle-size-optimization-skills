#!/usr/bin/env node
// Normalize browser precise-coverage data into factual Rspack script/module
// records. This tool does not infer user intent, removability, or savings.

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('fs');
const { createHash } = require('crypto');
const { basename, dirname, resolve } = require('path');
const { tmpdir } = require('os');

const ARTIFACTS = {
  session: 'runtime-coverage-session.json',
  scripts: 'runtime-coverage-scripts.jsonl',
  modules: 'runtime-coverage-modules.jsonl',
  summary: 'runtime-coverage-summary.json',
  failures: 'runtime-coverage-failures.jsonl',
  manifest: 'runtime-coverage-manifest.json',
};

function parseArgs(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith('--') ? true : next;
    if (values[key] === undefined) values[key] = value;
    else if (Array.isArray(values[key])) values[key].push(value);
    else values[key] = [values[key], value];
    if (value !== true) index++;
  }
  return values;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function loadJsonNonEmpty(path, label) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`Missing ${label}: ${absolute}`);
  if (statSync(absolute).size === 0) {
    throw new Error(`${label} is zero bytes: ${absolute}`);
  }
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot parse ${label} ${absolute}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function writeFresh(path, body) {
  if (existsSync(path)) throw new Error(`Refusing to overwrite: ${path}`);
  writeFileSync(path, body);
}

function artifactRecord(path) {
  const body = readFileSync(path);
  return {
    file: basename(path),
    bytes: body.length,
    sha256: sha256(body),
  };
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function maxEndOffset(script) {
  return Math.max(
    0,
    ...arrayValue(script.functions).flatMap((fn) =>
      arrayValue(fn.ranges).map((range) => Number(range.endOffset) || 0)),
  );
}

function outerRange(fn) {
  return [...arrayValue(fn.ranges)].sort((left, right) =>
    (right.endOffset - right.startOffset)
    - (left.endOffset - left.startOffset))[0] || null;
}

function strictlyContains(parent, child) {
  return (
    parent.startOffset <= child.startOffset
    && parent.endOffset >= child.endOffset
    && (
      parent.startOffset < child.startOffset
      || parent.endOffset > child.endOffset
    )
  );
}

function flattenCoverage(raw, defaults) {
  const targetDefaults = {
    targetId: String(defaults.targetId || 'page'),
    targetType: String(defaults.targetType || 'page'),
  };
  const rows = [];

  function append(result, target = {}) {
    for (const script of arrayValue(result)) {
      rows.push({
        ...script,
        targetId: String(
          script.targetId
          || target.targetId
          || target.id
          || targetDefaults.targetId,
        ),
        targetType: String(
          script.targetType
          || target.targetType
          || target.type
          || targetDefaults.targetType,
        ),
      });
    }
  }

  if (Array.isArray(raw)) {
    append(raw);
  } else if (Array.isArray(raw?.targets)) {
    for (const target of raw.targets) {
      append(target.result || target.coverage?.result, target);
    }
  } else {
    append(raw?.result);
  }
  return rows;
}

function isJavaScriptUrl(url) {
  return /\.(?:m?js)(?:[?#]|$)/i.test(String(url || ''));
}

function includeScript(script, prefix) {
  const url = String(script.url || '');
  return (
    url
    && isJavaScriptUrl(url)
    && (!prefix || url.startsWith(prefix))
    && Array.isArray(script.functions)
  );
}

function normalizeLoadedScripts(raw, prefix) {
  const rows = Array.isArray(raw)
    ? raw
    : arrayValue(raw?.scripts || raw?.resources);
  return rows.map((row) => (
    typeof row === 'string'
      ? { url: row, targetId: null, targetType: null }
      : {
          url: row.url || row.name || null,
          targetId: row.targetId || null,
          targetType: row.targetType || null,
        }
  )).filter((row) =>
    row.url
    && isJavaScriptUrl(row.url)
    && (!prefix || row.url.startsWith(prefix)));
}

function loadSourceManifest(path) {
  if (!path) return null;
  const absolute = resolve(path);
  const raw = loadJsonNonEmpty(absolute, 'source manifest');
  const scripts = Array.isArray(raw) ? raw : arrayValue(raw.scripts);
  const byTargetAndScript = new Map();
  const byScript = new Map();
  const byUrl = new Map();
  for (const entry of scripts) {
    const normalized = { ...entry, manifestDir: dirname(absolute) };
    if (entry.targetId != null && entry.scriptId != null) {
      byTargetAndScript.set(
        `${String(entry.targetId)}\0${String(entry.scriptId)}`,
        normalized,
      );
    }
    if (entry.scriptId != null && !byScript.has(String(entry.scriptId))) {
      byScript.set(String(entry.scriptId), normalized);
    }
    if (entry.url && !byUrl.has(String(entry.url))) {
      byUrl.set(String(entry.url), normalized);
    }
  }
  return { absolute, raw, byTargetAndScript, byScript, byUrl };
}

function sourceManifestEntry(manifest, script) {
  if (!manifest) return null;
  return (
    manifest.byTargetAndScript.get(
      `${String(script.targetId)}\0${String(script.scriptId)}`,
    )
    || manifest.byScript.get(String(script.scriptId))
    || manifest.byUrl.get(String(script.url))
    || null
  );
}

function readManifestSource(entry) {
  if (typeof entry.source === 'string') {
    return { source: entry.source, provenance: 'manifest-inline' };
  }
  if (entry.sourcePath) {
    const path = resolve(entry.manifestDir, entry.sourcePath);
    return {
      source: readFileSync(path, 'utf8'),
      provenance: 'manifest-file',
      sourcePath: path,
    };
  }
  return null;
}

async function fetchSource(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const source = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return {
      source,
      provenance: 'http',
      responseStatus: response.status,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return output;
}

async function resolveScriptSource(script, options) {
  const expectedLength = maxEndOffset(script);
  const manifestEntry = sourceManifestEntry(options.sourceManifest, script);
  let loaded = null;
  try {
    if (manifestEntry) loaded = readManifestSource(manifestEntry);
    if (!loaded && options.fetchSources) {
      loaded = await fetchSource(script.url, options.sourceTimeoutMs);
    }
  } catch (error) {
    return {
      source: null,
      expectedLength,
      actualLength: null,
      utf8Bytes: null,
      sha256: null,
      provenance: manifestEntry ? 'manifest' : 'http',
      responseStatus: null,
      failure: {
        severity: 'error',
        stage: 'source',
        code: 'SOURCE_READ_FAILED',
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (!loaded) {
    return {
      source: null,
      expectedLength,
      actualLength: null,
      utf8Bytes: null,
      sha256: null,
      provenance: null,
      responseStatus: null,
      failure: {
        severity: 'error',
        stage: 'source',
        code: 'SOURCE_UNAVAILABLE',
        reason:
          'No matching source-manifest entry and HTTP source retrieval was not enabled',
      },
    };
  }

  const actualLength = loaded.source.length;
  const digest = sha256(loaded.source);
  if (manifestEntry?.sha256 && manifestEntry.sha256 !== digest) {
    return {
      ...loaded,
      expectedLength,
      actualLength,
      utf8Bytes: Buffer.byteLength(loaded.source),
      sha256: digest,
      failure: {
        severity: 'error',
        stage: 'source',
        code: 'SOURCE_HASH_MISMATCH',
        reason: `manifest sha256 ${manifestEntry.sha256} != actual ${digest}`,
      },
    };
  }
  if (actualLength !== expectedLength) {
    return {
      ...loaded,
      expectedLength,
      actualLength,
      utf8Bytes: Buffer.byteLength(loaded.source),
      sha256: digest,
      failure: {
        severity: 'error',
        stage: 'source',
        code: 'SOURCE_LENGTH_MISMATCH',
        reason:
          `source length ${actualLength} != V8 maximum endOffset ${expectedLength}`,
      },
    };
  }
  return {
    ...loaded,
    expectedLength,
    actualLength,
    utf8Bytes: Buffer.byteLength(loaded.source),
    sha256: digest,
    failure: null,
  };
}

function looksLikeModuleIdentifier(name) {
  return (
    name.startsWith('.')
    || name.startsWith('/')
    || name.includes('node_modules')
    || name.startsWith('external ')
    || name.startsWith('webpack/runtime/')
  );
}

function extractFactories(script, source) {
  const records = arrayValue(script.functions).map((fn, index) => ({
    index,
    fn,
    root: outerRange(fn),
    parent: null,
  })).filter((record) => record.root);
  records.sort((left, right) =>
    left.root.startOffset - right.root.startOffset
    || right.root.endOffset - left.root.endOffset
    || left.index - right.index);

  const stack = [];
  for (const current of records) {
    while (
      stack.length
      && !strictlyContains(stack[stack.length - 1].root, current.root)
    ) {
      stack.pop();
    }
    current.parent = stack[stack.length - 1] || null;
    stack.push(current);
  }

  const scriptRoot = records.find((record) =>
    record.root.startOffset === 0
    && record.root.endOffset === source.length
    && record.fn.functionName === '');
  if (!scriptRoot) {
    return {
      factories: [],
      warnings: [{
        severity: 'error',
        stage: 'factory-mapping',
        code: 'SCRIPT_ROOT_NOT_FOUND',
        reason:
          'No blank-name V8 function covered the complete retrieved script source',
      }],
    };
  }

  const directChildren = records.filter((record) =>
    record !== scriptRoot && record.parent === scriptRoot);
  const factories = directChildren.filter((record) => {
    const moduleId = String(record.fn.functionName || '');
    if (!moduleId) return false;
    const encoded = JSON.stringify(moduleId);
    if (!source.startsWith(encoded, record.root.startOffset)) return false;
    return /^\s*\(/.test(
      source.slice(
        record.root.startOffset + encoded.length,
        record.root.startOffset + encoded.length + 32,
      ),
    );
  });
  const factorySet = new Set(factories);
  const warnings = directChildren
    .filter((record) =>
      record.fn.functionName
      && looksLikeModuleIdentifier(record.fn.functionName)
      && !factorySet.has(record))
    .map((record) => ({
      severity: 'error',
      stage: 'factory-mapping',
      code: 'FACTORY_SYNTAX_MISMATCH',
      reason:
        'A top-level function looked like a module identifier but did not match the Rspack object-method boundary',
      functionName: record.fn.functionName,
      startOffset: record.root.startOffset,
      endOffset: record.root.endOffset,
      sourcePrefix: source.slice(
        record.root.startOffset,
        record.root.startOffset + 200,
      ),
    }));
  return { factories, warnings };
}

function buildCompilationIndex(compilation) {
  if (!compilation) return null;
  if (
    compilation.kind !== 'rspack-compilation-data'
    || ![1, 2].includes(compilation.schemaVersion)
  ) {
    throw new Error('Unsupported compilation-data schema');
  }
  const byId = new Map();
  const byIdentifier = new Map();
  const chunksByFile = new Map();
  for (const module of arrayValue(compilation.modules)) {
    if (module.id !== null && module.id !== undefined) {
      const key = String(module.id);
      const rows = byId.get(key) || [];
      rows.push(module);
      byId.set(key, rows);
    }
    if (module.identifier) {
      const key = String(module.identifier);
      const rows = byIdentifier.get(key) || [];
      rows.push(module);
      byIdentifier.set(key, rows);
    }
  }
  for (const chunk of arrayValue(compilation.chunks)) {
    for (const file of arrayValue(chunk.files)) {
      const rows = chunksByFile.get(String(file)) || [];
      rows.push(chunk);
      chunksByFile.set(String(file), rows);
    }
  }
  return { compilation, byId, byIdentifier, chunksByFile };
}

function chunksForUrl(url, compilationIndex) {
  if (!compilationIndex) return [];
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
  } catch {
    pathname = String(url || '').replace(/^\/+/, '').split(/[?#]/, 1)[0];
  }
  const matches = [];
  for (const [file, chunks] of compilationIndex.chunksByFile) {
    if (pathname === file || pathname.endsWith(`/${file}`)) {
      for (const chunk of chunks) matches.push({ file, chunk });
    }
  }
  return matches;
}

function matchCompilationModule(moduleId, chunkMatches, compilationIndex) {
  if (!compilationIndex) {
    return {
      status: 'not-requested',
      matchedBy: null,
      matches: [],
    };
  }
  const candidates = [
    ...(compilationIndex.byId.get(String(moduleId)) || []).map((module) => ({
      module,
      matchedBy: 'id',
    })),
    ...(
      compilationIndex.byIdentifier.get(String(moduleId)) || []
    ).map((module) => ({ module, matchedBy: 'identifier' })),
  ];
  const chunkIds = new Set(
    chunkMatches.map(({ chunk }) => String(chunk.id)),
  );
  const deduplicated = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${String(candidate.module.id)}\0${candidate.module.identifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(candidate);
  }
  const inChunk = chunkIds.size
    ? deduplicated.filter(({ module }) =>
        arrayValue(module.chunks).some((id) => chunkIds.has(String(id))))
    : [];
  const narrowed = inChunk.length ? inChunk : deduplicated;
  return {
    status:
      narrowed.length === 1
        ? 'matched'
        : narrowed.length > 1
          ? 'ambiguous'
          : 'not-found',
    matchedBy: narrowed.length === 1 ? narrowed[0].matchedBy : null,
    matches: narrowed.map(({ module }) => ({
      id: module.id ?? null,
      identifier: module.identifier || null,
      resource: module.resource || null,
      chunks: arrayValue(module.chunks),
      concatenatedModules: arrayValue(module.concatenatedModules),
    })),
  };
}

function parseComparableTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== '') return numeric;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : date;
}

function startBeforeNavigationFact(session) {
  const explicit =
    session?.capture?.startBeforeNavigation
    ?? session?.startBeforeNavigation;
  if (typeof explicit === 'boolean') {
    return {
      value: explicit,
      basis: 'explicit',
      reason: explicit
        ? null
        : 'Coverage collection was explicitly recorded as starting after navigation',
    };
  }
  const captureStartedAt =
    session?.capture?.startedAt
    ?? session?.coverageStartedAt
    ?? session?.captureStartedAt;
  const navigationStartedAt =
    session?.navigation?.startedAt
    ?? session?.navigationStartedAt;
  const captureValue = parseComparableTimestamp(captureStartedAt);
  const navigationValue = parseComparableTimestamp(navigationStartedAt);
  if (captureValue !== null && navigationValue !== null) {
    const value = captureValue <= navigationValue;
    return {
      value,
      basis: 'timestamps',
      reason: value
        ? null
        : `coverage start ${captureStartedAt} followed navigation start ${navigationStartedAt}`,
    };
  }
  return {
    value: null,
    basis: 'missing-metadata',
    reason:
      'Session metadata does not prove that coverage collection started before navigation',
  };
}

function expectedTargets(session) {
  const rows =
    session?.targetsExpected
    || session?.expectedTargets
    || session?.targets?.expected;
  return arrayValue(rows).map((row) => (
    typeof row === 'string'
      ? { targetId: null, targetType: row }
      : {
          targetId: row.targetId || row.id || null,
          targetType: row.targetType || row.type || null,
        }
  ));
}

function unique(values) {
  return [...new Set(values)];
}

function sum(rows, getter) {
  return rows.reduce((total, row) => total + getter(row), 0);
}

function inputFingerprint(path) {
  if (!path) return null;
  const absolute = resolve(path);
  const body = readFileSync(absolute);
  return {
    path: absolute,
    bytes: body.length,
    sha256: sha256(body),
  };
}

async function normalizeRun(args) {
  if (!args.coverage) throw new Error('Provide --coverage <precise-coverage.json>');
  if (!args['out-dir']) throw new Error('Provide --out-dir <fresh-directory>');

  const coveragePath = resolve(args.coverage);
  const loadedScriptsPath = args['loaded-scripts']
    ? resolve(args['loaded-scripts'])
    : null;
  const sessionPath = args.session ? resolve(args.session) : null;
  const compilationPath = args.compilation
    ? resolve(args.compilation)
    : null;
  const sourceManifestPath = args['source-manifest']
    ? resolve(args['source-manifest'])
    : null;
  const outDir = resolve(args['out-dir']);
  const includeUrlPrefix =
    args['include-url-prefix'] === undefined
      ? null
      : String(args['include-url-prefix']);
  const concurrency = Number(args['fetch-concurrency'] || 8);
  const sourceTimeoutMs = Number(args['source-timeout-ms'] || 15000);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('--fetch-concurrency must be a positive integer');
  }
  if (!Number.isFinite(sourceTimeoutMs) || sourceTimeoutMs < 1) {
    throw new Error('--source-timeout-ms must be positive');
  }

  const coverageRaw = loadJsonNonEmpty(coveragePath, 'coverage input');
  const loadedRaw = loadedScriptsPath
    ? loadJsonNonEmpty(loadedScriptsPath, 'loaded scripts input')
    : null;
  const sessionInput = sessionPath
    ? loadJsonNonEmpty(sessionPath, 'session input')
    : {};
  const compilation = compilationPath
    ? loadJsonNonEmpty(compilationPath, 'compilation data')
    : null;
  const sourceManifest = loadSourceManifest(sourceManifestPath);
  const compilationIndex = buildCompilationIndex(compilation);

  const allCoverageScripts = flattenCoverage(coverageRaw, {
    targetId: args['target-id'],
    targetType: args['target-type'],
  });
  const scripts = allCoverageScripts.filter((script) =>
    includeScript(script, includeUrlPrefix));
  if (!scripts.length) {
    throw new Error('No JavaScript coverage entries matched the requested scope');
  }
  const loadedScripts = loadedRaw
    ? normalizeLoadedScripts(loadedRaw, includeUrlPrefix)
    : [];
  const loadedUrls = unique(loadedScripts.map((row) => String(row.url)));
  const coverageUrls = unique(scripts.map((script) => String(script.url)));
  const coverageUrlSet = new Set(coverageUrls);
  const loadedUrlSet = new Set(loadedUrls);
  const failures = [];

  const sourceRows = await mapLimit(scripts, concurrency, async (script) => ({
    script,
    sourceData: await resolveScriptSource(script, {
      sourceManifest,
      fetchSources: args['fetch-sources'] === true,
      sourceTimeoutMs,
    }),
  }));

  const scriptRows = [];
  const moduleRows = [];
  for (const { script, sourceData } of sourceRows) {
    const scriptKey = `${script.targetId}:${script.scriptId}`;
    const chunkMatches = chunksForUrl(script.url, compilationIndex);
    const baseFailure = {
      scriptKey,
      targetId: script.targetId,
      targetType: script.targetType,
      scriptId: String(script.scriptId),
      url: String(script.url),
    };
    if (sourceData.failure) {
      failures.push({ ...baseFailure, ...sourceData.failure });
    }

    let extracted = { factories: [], warnings: [] };
    if (!sourceData.failure) {
      extracted = extractFactories(script, sourceData.source);
      for (const warning of extracted.warnings) {
        failures.push({ ...baseFailure, ...warning });
      }
    }

    const perScriptModules = [];
    for (const factory of extracted.factories) {
      const { startOffset, endOffset, count } = factory.root;
      const moduleId = String(factory.fn.functionName);
      const factorySource = sourceData.source.slice(startOffset, endOffset);
      const compilationMatch = matchCompilationModule(
        moduleId,
        chunkMatches,
        compilationIndex,
      );
      const concatenatedModules = unique(
        compilationMatch.matches.flatMap((match) =>
          arrayValue(match.concatenatedModules).map(String)),
      ).sort();
      const row = {
        schemaVersion: 1,
        kind: 'rspack-runtime-module-factory-fact',
        scriptKey,
        targetId: script.targetId,
        targetType: script.targetType,
        scriptId: String(script.scriptId),
        url: String(script.url),
        assetFiles: unique(chunkMatches.map((match) => match.file)).sort(),
        chunkIds: unique(
          chunkMatches.map(({ chunk }) => String(chunk.id)),
        ).sort(),
        moduleId,
        factoryStartOffset: startOffset,
        factoryEndOffset: endOffset,
        factoryCharacters: endOffset - startOffset,
        factoryUtf8Bytes: Buffer.byteLength(factorySource),
        factoryExecutionCount: Number(count) || 0,
        isBlockCoverage: factory.fn.isBlockCoverage === true,
        factorySourceSnippet: factorySource.slice(0, 500),
        compilerMapping: compilationMatch,
        mappingGranularity:
          concatenatedModules.length
            ? 'coarse-concatenated-factory'
            : 'exact-generated-factory',
        concatenatedModuleIdentifiers: concatenatedModules,
      };
      perScriptModules.push(row);
      moduleRows.push(row);
    }

    const zeroCountModules = perScriptModules.filter((row) =>
      row.factoryExecutionCount === 0);
    const positiveCountModules = perScriptModules.filter((row) =>
      row.factoryExecutionCount > 0);
    scriptRows.push({
      schemaVersion: 1,
      kind: 'rspack-runtime-script-fact',
      scriptKey,
      targetId: script.targetId,
      targetType: script.targetType,
      scriptId: String(script.scriptId),
      url: String(script.url),
      assetFiles: unique(chunkMatches.map((match) => match.file)).sort(),
      chunkIds: unique(
        chunkMatches.map(({ chunk }) => String(chunk.id)),
      ).sort(),
      chunkNames: unique(
        chunkMatches.map(({ chunk }) => chunk.name).filter(Boolean),
      ).sort(),
      canBeInitial: unique(
        chunkMatches
          .map(({ chunk }) => chunk.canBeInitial)
          .filter((value) => value !== null && value !== undefined),
      ),
      source: {
        provenance: sourceData.provenance,
        responseStatus: sourceData.responseStatus ?? null,
        expectedV8Characters: sourceData.expectedLength,
        actualCharacters: sourceData.actualLength,
        utf8Bytes: sourceData.utf8Bytes,
        sha256: sourceData.sha256,
        lengthMatches:
          sourceData.actualLength !== null
          && sourceData.actualLength === sourceData.expectedLength,
      },
      coverage: {
        functionCount: arrayValue(script.functions).length,
        rangeCount: sum(
          arrayValue(script.functions),
          (fn) => arrayValue(fn.ranges).length,
        ),
        maximumEndOffset: maxEndOffset(script),
      },
      factoryMapping: {
        factoryCount: perScriptModules.length,
        zeroCountFactoryCount: zeroCountModules.length,
        positiveCountFactoryCount: positiveCountModules.length,
        factoryUtf8Bytes: sum(
          perScriptModules,
          (row) => row.factoryUtf8Bytes,
        ),
        zeroCountFactoryUtf8Bytes: sum(
          zeroCountModules,
          (row) => row.factoryUtf8Bytes,
        ),
        mappingFailureCount:
          (sourceData.failure ? 1 : 0) + extracted.warnings.length,
      },
    });
  }

  for (const url of loadedUrls.filter((url) => !coverageUrlSet.has(url))) {
    failures.push({
      severity: 'error',
      stage: 'resource-coverage',
      code: 'LOADED_SCRIPT_MISSING_COVERAGE',
      reason: 'A loaded JavaScript resource had no matching coverage entry',
      url,
    });
  }
  for (const url of coverageUrls.filter((url) => !loadedUrlSet.has(url))) {
    if (!loadedScriptsPath) break;
    failures.push({
      severity: 'warning',
      stage: 'resource-coverage',
      code: 'COVERAGE_SCRIPT_MISSING_RESOURCE_RECORD',
      reason:
        'A JavaScript coverage entry was absent from the loaded-resource input',
      url,
    });
  }

  const observedTargets = unique(
    scripts.map((script) =>
      `${script.targetId}\0${script.targetType}`),
  ).map((key) => {
    const [targetId, targetType] = key.split('\0');
    return { targetId, targetType };
  });
  const expected = expectedTargets(sessionInput);
  for (const target of expected) {
    const present = observedTargets.some((observed) =>
      (!target.targetId || observed.targetId === target.targetId)
      && (!target.targetType || observed.targetType === target.targetType));
    if (!present) {
      failures.push({
        severity: 'error',
        stage: 'target-coverage',
        code: 'EXPECTED_TARGET_MISSING',
        reason:
          `Expected target was not represented in coverage: ${JSON.stringify(target)}`,
        targetId: target.targetId,
        targetType: target.targetType,
      });
    }
  }

  const startFact = startBeforeNavigationFact(sessionInput);
  if (startFact.value === false) {
    failures.push({
      severity: 'error',
      stage: 'session',
      code: 'COVERAGE_STARTED_AFTER_NAVIGATION',
      reason: startFact.reason,
    });
  } else if (startFact.value === null) {
    failures.push({
      severity: 'warning',
      stage: 'session',
      code: 'COVERAGE_START_ORDER_UNKNOWN',
      reason: startFact.reason,
    });
  }

  const zeroCountModules = moduleRows.filter((row) =>
    row.factoryExecutionCount === 0);
  const positiveCountModules = moduleRows.filter((row) =>
    row.factoryExecutionCount > 0);
  const scriptsWithFactories = scriptRows.filter((row) =>
    row.factoryMapping.factoryCount > 0);
  const summary = {
    schemaVersion: 1,
    kind: 'rspack-runtime-coverage-arithmetic',
    scripts: {
      coverageEntriesInInput: allCoverageScripts.length,
      selectedJavaScriptEntries: scripts.length,
      loadedJavaScriptResources: loadedUrls.length || null,
      uniqueSelectedUrls: coverageUrls.length,
      duplicateSelectedUrls:
        scripts.length - coverageUrls.length,
      sourceLengthMatched: scriptRows.filter((row) =>
        row.source.lengthMatches).length,
      sourceLengthNotMatched: scriptRows.filter((row) =>
        !row.source.lengthMatches).length,
      withFactories: scriptsWithFactories.length,
      withoutFactories: scriptRows.length - scriptsWithFactories.length,
      withOnlyZeroCountFactories: scriptsWithFactories.filter((row) =>
        row.factoryMapping.zeroCountFactoryCount
        === row.factoryMapping.factoryCount).length,
      withMixedFactoryCounts: scriptsWithFactories.filter((row) =>
        row.factoryMapping.zeroCountFactoryCount > 0
        && row.factoryMapping.positiveCountFactoryCount > 0).length,
      withOnlyPositiveCountFactories: scriptsWithFactories.filter((row) =>
        row.factoryMapping.zeroCountFactoryCount === 0).length,
    },
    moduleFactories: {
      instances: moduleRows.length,
      uniqueModuleIds: unique(moduleRows.map((row) => row.moduleId)).length,
      duplicateInstances:
        moduleRows.length - unique(moduleRows.map((row) => row.moduleId)).length,
      zeroCountInstances: zeroCountModules.length,
      positiveCountInstances: positiveCountModules.length,
      allFactoryUtf8Bytes: sum(
        moduleRows,
        (row) => row.factoryUtf8Bytes,
      ),
      zeroCountFactoryUtf8Bytes: sum(
        zeroCountModules,
        (row) => row.factoryUtf8Bytes,
      ),
      coarseConcatenatedInstances: moduleRows.filter((row) =>
        row.mappingGranularity === 'coarse-concatenated-factory').length,
      compilerMatchedInstances: moduleRows.filter((row) =>
        row.compilerMapping.status === 'matched').length,
      compilerAmbiguousInstances: moduleRows.filter((row) =>
        row.compilerMapping.status === 'ambiguous').length,
      compilerNotFoundInstances: moduleRows.filter((row) =>
        row.compilerMapping.status === 'not-found').length,
      compilerMappingNotRequestedInstances: moduleRows.filter((row) =>
        row.compilerMapping.status === 'not-requested').length,
    },
    resources: {
      loadedUrlsMissingCoverage:
        loadedUrls.filter((url) => !coverageUrlSet.has(url)).length,
      coverageUrlsMissingLoadedRecord:
        loadedScriptsPath
          ? coverageUrls.filter((url) => !loadedUrlSet.has(url)).length
          : null,
    },
    targets: {
      expected,
      observed: observedTargets,
    },
    failures: {
      errors: failures.filter((failure) =>
        failure.severity === 'error').length,
      warnings: failures.filter((failure) =>
        failure.severity === 'warning').length,
    },
  };

  const session = {
    schemaVersion: 1,
    kind: 'rspack-runtime-coverage-session',
    normalizedAt: new Date().toISOString(),
    runId: args['run-id'] || sessionInput.runId || null,
    scenarioId:
      args['scenario-id']
      || sessionInput.scenarioId
      || sessionInput.scenario?.id
      || null,
    repetition:
      args.repetition
      || sessionInput.repetition
      || sessionInput.scenario?.repetition
      || null,
    provider:
      args.provider
      || sessionInput.provider
      || sessionInput.capture?.provider
      || 'cdp-precise-coverage',
    pageUrl: sessionInput.pageUrl || sessionInput.url || null,
    captureSettings: {
      callCount:
        sessionInput.capture?.callCount
        ?? sessionInput.callCount
        ?? null,
      detailed:
        sessionInput.capture?.detailed
        ?? sessionInput.detailed
        ?? null,
      startedAt:
        sessionInput.capture?.startedAt
        ?? sessionInput.coverageStartedAt
        ?? sessionInput.captureStartedAt
        ?? null,
      navigationStartedAt:
        sessionInput.navigation?.startedAt
        ?? sessionInput.navigationStartedAt
        ?? null,
      startBeforeNavigation: startFact,
    },
    targetsExpected: expected,
    targetsObserved: observedTargets,
    inputs: {
      coverage: inputFingerprint(coveragePath),
      loadedScripts: inputFingerprint(loadedScriptsPath),
      session: inputFingerprint(sessionPath),
      sourceManifest: inputFingerprint(sourceManifestPath),
      compilation: inputFingerprint(compilationPath),
    },
  };

  mkdirSync(outDir, { recursive: true });
  const paths = Object.fromEntries(
    Object.entries(ARTIFACTS).map(([key, file]) => [key, resolve(outDir, file)]),
  );
  for (const [key, path] of Object.entries(paths)) {
    if (key !== 'manifest' && existsSync(path)) {
      throw new Error(`Refusing to overwrite: ${path}`);
    }
  }
  if (existsSync(paths.manifest)) {
    throw new Error(`Refusing to overwrite: ${paths.manifest}`);
  }

  writeFresh(paths.session, `${JSON.stringify(session, null, 2)}\n`);
  writeFresh(
    paths.scripts,
    scriptRows.length
      ? `${scriptRows.map((row) => JSON.stringify(row)).join('\n')}\n`
      : '',
  );
  writeFresh(
    paths.modules,
    moduleRows.length
      ? `${moduleRows.map((row) => JSON.stringify(row)).join('\n')}\n`
      : '',
  );
  writeFresh(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);
  writeFresh(
    paths.failures,
    failures.length
      ? `${failures.map((row) => JSON.stringify(row)).join('\n')}\n`
      : '',
  );
  const artifactPaths = [
    paths.session,
    paths.scripts,
    paths.modules,
    paths.summary,
    paths.failures,
  ];
  const manifest = {
    schemaVersion: 1,
    kind: 'rspack-runtime-coverage-manifest',
    generatedAt: new Date().toISOString(),
    runId: session.runId,
    scenarioId: session.scenarioId,
    artifacts: artifactPaths.map(artifactRecord),
  };
  writeFresh(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    outDir,
    manifest: paths.manifest,
    summary,
    failures,
  };
}

function fixtureScript(url, scriptId, definitions, target = {}) {
  let source = 'var __webpack_modules__ = {\n';
  const functions = [];
  const nested = [];
  for (const definition of definitions) {
    const startOffset = source.length;
    const fragment =
      `${JSON.stringify(definition.moduleId)}(module) {\n`
      + `${definition.body || ''}\n}`;
    source += `${fragment},\n`;
    const endOffset = startOffset + fragment.length;
    functions.push({
      functionName: definition.moduleId,
      ranges: [{
        startOffset,
        endOffset,
        count: definition.count,
      }],
      isBlockCoverage: false,
    });
    const nestedIndex = fragment.indexOf('function nested');
    if (nestedIndex >= 0) {
      const nestedStart = startOffset + nestedIndex;
      nested.push({
        functionName: 'nested',
        ranges: [{
          startOffset: nestedStart,
          endOffset: endOffset - 1,
          count: definition.count,
        }],
        isBlockCoverage: false,
      });
    }
  }
  source += '};\n';
  return {
    source,
    coverage: {
      targetId: target.targetId || 'page-1',
      targetType: target.targetType || 'page',
      scriptId,
      url,
      functions: [{
        functionName: '',
        ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
        isBlockCoverage: false,
      }, ...functions, ...nested],
    },
  };
}

function assertNoAnalyticalKeys(value) {
  const assert = require('assert');
  const forbidden = new Set([
    'candidate',
    'opportunity',
    'verdict',
    'priority',
    'risk',
    'rootCause',
    'recommendation',
    'removable',
    'unused',
  ]);
  function visit(current) {
    if (!current || typeof current !== 'object') return;
    for (const [key, nested] of Object.entries(current)) {
      assert(!forbidden.has(key), `forbidden analytical key: ${key}`);
      visit(nested);
    }
  }
  visit(value);
}

async function selfTest() {
  const assert = require('assert');
  const root = mkdtempSync(resolve(tmpdir(), 'runtime-coverage-normalize-'));
  try {
    const page = fixtureScript(
      'http://fixture/static/page.js',
      '11',
      [
        {
          moduleId: './a.js',
          count: 1,
          body: 'function nested() { return 1; } nested();',
        },
        {
          moduleId: './concat.js',
          count: 0,
          body: 'module.exports = 2;',
        },
      ],
    );
    const worker = fixtureScript(
      'http://fixture/static/worker.js',
      '12',
      [{ moduleId: './a.js', count: 0, body: 'module.exports = 1;' }],
      { targetId: 'worker-1', targetType: 'worker' },
    );
    const coveragePath = resolve(root, 'coverage.json');
    const loadedPath = resolve(root, 'loaded.json');
    const sourcesPath = resolve(root, 'sources.json');
    const sessionPath = resolve(root, 'session.json');
    const compilationPath = resolve(root, 'compilation.json');
    writeFileSync(coveragePath, JSON.stringify({
      targets: [
        {
          targetId: 'page-1',
          targetType: 'page',
          result: [page.coverage],
        },
        {
          targetId: 'worker-1',
          targetType: 'worker',
          result: [worker.coverage],
        },
      ],
    }));
    writeFileSync(
      loadedPath,
      JSON.stringify([page.coverage.url, worker.coverage.url]),
    );
    writeFileSync(sourcesPath, JSON.stringify({
      scripts: [
        {
          targetId: 'page-1',
          scriptId: '11',
          url: page.coverage.url,
          source: page.source,
          sha256: sha256(page.source),
        },
        {
          targetId: 'worker-1',
          scriptId: '12',
          url: worker.coverage.url,
          source: worker.source,
          sha256: sha256(worker.source),
        },
      ],
    }));
    writeFileSync(sessionPath, JSON.stringify({
      runId: 'fixture-run',
      scenarioId: 'first-screen-cold',
      capture: {
        callCount: true,
        detailed: false,
        startedAt: 1,
        startBeforeNavigation: true,
      },
      navigation: { startedAt: 2 },
      targetsExpected: [
        { targetId: 'page-1', targetType: 'page' },
        { targetId: 'worker-1', targetType: 'worker' },
      ],
    }));
    writeFileSync(compilationPath, JSON.stringify({
      schemaVersion: 2,
      kind: 'rspack-compilation-data',
      modules: [
        {
          id: './a.js',
          identifier: './a.js',
          resource: '/src/a.js',
          chunks: ['page', 'worker'],
          concatenatedModules: [],
        },
        {
          id: './concat.js',
          identifier: './concat.js',
          resource: '/src/concat.js',
          chunks: ['page'],
          concatenatedModules: ['/src/inner-a.js', '/src/inner-b.js'],
        },
      ],
      chunks: [
        {
          id: 'page',
          name: 'page',
          files: ['static/page.js'],
          canBeInitial: true,
        },
        {
          id: 'worker',
          name: 'worker',
          files: ['static/worker.js'],
          canBeInitial: false,
        },
      ],
    }));

    const outDir = resolve(root, 'out');
    const result = await normalizeRun({
      coverage: coveragePath,
      'loaded-scripts': loadedPath,
      session: sessionPath,
      'source-manifest': sourcesPath,
      compilation: compilationPath,
      'include-url-prefix': 'http://fixture/',
      'out-dir': outDir,
    });
    assert.equal(result.summary.scripts.selectedJavaScriptEntries, 2);
    assert.equal(result.summary.moduleFactories.instances, 3);
    assert.equal(result.summary.moduleFactories.zeroCountInstances, 2);
    assert.equal(result.summary.moduleFactories.positiveCountInstances, 1);
    assert.equal(result.summary.moduleFactories.duplicateInstances, 1);
    assert.equal(result.summary.moduleFactories.coarseConcatenatedInstances, 1);
    assert.equal(result.failures.length, 0);
    const modules = readFileSync(resolve(outDir, ARTIFACTS.modules), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      modules.filter((row) => row.moduleId === './a.js').length,
      2,
    );
    assert.equal(
      modules.find((row) => row.moduleId === './concat.js')
        .concatenatedModuleIdentifiers.length,
      2,
    );
    assertNoAnalyticalKeys({ summary: result.summary, modules });

    const mismatchedSourcesPath = resolve(root, 'sources-mismatch.json');
    writeFileSync(mismatchedSourcesPath, JSON.stringify({
      scripts: [{
        targetId: 'page-1',
        scriptId: '11',
        url: page.coverage.url,
        source: `${page.source}x`,
      }],
    }));
    const mismatchResult = await normalizeRun({
      coverage: coveragePath,
      'source-manifest': mismatchedSourcesPath,
      'include-url-prefix': page.coverage.url,
      'out-dir': resolve(root, 'mismatch'),
    });
    assert(
      mismatchResult.failures.some((failure) =>
        failure.code === 'SOURCE_LENGTH_MISMATCH'),
    );

    const zeroPath = resolve(root, 'zero.json');
    writeFileSync(zeroPath, '');
    assert.throws(
      () => loadJsonNonEmpty(zeroPath, 'coverage input'),
      /zero bytes/,
    );
    process.stdout.write('normalize-runtime-coverage self-test passed\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const result = await normalizeRun(args);
  process.stdout.write(`${JSON.stringify({
    outDir: result.outDir,
    manifest: result.manifest,
    summary: result.summary,
    failures: result.failures,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.stack || error.message : String(error),
      }, null, 2)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  ARTIFACTS,
  extractFactories,
  flattenCoverage,
  loadJsonNonEmpty,
  normalizeRun,
  parseArgs,
  startBeforeNavigationFact,
};
