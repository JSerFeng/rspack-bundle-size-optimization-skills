const { openRead, meta, fail, decode } = require('../common.cjs');
const { sourcePathForContext } = require('../coverage.cjs');

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === col);

function readChunkGroups(db) {
  if (!hasTable(db, 'chunk_groups')) return [];
  const withName = hasColumn(db, 'chunk_groups', 'name');
  return db.prepare(`SELECT id,chunks,origins,parents${withName ? ',name' : ''} FROM chunk_groups ORDER BY id`).all().map(row => ({
    id: row.id, name: withName ? (row.name ?? null) : null,
    chunks: decode(row.chunks || '[]'), origins: decode(row.origins || '[]'), parents: decode(row.parents || '[]'),
  }));
}

function buildChunks(db, assetRows) {
  const loadedChunks = new Set(); const unknownChunks = new Set();
  const chunkTotals = new Map(); const sharedChunks = new Set();
  for (const asset of assetRows) {
    if (asset.loaded) for (const chunk of asset.chunks) loadedChunks.add(chunk);
    if (asset.loaded === null) for (const chunk of asset.chunks) unknownChunks.add(chunk);
    if (asset.metrics) {
      if (asset.chunks.length === 1) {
        const cid = asset.chunks[0];
        const prev = chunkTotals.get(cid) || { emittedBytes: 0, loadedBytes: 0, executedBytes: 0, unusedBytes: 0 };
        for (const key of ['emittedBytes', 'loadedBytes', 'executedBytes', 'unusedBytes']) {
          prev[key] = prev[key] === null || asset.metrics[key] === null || asset.metrics[key] === undefined ? null : prev[key] + asset.metrics[key];
        }
        chunkTotals.set(cid, prev);
      } else {
        for (const cid of asset.chunks) sharedChunks.add(cid);
      }
    }
  }
  if (!hasTable(db, 'chunks')) return [];
  return db.prepare('SELECT id,initial,files,runtime FROM chunks ORDER BY id').all().map(row => {
    const raw = sharedChunks.has(row.id) ? null : chunkTotals.get(row.id) || null;
    return {
      id: row.id, initial: Boolean(row.initial),
      loaded: loadedChunks.has(row.id) ? true : unknownChunks.has(row.id) ? null : false,
      files: decode(row.files || '[]'), runtime: decode(row.runtime || '[]'),
      metrics: raw,
    };
  });
}

