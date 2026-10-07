const { AnyMap, originalPositionFor, GREATEST_LOWER_BOUND } = require('@jridgewell/trace-mapping');
const { parse } = require('@babel/parser');
const { hash } = require('./usage-store.cjs');

function parseLocation(raw, base = 1) {
  const match = typeof raw === 'string' && /^(\d+):(\d+)(?:-(?:(\d+):)?(\d+))?$/.exec(raw.trim());
  if (!match) return null;
  const start = { line: Number(match[1]), column: Number(match[2]) - base };
  const end = match[4] === undefined ? null : {
    line: match[3] ? Number(match[3]) : start.line, column: Number(match[4]) - base,
  };
  if (start.line < 1 || start.column < 0 || (end && (end.column < 0 ||
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
      const mapped = candidate(content, start.source, location, 'post-loader', 'approximate', !forwardEnd, context);
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
    if (item.coordinateSpace === 'post-loader' && item.sourceIdentity.matchesPostLoader &&
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
