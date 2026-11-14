const { AnyMap, decodedMappings } = require('@jridgewell/trace-mapping');
const { fileURLToPath } = require('node:url');
const { path, fail } = require('./common.cjs');

function canonicalSource(value, context) {
  let source = value.replaceAll('\\', '/');
  const loader = source.lastIndexOf('!'); if (loader >= 0) source = source.slice(loader + 1);
  if (source.startsWith('file://')) { try { source = fileURLToPath(source); } catch { return source; } }
  source = source.replace(/^(?:webpack|rspack):\/\/[^/]*\//, '').split(/[?#]/, 1)[0];
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) return source;
  if (/^[a-z]:\//i.test(source)) return path.win32.normalize(source).replaceAll('\\', '/');
  return path.resolve(context, source);
}
function sourcePathForContext(value, context) {
  const canonical = canonicalSource(value, context); const rel = path.relative(context, canonical);
  return !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel) ? rel || path.basename(canonical) : canonical;
}
function lineStarts(text) {
  const result = [0]; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) result.push(i + 1); return result;
}
function utf8Prefix(text) {
  const result = new Float64Array(text.length + 1); let bytes = 0;
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i); result[i] = bytes;
    if (code > 0xffff) { result[i + 1] = bytes; bytes += 4; result[i + 2] = bytes; i += 2; }
    else { bytes += code < 128 ? 1 : code < 2048 ? 2 : 3; result[i + 1] = bytes; i++; }
  }
  return result;
}
function mergeRanges(ranges, length) {
  const sorted = ranges.map(range => {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end > length)
      fail('INVALID_INPUT', 'Coverage range is outside its captured script (UTF-16, exclusive end).');
    return { start: range.start, end: range.end };
  }).filter(range => range.end > range.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const result = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push(range);
  }
  return result;
}
function coveredRanges(entry) {
  if (Array.isArray(entry.ranges)) return mergeRanges(entry.ranges, entry.text.length);
  if (!Array.isArray(entry.functions)) fail('INVALID_INPUT', 'Expected covered ranges or raw V8 functions with execution counts.');
  const ranges = entry.functions.flatMap(fn => fn.ranges || []).map(range => {
    const value = { start: range.startOffset, end: range.endOffset, count: range.count };
    mergeRanges([value], entry.text.length);
    if (!Number.isSafeInteger(value.count) || value.count < 0) fail('INVALID_INPUT', 'Invalid V8 execution count.');
    return value;
  }).filter(range => range.end > range.start).sort((a, b) => a.start - b.start || b.end - a.end);
  // The innermost block overrides an enclosing function/program counter.
  const points = [...new Set(ranges.flatMap(range => [range.start, range.end]))].sort((a, b) => a - b);
  const stack = []; const result = []; let cursor = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const point = points[i];
    while (stack.length && stack.at(-1).end <= point) stack.pop();
    while (cursor < ranges.length && ranges[cursor].start === point) {
      const range = ranges[cursor++];
      if (stack.length && range.end > stack.at(-1).end) fail('INVALID_INPUT', 'V8 coverage ranges cross instead of nesting.');
      stack.push(range);
    }
    if (stack.at(-1)?.count > 0) result.push({ start: point, end: points[i + 1] });
  }
  return mergeRanges(result, entry.text.length);
}
function* generatedSpans(text, rawMap) {
  const starts = lineStarts(text);
  if (!rawMap) { yield { start: 0, end: text.length, source: null }; return; }
  const trace = AnyMap(rawMap); const decoded = decodedMappings(trace);
  for (let line = 0; line < starts.length; line++) {
    const begin = starts[line]; const end = starts[line + 1] ?? text.length;
    let contentEnd = end;
    if (text.charCodeAt(contentEnd - 1) === 10) contentEnd--;
    if (text.charCodeAt(contentEnd - 1) === 13) contentEnd--;
    const segments = decoded[line] || []; let cursor = begin;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]; const start = begin + segment[0];
      if (!Number.isSafeInteger(start) || start < cursor || start > contentEnd) fail('INVALID_INPUT', 'Source-map segment is outside its generated line.');
      if (cursor < start) yield { start: cursor, end: start, source: null };
      const stop = Math.min(contentEnd, segments[i + 1] ? begin + segments[i + 1][0] : contentEnd);
      if (stop > start) {
        const source = segment.length >= 4 ? trace.resolvedSources[segment[1]] : null;
        if (segment.length >= 4 && (typeof source !== 'string' || segment[2] < 0 || segment[3] < 0)) fail('INVALID_INPUT', 'Invalid source-map original location.');
        yield { start, end: stop, source: source ?? null, content: source == null ? null : trace.sourcesContent?.[segment[1]] ?? null,
          line: source == null ? null : segment[2], column: source == null ? null : segment[3] };
      }
      cursor = stop;
    }
    if (cursor < end) yield { start: cursor, end, source: null };
  }
}
function byteMetrics(emitted = 0, loaded = 0, executed = 0) {
  return { emittedBytes: emitted, loadedBytes: loaded, executedBytes: executed, unusedBytes: loaded === null || executed === null ? null : loaded - executed,
    mappedBytes: 0, unmappedBytes: 0, notLoadedBytes: loaded === null ? null : emitted - loaded, usageRatio: loaded && executed !== null ? executed / loaded : null };
}
function addBytes(target, emitted, loaded, executed) {
  target.emittedBytes += emitted;
  target.loadedBytes = target.loadedBytes === null || loaded === null ? null : target.loadedBytes + loaded;
  target.executedBytes = target.executedBytes === null || executed === null ? null : target.executedBytes + executed;
  target.unusedBytes = target.loadedBytes === null || target.executedBytes === null ? null : target.loadedBytes - target.executedBytes;
  target.notLoadedBytes = target.loadedBytes === null ? null : target.emittedBytes - target.loadedBytes;
  target.usageRatio = target.loadedBytes && target.executedBytes !== null ? target.executedBytes / target.loadedBytes : null;
}
module.exports = { canonicalSource, sourcePathForContext, lineStarts, utf8Prefix, mergeRanges, coveredRanges, generatedSpans, byteMetrics, addBytes };
