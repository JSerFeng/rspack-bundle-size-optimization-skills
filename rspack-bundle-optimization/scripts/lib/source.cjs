const { AnyMap, originalPositionFor, GREATEST_LOWER_BOUND } = require('@jridgewell/trace-mapping');
const { parse } = require('@babel/parser');
const { hash } = require('./common.cjs');

function parseLocation(raw, base = 1) {
  if (raw && typeof raw === 'object') {
    const valid = point => point && Number.isSafeInteger(point.line) && point.line >= 1 && Number.isSafeInteger(point.column) && point.column >= 0;
    if (!valid(raw.start) || (raw.end && (!valid(raw.end) || raw.end.line < raw.start.line || (raw.end.line === raw.start.line && raw.end.column <= raw.start.column)))) return null;
    return { start: raw.start, end: raw.end || null };
  }
  const match = typeof raw === 'string' && /^(\d+):(\d+)(?:-(?:(\d+):)?(\d+))?$/.exec(raw.trim());
  if (!match) return null;
  const start = { line: Number(match[1]), column: Number(match[2]) - base };
  const end = match[4] === undefined ? null : {
    line: match[3] ? Number(match[3]) : start.line, column: Number(match[4]) - base,
  };
  if (!Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.column) || start.line < 1 || start.column < 0 || (end && (!Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.column) || end.column < 0 ||
    end.line < start.line || (end.line === start.line && end.column <= start.column)))) return null;
  return { start, end };
}

function offset(content, point) {
  if (!point) return null;
  let start = 0;
  for (let line = 1; line < point.line; line++) {
    const next = content.indexOf('\n', start);
    if (next < 0) return null;
    start = next + 1;
  }
  const next = content.indexOf('\n', start);
  let end = next < 0 ? content.length : next;
  if (end > start && content[end - 1] === '\r') end--;
  return point.column >= 0 && start + point.column <= end ? start + point.column : null;
}

function boundedLines(content, line, context = 3) {
  const lines = content.split('\n');
  const from = Math.max(1, line - context);
  const to = Math.min(lines.length, line + context);
  return { startLine: from, endLine: to, totalLines: lines.length,
    lines: lines.slice(from - 1, to).map((text, i) => ({ line: from + i,
      text: text.slice(0, 500), truncated: text.length > 500 })) };
}

function syntax(content, sourcePath) {
  return parse(content, { sourceType: 'unambiguous', plugins: [
    ...(/\.[cm]?tsx?(?:$|[?#])/.test(sourcePath) ? ['typescript'] : []), 'jsx', 'decorators-legacy',
  ] });
}

function owners(content, sourcePath, location) {
  if (content.length > 2 * 1024 * 1024) return { ownerChain: [], astGap: 'AST ownership unavailable above the 2 MiB parsing budget' };
  const start = offset(content, location.start);
  const end = location.end ? offset(content, location.end) : start;
  if (start === null || end === null) return { ownerChain: [], astGap: 'Location outside source' };
  try {
    const ast = syntax(content, sourcePath);
    const chain = [];
    const visit = (node, parent) => {
      if (!node || typeof node.type !== 'string' || node.start > start || node.end < end) return;
      if (/Function|Method|Class/.test(node.type) && !/ClassBody|ClassProperty/.test(node.type)) {
        const name = node.id?.name || node.key?.name || node.key?.value ||
          (parent?.type === 'VariableDeclarator' ? parent.id?.name : null) ||
          (parent?.type === 'ExportDefaultDeclaration' ? 'default' : null) ||
          (parent?.type === 'CallExpression' ? `${parent.callee?.name || parent.callee?.property?.name || 'call'} callback` : '<anonymous>');
        chain.push({ kind: node.type, name, start: { line: node.loc.start.line, column: node.loc.start.column } });
      }
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'tokens', 'comments', 'errors'].includes(key)) continue;
        if (Array.isArray(value)) { for (const child of value) visit(child, node); }
        else if (value && typeof value === 'object') visit(value, node);
      }
    };
    visit(ast, null);
    return { ownerChain: chain, astGap: null };
  } catch (error) { return { ownerChain: [], astGap: error.message }; }
}

function candidate(content, path, location, space, precision, estimated, context) {
  const start = offset(content, location.start);
  const end = location.end ? offset(content, location.end) : null;
  if (start === null || (location.end && (end === null || end <= start))) return null;
  return { sourcePath: path, sourceHash: hash(content), coordinateSpace: space,
    sourceLocation: location, locationPrecision: precision, endEstimated: estimated,
    excerpt: boundedLines(content, location.start.line, context),
    // Preserve a window around a late column in minified/long source lines.
    focus: { text: content.slice(Math.max(0, start - 100), Math.min(content.length, (end ?? start + 1) + 100)).slice(0, 1000),
      startOffset: Math.max(0, start - 100), truncated: (end ?? start + 1) + 100 - Math.max(0, start - 100) > 1000 },
    ...owners(content, path, location) };
}

