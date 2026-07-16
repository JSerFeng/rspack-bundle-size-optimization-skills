#!/usr/bin/env node
// Classify every retained usedExports=[] module without guessing purity.
// A side-effect bailout is only eligible for a sideEffects:false A/B when an
// explicit, hash-pinned decision ledger says `safe-experiment` and contains
// both source and package evidence.

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { createHash } = require('crypto');
const { dirname, isAbsolute, relative, resolve } = require('path');
const { tmpdir } = require('os');

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

const SIDE_EFFECT_RE = /side[_ ]effects in source code/i;
const LOC_RE = /at\s+(.+?):(\d+):/;
const ALLOWED_DECISIONS = new Set(['safe-experiment', 'keep', 'unknown']);

function canonicalPath(value, context) {
  if (!value) return '';
  const absolute = isAbsolute(value) ? resolve(value) : resolve(context, value);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

function sha256File(file) {
  if (!file || !existsSync(file)) return null;
  try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return null; }
}

function sourceSnippet(resource, line) {
  if (!resource || !line || !existsSync(resource)) return '';
  try {
    const lines = readFileSync(resource, 'utf8').split('\n');
    const start = Math.max(0, line - 2);
    return lines
      .slice(start, start + 5)
      .map((text, index) => `${start + index + 1}| ${text.trim()}`.slice(0, 240))
      .join('  ⏎ ');
  } catch { return ''; }
}

function loadDecisionLedger(file, context) {
  if (!file) return { version: 1, decisions: [], byResource: new Map() };
  if (!existsSync(file)) throw new Error(`Missing decision ledger: ${file}`);
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  if (ledger.version !== 1 || !Array.isArray(ledger.decisions)) {
    throw new Error('Decision ledger must be { version: 1, decisions: [] }');
  }
  const byResource = new Map();
  for (const decision of ledger.decisions) {
    if (!decision || !ALLOWED_DECISIONS.has(decision.decision)) {
      throw new Error(`Invalid side-effects decision: ${JSON.stringify(decision?.decision)}`);
    }
    const resource = canonicalPath(decision.resource, context);
    if (!resource) throw new Error('Every decision must name an absolute or project-relative resource');
    if (byResource.has(resource)) throw new Error(`Duplicate decision for ${resource}`);
    byResource.set(resource, {
      ...decision,
      resource,
      packageJson: decision.packageJson ? canonicalPath(decision.packageJson, context) : null,
      postLoaderSourceArtifact: decision.postLoaderSourceArtifact ? canonicalPath(decision.postLoaderSourceArtifact, context) : null,
    });
  }
  return { ...ledger, byResource };
}

function validateDecision(decision, resource) {
  if (!decision) return { valid: false, reason: 'no explicit decision ledger row' };
  const sourceEvidence = Array.isArray(decision.sourceEvidence) ? decision.sourceEvidence.filter(Boolean) : [];
  const packageEvidence = Array.isArray(decision.packageEvidence) ? decision.packageEvidence.filter(Boolean) : [];
  if (sourceEvidence.length === 0) return { valid: false, reason: 'sourceEvidence is empty' };
  if (packageEvidence.length === 0) return { valid: false, reason: 'packageEvidence is empty' };

  const currentSourceHash = sha256File(resource);
  if (!decision.sourceHash || decision.sourceHash !== currentSourceHash) {
    return { valid: false, reason: 'sourceHash is missing or stale' };
  }

  const currentPostLoaderHash = sha256File(decision.postLoaderSourceArtifact);
  if (decision.postLoaderSourceReadable !== true) {
    return { valid: false, reason: 'postLoaderSourceReadable was not affirmatively reviewed' };
  }
  if (!decision.postLoaderSourceArtifact || !decision.postLoaderSourceHash || decision.postLoaderSourceHash !== currentPostLoaderHash) {
    return { valid: false, reason: 'postLoaderSourceArtifact/postLoaderSourceHash is missing or stale' };
  }

  const packageJson = decision.packageJson ? canonicalPath(decision.packageJson, dirname(resource)) : '';
  const currentPackageHash = sha256File(packageJson);
  if (!packageJson || !decision.packageJsonHash || decision.packageJsonHash !== currentPackageHash) {
    return { valid: false, reason: 'packageJson/packageJsonHash is missing or stale' };
  }
  if (!decision.reviewedAt) return { valid: false, reason: 'reviewedAt is missing' };
  return { valid: true, reason: 'hash-pinned source and package review present' };
}

