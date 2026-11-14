const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../query.cjs');
const { DatabaseSync } = require('node:sqlite');

const { buildFixture, core } = require('./build-fixture.cjs');

test('bundled plugin -> bundled sourcemap analysis -> indexed evidence with real production optimization', { skip: !core }, async t => {
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
  const report = path.join(dir, 'coverage.sqlite'); const index = path.join(dir, 'index.sqlite');
  const result = main(['analyze', '--build', build, '--coverage', recording, '--out', report, '--precision', 'per-block', '--scenario', 'first-screen']);
  assert.ok(result.generated.mappedBytes > 0); assert.equal(result.counts.matchedAssets, 1);
  // Analysis is a portable complete SQLite artifact: the original capture and recording can be removed.
  fs.rmSync(path.join(dir, 'capture'), { recursive: true, force: true }); fs.unlinkSync(recording);
  main(['index', '--coverage', report, '--out', index]);
  const query = (command, options = {}) => main([command, '--db', index, ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, String(value)])]);
  const status = query('status'); assert.ok(status.counts.modules >= 3); assert.ok(status.generated.mappedBytes > 0);
  const modules = query('modules', { scope: 'loaded', sort: 'coverage.generated.unexecutedBytes:desc' });
  assert.ok(modules.items.length >= 3);
  const dep = modules.items.find(item => item.path.endsWith('/dep.js')); assert.ok(dep);
  assert.ok(query('coverage', { module: dep.moduleId, view: 'lines' }).items.length);
  const detail = query('module', { module: dep.moduleId, include: 'exports' });
  assert.ok(detail.exports.items.some(item => item.exportPath[0] === 'hot'));
  const refs = query('references', { module: dep.moduleId, relation: 'native' }); assert.ok(refs.items.length);
  const reference = query('reference', { edge: refs.items[0].edgeId, characters: 500 });
  assert.ok(reference.mapping.window || reference.mapping.candidates.length);
  const resource = detail.sources.items.find(item => item.coordinateSpace === 'resource');
  assert.ok(query('source', { source: resource.sourceId, characters: 100 }).content.length);
  const { command: sourceCommand, ...sourceOptions } = reference.mapping.sourceQuery;
  const useSite = query(sourceCommand, sourceOptions);
  assert.ok(useSite.coverage.total > 0, 'A resource sourceQuery should retain the verified coverage overlay.');
  assert.ok(query('chain', { module: dep.moduleId, export: 'hot' }).edges.length);
  t.diagnostic(JSON.stringify({ directory: dir, counts: status.counts, mappedBytes: status.generated.mappedBytes, outputBytes: Buffer.byteLength(JSON.stringify(modules)) }));
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
