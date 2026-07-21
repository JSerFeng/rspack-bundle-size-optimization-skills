#!/usr/bin/env node
// Compare two inventories written by ecma-module-capture-plugin.template.cjs.
// Module-set identity and source-map byte attribution remain separate: a
// generated-byte row is attached to a module only for an unambiguous one-to-one
// source key join.

const { createHash } = require('crypto');
const {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} = require('fs');
const { tmpdir } = require('os');
const { dirname, join, resolve } = require('path');

function parseArgs(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index++;
    }
  }
  return result;
}

function slash(value) {
  return String(value).replace(/\\/g, '/');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// V8 limits the length of a single JavaScript string. A large ECMA inventory can
// legitimately produce a module diff above that limit because every retained
// row preserves both sides' complete chunk and issuer evidence. Serialize each
// top-level array item independently so output size is bounded by the largest
// evidence row, rather than by the entire artifact. The JSON schema and field
// values remain unchanged.
function writeLargeJsonSync(path, value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('writeLargeJsonSync requires a JSON object root');
  }
  const maxFragmentUtf8Bytes = options.maxFragmentUtf8Bytes ?? Infinity;
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let fd;
  const write = (fragment) => {
    const buffer = Buffer.from(fragment, 'utf8');
    if (buffer.length > maxFragmentUtf8Bytes) {
      throw new Error(`JSON fragment exceeds self-test limit: ${buffer.length} > ${maxFragmentUtf8Bytes}`);
    }
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error(`failed to make progress writing JSON artifact: ${path}`);
      offset += written;
    }
  };
  const indented = (fragment, spaces) => {
    const prefix = ' '.repeat(spaces);
    return fragment.split('\n').map((line) => `${prefix}${line}`).join('\n');
  };

  try {
    fd = openSync(temporaryPath, 'wx');
    const entries = Object.entries(value);
    write('{\n');
    entries.forEach(([key, entryValue], entryIndex) => {
      write(`  ${JSON.stringify(key)}: `);
      if (Array.isArray(entryValue)) {
        write('[\n');
        entryValue.forEach((item, itemIndex) => {
          // One compact line per item both avoids a whole-document string and
          // keeps large artifacts below the ordinary Node JSON reader limit.
          // It is also directly inspectable with line-oriented tooling.
          write(`    ${JSON.stringify(item)}`);
          write(itemIndex === entryValue.length - 1 ? '\n' : ',\n');
        });
        write('  ]');
      } else {
        write(indented(JSON.stringify(entryValue, null, 2), 2).slice(2));
      }
      write(entryIndex === entries.length - 1 ? '\n' : ',\n');
    });
    write('}\n');
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function validateInventory(inventory, label) {
  if (!inventory || inventory.schemaVersion !== 1 || !Array.isArray(inventory.modules)) {
    throw new Error(`${label} is not an ECMA module inventory schemaVersion 1`);
  }
  if (!inventory.runId || !inventory.variant || !inventory.compiler?.id) {
    throw new Error(`${label} is missing runId, variant, or compiler.id`);
  }
  if (!inventory.scope?.appJsRuleId || !Array.isArray(inventory.scope?.appJsAssets)) {
    throw new Error(`${label} is missing appJsRuleId or appJsAssets scope`);
  }
}

function assertComparable(baseline, experiment) {
  validateInventory(baseline, 'baseline inventory');
  validateInventory(experiment, 'experiment inventory');
  if (baseline.runId !== experiment.runId) {
    throw new Error(`runId mismatch: baseline=${baseline.runId} experiment=${experiment.runId}`);
  }
  if (baseline.variant === experiment.variant) {
    throw new Error(`baseline and experiment variants are identical: ${baseline.variant}`);
  }
  if (baseline.compiler.id !== experiment.compiler.id) {
    throw new Error(`compiler.id mismatch: baseline=${baseline.compiler.id} experiment=${experiment.compiler.id}`);
  }
  if (resolve(baseline.compiler.context) !== resolve(experiment.compiler.context)) {
    throw new Error(`compiler context mismatch: baseline=${baseline.compiler.context} experiment=${experiment.compiler.context}`);
  }
  if (baseline.scope.appJsRuleId !== experiment.scope.appJsRuleId) {
    throw new Error(`appJsRuleId mismatch: baseline=${baseline.scope.appJsRuleId} experiment=${experiment.scope.appJsRuleId}`);
  }
}

function logicalGroups(inventory) {
  const groups = new Map();
  for (const module of inventory.modules.filter((record) => record.logicalModule !== false)) {
    const list = groups.get(module.canonicalKey) || [];
    list.push(module);
    groups.set(module.canonicalKey, list);
  }
  return groups;
}

function moduleSummary(record) {
  return {
    canonicalKey: record.canonicalKey,
    rawIdentifier: record.rawIdentifier,
    resource: record.resource,
    canonicalResource: record.canonicalResource,
    sourceMapKeys: record.sourceMapKeys || [],
    type: record.type,
    layer: record.layer,
    category: record.category,
    membershipKinds: record.membershipKinds || [],
    chunks: record.chunks || [],
    entrypoints: record.entrypoints || [],
    entryModuleFor: record.entryModuleFor || [],
    issuers: record.issuers || [],
    originalSource: record.originalSource || null,
  };
}

function stableStrings(values) {
  return [...new Set((values || []).map(String))].sort();
}

function setChange(baseline, experiment) {
  const before = stableStrings(baseline);
  const after = stableStrings(experiment);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    changed: before.length !== after.length || before.some((value, index) => value !== after[index]),
    baseline: before,
    experiment: after,
    added: after.filter((value) => !beforeSet.has(value)),
    removed: before.filter((value) => !afterSet.has(value)),
  };
}