function dispositionFor(entry, decision, resource) {
  const sideEffectBailout = (entry.sideEffectBailouts || entry.bailouts || []).some((b) => SIDE_EFFECT_RE.test(b));
  if (!sideEffectBailout) {
    return {
      disposition: 'investigate',
      reason: 'usedExports=[] is retained without a side-effect bailout; inspect graph/concatenation causes',
      decisionValidation: 'not-applicable',
    };
  }

  const validation = validateDecision(decision, resource);
  if (!validation.valid) {
    return {
      disposition: 'source-review-required',
      reason: validation.reason,
      decisionValidation: 'missing-or-stale',
    };
  }
  return {
    disposition: decision.decision,
    reason: decision.reason || validation.reason,
    decisionValidation: 'valid',
  };
}

function run(argv = process.argv) {
  const args = parseArgs(argv);
  const summaryPath = resolve(args.summary || 'retained-unused-side-effects-summary.json');
  const outDir = resolve(args['out-dir'] || dirname(summaryPath));
  const context = resolve(args.context || process.cwd());
  const decisionsPath = args.decisions ? resolve(args.decisions) : null;
  if (!existsSync(summaryPath)) throw new Error(`Missing summary: ${summaryPath}`);

  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const ledger = loadDecisionLedger(decisionsPath, context);
  const entries = Array.isArray(summary.retainedUnusedEntries) ? summary.retainedUnusedEntries : [];
  const rows = entries.map((entry) => {
    const resource = canonicalPath(entry.resource || entry.relResource, context);
    const bailout = (entry.sideEffectBailouts || entry.bailouts || []).find((value) => SIDE_EFFECT_RE.test(value))
      || (entry.bailouts || [])[0]
      || '';
    const locMatch = LOC_RE.exec(bailout);
    const line = locMatch ? Number(locMatch[2]) : 0;
    const decision = ledger.byResource.get(resource);
    const disposition = dispositionFor(entry, decision, resource);
    return {
      resource: relative(context, resource) || resource,
      absoluteResource: resource,
      moduleSize: Number(entry.size || 0),
      disposition: disposition.disposition,
      reason: disposition.reason,
      decisionValidation: disposition.decisionValidation,
      sourceHash: sha256File(resource),
      postLoaderSourceArtifact: decision?.postLoaderSourceArtifact || null,
      postLoaderSourceHash: decision?.postLoaderSourceHash || null,
      postLoaderSourceReadable: decision?.postLoaderSourceReadable === true,
      packageJson: decision?.packageJson || null,
      packageJsonHash: decision?.packageJsonHash || null,
      sourceEvidence: decision?.sourceEvidence || [],
      packageEvidence: decision?.packageEvidence || [],
      bailout: bailout.slice(0, 300),
      snippet: sourceSnippet(resource, line),
    };
  });

  const byDisposition = {};
  for (const row of rows) {
    const bucket = (byDisposition[row.disposition] ||= { count: 0, moduleSizeBytes: 0 });
    bucket.count += 1;
    bucket.moduleSizeBytes += row.moduleSize;
  }
  const sideEffectRows = rows.filter((row) => row.disposition !== 'investigate');
  const reviewedRows = sideEffectRows.filter((row) => row.decisionValidation === 'valid');
  const safeRows = rows.filter((row) => row.disposition === 'safe-experiment');
  const unresolvedRows = rows.filter((row) => row.disposition === 'source-review-required' || row.disposition === 'unknown');
  const result = {
    version: 2,
    generatedAt: new Date().toISOString(),
    summaryPath,
    decisionsPath,
    moduleCount: rows.length,
    sideEffectReviewCount: sideEffectRows.length,
    reviewedDecisionCount: reviewedRows.length,
    decisionCoverage: sideEffectRows.length === 0 ? 1 : reviewedRows.length / sideEffectRows.length,
    unresolvedDecisionCount: unresolvedRows.length,
    allDecisionsResolved: unresolvedRows.length === 0,
    reviewWorklistModuleSizeBytes: sideEffectRows.reduce((sum, row) => sum + row.moduleSize, 0),
    confirmedSafeExperimentModuleSizeBytes: safeRows.reduce((sum, row) => sum + row.moduleSize, 0),
    warning: 'Module/source size is review scope, not emitted-byte savings. Only production A/B emitted raw/gzip deltas are savings.',
    byDisposition,
    safeExperimentResources: safeRows.map((row) => row.absoluteResource),
    modules: rows.sort((a, b) => b.moduleSize - a.moduleSize),
  };

  mkdirSync(outDir, { recursive: true });
  const jsonPath = resolve(outDir, 'retained-unused-disposition.json');
  const mdPath = resolve(outDir, 'retained-unused-disposition.md');
  writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');

  const lines = [
    '# Retained-Unused Decision Ledger Result',
    '',
    `Decision coverage: ${reviewedRows.length}/${sideEffectRows.length}.`,
    '',
    '> Module/source bytes below describe review scope only. They are not removable bytes or emitted savings.',
    '',
    '| disposition | modules | module/source bytes |',
    '| --- | ---: | ---: |',
    ...Object.entries(byDisposition)
      .sort((a, b) => b[1].moduleSizeBytes - a[1].moduleSizeBytes)
      .map(([name, value]) => `| ${name} | ${value.count} | ${value.moduleSizeBytes} |`),
    '',
    '## Every module',
    '',
    '| module | size | disposition | decision validation | reason | evidence |',
    '| --- | ---: | --- | --- | --- | --- |',
    ...rows.map((row) => {
      const evidence = [row.bailout, row.snippet].filter(Boolean).join('<br>').replace(/\|/g, '\\|');
      return `| ${row.resource} | ${row.moduleSize} | ${row.disposition} | ${row.decisionValidation} | ${row.reason} | ${evidence} |`;
    }),
    '',
    `Unresolved decisions: ${unresolvedRows.length}. Any unresolved row keeps the side-effects check blocked.`,
    '',
    `Safe A/B set: ${safeRows.length} module(s). Rebuild production output before reporting any saving.`,
  ];
  writeFileSync(mdPath, lines.join('\n') + '\n');
  console.log(`modules=${rows.length} reviewed=${reviewedRows.length}/${sideEffectRows.length} safeExperiment=${safeRows.length}`);
  console.log(`wrote ${jsonPath}`);
  return result;
}

