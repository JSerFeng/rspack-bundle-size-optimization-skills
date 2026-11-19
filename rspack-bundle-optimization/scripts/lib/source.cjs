const path = require('node:path');
const { AnyMap, originalPositionFor, GREATEST_LOWER_BOUND } = require('@jridgewell/trace-mapping');
const { parse } = require('@babel/parser');
const { fail, hash, openRead, integer, displayPath } = require('./common.cjs');
const { sourcePathForContext, canonicalSource } = require('./coverage.cjs');

function createSession() {
  const dbs = new Map();
  const modules = new Map();
  const maps = new Map();
  const asts = new Map();
  return {
    openDb(file) {
      if (!dbs.has(file)) dbs.set(file, openRead(file));
      return dbs.get(file);
    },
    getModule(file, moduleId) {
      const key = `${file}\0${moduleId}`;
      if (!modules.has(key)) {
        const db = this.openDb(file);
        modules.set(key, db.prepare('SELECT identifier,resource,transformed,source_map,resource_content FROM modules WHERE id=?').get(moduleId) || null);
      }
      return modules.get(key);
    },
    getMap(sourceMapStr) {
      const key = hash(sourceMapStr);
      if (!maps.has(key)) maps.set(key, AnyMap(JSON.parse(sourceMapStr)));
      return maps.get(key);
    },
    asts,
    close() {
      for (const db of dbs.values()) { try { db.close(); } catch {} }
      dbs.clear();
    },
  };
}