function recordMembershipDiff(baseline, experiment) {
  return {
    chunks: setChange((baseline.chunks || []).map((chunk) => chunk.key), (experiment.chunks || []).map((chunk) => chunk.key)),
    entrypoints: setChange(baseline.entrypoints, experiment.entrypoints),
    entryModuleFor: setChange(baseline.entryModuleFor, experiment.entryModuleFor),
    issuers: setChange((baseline.issuers || []).map((issuer) => issuer.canonicalKey), (experiment.issuers || []).map((issuer) => issuer.canonicalKey)),
  };
}

function sourceStatus(baseline, experiment) {
  const before = baseline.originalSource || {};
  const after = experiment.originalSource || {};
  if (!before.available && !after.available) return 'unavailable-both';
  if (!before.available) return 'became-available';
  if (!after.available) return 'became-unavailable';
  return before.sha256 === after.sha256 ? 'identical' : 'changed';
}

function normalizeSourceKey(value) {
  return slash(value || '').replace(/^\.\//, '');
}

function generatedRows(generatedAttribution) {
  if (!generatedAttribution) return [];
  const rows = generatedAttribution.comparison?.sources;
  if (!Array.isArray(rows)) throw new Error('generated attribution is missing comparison.sources');
  return rows.filter((row) => row?.source && row.source !== '<unmapped>').map((row) => ({ ...row, normalizedSource: normalizeSourceKey(row.source) }));
}

function canonicalSourceCandidate(row) {
  const identities = ['baseline', 'experiment']
    .map((side) => ({ side, identity: row.sourceIdentity?.[side] }))
    .filter(({ identity }) => identity != null);
  const ambiguousSides = identities
    .filter(({ identity }) => identity.status === 'ambiguous')
    .map(({ side }) => side);
  const unresolvedSides = identities
    .filter(({ identity }) => identity.status !== 'canonical' && identity.status !== 'ambiguous')
    .map(({ side }) => side);
  if (ambiguousSides.length > 0) {
    return { status: 'ambiguous', ambiguousSides, unresolvedSides, values: [] };
  }
  if (unresolvedSides.length > 0) {
    return { status: 'unavailable', ambiguousSides: [], unresolvedSides, values: [] };
  }
  const candidates = [];
  for (const { side, identity } of identities) {
    for (const candidate of identity.canonicalCandidates || []) {
      if (
        candidate?.kind !== 'absolute-path' ||
        candidate.filesystemVerified !== true ||
        !candidate.value
      ) continue;
      candidates.push({
        side,
        value: slash(candidate.value),
        provenance: candidate.provenance || null,
      });
    }
  }
  const values = stableStrings(candidates.map((candidate) => candidate.value));
  if (values.length > 1) {
    return {
      status: 'ambiguous',
      ambiguousSides,
      unresolvedSides,
      values,
    };
  }
  if (values.length === 0) return { status: 'unavailable', ambiguousSides: [], unresolvedSides: [], values: [] };
  const value = values[0];
  return {
    status: 'canonical',
    value,
    sides: stableStrings(candidates.filter((candidate) => candidate.value === value).map((candidate) => candidate.side)),
    provenance: stableStrings(candidates.filter((candidate) => candidate.value === value).map((candidate) => candidate.provenance).filter(Boolean)),
  };
}

function buildGeneratedJoiner(allRecords, generatedAttribution) {
  if (!generatedAttribution) {
    return () => ({ status: 'not-provided', metricKind: 'per-source-generated-byte-attribution' });
  }
  const rows = generatedRows(generatedAttribution);
  const rowsBySource = new Map();
  for (const row of rows) {
    const list = rowsBySource.get(row.normalizedSource) || [];
    list.push(row);
    rowsBySource.set(row.normalizedSource, list);
  }
  const owners = new Map();
  const resourceOwners = new Map();
  for (const record of allRecords) {
    for (const key of record.sourceMapKeys || []) {
      const normalized = normalizeSourceKey(key);
      if (!normalized) continue;
      const set = owners.get(normalized) || new Set();
      set.add(record.canonicalKey);
      owners.set(normalized, set);
    }
    if (record.resource) {
      const normalized = slash(record.resource);
      const set = resourceOwners.get(normalized) || new Set();
      set.add(record.canonicalKey);
      resourceOwners.set(normalized, set);
    }
  }
  const rowsByCanonicalSource = new Map();
  const canonicalCandidateByRow = new Map();
  for (const row of rows) {
    const candidate = canonicalSourceCandidate(row);
    canonicalCandidateByRow.set(row, candidate);
    if (candidate.status !== 'canonical') continue;
    const list = rowsByCanonicalSource.get(candidate.value) || [];
    list.push(row);
    rowsByCanonicalSource.set(candidate.value, list);
  }
  return (record) => {
    const exactMatches = [];
    for (const key of record.sourceMapKeys || []) {
      const normalized = normalizeSourceKey(key);
      for (const row of rowsBySource.get(normalized) || []) exactMatches.push({ key: normalized, row });
    }
    let matches = exactMatches;
    let joinKind = 'exact-source-map-key';
    if (matches.length === 0 && record.resource) {
      const resource = slash(record.resource);
      matches = (rowsByCanonicalSource.get(resource) || []).map((row) => ({ key: resource, row }));
      joinKind = 'exact-canonical-filesystem-candidate';
    }
    const unique = new Map(matches.map((match) => [match.row.normalizedSource, match]));
    if (unique.size === 0) return { status: 'no-match', metricKind: 'per-source-generated-byte-attribution' };
    if (unique.size > 1) {
      return { status: 'ambiguous-source-rows', candidates: [...unique.keys()].sort(), metricKind: 'per-source-generated-byte-attribution' };
    }
    const match = [...unique.values()][0];
    const candidate = canonicalCandidateByRow.get(match.row) || { status: 'unavailable' };
    if (joinKind === 'exact-canonical-filesystem-candidate' && candidate.status !== 'canonical') {
      return {
        status: 'ambiguous-canonical-source-candidates',
        source: match.row.source,
        candidates: candidate.values || [],
        ambiguousSides: candidate.ambiguousSides || [],
        metricKind: 'per-source-generated-byte-attribution',
      };
    }
    const keyOwners = joinKind === 'exact-source-map-key'
      ? owners.get(match.key) || new Set()
      : resourceOwners.get(match.key) || new Set();
    if (keyOwners.size !== 1 || !keyOwners.has(record.canonicalKey)) {
      return {
        status: 'ambiguous-module-source-join',
        source: match.row.source,
        ownerCanonicalKeys: [...keyOwners].sort(),
        metricKind: 'per-source-generated-byte-attribution',
      };
    }
    return {
      status: 'exact-one-to-one-source-key',
      // The sourceIdentity candidate and its raw/resolved/provenance evidence
      // remain in the generated attribution artifact. Avoid duplicating that
      // large structure in every retained module row; joinKind plus source and
      // the module's resource make the exact equality independently checkable.
      joinKind,
      source: match.row.source,
      baselineBytes: Number(match.row.baselineBytes || 0),
      experimentBytes: Number(match.row.experimentBytes || 0),
      deltaBytes: Number(match.row.deltaBytes || 0),
      savedBytes: Number(match.row.savedBytes || 0),
      classification: match.row.classification,
      metricKind: 'per-source-generated-byte-attribution',
    };
  };
}

function sourceScopeIssues(inventory, side, analysis) {
  if (!analysis) return [{ type: 'generated-attribution-side-missing', side }];
  const expected = stableStrings(inventory.scope.appJsAssets.map(normalizeSourceKey));
  const actual = stableStrings((analysis.assets || []).map((asset) => normalizeSourceKey(asset.asset)));
  const issues = [];
  const change = setChange(expected, actual);
  if (change.changed) {
    issues.push({ type: 'generated-attribution-app-js-assets-mismatch', side, expected, actual, added: change.added, removed: change.removed });
  }
  for (const issue of analysis.dataQuality || []) issues.push({ ...issue, side });
  return issues;
}

function generatedAttributionIssues(baseline, experiment, generatedAttribution) {
  if (!generatedAttribution) return [{ type: 'generated-attribution-not-provided' }];
  return [
    ...sourceScopeIssues(baseline, 'baseline', generatedAttribution.baseline),
    ...sourceScopeIssues(experiment, 'experiment', generatedAttribution.experiment),
  ];
}

function compareInventories(baseline, experiment, generatedAttribution = null) {
  assertComparable(baseline, experiment);
  const baselineGroups = logicalGroups(baseline);
  const experimentGroups = logicalGroups(experiment);
  const canonicalKeys = [...new Set([...baselineGroups.keys(), ...experimentGroups.keys()])].sort();
  const uniqueRecords = [];
  for (const key of canonicalKeys) {
    const before = baselineGroups.get(key) || [];
    const after = experimentGroups.get(key) || [];
    if (before.length === 1) uniqueRecords.push(before[0]);
    if (after.length === 1) uniqueRecords.push(after[0]);
  }
  const joinGenerated = buildGeneratedJoiner(uniqueRecords, generatedAttribution);
  const added = [];
  const removed = [];
  const retained = [];
  const ambiguous = [];

  for (const canonicalKey of canonicalKeys) {
    const before = baselineGroups.get(canonicalKey) || [];
    const after = experimentGroups.get(canonicalKey) || [];
    if (before.length > 1 || after.length > 1) {
      ambiguous.push({
        canonicalKey,
        reason: 'canonical-key-collision',
        baseline: before.map(moduleSummary),
        experiment: after.map(moduleSummary),
      });
      continue;
    }
    if (before.length === 0) {
      added.push({ ...moduleSummary(after[0]), generatedByteAttribution: joinGenerated(after[0]) });
      continue;
    }
    if (after.length === 0) {
      removed.push({ ...moduleSummary(before[0]), generatedByteAttribution: joinGenerated(before[0]) });
      continue;
    }
    const membership = recordMembershipDiff(before[0], after[0]);
    retained.push({
      canonicalKey,
      baseline: moduleSummary(before[0]),
      experiment: moduleSummary(after[0]),
      membership,
      membershipChanged: Object.values(membership).some((change) => change.changed),
      postLoaderSourceStatus: sourceStatus(before[0], after[0]),
      postLoaderSourceUtf8ByteDeltaDiagnostic:
        Number(after[0].originalSource?.utf8Bytes || 0) - Number(before[0].originalSource?.utf8Bytes || 0),
      generatedByteAttribution: joinGenerated(after[0]),
    });
  }

  const generatedIssues = generatedAttributionIssues(baseline, experiment, generatedAttribution);
  const joinedGeneratedSources = new Set();
  for (const record of [...added, ...removed, ...retained]) {
    if (record.generatedByteAttribution?.status === 'exact-one-to-one-source-key') {
      joinedGeneratedSources.add(normalizeSourceKey(record.generatedByteAttribution.source));
    }
  }
  const changedGeneratedSources = generatedRows(generatedAttribution)
    .filter((row) => Number(row.deltaBytes || 0) !== 0)
    .sort((a, b) => Math.abs(Number(b.deltaBytes || 0)) - Math.abs(Number(a.deltaBytes || 0)) || a.source.localeCompare(b.source));
  const unjoinedGeneratedSources = changedGeneratedSources
    .filter((row) => !joinedGeneratedSources.has(row.normalizedSource))
    .map(({ normalizedSource, ...row }) => ({
      ...row,
      joinStatus: canonicalSourceCandidate(row).status === 'ambiguous'
        ? 'source-only-ambiguous-canonical-candidates'
        : 'source-only-unjoined',
    }));
  const dataQuality = [
    ...(baseline.dataQuality || []).map((issue) => ({ ...issue, side: 'baseline-capture' })),
    ...(experiment.dataQuality || []).map((issue) => ({ ...issue, side: 'experiment-capture' })),
    ...generatedIssues,
  ];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: baseline.runId,
    compilerId: baseline.compiler.id,
    variants: { baseline: baseline.variant, experiment: experiment.variant },
    scope: {
      appJsRuleId: baseline.scope.appJsRuleId,
      baselineAppJsAssets: baseline.scope.appJsAssets,
      experimentAppJsAssets: experiment.scope.appJsAssets,
    },
    generatedByteSummary: generatedAttribution ? {
      metric: generatedAttribution.metric || null,
      rawDeltaBytes: generatedAttribution.comparison?.rawDeltaBytes ?? null,
      gzipDeltaBytes: generatedAttribution.comparison?.gzipDeltaBytes ?? null,
      baselineMappedBytes: generatedAttribution.baseline?.mappedBytes ?? null,
      experimentMappedBytes: generatedAttribution.experiment?.mappedBytes ?? null,
      mappedDeltaBytes: generatedAttribution.comparison?.mappedDeltaBytes ??
        ((generatedAttribution.experiment?.mappedBytes ?? 0) - (generatedAttribution.baseline?.mappedBytes ?? 0)),
      baselineUnmappedBytes: generatedAttribution.baseline?.unmappedBytes ?? null,
      experimentUnmappedBytes: generatedAttribution.experiment?.unmappedBytes ?? null,
      unmappedDeltaBytes: generatedAttribution.comparison?.unmappedDeltaBytes ??
        ((generatedAttribution.experiment?.unmappedBytes ?? 0) - (generatedAttribution.baseline?.unmappedBytes ?? 0)),
    } : null,
    counts: {
      baselineLogicalModules: [...baselineGroups.values()].reduce((sum, list) => sum + list.length, 0),
      experimentLogicalModules: [...experimentGroups.values()].reduce((sum, list) => sum + list.length, 0),
      added: added.length,
      removed: removed.length,
      retained: retained.length,
      ambiguousCanonicalKeys: ambiguous.length,
      retainedPostLoaderChanged: retained.filter((row) => row.postLoaderSourceStatus === 'changed').length,
      retainedPostLoaderIdentical: retained.filter((row) => row.postLoaderSourceStatus === 'identical').length,
      retainedGeneratedShrunk: retained.filter((row) => row.generatedByteAttribution.status === 'exact-one-to-one-source-key' && row.generatedByteAttribution.deltaBytes < 0).length,
      retainedGeneratedGrown: retained.filter((row) => row.generatedByteAttribution.status === 'exact-one-to-one-source-key' && row.generatedByteAttribution.deltaBytes > 0).length,
      changedGeneratedSources: changedGeneratedSources.length,
      changedGeneratedSourcesJoinedOneToOne: changedGeneratedSources.filter((row) => joinedGeneratedSources.has(row.normalizedSource)).length,
      changedGeneratedSourcesUnjoined: unjoinedGeneratedSources.length,
    },
    complete: ambiguous.length === 0 && dataQuality.length === 0,
    metricWarnings: [
      'Module identity is independent from stats module.size; this artifact contains no emitted saving derived from module.size.',
      'Post-loader source UTF-8 bytes are diagnostic source scope, not minified emitted bytes.',
      'Generated bytes are attributed per source map source and joined to a module only when the source key has exactly one module owner.',
    ],
    dataQuality,
    added,
    removed,
    retained,
    ambiguous,
    unjoinedGeneratedSources,
  };
}

