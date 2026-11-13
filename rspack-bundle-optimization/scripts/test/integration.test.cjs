// Optional owning-tool integration: RSPACK_COVERAGE_REPO=/path/to/rspack-coverage npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { main } = require('../query.cjs');

test('real Rspack build -> headless coverage export -> skill queries', { skip: !process.env.RSPACK_COVERAGE_REPO }, async t => {
  const repo = path.resolve(process.env.RSPACK_COVERAGE_REPO);
  const requireTool = createRequire(path.join(repo, 'packages/rspack-coverage/package.json'));
  const { rspack } = requireTool('@rspack/core');
  const { RspackCoveragePlugin } = require(path.join(repo, 'packages/rspack-coverage/dist/index.cjs'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-query-real-'));
  if (!process.env.KEEP_QUERY_FIXTURE) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.js'), "import { hot, cold } from './dep.js'; globalThis.api = { hot, cold }; hot();\n");
  fs.writeFileSync(path.join(dir, 'dep.js'), "import { leaf } from './leaf.js';\nexport function hot() { return leaf(); }\nexport function cold() { return 'cold'; }\n");
  fs.writeFileSync(path.join(dir, 'leaf.js'), "export function leaf() { return '热'; }\n");
  const cache = path.join(dir, 'cache');
  const compiler = rspack({ context: dir, mode: 'production', entry: './index.js', devtool: 'source-map',
    output: { path: path.join(dir, 'dist'), filename: 'main.js' }, optimization: { concatenateModules: false },
    plugins: [new RspackCoveragePlugin({ server: false, dataDir: cache })] });
  try {
    const stats = await new Promise((resolve, reject) => compiler.run((error, value) => error ? reject(error) : resolve(value)));
    assert.equal(stats.hasErrors(), false, stats.toString({ errors: true }));
  } finally { await new Promise(resolve => compiler.close(resolve)); }
  const pointer = JSON.parse(fs.readFileSync(path.join(cache, 'latest.json')));
  const snapshot = path.join(cache, 'snapshots', pointer.snapshotId);
  const metadata = JSON.parse(fs.readFileSync(path.join(snapshot, 'metadata.json')));
  const asset = metadata.manifest.assets[0];
  const stored = metadata.assets.find(item => item.key === asset.id);
  const text = fs.readFileSync(path.join(snapshot, stored.value.file), 'utf8');
  const recording = path.join(dir, 'coverage.json');
  fs.writeFileSync(recording, JSON.stringify([{ url: `http://localhost/${asset.name}`, text, ranges: [{ start: 0, end: Math.floor(text.length / 2) }] }]));
  const report = path.join(dir, 'agent-report');
  const analyze = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'packages/rspack-coverage/dist/cli.js'),
    'analyze', '--data-dir', cache, '--coverage', recording, '--output', report, '--scenario', 'first-screen', '--precision', 'per-block'],
  { encoding: 'utf8', timeout: 20000 }));
  assert.equal(analyze.ok, true);
  const db = path.join(dir, 'index.sqlite');
  main(['index', '--coverage', report, '--out', db]);
  const query = (command, options = {}) => main([command, '--db', db, ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, String(value)])]);
  const status = query('status'); assert.ok(status.counts.modules >= 3); assert.equal(status.capabilities.coverage, true);
  const modules = query('modules', { scope: 'loaded', sort: 'coverage.generated.unexecutedBytes:desc' });
  assert.ok(modules.items.length >= 3);
  const dep = modules.items.find(item => item.path.endsWith('/dep.js'));
  assert.ok(dep); assert.ok(query('coverage', { module: dep.moduleId, view: 'lines' }).items.length);
  const detail = query('module', { module: dep.moduleId, include: 'exports' });
  assert.ok(detail.exports.items.some(item => item.exportPath[0] === 'hot'));
  const refs = query('references', { module: dep.moduleId }); assert.ok(refs.items.length);
  const reference = query('reference', { edge: refs.items[0].edgeId, characters: 500 });
  assert.notEqual(reference.mapping.locationPrecision, 'unavailable');
  const resource = detail.sources.items.find(item => item.coordinateSpace === 'resource');
  assert.ok(query('source', { source: resource.sourceId, characters: 100 }).content.length);
  const chain = query('chain', { module: dep.moduleId, export: 'hot' });
  assert.ok(chain.edges.length);
  t.diagnostic(JSON.stringify({ directory: dir, compilerVersion: requireTool('@rspack/core/package.json').version,
    counts: status.counts, listBytes: Buffer.byteLength(JSON.stringify(modules)), referencePrecision: reference.mapping.locationPrecision }));
});