function mapReference(module, rawLoc, options = {}) {
  const normalizedLoc = parseLocation(rawLoc, options.columnBase ?? 1);
  const base = { rawLoc, normalizedLoc, relationPrecision: 'native', candidates: [] };
  if (!normalizedLoc) return { ...base, locationPrecision: 'unavailable', gap: 'Missing or invalid dependency location' };
  const context = options.context ?? 3;
  const space = options.space || 'auto';
  const candidates = [];
  const gaps = [];
  if (space !== 'post-loader' && module.resource_content !== null) {
    const direct = candidate(module.resource_content, module.resource || module.identifier, normalizedLoc,
      'resource', normalizedLoc.end ? 'exact' : 'approximate', !normalizedLoc.end, context);
    if (direct) candidates.push(direct);
  }
  if (space !== 'resource' && module.source_map && module.transformed !== null) {
    try {
      if (offset(module.transformed, normalizedLoc.start) === null) throw new Error('Location outside post-loader text');
      const trace = AnyMap(JSON.parse(module.source_map));
      const lookup = point => originalPositionFor(trace, { ...point, bias: GREATEST_LOWER_BOUND });
      const start = lookup(normalizedLoc.start);
      if (start.source === null || start.line === null || start.column === null) throw new Error('Unmapped start segment');
      const index = trace.resolvedSources.indexOf(start.source);
      const content = trace.sourcesContent?.[index];
      if (typeof content !== 'string') throw new Error('Mapped source content unavailable');
      const mappedStart = { line: start.line, column: start.column };
      const end = normalizedLoc.end ? lookup(normalizedLoc.end) : null;
      const forwardEnd = end?.source === start.source && end.line !== null && end.column !== null &&
        (end.line > start.line || (end.line === start.line && end.column > start.column));
      const location = { start: mappedStart, end: forwardEnd ? { line: end.line, column: end.column } : null };
      // Point mappings alone cannot prove an exact lexical range, even with two mapped endpoints.
      const mapped = candidate(content, start.source, location, 'map-source', 'approximate', !forwardEnd, context);
      if (mapped) candidates.push(mapped); else gaps.push('Mapped range outside source content');
    } catch (error) { gaps.push(error.message); }
  }
  if (space !== 'resource' && !module.source_map && module.transformed !== null &&
      (space === 'post-loader' || module.resource_content === null || module.resource_content !== module.transformed)) {
    const transformed = candidate(module.transformed, module.identifier, normalizedLoc,
      'post-loader', 'approximate', !normalizedLoc.end, context);
    if (transformed) candidates.push({ ...transformed, gap: 'No loader source map; showing post-loader text' });
  }
  const resourceHash = module.resource_content === null ? null : hash(module.resource_content);
  const transformedHash = module.transformed === null ? null : hash(module.transformed);
  for (const item of candidates) {
    item.sourceIdentity = {
      matchesCapturedResource: resourceHash !== null && item.sourceHash === resourceHash,
      matchesPostLoader: transformedHash !== null && item.sourceHash === transformedHash,
    };
    // Some loader chains replace the original map with an identity map of their
    // output, retaining a .ts/.tsx source name. A mapped position in that text
    // must not be presented as a verified position in the original resource.
    if (item.coordinateSpace === 'map-source' && item.sourceIdentity.matchesPostLoader &&
        resourceHash !== null && !item.sourceIdentity.matchesCapturedResource && !item.gap) {
      item.gap = 'Loader map points to post-loader text; mapping to the captured resource is unavailable';
    }
  }
  const unique = [...new Map(candidates.map(item => [JSON.stringify([item.sourcePath, item.sourceHash, item.sourceLocation]), item])).values()];
  if (!unique.length) return { ...base, locationPrecision: 'unavailable', gap: gaps.join('; ') || 'Source or mapping unavailable' };
  if (space === 'auto') {
    // Rspack can attach a line-only identity map even without a loader transform.
    // When both texts and source identity agree, the raw columns are better
    // evidence than tracing them back to the beginning of that same line.
    const direct = candidates.find(item => item.coordinateSpace === 'resource');
    if (direct && module.resource_content === module.transformed && candidates.every(item =>
      item.sourcePath === direct.sourcePath && item.sourceHash === direct.sourceHash)) {
      return { ...base, ...direct, mappingGaps: gaps, gap: null };
    }
    // No map is not proof that a transforming loader preserved resource coordinates.
    const identical = !module.source_map && module.resource_content !== null && module.resource_content === module.transformed;
    if (unique.length > 1 || (!identical && module.resource_content !== null && module.resource_content !== module.transformed)) {
      return { ...base, candidates: unique, locationPrecision: 'unavailable',
        gap: 'Coordinate space unverified; inspect candidates then query with --space resource or post-loader', mappingGaps: gaps };
    }
  }
  return { ...base, ...unique[0], mappingGaps: gaps, gap: unique[0].gap || null };
}

