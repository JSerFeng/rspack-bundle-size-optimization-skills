#!/usr/bin/env node
// Verify runtime-coverage artifact integrity and capture completeness facts.
// This tool does not decide whether any code should be removed or deferred.

const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('fs');
const { createHash } = require('crypto');
const { resolve } = require('path');
const { tmpdir } = require('os');
const {
  ARTIFACTS,
  normalizeRun,
} = require('./normalize-runtime-coverage.cjs');

function parseArgs(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  if (statSync(path).size === 0) throw new Error(`${label} is zero bytes: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot parse ${label} ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function readJsonl(path, label) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  const body = readFileSync(path, 'utf8');
  if (!body) return [];
  try {
    return body.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(
      `Cannot parse ${label} ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function requiredTargetTypes(args) {
  const value = args['require-target-types'];
  if (!value || value === true) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function verifyRun(args) {
  const directory = resolve(args.dir || '.');
  const paths = Object.fromEntries(
    Object.entries(ARTIFACTS).map(([key, file]) => [
      key,
      resolve(directory, file),
    ]),
  );
  const checks = [];
  const failures = [];

  function check(name, pass, details, code = 'INTEGRITY_CHECK_FAILED') {
    checks.push({ name, pass, details });
    if (!pass) failures.push({ code, check: name, reason: details });
  }

  let manifest;
  let session;
  let summary;
  let scriptRows;
  let moduleRows;
  let capturedFailures;
  try {
    manifest = readJson(paths.manifest, 'runtime coverage manifest');
    session = readJson(paths.session, 'runtime coverage session');
    summary = readJson(paths.summary, 'runtime coverage summary');
    scriptRows = readJsonl(paths.scripts, 'runtime coverage script facts');
    moduleRows = readJsonl(paths.modules, 'runtime coverage module facts');
    capturedFailures = readJsonl(
      paths.failures,
      'runtime coverage failure facts',
    );
  } catch (error) {
    return {
      ok: false,
      directory,
      checks,
      failures: [{
        code: 'ARTIFACT_READ_FAILED',
        check: 'artifact-read',
        reason: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  check(
    'manifest-schema',
    manifest.schemaVersion === 1
      && manifest.kind === 'rspack-runtime-coverage-manifest',
    `schemaVersion=${manifest.schemaVersion}, kind=${manifest.kind}`,
    'MANIFEST_SCHEMA_INVALID',
  );
  check(
    'session-schema',
    session.schemaVersion === 1
      && session.kind === 'rspack-runtime-coverage-session',
    `schemaVersion=${session.schemaVersion}, kind=${session.kind}`,
    'SESSION_SCHEMA_INVALID',
  );
  check(
    'summary-schema',
    summary.schemaVersion === 1
      && summary.kind === 'rspack-runtime-coverage-arithmetic',
    `schemaVersion=${summary.schemaVersion}, kind=${summary.kind}`,
    'SUMMARY_SCHEMA_INVALID',
  );

  for (const artifact of Array.isArray(manifest.artifacts)
    ? manifest.artifacts
    : []) {
    const path = resolve(directory, artifact.file);
    if (!existsSync(path)) {
      check(
        `artifact:${artifact.file}`,
        false,
        'file is missing',
        'ARTIFACT_MISSING',
      );
      continue;
    }
    const body = readFileSync(path);
    check(
      `artifact:${artifact.file}`,
      body.length === artifact.bytes && sha256(body) === artifact.sha256,
      `expected bytes=${artifact.bytes} sha256=${artifact.sha256}; `
        + `actual bytes=${body.length} sha256=${sha256(body)}`,
      'ARTIFACT_FINGERPRINT_MISMATCH',
    );
  }

  check(
    'script-row-count',
    scriptRows.length === summary.scripts.selectedJavaScriptEntries,
    `rows=${scriptRows.length}, summary=${summary.scripts.selectedJavaScriptEntries}`,
    'SCRIPT_COUNT_MISMATCH',
  );
  check(
    'module-row-count',
    moduleRows.length === summary.moduleFactories.instances,
    `rows=${moduleRows.length}, summary=${summary.moduleFactories.instances}`,
    'MODULE_COUNT_MISMATCH',
  );
  const zeroCount = moduleRows.filter((row) =>
    row.factoryExecutionCount === 0).length;
  const positiveCount = moduleRows.filter((row) =>
    row.factoryExecutionCount > 0).length;
  check(
    'factory-count-arithmetic',
    zeroCount === summary.moduleFactories.zeroCountInstances
      && positiveCount === summary.moduleFactories.positiveCountInstances
      && zeroCount + positiveCount === moduleRows.length,
    `rows zero=${zeroCount} positive=${positiveCount}; `
      + `summary zero=${summary.moduleFactories.zeroCountInstances} `
      + `positive=${summary.moduleFactories.positiveCountInstances}`,
    'FACTORY_COUNT_ARITHMETIC_MISMATCH',
  );
  const allBytes = moduleRows.reduce(
    (total, row) => total + Number(row.factoryUtf8Bytes || 0),
    0,
  );
  const zeroBytes = moduleRows.reduce(
    (total, row) =>
      total + (row.factoryExecutionCount === 0
        ? Number(row.factoryUtf8Bytes || 0)
        : 0),
    0,
  );
  check(
    'factory-byte-arithmetic',
    allBytes === summary.moduleFactories.allFactoryUtf8Bytes
      && zeroBytes === summary.moduleFactories.zeroCountFactoryUtf8Bytes,
    `rows all=${allBytes} zero=${zeroBytes}; `
      + `summary all=${summary.moduleFactories.allFactoryUtf8Bytes} `
      + `zero=${summary.moduleFactories.zeroCountFactoryUtf8Bytes}`,
    'FACTORY_BYTE_ARITHMETIC_MISMATCH',
  );
  check(
    'source-lengths',
    scriptRows.every((row) => row.source?.lengthMatches === true),
    `${scriptRows.filter((row) => row.source?.lengthMatches === true).length}`
      + `/${scriptRows.length} scripts matched V8 offsets`,
    'SOURCE_INTEGRITY_FAILED',
  );

  const capturedErrors = capturedFailures.filter((failure) =>
    failure.severity === 'error');
  check(
    'captured-errors',
    capturedErrors.length === 0,
    capturedErrors.length
      ? capturedErrors.map((failure) =>
          `${failure.code}: ${failure.reason}`).join('; ')
      : 'none',
    'CAPTURE_REPORTED_ERRORS',
  );

  if (args['require-start-before-navigation'] === true) {
    const fact = session.captureSettings?.startBeforeNavigation;
    check(
      'start-before-navigation',
      fact?.value === true,
      fact?.reason || `recorded value=${String(fact?.value)}`,
      'START_ORDER_NOT_PROVEN',
    );
  }

  const observedTargets = Array.isArray(session.targetsObserved)
    ? session.targetsObserved
    : [];
  for (const targetType of requiredTargetTypes(args)) {
    check(
      `target-type:${targetType}`,
      observedTargets.some((target) => target.targetType === targetType),
      `observed target types: ${
        [...new Set(observedTargets.map((target) => target.targetType))].join(', ')
      }`,
      'REQUIRED_TARGET_TYPE_MISSING',
    );
  }

  return {
    ok: failures.length === 0,
    directory,
    checks,
    capturedWarnings: capturedFailures.filter((failure) =>
      failure.severity === 'warning'),
    failures,
  };
}

function fixtureScript(url, scriptId, moduleId, count, target) {
  const prefix = 'var __webpack_modules__ = {\n';
  const fragment =
    `${JSON.stringify(moduleId)}(module) {\nmodule.exports = 1;\n}`;
  const source = `${prefix}${fragment},\n};\n`;
  return {
    source,
    coverage: {
      targetId: target.targetId,
      targetType: target.targetType,
      scriptId,
      url,
      functions: [
        {
          functionName: '',
          ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
          isBlockCoverage: false,
        },
        {
          functionName: moduleId,
          ranges: [{
            startOffset: prefix.length,
            endOffset: prefix.length + fragment.length,
            count,
          }],
          isBlockCoverage: false,
        },
      ],
    },
  };
}

async function selfTest() {
  const assert = require('assert');
  const root = mkdtempSync(resolve(tmpdir(), 'runtime-coverage-verify-'));
  try {
    const page = fixtureScript(
      'http://fixture/page.js',
      '1',
      './page.js',
      1,
      { targetId: 'page-1', targetType: 'page' },
    );
    const worker = fixtureScript(
      'http://fixture/worker.js',
      '2',
      './worker.js',
      0,
      { targetId: 'worker-1', targetType: 'worker' },
    );
    const coverage = resolve(root, 'coverage.json');
    const sources = resolve(root, 'sources.json');
    const session = resolve(root, 'session.json');
    writeFileSync(coverage, JSON.stringify({
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
    writeFileSync(sources, JSON.stringify({
      scripts: [
        {
          targetId: 'page-1',
          scriptId: '1',
          source: page.source,
        },
        {
          targetId: 'worker-1',
          scriptId: '2',
          source: worker.source,
        },
      ],
    }));
    writeFileSync(session, JSON.stringify({
      capture: { startBeforeNavigation: true },
      targetsExpected: [
        { targetId: 'page-1', targetType: 'page' },
        { targetId: 'worker-1', targetType: 'worker' },
      ],
    }));
    const outDir = resolve(root, 'out');
    await normalizeRun({
      coverage,
      session,
      'source-manifest': sources,
      'include-url-prefix': 'http://fixture/',
      'out-dir': outDir,
    });
    const valid = verifyRun({
      dir: outDir,
      'require-start-before-navigation': true,
      'require-target-types': 'page,worker',
    });
    assert.equal(valid.ok, true);

    const lateSession = resolve(root, 'late-session.json');
    writeFileSync(lateSession, JSON.stringify({
      capture: { startBeforeNavigation: false },
    }));
    const lateOut = resolve(root, 'late-out');
    await normalizeRun({
      coverage,
      session: lateSession,
      'source-manifest': sources,
      'include-url-prefix': 'http://fixture/',
      'out-dir': lateOut,
    });
    const late = verifyRun({
      dir: lateOut,
      'require-start-before-navigation': true,
    });
    assert.equal(late.ok, false);
    assert(
      late.failures.some((failure) =>
        failure.code === 'CAPTURE_REPORTED_ERRORS'
        || failure.code === 'START_ORDER_NOT_PROVEN'),
    );

    const missingWorker = verifyRun({
      dir: outDir,
      'require-target-types': 'page,service_worker',
    });
    assert.equal(missingWorker.ok, false);
    assert(
      missingWorker.failures.some((failure) =>
        failure.code === 'REQUIRED_TARGET_TYPE_MISSING'),
    );

    writeFileSync(
      resolve(outDir, ARTIFACTS.modules),
      `${readFileSync(resolve(outDir, ARTIFACTS.modules), 'utf8')}\n`,
    );
    const tampered = verifyRun({ dir: outDir });
    assert.equal(tampered.ok, false);
    assert(
      tampered.failures.some((failure) =>
        failure.code === 'ARTIFACT_FINGERPRINT_MISMATCH'),
    );
    process.stdout.write(
      'verify-runtime-coverage-artifacts self-test passed\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const result = verifyRun(args);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (result.ok) process.stdout.write(output);
  else {
    process.stderr.write(output);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        failures: [{
          code: 'VERIFIER_CRASHED',
          reason: error instanceof Error ? error.stack || error.message : String(error),
        }],
      }, null, 2)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  readJsonl,
  verifyRun,
};
