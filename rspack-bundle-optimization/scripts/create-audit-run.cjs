#!/usr/bin/env node
// Create and update an isolated, fingerprinted bundle-audit run directory.

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
const { createHash, randomBytes } = require('crypto');
const { spawnSync } = require('child_process');
const { basename, dirname, isAbsolute, resolve } = require('path');
const { tmpdir } = require('os');

const RUN_SUBDIRS = [
  'baseline', 'reachability', 'retained-unused', 'side-effects', 'export-usage',
  'rollup-diff', 'cjs2esm', 'splitchunks', 'ecma', 'post-loader', 'report',
];
const ROUTE_IDS = [
  'baseline', 'reachability', 'retained-unused', 'side-effects', 'export-usage',
  'rollup-diff', 'cjs2esm', 'splitchunks', 'ecma', 'post-loader',
];
const TERMINAL_DISPOSITIONS = new Set([
  'applied', 'validated-opportunity', 'keep', 'risk-found', 'rejected', 'blocked',
]);
const TERMINAL_ROUTE_STATES = new Set(['completed', 'completed-no-op', 'blocked']);

function parseArgs(argv) {
  const values = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { values._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i += 1; }
  }
  return values;
}

function canonical(value) {
  const absolute = resolve(value);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashFile(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const body = readFileSync(file);
  return { path: file, bytes: body.length, sha256: sha256(body) };
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function gitInfo(projectRoot) {
  const commit = runCommand('git', ['rev-parse', 'HEAD'], projectRoot);
  if (!commit) return { available: false, commit: null, dirty: null };
  const status = runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], projectRoot);
  return { available: true, commit, dirty: Boolean(status), statusSha256: sha256(status || '') };
}

function isGitIgnored(projectRoot, candidate) {
  return spawnSync('git', ['check-ignore', '-q', candidate], { cwd: projectRoot }).status === 0;
}

function chooseRunRoot(projectRoot, requested, allowUnignored) {
  if (requested) {
    const chosen = canonical(isAbsolute(requested) ? requested : resolve(projectRoot, requested));
    if (!allowUnignored && gitInfo(projectRoot).available && !isGitIgnored(projectRoot, chosen)) {
      throw new Error(`Requested audit root is not git-ignored: ${chosen}. Choose an ignored project-local root or pass --allow-unignored deliberately.`);
    }
    return chosen;
  }
  const candidates = [
    resolve(projectRoot, 'tmp', 'rspack-audit'),
    resolve(projectRoot, '.tmp', 'rspack-audit'),
    resolve(projectRoot, '.cache', 'rspack-audit'),
    resolve(projectRoot, 'node_modules', '.cache', 'rspack-audit'),
  ];
  if (!gitInfo(projectRoot).available) return candidates[0];
  const ignored = candidates.find((candidate) => isGitIgnored(projectRoot, candidate));
  if (!ignored) {
    throw new Error('No known project-local ignored audit root was found. Inspect the project and pass --root <ignored-path>.');
  }
  return ignored;
}

function packageVersion(projectRoot, name) {
  try {
    const packageJson = require.resolve(`${name}/package.json`, { paths: [projectRoot] });
    return JSON.parse(readFileSync(packageJson, 'utf8')).version || null;
  } catch {
    try {
      let current = dirname(require.resolve(name, { paths: [projectRoot] }));
      while (dirname(current) !== current) {
        const packageJson = resolve(current, 'package.json');
        if (existsSync(packageJson)) return JSON.parse(readFileSync(packageJson, 'utf8')).version || null;
        current = dirname(current);
      }
    } catch { /* package is not installed or its entry is not resolvable */ }
    return null;
  }
}

function configFingerprints(projectRoot, extraConfig) {
  const names = new Set(['package.json']);
  for (const name of readdirSync(projectRoot)) {
    if (/^(rspack|rsbuild|rspeedy|edenx)\.config\.(js|cjs|mjs|ts|cts|mts)$/.test(name)) names.add(name);
  }
  for (const value of String(extraConfig || '').split(',').filter(Boolean)) names.add(value);
  return [...names]
    .map((name) => hashFile(isAbsolute(name) ? name : resolve(projectRoot, name)))
    .filter(Boolean);
}

