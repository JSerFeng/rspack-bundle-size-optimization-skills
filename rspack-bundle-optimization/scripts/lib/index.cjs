const { DatabaseSync } = require('node:sqlite');
const { fs, path, fail, id, hash, json, displayPath, signature, verifyInputs, setMeta } = require('./common.cjs');
const { canonicalSource } = require('./coverage.cjs');
const { computeAnalysis } = require('./analyze.cjs');
const { openUsage } = require('./adapters/usage.cjs');
const { openCoverage, openInlineCoverage } = require('./adapters/coverage.cjs');

const METRICS = ['ge', 'gl', 'gx', 'gu', 'gr', 'se', 'sl', 'sx', 'su', 'sr'];
function normalizedMetrics(value) {
  if (!value) return null;
  const values = ['emittedBytes', 'loadedBytes', 'executedBytes', 'unusedBytes'].map(key => value[key]);
  if (!Number.isFinite(values[0]) || values.some(number => number !== null && (!Number.isFinite(number) || number < 0))) fail('INVALID_INPUT', 'Coverage contains invalid byte metrics.');
  if ((values[1] === null && (values[2] !== null || values[3] !== null)) || (values[2] === null && values[3] !== null) ||
    (values[1] !== null && (values[1] > values[0] || (values[2] !== null && (values[2] > values[1] || values[3] !== values[1] - values[2])))))
    fail('INVALID_INPUT', 'Coverage byte metrics must satisfy executed <= loaded <= emitted and unused = loaded - executed.');
  return [...values, value.loadedBytes > 0 && value.executedBytes !== null ? value.executedBytes / value.loadedBytes : null];
}
function sumMetrics(values) {
  if (!values.length || values.some(value => value === null)) return null;
  const sum = [0, 0, 0, 0, null];
  for (const value of values) for (let i = 0; i < 4; i++) sum[i] = sum[i] === null || value[i] === null ? null : sum[i] + value[i];
  sum[4] = sum[1] > 0 && sum[2] !== null ? sum[2] / sum[1] : null;
  return sum;
}
function packageName(resource) {
  const parts = String(resource || '').replaceAll('\\', '/').split('/node_modules/');
  if (parts.length < 2) return null;
  const tail = parts.at(-1).split('/');
  return tail[0].startsWith('@') ? tail.slice(0, 2).join('/') : tail[0];
}
function classifyUsedState(used) {
  if (used === false) return 'none';
  if (Array.isArray(used)) return used.length ? 'named' : 'none';
  return 'unknown';
}
function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384; PRAGMA mmap_size=0;
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE modules(id TEXT PRIMARY KEY,identifier TEXT NOT NULL,resource TEXT,display_path TEXT NOT NULL,layer TEXT,type TEXT,package TEXT,
      provided TEXT,used TEXT,used_state TEXT NOT NULL,loaded INTEGER,initial INTEGER,incoming INTEGER,consumers INTEGER,used_count INTEGER,
      module_incoming INTEGER DEFAULT 0,module_outgoing INTEGER DEFAULT 0);
    CREATE TABLE aliases(adapter TEXT,original_id TEXT,module_id TEXT,PRIMARY KEY(adapter,original_id));
    CREATE TABLE sources(id TEXT PRIMARY KEY,path TEXT,space TEXT,hash TEXT,locator TEXT NOT NULL);
    CREATE TABLE source_contents(source_id TEXT PRIMARY KEY,content TEXT);
    CREATE TABLE module_sources(module_id TEXT,source_id TEXT,PRIMARY KEY(module_id,source_id));
    CREATE TABLE chunks(id TEXT PRIMARY KEY,initial INTEGER,loaded INTEGER,files TEXT,runtime TEXT,
      emitted_bytes REAL,loaded_bytes REAL,executed_bytes REAL,unexecuted_bytes REAL);
    CREATE TABLE module_chunks(module_id TEXT,chunk_id TEXT,PRIMARY KEY(module_id,chunk_id));
    CREATE INDEX module_chunks_chunk ON module_chunks(chunk_id,module_id);
    CREATE TABLE chunk_groups(id TEXT PRIMARY KEY,name TEXT,chunks TEXT,origins TEXT,parents TEXT);
    CREATE TABLE metrics(module_id TEXT,scope TEXT,ge REAL,gl REAL,gx REAL,gu REAL,gr REAL,se REAL,sl REAL,sx REAL,su REAL,sr REAL,PRIMARY KEY(module_id,scope));
    CREATE TABLE edges(id TEXT PRIMARY KEY,origin TEXT NOT NULL,target TEXT NOT NULL,origin_export TEXT,target_export TEXT,
      kind TEXT,dependency TEXT,dependency_type TEXT,request TEXT,raw_loc TEXT,source_path TEXT,source_loc TEXT,adapter TEXT,original_id TEXT,active INTEGER);
    CREATE INDEX edge_in ON edges(target,kind,id); CREATE INDEX edge_out ON edges(origin,kind,id);
    CREATE TABLE targets(module_id TEXT,path TEXT,edge_id TEXT,PRIMARY KEY(module_id,path,edge_id));
    CREATE TABLE exports(id TEXT PRIMARY KEY,module_id TEXT,path TEXT,used TEXT,incoming INTEGER);
    CREATE INDEX exports_module ON exports(module_id,id);
    CREATE TABLE coverage_lines(id TEXT PRIMARY KEY,module_id TEXT,source_id TEXT,line INTEGER,state TEXT,
      ge REAL,gl REAL,gx REAL,gu REAL,ranges TEXT,range_precision TEXT);
    CREATE INDEX lines_module ON coverage_lines(module_id,id);
    CREATE INDEX lines_bytes ON coverage_lines(module_id,gu DESC,id);
    CREATE INDEX lines_source_line ON coverage_lines(module_id,source_id,line);
    CREATE TABLE gaps(id TEXT PRIMARY KEY,module_id TEXT,kind TEXT,detail TEXT);
    CREATE INDEX gaps_kind ON gaps(kind,id);
    CREATE INDEX metrics_unexecuted ON metrics(scope,gu DESC,module_id);
    CREATE INDEX metrics_emitted ON metrics(scope,ge DESC,module_id);
    CREATE INDEX metrics_ratio ON metrics(scope,gr ASC,module_id);
    CREATE INDEX metrics_source ON metrics(scope,su DESC,module_id);
    CREATE INDEX modules_incoming ON modules(incoming DESC,id);
    CREATE INDEX modules_consumers ON modules(consumers DESC,id);
    CREATE INDEX modules_used_state ON modules(used_state,id);
  `);
}

function buildIndex(args) {
  if (!args.build && !args.coverage && !args.usage) fail('INVALID_ARGUMENT', 'index requires --build, --coverage, or --usage.');
  if (args.build && args.usage) fail('INVALID_ARGUMENT', 'Use --build or --usage, not both.');
  if (!args.out) fail('INVALID_ARGUMENT', '--out is required.');
  const output = path.resolve(args.out);
  if (fs.existsSync(output)) fail('OUTPUT_EXISTS', 'The index already exists. Choose a new --out path.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const pending = `${output}.${process.pid}.${Date.now()}.incomplete`;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let emittedProgress = false;
  const logProgress = (message, force = false) => {
    const now = Date.now();
    if (!force && now - startedAt < 1500) return;
    if (!force && now - lastProgressAt < 2000) return;
    lastProgressAt = now;
    emittedProgress = true;
    const elapsed = ((now - startedAt) / 1000).toFixed(1);
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    process.stderr.write(`[index ${elapsed}s | ${rssMb}MB RSS] ${message}\n`);
  };
  let usage; let coverage; let db;
  try {
    if (args.build && args.coverage) {
      const analyzed = computeAnalysis(
        { build: args.build, coverage: args.coverage, scenario: args.scenario, precision: args.precision },
        { onProgress: msg => logProgress(msg) },
      );
      coverage = openInlineCoverage(analyzed);
    } else if (args.build) {
      usage = openUsage(path.resolve(args.build));
    } else {
      usage = args.usage ? openUsage(path.resolve(args.usage)) : null;
      coverage = args.coverage ? openCoverage(path.resolve(args.coverage)) : null;
    }
    const build = usage?.build || coverage.build;
    if (usage && coverage && (usage.build.hash !== coverage.build.hash || path.resolve(usage.build.context) !== path.resolve(coverage.build.context) ||
      (usage.build.compiler && coverage.build.compiler && usage.build.compiler !== coverage.build.compiler)))
      fail('INPUT_IDENTITY_MISMATCH', 'Usage and coverage must identify the same build and compiler context.');
    const inputs = [...new Set([...(coverage?.files || []), ...(usage ? [usage.file] : [])])].map(signature);
    db = new DatabaseSync(pending); createSchema(db); db.exec('BEGIN');
    const graphAvailable = usage ? usage.graphAvailable : coverage.graphAvailable;
    const moduleMaps = { usage: new Map(), coverage: new Map() };
    const moduleRows = new Map();
    const addModule = (adapter, row) => {
      if (typeof row.identifier !== 'string' || !row.identifier || typeof row.id !== 'string') fail('INVALID_INPUT', 'Module identity is missing.');
      const key = id('mod', [row.identifier, row.layer ?? null]);
      if (moduleMaps[adapter].has(row.id) && moduleMaps[adapter].get(row.id) !== key) fail('INVALID_INPUT', 'Conflicting module IDs.');
      const known = moduleRows.get(key);
      if (known?.adapterIds[adapter] && known.adapterIds[adapter] !== row.id) fail('INPUT_IDENTITY_MISMATCH', 'Multiple module instances share identifier/layer; cannot merge them safely.');
      const provided = row.providedExports;
      const used = row.usedExports;
      const value = known || { id: key, identifier: row.identifier, resource: row.resource ?? null,
        displayPath: displayPath(row.resource || row.identifier, build.context),
        layer: row.layer ?? null, type: row.moduleType ?? row.type ?? null,
        package: packageName(row.resource || row.identifier), provided: null, used: null, adapterIds: {} };
      if (provided !== undefined && provided !== null && (!Array.isArray(provided) || !provided.every(name => typeof name === 'string'))) fail('INVALID_INPUT', 'Invalid provided exports.');
      if (used !== undefined && used !== null && typeof used !== 'boolean' && (!Array.isArray(used) || !used.every(name => typeof name === 'string'))) fail('INVALID_INPUT', 'Invalid used exports.');
      if (adapter === 'usage' || !known) { value.provided = provided ?? null; value.used = used ?? null; }
      value.adapterIds[adapter] = row.id;
      moduleRows.set(key, value); moduleMaps[adapter].set(row.id, key);
      db.prepare('INSERT OR REPLACE INTO aliases VALUES (?,?,?)').run(adapter, row.id, key);
      return key;
    };
    const sourceInsert = db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?,?,?,?)');
    const contentInsert = db.prepare('INSERT OR IGNORE INTO source_contents VALUES (?,?)');
    const linkInsert = db.prepare('INSERT OR IGNORE INTO module_sources VALUES (?,?)');
    const moduleSourceKey = new Map();
    const addSource = (moduleId, sourcePath, space, sourceHash, locator, inlineContent = null) => {
      const canonical = canonicalSource(sourcePath, build.context);
      const dedupeKey = sourceHash !== null ? `${moduleId}\0${space}\0${sourceHash}\0${canonical}` : null;
      if (dedupeKey && moduleSourceKey.has(dedupeKey)) return moduleSourceKey.get(dedupeKey);
      const key = id('src', [locator, space, sourceHash]);
      sourceInsert.run(key, displayPath(sourcePath, build.context), space, sourceHash, json(locator));
      if (inlineContent !== null) contentInsert.run(key, inlineContent);
      linkInsert.run(moduleId, key);
      if (dedupeKey) moduleSourceKey.set(dedupeKey, key);
      return key;
    };
    const gapInsert = db.prepare('INSERT OR IGNORE INTO gaps VALUES (?,?,?,?)');
    const gap = (moduleId, kind, detail) => gapInsert.run(id('gap', [moduleId, kind, detail]), moduleId, kind, json(detail));
    if (coverage) for (const row of coverage.modules()) addModule('coverage', row);
    if (usage) for (const row of usage.modules()) {
      const key = addModule('usage', row);
      if (row.has_resource) addSource(key, row.resource || row.identifier, 'resource', row.resource_hash,
        { adapter: 'usage', file: usage.file, module: row.id, space: 'resource' });
      if (row.has_transformed) addSource(key, row.identifier, 'post-loader', row.transformed_hash,
        { adapter: 'usage', file: usage.file, module: row.id, space: 'post-loader' });
      if (row.source_gap) gap(key, 'source', { message: row.source_gap });
    }
    if (usage && coverage && ![...moduleRows.values()].some(row => row.adapterIds.usage && row.adapterIds.coverage))
      fail('INPUT_IDENTITY_MISMATCH', 'No identical module identifier/layer pairs connect these inputs.');
    if (coverage) {
      const readFlags = coverage.db.prepare('SELECT transformed IS NOT NULL AS has_transformed,transformed_hash,resource_content IS NOT NULL AS has_resource,resource_hash FROM modules WHERE id=?');
      const readText = coverage.db.prepare('SELECT transformed,resource_content FROM modules WHERE id=?');
      for (const row of coverage.modules()) {
        const moduleId = moduleMaps.coverage.get(row.id);
        const captured = readFlags.get(row.id);
        if (!captured) continue;
        let resourceHash = captured.resource_hash;
        let transformedHash = captured.transformed_hash;
        if ((captured.has_resource && !resourceHash) || (captured.has_transformed && !transformedHash)) {
          const texts = readText.get(row.id);
          if (captured.has_resource && !resourceHash && typeof texts?.resource_content === 'string') resourceHash = hash(texts.resource_content);
          if (captured.has_transformed && !transformedHash && typeof texts?.transformed === 'string') transformedHash = hash(texts.transformed);
        }
        if (captured.has_resource) addSource(moduleId, row.resource || row.identifier, 'resource', resourceHash, { adapter: 'usage', file: coverage.database, module: row.id, space: 'resource' });
        if (captured.has_transformed) addSource(moduleId, row.identifier, 'post-loader', transformedHash, { adapter: 'usage', file: coverage.database, module: row.id, space: 'post-loader' });
      }
    }
    const edgeInsert = db.prepare('INSERT OR IGNORE INTO edges VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const targetInsert = db.prepare('INSERT OR IGNORE INTO targets VALUES (?,?,?)');
    let missingEdges = 0; let ingestedEdges = 0;
    const ingestEdges = (adapter, edges) => {
      for (const edge of edges) {
        const origin = moduleMaps[adapter].get(edge.origin); const target = moduleMaps[adapter].get(edge.target);
        if (!origin || !target) { missingEdges++; continue; }
        const key = id('edge', [adapter, edge.originalId, edge.kind]);
        edgeInsert.run(key, origin, target, json(edge.originExport), json(edge.targetExport), edge.kind,
          edge.dependency, edge.dependencyType, edge.request ?? null, json(edge.rawLocation), edge.sourcePath, json(edge.sourceLocation), adapter, edge.originalId,
          edge.active === null || edge.active === undefined ? null : Number(edge.active));
        if (edge.kind === 'native') {
          const names = edge.targetExport;
          if (Array.isArray(names) && names.length) for (let i = 1; i <= names.length; i++) targetInsert.run(target, json(names.slice(0, i)), key);
          else targetInsert.run(target, json(names ?? null), key);
        }
        ingestedEdges++;
        if (ingestedEdges % 200000 === 0) logProgress(`indexed ${ingestedEdges} graph edges...`);
      }
    };
    logProgress(`indexing ${moduleRows.size} modules and graph edges...`);
    if (coverage) ingestEdges('coverage', coverage.edges(false));
    if (usage) { ingestEdges('usage', usage.edges()); if (!coverage) ingestEdges('usage', usage.moduleEdges()); }
    else if (coverage) ingestEdges('coverage', coverage.edges(true));
    if (missingEdges) gap(null, 'dangling-edges', { count: missingEdges, message: 'Edges without module identities were excluded; the captured graph is incomplete.' });
    const filesByModule = new Map();
    let mappedLineCount = 0;
    if (coverage) {
      logProgress(`writing ${coverage.report.files.length} mapped sources and coverage lines to SQLite...`);
      const insertLine = db.prepare('INSERT OR REPLACE INTO coverage_lines VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      let fileIdx = 0;
      for (const file of coverage.report.files) {
        fileIdx++;
        if (fileIdx % 5000 === 0) logProgress(`indexed ${fileIdx}/${coverage.report.files.length} sources (${mappedLineCount} lines)...`);
        const knownModules = file.moduleIds.map(original => moduleMaps.coverage.get(original)).filter(Boolean);
        if (knownModules.length !== file.moduleIds.length) gap(null, 'coverage-module-link', { source: file.id, message: 'Some module instances are absent from the manifest.' });
        const detail = coverage.detail(file.id);
        const locator = coverage.inlineSources
          ? { adapter: 'inline-source', source: file.id }
          : { adapter: 'coverage-source', file: coverage.database, source: file.id };
        const textHash = typeof detail.content === 'string' ? hash(detail.content) : null;
        for (const moduleId of knownModules) {
          const sourceId = addSource(moduleId, file.path, file.coordinateSpace || 'map-source', textHash, locator, coverage.inlineSources ? detail.content : null);
          const list = filesByModule.get(moduleId) || []; list.push(file); filesByModule.set(moduleId, list);
          const originalId = moduleRows.get(moduleId).adapterIds.coverage;
          for (const line of detail.mappedLines || []) {
            const perInstance = line.moduleStates?.[originalId];
            const evidence = perInstance || (file.moduleIds.length === 1 ? line : null);
            const ge = evidence?.emittedBytes ?? null; const gl = evidence?.loadedBytes ?? null; const gx = evidence?.executedBytes ?? null;
            const state = !evidence || ![ge, gl, gx].every(Number.isFinite) ? 'unknown' : gl === 0 ? 'not-loaded' : gx > 0 ? 'executed' : 'unexecuted';
            const rangeCount = file.moduleIds.length === 1
              ? (Number.isInteger(line.rangeCount) ? line.rangeCount : (Array.isArray(line.ranges) ? line.ranges.length : 0))
              : null;
            insertLine.run(id('line', [moduleId, sourceId, line.lineIndex]), moduleId, sourceId, line.lineIndex + 1, state,
              ge, gl, gx, gl === null || gx === null ? null : Math.max(0, gl - gx), json(rangeCount), rangeCount === null ? 'unavailable-per-instance' : 'source-line');
            mappedLineCount++;
          }
          if (detail.content === null) gap(moduleId, 'source', { sourceId, message: 'Captured source content is unavailable.' });
          if (file.moduleIds.length > 1) gap(moduleId, 'shared-source', { sourceId, message: 'Generated bytes cannot be uniquely assigned to this module instance.' });
        }
        // Release per-file line arrays and content once written to SQLite so GC can reclaim heap.
        if (coverage.inlineSources) { file.mappedLines = null; file.content = null; }
      }
      for (const diagnostic of coverage.manifest.diagnostics || []) gap(null, diagnostic?.kind || 'build', diagnostic);
      for (const ignored of coverage.report.importSummary.ignoredEntries || []) gap(null, 'ignored-coverage', ignored);
      if (coverage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_gaps'").get()) {
        for (const row of coverage.db.prepare('SELECT module_id,kind,detail FROM capture_gaps').iterate()) gap(moduleMaps.coverage.get(row.module_id) ?? null, row.kind, JSON.parse(row.detail));
      }
      for (const file of coverage.report.files) if (!file.moduleIds.length) gap(null, 'source-module-link', { path: file.path, message: 'Mapped source has no exact captured module instance.' });
    }
    // Index chunks, module_chunks, and chunk_groups
    const chunkSource = coverage ? coverage.report : usage;
    const chunkAdapter = coverage ? 'coverage' : 'usage';
    const chunkInsert = db.prepare('INSERT OR REPLACE INTO chunks VALUES (?,?,?,?,?,?,?,?,?)');
    const modChunkInsert = db.prepare('INSERT OR IGNORE INTO module_chunks VALUES (?,?)');
    const groupInsert = db.prepare('INSERT OR REPLACE INTO chunk_groups VALUES (?,?,?,?,?)');
    const chunksList = chunkSource?.chunks || [];
    for (const chunk of chunksList) {
      const m = chunk.metrics;
      chunkInsert.run(chunk.id, Number(chunk.initial), chunk.loaded === null ? null : Number(chunk.loaded),
        json(chunk.files || []), json(chunk.runtime || []),
        m?.emittedBytes ?? null, m?.loadedBytes ?? null, m?.executedBytes ?? null, m?.unusedBytes ?? null);
    }
    for (const group of chunkSource?.chunkGroups || []) {
      const origins = (group.origins || []).map(origin => ({
        moduleId: origin.moduleId ? (moduleMaps[chunkAdapter].get(origin.moduleId) ?? null) : null,
        request: origin.request ?? null,
        location: origin.location ?? null,
      }));
      groupInsert.run(group.id, group.name ?? null, json(group.chunks || []), json(origins), json(group.parents || []));
    }
    const moduleInsert = db.prepare('INSERT INTO modules(id,identifier,resource,display_path,layer,type,package,provided,used,used_state,loaded,initial,incoming,consumers,used_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const metricInsert = db.prepare(`INSERT INTO metrics VALUES (${Array(12).fill('?').join(',')})`);
    const covModules = new Map(coverage ? coverage.modules().map(row => [row.id, row]) : []);
    const usageChunksByMod = new Map();
    if (!coverage && usage) {
      for (const row of usage.modules()) usageChunksByMod.set(row.id, row.chunks || []);
    }
    const chunks = new Map(chunksList.map(chunk => [chunk.id, chunk]));
    for (const row of moduleRows.values()) {
      const captured = covModules.get(row.adapterIds.coverage);
      const chunkIds = coverage ? (captured?.chunks || []) : (usageChunksByMod.get(row.adapterIds.usage) || []);
      for (const cid of chunkIds) modChunkInsert.run(row.id, cid);
      const knownChunks = chunkIds.map(key => chunks.get(key)).filter(Boolean);
      const loaded = coverage && knownChunks.length ? knownChunks.some(chunk => chunk.loaded === true) ? 1 : knownChunks.some(chunk => chunk.loaded === null) ? null : 0 : null;
      const initial = knownChunks.length ? Number(knownChunks.some(chunk => chunk.initial)) : null;
      const incoming = graphAvailable ? db.prepare("SELECT count(*) AS n,count(DISTINCT origin) AS consumers FROM edges WHERE target=? AND kind='native'").get(row.id) : null;
      const usedCount = Array.isArray(row.used) ? new Set(row.used).size : row.used === false ? 0 : null;
      const usedState = classifyUsedState(row.used);
      moduleInsert.run(row.id, row.identifier, row.resource, row.displayPath, row.layer, row.type, row.package, json(row.provided), json(row.used), usedState, loaded, initial, incoming?.n ?? null, incoming?.consumers ?? null, usedCount);
      const files = filesByModule.get(row.id) || [];
      const generated = sumMetrics(files.map(file => normalizedMetrics(file.generatedMetricsById ? file.generatedMetricsById[row.adapterIds.coverage] ?? null : file.moduleIds.length === 1 ? file.metrics : null)));
      const retained = sumMetrics(files.map(file => normalizedMetrics(file.moduleMetricsById?.[row.adapterIds.coverage] ?? (file.moduleIds.length === 1 ? file.moduleMetrics : null))));
      for (const scope of ['build', 'loaded']) {
        const convert = value => !value ? Array(5).fill(null) : scope === 'loaded' ? [value[1], value[1], value[2], value[3], value[4]] : value;
        metricInsert.run(row.id, scope, ...convert(generated), ...convert(retained));
      }
      if (coverage && !files.length) gap(row.id, 'coverage', { message: 'No coverage source is associated with this module; byte metrics are unknown.' });
      if (!row.adapterIds.coverage && coverage) gap(row.id, 'module-alignment', { message: 'Usage module has no exact coverage identifier/layer match.' });
    }
    db.exec(`UPDATE modules SET module_incoming=(SELECT count(*) FROM edges WHERE target=modules.id AND kind='module-graph'),
      module_outgoing=(SELECT count(*) FROM edges WHERE origin=modules.id AND kind='module-graph');`);
    const exportInsert = db.prepare('INSERT OR IGNORE INTO exports VALUES (?,?,?,?,?)');
    for (const row of moduleRows.values()) {
      const paths = new Map((row.provided || []).map(name => [json([name]), [name]]));
      for (const value of db.prepare('SELECT DISTINCT path FROM targets WHERE module_id=?').iterate(row.id)) {
        const names = JSON.parse(value.path); if (Array.isArray(names) && names.length) paths.set(value.path, names);
      }
      for (const [key, names] of paths) {
        const used = row.used === false ? 'unused' : Array.isArray(row.used) ? (row.used.includes(names[0]) ? (names.length === 1 ? 'used' : 'unknown') : 'unused') : 'unknown';
        const count = graphAvailable ? db.prepare('SELECT count(*) AS n FROM targets WHERE module_id=? AND path=?').get(row.id, key).n : null;
        exportInsert.run(id('export', [row.id, names]), row.id, key, used, count);
      }
    }
    if (!graphAvailable) gap(null, 'usage-graph', { message: 'Native export usage graph unavailable. Empty results do not prove no usage.' });
    if (usage?.metadata.captureError) gap(null, 'usage-capture', { message: usage.metadata.captureError });
    if (usage?.metadata.discardedEdges) gap(null, 'usage-capture', { discardedEdges: usage.metadata.discardedEdges });
    verifyInputs(inputs);
    const identity = { inputs, build, coverage: coverage?.dataset.coverageSha256 ?? null };
    const metadata = { kind: 'rspack-bundle-query', schemaVersion: 3, status: 'complete', datasetId: id('dataset', identity),
      buildId: build.hash, compiler: build.compiler, context: build.context, inputs, coverageRunId: coverage?.dataset.coverageSha256 ?? null,
      scenario: coverage?.dataset.scenario ?? null, coveragePrecision: coverage?.dataset.precision ?? null,
      graphAvailable, coverageAvailable: Boolean(coverage), coverageRanges: false, scopes: coverage ? ['build', 'loaded'] : ['build'],
      coverageTotals: coverage?.metadata.coverageTotals ?? null, coverageImportSummary: coverage?.metadata.coverageImportSummary ?? null,
      graphColumnBase: usage?.metadata.columnBase ?? coverage?.metadata.columnBase ?? 1,
      graphLocationSpace: usage?.metadata.locationSpace ?? coverage?.metadata.locationSpace ?? 'auto',
      counts: {
        modules: moduleRows.size, coverageLines: mappedLineCount,
        edges: db.prepare('SELECT count(*) AS n FROM edges').get().n,
        sources: db.prepare('SELECT count(*) AS n FROM sources').get().n,
        chunks: db.prepare('SELECT count(*) AS n FROM chunks').get().n,
        chunkGroups: db.prepare('SELECT count(*) AS n FROM chunk_groups').get().n,
        gaps: db.prepare('SELECT count(*) AS n FROM gaps').get().n,
      },
      createdAt: new Date().toISOString() };
    setMeta(db, metadata); db.exec('COMMIT'); db.close(); db = null;
    fs.linkSync(pending, output); fs.unlinkSync(pending);
    if (emittedProgress) {
      logProgress(`done: ${metadata.counts.modules} modules, ${metadata.counts.edges} edges, ${metadata.counts.coverageLines} coverage lines -> ${output}`, true);
    }
    return { ok: true, schemaVersion: 1, command: 'index', datasetId: metadata.datasetId, buildId: metadata.buildId, compiler: metadata.compiler,
      coverageRunId: metadata.coverageRunId, precision: metadata.coveragePrecision, scenario: metadata.scenario,
      database: output, counts: metadata.counts, generated: metadata.coverageTotals ?? null };
  } finally {
    db?.close(); usage?.close(); coverage?.close();
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
  }
}
module.exports = { buildIndex, METRICS };