function validateSourceArtifacts(inventory, inventoryPath, side) {
  const issues = [];
  for (const record of inventory.modules.filter((module) => module.logicalModule !== false)) {
    const meta = record.originalSource || {};
    if (!meta.available) continue;
    if (!meta.artifact) {
      issues.push({ type: 'source-artifact-path-missing', side, canonicalKey: record.canonicalKey });
      continue;
    }
    const path = resolve(dirname(inventoryPath), meta.artifact);
    if (!existsSync(path)) {
      issues.push({ type: 'source-artifact-missing', side, canonicalKey: record.canonicalKey, path });
      continue;
    }
    const bytes = readFileSync(path);
    const actualHash = sha256(bytes);
    if (actualHash !== meta.sha256) issues.push({ type: 'source-artifact-hash-mismatch', side, canonicalKey: record.canonicalKey, expected: meta.sha256, actual: actualHash, path });
    if (bytes.length !== meta.utf8Bytes) issues.push({ type: 'source-artifact-byte-mismatch', side, canonicalKey: record.canonicalKey, expected: meta.utf8Bytes, actual: bytes.length, path });
  }
  return issues;
}

function resolveArtifact(inventoryPath, meta) {
  return meta?.artifact ? resolve(dirname(inventoryPath), meta.artifact) : null;
}

