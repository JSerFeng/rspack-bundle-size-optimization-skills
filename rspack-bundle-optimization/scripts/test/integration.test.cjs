const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, formatText } = require('../query.cjs');
const { DatabaseSync } = require('node:sqlite');

const { buildFixture, core } = require('./build-fixture.cjs');

test('bundled plugin -> one-step index -> AI-friendly queries with real production optimization', { skip: !core }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-bundle-real-'));
  if (!process.env.KEEP_QUERY_FIXTURE) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const build = await buildFixture(dir);
  const capture = new DatabaseSync(build, { readOnly: true });
  const asset = capture.prepare('SELECT content,source_map FROM assets WHERE name=?').get('main.js');
  assert.ok(asset.source_map); assert.ok(asset.content.length);
  capture.close();
  await buildFixture(dir, { output: { path: path.join(dir, 'baseline'), filename: 'main.js' } }, false);
  assert.equal(fs.readFileSync(path.join(dir, 'baseline/main.js'), 'utf8'), asset.content, 'The capture plugin must preserve the production JavaScript.');
  const recording = path.join(dir, 'coverage.json');
  fs.writeFileSync(recording, JSON.stringify([{ url: 'http://localhost/main.js', text: asset.content, ranges: [{ start: 0, end: Math.floor(asset.content.length / 2) }] }]));
  const index = path.join(dir, 'index.sqlite');
  const indexed = main(['index', '--build', build, '--coverage', recording, '--out', index, '--precision', 'per-block', '--scenario', 'first-screen']);
  assert.ok(indexed.generated.mappedBytes > 0);
  const toFlags = options => Object.entries(options).flatMap(([k, v]) => v === true ? [`--${k}`] : v === false || v === undefined ? [] : [`--${k}`, String(v)]);
  const query = (command, options = {}) => main([command, '--db', index, ...toFlags(options)]);

  const status = query('status'); assert.ok(status.counts.modules >= 3); assert.ok(status.generated.mappedBytes > 0);
  assert.ok(formatText('status', status).includes('# Status'));

  const chunks = query('chunks');
  assert.ok(chunks.chunks.total >= 1);
  assert.ok(chunks.page.total >= 1);
  assert.ok(formatText('chunks', chunks).includes('# Chunks & Chunk Groups'));

  const modules = query('modules', { scope: 'loaded', sort: 'coverage.generated.unexecutedBytes:desc' });
  assert.ok(modules.items.length >= 3);
  const dep = modules.items.find(item => item.path.endsWith('dep.js')); assert.ok(dep);
  const detail = query('module', { module: dep.moduleId });
  assert.ok(detail.exports.items.some(item => item.exportPath[0] === 'hot'));
  assert.ok(detail.chunks.length >= 1);
  assert.equal(detail.sources.items.filter(s => s.coordinateSpace === 'resource').length, 1);

  const src = query('source', { module: dep.moduleId });
  assert.ok(src.content.includes('export function hot'));
  assert.ok(src.coverage.total > 0);
  assert.ok(formatText('source', src).includes('|'));

  const refs = query('refs', { module: dep.moduleId, relation: 'native' });
  assert.ok(refs.items.length);
  assert.ok(refs.items[0].originPath.endsWith('index.js'));
  assert.ok(refs.items[0].mapping.snippet.lines.length > 0);
  assert.ok(formatText('refs', refs).includes('## Export'));

  const expanded = query('refs', { edge: refs.items[0].edgeId, characters: 500 });
  assert.ok(expanded.items[0].mapping.window || expanded.items[0].mapping.candidates?.length);
  const chain = query('chain', { module: dep.moduleId, export: 'hot' });
  assert.ok(chain.edges.length);
  assert.ok(chain.modules.length >= 2);
  assert.ok(formatText('chain', chain).includes('# Export Usage Chain'));
  t.diagnostic(JSON.stringify({ directory: dir, counts: status.counts, mappedBytes: status.generated.mappedBytes, textBytes: Buffer.byteLength(formatText('modules', modules)) }));
});

