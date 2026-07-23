#!/usr/bin/env node
// Create an isolated data run and fingerprint recorded evidence.
// This tool stores facts only. It has no candidate, verdict, or completion model.

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
const { isAbsolute, relative, resolve, sep } = require('path');
const { tmpdir } = require('os');

const RUN_SUBDIRS = ['baseline', 'captures', 'experiments', 'notes'];

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

function fingerprintFile(path) {
  const body = readFileSync(path);
  return {
    kind: 'file',
    path: canonical(path),
    bytes: body.length,
    sha256: sha256(body),
  };
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

function fingerprintDirectory(path) {
  const root = canonical(path);
  const files = listFiles(root);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const body = readFileSync(file);
    const name = relative(root, file).split(sep).join('/');
    bytes += body.length;
    hash.update(name);
    hash.update('\0');
    hash.update(sha256(body));
    hash.update('\n');
  }
  return {
    kind: 'directory',
    path: root,
    files: files.length,
    bytes,
    sha256: hash.digest('hex'),
  };
}

function fingerprintPath(path) {
  const absolute = canonical(path);
  if (!existsSync(absolute)) throw new Error(`Cannot fingerprint missing path: ${absolute}`);
  const stats = statSync(absolute);
  if (stats.isFile()) return fingerprintFile(absolute);
  if (stats.isDirectory()) return fingerprintDirectory(absolute);
  throw new Error(`Unsupported evidence path type: ${absolute}`);
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function gitInfo(projectRoot) {
  const commit = runCommand('git', ['rev-parse', 'HEAD'], projectRoot);
  if (!commit) return { available: false, commit: null, dirty: null };
  const status = runCommand(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    projectRoot,
  );
  return {
    available: true,
    commit,
    dirty: Boolean(status),
    statusSha256: sha256(status || ''),
  };
}

function isGitIgnored(projectRoot, pathToCheck) {
  return spawnSync('git', ['check-ignore', '-q', pathToCheck], {
    cwd: projectRoot,
  }).status === 0;
}

function chooseRunRoot(projectRoot, requested, allowUnignored) {
  if (requested) {
    const chosen = canonical(
      isAbsolute(requested) ? requested : resolve(projectRoot, requested),
    );
    if (
      !allowUnignored
      && gitInfo(projectRoot).available
      && !isGitIgnored(projectRoot, chosen)
    ) {
      throw new Error(
        `Requested data root is not git-ignored: ${chosen}. `
        + 'Choose an ignored project-local root or pass --allow-unignored deliberately.',
      );
    }
    return chosen;
  }
  const choices = [
    resolve(projectRoot, 'tmp', 'rspack-bundle-data'),
    resolve(projectRoot, '.tmp', 'rspack-bundle-data'),
    resolve(projectRoot, '.cache', 'rspack-bundle-data'),
    resolve(projectRoot, 'node_modules', '.cache', 'rspack-bundle-data'),
  ];
  if (!gitInfo(projectRoot).available) return choices[0];
  const ignored = choices.find((choice) => isGitIgnored(projectRoot, choice));
  if (!ignored) {
    throw new Error(
      'No known project-local ignored data root was found. '
      + 'Inspect the project and pass --root <ignored-path>.',
    );
  }
  return ignored;
}

function makeRunId() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${timestamp}-${randomBytes(3).toString('hex')}`;
}

function readManifest(runDir) {
  const path = resolve(runDir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`Missing run manifest: ${path}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (
    manifest.schemaVersion !== 1
    || manifest.kind !== 'rspack-bundle-data-run'
  ) {
    throw new Error('Unsupported or missing run manifest schema');
  }
  if (canonical(manifest.runDir) !== canonical(runDir)) {
    throw new Error('Manifest runDir does not match the selected run');
  }
  return { manifest, path };
}

