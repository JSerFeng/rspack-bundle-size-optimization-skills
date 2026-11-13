const { openRead, meta, fail, decode } = require('../common.cjs');

function openUsage(file) {
  const db = openRead(file);
  try {
    const metadata = meta(db);
    if (metadata.schema !== 1 || metadata.status !== 'complete') fail('INVALID_INPUT', 'Expected a complete usage SQLite snapshot (schema 1).');
    if (!metadata.buildHash || !metadata.context) fail('INVALID_INPUT', 'Usage snapshot must identify its build hash and compiler context.');
    return {
      kind: 'usage', file, db, metadata,
      build: { hash: metadata.buildHash, context: metadata.context, compiler: metadata.compiler ?? null },
      graphAvailable: metadata.graphAvailable === true,
      *modules() {
        for (const row of db.prepare(`SELECT id,identifier,layer,type,resource,parent_id,provided,used,transformed_hash,resource_hash,
          transformed IS NOT NULL AS has_transformed,resource_content IS NOT NULL AS has_resource,source_gap FROM modules`).iterate()) {
          yield { ...row, providedExports: decode(row.provided || 'null'), usedExports: decode(row.used || 'null') };
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
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
module.exports = { openUsage };
