const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main } = require('../query.cjs');
const { hash } = require('../lib/common.cjs');
const { module_, usage, coverage, metrics } = require('./fixtures.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspack-bundle-query-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'index.sqlite');
  return { dir, db, query(command, options = {}) {
    return main([command, '--db', db, ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, String(v)])]);
  }, index(options) { return main(['index', '--out', db, ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])]); } };
}
const errorCode = (fn, code) => assert.throws(fn, e => e.code === code);
function all(query, command, args = {}, size = 7) {
  const items = []; let cursor;
  do {
    const page = query(command, { ...args, limit: size, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32768); items.push(...page.items); cursor = page.page.nextCursor;
  } while (cursor);
  return items;
}

test('tied ranks, null-last both ways and keyset pages have no missing or duplicate modules', t => {
  const f = fixture(t);
  const modules = Array.from({ length: 53 }, (_, i) => module_(i, { usedExports: i > 39 ? true : i % 2 ? ['foo'] : false }));
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), modules) });
  for (const direction of ['asc', 'desc']) {
    const items = all(f.query, 'modules', { sort: `usage.usedExportCount:${direction}` });
    assert.equal(new Set(items.map(m => m.moduleId)).size, 53);
    assert.deepEqual(items.slice(-13).map(m => m.usage.usedExportCount), Array(13).fill(null));
    const counts = items.slice(0, 40).map(m => m.usage.usedExportCount);
    assert.deepEqual(counts, counts.toSorted((a, b) => direction === 'asc' ? a - b : b - a));
  }
  const first = f.query('modules', { limit: 2 });
  assert.equal(first.ranking.unknown, 0);
  assert.equal(f.query('modules', { limit: 9, cursor: first.page.nextCursor }).items.length, 9);
  for (const changed of [{ search: '1' }, { sort: 'path:asc' }, { fields: 'path' }])
    errorCode(() => f.query('modules', { ...changed, cursor: first.page.nextCursor }), 'CURSOR_MISMATCH');
  errorCode(() => f.query('modules', { cursor: 'broken' }), 'CURSOR_MISMATCH');
  errorCode(() => f.query('modules', { run: 'another-recording' }), 'INPUT_IDENTITY_MISMATCH');
  errorCode(() => f.query('modules', { sort: 'coverage.generated.unexecutedBytes:desc' }), 'METRIC_UNAVAILABLE');
  errorCode(() => f.query('modules', { sort: 'm.id;DROP TABLE modules' }), 'INVALID_SORT');
  errorCode(() => f.query('modules', { sort: '__proto__:desc' }), 'INVALID_SORT');
  errorCode(() => main(['constructor']), 'INVALID_ARGUMENT');
  errorCode(() => main(['describe', '--command', 'constructor']), 'INVALID_ARGUMENT');
  const other = fixture(t); other.index({ usage: usage(path.join(other.dir, 'usage.sqlite'), modules) });
  errorCode(() => other.query('modules', { cursor: first.page.nextCursor }), 'CURSOR_MISMATCH');
});

