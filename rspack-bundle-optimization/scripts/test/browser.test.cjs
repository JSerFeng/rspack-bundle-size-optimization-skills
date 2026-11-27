const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { buildFixture, core } = require('./build-fixture.cjs');
const { main } = require('../query.cjs');
const { record } = require('../record.cjs');
const { comparePaint, summarizePaint } = require('../lib/paint.cjs');
const chrome = process.env.CHROME_PATH;
const run = promisify(execFile);

async function openBrowser(t, dir, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    browser.kill('SIGTERM'); await Promise.race([once(browser, 'exit').catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (!process.env.KEEP_QUERY_FIXTURE) fs.rmSync(dir, { recursive: true, force: true });
  });
  const activePort = path.join(dir, 'profile/DevToolsActivePort'); const deadline = Date.now() + 15000;
  while (!fs.existsSync(activePort)) {
    if (Date.now() > deadline || browser.exitCode !== null) throw new Error('Headless Chrome did not start.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const port = fs.readFileSync(activePort, 'utf8').split('\n')[0];
  return { endpoint: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${server.address().port}/` };
}

test('bundled recorder captures actual Chrome block coverage before first-screen ready', { skip: !chrome || !core, timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-browser-real-'));
  const build = await buildFixture(dir);
  fs.writeFileSync(path.join(dir, 'dist/index.html'), '<!doctype html><meta charset="utf-8"><title>Coverage fixture</title><script src="/main.js"></script>');
  const { endpoint, url } = await openBrowser(t, dir, (request, response) => {
    const file = request.url === '/main.js' ? 'main.js' : 'index.html';
    response.setHeader('Content-Type', `${file.endsWith('.js') ? 'text/javascript' : 'text/html'}; charset=utf-8`); response.end(fs.readFileSync(path.join(dir, 'dist', file)));
  });
  const out = path.join(dir, 'recording.json');
  const result = await record({ endpoint, url, out, 'ready-expression': 'globalThis.__READY__ === true', timeout: '10000' });
  assert.equal(result.ok, true);
  const data = JSON.parse(fs.readFileSync(out)); assert.equal(data.precision, 'per-block');
  const script = data.scripts.find(script => script.url === `${url}main.js`); assert.ok(script); assert.ok(script.text);
  assert.ok(script.functions.some(fn => fn.ranges.some(range => range.count === 0)), 'Retained cold() implementation should have zero execution count.');
  assert.ok(data.network.some(request => request.url.endsWith('/main.js') && request.status === 200));
  const index = path.join(dir, 'index.sqlite');
  const analysis = main(['index', '--build', build, '--coverage', out, '--out', index]);
  assert.equal(analysis.precision, 'per-block'); assert.ok(analysis.generated.unusedBytes > 0);
  const modules = main(['modules', '--db', index, '--scope', 'loaded', '--sort', 'coverage.generated.unexecutedBytes:desc']);
  assert.ok(modules.items.some(module => module.coverage.generated?.unexecutedBytes > 0));
  // Re-recording the same ready page must wait for its new document, never accept the old ready marker.
  const repeat = path.join(dir, 'repeat.json'); await record({ endpoint, url, out: repeat, 'ready-expression': 'globalThis.__READY__ === true' });
  assert.ok(JSON.parse(fs.readFileSync(repeat)).scripts.some(script => script.url === `${url}main.js`));
  const hashRoute = path.join(dir, 'hash-route.json'); await record({ endpoint, url: `${url}#hash-route`, out: hashRoute, 'ready-expression': 'globalThis.__READY__ === true' });
  assert.ok(JSON.parse(fs.readFileSync(hashRoute)).scripts.some(script => script.url === `${url}main.js`));
  const failed = path.join(dir, 'timeout.json');
  await assert.rejects(() => record({ endpoint, url, out: failed, 'ready-expression': 'false', timeout: '100' }), error => error.code === 'RECORDING_TIMEOUT');
  assert.equal(fs.existsSync(failed), false);
  const invalid = path.join(dir, 'invalid.json');
  await assert.rejects(() => record({ endpoint, url, out: invalid, 'ready-selector': '[' }), error => error.code === 'READINESS_FAILED');
  assert.equal(fs.existsSync(invalid), false);
  t.diagnostic(JSON.stringify({ directory: dir, scriptCount: data.scripts.length, generated: analysis.generated, modules: modules.page.total }));
});

test('record isolates reused Chrome tabs across different builds without leaking old scripts or requests', { skip: !chrome, timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-browser-reuse-'));
  let serveOld = true;
  const { endpoint, url } = await openBrowser(t, dir, (request, response) => {
    if (request.url === '/old.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end('globalThis.__OLD_READY__ = true; function oldOnly() { return 1; }\n');
      return;
    }
    if (request.url === '/new.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end('globalThis.__NEW_READY__ = true; function newOnly() { return 2; }\n');
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(serveOld
      ? '<!doctype html><script src="/old.js"></script>'
      : '<!doctype html><script src="/new.js"></script>');
  });
  await record({ endpoint, url, out: path.join(dir, 'old.json'), 'ready-expression': 'globalThis.__OLD_READY__ === true', timeout: '10000' });
  serveOld = false;
  const newRecPath = path.join(dir, 'new.json');
  await record({ endpoint, url, out: newRecPath, 'ready-expression': 'globalThis.__NEW_READY__ === true', timeout: '10000' });
  const newRec = JSON.parse(fs.readFileSync(newRecPath, 'utf8'));
  assert.ok(newRec.scripts.some(s => s.url.endsWith('/new.js')));
  assert.equal(newRec.scripts.some(s => s.url.endsWith('/old.js')), false, 'Old document script must not leak into new recording.');
  assert.equal(newRec.network.some(r => r.url.endsWith('/old.js')), false, 'Old document request must not leak into new recording.');
  assert.equal(newRec.gaps.some(g => g.kind === 'script-source'), false, 'Old document scripts must not produce script-source gaps.');
});

test('paint comparison uses each median and prioritizes either regression', () => {
  const medians = summarizePaint([
    { fcpMs: 110, lcpMs: 2010 },
    { fcpMs: 900, lcpMs: 2080 },
    { fcpMs: 100, lcpMs: 2000 },
    { fcpMs: 130, lcpMs: 2000 },
  ]);
  assert.deepEqual(medians, { fcpMs: 120, lcpMs: 2005 });
  const mixed = comparePaint(medians, { fcpMs: 90, lcpMs: 2056 });
  assert.equal(mixed.metrics.fcpMs.status, 'improved');
  assert.equal(mixed.metrics.lcpMs.thresholdMs, 40.1);
  assert.equal(mixed.status, 'regressed');
  assert.equal(comparePaint(medians, { fcpMs: 91, lcpMs: 2045 }).status, 'within-noise');
  assert.equal(comparePaint(medians, { fcpMs: 90, lcpMs: 2005 }).status, 'improved');
});

test('scan measures page variants and rejects a real Chrome paint regression', { skip: !chrome, timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-paint-real-'));
  let renderDelay = 0;
  let mainRequests = 0;
  const { endpoint, url } = await openBrowser(t, dir, (request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    mainRequests++;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta charset="utf-8">
      <body>
      <script>setTimeout(() => {
        const heading = document.createElement('h1');
        heading.id = 'ready';
        heading.textContent = 'The application has rendered its main content';
        document.body.append(heading);
      }, ${renderDelay})</script>`);
  });

  const baseline = path.join(dir, 'before.json');
  const candidate = path.join(dir, 'after.json');
  const command = (...flags) => run(process.execPath, [
    path.join(__dirname, '../scan.cjs'), '--endpoint', endpoint, '--url', `${url}#route`,
    '--ready-selector', '#ready', '--settle-ms', '100', ...flags,
  ]);
  const beforeRun = await command('--out', baseline);
  const before = JSON.parse(beforeRun.stdout);
  assert.ok(beforeRun.stderr.includes('[scan] warmup:'), 'scan.cjs should emit warmup progress to stderr.');
  assert.ok(beforeRun.stderr.includes('[scan] run 3/3:'), 'scan.cjs should emit per-run progress to stderr.');
  assert.deepEqual(before.diagnostics, { failedAssets: 0, pageErrors: 0 });
  const savedBefore = fs.readFileSync(baseline, 'utf8');
  assert.equal(before.comparison, null);
  assert.equal(JSON.parse(savedBefore).samples.length, 3);
  assert.equal(mainRequests, 4, 'Every warm-up and measured sample must reload the document.');

  renderDelay = 400;
  await assert.rejects(command('--against', baseline, '--out', candidate), error => {
    assert.equal(error.code, 1);
    const summary = JSON.parse(error.stdout);
    assert.equal(summary.comparison.status, 'regressed');
    assert.equal(summary.comparison.metrics.fcpMs.status, 'regressed');
    assert.equal(summary.comparison.metrics.lcpMs.status, 'regressed');
    return true;
  });
  const savedAfter = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  assert.equal(savedAfter.samples.length, 3);
  assert.ok(savedAfter.samples.every(sample => sample.fcpMs >= 400 && sample.lcpMs >= 400 && sample.lcpElement.tag === 'h1'));
  assert.equal(mainRequests, 8);
  assert.equal(fs.readFileSync(baseline, 'utf8'), savedBefore);

  const failed = path.join(dir, 'failed.json');
  await assert.rejects(command('--against', baseline, '--cache', 'warm', '--out', failed),
    error => JSON.parse(error.stdout).error.code === 'INCOMPARABLE_RUNS');
  assert.equal(mainRequests, 8);
  await assert.rejects(command('--ready-selector', '#missing', '--timeout', '1000', '--out', failed),
    error => JSON.parse(error.stdout).error.code === 'MEASUREMENT_TIMEOUT');
  assert.equal(fs.existsSync(failed), false);

  const mobile = path.join(dir, 'mobile.json');
  await command('--throttle', 'mobile', '--out', mobile);
  assert.equal(JSON.parse(fs.readFileSync(mobile, 'utf8')).conditions.throttle, 'mobile');
});