function changedRegion(baselineSource, experimentSource) {
  if (baselineSource == null || experimentSource == null || baselineSource === experimentSource) return null;
  const before = baselineSource.split(/\r?\n/);
  const after = experimentSource.split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  return {
    baseline: {
      startLine: beforeEnd > prefix ? prefix + 1 : null,
      endLine: beforeEnd > prefix ? beforeEnd : null,
      preview: before.slice(prefix, Math.min(beforeEnd, prefix + 8)),
    },
    experiment: {
      startLine: afterEnd > prefix ? prefix + 1 : null,
      endLine: afterEnd > prefix ? afterEnd : null,
      preview: after.slice(prefix, Math.min(afterEnd, prefix + 8)),
    },
    previewTruncated: beforeEnd - prefix > 8 || afterEnd - prefix > 8,
  };
}

function readArtifactText(path) {
  return path && existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function makeSourceDiff(moduleDiff, baselinePath, experimentPath) {
  const rows = [];
  for (const retained of moduleDiff.retained) {
    const baselineArtifact = resolveArtifact(baselinePath, retained.baseline.originalSource);
    const experimentArtifact = resolveArtifact(experimentPath, retained.experiment.originalSource);
    const row = {
      canonicalKey: retained.canonicalKey,
      resource: retained.experiment.resource || retained.baseline.resource,
      category: retained.experiment.category,
      moduleSetStatus: 'retained',
      postLoaderSourceStatus: retained.postLoaderSourceStatus,
      postLoaderSourceUtf8ByteDeltaDiagnostic: retained.postLoaderSourceUtf8ByteDeltaDiagnostic,
      baseline: { ...retained.baseline.originalSource, artifactAbsolute: baselineArtifact },
      experiment: { ...retained.experiment.originalSource, artifactAbsolute: experimentArtifact },
      changedRegion: changedRegion(readArtifactText(baselineArtifact), readArtifactText(experimentArtifact)),
      diffCommand: baselineArtifact && experimentArtifact ? ['diff', '-u', baselineArtifact, experimentArtifact] : null,
      membershipChanged: retained.membershipChanged,
      generatedByteAttribution: retained.generatedByteAttribution,
    };
    const generatedChanged = row.generatedByteAttribution?.status === 'exact-one-to-one-source-key' && Number(row.generatedByteAttribution.deltaBytes || 0) !== 0;
    const sourceNeedsReview = !['identical', 'unavailable-both'].includes(row.postLoaderSourceStatus);
    if (generatedChanged || sourceNeedsReview || row.membershipChanged) rows.push(row);
  }
  for (const record of moduleDiff.removed) {
    rows.push({
      canonicalKey: record.canonicalKey,
      resource: record.resource,
      category: record.category,
      moduleSetStatus: 'removed',
      postLoaderSourceStatus: 'module-removed',
      baseline: { ...record.originalSource, artifactAbsolute: resolveArtifact(baselinePath, record.originalSource) },
      experiment: null,
      changedRegion: null,
      diffCommand: null,
      generatedByteAttribution: record.generatedByteAttribution,
    });
  }
  for (const record of moduleDiff.added) {
    rows.push({
      canonicalKey: record.canonicalKey,
      resource: record.resource,
      category: record.category,
      moduleSetStatus: 'added',
      postLoaderSourceStatus: 'module-added',
      baseline: null,
      experiment: { ...record.originalSource, artifactAbsolute: resolveArtifact(experimentPath, record.originalSource) },
      changedRegion: null,
      diffCommand: null,
      generatedByteAttribution: record.generatedByteAttribution,
    });
  }
  for (const collision of moduleDiff.ambiguous) {
    rows.push({
      canonicalKey: collision.canonicalKey,
      resource: collision.experiment[0]?.resource || collision.baseline[0]?.resource || null,
      category: 'ambiguous',
      moduleSetStatus: 'ambiguous',
      postLoaderSourceStatus: 'identity-ambiguous',
      baseline: collision.baseline.map((record) => record.originalSource),
      experiment: collision.experiment.map((record) => record.originalSource),
      changedRegion: null,
      diffCommand: null,
      generatedByteAttribution: { status: 'not-joined-ambiguous-module-identity', metricKind: 'per-source-generated-byte-attribution' },
    });
  }
  for (const source of moduleDiff.unjoinedGeneratedSources || []) {
    rows.push({
      canonicalKey: `source:${source.source}`,
      resource: source.source,
      category: 'source-map-source',
      moduleSetStatus: 'source-only',
      postLoaderSourceStatus: 'module-join-unavailable',
      baseline: null,
      experiment: null,
      changedRegion: null,
      diffCommand: null,
      generatedByteAttribution: {
        status: source.joinStatus || 'source-only-unjoined',
        source: source.source,
        baselineBytes: source.baselineBytes,
        experimentBytes: source.experimentBytes,
        deltaBytes: source.deltaBytes,
        savedBytes: source.savedBytes,
        classification: source.classification,
        metricKind: 'per-source-generated-byte-attribution',
      },
    });
  }

  const score = (row) => {
    const generated = row.generatedByteAttribution;
    if (generated?.status === 'exact-one-to-one-source-key') return Math.abs(Number(generated.deltaBytes || 0)) * 1000 + 1;
    const before = Number(row.baseline?.utf8Bytes || 0);
    const after = Number(row.experiment?.utf8Bytes || 0);
    return Math.abs(after - before);
  };
  rows.sort((a, b) => score(b) - score(a) || a.canonicalKey.localeCompare(b.canonicalKey));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: moduleDiff.runId,
    compilerId: moduleDiff.compilerId,
    metricWarning: 'Worklist order uses exact one-to-one per-source generated-byte attribution when available; post-loader UTF-8 bytes are diagnostic only.',
    rows,
  };
}

function markdownEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function worklistMarkdown(sourceDiff, moduleDiff) {
  const lines = [
    '# ECMA Post-Loader Source Review Worklist',
    '',
    `Run: ${moduleDiff.runId}`,
    '',
    `Compiler: ${moduleDiff.compilerId}`,
    '',
    `Complete: ${moduleDiff.complete ? 'yes' : 'no'}`,
    '',
    `AppJs raw delta: ${moduleDiff.generatedByteSummary?.rawDeltaBytes ?? 'unavailable'} B`,
    '',
    `Mapped / unmapped delta: ${moduleDiff.generatedByteSummary?.mappedDeltaBytes ?? 'unavailable'} B / ${moduleDiff.generatedByteSummary?.unmappedDeltaBytes ?? 'unavailable'} B`,
    '',
    '> Source-map rows are per-source emitted-byte attribution. They are joined to a module only when the source key has exactly one owner. Post-loader source bytes and stats module.size are never counted as emitted savings.',
    '',
    '| priority | module set | source status | generated delta | join | post-loader byte delta (diagnostic) | resource | action |',
    '| ---: | --- | --- | ---: | --- | ---: | --- | --- |',
  ];
  sourceDiff.rows.forEach((row, index) => {
    const generated = row.generatedByteAttribution || {};
    const generatedDelta = generated.status === 'exact-one-to-one-source-key' ? generated.deltaBytes : '';
    const sourceDelta = row.postLoaderSourceUtf8ByteDeltaDiagnostic ?? '';
    const action = row.postLoaderSourceStatus === 'changed'
      ? 'read complete artifacts and run diffCommand; name the exact transform'
      : row.postLoaderSourceStatus === 'identical' && generatedDelta !== 0 && generatedDelta !== ''
        ? 'inspect minifier and Rspack codegen/chunk context'
        : row.moduleSetStatus === 'added' || row.moduleSetStatus === 'removed'
          ? 'prove the graph connection, helper, or polyfill injection rule'
          : row.moduleSetStatus === 'ambiguous'
            ? 'repair canonical identity collision before attribution'
            : row.moduleSetStatus === 'source-only'
              ? 'keep this as source-level evidence or prove a unique module join'
            : 'review only if needed to reconcile residual';
    lines.push(`| ${index + 1} | ${markdownEscape(row.moduleSetStatus)} | ${markdownEscape(row.postLoaderSourceStatus)} | ${generatedDelta} | ${markdownEscape(generated.status)} | ${sourceDelta} | ${markdownEscape(row.resource || row.canonicalKey)} | ${markdownEscape(action)} |`);
  });
  lines.push('', '## Data quality', '');
  if (moduleDiff.dataQuality.length === 0) lines.push('- No data-quality issue recorded.');
  else for (const issue of moduleDiff.dataQuality) lines.push(`- ${markdownEscape(JSON.stringify(issue))}`);
  lines.push('', '## Required agent conclusion', '', '- Reconcile the exact appJs raw delta with mapped source rows and the explicitly reported unmapped residual.', '- For each top row, record whether the cause is loader lowering, helper/polyfill injection, Rspack code generation, concatenation/chunk context, or minifier-only output.', '- Do not convert post-loader source bytes or stats module.size into a saving claim.');
  return `${lines.join('\n')}\n`;
}

