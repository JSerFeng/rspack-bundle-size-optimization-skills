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
  };
  writeFileSync(resolve(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
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

function selfTest() {
  const projectRoot = mkdtempSync(resolve(tmpdir(), 'rspack-audit-run-'));
  try {
    writeFileSync(resolve(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture' }));
    const manifest = createRun({ 'project-root': projectRoot, root: resolve(projectRoot, 'tmp', 'rspack-audit'), 'allow-unignored': true, 'run-id': 'test-run' });
    recordCommand({ 'run-dir': manifest.runDir, command: 'fixture build', 'exit-code': '0', artifacts: 'baseline/stats.json' });
    const reread = JSON.parse(readFileSync(resolve(manifest.runDir, 'manifest.json'), 'utf8'));
    if (reread.runId !== 'test-run' || reread.commands.length !== 1 || !existsSync(resolve(manifest.runDir, 'report'))) throw new Error('self-test assertion failed');
    console.log('create-audit-run self-test passed');
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const mode = args._[0] || 'create';
  const result = mode === 'record' ? recordCommand(args) : createRun(args);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main();
module.exports = { RUN_SUBDIRS, chooseRunRoot, createRun, gitInfo, main, recordCommand };