function selfTest() {
  const root = mkdtempSync(resolve(tmpdir(), 'retained-unused-disposition-'));
  try {
    const source = resolve(root, 'src', 'module.js');
    const packageJson = resolve(root, 'package.json');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'export const value = 1;\n');
    writeFileSync(packageJson, JSON.stringify({ name: 'fixture', sideEffects: false }));
    const summary = resolve(root, 'summary.json');
    writeFileSync(summary, JSON.stringify({ retainedUnusedEntries: [{ resource: source, size: 24, sideEffectBailouts: ['Statement with side_effects in source code at ./src/module.js:1:0'] }] }));
    const withoutDecision = run(['node', 'script', '--summary', summary, '--context', root, '--out-dir', resolve(root, 'without')]);
    if (withoutDecision.safeExperimentResources.length !== 0 || withoutDecision.modules[0].disposition !== 'source-review-required') throw new Error('missing-ledger gate self-test failed');
    const decisions = resolve(root, 'decisions.json');
    const postLoaderSourceArtifact = resolve(root, 'post-loader-module.js');
    writeFileSync(postLoaderSourceArtifact, 'export const value = 1;\n');
    writeFileSync(decisions, JSON.stringify({ version: 1, decisions: [{
      resource: source,
      decision: 'safe-experiment',
      packageJson,
      sourceHash: sha256File(source),
      postLoaderSourceArtifact,
      postLoaderSourceHash: sha256File(postLoaderSourceArtifact),
      postLoaderSourceReadable: true,
      packageJsonHash: sha256File(packageJson),
      sourceEvidence: ['declaration only'],
      packageEvidence: ['nearest package reviewed'],
      reviewedAt: new Date().toISOString(),
    }] }));
    const withDecision = run(['node', 'script', '--summary', summary, '--decisions', decisions, '--context', root, '--out-dir', resolve(root, 'with')]);
    if (withDecision.safeExperimentResources.length !== 1 || withDecision.modules[0].disposition !== 'safe-experiment') throw new Error('valid-ledger self-test failed');
    console.log('retained-unused-disposition self-test passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  return run(argv);
}

if (require.main === module) main();
module.exports = { canonicalPath, dispositionFor, loadDecisionLedger, run, validateDecision };
