const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { main } = require('../query.cjs');
const { usage, module_ } = require('./fixtures.cjs');

test('10k modules / 30k edges query from disk in a fresh process with bounded output', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-query-scale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modules = Array.from({ length: 10000 }, (_, i) => module_(i));
  const edges = modules.flatMap((m, i) => [1, 2, 3].map(delta => ({ origin: m.id, target: String((i + delta) % modules.length), originExport: ['foo'], targetExport: ['foo'] })));
  const input = usage(path.join(dir, 'usage.sqlite'), modules, edges);
  const db = path.join(dir, 'index.sqlite');
  const start = performance.now(); main(['index', '--usage', input, '--out', db]); const indexMs = performance.now() - start;
  const queryStart = performance.now();
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../query.cjs'), 'modules', '--db', db, '--sort', 'usage.distinctConsumers:desc', '--limit', '20', '--format', 'json'], { encoding: 'utf8', timeout: 10000 });
  const queryMs = performance.now() - queryStart;
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout); assert.equal(response.page.total, 10000); assert.equal(response.page.returned, 20);
  assert.ok(response.items.every(m => m.usage.distinctConsumers === 3)); assert.ok(Buffer.byteLength(result.stdout) <= 32768);
  const textResult = spawnSync(process.execPath, [path.resolve(__dirname, '../query.cjs'), 'modules', '--db', db, '--sort', 'usage.distinctConsumers:desc', '--limit', '20'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.ok(textResult.stdout.includes('# Modules'));
  assert.ok(Buffer.byteLength(textResult.stdout) < Buffer.byteLength(result.stdout), 'Text output should be more compact than JSON.');
  const memory = spawnSync(process.execPath, ['-e', 'const {main}=require(process.argv[1]);main(["modules","--db",process.argv[2],"--sort","usage.distinctConsumers:desc"]);console.log(process.resourceUsage().maxRSS)', path.resolve(__dirname, '../query.cjs'), db], { encoding: 'utf8', timeout: 10000 });
  assert.equal(memory.status, 0, memory.stderr);
  t.diagnostic(JSON.stringify({ inputBytes: fs.statSync(input).size, indexBytes: fs.statSync(db).size,
    indexMs: Math.round(indexMs), freshProcessQueryMs: Math.round(queryMs), queryPeakRssKiB: Number(memory.stdout),
    jsonBytes: Buffer.byteLength(result.stdout), textBytes: Buffer.byteLength(textResult.stdout) }));
});