test('chunks --group detects multi-origin merged chunk unnecessary module candidates', { skip: !core }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-bundle-chunks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const build = await buildFixture(dir, {
    output: { path: path.join(dir, 'dist'), filename: '[name].js' },
    optimization: { concatenateModules: false },
  }, true, {
    'index.js': "globalThis.loadA = () => import(/* webpackChunkName: 'merged' */ './featA.js');\nglobalThis.loadB = () => import(/* webpackChunkName: 'merged' */ './featB.js');\n",
    'featA.js': "import { helperA } from './helperA.js';\nexport function runA() { return 'featA-executed-marker:' + helperA(); }\n",
    'helperA.js': "export function helperA() { return 'from-A-executed-branch'; }\n",
    'featB.js': "import { helperB } from './helperB.js';\nexport function runB() { return 'featB-unexecuted-marker:' + helperB(); }\n",
    'helperB.js': "export function helperB() { return 'from-B-unexecuted-branch-payload-padding-1234567890'; }\n",
  });
  const capture = new DatabaseSync(build, { readOnly: true });
  const assets = capture.prepare('SELECT name,content FROM assets').all();
  capture.close();
  const mainAsset = assets.find(a => a.name === 'main.js');
  const mergedAsset = assets.find(a => a.name === 'merged.js');
  assert.ok(mainAsset && mergedAsset);
  // Simulate execution covering main.js + only featA/helperA inside merged.js (not featB/helperB).
  const aMarkers = [mergedAsset.content.indexOf('featA-executed-marker'), mergedAsset.content.indexOf('from-A-executed-branch')].filter(i => i >= 0);
  const bMarkers = [mergedAsset.content.indexOf('featB-unexecuted-marker'), mergedAsset.content.indexOf('from-B-unexecuted-branch')].filter(i => i >= 0);
  assert.equal(aMarkers.length, 2); assert.equal(bMarkers.length, 2);
  const rangesA = aMarkers.map(pos => ({ start: pos, end: pos + 20 }));
  const recording = path.join(dir, 'recording.json');
  fs.writeFileSync(recording, JSON.stringify([
    { url: 'http://localhost/main.js', text: mainAsset.content, ranges: [{ start: 0, end: mainAsset.content.length }] },
    { url: 'http://localhost/merged.js', text: mergedAsset.content, ranges: rangesA },
  ]));
  const index = path.join(dir, 'index.sqlite');
  main(['index', '--build', build, '--coverage', recording, '--out', index, '--precision', 'per-block']);
  const overview = main(['chunks', '--db', index]);
  const mainGroup = overview.items.find(g => g.name === 'main');
  const mergedGroup = overview.items.find(g => g.name === 'merged');
  assert.ok(mainGroup && mergedGroup, 'Chunk groups should be indexed with their names.');
  assert.equal(mergedGroup.multiOrigin, true);
  assert.equal(mergedGroup.originCount, 2);
  const detail = main(['chunks', '--db', index, '--group', mergedGroup.groupId]);
  assert.equal(detail.group.multiOrigin, true);
  assert.deepEqual(detail.group.parents, [mainGroup.groupId]);
  assert.equal(detail.origins.length, 2);
  assert.equal(detail.analysis.executedOriginCount, 1);
  assert.equal(detail.analysis.unexecutedOriginCount, 1);
  assert.equal(detail.analysis.unnecessaryCandidateCount, 2);
  assert.deepEqual(detail.analysis.candidates.map(c => c.path).sort(), ['featB.js', 'helperB.js']);
  const text = formatText('chunks', detail);
  assert.ok(text.includes('[MULTI-ORIGIN]'));
  assert.ok(text.includes('## Origin Reachability Analysis'));
  assert.ok(text.includes('helperB.js'));
});

