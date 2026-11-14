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
  fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'coverage.sqlite');
  usage(file, modules, edges.map(edge => ({ ...edge, origin: edge.originModuleId, target: edge.targetModuleId })), {
    kind: 'rspack-bundle-coverage', coverageSchema: 1, buildHash, coverageSha256: 'c'.repeat(64), scenario: 'first-screen', precision: 'per-block',
    coverageImportSummary: { ignoredEntries: [], warnings: [] },
  });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE coverage_files(id TEXT PRIMARY KEY,path TEXT,space TEXT,content TEXT,module_ids TEXT,metrics TEXT,generated_by_module TEXT,retained_by_module TEXT,mapped_lines TEXT);
    CREATE TABLE coverage_assets(id TEXT PRIMARY KEY,payload TEXT);
    CREATE TABLE chunks(id TEXT PRIMARY KEY,initial INTEGER,files TEXT,runtime TEXT);
    CREATE TABLE module_chunks(module_id TEXT,chunk_id TEXT,PRIMARY KEY(module_id,chunk_id));
    CREATE TABLE refs(id TEXT PRIMARY KEY,origin TEXT,target TEXT,dependency_type TEXT,request TEXT,loc TEXT,active INTEGER);
    CREATE TABLE capture_gaps(id TEXT PRIMARY KEY,module_id TEXT,kind TEXT,detail TEXT);`);
  for (const [chunk, initial] of [['main', 1], ['lazy', 0]]) {
    db.prepare('INSERT INTO chunks VALUES (?,?,?,?)').run(chunk, initial, '[]', '[]');
    db.prepare('INSERT INTO coverage_assets VALUES (?,?)').run(chunk, JSON.stringify({ chunks: [chunk], loaded: chunk === 'main' }));
  }
  for (const m of modules) for (const chunk of m.chunks || ['main']) db.prepare('INSERT INTO module_chunks VALUES (?,?)').run(m.id, chunk);
  const sourceFiles = files ?? modules.map((m, i) => ({ id: `s${i}`, path: m.resource, moduleIds: [m.id], metrics: metrics(), moduleMetrics: metrics(60, 60, 30), content: m.text }));
  for (const f of sourceFiles) {
    const lines = f.lines ?? [{ lineIndex: 0, emittedBytes: 100, loadedBytes: 100, executedBytes: 20, ranges: [{ startColumn: 0, endColumn: 10, executed: true }] }];
    const generated = f.generatedMetricsById ?? Object.fromEntries(f.moduleIds.map(key => [key, f.moduleIds.length === 1 ? f.metrics : null]));
    const retained = f.moduleMetricsById ?? Object.fromEntries(f.moduleIds.map(key => [key, f.moduleIds.length === 1 ? f.moduleMetrics ?? null : null]));
    db.prepare('INSERT INTO coverage_files VALUES (?,?,?,?,?,?,?,?,?)').run(f.id, f.path, 'resource', f.content ?? null, JSON.stringify(f.moduleIds), JSON.stringify(f.metrics), JSON.stringify(generated), JSON.stringify(retained), JSON.stringify(lines));
  }
  for (const r of refs) db.prepare('INSERT INTO refs VALUES (?,?,?,?,?,?,?)').run(r.id, r.originId, r.targetId, r.dependencyType ?? null, r.request ?? null, JSON.stringify(r.location ?? null), r.active == null ? null : Number(r.active));
  db.close(); return file;
}
module.exports = { module_, usage, coverage, metrics };