function createRun(args) {
  const projectRoot = canonical(args['project-root'] || process.cwd());
  const root = chooseRunRoot(
    projectRoot,
    args.root,
    Boolean(args['allow-unignored']),
  );
  const runId = String(args['run-id'] || makeRunId())
    .replace(/[^a-zA-Z0-9._-]/g, '-');
  const runDir = resolve(root, runId);
  if (existsSync(runDir)) throw new Error(`Data run already exists: ${runDir}`);

  mkdirSync(runDir, { recursive: true });
  for (const directory of RUN_SUBDIRS) {
    mkdirSync(resolve(runDir, directory), { recursive: true });
  }

  const manifest = {
    schemaVersion: 1,
    kind: 'rspack-bundle-data-run',
    runId,
    createdAt: new Date().toISOString(),
    projectRoot,
    runDir,
    buildCommand: args['build-command'] || null,
    assetScope: args['asset-scope'] || null,
    git: gitInfo(projectRoot),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    commands: [],
    artifacts: [],
  };
  writeFileSync(
    resolve(runDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function resolveInsideRun(runDir, value) {
  const path = canonical(isAbsolute(value) ? value : resolve(runDir, value));
  const rel = relative(runDir, path);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`Evidence path must stay inside the data run: ${path}`);
  }
  return path;
}

function recordCommand(args) {
  const runDir = canonical(args['run-dir'] || '.');
  const { manifest, path: manifestPath } = readManifest(runDir);
  if (!args.command) throw new Error('--command is required in record mode');
  if (args['exit-code'] === undefined) {
    throw new Error('--exit-code is required in record mode');
  }

  const artifactPaths = String(args.artifacts || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolveInsideRun(runDir, value));
  const artifacts = artifactPaths.map(fingerprintPath);
  const entry = {
    recordedAt: new Date().toISOString(),
    command: String(args.command),
    exitCode: Number(args['exit-code']),
    outputDirectory: args['output-dir']
      ? resolveInsideRun(runDir, args['output-dir'])
      : null,
    artifacts,
  };
  if (!Number.isSafeInteger(entry.exitCode)) {
    throw new Error('--exit-code must be an integer');
  }

  manifest.commands.push(entry);
  const byPath = new Map(
    [...(manifest.artifacts || []), ...artifacts]
      .map((artifact) => [artifact.path, artifact]),
  );
  manifest.artifacts = [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return entry;
}

function verifyRun(args) {
  const runDir = canonical(args['run-dir'] || '.');
  const { manifest } = readManifest(runDir);
  const checks = (manifest.artifacts || []).map((recorded) => {
    const current = fingerprintPath(recorded.path);
    return {
      path: recorded.path,
      matches:
        recorded.kind === current.kind
        && recorded.bytes === current.bytes
        && recorded.sha256 === current.sha256
        && (recorded.kind !== 'directory' || recorded.files === current.files),
      recorded,
      current,
    };
  });
  const changed = checks.filter((check) => !check.matches);
  if (changed.length) {
    throw new Error(
      `Evidence verification failed for ${changed.length} path(s): `
      + changed.map((row) => row.path).join(', '),
    );
  }
  return {
    runId: manifest.runId,
    artifactCount: checks.length,
    verified: checks.length,
  };
}

function selfTest() {
  const assert = require('assert');
  const root = mkdtempSync(resolve(tmpdir(), 'rspack-bundle-data-run-'));
  try {
    writeFileSync(resolve(root, 'package.json'), '{"name":"fixture"}\n');
    const manifest = createRun({
      'project-root': root,
      root: resolve(root, 'data'),
      'allow-unignored': true,
      'run-id': 'test-run',
      'asset-scope': 'fixture JavaScript',
    });
    const artifact = resolve(manifest.runDir, 'baseline', 'measurement.json');
    writeFileSync(artifact, '{"raw":10}\n');
    recordCommand({
      'run-dir': manifest.runDir,
      command: 'fixture build',
      'exit-code': '0',
      artifacts: 'baseline/measurement.json',
    });
    const verification = verifyRun({ 'run-dir': manifest.runDir });
    assert.equal(verification.verified, 1);
    assert.throws(
      () => resolveInsideRun(manifest.runDir, '../outside'),
      /must stay inside/,
    );
    writeFileSync(artifact, '{"raw":11}\n');
    assert.throws(
      () => verifyRun({ 'run-dir': manifest.runDir }),
      /verification failed/,
    );
    process.stdout.write('create-audit-run self-test passed\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const mode = args._[0] || 'create';
  const result = mode === 'record'
    ? recordCommand(args)
    : mode === 'verify'
      ? verifyRun(args)
      : createRun(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = {
  RUN_SUBDIRS,
  chooseRunRoot,
  createRun,
  fingerprintPath,
  main,
  recordCommand,
  verifyRun,
};