function openCoverage(file) {
  const db = openRead(file);
  try {
    const metadata = meta(db);
    if (metadata.schema !== 1 || metadata.kind !== 'rspack-bundle-coverage' || metadata.coverageSchema !== 1 || metadata.status !== 'complete')
      fail('INVALID_INPUT', 'Expected a complete rspack-bundle-coverage SQLite (schema 1), or pass --build <build.sqlite> --coverage <recording.json> to index.');
    const chunksByModule = new Map();
    if (hasTable(db, 'module_chunks')) {
      for (const row of db.prepare('SELECT module_id,chunk_id FROM module_chunks').iterate()) {
        if (!chunksByModule.has(row.module_id)) chunksByModule.set(row.module_id, []);
        chunksByModule.get(row.module_id).push(row.chunk_id);
      }
    }
    const modules = db.prepare('SELECT id,identifier,layer,type,resource,provided,used FROM modules').all().map(row => ({ ...row,
      moduleType: row.type, chunks: chunksByModule.get(row.id) || [], providedExports: decode(row.provided || 'null'), usedExports: decode(row.used || 'null') }));
    const files = db.prepare('SELECT id,path,space,module_ids,metrics,generated_by_module,retained_by_module FROM coverage_files ORDER BY id').all().map(row => ({
      id: row.id, path: row.path, coordinateSpace: row.space, moduleIds: decode(row.module_ids), metrics: decode(row.metrics),
      generatedMetricsById: decode(row.generated_by_module), moduleMetricsById: decode(row.retained_by_module),
    }));
    const assetRows = db.prepare('SELECT payload FROM coverage_assets').all().map(row => decode(row.payload));
    const chunks = buildChunks(db, assetRows);
    const chunkGroups = readChunkGroups(db);
    return {
      kind: 'coverage', db, database: file, files: [file], metadata, inlineSources: false,
      build: { hash: metadata.buildHash, context: metadata.context, compiler: metadata.compiler ?? null },
      dataset: { coverageSha256: metadata.coverageSha256, scenario: metadata.scenario, precision: metadata.precision },
      graphAvailable: metadata.graphAvailable === true,
      manifest: { modules, diagnostics: [...(metadata.coverageImportSummary?.warnings || []), ...(metadata.coverageImportSummary?.recordingGaps || [])] },
      report: { files, chunks, chunkGroups, importSummary: metadata.coverageImportSummary || { ignoredEntries: [] } },
      modules() { return modules; },
      detail(sourceId) {
        const row = db.prepare('SELECT id,content,mapped_lines FROM coverage_files WHERE id=?').get(sourceId);
        if (!row) fail('SOURCE_UNAVAILABLE', 'Unknown analyzed source.');
        return { id: row.id, content: row.content, mappedLines: decode(row.mapped_lines) };
      },
      *edges(native = true) {
        if (native && !this.graphAvailable) return;
        const table = native ? 'edges' : 'refs';
        if (!hasTable(db, table)) return;
        for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY id`).iterate()) yield {
          originalId: row.id, origin: row.origin, target: row.target, originExport: native ? decode(row.origin_export) : null,
          targetExport: native ? decode(row.target_export) : null, dependency: native ? row.dependency : row.id,
          rawLocation: native ? row.loc : decode(row.loc || 'null'), sourcePath: null, sourceLocation: null,
          kind: native ? 'native' : 'module-graph', dependencyType: native ? 'export usage' : row.dependency_type, request: native ? null : (row.request ?? null), active: native || row.active === null ? null : Boolean(row.active),
        };
      },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}

function openInlineCoverage(analyzed) {
  const db = openRead(analyzed.build);
  try {
    const metadata = { ...analyzed.metadata, ...analyzed.coverageMeta };
    const chunksByModule = new Map();
    if (hasTable(db, 'module_chunks')) {
      for (const row of db.prepare('SELECT module_id,chunk_id FROM module_chunks').iterate()) {
        if (!chunksByModule.has(row.module_id)) chunksByModule.set(row.module_id, []);
        chunksByModule.get(row.module_id).push(row.chunk_id);
      }
    }
    const modules = db.prepare('SELECT id,identifier,layer,type,resource,provided,used FROM modules').all().map(row => ({ ...row,
      moduleType: row.type, chunks: chunksByModule.get(row.id) || [], providedExports: decode(row.provided || 'null'), usedExports: decode(row.used || 'null') }));
    const byId = new Map(analyzed.fileRecords.map(file => [file.id, file]));
    const chunks = buildChunks(db, analyzed.assetReports);
    const chunkGroups = readChunkGroups(db);
    return {
      kind: 'coverage', db, database: analyzed.build, files: [analyzed.build, analyzed.recording], metadata, inlineSources: true,
      build: { hash: metadata.buildHash, context: metadata.context, compiler: metadata.compiler ?? null },
      dataset: { coverageSha256: metadata.coverageSha256, scenario: metadata.scenario, precision: metadata.precision },
      graphAvailable: metadata.graphAvailable === true,
      manifest: { modules, diagnostics: [...(metadata.coverageImportSummary?.warnings || []), ...(metadata.coverageImportSummary?.recordingGaps || [])] },
      report: { files: analyzed.fileRecords, chunks, chunkGroups, importSummary: metadata.coverageImportSummary || { ignoredEntries: [] } },
      modules() { return modules; },
      detail(sourceId) {
        const row = byId.get(sourceId);
        if (!row) fail('SOURCE_UNAVAILABLE', 'Unknown analyzed source.');
        return { id: row.id, content: row.content, mappedLines: row.mappedLines };
      },
      *edges(native = true) {
        if (native && !this.graphAvailable) return;
        const table = native ? 'edges' : 'refs';
        if (!hasTable(db, table)) return;
        for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY id`).iterate()) yield {
          originalId: row.id, origin: row.origin, target: row.target, originExport: native ? decode(row.origin_export) : null,
          targetExport: native ? decode(row.target_export) : null, dependency: native ? row.dependency : row.id,
          rawLocation: native ? row.loc : decode(row.loc || 'null'), sourcePath: null, sourceLocation: null,
          kind: native ? 'native' : 'module-graph', dependencyType: native ? 'export usage' : row.dependency_type, request: native ? null : (row.request ?? null), active: native || row.active === null ? null : Boolean(row.active),
        };
      },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}

module.exports = { openCoverage, openInlineCoverage, sourcePathForContext, readChunkGroups };
