const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hash, setMeta } = require('../lib/common.cjs');

const metrics = (emitted = 100, loaded = emitted, executed = 20) => ({
  emittedBytes: emitted, loadedBytes: loaded, executedBytes: executed, unusedBytes: loaded - executed,
  notLoadedBytes: emitted - loaded, mappedBytes: emitted, unmappedBytes: 0, usageRatio: loaded ? executed / loaded : null,
});
function module_(i, extra = {}) {
  return { id: String(i), identifier: `/fixture/src/${i}.js`, resource: `/fixture/src/${i}.js`,
    providedExports: ['foo', 'bar', 'foo.bar'], usedExports: ['foo'],
    text: 'export function foo() { return 1; }\nexport function bar() { return 2; }\n', ...extra };
}
function usage(file, modules, edges = [], metadata = {}) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE modules(id TEXT PRIMARY KEY,identifier TEXT,layer TEXT,type TEXT,resource TEXT,parent_id TEXT,provided TEXT,used TEXT,
      transformed TEXT,source_map TEXT,resource_content TEXT,transformed_hash TEXT,resource_hash TEXT,source_gap TEXT);
    CREATE TABLE edges(id TEXT PRIMARY KEY,origin TEXT,target TEXT,origin_export TEXT,target_export TEXT,dependency TEXT,loc TEXT);`);
  setMeta(db, { schema: 1, status: 'complete', graphAvailable: true, buildHash: 'build-test', context: '/fixture', columnBase: 1, ...metadata });
  const insert = db.prepare('INSERT INTO modules VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (const m of modules) {
    const resource = m.resourceText === undefined ? m.text ?? null : m.resourceText;
    const transformed = m.transformed === undefined ? m.text ?? null : m.transformed;
    insert.run(m.id, m.identifier, m.layer ?? null, 'javascript/auto', m.resource ?? null, null, JSON.stringify(m.providedExports ?? null),
      JSON.stringify(m.usedExports ?? null), transformed, m.map ? JSON.stringify(m.map) : null, resource,
      transformed === null ? null : hash(transformed), resource === null ? null : hash(resource), null);
  }
  const insertEdge = db.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    insertEdge.run(e.id ?? String(i), e.origin, e.target, JSON.stringify(e.originExport ?? null), JSON.stringify(e.targetExport ?? null),
      `dep-${i}`, e.loc === undefined ? '1:1-10' : e.loc);
  }
  db.exec('COMMIT'); db.close(); return file;
}
function coverage(directory, modules, { files, edges = [], refs = [], buildHash = 'build-test' } = {}) {
  const snapshotId = `v2-${'a'.repeat(32)}`; const run = 'c'.repeat(64);
  const snapshot = path.join(directory, 'snapshots', snapshotId);
  fs.mkdirSync(snapshot, { recursive: true });
  const database = path.join(snapshot, 'snapshot.sqlite');
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE export_modules(id TEXT PRIMARY KEY,payload BLOB);
    CREATE TABLE export_usage_edges(sequence INTEGER PRIMARY KEY,payload BLOB);
    CREATE TABLE refs(sequence INTEGER PRIMARY KEY,payload BLOB);`);
  const insertModule = db.prepare('INSERT INTO export_modules VALUES (?,?)');
  for (const m of modules) insertModule.run(m.id, JSON.stringify({ ...m, transformedSource: m.text, sourceMap: m.map ?? null }));
  for (const [table, rows] of [['export_usage_edges', edges], ['refs', refs]]) {
    const insert = db.prepare(`INSERT INTO ${table} VALUES (?,?)`);
    rows.forEach((row, i) => insert.run(i, JSON.stringify(row)));
  }
  db.close();
  const sourceFiles = files ?? modules.map((m, i) => ({ id: `s${i}`, path: m.resource, moduleIds: [m.id], metrics: metrics(), moduleMetrics: metrics(60, 60, 30), content: m.text }));
  const entries = {}; const parts = []; let offset = 0;
  for (const f of sourceFiles) {
    const detail = { id: f.id, content: f.content ?? null, mappedLines: f.lines ?? [{ lineIndex: 0, emittedBytes: 100, loadedBytes: 100, executedBytes: 20, ranges: [{ startColumn: 0, endColumn: 10, executed: true }] }] };
    const record = Buffer.from(JSON.stringify(detail)); entries[f.id] = { offset, length: record.length }; offset += record.length; parts.push(record);
  }
  const write = (file, value) => fs.writeFileSync(path.join(snapshot, file), JSON.stringify(value));
  fs.writeFileSync(path.join(snapshot, 'report.sources'), Buffer.concat(parts));
  write('report.sources.index.json', { version: 1, entries });
  const manifest = { hash: buildHash, context: '/fixture', capabilities: { exportUsageGraph: 'native' }, diagnostics: [],
    modules: modules.map(m => ({ ...m, chunks: m.chunks ?? ['main'] })) };
  write('metadata.json', { version: 2, snapshotId, manifest, database: { file: 'snapshot.sqlite', bytes: fs.statSync(database).size } });
  write('report.json', { status: 'complete', id: run, report: { version: 2, buildHash, files: sourceFiles.map(({ content, lines, ...f }) => f),
    chunks: [{ id: 'main', initial: true, loaded: true }, { id: 'lazy', initial: false, loaded: false }], importSummary: { ignoredEntries: [] } } });
  fs.writeFileSync(path.join(directory, 'dataset.json'), JSON.stringify({ schemaVersion: 1, kind: 'rspack-coverage-agent-data', snapshotId, buildHash, coverageSha256: run, scenario: 'first-screen', precision: 'per-block' }));
  fs.writeFileSync(path.join(directory, 'latest.json'), JSON.stringify({ version: 2, snapshotId, buildHash }));
  return directory;
}
module.exports = { module_, usage, coverage, metrics };