function writeOutputs({ baselinePath, experimentPath, generatedPath, outDir, moduleOut, sourceOut, worklistOut, requireGeneratedAttribution }) {
  const baseline = readJson(baselinePath);
  const experiment = readJson(experimentPath);
  const generated = generatedPath ? readJson(generatedPath) : null;
  const moduleDiff = compareInventories(baseline, experiment, generated);
  moduleDiff.dataQuality.push(
    ...validateSourceArtifacts(baseline, baselinePath, 'baseline-source-artifact'),
    ...validateSourceArtifacts(experiment, experimentPath, 'experiment-source-artifact'),
  );
  if (requireGeneratedAttribution && moduleDiff.dataQuality.some((issue) => issue.type === 'generated-attribution-not-provided')) {
    moduleDiff.dataQuality.push({ type: 'required-generated-attribution-missing' });
  }
  moduleDiff.complete = moduleDiff.ambiguous.length === 0 && moduleDiff.dataQuality.length === 0;
  const sourceDiff = makeSourceDiff(moduleDiff, baselinePath, experimentPath);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(dirname(moduleOut), { recursive: true });
  mkdirSync(dirname(sourceOut), { recursive: true });
  mkdirSync(dirname(worklistOut), { recursive: true });
  writeLargeJsonSync(moduleOut, moduleDiff);
  writeLargeJsonSync(sourceOut, sourceDiff);
  writeFileSync(worklistOut, worklistMarkdown(sourceDiff, moduleDiff), 'utf8');
  return { moduleDiff, sourceDiff };
}

function fixtureRecord(key, sourceHash, bytes, extra = {}) {
  return {
    canonicalKey: key,
    rawIdentifier: key,
    resource: `/repo/${key}.js`,
    canonicalResource: `project:${key}.js`,
    sourceMapKeys: [`${key}.js`],
    type: 'javascript/auto',
    layer: null,
    category: 'normal',
    logicalModule: true,
    chunks: [{ key: 'name:main' }],
    entrypoints: ['main'],
    entryModuleFor: [],
    issuers: [],
    originalSource: { available: true, sha256: sourceHash, utf8Bytes: bytes, metricKind: 'post-loader-source-diagnostic', quality: {}, artifact: `sources/${sourceHash}.txt` },
    ...extra,
  };
}

function fixtureInventory(variant, modules) {
  return {
    schemaVersion: 1,
    runId: 'run-test',
    variant,
    compiler: { id: 'web', context: '/repo' },
    scope: { appJsRuleId: 'all-js-v1', appJsAssets: ['main.js'] },
    modules,
    dataQuality: [],
  };
}

