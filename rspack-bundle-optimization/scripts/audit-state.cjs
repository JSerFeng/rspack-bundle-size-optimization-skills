#!/usr/bin/env node
// Maintain and validate bundle-audit coverage and completion state.
// Evidence integrity alone is not completion; this script is the completion gate.

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
const { spawnSync } = require('child_process');
const { dirname, isAbsolute, relative, resolve, sep } = require('path');
const { tmpdir } = require('os');

const FAMILY_DEFINITIONS = Object.freeze([
  {
    id: 'entry-route-loading',
    label: 'Entry and route loading boundaries',
  },
  {
    id: 'import-export-shape',
    label: 'Import shape, barrels, and export usage',
  },
  {
    id: 'side-effects-retention',
    label: 'Side effects and retained code',
  },
  {
    id: 'duplicate-code-dependencies',
    label: 'Duplicate code and dependency versions',
  },
  {
    id: 'module-format-boundaries',
    label: 'CommonJS, ESM, and prebuilt module boundaries',
  },
  {
    id: 'chunking-request-shape',
    label: 'Chunking, cache groups, requests, and caching',
  },
  {
    id: 'syntax-transforms-polyfills',
    label: 'Syntax targets, transforms, helpers, and polyfills',
  },
  {
    id: 'production-only-payloads',
    label: 'Production-only payloads, locales, icons, and debug code',
  },
  {
    id: 'compiler-config-capabilities',
    label: 'Compiler version and optimization configuration',
  },
  {
    id: 'runtime-scenario-loading',
    label: 'Runtime route and interaction loading',
  },
]);

const MODES = new Set(['audit-only', 'optimize']);
const COVERAGE_POLICIES = new Set(['comprehensive', 'targeted']);
const FAMILY_STATUSES = new Set([
  'pending',
  'in-progress',
  'completed',
  'not-applicable',
  'out-of-scope',
  'blocked',
]);
const FAMILY_TERMINAL = new Set([
  'completed',
  'not-applicable',
  'out-of-scope',
  'blocked',
]);
const CANDIDATE_STATUSES = new Set([
  'discovered',
  'investigating',
  'experimenting',
  'ready-to-apply',
  'proposed-unmeasured',
  'validated-opportunity',
  'applied',
  'keep',
  'rejected',
  'risk-found',
  'blocked',
]);
const CANDIDATE_TERMINAL = new Set([
  'proposed-unmeasured',
  'validated-opportunity',
  'applied',
  'keep',
  'rejected',
  'risk-found',
  'blocked',
]);
const CHECK_KINDS = new Set([
  'production-build',
  'test',
  'runtime',
  'typecheck',
  'lint',
  'manual',
]);
const CORRECTNESS_CHECK_KINDS = new Set([
  'test',
  'runtime',
  'typecheck',
  'lint',
  'manual',
]);

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

function canonical(value) {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`);
  }
}

function readRun(runDir) {
  const root = canonical(runDir);
  const manifestPath = resolve(root, 'manifest.json');
  const statePath = resolve(root, 'audit-state.json');
  const manifest = readJson(manifestPath, 'run manifest');
  const state = readJson(statePath, 'audit state');
  return { root, manifestPath, statePath, manifest, state };
}

function safeRunPath(runDir, value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty run-relative path`);
  }
  if (isAbsolute(value)) throw new Error(`${label} must be run-relative`);
  const absolute = canonical(resolve(runDir, value));
  const rel = relative(runDir, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes the run directory: ${value}`);
  }
  return absolute;
}

function safeProjectPath(projectRoot, value, label) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty project-relative path`);
  }
  const absolute = canonical(resolve(projectRoot, value));
  const rel = relative(projectRoot, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes the project root: ${value}`);
  }
  return absolute;
}

function listFiles(root) {
  const rows = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) rows.push(path);
    }
  };
  visit(root);
  return rows.sort((left, right) => left.localeCompare(right));
}

function fingerprintPath(path) {
  const absolute = canonical(path);
  if (!existsSync(absolute)) throw new Error(`Missing evidence path: ${absolute}`);
  const stats = statSync(absolute);
  if (stats.isFile()) {
    const body = readFileSync(absolute);
    return {
      kind: 'file',
      path: absolute,
      bytes: body.length,
      sha256: sha256(body),
    };
  }
  if (!stats.isDirectory()) {
    throw new Error(`Unsupported evidence path type: ${absolute}`);
  }
  const files = listFiles(absolute);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const body = readFileSync(file);
    const name = relative(absolute, file).split(sep).join('/');
    bytes += body.length;
    hash.update(name);
    hash.update('\0');
    hash.update(sha256(body));
    hash.update('\n');
  }
  return {
    kind: 'directory',
    path: absolute,
    files: files.length,
    bytes,
    sha256: hash.digest('hex'),
  };
}

function initializeState({
  runDir,
  runId,
  projectRoot,
  mode = 'audit-only',
  coverage = 'comprehensive',
  goal,
}) {
  if (!MODES.has(mode)) throw new Error(`Unsupported audit mode: ${mode}`);
  if (!COVERAGE_POLICIES.has(coverage)) {
    throw new Error(`Unsupported coverage policy: ${coverage}`);
  }
  const statePath = resolve(runDir, 'audit-state.json');
  if (existsSync(statePath)) throw new Error(`Audit state already exists: ${statePath}`);
  const state = {
    schemaVersion: 1,
    kind: 'rspack-bundle-audit-state',
    runId,
    projectRoot: canonical(projectRoot),
    mode,
    coverage,
    goal: String(goal || 'Reduce relevant JavaScript with production evidence'),
    initialProjectSnapshot: {
      capturedAt: new Date().toISOString(),
      git: gitFingerprint(canonical(projectRoot)),
      files: [],
    },
    families: FAMILY_DEFINITIONS.map(({ id, label }) => ({
      id,
      label,
      status: 'pending',
      summary: null,
      discoveredCandidateCount: null,
      noCandidateReason: null,
      evidence: [],
      blocker: null,
    })),
    candidates: [],
    checks: [],
    baseline: {
      productionBuildCheckId: null,
      measurements: [],
    },
    final: {
      productionBuildCheckId: null,
      measurements: [],
      comparisons: [],
      projectSnapshot: null,
      sealedAt: null,
    },
  };
  writeJson(statePath, state);
  return state;
}

function commandResult(command, args, cwd, encoding = 'utf8') {
  return spawnSync(command, args, {
    cwd,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitFingerprint(projectRoot) {
  const commitResult = commandResult('git', ['rev-parse', 'HEAD'], projectRoot);
  if (commitResult.status !== 0) return { available: false };
  const diffResult = commandResult('git', ['diff', '--binary', 'HEAD', '--'], projectRoot);
  const untrackedResult = commandResult(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    projectRoot,
  );
  if (diffResult.status !== 0 || untrackedResult.status !== 0) {
    throw new Error('Cannot fingerprint the final Git diff and untracked files.');
  }
  const commit = String(commitResult.stdout || '').trim();
  const diff = Buffer.from(String(diffResult.stdout || ''), 'utf8');
  const untrackedNames = String(untrackedResult.stdout || '')
    .split('\0')
    .filter(Boolean)
    .sort();
  const untracked = untrackedNames.map((name) => {
    const path = safeProjectPath(projectRoot, name, 'untracked path');
    const body = readFileSync(path);
    return { path: name.split(sep).join('/'), bytes: body.length, sha256: sha256(body) };
  });
  const digest = createHash('sha256');
  digest.update(commit);
  digest.update('\0');
  digest.update(diff);
  for (const row of untracked) {
    digest.update('\0');
    digest.update(row.path);
    digest.update('\0');
    digest.update(row.sha256);
  }
  return {
    available: true,
    commit,
    diffBytes: diff.length,
    diffSha256: sha256(diff),
    untracked,
    sha256: digest.digest('hex'),
  };
}

function collectAppliedFiles(state) {
  const files = new Set();
  for (const candidate of state.candidates || []) {
    if (candidate.status !== 'applied') continue;
    for (const path of candidate.change?.changedFiles || []) files.add(path);
  }
  return [...files].sort();
}

function projectSnapshot(state) {
  const projectRoot = canonical(state.projectRoot);
  const files = collectAppliedFiles(state).map((name) => {
    const path = safeProjectPath(projectRoot, name, 'changed file');
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Changed file is missing from the final project: ${name}`);
    }
    const body = readFileSync(path);
    return {
      path: name.split(sep).join('/'),
      bytes: body.length,
      sha256: sha256(body),
    };
  });
  return {
    capturedAt: new Date().toISOString(),
    git: gitFingerprint(projectRoot),
    files,
  };
}

