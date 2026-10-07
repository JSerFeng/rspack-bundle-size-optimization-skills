const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');
const moduleId = (identifier, layer) => 'mod_' + hash(JSON.stringify([identifier, layer || null])).slice(0, 24);
const SCHEMA = 1;
const statements = new WeakMap();
function prepare(db, sql) {
  if (!statements.has(db)) statements.set(db, new Map());
  const cache = statements.get(db);
  if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
  return cache.get(sql);
}

function createStore(filename, metadata) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE modules (
      id TEXT PRIMARY KEY, identifier TEXT NOT NULL, layer TEXT, type TEXT,
      resource TEXT, parent_id TEXT, provided TEXT, used TEXT,
      transformed TEXT, source_map TEXT, resource_content TEXT,
      transformed_hash TEXT, resource_hash TEXT, source_gap TEXT
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY, origin TEXT NOT NULL, target TEXT NOT NULL,
      origin_export TEXT NOT NULL, target_export TEXT NOT NULL,
      dependency TEXT NOT NULL, loc TEXT
    );
    CREATE INDEX edge_origin ON edges(origin, id);
    CREATE INDEX edge_target ON edges(target, id);
    CREATE TABLE targets (module TEXT, path TEXT, edge TEXT,
      PRIMARY KEY(module, path, edge));
  `);
  setMeta(db, { schema: SCHEMA, status: 'capturing', graphAvailable: false, ...metadata });
  return db;
}

function setMeta(db, metadata) {
  const insert = prepare(db, 'INSERT OR REPLACE INTO meta VALUES (?, ?)');
  for (const [key, value] of Object.entries(metadata)) insert.run(key, JSON.stringify(value));
}

function getMeta(db) {
  return Object.fromEntries(db.prepare('SELECT * FROM meta').all().map(row => [row.key, JSON.parse(row.value)]));
}

function openStore(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const meta = getMeta(db);
    if (meta.schema !== SCHEMA) throw new Error(`Unsupported snapshot schema: ${meta.schema}`);
    if (meta.status !== 'complete') throw new Error(`Snapshot is not complete: ${meta.status}`);
    return db;
  } catch (error) { db.close(); throw error; }
}

function ensureModule(db, identifier, layer = null) {
  const id = moduleId(identifier, layer);
  prepare(db, 'INSERT OR IGNORE INTO modules (id, identifier, layer) VALUES (?, ?, ?)')
    .run(id, identifier, layer || null);
  return id;
}

function addEdge(db, edge) {
  const id = 'edge_' + hash(JSON.stringify(edge)).slice(0, 24);
  prepare(db, 'INSERT OR IGNORE INTO edges VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, edge.origin, edge.target, JSON.stringify(edge.originExport),
    JSON.stringify(edge.targetExport), edge.dependency, edge.loc);
  const insert = prepare(db, 'INSERT OR IGNORE INTO targets VALUES (?, ?, ?)');
  if (edge.targetExport?.length) {
    for (let i = 1; i <= edge.targetExport.length; i++) {
      insert.run(edge.target, JSON.stringify(edge.targetExport.slice(0, i)), id);
    }
  } else insert.run(edge.target, JSON.stringify(edge.targetExport), id);
  return id;
}

module.exports = { hash, moduleId, prepare, createStore, setMeta, getMeta, openStore, ensureModule, addEdge };
