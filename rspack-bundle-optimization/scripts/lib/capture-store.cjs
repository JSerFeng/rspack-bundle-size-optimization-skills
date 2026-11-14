const { DatabaseSync } = require('node:sqlite');
const { setMeta, hash, id, json } = require('./common.cjs');

const statements = new WeakMap();
function prepare(db, sql) {
  if (!statements.has(db)) statements.set(db, new Map());
  const cache = statements.get(db);
  if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
  return cache.get(sql);
}
function createCapture(file, metadata) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384; PRAGMA mmap_size=0;
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE modules(id TEXT PRIMARY KEY,identifier TEXT NOT NULL,layer TEXT,type TEXT,resource TEXT,parent_id TEXT,
      provided TEXT,used TEXT,transformed TEXT,source_map TEXT,resource_content TEXT,transformed_hash TEXT,resource_hash TEXT,source_gap TEXT);
    CREATE TABLE edges(id TEXT PRIMARY KEY,origin TEXT,target TEXT,origin_export TEXT,target_export TEXT,dependency TEXT,loc TEXT);
    CREATE INDEX capture_edge_in ON edges(target,id);
    CREATE TABLE refs(id TEXT PRIMARY KEY,origin TEXT,target TEXT,dependency_type TEXT,request TEXT,loc TEXT,active INTEGER);
    CREATE TABLE chunks(id TEXT PRIMARY KEY,initial INTEGER,files TEXT,runtime TEXT);
    CREATE TABLE module_chunks(module_id TEXT,chunk_id TEXT,PRIMARY KEY(module_id,chunk_id));
    CREATE TABLE assets(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT,content TEXT NOT NULL,content_hash TEXT NOT NULL,
      source_map TEXT,map_error TEXT,chunks TEXT,initial INTEGER);
    CREATE INDEX capture_asset_hash ON assets(content_hash);
    CREATE TABLE chunk_groups(id TEXT PRIMARY KEY,chunks TEXT,origins TEXT,parents TEXT);
    CREATE TABLE capture_gaps(id TEXT PRIMARY KEY,module_id TEXT,kind TEXT,detail TEXT);
  `);
  setMeta(db, { schema: 1, kind: 'rspack-bundle-capture', status: 'capturing', graphAvailable: false, ...metadata });
  return db;
}
function ensureModule(db, identifier, layer = null) {
  const key = id('mod', [identifier, layer ?? null]);
  prepare(db, 'INSERT OR IGNORE INTO modules(id,identifier,layer) VALUES (?,?,?)').run(key, identifier, layer ?? null);
  return key;
}
function addEdge(db, edge) {
  prepare(db, 'INSERT OR IGNORE INTO edges VALUES (?,?,?,?,?,?,?)').run(id('edge', edge), edge.origin, edge.target,
    json(edge.originExport), json(edge.targetExport), edge.dependency, edge.loc);
}
function addGap(db, moduleId, kind, detail) {
  prepare(db, 'INSERT OR IGNORE INTO capture_gaps VALUES (?,?,?,?)').run(id('gap', [moduleId, kind, detail]), moduleId, kind, json(detail));
}
module.exports = { createCapture, ensureModule, addEdge, addGap, prepare, setMeta, hash, id, json };