module.exports = { parseLocation, offset, boundedLines, mapReference, owners };

const { fail, openRead, decode, json, integer } = require('./common.cjs');
const { readDetail, sourcePathForContext } = require('./adapters/coverage.cjs');

function loadSource(row, mapSource) {
  const locator = JSON.parse(row.locator);
  let text; let sourceMap = null; let detail = null;
  if (locator.adapter === 'coverage-detail') {
    detail = readDetail(locator.file, locator.location);
    if (detail.id !== locator.originalId) fail('INPUT_CHANGED', 'Coverage source identity changed.');
    text = detail.content;
  } else {
    const db = openRead(locator.file);
    try {
      if (locator.adapter === 'usage') {
        const value = db.prepare('SELECT transformed,source_map,resource_content FROM modules WHERE id=?').get(locator.module);
        text = row.space === 'resource' ? value?.resource_content : value?.transformed;
        sourceMap = value?.source_map ?? null;
      } else if (locator.adapter === 'coverage-module') {
        const value = db.prepare('SELECT payload FROM export_modules WHERE id=?').get(locator.module);
        const module = value ? decode(value.payload) : null;
        text = module?.transformedSource;
        sourceMap = module?.sourceMap ? json(module.sourceMap) : null;
      } else fail('INVALID_INDEX', 'Unknown source storage adapter.');
    } finally { db.close(); }
  }
  let sourcePath = row.path; let space = row.space;
  if (mapSource !== undefined) {
    if (!sourceMap) fail('SOURCE_UNAVAILABLE', 'No captured loader source map is available.');
    const trace = AnyMap(JSON.parse(sourceMap));
    const index = trace.resolvedSources.indexOf(mapSource);
    if (index < 0) fail('SOURCE_UNAVAILABLE', 'Unknown map source.', { sources: trace.resolvedSources.slice(0, 20), total: trace.resolvedSources.length });
    text = trace.sourcesContent?.[index]; sourcePath = mapSource; space = 'map-source';
  }
  if (typeof text !== 'string') fail('SOURCE_UNAVAILABLE', 'Captured source text is unavailable.', { sourceId: row.id, coordinateSpace: space });
  if (mapSource === undefined && row.hash && hash(text) !== row.hash) fail('INPUT_CHANGED', 'Captured source hash changed.');
  return { text, sourceMap, detail, path: sourcePath, space, hash: hash(text) };
}

function sourceWindow(value, args, fallbackLine = 1, fallbackColumn = 0) {
  const line = integer(args.line, fallbackLine, Number.MAX_SAFE_INTEGER, 1);
  const column = integer(args.column, fallbackColumn);
  const characters = integer(args.characters, 4000, 12000, 1);
  const lines = value.text.split('\n');
  if (line > lines.length || column > lines[line - 1].length) fail('INVALID_ARGUMENT', 'Requested window is outside captured source.');
  const from = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column;
  let content = value.text.slice(from, from + characters);
  // UTF-8 response bytes can be much larger than UTF-16 coordinates.
  const byteBudget = args.byteBudget ?? 12 * 1024;
  while (Buffer.byteLength(content) > byteBudget) content = content.slice(0, Math.max(1, Math.floor(content.length * 0.8)));
  const parts = content.split('\n');
  let nextLine = line; let nextColumn = column;
  for (const char of content) {
    if (char === '\n') { nextLine++; nextColumn = 0; }
    else nextColumn += char.length;
  }
  const next = from + content.length < value.text.length ? { line: nextLine, column: nextColumn } : null;
  return { path: value.path, sourceHash: value.hash, coordinateSpace: value.space, coordinateUnit: 'UTF-16',
    start: { line, column }, content, totalCharacters: value.text.length, totalLines: lines.length,
    end: { line: nextLine, column: nextColumn }, next, truncated: next !== null,
    lines: parts.length };
}

function sourceRow(ctx, sourceId) {
  const row = ctx.db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
  if (!row) fail('SOURCE_UNAVAILABLE', 'Unknown source ID. Get source IDs from module detail.');
  if (ctx.args.module && !ctx.db.prepare('SELECT 1 FROM module_sources WHERE module_id=? AND source_id=?').get(ctx.args.module, sourceId))
    fail('INVALID_ARGUMENT', 'This source does not belong to the requested module.');
  return row;
}