function snapshotFinal(runDir) {
  const context = readRun(runDir);
  const gitAvailable = commandResult(
    'git',
    ['rev-parse', '--is-inside-work-tree'],
    context.state.projectRoot,
  ).status === 0;
  if (
    gitAvailable
    && commandResult(
      'git',
      ['check-ignore', '-q', context.root],
      context.state.projectRoot,
    ).status !== 0
  ) {
    throw new Error(
      `Run directory must be Git-ignored before snapshot-final: ${context.root}`,
    );
  }
  context.state.final ||= {};
  const snapshot = projectSnapshot(context.state);
  context.state.final.projectSnapshot = snapshot;
  context.state.final.sealedAt = snapshot.capturedAt;
  writeJson(context.statePath, context.state);
  return snapshot;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function sameFingerprint(recorded, current) {
  return recorded.kind === current.kind
    && recorded.bytes === current.bytes
    && recorded.sha256 === current.sha256
    && (recorded.kind !== 'directory' || recorded.files === current.files);
}

function dateValue(value) {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function validateAuditState(runDir) {
  const context = readRun(runDir);
  const { root, manifest, state } = context;
  const issues = [];
  const addIssue = (code, path, message) => issues.push({ code, path, message });

  if (manifest.schemaVersion !== 1 || manifest.kind !== 'rspack-bundle-data-run') {
    addIssue('MANIFEST_SCHEMA', 'manifest.json', 'Unsupported run manifest schema.');
  }
  if (state.schemaVersion !== 1 || state.kind !== 'rspack-bundle-audit-state') {
    addIssue('STATE_SCHEMA', 'audit-state.json', 'Unsupported audit-state schema.');
  }
  if (state.runId !== manifest.runId) {
    addIssue('RUN_ID_MISMATCH', 'runId', 'Audit state and manifest use different run ids.');
  }
  if (canonical(state.projectRoot || '.') !== canonical(manifest.projectRoot || '.')) {
    addIssue(
      'PROJECT_ROOT_MISMATCH',
      'projectRoot',
      'Audit state and manifest use different project roots.',
    );
  }
  if (!MODES.has(state.mode)) addIssue('MODE', 'mode', `Unsupported mode: ${state.mode}`);
  if (!COVERAGE_POLICIES.has(state.coverage)) {
    addIssue('COVERAGE', 'coverage', `Unsupported coverage policy: ${state.coverage}`);
  }
  if (!isNonEmptyString(state.goal)) addIssue('GOAL', 'goal', 'A concrete goal is required.');

  const artifactByPath = new Map();
  for (const [index, recorded] of (manifest.artifacts || []).entries()) {
    if (!recorded?.path) {
      addIssue('ARTIFACT_PATH', `manifest.artifacts[${index}]`, 'Artifact path is missing.');
      continue;
    }
    const absolute = canonical(recorded.path);
    if (artifactByPath.has(absolute)) {
      addIssue('DUPLICATE_ARTIFACT', `manifest.artifacts[${index}]`, absolute);
    }
    artifactByPath.set(absolute, recorded);
    try {
      const current = fingerprintPath(absolute);
      if (!sameFingerprint(recorded, current)) {
        addIssue('STALE_ARTIFACT', `manifest.artifacts[${index}]`, absolute);
      }
    } catch (error) {
      addIssue('MISSING_ARTIFACT', `manifest.artifacts[${index}]`, error.message);
    }
  }

  function recordedPath(value, fieldPath) {
    let absolute;
    try {
      absolute = safeRunPath(root, value, fieldPath);
    } catch (error) {
      addIssue('EVIDENCE_PATH', fieldPath, error.message);
      return null;
    }
    if (!artifactByPath.has(absolute)) {
      addIssue(
        'UNRECORDED_EVIDENCE',
        fieldPath,
        `${value} is not fingerprinted in manifest.json.`,
      );
      return null;
    }
    return absolute;
  }

  function evidenceList(value, fieldPath) {
    if (!Array.isArray(value) || value.length === 0) {
      addIssue('EVIDENCE_REQUIRED', fieldPath, 'At least one recorded evidence file is required.');
      return [];
    }
    const seen = new Set();
    return value.map((path, index) => {
      if (seen.has(path)) {
        addIssue('DUPLICATE_EVIDENCE', `${fieldPath}[${index}]`, String(path));
      }
      seen.add(path);
      return recordedPath(path, `${fieldPath}[${index}]`);
    }).filter(Boolean);
  }

  function recordedJson(value, fieldPath, expectedKind) {
    const absolute = recordedPath(value, fieldPath);
    if (!absolute) return null;
    let parsed;
    try {
      parsed = readJson(absolute, fieldPath);
    } catch (error) {
      addIssue('INVALID_JSON_EVIDENCE', fieldPath, error.message);
      return null;
    }
    if (expectedKind && parsed.kind !== expectedKind) {
      addIssue(
        'EVIDENCE_KIND',
        fieldPath,
        `Expected ${expectedKind}, received ${parsed.kind || 'missing kind'}.`,
      );
      return null;
    }
    return { absolute, value: parsed };
  }

  const checks = Array.isArray(state.checks) ? state.checks : [];
  if (!Array.isArray(state.checks)) addIssue('CHECKS_ARRAY', 'checks', 'checks must be an array.');
  const checkById = new Map();
  for (const [index, check] of checks.entries()) {
    const path = `checks[${index}]`;
    if (!isNonEmptyString(check?.id)) addIssue('CHECK_ID', `${path}.id`, 'Check id is required.');
    else if (checkById.has(check.id)) addIssue('DUPLICATE_CHECK', `${path}.id`, check.id);
    else checkById.set(check.id, check);
    if (!CHECK_KINDS.has(check?.kind)) {
      addIssue('CHECK_KIND', `${path}.kind`, `Unsupported check kind: ${check?.kind}`);
    }
    if (!['passed', 'failed', 'blocked'].includes(check?.status)) {
      addIssue('CHECK_STATUS', `${path}.status`, `Unsupported check status: ${check?.status}`);
    }
    if (!isNonEmptyString(check?.summary)) {
      addIssue('CHECK_SUMMARY', `${path}.summary`, 'A check summary is required.');
    }
    const commandIndex = check?.commandIndex;
    if (commandIndex !== undefined && commandIndex !== null) {
      if (!Number.isInteger(commandIndex) || !manifest.commands?.[commandIndex]) {
        addIssue('CHECK_COMMAND', `${path}.commandIndex`, 'Referenced manifest command is missing.');
      } else {
        const command = manifest.commands[commandIndex];
        if (check.status === 'passed' && command.exitCode !== 0) {
          addIssue(
            'CHECK_EXIT_CODE',
            `${path}.commandIndex`,
            `Passed check references exit code ${command.exitCode}.`,
          );
        }
        if (check.kind === 'production-build' && !(command.artifacts || []).length) {
          addIssue(
            'BUILD_ARTIFACT_REQUIRED',
            `${path}.commandIndex`,
            'A production build check must record at least one output artifact.',
          );
        }
        if (check.kind === 'production-build') {
          if (!command.outputDirectory) {
            addIssue(
              'BUILD_OUTPUT_DIRECTORY',
              `${path}.commandIndex`,
              'A production build check must record its fresh output directory.',
            );
          } else {
            const outputDirectory = canonical(command.outputDirectory);
            const outputRel = relative(root, outputDirectory);
            if (
              outputRel === '..'
              || outputRel.startsWith(`..${sep}`)
              || isAbsolute(outputRel)
            ) {
              addIssue(
                'BUILD_OUTPUT_OUTSIDE_RUN',
                `${path}.commandIndex`,
                'Production build output must stay inside the isolated run.',
              );
            }
            const ownsOutputArtifact = (command.artifacts || []).some((artifact) => {
              const artifactPath = canonical(artifact.path || '.');
              const rel = relative(outputDirectory, artifactPath);
              return rel === ''
                || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
            });
            if (!ownsOutputArtifact) {
              addIssue(
                'BUILD_OUTPUT_ARTIFACT',
                `${path}.commandIndex`,
                'Production build command has no recorded artifact under its output directory.',
              );
            }
          }
        }
      }
    } else if (check?.kind === 'production-build') {
      addIssue('BUILD_COMMAND_REQUIRED', `${path}.commandIndex`, 'Production build command is required.');
    }
    if (Array.isArray(check?.evidence) && check.evidence.length) {
      evidenceList(check.evidence, `${path}.evidence`);
    } else if (check?.kind === 'manual') {
      addIssue('MANUAL_EVIDENCE', `${path}.evidence`, 'Manual checks require recorded evidence.');
    }
  }

  function passedCheck(id, fieldPath, expectedKind) {
    if (!isNonEmptyString(id) || !checkById.has(id)) {
      addIssue('CHECK_REFERENCE', fieldPath, `Missing check: ${id || '(empty)'}`);
      return null;
    }
    const check = checkById.get(id);
    if (check.status !== 'passed') {
      addIssue('CHECK_NOT_PASSED', fieldPath, `Check ${id} is ${check.status}.`);
    }
    if (expectedKind && check.kind !== expectedKind) {
      addIssue('CHECK_WRONG_KIND', fieldPath, `Check ${id} must be ${expectedKind}.`);
    }
    return check;
  }

  function checkRecordedAt(check) {
    const command = manifest.commands?.[check?.commandIndex];
    return dateValue(command?.recordedAt);
  }

  function measurementRows(value, fieldPath) {
    if (!Array.isArray(value) || !value.length) {
      addIssue('MEASUREMENT_REQUIRED', fieldPath, 'At least one production measurement is required.');
      return new Map();
    }
    const rows = new Map();
    const scopeIds = new Set();
    for (const [index, row] of value.entries()) {
      const path = `${fieldPath}[${index}]`;
      if (!isNonEmptyString(row?.scopeId)) addIssue('SCOPE_ID', `${path}.scopeId`, 'scopeId is required.');
      else if (scopeIds.has(row.scopeId)) {
        addIssue('DUPLICATE_SCOPE_ID', `${path}.scopeId`, row.scopeId);
      } else scopeIds.add(row.scopeId);
      if (!isNonEmptyString(row?.label)) addIssue('SCOPE_LABEL', `${path}.label`, 'label is required.');
      const loaded = recordedJson(
        row?.path,
        `${path}.path`,
        'rspack-bundle-asset-measurement',
      );
      if (!loaded) continue;
      if (loaded.value.runId !== state.runId) {
        addIssue('MEASUREMENT_RUN_ID', `${path}.path`, 'Measurement uses a different run id.');
      }
      validateMeasurementValue(loaded.value, `${path}.path`, addIssue);
      if (rows.has(loaded.absolute)) {
        addIssue('DUPLICATE_MEASUREMENT', `${path}.path`, row.path);
      }
      rows.set(loaded.absolute, { row, ...loaded });
    }
    return rows;
  }

  function comparison(value, fieldPath) {
    const loaded = recordedJson(
      value,
      fieldPath,
      'rspack-bundle-asset-comparison',
    );
    if (!loaded) return null;
    const comparisonValue = loaded.value;
    if (
      comparisonValue.baseline?.runId !== state.runId
      || comparisonValue.experiment?.runId !== state.runId
    ) {
      addIssue('COMPARISON_RUN_ID', fieldPath, 'Comparison uses a different run id.');
    }
    if (comparisonValue.inclusionRulesEquivalent !== true) {
      addIssue('COMPARISON_SCOPE', fieldPath, 'Comparison asset rules are not equivalent.');
    }
    const measurements = {};
    for (const side of ['baseline', 'experiment']) {
      const absolute = canonical(comparisonValue[side]?.path || '.');
      const relativePath = relative(root, absolute).split(sep).join('/');
      const measurement = recordedJson(
        relativePath,
        `${fieldPath}.${side}Measurement`,
        'rspack-bundle-asset-measurement',
      );
      if (!measurement) continue;
      measurements[side] = measurement;
      validateMeasurementValue(
        measurement.value,
        `${fieldPath}.${side}Measurement`,
        addIssue,
      );
      if (measurement.value.runId !== state.runId) {
        addIssue(
          'COMPARISON_MEASUREMENT_RUN_ID',
          `${fieldPath}.${side}Measurement`,
          'Comparison measurement uses a different run id.',
        );
      }
      for (const key of ['assets', 'rawBytes', 'gzipBytes']) {
        if (comparisonValue[side]?.totals?.[key] !== measurement.value.totals?.[key]) {
          addIssue(
            'COMPARISON_TOTAL_MISMATCH',
            `${fieldPath}.${side}.totals.${key}`,
            'Comparison totals do not match the recorded measurement.',
          );
        }
      }
    }
    if (measurements.baseline && measurements.experiment) {
      const expected = {
        rawDeltaBytes:
          measurements.experiment.value.totals.rawBytes
          - measurements.baseline.value.totals.rawBytes,
        gzipDeltaBytes:
          measurements.experiment.value.totals.gzipBytes
          - measurements.baseline.value.totals.gzipBytes,
        assetCountDelta:
          measurements.experiment.value.totals.assets
          - measurements.baseline.value.totals.assets,
      };
      for (const [key, expectedValue] of Object.entries(expected)) {
        if (comparisonValue.totals?.[key] !== expectedValue) {
          addIssue(
            'COMPARISON_DELTA_MISMATCH',
            `${fieldPath}.totals.${key}`,
            `Expected ${expectedValue}, received ${comparisonValue.totals?.[key]}.`,
          );
        }
      }
    }
    return { ...loaded, measurements };
  }

  const baseline = state.baseline || {};
  const baselineBuild = passedCheck(
    baseline.productionBuildCheckId,
    'baseline.productionBuildCheckId',
    'production-build',
  );
  const baselineMeasurements = measurementRows(
    baseline.measurements,
    'baseline.measurements',
  );
  const baselineBuildAt = checkRecordedAt(baselineBuild);
  for (const { value, row } of baselineMeasurements.values()) {
    const measuredAt = dateValue(value.generatedAt);
    if (baselineBuildAt && measuredAt && measuredAt < baselineBuildAt) {
      addIssue(
        'BASELINE_ORDER',
        `baseline.measurements.${row.scopeId}`,
        'Baseline measurement predates the recorded production build.',
      );
    }
    validateMeasurementOutput(
      value,
      baselineBuild,
      manifest,
      `baseline.measurements.${row.scopeId}`,
      addIssue,
    );
  }

  const familyById = new Map();
  const families = Array.isArray(state.families) ? state.families : [];
  if (!Array.isArray(state.families)) addIssue('FAMILIES_ARRAY', 'families', 'families must be an array.');
  for (const [index, family] of families.entries()) {
    const path = `families[${index}]`;
    if (!isNonEmptyString(family?.id)) addIssue('FAMILY_ID', `${path}.id`, 'Family id is required.');
    else if (familyById.has(family.id)) addIssue('DUPLICATE_FAMILY', `${path}.id`, family.id);
    else familyById.set(family.id, family);
    if (!FAMILY_STATUSES.has(family?.status)) {
      addIssue('FAMILY_STATUS', `${path}.status`, `Unsupported status: ${family?.status}`);
      continue;
    }
    if (!FAMILY_TERMINAL.has(family.status)) {
      addIssue('FAMILY_UNRESOLVED', `${path}.status`, `${family.id} is ${family.status}.`);
    }
    if (family.status === 'out-of-scope' && state.coverage === 'comprehensive') {
      addIssue(
        'COMPREHENSIVE_SCOPE_GAP',
        `${path}.status`,
        'Comprehensive audits cannot mark a family out of scope.',
      );
    }
    if (FAMILY_TERMINAL.has(family.status)) {
      if (!isNonEmptyString(family.summary)) {
        addIssue('FAMILY_SUMMARY', `${path}.summary`, 'Terminal family requires a concrete summary.');
      }
      if (
        !Number.isSafeInteger(family.discoveredCandidateCount)
        || family.discoveredCandidateCount < 0
      ) {
        addIssue(
          'FAMILY_DISCOVERED_COUNT',
          `${path}.discoveredCandidateCount`,
          'Terminal family requires a non-negative discovered candidate count.',
        );
      }
      evidenceList(family.evidence, `${path}.evidence`);
    }
    if (family.status === 'blocked') {
      validateBlocker(family.blocker, `${path}.blocker`, addIssue);
      addIssue('FAMILY_BLOCKED', `${path}.status`, `${family.id} remains blocked.`);
    }
  }
  for (const definition of FAMILY_DEFINITIONS) {
    if (!familyById.has(definition.id)) {
      addIssue('MISSING_FAMILY', 'families', `Missing optimization family: ${definition.id}`);
    }
  }
  for (const id of familyById.keys()) {
    if (!FAMILY_DEFINITIONS.some((definition) => definition.id === id)) {
      addIssue('UNKNOWN_FAMILY', 'families', `Unknown optimization family: ${id}`);
    }
  }
  if (
    state.coverage === 'targeted'
    && families.every((family) => family.status === 'out-of-scope')
  ) {
    addIssue('EMPTY_TARGET', 'families', 'A targeted audit must evaluate at least one family.');
  }

  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  if (!Array.isArray(state.candidates)) {
    addIssue('CANDIDATES_ARRAY', 'candidates', 'candidates must be an array.');
  }
  const candidateIds = new Set();
  const candidatesByFamily = new Map();
  for (const [index, candidate] of candidates.entries()) {
    const path = `candidates[${index}]`;
    if (!isNonEmptyString(candidate?.id)) addIssue('CANDIDATE_ID', `${path}.id`, 'Candidate id is required.');
    else if (candidateIds.has(candidate.id)) addIssue('DUPLICATE_CANDIDATE', `${path}.id`, candidate.id);
    else candidateIds.add(candidate.id);
    if (!familyById.has(candidate?.familyId)) {
      addIssue('CANDIDATE_FAMILY', `${path}.familyId`, `Unknown family: ${candidate?.familyId}`);
    } else {
      const rows = candidatesByFamily.get(candidate.familyId) || [];
      rows.push(candidate);
      candidatesByFamily.set(candidate.familyId, rows);
    }
    if (!isNonEmptyString(candidate?.title)) {
      addIssue('CANDIDATE_TITLE', `${path}.title`, 'Candidate title is required.');
    }
    if (!CANDIDATE_STATUSES.has(candidate?.status)) {
      addIssue('CANDIDATE_STATUS', `${path}.status`, `Unsupported status: ${candidate?.status}`);
      continue;
    }
    if (!CANDIDATE_TERMINAL.has(candidate.status)) {
      addIssue('CANDIDATE_UNRESOLVED', `${path}.status`, `${candidate.id} is ${candidate.status}.`);
    }
    if (!isNonEmptyString(candidate?.summary)) {
      addIssue('CANDIDATE_SUMMARY', `${path}.summary`, 'Candidate summary is required.');
    }
    evidenceList(candidate.evidence, `${path}.evidence`);

    if (state.mode === 'audit-only' && candidate.status === 'applied') {
      addIssue('AUDIT_APPLIED_CHANGE', `${path}.status`, 'audit-only mode cannot apply a change.');
    }
    if (
      state.mode === 'optimize'
      && ['proposed-unmeasured', 'validated-opportunity'].includes(candidate.status)
    ) {
      addIssue(
        'OPTIMIZE_LEFT_UNAPPLIED',
        `${path}.status`,
        'Optimize mode must apply, reject, keep, block, or name a concrete risk.',
      );
    }
    if (candidate.status === 'blocked') {
      validateBlocker(candidate.blocker, `${path}.blocker`, addIssue);
      addIssue('CANDIDATE_BLOCKED', `${path}.status`, `${candidate.id} remains blocked.`);
    }
    if (candidate.status === 'risk-found') {
      const risk = candidate.risk || {};
      if (!isNonEmptyString(risk.failureMode)) {
        addIssue('RISK_FAILURE_MODE', `${path}.risk.failureMode`, 'Concrete failure mode is required.');
      }
      if (!isNonEmptyString(risk.clearingCondition)) {
        addIssue(
          'RISK_CLEARING_CONDITION',
          `${path}.risk.clearingCondition`,
          'A condition that can clear the risk is required.',
        );
      }
    }
    if (candidate.status === 'validated-opportunity') {
      validateMeasuredOpportunity({
        candidate,
        path,
        state,
        root,
        baselineMeasurements,
        manifest,
        recordedPath,
        comparison,
        passedCheck,
        addIssue,
      });
    }
  }
  for (const [familyId, rows] of candidatesByFamily) {
    const family = familyById.get(familyId);
    if (['not-applicable', 'out-of-scope'].includes(family?.status) && rows.length) {
      addIssue(
        'FAMILY_CANDIDATE_CONTRADICTION',
        `families.${familyId}`,
        `${family.status} family contains discovered candidates.`,
      );
    }
  }
  for (const [familyId, family] of familyById) {
    const actual = candidatesByFamily.get(familyId)?.length || 0;
    if (
      FAMILY_TERMINAL.has(family.status)
      && family.discoveredCandidateCount !== actual
    ) {
      addIssue(
        'FAMILY_CANDIDATE_COUNT_MISMATCH',
        `families.${familyId}.discoveredCandidateCount`,
        `Recorded ${family.discoveredCandidateCount}; found ${actual} candidate record(s).`,
      );
    }
    if (
      family.status === 'completed'
      && actual === 0
      && !isNonEmptyString(family.noCandidateReason)
    ) {
      addIssue(
        'FAMILY_NO_OP_REASON',
        `families.${familyId}.noCandidateReason`,
        'A completed family with zero candidates must explain the no-op result.',
      );
    }
    if (
      ['not-applicable', 'out-of-scope'].includes(family.status)
      && family.discoveredCandidateCount !== 0
    ) {
      addIssue(
        'FAMILY_NON_APPLICABLE_COUNT',
        `families.${familyId}.discoveredCandidateCount`,
        `${family.status} family must record zero candidates.`,
      );
    }
  }

  const final = state.final || {};
  let finalMeasurements = new Map();
  const finalComparisonPaths = new Map();
  const applied = candidates.filter((candidate) => candidate.status === 'applied');
  if (!state.initialProjectSnapshot?.git) {
    addIssue(
      'INITIAL_PROJECT_SNAPSHOT',
      'initialProjectSnapshot',
      'Initial project snapshot is missing.',
    );
  } else if (state.mode === 'audit-only' || applied.length === 0) {
    try {
      const currentGit = gitFingerprint(canonical(state.projectRoot));
      if (JSON.stringify(state.initialProjectSnapshot.git) !== JSON.stringify(currentGit)) {
        addIssue(
          'UNBOUND_PROJECT_CHANGE',
          'initialProjectSnapshot',
          'Project changed even though no applied candidate is declared.',
        );
      }
    } catch (error) {
      addIssue('PROJECT_SNAPSHOT_INVALID', 'initialProjectSnapshot', error.message);
    }
  }
  let finalBuild = null;
  if (applied.length) {
    finalBuild = passedCheck(
      final.productionBuildCheckId,
      'final.productionBuildCheckId',
      'production-build',
    );
    finalMeasurements = measurementRows(final.measurements, 'final.measurements');
    const finalComparisonScopeIds = new Set();
    if (!Array.isArray(final.comparisons) || !final.comparisons.length) {
      addIssue('FINAL_COMPARISON_REQUIRED', 'final.comparisons', 'Final comparison is required.');
    } else {
      for (const [index, row] of final.comparisons.entries()) {
        const path = `final.comparisons[${index}]`;
        if (!isNonEmptyString(row?.scopeId)) addIssue('SCOPE_ID', `${path}.scopeId`, 'scopeId is required.');
        else if (finalComparisonScopeIds.has(row.scopeId)) {
          addIssue('DUPLICATE_SCOPE_ID', `${path}.scopeId`, row.scopeId);
        } else finalComparisonScopeIds.add(row.scopeId);
        const loaded = comparison(row?.path, `${path}.path`);
        if (!loaded) continue;
        finalComparisonPaths.set(loaded.absolute, loaded);
        const baselinePath = canonical(loaded.value.baseline?.path || '.');
        const experimentPath = canonical(loaded.value.experiment?.path || '.');
        if (!baselineMeasurements.has(baselinePath)) {
          addIssue('FINAL_BASELINE_LINK', `${path}.path`, 'Comparison baseline is not declared in baseline.measurements.');
        }
        if (!finalMeasurements.has(experimentPath)) {
          addIssue('FINAL_MEASUREMENT_LINK', `${path}.path`, 'Comparison result is not declared in final.measurements.');
        }
        const baselineScope = baselineMeasurements.get(baselinePath)?.row?.scopeId;
        const finalScope = finalMeasurements.get(experimentPath)?.row?.scopeId;
        if (baselineScope && baselineScope !== row.scopeId) {
          addIssue(
            'FINAL_SCOPE_LINK',
            `${path}.scopeId`,
            `Comparison baseline belongs to ${baselineScope}.`,
          );
        }
        if (finalScope && finalScope !== row.scopeId) {
          addIssue(
            'FINAL_SCOPE_LINK',
            `${path}.scopeId`,
            `Comparison result belongs to ${finalScope}.`,
          );
        }
      }
    }
    const finalMeasurementScopeIds = new Set(
      [...finalMeasurements.values()].map(({ row }) => row.scopeId),
    );
    for (const { row } of baselineMeasurements.values()) {
      if (!finalMeasurementScopeIds.has(row.scopeId)) {
        addIssue(
          'FINAL_SCOPE_MISSING',
          'final.measurements',
          `Missing final measurement for baseline scope ${row.scopeId}.`,
        );
      }
      if (!finalComparisonScopeIds.has(row.scopeId)) {
        addIssue(
          'FINAL_SCOPE_COMPARISON_MISSING',
          'final.comparisons',
          `Missing final comparison for baseline scope ${row.scopeId}.`,
        );
      }
    }
    const finalBuildAt = checkRecordedAt(finalBuild);
    for (const { value, row } of finalMeasurements.values()) {
      const measuredAt = dateValue(value.generatedAt);
      if (finalBuildAt && measuredAt && measuredAt < finalBuildAt) {
        addIssue(
          'FINAL_ORDER',
          `final.measurements.${row.scopeId}`,
          'Final measurement predates the final production build.',
        );
      }
      validateMeasurementOutput(
        value,
        finalBuild,
        manifest,
        `final.measurements.${row.scopeId}`,
        addIssue,
      );
    }
  }

  for (const [index, candidate] of candidates.entries()) {
    if (candidate.status !== 'applied') continue;
    validateAppliedCandidate({
      candidate,
      path: `candidates[${index}]`,
      state,
      root,
      baselineMeasurements,
      finalMeasurements,
      finalComparisonPaths,
      manifest,
      recordedPath,
      comparison,
      passedCheck,
      addIssue,
    });
  }

  if (applied.length) {
    if (!final.projectSnapshot || !isNonEmptyString(final.sealedAt)) {
      addIssue(
        'FINAL_SNAPSHOT_REQUIRED',
        'final.projectSnapshot',
        'Run snapshot-final after the final build, measurements, and checks.',
      );
    } else {
      try {
        const current = projectSnapshot(state);
        const recorded = final.projectSnapshot;
        if (
          JSON.stringify(recorded.git) !== JSON.stringify(current.git)
          || JSON.stringify(recorded.files) !== JSON.stringify(current.files)
        ) {
          addIssue(
            'FINAL_PROJECT_CHANGED',
            'final.projectSnapshot',
            'Project files changed after the final snapshot.',
          );
        }
      } catch (error) {
        addIssue('FINAL_SNAPSHOT_INVALID', 'final.projectSnapshot', error.message);
      }
      const sealedAt = dateValue(final.sealedAt);
      if (!sealedAt) addIssue('FINAL_SEALED_AT', 'final.sealedAt', 'Invalid final seal timestamp.');
      const latestEvidenceAt = Math.max(
        0,
        ...[...finalMeasurements.values()].map(({ value }) => dateValue(value.generatedAt) || 0),
        ...[...finalComparisonPaths.values()].map(({ value }) => dateValue(value.generatedAt) || 0),
        checkRecordedAt(finalBuild) || 0,
      );
      if (sealedAt && sealedAt < latestEvidenceAt) {
        addIssue('FINAL_SEAL_ORDER', 'final.sealedAt', 'Final snapshot predates final evidence.');
      }
    }
  }

  const uniqueIssues = [...new Map(
    issues.map((issue) => [`${issue.code}\0${issue.path}\0${issue.message}`, issue]),
  ).values()];
  const status = uniqueIssues.length ? 'incomplete' : 'complete';
  return {
    schemaVersion: 1,
    kind: 'rspack-bundle-completion-result',
    runId: state.runId,
    mode: state.mode,
    coverage: state.coverage,
    status,
    complete: status === 'complete',
    counts: {
      families: families.length,
      terminalFamilies: families.filter((family) => FAMILY_TERMINAL.has(family.status)).length,
      candidates: candidates.length,
      terminalCandidates: candidates.filter((candidate) => CANDIDATE_TERMINAL.has(candidate.status)).length,
      appliedCandidates: applied.length,
      issues: uniqueIssues.length,
    },
    issues: uniqueIssues,
  };
}

function validateBlocker(blocker, path, addIssue) {
  const fields = ['attemptedCommand', 'error', 'missingPrerequisite', 'nextAction'];
  for (const field of fields) {
    if (!isNonEmptyString(blocker?.[field])) {
      addIssue('BLOCKER_DETAIL', `${path}.${field}`, `${field} is required.`);
    }
  }
}

function validateMeasurementValue(value, path, addIssue) {
  if (!dateValue(value?.generatedAt)) {
    addIssue('MEASUREMENT_TIME', `${path}.generatedAt`, 'Measurement timestamp is invalid.');
  }
  if (!isNonEmptyString(value?.outputDirectory)) {
    addIssue('MEASUREMENT_OUTPUT', `${path}.outputDirectory`, 'Measurement output directory is required.');
  }
  for (const key of ['assets', 'rawBytes', 'gzipBytes']) {
    const count = value?.totals?.[key];
    if (!Number.isSafeInteger(count) || count < 0) {
      addIssue(
        'MEASUREMENT_TOTAL',
        `${path}.totals.${key}`,
        `${key} must be a non-negative integer.`,
      );
    }
  }
}

function validateMeasurementOutput(value, check, manifest, path, addIssue) {
  const command = manifest.commands?.[check?.commandIndex];
  if (!command?.outputDirectory || !value?.outputDirectory) return;
  const buildOutput = canonical(command.outputDirectory);
  const measuredOutput = canonical(value.outputDirectory);
  const rel = relative(buildOutput, measuredOutput);
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    addIssue(
      'MEASUREMENT_OUTPUT_MISMATCH',
      path,
      'Measurement does not read from the recorded production build output.',
    );
  }
}

function validateMeasuredOpportunity({
  candidate,
  path,
  state,
  root,
  baselineMeasurements,
  manifest,
  recordedPath,
  comparison,
  passedCheck,
  addIssue,
}) {
  const experiment = candidate.experiment || {};
  const buildCheck = passedCheck(
    experiment.buildCheckId,
    `${path}.experiment.buildCheckId`,
    'production-build',
  );
  const loaded = comparison(experiment.comparison, `${path}.experiment.comparison`);
  if (loaded) {
    if (!(loaded.value.totals?.rawDeltaBytes < 0)) {
      addIssue(
        'NO_RAW_SAVING',
        `${path}.experiment.comparison`,
        'Validated opportunity does not reduce raw JavaScript bytes.',
      );
    }
    const baselinePath = canonical(loaded.value.baseline?.path || '.');
    if (!baselineMeasurements.has(baselinePath)) {
      addIssue(
        'CANDIDATE_BASELINE_LINK',
        `${path}.experiment.comparison`,
        'Comparison baseline is not declared in baseline.measurements.',
      );
    }
    validateExperimentMeasurement({
      comparisonValue: loaded.value,
      buildCheck,
      state,
      root,
      manifest,
      recordedPath,
      fieldPath: `${path}.experiment.comparison`,
      addIssue,
    });
  }
  validateCorrectnessChecks(
    experiment.checkIds,
    `${path}.experiment.checkIds`,
    passedCheck,
    addIssue,
  );
}

function validateExperimentMeasurement({
  comparisonValue,
  buildCheck,
  state,
  root,
  manifest,
  recordedPath,
  fieldPath,
  addIssue,
}) {
  const experimentPath = canonical(comparisonValue.experiment?.path || '.');
  const relativePath = relative(root, experimentPath).split(sep).join('/');
  const recorded = recordedPath(relativePath, `${fieldPath}.experimentMeasurement`);
  if (!recorded) return;
  let measurement;
  try {
    measurement = readJson(recorded, `${fieldPath} experiment measurement`);
  } catch (error) {
    addIssue('INVALID_JSON_EVIDENCE', `${fieldPath}.experimentMeasurement`, error.message);
    return;
  }
  if (
    measurement.kind !== 'rspack-bundle-asset-measurement'
    || measurement.runId !== state.runId
  ) {
    addIssue(
      'EXPERIMENT_MEASUREMENT',
      `${fieldPath}.experimentMeasurement`,
      'Experiment measurement kind or run id is invalid.',
    );
  }
  const buildCommand = manifest.commands?.[buildCheck?.commandIndex];
  const builtAt = dateValue(buildCommand?.recordedAt);
  const measuredAt = dateValue(measurement.generatedAt);
  if (builtAt && measuredAt && measuredAt < builtAt) {
    addIssue(
      'EXPERIMENT_ORDER',
      fieldPath,
      'Experiment measurement predates its production build.',
    );
  }
  validateMeasurementOutput(
    measurement,
    buildCheck,
    manifest,
    `${fieldPath}.experimentMeasurement`,
    addIssue,
  );
}

function validateCorrectnessChecks(checkIds, path, passedCheck, addIssue) {
  if (!Array.isArray(checkIds) || !checkIds.length) {
    addIssue('CORRECTNESS_CHECK_REQUIRED', path, 'A measured change needs a correctness check.');
    return;
  }
  for (const [index, id] of checkIds.entries()) {
    const check = passedCheck(id, `${path}[${index}]`);
    if (check && !CORRECTNESS_CHECK_KINDS.has(check.kind)) {
      addIssue(
        'CORRECTNESS_CHECK_KIND',
        `${path}[${index}]`,
        `${id} is not a correctness check.`,
      );
    }
  }
}

function validateAppliedCandidate({
  candidate,
  path,
  state,
  root,
  baselineMeasurements,
  finalMeasurements,
  finalComparisonPaths,
  manifest,
  recordedPath,
  comparison,
  passedCheck,
  addIssue,
}) {
  const change = candidate.change || {};
  const changedFiles = change.changedFiles;
  if (!Array.isArray(changedFiles) || !changedFiles.length) {
    addIssue('APPLIED_FILES', `${path}.change.changedFiles`, 'Applied candidate must name changed files.');
  } else {
    const seen = new Set();
    for (const [index, file] of changedFiles.entries()) {
      if (seen.has(file)) addIssue('DUPLICATE_CHANGED_FILE', `${path}.change.changedFiles[${index}]`, file);
      seen.add(file);
      try {
        safeProjectPath(state.projectRoot, file, `${path}.change.changedFiles[${index}]`);
      } catch (error) {
        addIssue('APPLIED_FILE_PATH', `${path}.change.changedFiles[${index}]`, error.message);
      }
    }
  }

  const diffPath = recordedPath(change.diffEvidence, `${path}.change.diffEvidence`);
  if (diffPath) {
    const body = readFileSync(diffPath, 'utf8');
    if (!body.trim() || !body.includes('diff --git')) {
      addIssue('APPLIED_DIFF', `${path}.change.diffEvidence`, 'Recorded diff is empty or not a patch.');
    }
    for (const file of changedFiles || []) {
      const normalized = file.split(sep).join('/');
      if (!body.includes(`a/${normalized}`) && !body.includes(`b/${normalized}`)) {
        addIssue(
          'APPLIED_DIFF_FILE',
          `${path}.change.diffEvidence`,
          `Patch does not contain ${normalized}.`,
        );
      }
    }
  }

  const experimentBuild = passedCheck(
    change.experimentBuildCheckId,
    `${path}.change.experimentBuildCheckId`,
    'production-build',
  );
  const isolated = comparison(change.isolatedComparison, `${path}.change.isolatedComparison`);
  const finalResult = comparison(change.finalComparison, `${path}.change.finalComparison`);
  if (change.isolatedComparison === change.finalComparison) {
    addIssue(
      'FINAL_REBUILD_REQUIRED',
      `${path}.change.finalComparison`,
      'Isolated experiment and final production comparison must be different artifacts.',
    );
  }
  for (const [label, loaded] of [['isolated', isolated], ['final', finalResult]]) {
    if (!loaded) continue;
    if (!(loaded.value.totals?.rawDeltaBytes < 0)) {
      addIssue(
        'NO_RAW_SAVING',
        `${path}.change.${label}Comparison`,
        `${label} comparison does not reduce raw JavaScript bytes.`,
      );
    }
    const baselinePath = canonical(loaded.value.baseline?.path || '.');
    if (!baselineMeasurements.has(baselinePath)) {
      addIssue(
        'CANDIDATE_BASELINE_LINK',
        `${path}.change.${label}Comparison`,
        'Comparison baseline is not declared in baseline.measurements.',
      );
    }
  }
  if (finalResult && !finalComparisonPaths.has(finalResult.absolute)) {
    addIssue(
      'CANDIDATE_FINAL_LINK',
      `${path}.change.finalComparison`,
      'Final comparison is not declared in final.comparisons.',
    );
  }
  if (finalResult) {
    const finalMeasurementPath = canonical(finalResult.value.experiment?.path || '.');
    if (!finalMeasurements.has(finalMeasurementPath)) {
      addIssue(
        'CANDIDATE_FINAL_MEASUREMENT',
        `${path}.change.finalComparison`,
        'Final comparison result is not declared in final.measurements.',
      );
    }
  }
  if (isolated && experimentBuild) {
    validateExperimentMeasurement({
      comparisonValue: isolated.value,
      buildCheck: experimentBuild,
      state,
      root,
      manifest,
      recordedPath,
      fieldPath: `${path}.change.isolatedComparison`,
      addIssue,
    });
  }

  validateCorrectnessChecks(
    change.checkIds,
    `${path}.change.checkIds`,
    passedCheck,
    addIssue,
  );
}

function fixtureArtifact(path) {
  const body = readFileSync(path);
  return {
    kind: 'file',
    path: canonical(path),
    bytes: body.length,
    sha256: sha256(body),
  };
}

function selfTest() {
  const assert = require('assert');
  const root = mkdtempSync(resolve(tmpdir(), 'rspack-audit-state-'));
  try {
    const projectRoot = resolve(root, 'project');
    const runDir = resolve(projectRoot, '.cache', 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(resolve(projectRoot, 'src.js'), 'export const large = true;\n');
    writeFileSync(resolve(projectRoot, '.gitignore'), '.cache/\n');
    assert.equal(commandResult('git', ['init', '-q'], projectRoot).status, 0);
    commandResult('git', ['config', 'user.email', 'fixture@example.com'], projectRoot);
    commandResult('git', ['config', 'user.name', 'Fixture'], projectRoot);
    commandResult('git', ['add', 'src.js', '.gitignore'], projectRoot);
    assert.equal(commandResult('git', ['commit', '-qm', 'fixture'], projectRoot).status, 0);

    const manifest = {
      schemaVersion: 1,
      kind: 'rspack-bundle-data-run',
      runId: 'fixture-run',
      projectRoot: canonical(projectRoot),
      runDir: canonical(runDir),
      commands: [],
      artifacts: [],
    };
    const manifestPath = resolve(runDir, 'manifest.json');
    writeJson(manifestPath, manifest);
    initializeState({
      runDir,
      runId: manifest.runId,
      projectRoot,
      mode: 'audit-only',
      coverage: 'comprehensive',
      goal: 'fixture bundle',
    });

    const addArtifact = (name, value) => {
      const path = resolve(runDir, name);
      mkdirSync(dirname(path), { recursive: true });
      if (typeof value === 'string') writeFileSync(path, value);
      else writeJson(path, value);
      const artifact = fixtureArtifact(path);
      manifest.artifacts.push(artifact);
      return { name, path, artifact };
    };
    const addCommand = (command, recordedAt, artifact, outputDirectory = null) => {
      manifest.commands.push({
        recordedAt,
        command,
        exitCode: 0,
        outputDirectory,
        artifacts: [artifact],
      });
      return manifest.commands.length - 1;
    };
    const measurement = (label, generatedAt, rawBytes) => ({
      schemaVersion: 1,
      kind: 'rspack-bundle-asset-measurement',
      generatedAt,
      runId: manifest.runId,
      label,
      outputDirectory: label === 'baseline'
        ? resolve(runDir, 'baseline/output')
        : label === 'experiment'
          ? resolve(runDir, 'experiments/narrow-import/output')
          : resolve(runDir, 'final/output'),
      inclusionRule: { type: 'regular-expression', source: '\\.js$' },
      totals: { assets: 1, rawBytes, gzipBytes: Math.ceil(rawBytes / 3) },
      assets: [],
    });
    const comparisonValue = (baselinePath, experimentPath, generatedAt, delta) => ({
      schemaVersion: 1,
      kind: 'rspack-bundle-asset-comparison',
      generatedAt,
      baseline: {
        path: canonical(baselinePath),
        runId: manifest.runId,
        inclusionRule: { type: 'regular-expression', source: '\\.js$' },
        totals: { assets: 1, rawBytes: 100, gzipBytes: 34 },
      },
      experiment: {
        path: canonical(experimentPath),
        runId: manifest.runId,
        inclusionRule: { type: 'regular-expression', source: '\\.js$' },
        totals: {
          assets: 1,
          rawBytes: 100 + delta,
          gzipBytes: Math.ceil((100 + delta) / 3),
        },
      },
      inclusionRulesEquivalent: true,
      totals: {
        rawDeltaBytes: delta,
        gzipDeltaBytes: Math.ceil((100 + delta) / 3) - 34,
        assetCountDelta: 0,
      },
      assetSet: { added: [], removed: [], retained: ['main.js'] },
      assets: [],
    });

    const baselineLog = addArtifact('baseline/output/main.js', 'baseline bundle\n');
    const baselineCommand = addCommand(
      'fixture production build',
      '2020-01-01T00:00:00.000Z',
      baselineLog.artifact,
      resolve(runDir, 'baseline/output'),
    );
    const baselineMeasurement = addArtifact(
      'baseline/measurement.json',
      measurement('baseline', '2020-01-01T00:01:00.000Z', 100),
    );
    const familyNotes = new Map();
    for (const definition of FAMILY_DEFINITIONS) {
      familyNotes.set(
        definition.id,
        addArtifact(`notes/${definition.id}.md`, `${definition.label}: checked.\n`),
      );
    }
    writeJson(manifestPath, manifest);

    const statePath = resolve(runDir, 'audit-state.json');
    const state = readJson(statePath, 'fixture state');
    for (const family of state.families) {
      family.status = 'completed';
      family.summary = 'Checked; no material candidate in this fixture.';
      family.discoveredCandidateCount = 0;
      family.noCandidateReason = 'The fixture evidence contains no candidate.';
      family.evidence = [relative(runDir, familyNotes.get(family.id).path)];
    }
    state.checks = [{
      id: 'baseline-build',
      kind: 'production-build',
      status: 'passed',
      commandIndex: baselineCommand,
      summary: 'Baseline production build passed.',
    }];
    state.baseline = {
      productionBuildCheckId: 'baseline-build',
      measurements: [{
        scopeId: 'app-js',
        label: 'Application JavaScript',
        path: relative(runDir, baselineMeasurement.path),
      }],
    };
    writeJson(statePath, state);
    assert.equal(validateAuditState(runDir).complete, true);

    state.families[0].discoveredCandidateCount = 1;
    writeJson(statePath, state);
    assert.equal(validateAuditState(runDir).complete, false);
    state.families[0].discoveredCandidateCount = 0;

    writeFileSync(resolve(projectRoot, 'src.js'), 'export const auditMutation = true;\n');
    writeJson(statePath, state);
    assert.equal(validateAuditState(runDir).complete, false);
    writeFileSync(resolve(projectRoot, 'src.js'), 'export const large = true;\n');

    state.families[0].status = 'pending';
    writeJson(statePath, state);
    assert.equal(validateAuditState(runDir).complete, false);
    state.families[0].status = 'completed';

    state.candidates = [{
      id: 'unproven-opportunity',
      familyId: 'import-export-shape',
      title: 'Claimed measured opportunity',
      status: 'validated-opportunity',
      summary: 'This claim intentionally lacks experiment evidence.',
      evidence: [relative(runDir, familyNotes.get('import-export-shape').path)],
    }];
    const importFamily = state.families.find(
      (family) => family.id === 'import-export-shape',
    );
    importFamily.discoveredCandidateCount = 1;
    importFamily.noCandidateReason = null;
    writeJson(statePath, state);
    assert.equal(validateAuditState(runDir).complete, false);

    state.mode = 'optimize';
    state.candidates = [{
      id: 'narrow-import',
      familyId: 'import-export-shape',
      title: 'Replace a broad import',
      status: 'applied',
      summary: 'The fixture applies a smaller import.',
      evidence: [relative(runDir, familyNotes.get('import-export-shape').path)],
      change: {},
    }];
    writeJson(statePath, state);
    assert.equal(validateAuditState(runDir).complete, false);

    writeFileSync(resolve(projectRoot, 'src.js'), 'export const small = 1;\n');
    const candidateNote = addArtifact('notes/narrow-import.md', 'Broad import retained unused code.\n');
    const diff = addArtifact(
      'experiments/narrow-import/change.diff',
      'diff --git a/src.js b/src.js\n--- a/src.js\n+++ b/src.js\n',
    );
    const experimentLog = addArtifact(
      'experiments/narrow-import/output/main.js',
      'smaller bundle\n',
    );
    const experimentCommand = addCommand(
      'fixture experiment production build',
      '2020-01-01T00:02:00.000Z',
      experimentLog.artifact,
      resolve(runDir, 'experiments/narrow-import/output'),
    );
    const experimentMeasurement = addArtifact(
      'experiments/narrow-import/measurement.json',
      measurement('experiment', '2020-01-01T00:03:00.000Z', 90),
    );
    const isolatedComparison = addArtifact(
      'experiments/narrow-import/comparison.json',
      comparisonValue(
        baselineMeasurement.path,
        experimentMeasurement.path,
        '2020-01-01T00:04:00.000Z',
        -10,
      ),
    );
    const finalLog = addArtifact('final/output/main.js', 'smaller final bundle\n');
    const finalCommand = addCommand(
      'fixture final production build',
      '2020-01-01T00:05:00.000Z',
      finalLog.artifact,
      resolve(runDir, 'final/output'),
    );
    const finalMeasurement = addArtifact(
      'final/measurement.json',
      measurement('final', '2020-01-01T00:06:00.000Z', 90),
    );
    const finalComparison = addArtifact(
      'final/comparison.json',
      comparisonValue(
        baselineMeasurement.path,
        finalMeasurement.path,
        '2020-01-01T00:07:00.000Z',
        -10,
      ),
    );
    const testLog = addArtifact('final/test.log', 'passed\n');
    const testCommand = addCommand(
      'fixture test',
      '2020-01-01T00:08:00.000Z',
      testLog.artifact,
    );
    writeJson(manifestPath, manifest);

    state.candidates[0].evidence = [relative(runDir, candidateNote.path)];
    state.candidates[0].change = {
      changedFiles: ['src.js'],
      diffEvidence: relative(runDir, diff.path),
      experimentBuildCheckId: 'experiment-build',
      isolatedComparison: relative(runDir, isolatedComparison.path),
      finalComparison: relative(runDir, finalComparison.path),
      checkIds: ['fixture-test'],
    };
    state.checks.push(
      {
        id: 'experiment-build',
        kind: 'production-build',
        status: 'passed',
        commandIndex: experimentCommand,
        summary: 'Isolated production experiment passed.',
      },
      {
        id: 'final-build',
        kind: 'production-build',
        status: 'passed',
        commandIndex: finalCommand,
        summary: 'Final production build passed.',
      },
      {
        id: 'fixture-test',
        kind: 'test',
        status: 'passed',
        commandIndex: testCommand,
        summary: 'Affected behavior passed.',
      },
    );
    state.final = {
      productionBuildCheckId: 'final-build',
      measurements: [{
        scopeId: 'app-js',
        label: 'Application JavaScript',
        path: relative(runDir, finalMeasurement.path),
      }],
      comparisons: [{
        scopeId: 'app-js',
        path: relative(runDir, finalComparison.path),
      }],
      projectSnapshot: null,
      sealedAt: null,
    };
    writeJson(statePath, state);
    snapshotFinal(runDir);
    const result = validateAuditState(runDir);
    assert.equal(result.complete, true, JSON.stringify(result.issues, null, 2));

    writeFileSync(resolve(projectRoot, 'src.js'), 'export const changedAfterSeal = 1;\n');
    assert.equal(validateAuditState(runDir).complete, false);
    process.stdout.write('audit-state self-test passed\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const mode = args._[0] || 'validate';
  const runDir = canonical(args['run-dir'] || '.');
  if (mode === 'init') {
    const manifest = readJson(resolve(runDir, 'manifest.json'), 'run manifest');
    const state = initializeState({
      runDir,
      runId: manifest.runId,
      projectRoot: manifest.projectRoot,
      mode: args.mode || 'audit-only',
      coverage: args.coverage || 'comprehensive',
      goal: args.goal || manifest.assetScope,
    });
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  if (mode === 'snapshot-final') {
    const snapshot = snapshotFinal(runDir);
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  if (mode !== 'validate') throw new Error(`Unsupported mode: ${mode}`);
  const result = validateAuditState(runDir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.complete) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = {
  FAMILY_DEFINITIONS,
  initializeState,
  projectSnapshot,
  snapshotFinal,
  validateAuditState,
};