test('coverage uses per-instance evidence and never duplicates shared generated or retained bytes', t => {
  const f = fixture(t); const modules = [module_('a'), module_('b'), module_('c'), module_('d'), module_('e', { chunks: ['lazy'] }), module_('f')];
  const files = [
    { id: 'shared', path: 'src/shared.js', moduleIds: ['a', 'b'], metrics: metrics(), moduleMetrics: metrics(90, 90, 20),
      moduleMetricsById: { a: metrics(40, 40, 20) }, content: modules[0].text,
      lines: [{ lineIndex: 0, emittedBytes: 100, loadedBytes: 100, executedBytes: 20,
        moduleStates: { a: { emittedBytes: 40, loadedBytes: 40, executedBytes: 20 } }, ranges: [] }] },
    { id: 'c', path: 'src/c.js', moduleIds: ['c'], metrics: metrics(), moduleMetrics: metrics(60, 60, 10), content: modules[2].text },
    { id: 'd', path: 'src/d.js', moduleIds: ['d'], metrics: metrics(160, 100, 20), moduleMetrics: metrics(60, 60, 10), content: modules[3].text },
    { id: 'e', path: 'src/e.js', moduleIds: ['e'], metrics: metrics(90, 0, 0), moduleMetrics: metrics(60, 0, 0), content: modules[4].text },
  ];
  f.index({ coverage: coverage(path.join(f.dir, 'coverage'), modules, { files }) });
  const find = name => f.query('modules', { search: `/src/${name}.js` }).items[0].moduleId;
  const a = find('a'); const b = find('b');
  assert.equal(f.query('coverage', { module: a }).generated, null);
  assert.equal(f.query('coverage', { module: b }).retainedSource, null);
  assert.equal(f.query('coverage', { module: a }).retainedSource.unexecutedBytes, 20);
  const lineA = f.query('coverage', { module: a, view: 'lines' }).items[0];
  const lineB = f.query('coverage', { module: b, view: 'lines' }).items[0];
  assert.equal(lineA.generated.emittedBytes, 40); assert.equal(lineA.sourceRangeCount, null);
  assert.equal(lineB.runtimeState, 'unknown'); assert.equal(lineB.generated, null);
  const ranked = all(f.query, 'modules', { sort: 'coverage.generated.unexecutedBytes:desc' }, 1);
  assert.equal(ranked.filter(m => m.coverage.generated !== null).length, 3);
  assert.equal(ranked.slice(-3).every(m => m.coverage.generated === null), true);
  const loaded = f.query('modules', { scope: 'loaded', sort: 'coverage.generated.emittedBytes:desc' });
  assert.equal(loaded.items.some(m => m.path.endsWith('/e.js')), false);
  assert.equal(loaded.items.find(m => m.path.endsWith('/d.js')).coverage.generated.emittedBytes, 100);
  assert.equal(f.query('module', { module: find('d') }).coverage.generated.emittedBytes, 160);
  errorCode(() => f.query('modules', { scope: 'initial' }), 'METRIC_UNAVAILABLE');
  errorCode(() => f.query('coverage', { module: a, view: 'ranges' }), 'FEATURE_UNAVAILABLE');
  assert.ok(f.query('gaps', { module: b, kind: 'shared-source' }).page.total > 0);
  const source = f.query('source', { source: lineA.sourceId, module: a, characters: 12 });
  assert.equal(source.content.length, 12); assert.equal(source.coverage.items[0].ge, 40);
  const page = f.query('modules', { limit: 1 });
  errorCode(() => f.query('modules', { scope: 'loaded', cursor: page.page.nextCursor }), 'CURSOR_MISMATCH');
});

test('native export paths preserve namespace, anonymous and member ancestry without matching siblings', t => {
  const f = fixture(t); const modules = ['provider', 'consumer'].map(i => module_(i));
  const edges = [ ['foo', 'bar'], ['foo'], ['foo', 'baz'], [], null, ['foo.bar'] ].map((names, i) => ({ id: String(i), origin: 'consumer', target: 'provider', targetExport: names }));
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), modules, edges) });
  const p = f.query('modules', { search: 'provider' }).items[0].moduleId;
  assert.equal(f.query('references', { module: p, 'export-path': '["foo","bar"]' }).items.length, 4);
  assert.equal(f.query('references', { module: p, export: 'foo.bar' }).items.length, 3);
  assert.equal(f.query('exports', { module: p, used: 'used' }).items[0].exportPath[0], 'foo');
  assert.equal(f.query('module', { module: p }).usage.distinctConsumers, 1);
  assert.equal(f.query('module', { module: p }).usage.incomingReferences, 6);
  errorCode(() => f.query('references', { module: p, direction: 'out', export: 'foo' }), 'INVALID_ARGUMENT');
});