function referenceWindow(value, args, location) {
  const context = integer(args.context, 3, 10);
  let line = Math.max(1, location.start.line - context); let column = 0;
  const start = offset(value.text, { line, column }); const focus = offset(value.text, location.start);
  const characters = integer(args.characters, 4000, 12000, 1);
  if (focus - start > characters / 2 || Buffer.byteLength(value.text.slice(start, focus)) > 3000) {
    line = location.start.line; column = Math.max(0, location.start.column - Math.min(100, Math.floor(characters / 4)));
  }
  return sourceWindow(value, { ...args, byteBudget: 6 * 1024 }, line, column);
}

function reference(ctx, edge) {
  if (ctx.args.space !== undefined && !['auto', 'resource', 'post-loader'].includes(ctx.args.space)) fail('INVALID_ARGUMENT', '--space must be auto, resource, or post-loader.');
  if (edge.adapter !== 'usage' && (ctx.args.space !== undefined || ctx.args['column-base'] !== undefined))
    fail('INVALID_ARGUMENT', 'Coverage references already have normalized coordinates; --space and --column-base apply to standalone usage captures.');
  const raw = JSON.parse(edge.raw_loc);
  const sourceLocation = JSON.parse(edge.source_loc);
  const sourceRows = ctx.db.prepare('SELECT s.* FROM sources s JOIN module_sources ms ON s.id=ms.source_id WHERE ms.module_id=?').all(edge.origin);
  const usageSource = sourceRows.find(row => JSON.parse(row.locator).adapter === 'usage' && row.space === 'post-loader');
  if (edge.adapter === 'usage' && usageSource) {
    const locator = JSON.parse(usageSource.locator); const db = openRead(locator.file);
    let module;
    try { module = db.prepare('SELECT identifier,resource,transformed,source_map,resource_content FROM modules WHERE id=?').get(locator.module); }
    finally { db.close(); }
    if (!module) fail('SOURCE_UNAVAILABLE', 'Captured consumer module is missing.');
    const result = mapReference(module, raw, { context: integer(ctx.args.context, 3, 10), columnBase: integer(ctx.args['column-base'], ctx.meta.graphColumnBase ?? 1, 1), space: ctx.args.space || ctx.meta.graphLocationSpace || 'auto' });
    const attach = candidate => {
      const row = candidate.coordinateSpace === 'resource'
        ? sourceRows.find(row => row.space === 'resource' && JSON.parse(row.locator).adapter === 'usage') : usageSource;
      const mapSource = candidate.coordinateSpace === 'map-source' ? candidate.sourcePath : undefined;
      const value = loadSource(row, mapSource);
      const { excerpt, focus, ...metadata } = candidate;
      return { ...metadata, window: referenceWindow(value, ctx.args, candidate.sourceLocation),
        sourceQuery: { source: row.id, ...(mapSource === undefined ? {} : { 'map-source': mapSource }) } };
    };
    if (result.sourceHash) return attach(result);
    return { ...result, candidates: result.candidates.map(attach) };
  }
  const canonical = value => typeof value === 'string' && !value.includes('://') ? require('node:path').resolve(ctx.meta.context, value) : value;
  const candidates = sourceLocation && edge.source_path ? sourceRows.filter(row => row.space === 'resource' &&
    (canonical(row.path) === canonical(edge.source_path) || (JSON.parse(row.locator).adapter === 'coverage-detail' &&
      sourcePathForContext(row.path, ctx.meta.context) === sourcePathForContext(edge.source_path, ctx.meta.context)))) : [];
  const original = candidates.length === 1 ? candidates[0] : null;
  const selected = original || sourceRows.find(row => row.space === 'post-loader');
  if (!selected) return { rawLocation: raw, locationPrecision: 'unavailable', gap: 'Consumer source was not captured.' };
  let value;
  try { value = loadSource(selected); }
  catch (error) {
    if (error.code !== 'SOURCE_UNAVAILABLE') throw error;
    return { rawLocation: raw, locationPrecision: 'unavailable', gap: error.message };
  }
  const location = parseLocation(original ? sourceLocation : raw, 0);
  if (!location || offset(value.text, location.start) === null) return { rawLocation: raw, locationPrecision: 'unavailable', gap: 'Captured location cannot be placed in captured source.', sourceId: selected.id };
  return { rawLocation: raw, sourceId: selected.id, sourceLocation: location,
    locationPrecision: original ? 'captured-source-location' : 'post-loader',
    window: referenceWindow(value, ctx.args, location),
    ...owners(value.text, value.path, location), gap: original ? null : 'Showing captured post-loader coordinates; original-source mapping is unavailable.' };
}
module.exports = { ...module.exports, loadSource, sourceWindow, sourceRow, reference };
