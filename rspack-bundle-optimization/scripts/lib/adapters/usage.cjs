const { openRead, meta, fail, decode } = require('../common.cjs');
const { readChunkGroups } = require('./coverage.cjs');

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function openUsage(file) {
  const db = openRead(file);
  try {
    const metadata = meta(db);
    if (metadata.schema !== 1 || metadata.status !== 'complete') fail('INVALID_INPUT', 'Expected a complete usage SQLite snapshot (schema 1).');
    if (!metadata.buildHash || !metadata.context) fail('INVALID_INPUT', 'Usage snapshot must identify its build hash and compiler context.');
    const chunksByModule = new Map();
    if (hasTable(db, 'module_chunks')) {
      for (const row of db.prepare('SELECT module_id,chunk_id FROM module_chunks').iterate()) {
        if (!chunksByModule.has(row.module_id)) chunksByModule.set(row.module_id, []);
        chunksByModule.get(row.module_id).push(row.chunk_id);
      }
    }
    const chunks = hasTable(db, 'chunks')
      ? db.prepare('SELECT id,initial,files,runtime FROM chunks ORDER BY id').all().map(row => ({
          id: row.id, initial: Boolean(row.initial), loaded: null, files: decode(row.files || '[]'), runtime: decode(row.runtime || '[]'), metrics: null,
        }))
      : [];
    const chunkGroups = readChunkGroups(db);
    return {
      kind: 'usage', file, db, metadata, chunks, chunkGroups,
      build: { hash: metadata.buildHash, context: metadata.context, compiler: metadata.compiler ?? null },
      graphAvailable: metadata.graphAvailable === true,
      *modules() {
        for (const row of db.prepare(`SELECT id,identifier,layer,type,resource,parent_id,provided,used,transformed_hash,resource_hash,
          transformed IS NOT NULL AS has_transformed,resource_content IS NOT NULL AS has_resource,source_gap FROM modules`).iterate()) {
          yield { ...row, chunks: chunksByModule.get(row.id) || [], providedExports: decode(row.provided || 'null'), usedExports: decode(row.used || 'null') };
        }
      },
      *edges() {
        if (metadata.graphAvailable !== true) return;
        for (const row of db.prepare('SELECT * FROM edges ORDER BY id').iterate()) yield {
          originalId: row.id, origin: row.origin, target: row.target, originExport: decode(row.origin_export),
          targetExport: decode(row.target_export), dependency: row.dependency, rawLocation: row.loc,
          sourcePath: null, sourceLocation: null, kind: 'native', dependencyType: 'export usage',
        };
      },
      *moduleEdges() {
        if (!hasTable(db, 'refs')) return;
        for (const row of db.prepare('SELECT * FROM refs ORDER BY id').iterate()) yield {
          originalId: row.id, origin: row.origin, target: row.target, originExport: null, targetExport: null,
          dependency: row.id, rawLocation: decode(row.loc || 'null'), sourcePath: null, sourceLocation: null,
          kind: 'module-graph', dependencyType: row.dependency_type, request: row.request ?? null, active: row.active === null ? null : Boolean(row.active),
        };
      },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
module.exports = { openUsage };