test('chains retain cycles, wide-node continuations and unnamed terminals', t => {
  const f = fixture(t); const modules = Array.from({ length: 260 }, (_, i) => module_(i));
  const edges = modules.slice(1).map(m => ({ origin: m.id, target: '0', originExport: ['foo'], targetExport: ['foo'] }));
  edges.push({ origin: '0', target: '1', originExport: ['foo'], targetExport: ['foo'] });
  edges.push({ origin: '2', target: '1', targetExport: ['foo'] });
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), modules, edges) });
  const root = f.query('modules', { search: '/0.js' }).items[0].moduleId;
  const result = f.query('chain', { module: root, export: 'foo', depth: 3, 'max-edges': 500 });
  assert.ok(result.truncated); assert.ok(result.frontier.length);
  const pageFrontier = result.frontier.find(s => s.query.cursor);
  assert.ok(pageFrontier);
  const { command, ...options } = pageFrontier.query;
  const continued = f.query(command, options);
  assert.ok(continued.items.length);
  assert.equal(continued.items.some(e => result.edges.some(old => old.edgeId === e.edgeId)), false);
  const one = f.query('modules', { search: '/1.js' }).items[0].moduleId;
  const cycle = f.query('chain', { module: one, export: 'foo', 'max-edges': 500 });
  assert.ok(cycle.cycles.length || cycle.frontier.length); // A budget can stop before the cycle, with explicit continuation.
  assert.ok(cycle.terminals.some(item => item.reason === 'no-named-origin-export'));
});

test('UTF-16 source windows resume exactly on long lines, astral characters and newlines', t => {
  const f = fixture(t); const text = `const emoji = '😀';${'中'.repeat(6000)}\nexport const end = 1;\n`;
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), [module_('long', { text })]) });
  const m = f.query('modules').items[0].moduleId;
  const s = f.query('sources', { module: m }).items.find(s => s.coordinateSpace === 'resource').sourceId;
  let next = { line: 1, column: 0 }; let content = '';
  while (next) {
    const part = f.query('source', { source: s, characters: 12000, ...next });
    assert.equal(part.coordinateUnit, 'UTF-16'); content += part.content; next = part.next;
  }
  assert.equal(content, text);
  errorCode(() => f.query('source', { source: s, line: 90 }), 'INVALID_ARGUMENT');
});

test('reference queries use captured source/map, bounded windows and syntax owners', t => {
  const f = fixture(t);
  const text = "export function foo() { return bar(); }\n";
  const modules = [module_('a', { text }), module_('b')];
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), modules, [{ origin: 'a', target: 'b', loc: '1:32-35', targetExport: ['bar'] }]) });
  const b = f.query('modules', { search: '/b.js' }).items[0].moduleId;
  const edge = f.query('references', { module: b }).items[0].edgeId;
  const ref = f.query('reference', { edge, characters: 8 });
  assert.equal(ref.mapping.window.content.length, 8);
  assert.equal(ref.mapping.ownerChain[0].name, 'foo');
  assert.equal(ref.mapping.sourceLocation.start.column, 31);
});

test('cross-line references preserve the shorter ending line instead of extending its column', t => {
  const f = fixture(t);
  const text = `${'\n'.repeat(174)}${' '.repeat(42)}foo(\n  value());  `;
  assert.equal(text.split('\n')[175].length, 13);
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), [module_('consumer', { text }), module_('provider')], [
    { origin: 'consumer', target: 'provider', loc: '175:43-176:12', targetExport: ['foo'] },
  ]) });
  const provider = f.query('modules', { search: '/provider.js' }).items[0].moduleId;
  const edge = f.query('references', { module: provider }).items[0].edgeId;
  const ref = f.query('reference', { edge });
  assert.deepEqual(ref.mapping.sourceLocation, { start: { line: 175, column: 42 }, end: { line: 176, column: 11 } });
  assert.equal(ref.mapping.astGap, null);
  assert.ok(ref.mapping.window.content.includes('foo(\n  value());'));
});