function lockfileFingerprint(projectRoot) {
  for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    const fingerprint = hashFile(resolve(projectRoot, name));
    if (fingerprint) return fingerprint;
  }
  return null;
}

function packageManagerInfo(projectRoot) {
  const packageJson = existsSync(resolve(projectRoot, 'package.json'))
    ? JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'))
    : {};
  const declared = packageJson.packageManager || null;
  const executable = declared ? declared.split('@')[0] : existsSync(resolve(projectRoot, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(resolve(projectRoot, 'yarn.lock')) ? 'yarn' : 'npm';
  return { declared, executable, version: runCommand(executable, ['--version'], projectRoot) };
}

function envFingerprints(keys) {
  return [...new Set(keys.filter(Boolean))].sort().map((key) => ({
    key,
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    valueSha256: Object.prototype.hasOwnProperty.call(process.env, key) ? sha256(String(process.env[key])) : null,
  }));
}

function makeRunId() {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
}

function createCandidateLedger(runId) {
  return {
    schemaVersion: 1,
    kind: 'rspack-bundle-candidate-ledger',
    runId,
    updatedAt: new Date().toISOString(),
    routes: ROUTE_IDS.map((id) => ({
      id,
      state: 'pending',
      coverage: {
        discovered: null,
        terminal: null,
        unresolved: null,
        applied: null,
        riskFound: null,
      },
      result: null,
      evidence: [],
      candidates: [],
    })),
  };
}

function evidencePresent(value) {
  if (Array.isArray(value)) return value.some(evidencePresent);
  if (value && typeof value === 'object') return Object.values(value).some(evidencePresent);
  return typeof value === 'string' && value.trim().length > 0;
}

function validateCandidateLedger(ledger) {
  if (!ledger || ledger.schemaVersion !== 1 || ledger.kind !== 'rspack-bundle-candidate-ledger') {
    throw new Error('Candidate ledger has an unsupported or missing schema');
  }
  if (typeof ledger.runId !== 'string' || !ledger.runId) throw new Error('Candidate ledger is missing runId');
  if (!Array.isArray(ledger.routes)) throw new Error('Candidate ledger routes must be an array');
  const routeById = new Map();
  for (const route of ledger.routes) {
    if (!route || typeof route.id !== 'string' || routeById.has(route.id)) {
      throw new Error(`Candidate ledger contains a missing or duplicate route id: ${route?.id}`);
    }
    routeById.set(route.id, route);
  }
  const missing = ROUTE_IDS.filter((id) => !routeById.has(id));
  const extra = [...routeById.keys()].filter((id) => !ROUTE_IDS.includes(id));
  if (missing.length || extra.length) {
    throw new Error(`Candidate ledger route mismatch; missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
  }

  for (const id of ROUTE_IDS) {
    const route = routeById.get(id);
    if (!TERMINAL_ROUTE_STATES.has(route.state)) throw new Error(`Route ${id} is not terminal`);
    if (typeof route.result !== 'string' || !route.result.trim()) throw new Error(`Route ${id} is missing a result`);
    if (!evidencePresent(route.evidence)) throw new Error(`Route ${id} is missing fresh evidence`);
    if (route.state === 'blocked') {
      for (const field of ['attemptedCommand', 'error', 'missingPrerequisite', 'nextCommand']) {
        if (!route[field]) throw new Error(`Route ${id} blocked state is missing ${field}`);
      }
    }
    if (!Array.isArray(route.candidates)) throw new Error(`Route ${id} candidates must be an array`);
    const candidateIds = new Set();
    let applied = 0;
    let riskFound = 0;
    for (const candidate of route.candidates) {
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id || candidateIds.has(candidate.id)) {
        throw new Error(`Route ${id} contains a missing or duplicate candidate id: ${candidate?.id}`);
      }
      candidateIds.add(candidate.id);
      if (!TERMINAL_DISPOSITIONS.has(candidate.disposition)) {
        throw new Error(`Route ${id} candidate ${candidate.id} has a non-terminal disposition`);
      }
      if (!evidencePresent(candidate.evidence)) {
        throw new Error(`Route ${id} candidate ${candidate.id} is missing source-backed evidence`);
      }
      if (typeof candidate.conclusion !== 'string' || !candidate.conclusion.trim()) {
        throw new Error(`Route ${id} candidate ${candidate.id} is missing a conclusion`);
      }
      if (candidate.disposition === 'applied') applied++;
      if (candidate.disposition === 'risk-found') {
        riskFound++;
        if (!candidate.risk || !candidate.clearingCondition) {
          throw new Error(`Route ${id} candidate ${candidate.id} risk-found requires risk and clearingCondition`);
        }
      }
      if (candidate.disposition === 'blocked') {
        for (const field of ['attemptedCommand', 'error', 'missingPrerequisite', 'nextCommand']) {
          if (!candidate[field]) throw new Error(`Route ${id} candidate ${candidate.id} blocked disposition is missing ${field}`);
        }
      }
    }
    const expectedCoverage = {
      discovered: route.candidates.length,
      terminal: route.candidates.length,
      unresolved: 0,
      applied,
      riskFound,
    };
    const blockedCandidates = route.candidates.filter((candidate) => candidate.disposition === 'blocked');
    if (blockedCandidates.length > 0 && route.state !== 'blocked') {
      throw new Error(`Route ${id} contains blocked candidates but route state is ${route.state}`);
    }
    if (route.state === 'completed-no-op') {
      const actionable = route.candidates.filter((candidate) => ['applied', 'validated-opportunity', 'risk-found'].includes(candidate.disposition));
      if (actionable.length > 0) {
        throw new Error(`Route ${id} completed-no-op contains actionable candidate dispositions`);
      }
    }
    for (const [key, value] of Object.entries(expectedCoverage)) {
      if (route.coverage?.[key] !== value) {
        throw new Error(`Route ${id} coverage.${key} must be ${value}, got ${route.coverage?.[key]}`);
      }
    }
  }
  return ledger;
}

function createRun(args) {
  const projectRoot = canonical(args['project-root'] || process.cwd());
  const root = chooseRunRoot(projectRoot, args.root, Boolean(args['allow-unignored']));
  const runId = String(args['run-id'] || makeRunId()).replace(/[^a-zA-Z0-9._-]/g, '-');
  const runDir = resolve(root, runId);
  if (existsSync(runDir)) throw new Error(`Audit run already exists: ${runDir}`);
  mkdirSync(runDir, { recursive: true });
  for (const subdir of RUN_SUBDIRS) mkdirSync(resolve(runDir, subdir), { recursive: true });

  const envKeys = ['NODE_ENV', 'BUILD_MODE', 'RSPACK_CONFIG_VALIDATE', ...String(args['env-keys'] || '').split(',')];
  const manifest = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    projectRoot,
    runDir,
    buildCommand: args['build-command'] || null,
    metricRule: args['metric-rule'] || 'emitted JavaScript raw bytes primary; gzip secondary; appJs inclusion list required',
    git: gitInfo(projectRoot),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      packageManager: packageManagerInfo(projectRoot),
      packages: Object.fromEntries(['@rspack/core', '@rsbuild/core', '@rspeedy/core', '@swc/core', 'terser'].map((name) => [name, packageVersion(projectRoot, name)])),
    },
    fingerprints: {
      lockfile: lockfileFingerprint(projectRoot),
      configs: configFingerprints(projectRoot, args.config),
      environment: envFingerprints(envKeys),
    },
    commands: [],
    artifacts: [],
    candidateLedger: resolve(runDir, 'candidate-ledger.json'),
  };
  writeFileSync(resolve(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(resolve(runDir, 'candidate-ledger.json'), JSON.stringify(createCandidateLedger(runId), null, 2) + '\n');
  return manifest;
}

function recordCommand(args) {
  const runDir = canonical(args['run-dir'] || '.');
  const manifestPath = resolve(runDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
  if (!args.command) throw new Error('--command is required in record mode');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (canonical(manifest.runDir) !== runDir) throw new Error('Manifest runDir does not match --run-dir');
  const artifacts = String(args.artifacts || '').split(',').filter(Boolean).map((value) => canonical(isAbsolute(value) ? value : resolve(runDir, value)));
  const entry = {
    recordedAt: new Date().toISOString(),
    command: args.command,
    exitCode: args['exit-code'] === undefined ? null : Number(args['exit-code']),
    outputDirectory: args['output-dir'] ? canonical(isAbsolute(args['output-dir']) ? args['output-dir'] : resolve(runDir, args['output-dir'])) : null,
    artifacts,
  };
  manifest.commands.push(entry);
  manifest.artifacts = [...new Set([...(manifest.artifacts || []), ...artifacts])];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return entry;
}

function validateLedger(args) {
  const runDir = canonical(args['run-dir'] || '.');
  const manifestPath = resolve(runDir, 'manifest.json');
  const ledgerPath = resolve(runDir, args.ledger || 'candidate-ledger.json');
  if (!existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
  if (!existsSync(ledgerPath)) throw new Error(`Missing candidate ledger: ${ledgerPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const ledger = validateCandidateLedger(JSON.parse(readFileSync(ledgerPath, 'utf8')));
  if (manifest.runId !== ledger.runId) throw new Error('Candidate ledger runId does not match manifest runId');
  return {
    runId: ledger.runId,
    routes: ledger.routes.length,
    discovered: ledger.routes.reduce((sum, route) => sum + route.coverage.discovered, 0),
    terminal: ledger.routes.reduce((sum, route) => sum + route.coverage.terminal, 0),
    checks: ledger.routes.map((route) => ({
      id: route.id,
      state: route.state,
      result: route.result,
      evidence: route.evidence,
      coverage: route.coverage,
      attemptedCommand: route.attemptedCommand || null,
      error: route.error || null,
      missingPrerequisite: route.missingPrerequisite || null,
      nextCommand: route.nextCommand || null,
    })),
  };
}

function selfTest() {
  const assert = require('assert');
  const projectRoot = mkdtempSync(resolve(tmpdir(), 'rspack-audit-run-'));
  try {
    writeFileSync(resolve(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture' }));
    const manifest = createRun({ 'project-root': projectRoot, root: resolve(projectRoot, 'tmp', 'rspack-audit'), 'allow-unignored': true, 'run-id': 'test-run' });
    recordCommand({ 'run-dir': manifest.runDir, command: 'fixture build', 'exit-code': '0', artifacts: 'baseline/stats.json' });
    const ledgerPath = resolve(manifest.runDir, 'candidate-ledger.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assert.throws(() => validateCandidateLedger(ledger), /not terminal/);
    for (const route of ledger.routes) {
      route.state = 'completed-no-op';
      route.coverage = { discovered: 0, terminal: 0, unresolved: 0, applied: 0, riskFound: 0 };
      route.result = 'fixture no-op proof';
      route.evidence = [`${route.id}/complete.json`];
    }
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
    const validation = validateLedger({ 'run-dir': manifest.runDir });
    const reread = JSON.parse(readFileSync(resolve(manifest.runDir, 'manifest.json'), 'utf8'));
    if (reread.runId !== 'test-run' || reread.commands.length !== 1 || validation.routes !== 10 || !existsSync(resolve(manifest.runDir, 'report'))) throw new Error('self-test assertion failed');
    console.log('create-audit-run self-test passed');
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const mode = args._[0] || 'create';
  const result = mode === 'record'
    ? recordCommand(args)
    : mode === 'validate-ledger'
      ? validateLedger(args)
      : createRun(args);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main();
module.exports = {
  ROUTE_IDS,
  RUN_SUBDIRS,
  chooseRunRoot,
  createCandidateLedger,
  createRun,
  gitInfo,
  main,
  recordCommand,
  validateCandidateLedger,
  validateLedger,
};
