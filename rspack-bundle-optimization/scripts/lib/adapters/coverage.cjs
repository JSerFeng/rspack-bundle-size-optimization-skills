const { openRead, meta, fail, decode } = require('../common.cjs');
const { sourcePathForContext } = require('../coverage.cjs');

function openCoverage(file) {
  const db = openRead(file);
  try {
    const metadata = meta(db);
    if (metadata.schema !== 1 || metadata.kind !== 'rspack-bundle-coverage' || metadata.coverageSchema !== 1 || metadata.status !== 'complete')
      fail('INVALID_INPUT', 'Expected coverage SQLite produced by scripts/query.cjs analyze.');
    const chunksByModule = new Map();
    for (const row of db.prepare('SELECT module_id,chunk_id FROM module_chunks').iterate()) {
      if (!chunksByModule.has(row.module_id)) chunksByModule.set(row.module_id, []);
      chunksByModule.get(row.module_id).push(row.chunk_id);
    }
    const modules = db.prepare('SELECT id,identifier,layer,type,resource,provided,used FROM modules').all().map(row => ({ ...row,
      moduleType: row.type, chunks: chunksByModule.get(row.id) || [], providedExports: decode(row.provided || 'null'), usedExports: decode(row.used || 'null') }));
    const files = db.prepare('SELECT id,path,space,module_ids,metrics,generated_by_module,retained_by_module FROM coverage_files ORDER BY id').all().map(row => ({
      id: row.id, path: row.path, coordinateSpace: row.space, moduleIds: decode(row.module_ids), metrics: decode(row.metrics),
      generatedMetricsById: decode(row.generated_by_module), moduleMetricsById: decode(row.retained_by_module),
    }));
    const loadedChunks = new Set(); const unknownChunks = new Set();
    for (const row of db.prepare('SELECT payload FROM coverage_assets').iterate()) {
      const asset = decode(row.payload); if (asset.loaded) for (const chunk of asset.chunks) loadedChunks.add(chunk);
      if (asset.loaded === null) for (const chunk of asset.chunks) unknownChunks.add(chunk);
    }
    const chunks = db.prepare('SELECT id,initial,files,runtime FROM chunks').all().map(row => ({ ...row, initial: Boolean(row.initial), loaded: loadedChunks.has(row.id) ? true : unknownChunks.has(row.id) ? null : false, files: decode(row.files) }));
    return {
      kind: 'coverage', db, database: file, files: [file], metadata,
      build: { hash: metadata.buildHash, context: metadata.context, compiler: metadata.compiler ?? null },
      dataset: { coverageSha256: metadata.coverageSha256, scenario: metadata.scenario, precision: metadata.precision },
      graphAvailable: metadata.graphAvailable === true,
      manifest: { modules, diagnostics: [...(metadata.coverageImportSummary?.warnings || []), ...(metadata.coverageImportSummary?.recordingGaps || [])] },
      report: { files, chunks, importSummary: metadata.coverageImportSummary || { ignoredEntries: [] } },
      modules() { return modules; },
      detail(sourceId) {
        const row = db.prepare('SELECT id,content,mapped_lines FROM coverage_files WHERE id=?').get(sourceId);
        if (!row) fail('SOURCE_UNAVAILABLE', 'Unknown analyzed source.');
        return { id: row.id, content: row.content, mappedLines: decode(row.mapped_lines) };
      },
      *edges(native = true) {
        if (native && !this.graphAvailable) return;
        for (const row of db.prepare(native ? 'SELECT * FROM edges ORDER BY id' : 'SELECT * FROM refs ORDER BY id').iterate()) yield {
          originalId: row.id, origin: row.origin, target: row.target, originExport: native ? decode(row.origin_export) : null,
          targetExport: native ? decode(row.target_export) : null, dependency: native ? row.dependency : row.id,
          rawLocation: native ? row.loc : decode(row.loc || 'null'), sourcePath: null, sourceLocation: null,
          kind: native ? 'native' : 'module-graph', dependencyType: native ? 'export usage' : row.dependency_type, active: native || row.active === null ? null : Boolean(row.active),
        };
      },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
module.exports = { openCoverage, sourcePathForContext };