test('sourcemap tracing keeps a mapped cross-line endpoint on a shorter line', t => {
  const f = fixture(t);
  const resource = `${'\n'.repeat(174)}${' '.repeat(42)}foo(\n  value());  `;
  const transformed = 'foo(value());';
  const map = { version: 3, sources: ['consumer.ts'], sourcesContent: [resource], names: [],
    mappings: require('@jridgewell/sourcemap-codec').encode([[[0, 0, 174, 42], [13, 0, 175, 11]]]) };
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), [module_('consumer', { resourceText: resource, transformed, map }), module_('provider')], [
    { origin: 'consumer', target: 'provider', loc: '1:1-14', targetExport: ['foo'] },
  ]) });
  const provider = f.query('modules', { search: '/provider.js' }).items[0].moduleId;
  const edge = f.query('references', { module: provider }).items[0].edgeId;
  const ref = f.query('reference', { edge, space: 'post-loader' });
  assert.deepEqual(ref.mapping.sourceLocation, { start: { line: 175, column: 42 }, end: { line: 176, column: 11 } });
  assert.equal(ref.mapping.coordinateSpace, 'map-source');
  assert.equal(ref.mapping.astGap, null);
  assert.ok(ref.mapping.window.content.includes('foo(\n  value());'));
});

test('transformed map candidates keep their coordinate space and captured identity', t => {
  const f = fixture(t);
  const resource = 'export const foo: number = bar();\n';
  const transformed = 'export const foo = bar();\n';
  const map = { version: 3, sources: ['a.ts'], sourcesContent: [resource], names: [], mappings: 'AAAA' };
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), [module_('a', { resourceText: resource, transformed, map }), module_('b')], [{ origin: 'a', target: 'b', loc: '1:20-23', targetExport: ['bar'] }]) });
  const b = f.query('modules', { search: '/b.js' }).items[0].moduleId;
  const edge = f.query('references', { module: b }).items[0].edgeId;
  const result = f.query('reference', { edge, characters: 9 });
  assert.equal(result.mapping.locationPrecision, 'unavailable');
  const candidate = result.mapping.candidates.find(c => c.coordinateSpace === 'map-source');
  assert.ok(candidate); assert.equal(candidate.window.content.length, 9);
  const { command, ...options } = candidate.sourceQuery;
  const source = f.query(command, options);
  assert.equal(source.content, resource); assert.equal(source.coordinateSpace, 'map-source');
});

test('input identity, layer separation, immutable reads, failed-index cleanup and changed-input detection', t => {
  const f = fixture(t);
  const modules = [module_('a'), module_('layer', { identifier: '/fixture/src/a.js', resource: '/fixture/src/a.js', layer: 'worker' })];
  const u = usage(path.join(f.dir, 'usage.sqlite'), modules);
  const c = coverage(path.join(f.dir, 'coverage'), modules, { buildHash: 'another-build' });
  errorCode(() => f.index({ usage: u, coverage: c }), 'INPUT_IDENTITY_MISMATCH');
  assert.equal(fs.existsSync(f.db), false); assert.equal(fs.readdirSync(f.dir).some(n => n.endsWith('.incomplete')), false);
  const before = hash(fs.readFileSync(u)); f.index({ usage: u });
  assert.equal(f.query('modules').items.length, 2);
  const indexBefore = hash(fs.readFileSync(f.db)); f.query('status'); f.query('modules');
  assert.equal(hash(fs.readFileSync(u)), before); assert.equal(hash(fs.readFileSync(f.db)), indexBefore);
  errorCode(() => f.index({ usage: u }), 'OUTPUT_EXISTS');
  fs.utimesSync(u, new Date(), new Date(Date.now() + 1000));
  errorCode(() => f.query('modules'), 'INPUT_CHANGED');
});

test('same-build inputs align exact instances and keep module graph distinct', t => {
  const f = fixture(t); const modules = [module_('a'), module_('b')];
  const refs = [{ id: 'r', originId: 'a', targetId: 'b', dependencyType: 'commonjs require', exports: null, active: true, location: { start: { line: 1, column: 0 } } }];
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), modules, [{ origin: 'a', target: 'b', targetExport: ['foo'] }]), coverage: coverage(path.join(f.dir, 'coverage'), modules, { refs }) });
  const b = f.query('modules', { search: '/b.js' }).items[0].moduleId;
  assert.equal(f.query('references', { module: b }).page.total, 2);
  assert.equal(f.query('references', { module: b, relation: 'module-graph' }).items[0].dependencyType, 'commonjs require');
  assert.equal(f.query('references', { module: b, relation: 'native' }).page.total, 1);
});