function parseLocation(raw, base = 1) {
  if (raw && typeof raw === 'object') {
    const valid = point => point && Number.isSafeInteger(point.line) && point.line >= 1 && Number.isSafeInteger(point.column) && point.column >= 0;
    if (!valid(raw.start) || (raw.end && (!valid(raw.end) || raw.end.line < raw.start.line || (raw.end.line === raw.start.line && raw.end.column <= raw.start.column)))) return null;
    const shift = base === 1 && raw.start.column >= 1 && (!raw.end || raw.end.column >= 1) ? 1 : 0;
    return {
      start: { line: raw.start.line, column: raw.start.column - shift },
      end: raw.end ? { line: raw.end.line, column: raw.end.column - shift } : null,
    };
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

function boundedLines(content, line, context = 3, maxLineLen = 300, location = null) {
  const lines = content.split('\n');
  const from = Math.max(1, line - context);
  const to = Math.min(lines.length, line + context);
  return {
    startLine: from, endLine: to, totalLines: lines.length,
    lines: lines.slice(from - 1, to).map((raw, i) => {
      const lineNo = from + i;
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      // If this is the focus line and the column is far into a minified/long line, center around the column.
      if (location && lineNo === location.start.line && text.length > maxLineLen && location.start.column > maxLineLen - 60) {
        const winStart = Math.max(0, location.start.column - Math.floor(maxLineLen / 3));
        const slice = text.slice(winStart, winStart + maxLineLen);
        return { line: lineNo, text: slice, columnOffset: winStart, truncated: true };
      }
      return { line: lineNo, text: text.slice(0, maxLineLen), columnOffset: 0, truncated: text.length > maxLineLen };
    }),
  };
}

function syntax(content, sourcePath) {
  return parse(content, { sourceType: 'unambiguous', plugins: [
    ...(/\.[cm]?tsx?(?:$|[?#])/.test(sourcePath) ? ['typescript'] : []), 'jsx', 'decorators-legacy',
  ] });
}

function owners(content, sourcePath, location, astCache = null) {
  if (content.length > 2 * 1024 * 1024) return { ownerChain: [], astGap: 'AST ownership unavailable above the 2 MiB parsing budget' };
  const start = offset(content, location.start);
  const end = location.end ? offset(content, location.end) : start;
  if (start === null || end === null) return { ownerChain: [], astGap: 'Location outside source' };
  try {
    const cacheKey = astCache ? `${hash(content)}:${/\.[cm]?tsx?(?:$|[?#])/.test(sourcePath) ? 'ts' : 'js'}` : null;
    let ast;
    if (astCache && astCache.has(cacheKey)) {
      const cached = astCache.get(cacheKey);
      if (cached.error) return { ownerChain: [], astGap: cached.error };
      ast = cached.ast;
    } else {
      try {
        ast = syntax(content, sourcePath);
        if (astCache) astCache.set(cacheKey, { ast });
      } catch (error) {
        if (astCache) astCache.set(cacheKey, { error: error.message });
        return { ownerChain: [], astGap: error.message };
      }
    }
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

function candidate(content, sourcePath, location, space, precision, estimated, context, session = null) {
  const start = offset(content, location.start);
  const end = location.end ? offset(content, location.end) : null;
  if (start === null || (location.end && (end === null || end <= start))) return null;
  return { sourcePath, sourceHash: hash(content), coordinateSpace: space,
    sourceLocation: location, locationPrecision: precision, endEstimated: estimated,
    excerpt: boundedLines(content, location.start.line, context, 300, location),
    focus: { text: content.slice(Math.max(0, start - 100), Math.min(content.length, (end ?? start + 1) + 100)).slice(0, 1000),
      startOffset: Math.max(0, start - 100), truncated: (end ?? start + 1) + 100 - Math.max(0, start - 100) > 1000 },
    ...owners(content, sourcePath, location, session?.asts || null) };
}

function mapReference(module, rawLoc, options = {}) {
  const normalizedLoc = parseLocation(rawLoc, options.columnBase ?? 1);
  const base = { rawLocation: rawLoc, normalizedLoc, relationPrecision: 'native', candidates: [] };
  if (!normalizedLoc) return { ...base, locationPrecision: 'unavailable', gap: 'Missing or invalid dependency location' };
  const context = options.context ?? 3;
  const space = options.space || 'auto';
  const session = options.session || null;
  const candidates = [];
  const gaps = [];
  const identicalText = module.resource_content !== null && module.transformed !== null && module.resource_content === module.transformed;

  // When space is 'post-loader' and texts are identical, the post-loader coordinates are directly valid in resource.
  if ((space !== 'post-loader' || identicalText) && module.resource_content !== null) {
    const direct = candidate(module.resource_content, module.resource || module.identifier, normalizedLoc,
      'resource', normalizedLoc.end ? 'exact' : 'approximate', !normalizedLoc.end, context, session);
    if (direct) candidates.push(direct);
  }
  if (space !== 'resource' && !(space === 'post-loader' && identicalText) && module.source_map && module.transformed !== null) {
    try {
      if (offset(module.transformed, normalizedLoc.start) === null) throw new Error('Location outside post-loader text');
      const trace = session ? session.getMap(module.source_map) : AnyMap(JSON.parse(module.source_map));
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
      const mapped = candidate(content, start.source, location, 'map-source', 'approximate', !forwardEnd, context, session);
      if (mapped) candidates.push(mapped); else gaps.push('Mapped range outside source content');
    } catch (error) { gaps.push(error.message); }
  }
  // Fallback to raw post-loader text when no loader map exists OR when space === 'post-loader' and map lookup failed.
  if (space !== 'resource' && module.transformed !== null &&
      ((!module.source_map && (space === 'post-loader' || module.resource_content === null || !identicalText)) ||
       (space === 'post-loader' && !candidates.length))) {
    const transformed = candidate(module.transformed, module.identifier, normalizedLoc,
      'post-loader', 'approximate', !normalizedLoc.end, context, session);
    if (transformed) {
      const reason = !module.source_map
        ? 'No loader source map; showing post-loader text'
        : `Loader source map lookup failed (${gaps.join('; ')}); showing post-loader text`;
      candidates.push({ ...transformed, gap: reason });
    }
  }
  const resourceHash = module.resource_content === null ? null : hash(module.resource_content);
  const transformedHash = module.transformed === null ? null : hash(module.transformed);
  for (const item of candidates) {
    item.sourceIdentity = {
      matchesCapturedResource: resourceHash !== null && item.sourceHash === resourceHash,
      matchesPostLoader: transformedHash !== null && item.sourceHash === transformedHash,
    };
    if (item.coordinateSpace === 'map-source' && item.sourceIdentity.matchesPostLoader &&
        resourceHash !== null && !item.sourceIdentity.matchesCapturedResource) {
      if (!item.gap) item.gap = 'Loader map points to post-loader text; mapping to the captured resource is unavailable';
      // Line-only identity loader maps collapse exact post-loader columns to 0; preserve the exact
      // post-loader column span on the same line while keeping the explicit mapping gap warning.
      if (item.sourceLocation.start.line === normalizedLoc.start.line &&
          item.sourceLocation.start.column === 0 && normalizedLoc.start.column > 0 &&
          module.transformed !== null) {
        const exact = candidate(module.transformed, item.sourcePath, normalizedLoc, 'map-source', 'approximate', !normalizedLoc.end, context, session);
        if (exact) Object.assign(item, exact, { sourceIdentity: item.sourceIdentity, gap: item.gap });
      }
    }
  }
  const unique = [...new Map(candidates.map(item => [JSON.stringify([item.sourcePath, item.sourceHash, item.sourceLocation]), item])).values()];
  if (!unique.length) return { ...base, locationPrecision: 'unavailable', gap: gaps.join('; ') || 'Source or mapping unavailable' };
  if (space === 'auto') {
    const direct = candidates.find(item => item.coordinateSpace === 'resource');
    if (direct && identicalText && candidates.every(item =>
      item.sourcePath === direct.sourcePath && item.sourceHash === direct.sourceHash)) {
      return { ...base, ...direct, mappingGaps: gaps, gap: null };
    }
    const identical = !module.source_map && identicalText;
    if (unique.length > 1 || (!identical && module.resource_content !== null && !identicalText)) {
      return { ...base, candidates: unique, locationPrecision: 'unavailable',
        gap: 'Coordinate space unverified; inspect candidates then query with --space resource or post-loader', mappingGaps: gaps };
    }
  }
  return { ...base, ...unique[0], mappingGaps: gaps, gap: unique[0].gap || null };
}

function loadSource(row, mapSource, ctxDb = null, session = null) {
  const locator = JSON.parse(row.locator);
  let text; let sourceMap = null; let detail = null;
  if (locator.adapter === 'inline-source') {
    if (!ctxDb) fail('SOURCE_UNAVAILABLE', 'Inline source requires an open index database.');
    detail = ctxDb.prepare('SELECT content FROM source_contents WHERE source_id=?').get(row.id);
    if (!detail) fail('SOURCE_UNAVAILABLE', 'Analyzed inline source is unavailable.');
    text = detail.content;
  } else if (locator.adapter === 'coverage-source') {
    const db = session ? session.openDb(locator.file) : openRead(locator.file);
    try { detail = db.prepare('SELECT id,content FROM coverage_files WHERE id=?').get(locator.source); }
    finally { if (!session) db.close(); }
    if (!detail) fail('SOURCE_UNAVAILABLE', 'Analyzed source is unavailable.');
    text = detail.content;
  } else if (locator.adapter === 'usage') {
    const value = session ? session.getModule(locator.file, locator.module) : (() => {
      const db = openRead(locator.file);
      try { return db.prepare('SELECT transformed,source_map,resource_content FROM modules WHERE id=?').get(locator.module); }
      finally { db.close(); }
    })();
    text = row.space === 'resource' ? value?.resource_content : value?.transformed;
    sourceMap = value?.source_map ?? null;
  } else {
    fail('INVALID_INDEX', 'Unknown source storage adapter.');
  }
  let sourcePath = row.path; let space = row.space;
  if (mapSource !== undefined) {
    if (!sourceMap) fail('SOURCE_UNAVAILABLE', 'No captured loader source map is available.');
    const trace = session ? session.getMap(sourceMap) : AnyMap(JSON.parse(sourceMap));
    const index = trace.resolvedSources.indexOf(mapSource);
    if (index < 0) fail('SOURCE_UNAVAILABLE', 'Unknown map source.', { sources: trace.resolvedSources.slice(0, 20), total: trace.resolvedSources.length });
    text = trace.sourcesContent?.[index]; sourcePath = mapSource; space = 'map-source';
  }
  if (typeof text !== 'string') fail('SOURCE_UNAVAILABLE', 'Captured source text is unavailable.', { sourceId: row.id, coordinateSpace: space });
  if (mapSource === undefined && row.hash && hash(text) !== row.hash) fail('INPUT_CHANGED', 'Captured source hash changed.');
  return { text, sourceMap, detail, path: sourcePath, space, hash: hash(text) };
}

function sourceWindow(value, args, fallbackLine = 1, fallbackColumn = 0) {
  const line = integer(args.line, fallbackLine, Number.MAX_SAFE_INTEGER, 1, 'line');
  const column = integer(args.column, fallbackColumn, Number.MAX_SAFE_INTEGER, 0, 'column');
  const characters = integer(args.characters, 4000, 12000, 1, 'characters');
  const lines = value.text.split('\n');
  if (line > lines.length || column > lines[line - 1].length) fail('INVALID_ARGUMENT', 'Requested window is outside captured source.');
  const from = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column;
  let content = value.text.slice(from, from + characters);
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
  if (!row) fail('SOURCE_UNAVAILABLE', 'Unknown source ID. Inspect available sources with `module --module <moduleId>`.');
  if (ctx.args.module && !ctx.db.prepare('SELECT 1 FROM module_sources WHERE module_id=? AND source_id=?').get(ctx.args.module, sourceId))
    fail('INVALID_ARGUMENT', 'This source does not belong to the requested module.');
  return row;
}

function resolveModuleSource(ctx, moduleId) {
  if (ctx.args.source) return sourceRow(ctx, ctx.args.source);
  if (ctx.args.space !== undefined && !['resource', 'map-source', 'post-loader'].includes(ctx.args.space))
    fail('INVALID_ARGUMENT', '--space must be resource, map-source, or post-loader.');
  const rows = ctx.db.prepare(`
    SELECT s.*, (SELECT count(*) FROM coverage_lines cl WHERE cl.module_id=ms.module_id AND cl.source_id=s.id) AS cov_count
    FROM sources s JOIN module_sources ms ON s.id=ms.source_id
    WHERE ms.module_id=? ORDER BY s.id
  `).all(moduleId);
  if (!rows.length) fail('SOURCE_UNAVAILABLE', 'No captured source is associated with this module.');
  const requestedSpace = ctx.args.space;
  if (requestedSpace) {
    const matching = rows.filter(r => r.space === requestedSpace);
    if (!matching.length) fail('SOURCE_UNAVAILABLE', `No ${requestedSpace} source is captured for this module.`, { availableSpaces: [...new Set(rows.map(r => r.space))] });
    matching.sort((a, b) => (b.cov_count - a.cov_count) || a.id.localeCompare(b.id));
    return matching[0];
  }
  const rank = { resource: 0, 'map-source': 1, 'post-loader': 2 };
  rows.sort((a, b) => {
    const hasCovA = a.cov_count > 0 ? 0 : 1;
    const hasCovB = b.cov_count > 0 ? 0 : 1;
    if (hasCovA !== hasCovB) return hasCovA - hasCovB;
    const ra = rank[a.space] ?? 9; const rb = rank[b.space] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
  return rows[0];
}

function coverageSourceIds(ctx, value, moduleId = ctx.args.module) {
  if (!moduleId) return [];
  const canonical = canonicalSource(value.path, ctx.meta.context);
  return ctx.db.prepare('SELECT s.id,s.path,s.space,s.hash FROM sources s JOIN module_sources ms ON ms.source_id=s.id WHERE ms.module_id=?').all(moduleId)
    .filter(row => row.hash === value.hash && row.space === value.space && canonicalSource(row.path, ctx.meta.context) === canonical).map(row => row.id);
}

function referenceWindow(value, args, location) {
  const context = integer(args.context, 3, 10, 0, 'context');
  let line = Math.max(1, location.start.line - context); let column = 0;
  const start = offset(value.text, { line, column }); const focus = offset(value.text, location.start);
  const characters = integer(args.characters, 4000, 12000, 1, 'characters');
  if (focus - start > characters / 2 || Buffer.byteLength(value.text.slice(start, focus)) > 3000) {
    line = location.start.line; column = Math.max(0, location.start.column - Math.min(100, Math.floor(characters / 4)));
  }
  return sourceWindow(value, { ...args, byteBudget: 6 * 1024 }, line, column);
}

function reference(ctx, edge, options = {}) {
  const compact = Boolean(options.compact);
  const includeCode = options.includeCode !== false;
  const session = options.session || null;
  if (ctx.args.space !== undefined && !['auto', 'resource', 'post-loader'].includes(ctx.args.space))
    fail('INVALID_ARGUMENT', '--space must be auto, resource, or post-loader.');
  const raw = JSON.parse(edge.raw_loc);
  const sourceLocation = JSON.parse(edge.source_loc);
  const contextLines = options.context ?? integer(ctx.args.context, compact ? 1 : 3, 10, 0, 'context');
  const sourceRows = ctx.db.prepare('SELECT s.* FROM sources s JOIN module_sources ms ON s.id=ms.source_id WHERE ms.module_id=?').all(edge.origin);
  const usageSource = sourceRows.find(row => JSON.parse(row.locator).adapter === 'usage' && row.space === 'post-loader');

  if (usageSource) {
    const locator = JSON.parse(usageSource.locator);
    const module = session ? session.getModule(locator.file, locator.module) : (() => {
      const db = openRead(locator.file);
      try { return db.prepare('SELECT identifier,resource,transformed,source_map,resource_content FROM modules WHERE id=?').get(locator.module); }
      finally { db.close(); }
    })();
    if (!module) fail('SOURCE_UNAVAILABLE', 'Captured consumer module is missing.');
    const colBase = integer(ctx.args['column-base'], ctx.meta.graphColumnBase ?? 1, 1, 0, 'column-base');
    const spaceMode = ctx.args.space || ctx.meta.graphLocationSpace || 'auto';
    const result = mapReference(module, raw, { context: contextLines, columnBase: colBase, space: spaceMode, session });
    const attach = item => {
      let row = item.coordinateSpace === 'resource'
        ? (sourceRows.find(r => r.space === 'resource' && JSON.parse(r.locator).adapter === 'usage') || sourceRows.find(r => r.space === 'resource'))
        : usageSource;
      if (item.coordinateSpace === 'resource') row = sourceRows.find(value => value.space === 'resource' && value.hash === item.sourceHash &&
        ['coverage-source', 'inline-source'].includes(JSON.parse(value.locator).adapter) &&
        canonicalSource(value.path, ctx.meta.context) === canonicalSource(item.sourcePath, ctx.meta.context)) || row;
      const mapSource = item.coordinateSpace === 'map-source' ? item.sourcePath : undefined;
      const relPath = displayPath(item.sourcePath, ctx.meta.context);
      const { excerpt, focus, ...metadata } = item;
      const mapped = {
        ...metadata,
        sourcePath: relPath,
        ...(includeCode ? { snippet: excerpt } : {}),
      };
      if (!compact) {
        const value = loadSource(row, mapSource, ctx.db, session);
        mapped.window = referenceWindow(value, { ...ctx.args, context: String(contextLines) }, item.sourceLocation);
        mapped.sourceQuery = { command: 'source', module: edge.origin, source: row.id, ...(mapSource === undefined ? {} : { 'map-source': mapSource }) };
      }
      return mapped;
    };
    if (result.sourceHash) {
      const attached = attach(result);
      delete attached.candidates;
      return attached;
    }
    return { ...result, candidates: result.candidates.map(attach) };
  }

  const canonical = value => typeof value === 'string' && !value.includes('://') ? path.resolve(ctx.meta.context, value) : value;
  const candidates = sourceLocation && edge.source_path ? sourceRows.filter(row => row.space === 'resource' &&
    (canonical(row.path) === canonical(edge.source_path) || (['coverage-source', 'inline-source'].includes(JSON.parse(row.locator).adapter) &&
      sourcePathForContext(row.path, ctx.meta.context) === sourcePathForContext(edge.source_path, ctx.meta.context)))) : [];
  const original = candidates.length === 1 ? candidates[0] : null;
  const selected = original || sourceRows.find(row => row.space === 'post-loader') || sourceRows.find(row => row.space === 'resource');
  if (!selected) return { rawLocation: raw, locationPrecision: 'unavailable', gap: 'Consumer source was not captured.' };
  let value;
  try { value = loadSource(selected, undefined, ctx.db, session); }
  catch (error) {
    if (error.code !== 'SOURCE_UNAVAILABLE') throw error;
    return { rawLocation: raw, locationPrecision: 'unavailable', gap: error.message };
  }
  const location = parseLocation(original ? sourceLocation : raw, 0);
  if (!location || offset(value.text, location.start) === null) return { rawLocation: raw, locationPrecision: 'unavailable', gap: 'Captured location cannot be placed in captured source.', sourceId: selected.id };
  const snippet = includeCode ? boundedLines(value.text, location.start.line, contextLines, 300, location) : undefined;
  return {
    rawLocation: raw, sourceId: selected.id, sourcePath: displayPath(value.path, ctx.meta.context),
    coordinateSpace: selected.space, sourceLocation: location,
    locationPrecision: original ? 'captured-source-location' : selected.space,
    ...(snippet ? { snippet } : {}),
    ...(!compact ? { window: referenceWindow(value, { ...ctx.args, context: String(contextLines) }, location) } : {}),
    ...owners(value.text, value.path, location, session?.asts || null),
    gap: original || selected.space === 'resource' ? null : 'Showing captured post-loader coordinates; original-source mapping is unavailable.',
  };
}

module.exports = { createSession, parseLocation, offset, boundedLines, mapReference, owners, loadSource, sourceWindow, sourceRow, resolveModuleSource, reference, coverageSourceIds };
