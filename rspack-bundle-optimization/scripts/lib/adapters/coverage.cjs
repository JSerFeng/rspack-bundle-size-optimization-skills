const { fs, path, fail, readJson, safePath, openRead, decode } = require('../common.cjs');

function readDetail(file, location) {
  if (!location || !Number.isSafeInteger(location.offset) || location.offset < 0 || !Number.isSafeInteger(location.length) || location.length < 1 || location.length > 256 * 1024 * 1024)
    fail('INVALID_INPUT', 'Invalid coverage source detail location.');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(location.length);
    let read = 0;
    while (read < buffer.length) {
      const n = fs.readSync(fd, buffer, read, buffer.length - read, location.offset + read);
      if (!n) fail('INVALID_INPUT', 'Coverage source detail is truncated.');
      read += n;
    }
    return decode(buffer);
  } finally { fs.closeSync(fd); }
}
function openCoverage(directory) {
  const datasetFile = path.join(directory, 'dataset.json');
  const pointerFile = path.join(directory, 'latest.json');
  const dataset = readJson(datasetFile); const pointer = readJson(pointerFile);
  if (dataset.schemaVersion !== 1 || dataset.kind !== 'rspack-coverage-agent-data' || pointer.version !== 2 || !/^v2-[a-f0-9]{32}$/.test(pointer.snapshotId))
    fail('INVALID_INPUT', 'Expected an rspack-coverage Agent data directory.');
  const snapshot = path.join(directory, 'snapshots', pointer.snapshotId);
  const metadataFile = path.join(snapshot, 'metadata.json');
  const metadata = readJson(metadataFile);
  const reportFile = path.join(snapshot, 'report.json'); const complete = readJson(reportFile);
  if (metadata.version !== 2 || metadata.snapshotId !== dataset.snapshotId || pointer.snapshotId !== dataset.snapshotId ||
      pointer.buildHash !== dataset.buildHash || metadata.manifest?.hash !== dataset.buildHash || complete.status !== 'complete' ||
      complete.id !== dataset.coverageSha256 || complete.report?.buildHash !== dataset.buildHash || complete.report?.version !== 2)
    fail('INPUT_IDENTITY_MISMATCH', 'Coverage dataset, snapshot and recording identities disagree.');
  const database = safePath(snapshot, metadata.database.file);
  if (fs.statSync(database).size !== metadata.database.bytes) fail('INVALID_INPUT', 'Coverage payload database size does not match its metadata.');
  const detailsFile = path.join(snapshot, 'report.sources');
  const detailsIndexFile = path.join(snapshot, 'report.sources.index.json');
  const details = readJson(detailsIndexFile);
  if (details.version !== 1 || !details.entries) fail('INVALID_INPUT', 'Unsupported coverage source index.');
  const db = openRead(database);
  const table = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  return {
    kind: 'coverage', directory, db, database, dataset, manifest: metadata.manifest, report: complete.report,
    detailsFile, details,
    files: [datasetFile, pointerFile, metadataFile, reportFile, database, detailsFile, detailsIndexFile],
    build: { hash: dataset.buildHash, context: metadata.manifest.context, compiler: metadata.manifest.compilerName ?? null },
    graphAvailable: metadata.manifest.capabilities?.exportUsageGraph === 'native' && table('export_usage_edges'),
    modules() { return metadata.manifest.modules; },
    detail(fileId) {
      const detail = readDetail(detailsFile, Object.hasOwn(details.entries, fileId) ? details.entries[fileId] : null);
      if (detail.id !== fileId) fail('INVALID_INPUT', 'Coverage source identity mismatch.');
      return detail;
    },
    *edges(native = true) {
      const name = native ? 'export_usage_edges' : 'refs';
      if (!table(name) || (native && !this.graphAvailable)) return;
      for (const row of db.prepare(`SELECT payload FROM ${name} ORDER BY sequence`).iterate()) {
        const edge = decode(row.payload);
        yield { originalId: edge.id, origin: native ? edge.originModuleId : edge.originId, target: native ? edge.targetModuleId : edge.targetId,
          originExport: native ? edge.originExport : null, targetExport: native ? edge.targetExport : edge.exports,
          dependency: edge.dependencyId ?? edge.id, rawLocation: edge.location ?? null,
          sourcePath: edge.sourcePath ?? null, sourceLocation: edge.sourceLocation ?? null,
          kind: native ? 'native' : 'module-graph', dependencyType: edge.dependencyType ?? 'export usage', active: edge.active ?? null };
      }
    },
    close() { db.close(); },
  };
}
module.exports = { openCoverage, readDetail };

// The report uses rspack-coverage's source-path normalization, while captured
// reference locations can retain absolute/loader-prefixed paths. Never use a basename.
function sourcePathForContext(value, context) {
  const strip = value => {
    const index = value.lastIndexOf('!');
    if (index >= 0 && /^(?:[a-z][a-z\d+.-]*:\/\/|\/|\.\.?\/|[a-z]:[\\/])/i.test(value.slice(index + 1))) value = value.slice(index + 1);
    return value.split(/[?#]/, 1)[0].replaceAll('\\', '/');
  };
  const normalize = value => {
    let text = strip(value).replace(/^(?:webpack|rspack):\/\/[^/]*\//, '').replace(/^(?:webpack|rspack|file):\/\//, '').replace(/^\/+/, '').replace(/^\.\//, '');
    while (text.includes('../')) {
      const next = text.replace(/(^|\/)\.(?:\.\/)+/g, '$1');
      if (next === text) break;
      text = next;
    }
    return text || '[unknown source]';
  };
  let source = strip(value).replace(/^(?:webpack|rspack):\/\/[^/]*\//, '');
  if (/^\.\.?\//.test(source)) {
    const base = strip(context);
    source = /^[a-z]:\//i.test(base) ? path.win32.resolve(base, source).replaceAll('\\', '/') : base.startsWith('/') ? path.posix.resolve(base, source) : value;
  } else source = value;
  source = normalize(source); const base = normalize(context);
  return source === base ? source.split('/').at(-1) : source.startsWith(`${base}/`) ? source.slice(base.length + 1) : source;
}
module.exports.sourcePathForContext = sourcePathForContext;
