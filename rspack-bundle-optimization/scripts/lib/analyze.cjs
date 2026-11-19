const { DatabaseSync } = require('node:sqlite');
const { fs, path, fail, hash, id, json, readJson, signature, verifyInputs, openRead, meta, setMeta } = require('./common.cjs');
const { canonicalSource, sourcePathForContext, lineStarts, utf8Prefix, mergeRanges, coveredRanges, generatedSpans, byteMetrics, addBytes } = require('./coverage.cjs');

function urlPath(value) { try { return decodeURIComponent(new URL(value, 'http://capture.local').pathname); } catch { return value.split(/[?#]/, 1)[0]; } }

function computeAnalysis(args) {
  const build = path.resolve(args.build); const recording = path.resolve(args.coverage);
  const inputs = [signature(build), signature(recording)];
  const raw = readJson(recording, 128 * 1024 * 1024); const envelope = Array.isArray(raw) ? null : raw;
  if (envelope && (envelope.kind !== 'rspack-browser-recording' || envelope.schemaVersion !== 1 || envelope.status !== 'complete')) fail('INVALID_INPUT', 'Expected a complete browser recording or Chrome Coverage JSON array.');
  const scripts = envelope ? envelope.scripts : raw;
  if (!Array.isArray(scripts)) fail('INVALID_INPUT', 'Coverage scripts must be an array.');
  const precision = args.precision || envelope?.precision || 'unknown';
  if (!['per-block', 'per-function', 'unknown'].includes(precision)) fail('INVALID_ARGUMENT', 'Invalid coverage precision.');
  if (envelope?.precision && args.precision && envelope.precision !== args.precision) fail('INPUT_IDENTITY_MISMATCH', 'Requested precision disagrees with recording metadata.');
  const input = openRead(build);
  try {
    const metadata = meta(input);
    if (metadata.kind !== 'rspack-bundle-capture' || metadata.schema !== 1 || metadata.status !== 'complete' || !metadata.buildHash || !metadata.context)
      fail('INVALID_INPUT', 'Expected a complete build captured by scripts/capture-plugin.cjs.');
    const assets = input.prepare('SELECT id,name,url,content_hash,chunks,initial FROM assets ORDER BY id').all();
    const matched = new Map(); const ignored = []; const warnings = [];
    for (const entry of scripts) {
      if (!entry || typeof entry.url !== 'string' || typeof entry.text !== 'string') fail('INVALID_INPUT', 'Coverage entries must include url and the exact executed text.');
      const name = urlPath(entry.url);
      const candidates = assets.filter(asset => name === urlPath(asset.url) || name.endsWith(`/${asset.name}`));
      if (!candidates.length) { ignored.push({ url: entry.url, reason: 'Not a JavaScript asset from this build.' }); continue; }
      const digest = hash(entry.text); const longest = Math.max(...candidates.map(asset => asset.name.length));
      const exact = candidates.filter(asset => asset.name.length === longest && asset.content_hash === digest);
      if (exact.length !== 1) fail('INPUT_IDENTITY_MISMATCH', 'Recorded script text does not uniquely match its captured build asset.', { url: entry.url, buildId: metadata.buildHash });
      const previous = matched.get(exact[0].id);
      matched.set(exact[0].id, { ranges: mergeRanges([...(previous?.ranges || []), ...coveredRanges(entry)], entry.text.length) });
    }
    if (!matched.size) fail('INPUT_IDENTITY_MISMATCH', 'No recorded script matches this build.');
    const networkOnly = new Set();
    for (const request of envelope?.network || []) {
      if (request.type !== 'Script' || !(request.status >= 200 && request.status < 400)) continue;
      for (const asset of assets) if (!matched.has(asset.id) && (urlPath(request.url) === urlPath(asset.url) || urlPath(request.url).endsWith(`/${asset.name}`))) networkOnly.add(asset.id);
    }
    for (const asset of assets) if (networkOnly.has(asset.id)) warnings.push({ asset: asset.name, kind: 'network-without-coverage', message: 'A script request was observed but its executed text/coverage was not captured. Load/execution attribution is unknown.' });
    const modules = input.prepare('SELECT id,identifier,resource,resource_hash,layer FROM modules').all();
    const modulesById = new Map(modules.map(module => [module.id, module]));
    const memberships = new Map();
    for (const row of input.prepare('SELECT module_id,chunk_id FROM module_chunks').iterate()) {
      if (!memberships.has(row.module_id)) memberships.set(row.module_id, new Set()); memberships.get(row.module_id).add(row.chunk_id);
    }
    const bySource = new Map();
    for (const m of modules) if (m.resource) {
      const key = canonicalSource(m.resource, metadata.context); if (!bySource.has(key)) bySource.set(key, []); bySource.get(key).push(m);
    }
    const files = new Map(); const totals = byteMetrics(); const assetReports = [];
    const readAsset = input.prepare('SELECT content,source_map,map_error FROM assets WHERE id=?');
    for (const asset of assets) {
      const value = readAsset.get(asset.id); const generated = value.content; const prefix = utf8Prefix(generated);
      const loaded = networkOnly.has(asset.id) ? null : matched.has(asset.id); const ranges = matched.get(asset.id)?.ranges || []; const chunks = JSON.parse(asset.chunks);
      const assetMetrics = byteMetrics(); let rangeCursor = 0;
      const assetSources = new Map();
      let spans;
      try { spans = [...generatedSpans(generated, value.source_map ? JSON.parse(value.source_map) : null)]; }
      catch (error) { warnings.push({ asset: asset.name, kind: 'source-map', message: error.message }); spans = [{ start: 0, end: generated.length, source: null }]; }
      if (value.map_error) warnings.push({ asset: asset.name, kind: 'source-map', message: value.map_error });
      for (const span of spans) {
        const emitted = prefix[span.end] - prefix[span.start]; if (!emitted) continue;
        while (rangeCursor < ranges.length && ranges[rangeCursor].end <= span.start) rangeCursor++;
        let executed = 0;
        for (let i = rangeCursor; i < ranges.length && ranges[i].start < span.end; i++) executed += prefix[Math.min(span.end, ranges[i].end)] - prefix[Math.max(span.start, ranges[i].start)];
        if (loaded === null) executed = null;
        const loadedBytes = loaded === null ? null : loaded ? emitted : 0;
        addBytes(assetMetrics, emitted, loadedBytes, executed);
        if (!span.source) { assetMetrics.unmappedBytes += emitted; continue; }
        assetMetrics.mappedBytes += emitted;
        const content = typeof span.content === 'string' ? span.content : null;
        let sourceVariants = assetSources.get(span.source);
        if (!sourceVariants) assetSources.set(span.source, sourceVariants = new Map());
        let source = sourceVariants.get(content);
        if (!source) {
          const canonical = canonicalSource(span.source, metadata.context);
          const contentHash = content === null ? null : hash(content);
          const key = id('file', [canonical, contentHash]);
          let file = files.get(key);
          if (!file) {
            file = { id: key, path: sourcePathForContext(span.source, metadata.context), canonical, content, contentHash, metrics: byteMetrics(), lines: new Map(),
              moduleIds: new Set(), perModule: new Map(), ambiguous: new Set(), chunks: new Set(), loadedChunks: new Set() };
            files.set(key, file);
          }
          const candidates = (bySource.get(canonical) || []).filter(module => chunks.some(chunk => memberships.get(module.id)?.has(chunk)));
          sourceVariants.set(content, source = { file, candidates });
          for (const chunk of chunks) { file.chunks.add(chunk); if (loaded) file.loadedChunks.add(chunk); }
        }
        const { file, candidates } = source;
        addBytes(file.metrics, emitted, loadedBytes, executed);
        for (const module of candidates) file.moduleIds.add(module.id);
        const line = file.lines.get(span.line) || { lineIndex: span.line, ...byteMetrics(), ranges: [], states: new Map(), ambiguous: new Set() };
        addBytes(line, emitted, loadedBytes, executed);
        line.ranges.push({ startColumn: span.column, endColumn: span.column + 1, executed: executed === null ? null : executed > 0 });
        if (candidates.length === 1) {
          const moduleId = candidates[0].id; const current = file.perModule.get(moduleId) || byteMetrics(); addBytes(current, emitted, loadedBytes, executed); file.perModule.set(moduleId, current);
          const evidence = line.states.get(moduleId) || byteMetrics(); addBytes(evidence, emitted, loadedBytes, executed); line.states.set(moduleId, evidence);
        } else for (const module of candidates) { file.ambiguous.add(module.id); line.ambiguous.add(module.id); }
        file.lines.set(span.line, line);
      }
      addBytes(totals, assetMetrics.emittedBytes, assetMetrics.loadedBytes, assetMetrics.executedBytes); totals.mappedBytes += assetMetrics.mappedBytes; totals.unmappedBytes += assetMetrics.unmappedBytes;
      assetReports.push({ ...asset, chunks, loaded, metrics: assetMetrics });
    }
    const retainedMetrics = (file, moduleId) => {
      if (file.content === null || file.ambiguous.has(moduleId)) return null;
      const starts = lineStarts(file.content); const prefix = utf8Prefix(file.content); const result = byteMetrics();
      for (const line of file.lines.values()) {
        const evidence = line.states.get(moduleId); if (!evidence?.emittedBytes) continue;
        const start = starts[line.lineIndex]; if (start === undefined) continue;
        const bytes = prefix[starts[line.lineIndex + 1] ?? file.content.length] - prefix[start];
        addBytes(result, bytes, evidence.loadedBytes === null ? null : evidence.loadedBytes > 0 ? bytes : 0, evidence.executedBytes === null ? null : evidence.executedBytes > 0 ? bytes : 0);
      }
      return result;
    };
    const fileRecords = [...files.values()].map(file => {
      const moduleIds = [...file.moduleIds]; const knownHash = file.contentHash;
      const verifiedOriginal = knownHash !== null && moduleIds.some(key => modulesById.get(key)?.resource_hash === knownHash);
      const lines = [...file.lines.values()].sort((a, b) => a.lineIndex - b.lineIndex).map(line => ({ lineIndex: line.lineIndex,
        emittedBytes: line.emittedBytes, loadedBytes: line.loadedBytes, executedBytes: line.executedBytes, ranges: line.ranges,
        moduleStates: Object.fromEntries(moduleIds.filter(key => !line.ambiguous.has(key)).map(key => [key, line.states.get(key) || byteMetrics()])) }));
      return { id: file.id, path: file.path, coordinateSpace: verifiedOriginal ? 'resource' : 'map-source', content: file.content, moduleIds,
        metrics: file.metrics,
        generatedMetricsById: Object.fromEntries(moduleIds.map(key => [key, file.ambiguous.has(key) ? null : file.perModule.get(key) || byteMetrics()])),
        moduleMetricsById: Object.fromEntries(moduleIds.map(key => [key, retainedMetrics(file, key)])),
        mappedLines: lines };
    });
    const recordingSha256 = hash(fs.readFileSync(recording));
    const coverageMeta = {
      kind: 'rspack-bundle-coverage', coverageSchema: 1, coverageSha256: recordingSha256,
      scenario: args.scenario || envelope?.scenario || 'unspecified', precision,
      coverageTotals: totals,
      coverageImportSummary: { matchedAssets: matched.size, ignoredEntries: ignored, warnings, recordingGaps: envelope?.gaps || [] },
    };
    verifyInputs(inputs);
    return { build, recording, inputs, raw, envelope, metadata, assets, matched, ignored, warnings, totals, assetReports, fileRecords, coverageMeta };
  } finally { input.close(); }
}

function analyze(args) {
  if (!args.build || !args.coverage || !args.out) fail('INVALID_ARGUMENT', 'analyze requires --build, --coverage, and --out.');
  const output = path.resolve(args.out);
  if (fs.existsSync(output)) fail('OUTPUT_EXISTS', 'Choose a new analysis output path.');
  const analyzed = computeAnalysis(args);
  const pending = `${output}.${process.pid}.${Date.now()}.incomplete`;
  let db;
  try {
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(analyzed.build, pending, fs.constants.COPYFILE_EXCL);
    db = new DatabaseSync(pending); db.exec(`BEGIN;
      CREATE TABLE coverage_files(id TEXT PRIMARY KEY,path TEXT,space TEXT,content TEXT,module_ids TEXT,metrics TEXT,generated_by_module TEXT,retained_by_module TEXT,mapped_lines TEXT);
      CREATE TABLE coverage_assets(id TEXT PRIMARY KEY,payload TEXT);
      CREATE TABLE recordings(id TEXT PRIMARY KEY,payload TEXT);
    `);
    const insertFile = db.prepare('INSERT INTO coverage_files VALUES (?,?,?,?,?,?,?,?,?)');
    for (const file of analyzed.fileRecords) {
      insertFile.run(file.id, file.path, file.coordinateSpace, file.content, json(file.moduleIds), json(file.metrics),
        json(file.generatedMetricsById), json(file.moduleMetricsById), json(file.mappedLines));
    }
    const insertAsset = db.prepare('INSERT INTO coverage_assets VALUES (?,?)');
    for (const asset of analyzed.assetReports) insertAsset.run(asset.id, json(asset));
    db.prepare('INSERT INTO recordings VALUES (?,?)').run(analyzed.coverageMeta.coverageSha256, json(analyzed.raw));
    setMeta(db, analyzed.coverageMeta);
    verifyInputs(analyzed.inputs); db.exec('COMMIT'); db.close(); db = null; fs.linkSync(pending, output); fs.unlinkSync(pending);
    return { ok: true, schemaVersion: 1, buildId: analyzed.metadata.buildHash, coverageRunId: analyzed.coverageMeta.coverageSha256, database: output, precision: analyzed.coverageMeta.precision,
      counts: { assets: analyzed.assets.length, matchedAssets: analyzed.matched.size, sources: analyzed.fileRecords.length, ignoredScripts: analyzed.ignored.length, gaps: analyzed.warnings.length + (analyzed.envelope?.gaps?.length || 0) },
      generated: analyzed.totals };
  } finally { db?.close(); if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}

module.exports = { analyze, computeAnalysis };
