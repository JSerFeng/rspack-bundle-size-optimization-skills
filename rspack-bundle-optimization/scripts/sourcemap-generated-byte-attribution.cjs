#!/usr/bin/env node
// Attribute actual generated JavaScript bytes to original sources using emitted
// source maps, then compare baseline and experiment outputs.

const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} = require('fs');
const { gzipSync } = require('zlib');
const { basename, dirname, extname, isAbsolute, relative, resolve } = require('path');

function parseArgs(argv) {
  const result = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else { result[key] = next; i += 1; }
  }
  return result;
}

function resolveTraceMapping(projectRoot) {
  try { return require(require.resolve('@jridgewell/trace-mapping', { paths: [projectRoot] })); }
  catch (error) { throw new Error(`sourcemap attribution requires project-local @jridgewell/trace-mapping: ${error.message}`); }
}

function walkJsFiles(root, include, exclude) {
  const result = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && ['.js', '.mjs', '.cjs'].includes(extname(entry.name))) {
        const rel = relative(root, file).replace(/\\/g, '/');
        if ((!include || include.test(rel)) && (!exclude || !exclude.test(rel))) result.push(file);
      }
    }
  };
  visit(root);
  return result.sort();
}

function parseSourceMap(code, asset) {
  const adjacent = `${asset}.map`;
  if (existsSync(adjacent)) return { map: JSON.parse(readFileSync(adjacent, 'utf8')), mapPath: adjacent };
  const matches = [...code.matchAll(/[#@]\s*sourceMappingURL=([^\s*]+)\s*/g)];
  if (matches.length === 0) return null;
  const url = matches[matches.length - 1][1];
  if (/^data:application\/json[^,]*,/.test(url)) {
    const [meta, body] = url.split(',', 2);
    const text = /;base64/i.test(meta) ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
    return { map: JSON.parse(text), mapPath: `${asset}#inline` };
  }
  const mapPath = resolve(dirname(asset), decodeURIComponent(url.split(/[?#]/)[0]));
  if (!existsSync(mapPath)) return null;
  return { map: JSON.parse(readFileSync(mapPath, 'utf8')), mapPath };
}

function normalizeSource(source, projectRoot) {
  if (!source) return '<unmapped>';
  let value = String(source).replace(/\\/g, '/').replace(/^file:\/\//, '');
  value = value.replace(/^webpack:\/\/\/?/, '');
  value = value.replace(/^rspack:\/\/\/?/, '');
  value = value.replace(/[?#].*$/, '');
  if (isAbsolute(value)) {
    const rel = relative(projectRoot, value).replace(/\\/g, '/');
    if (!rel.startsWith('../')) return rel;
  }
  return value.replace(/^\.\//, '');
}

function splitGeneratedLines(code) {
  const lines = [];
  let start = 0;
  while (start < code.length) {
    const newline = code.indexOf('\n', start);
    if (newline === -1) { lines.push({ text: code.slice(start), newline: '' }); break; }
    lines.push({ text: code.slice(start, newline), newline: '\n' });
    start = newline + 1;
  }
  return lines;
}

function addBytes(target, source, bytes) {
  if (bytes <= 0) return;
  target.set(source, (target.get(source) || 0) + bytes);
}

function attributeCode(code, mappings, projectRoot) {
  const byLine = new Map();
  for (const mapping of mappings) {
    const line = Number(mapping.generatedLine || 0);
    if (line <= 0) continue;
    const list = byLine.get(line) || [];
    list.push({ column: Number(mapping.generatedColumn || 0), source: normalizeSource(mapping.source, projectRoot) });
    byLine.set(line, list);
  }
  const attributed = new Map();
  const lines = splitGeneratedLines(code);
  lines.forEach((line, index) => {
    const rawPoints = (byLine.get(index + 1) || []).sort((a, b) => a.column - b.column);
    const points = [];
    for (const point of rawPoints) {
      const column = Math.max(0, Math.min(line.text.length, point.column));
      if (points.length && points[points.length - 1].column === column) points[points.length - 1] = { ...point, column };
      else points.push({ ...point, column });
    }
    let cursor = 0;
    let lastSource = '<unmapped>';
    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
      const point = points[pointIndex];
      if (point.column > cursor) addBytes(attributed, lastSource, Buffer.byteLength(line.text.slice(cursor, point.column)));
      const nextColumn = points[pointIndex + 1]?.column ?? line.text.length;
      lastSource = point.source || '<unmapped>';
      addBytes(attributed, lastSource, Buffer.byteLength(line.text.slice(point.column, nextColumn)));
      cursor = nextColumn;
    }
    if (points.length === 0) addBytes(attributed, '<unmapped>', Buffer.byteLength(line.text));
    else if (cursor < line.text.length) addBytes(attributed, lastSource, Buffer.byteLength(line.text.slice(cursor)));
    addBytes(attributed, lastSource, Buffer.byteLength(line.newline));
  });
  return attributed;
}

function analyzeDirectory({ directory, projectRoot, traceMapping, include, exclude }) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`Missing output directory: ${directory}`);
  const { TraceMap, eachMapping } = traceMapping;
  const sources = new Map();
  const assets = [];
  const dataQuality = [];
  for (const asset of walkJsFiles(directory, include, exclude)) {
    const code = readFileSync(asset, 'utf8');
    const mapRecord = parseSourceMap(code, asset);
    let attributed;
    if (!mapRecord) {
      attributed = new Map([['<unmapped>', Buffer.byteLength(code)]]);
      dataQuality.push({ type: 'missing-source-map', asset: relative(directory, asset) });
    } else {
      try {
        const trace = new TraceMap(mapRecord.map, mapRecord.mapPath);
        const mappings = [];
        eachMapping(trace, (mapping) => mappings.push(mapping));
        attributed = attributeCode(code, mappings, projectRoot);
      } catch (error) {
        attributed = new Map([['<unmapped>', Buffer.byteLength(code)]]);
        dataQuality.push({ type: 'invalid-source-map', asset: relative(directory, asset), error: error.message });
      }
    }
    const rawBytes = Buffer.byteLength(code);
    const attributedBytes = [...attributed.values()].reduce((sum, value) => sum + value, 0);
    if (attributedBytes !== rawBytes) dataQuality.push({ type: 'attribution-byte-mismatch', asset: relative(directory, asset), rawBytes, attributedBytes });
    for (const [source, bytes] of attributed) addBytes(sources, source, bytes);
    assets.push({
      asset: relative(directory, asset).replace(/\\/g, '/'),
      rawBytes,
      gzipBytes: gzipSync(Buffer.from(code)).length,
      sourceMap: mapRecord?.mapPath || null,
      mappedBytes: rawBytes - (attributed.get('<unmapped>') || 0),
      unmappedBytes: attributed.get('<unmapped>') || 0,
    });
  }
  return {
    directory,
    rawBytes: assets.reduce((sum, asset) => sum + asset.rawBytes, 0),
    gzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    mappedBytes: [...sources.entries()].filter(([source]) => source !== '<unmapped>').reduce((sum, [, bytes]) => sum + bytes, 0),
    unmappedBytes: sources.get('<unmapped>') || 0,
    assets,
    sources: Object.fromEntries([...sources.entries()].sort((a, b) => b[1] - a[1])),
    dataQuality,
  };
}

function compareAnalyses(baseline, experiment) {
  const names = new Set([...Object.keys(baseline.sources), ...Object.keys(experiment.sources)]);
  const sources = [...names].map((source) => {
    const baselineBytes = baseline.sources[source] || 0;
    const experimentBytes = experiment.sources[source] || 0;
    const deltaBytes = experimentBytes - baselineBytes;
    const classification = baselineBytes > 0 && experimentBytes === 0 ? 'removed'
      : baselineBytes === 0 && experimentBytes > 0 ? 'added'
        : deltaBytes < 0 ? 'shrunk'
          : deltaBytes > 0 ? 'grown'
            : 'unchanged';
    return { source, baselineBytes, experimentBytes, deltaBytes, savedBytes: baselineBytes - experimentBytes, classification };
  }).sort((a, b) => b.savedBytes - a.savedBytes || a.source.localeCompare(b.source));
  return {
    rawDeltaBytes: experiment.rawBytes - baseline.rawBytes,
    gzipDeltaBytes: experiment.gzipBytes - baseline.gzipBytes,
    sources,
  };
}

function selfTest() {
  const code = 'const a = 1;\nconsole.log(a);\n';
  const attributed = attributeCode(code, [
    { generatedLine: 1, generatedColumn: 0, source: '/project/src/a.js' },
    { generatedLine: 2, generatedColumn: 0, source: '/project/src/b.js' },
  ], '/project');
  const total = [...attributed.values()].reduce((sum, value) => sum + value, 0);
  if (total !== Buffer.byteLength(code) || !attributed.has('src/a.js') || !attributed.has('src/b.js')) throw new Error('self-test assertion failed');
  console.log('sourcemap-generated-byte-attribution self-test passed');
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const projectRoot = resolve(args['project-root'] || process.cwd());
  const baselineDir = resolve(args['baseline-dir'] || 'baseline');
  const experimentDir = resolve(args['experiment-dir'] || 'experiment');
  const outPath = resolve(args.out || 'generated-byte-attribution.json');
  const include = args.include ? new RegExp(args.include) : null;
  const exclude = args.exclude ? new RegExp(args.exclude) : null;
  const traceMapping = resolveTraceMapping(projectRoot);
  const baseline = analyzeDirectory({ directory: baselineDir, projectRoot, traceMapping, include, exclude });
  const experiment = analyzeDirectory({ directory: experimentDir, projectRoot, traceMapping, include, exclude });
  const comparison = compareAnalyses(baseline, experiment);
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    metric: 'actual generated UTF-8 bytes attributed by source-map segment spans',
    warning: 'Total raw/gzip deltas are exact for included assets; per-source attribution depends on source-map completeness and is causal evidence, not a standalone saving claim.',
    baseline,
    experiment,
    comparison,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  const mdPath = outPath.replace(/\.json$/i, '') + '.md';
  const markdown = [
    '# Generated-Byte Attribution', '',
    `Raw delta: ${comparison.rawDeltaBytes} B`, '',
    `Gzip delta: ${comparison.gzipDeltaBytes} B`, '',
    '> Per-source rows depend on source-map quality; raw/gzip totals are the actual included asset sizes.', '',
    '| source | baseline | experiment | delta | saved | class |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...comparison.sources.map((row) => `| ${row.source.replace(/\|/g, '\\|')} | ${row.baselineBytes} | ${row.experimentBytes} | ${row.deltaBytes} | ${row.savedBytes} | ${row.classification} |`),
  ].join('\n');
  writeFileSync(mdPath, markdown + '\n');
  console.log(`rawDeltaBytes=${comparison.rawDeltaBytes} gzipDeltaBytes=${comparison.gzipDeltaBytes}`);
  console.log(`wrote ${outPath}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { analyzeDirectory, attributeCode, compareAnalyses, normalizeSource, parseSourceMap, splitGeneratedLines };