test('missing graph stays unknown; stdout is one bounded JSON object and errors exit nonzero', t => {
  const f = fixture(t);
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), [module_('a')], [], { graphAvailable: false }) });
  assert.equal(f.query('modules').items[0].usage.incomingReferences, null);
  errorCode(() => f.query('modules', { sort: 'usage.incomingReferences:desc' }), 'METRIC_UNAVAILABLE');
  const cli = path.resolve(__dirname, '../query.cjs');
  for (const [args, ok] of [[['status', '--db', f.db], true], [['module', '--db', f.db, '--module', 'wrong'], false]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, ok ? 0 : 1); assert.equal(JSON.parse(result.stdout).ok, ok);
    assert.equal(result.stdout.trim().split('\n').length, 1); assert.ok(Buffer.byteLength(result.stdout) <= 32768);
  }
});

test('a small cycle preserves all edges and explicitly reports the return edge', t => {
  const f = fixture(t);
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), [module_('a'), module_('b')], [
    { origin: 'a', target: 'b', originExport: ['foo'], targetExport: ['foo'] },
    { origin: 'b', target: 'a', originExport: ['foo'], targetExport: ['foo'] },
  ]) });
  const root = f.query('modules').items[0].moduleId;
  const chain = f.query('chain', { module: root, export: 'foo' });
  assert.equal(chain.edges.length, 2); assert.equal(chain.cycles.length, 1); assert.equal(chain.truncated, false);
});

test('response budget shrinks pages without losing rows, and projection can retrieve large identities', t => {
  const f = fixture(t); const modules = Array.from({ length: 120 }, (_, i) => module_(i, { identifier: `/fixture/${'a'.repeat(800)}/${i}.js` }));
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), modules) });
  const page = f.query('modules', { limit: 200 });
  assert.ok(page.page.returned < 120); assert.ok(page.page.nextCursor);
  assert.equal(all(f.query, 'modules', {}, 200).length, 120);
  const small = f.query('modules', { fields: 'path,usage.usedExportCount', limit: 200 });
  assert.equal(small.items.length, 120); assert.equal(small.items[0].identifier, undefined);
  assert.ok(small.items.every(m => m.moduleId));
});

test('reference window focuses a use site after a long preceding line', t => {
  const f = fixture(t); const text = `//${'x'.repeat(10000)}\nexport const foo = bar();\n`;
  f.index({ usage: usage(path.join(f.dir, 'usage.sqlite'), [module_('a', { text }), module_('b')], [{ origin: 'a', target: 'b', targetExport: ['bar'], loc: '2:20-23' }]) });
  const b = f.query('modules', { search: '/b.js' }).items[0].moduleId;
  const edge = f.query('references', { module: b }).items[0].edgeId;
  const result = f.query('reference', { edge, characters: 40 });
  assert.ok(result.mapping.window.content.includes('bar()')); assert.equal(result.mapping.window.start.line, 2);
});

test('source coverage overlay stays bounded and links to a source-filtered paginated query', t => {
  const f = fixture(t); const lines = Array.from({ length: 500 }, (_, lineIndex) => ({ lineIndex, emittedBytes: 1, loadedBytes: 1, executedBytes: 0, ranges: [] }));
  const m = module_('a', { text: '\n'.repeat(500) });
  f.index({ coverage: coverage(path.join(f.dir, 'coverage'), [m], { files: [{ id: 'a', path: m.resource, moduleIds: ['a'], metrics: metrics(500, 500, 0), moduleMetrics: metrics(500, 500, 0), content: m.text, lines }] }) });
  const moduleId = f.query('modules').items[0].moduleId;
  const sourceId = f.query('sources', { module: moduleId }).items.find(s => s.coordinateSpace === 'resource').sourceId;
  const result = f.query('source', { source: sourceId, module: moduleId });
  assert.equal(result.coverage.total, 500); assert.equal(result.coverage.items.length, 20);
  const { command, ...args } = result.coverage.nextQuery;
  const items = all(f.query, command, args);
  assert.equal(items.length, 500); assert.ok(items.every(line => result.coverage.sourceIds.includes(line.sourceId)));
});
