const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { buildFixture, core } = require('./build-fixture.cjs');
const { main } = require('../query.cjs');
const { record } = require('../record.cjs');
const chrome = process.env.CHROME_PATH;

test('bundled recorder captures actual Chrome block coverage before first-screen ready', { skip: !chrome || !core, timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-browser-real-'));
  const build = await buildFixture(dir);
  fs.writeFileSync(path.join(dir, 'dist/index.html'), '<!doctype html><meta charset="utf-8"><title>Coverage fixture</title><script src="/main.js"></script>');
  const server = http.createServer((request, response) => {
    const file = request.url === '/main.js' ? 'main.js' : 'index.html';
    response.setHeader('Content-Type', `${file.endsWith('.js') ? 'text/javascript' : 'text/html'}; charset=utf-8`); response.end(fs.readFileSync(path.join(dir, 'dist', file)));
  });
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
  const port = fs.readFileSync(activePort, 'utf8').split('\n')[0]; const endpoint = `http://127.0.0.1:${port}`;
  const out = path.join(dir, 'recording.json'); const url = `http://127.0.0.1:${server.address().port}/`;
  const result = await record({ endpoint, url, out, 'ready-expression': 'globalThis.__READY__ === true', timeout: '10000' });
  assert.equal(result.ok, true);
  const data = JSON.parse(fs.readFileSync(out)); assert.equal(data.precision, 'per-block');
  const script = data.scripts.find(script => script.url === `${url}main.js`); assert.ok(script); assert.ok(script.text);
  assert.ok(script.functions.some(fn => fn.ranges.some(range => range.count === 0)), 'Retained cold() implementation should have zero execution count.');
  assert.ok(data.network.some(request => request.url.endsWith('/main.js') && request.status === 200));
  const coverage = path.join(dir, 'coverage.sqlite'); const index = path.join(dir, 'index.sqlite');
  const analysis = main(['analyze', '--build', build, '--coverage', out, '--out', coverage]);
  assert.equal(analysis.precision, 'per-block'); assert.ok(analysis.generated.unusedBytes > 0);
  main(['index', '--coverage', coverage, '--out', index]);
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