function selfTest() {
  const baseline = fixtureInventory('baseline', [
    fixtureRecord('a', 'a-old', 20),
    fixtureRecord('removed', 'removed', 30),
    fixtureRecord('collision', 'c1', 10),
    fixtureRecord('collision', 'c2', 11),
  ]);
  const experiment = fixtureInventory('ecma', [
    fixtureRecord('a', 'a-new', 12),
    fixtureRecord('added', 'added', 15),
    fixtureRecord('collision', 'c3', 9),
  ]);
  const generated = {
    baseline: { assets: [{ asset: 'main.js' }], dataQuality: [] },
    experiment: { assets: [{ asset: 'main.js' }], dataQuality: [] },
    comparison: { sources: [{ source: 'a.js', baselineBytes: 100, experimentBytes: 60, deltaBytes: -40, savedBytes: 40, classification: 'shrunk' }] },
  };
  const diff = compareInventories(baseline, experiment, generated);
  if (diff.added.length !== 1 || diff.removed.length !== 1 || diff.retained.length !== 1 || diff.ambiguous.length !== 1) throw new Error('module classification self-test failed');
  if (diff.retained[0].generatedByteAttribution.status !== 'exact-one-to-one-source-key' || diff.retained[0].generatedByteAttribution.savedBytes !== 40) throw new Error('generated-byte join self-test failed');
  if (diff.retained[0].generatedByteAttribution.joinKind !== 'exact-source-map-key') throw new Error('exact source-key priority self-test failed');
  if (diff.retained[0].postLoaderSourceStatus !== 'changed' || diff.retained[0].postLoaderSourceUtf8ByteDeltaDiagnostic !== -8) throw new Error('post-loader diff self-test failed');

  const canonicalIdentity = (value, rawSource) => ({
    status: 'canonical',
    rawSources: [rawSource],
    resolvedSources: [rawSource.replace(/\.\.\//g, '')],
    canonicalCandidates: [{
      kind: 'absolute-path',
      value,
      provenance: 'raw-webpack-url-relative-to-compiler-context',
      rawSource,
      resolvedSource: rawSource.replace(/\.\.\//g, ''),
      compilerContext: '/repo/packages/L4-Entry/app',
      filesystemVerified: true,
    }],
  });
  const canonicalGenerated = {
    baseline: { assets: [{ asset: 'main.js' }], dataQuality: [] },
    experiment: { assets: [{ asset: 'main.js' }], dataQuality: [] },
    comparison: {
      sources: [
        {
          source: 'app/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js?raw#part',
          baselineBytes: 20,
          experimentBytes: 10,
          deltaBytes: -10,
          savedBytes: 10,
          classification: 'shrunk',
          sourceIdentity: {
            baseline: canonicalIdentity('/repo/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js?raw#part', 'webpack://app/../../../node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js?raw#part'),
            experiment: canonicalIdentity('/repo/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js?raw#part', 'webpack://app/../../../node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js?raw#part'),
          },
        },
        {
          source: 'app/L2-Core/chat/index.ts',
          baselineBytes: 30,
          experimentBytes: 20,
          deltaBytes: -10,
          savedBytes: 10,
          classification: 'shrunk',
          sourceIdentity: {
            baseline: canonicalIdentity('/repo/packages/L2-Core/chat/index.ts', 'webpack://app/../../L2-Core/chat/index.ts'),
            experiment: canonicalIdentity('/repo/packages/L2-Core/chat/index.ts', 'webpack://app/../../L2-Core/chat/index.ts'),
          },
        },
      ],
    },
  };
  const nodeModuleRecord = fixtureRecord('node-module', 'node-module', 10, {
    resource: '/repo/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js?raw#part',
    sourceMapKeys: ['/repo/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js?raw#part'],
  });
  const workspaceRecord = fixtureRecord('workspace', 'workspace', 10, {
    resource: '/repo/packages/L2-Core/chat/index.ts',
    sourceMapKeys: ['/repo/packages/L2-Core/chat/index.ts'],
  });
  const canonicalJoin = buildGeneratedJoiner([nodeModuleRecord, workspaceRecord], canonicalGenerated);
  const nodeModuleJoin = canonicalJoin(nodeModuleRecord);
  const workspaceJoin = canonicalJoin(workspaceRecord);
  if (
    nodeModuleJoin.status !== 'exact-one-to-one-source-key' ||
    nodeModuleJoin.joinKind !== 'exact-canonical-filesystem-candidate'
  ) throw new Error('canonical node_modules source join self-test failed');
  if (
    workspaceJoin.status !== 'exact-one-to-one-source-key' ||
    workspaceJoin.joinKind !== 'exact-canonical-filesystem-candidate'
  ) throw new Error('canonical monorepo source join self-test failed');

  const duplicateResourceRecord = fixtureRecord('duplicate-resource', 'duplicate-resource', 10, {
    resource: workspaceRecord.resource,
    sourceMapKeys: [workspaceRecord.resource],
  });
  const ambiguousOwnerJoin = buildGeneratedJoiner([workspaceRecord, duplicateResourceRecord], canonicalGenerated)(workspaceRecord);
  if (ambiguousOwnerJoin.status !== 'ambiguous-module-source-join' || ambiguousOwnerJoin.ownerCanonicalKeys.length !== 2) {
    throw new Error('canonical source multiple-owner self-test failed');
  }
  const ambiguousCandidateGenerated = JSON.parse(JSON.stringify(canonicalGenerated));
  ambiguousCandidateGenerated.comparison.sources[1].sourceIdentity.experiment.canonicalCandidates[0].value = '/repo/packages/L3-Platform/chat/index.ts';
  const ambiguousCandidateJoin = buildGeneratedJoiner([workspaceRecord], ambiguousCandidateGenerated)(workspaceRecord);
  if (ambiguousCandidateJoin.status !== 'no-match') throw new Error('ambiguous canonical candidate must not be guessed self-test failed');
  const unresolvedCandidateGenerated = JSON.parse(JSON.stringify(canonicalGenerated));
  unresolvedCandidateGenerated.comparison.sources[1].sourceIdentity.baseline.status = 'unresolved';
  const unresolvedCandidateJoin = buildGeneratedJoiner([workspaceRecord], unresolvedCandidateGenerated)(workspaceRecord);
  if (unresolvedCandidateJoin.status !== 'no-match') throw new Error('unresolved canonical candidate must not be joined self-test failed');
  const temp = mkdtempSync(join(tmpdir(), 'ecma-module-diff-'));
  try {
    const oldSource = 'export async function value() { return 1; }\n';
    const newSource = 'export function value() { return Promise.resolve(1); }\n';
    const oldHash = sha256(Buffer.from(oldSource));
    const newHash = sha256(Buffer.from(newSource));
    const baselineDir = resolve(temp, 'baseline');
    const experimentDir = resolve(temp, 'experiment');
    mkdirSync(resolve(baselineDir, 'sources'), { recursive: true });
    mkdirSync(resolve(experimentDir, 'sources'), { recursive: true });
    writeFileSync(resolve(baselineDir, 'sources', `${oldHash}.txt`), oldSource);
    writeFileSync(resolve(experimentDir, 'sources', `${newHash}.txt`), newSource);
    const baselinePath = resolve(baselineDir, 'inventory.json');
    const experimentPath = resolve(experimentDir, 'inventory.json');
    const baselineE2e = fixtureInventory('baseline', [fixtureRecord('a', oldHash, Buffer.byteLength(oldSource))]);
    const experimentE2e = fixtureInventory('target-policy', [fixtureRecord('a', newHash, Buffer.byteLength(newSource))]);
    writeFileSync(baselinePath, `${JSON.stringify(baselineE2e)}\n`);
    writeFileSync(experimentPath, `${JSON.stringify(experimentE2e)}\n`);
    const generatedPath = resolve(temp, 'generated.json');
    writeFileSync(generatedPath, `${JSON.stringify(generated)}\n`);
    const outDir = resolve(temp, 'out');
    const output = writeOutputs({
      baselinePath,
      experimentPath,
      generatedPath,
      outDir,
      moduleOut: resolve(outDir, 'module-diff.json'),
      sourceOut: resolve(outDir, 'post-loader-source-diff.json'),
      worklistOut: resolve(outDir, 'post-loader-source-worklist.md'),
      requireGeneratedAttribution: true,
    });
    if (!output.moduleDiff.complete || !existsSync(resolve(outDir, 'post-loader-source-worklist.md'))) throw new Error('end-to-end output self-test failed');
    const writtenModuleDiff = readJson(resolve(outDir, 'module-diff.json'));
    const writtenSourceDiff = readJson(resolve(outDir, 'post-loader-source-diff.json'));
    if (writtenModuleDiff.schemaVersion !== 1 || writtenModuleDiff.retained.length !== 1) throw new Error('streamed module-diff schema compatibility self-test failed');
    if (writtenSourceDiff.schemaVersion !== 1 || writtenSourceDiff.rows.length !== 1) throw new Error('streamed source-diff schema compatibility self-test failed');

    // Exercise the scaling boundary without allocating one aggregate JSON
    // string. The deliberately small fragment ceiling would reject a writer
    // that stringified all 32K rows together, while every individual row fits.
    const largeRowCount = 32 * 1024;
    const largePath = resolve(temp, 'large-streamed.json');
    const largeValue = {
      schemaVersion: 1,
      kind: 'ecma-module-diff-large-synthetic',
      rows: Array.from({ length: largeRowCount }, (_, index) => ({
        canonicalKey: `module-${String(index).padStart(5, '0')}`,
        baseline: { issuers: [`issuer-${index % 4096}`], chunks: [`chunk-${index % 1024}`] },
        experiment: { issuers: [`issuer-${index % 4096}`], chunks: [`chunk-${index % 1024}`] },
      })),
      complete: true,
    };
    writeLargeJsonSync(largePath, largeValue, { maxFragmentUtf8Bytes: 4096 });
    const writtenLarge = readJson(largePath);
    if (
      writtenLarge.schemaVersion !== 1 ||
      writtenLarge.rows.length !== largeRowCount ||
      writtenLarge.rows[0].canonicalKey !== 'module-00000' ||
      writtenLarge.rows.at(-1).canonicalKey !== `module-${largeRowCount - 1}` ||
      writtenLarge.complete !== true
    ) {
      throw new Error('large streamed JSON self-test failed');
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log('ecma-module-diff self-test passed');
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  if (!args.baseline || !args.experiment) throw new Error('usage: ecma-module-diff.cjs --baseline <inventory.json> --experiment <inventory.json> [--generated-attribution <json>] --out-dir <dir>');
  const baselinePath = resolve(args.baseline);
  const experimentPath = resolve(args.experiment);
  const generatedPath = args['generated-attribution'] ? resolve(args['generated-attribution']) : null;
  const outDir = resolve(args['out-dir'] || dirname(baselinePath));
  const moduleOut = args['module-out'] ? resolve(args['module-out']) : resolve(outDir, 'module-diff.json');
  const sourceOut = args['source-out'] ? resolve(args['source-out']) : resolve(outDir, 'post-loader-source-diff.json');
  const worklistOut = args['worklist-out'] ? resolve(args['worklist-out']) : resolve(outDir, 'post-loader-source-worklist.md');
  const result = writeOutputs({
    baselinePath,
    experimentPath,
    generatedPath,
    outDir,
    moduleOut,
    sourceOut,
    worklistOut,
    requireGeneratedAttribution: Boolean(args['require-generated-attribution']),
  });
  console.log(`added=${result.moduleDiff.counts.added} removed=${result.moduleDiff.counts.removed} retained=${result.moduleDiff.counts.retained} ambiguous=${result.moduleDiff.counts.ambiguousCanonicalKeys}`);
  console.log(`wrote ${moduleOut}`);
  console.log(`wrote ${sourceOut}`);
  console.log(`wrote ${worklistOut}`);
  if (!result.moduleDiff.complete) {
    console.error('ECMA module/source diff is incomplete; inspect dataQuality and ambiguous rows.');
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  assertComparable,
  buildGeneratedJoiner,
  changedRegion,
  compareInventories,
  generatedAttributionIssues,
  makeSourceDiff,
  parseArgs,
  setChange,
  sourceStatus,
  validateSourceArtifacts,
  writeLargeJsonSync,
  writeOutputs,
  worklistMarkdown,
};