test('native graph IDs align with layer-specific captured module instances', { skip: !core }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-bundle-layers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const build = await buildFixture(dir, { entry: ['./index.js?A', './index.js?B'], module: { rules: [{ resourceQuery: /A/, layer: 'a' }, { resourceQuery: /B/, layer: 'b' }] } });
  const db = new DatabaseSync(build, { readOnly: true });
  const modules = db.prepare("SELECT id,layer,identifier FROM modules WHERE resource LIKE '%/index.js' AND layer IS NOT NULL").all();
  assert.equal(new Set(modules.map(module => module.layer)).size, 2);
  for (const module of modules) assert.ok(db.prepare('SELECT count(*) AS n FROM edges WHERE origin=?').get(module.id).n > 0, module.identifier);
  db.close();
});

test('native reference columns after Unicode are UTF-16 and align with captured post-loader text', { skip: !core }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-bundle-unicode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const code = "import { hot } from './dep.js'; globalThis.emoji='热😀'; globalThis.result=hot();\n";
  const build = await buildFixture(dir, {}, true, { 'index.js': code });
  const db = new DatabaseSync(build, { readOnly: true });
  const edges = db.prepare("SELECT e.loc FROM edges e JOIN modules m ON m.id=e.origin WHERE m.resource LIKE '%/index.js' AND e.target_export=?").all('["hot"]');
  assert.ok(edges.length);
  assert.ok(edges.some(edge => require('../lib/source.cjs').parseLocation(edge.loc, 1)?.start.column === code.lastIndexOf('hot()')));
  db.close();
});

test('capture-plugin indexes modules(identifier), captures post-emit rewrites and resolves nested output sourcemaps', { skip: !core }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-bundle-emit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { BundleEvidencePlugin } = require('../capture-plugin.cjs');
  const { rspack } = require(core);
  fs.writeFileSync(path.join(dir, 'index.js'), "import { hot } from './dep.js'; globalThis.v = hot();\n");
  fs.writeFileSync(path.join(dir, 'dep.js'), "export function hot() { return 'nested-ok'; }\n");
  let snapshot;
  const rewritePlugin = {
    apply(compiler) {
      compiler.hooks.afterEmit.tap('MockArgusRewritePlugin', () => {
        const outFile = path.join(dir, 'dist/static/js/main.js');
        fs.appendFileSync(outFile, '\n/* post-emit-rewrite */\n');
      });
    },
  };
  const compiler = rspack({
    context: fs.realpathSync(dir), mode: 'production', entry: './index.js', devtool: 'hidden-source-map',
    output: { path: path.join(dir, 'dist'), filename: 'static/js/main.js' },
    plugins: [rewritePlugin, new BundleEvidencePlugin({ directory: path.join(dir, 'capture'), onSnapshot: file => { snapshot = file; } })],
  });
  try {
    const stats = await new Promise((resolve, reject) => compiler.run((err, v) => err ? reject(err) : resolve(v)));
    assert.equal(stats.hasErrors(), false, stats.toString({ errors: true }));
  } finally { await new Promise(resolve => compiler.close(resolve)); }
  const db = new DatabaseSync(snapshot, { readOnly: true });
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM modules WHERE identifier=?').all('x');
  assert.ok(plan.some(row => /INDEX capture_module_identifier/.test(row.detail)), JSON.stringify(plan));
  const asset = db.prepare('SELECT content,source_map FROM assets WHERE name=?').get('static/js/main.js');
  db.close();
  assert.ok(asset.content.includes('/* post-emit-rewrite */'), 'Should capture post-emit rewritten asset bytes.');
  assert.ok(JSON.parse(asset.source_map).x_rspack_bundle_map_base_url.endsWith('static/js/main.js.map'));

  const recording = path.join(dir, 'rec.json');
  fs.writeFileSync(recording, JSON.stringify([{ url: 'http://localhost/static/js/main.js', text: asset.content, ranges: [{ start: 0, end: asset.content.length }] }]));
  const index = path.join(dir, 'index.sqlite');
  const indexed = main(['index', '--build', snapshot, '--coverage', recording, '--out', index, '--precision', 'per-block']);
  assert.ok(indexed.generated.mappedBytes > 0);
  const dep = main(['modules', '--db', index, '--search', 'dep.js']).items[0];
  assert.ok(dep.coverage.generated.executedBytes > 0);
});
