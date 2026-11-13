const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const id = (kind, value) => `${kind}_${hash(JSON.stringify(value)).slice(0, 24)}`;
const json = value => JSON.stringify(value);
const decode = value => JSON.parse(Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value));
function integer(value, fallback, max = Number.MAX_SAFE_INTEGER, min = 0) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max)
    fail('INVALID_ARGUMENT', `Expected an integer in ${min}..${max}.`);
  return Number(value);
}
function readJson(file, max = 256 * 1024 * 1024) {
  if (fs.statSync(file).size > max) fail('INPUT_TOO_LARGE', `JSON record exceeds ${max} bytes: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function signature(file) {
  const real = fs.realpathSync(file);
  const s = fs.statSync(real, { bigint: true });
  if (!s.isFile()) fail('INVALID_INPUT', `Expected a file: ${file}`);
  return { path: real, size: String(s.size), mtime: String(s.mtimeNs), device: String(s.dev), inode: String(s.ino) };
}
function verifyInputs(inputs) {
  for (const expected of inputs) {
    let actual;
    try { actual = signature(expected.path); }
    catch { fail('INPUT_CHANGED', `Input is missing: ${expected.path}`); }
    if (json(actual) !== json(expected)) fail('INPUT_CHANGED', `Input changed after indexing: ${expected.path}`);
  }
}
function safePath(directory, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) fail('INVALID_INPUT', 'Invalid snapshot-relative path.');
  const resolved = path.resolve(directory, relative);
  const rel = path.relative(directory, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('INVALID_INPUT', 'Snapshot path escapes its directory.');
  return resolved;
}
function openRead(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384; PRAGMA mmap_size=0;');
  return db;
}
function meta(db) { return Object.fromEntries(db.prepare('SELECT key,value FROM meta').all().map(row => [row.key, decode(row.value)])); }
function setMeta(db, values) {
  const stmt = db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)');
  for (const [key, value] of Object.entries(values)) stmt.run(key, json(value));
}
function openIndex(file) {
  if (file.endsWith('.incomplete')) fail('INVALID_INDEX', 'An unpublished index cannot be queried. Rebuild it with index.');
  const db = openRead(file);
  try {
    const m = meta(db);
    if (m.schemaVersion !== 1 || m.status !== 'complete' || m.kind !== 'rspack-bundle-query') fail('INVALID_INDEX', 'Unsupported or incomplete query index.');
    verifyInputs(m.inputs);
    return { db, meta: m };
  } catch (error) { db.close(); throw error; }
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function fingerprint(value) { return hash(json(stable(value))); }
function encodeCursor(fingerprint_, keys) { return Buffer.from(json({ v: 1, fingerprint: fingerprint_, keys })).toString('base64url'); }
function decodeCursor(token, fingerprint_) {
  try {
    if (token.length > 16384) throw new Error();
    const value = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (value.v !== 1 || value.fingerprint !== fingerprint_ || !Array.isArray(value.keys) ||
      !value.keys.every(key => key === null || typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key)))) throw new Error();
    return value.keys;
  } catch { fail('CURSOR_MISMATCH', 'Cursor belongs to another dataset or query. Repeat the same run, scope, filters and sort.'); }
}
function sortTerms(raw, allowed, fallback = 'id:asc') {
  const input = raw || fallback;
  const terms = input.split(',').map(term => {
    const [name, direction = 'asc', extra] = term.split(':');
    if (!Object.hasOwn(allowed, name) || !['asc', 'desc'].includes(direction) || extra !== undefined) fail('INVALID_SORT', `Unsupported sort: ${term}`, { fields: Object.keys(allowed) });
    return { name, expression: allowed[name], direction };
  });
  if (terms.length > 3 || new Set(terms.map(term => term.name)).size !== terms.length) fail('INVALID_SORT', 'Use at most three distinct sort fields.');
  if (!terms.some(term => term.name === 'id' || term.name === 'moduleId')) terms.push({ name: 'id', expression: allowed.id, direction: 'asc' });
  return terms;
}
function paginate(ctx, spec) {
  const limit = integer(ctx.args.limit, 20, 200, 1);
  const terms = sortTerms(ctx.args.sort, spec.sort, spec.defaultSort);
  const dimensions = terms.flatMap(term => [
    { expression: `(${term.expression} IS NULL)`, direction: 'asc' },
    { expression: term.expression, direction: term.direction },
  ]);
  const fp = fingerprint({ dataset: ctx.meta.datasetId, command: spec.command || ctx.command, args: Object.fromEntries(Object.entries(ctx.args).filter(([key]) => !['db', 'cursor', 'limit'].includes(key))) });
  const base = spec.where || '1';
  const params = spec.params || [];
  const total = ctx.db.prepare(`SELECT count(*) AS n ${spec.from} WHERE ${base}`).get(...params).n;
  const first = terms[0];
  const known = ctx.db.prepare(`SELECT count(*) AS n ${spec.from} WHERE ${base} AND ${first.expression} IS NOT NULL`).get(...params).n;
  let seek = ''; const seekParams = [];
  if (ctx.args.cursor) {
    const keys = decodeCursor(ctx.args.cursor, fp);
    if (keys.length !== dimensions.length) fail('CURSOR_MISMATCH', 'Invalid cursor key count.');
    const clauses = [];
    for (let i = 0; i < dimensions.length; i++) {
      const prefix = [];
      for (let j = 0; j < i; j++) { prefix.push(`${dimensions[j].expression} IS ?`); seekParams.push(keys[j]); }
      prefix.push(`${dimensions[i].expression} ${dimensions[i].direction === 'asc' ? '>' : '<'} ?`);
      seekParams.push(keys[i]); clauses.push(`(${prefix.join(' AND ')})`);
    }
    seek = ` AND (${clauses.join(' OR ')})`;
  }
  const extra = dimensions.map((dim, i) => `${dim.expression} AS __key${i}`).join(',');
  const rows = ctx.db.prepare(`SELECT ${spec.select},${extra} ${spec.from} WHERE ${base}${seek} ORDER BY ${dimensions.map(dim => `${dim.expression} ${dim.direction}`).join(',')} LIMIT ?`).all(...params, ...seekParams, limit + 1);
  const items = []; let bytes = 0; let consumed = 0;
  for (const row of rows.slice(0, limit)) {
    const item = spec.map(row);
    const size = Buffer.byteLength(json(item));
    if (bytes + size > 20 * 1024 && items.length) break;
    if (size > 20 * 1024) fail('RECORD_TOO_LARGE', 'One record exceeds the output budget. Request fewer fields or a smaller source window.');
    items.push(item); bytes += size; consumed++;
  }
  const hasNext = consumed < rows.length;
  const last = rows[consumed - 1];
  return { items, page: { total, returned: items.length, nextCursor: hasNext && last ? encodeCursor(fp, dimensions.map((_, i) => last[`__key${i}`])) : null }, ranking: { field: first.name, known, unknown: total - known } };
}
function exportPath(args) {
  if (args.export !== undefined && args['export-path'] !== undefined) fail('INVALID_ARGUMENT', 'Use --export or --export-path, not both.');
  if (args.export !== undefined) return [args.export];
  if (args['export-path'] === undefined) return null;
  let value;
  try { value = JSON.parse(args['export-path']); } catch { fail('INVALID_ARGUMENT', '--export-path must be a JSON array.'); }
  if (!Array.isArray(value) || !value.length || !value.every(item => typeof item === 'string' && item.length)) fail('INVALID_ARGUMENT', 'Expected a nonempty array of export names.');
  return value;
}
module.exports = { fs, path, fail, hash, id, json, decode, integer, readJson, signature, verifyInputs, safePath, openRead, meta, setMeta, openIndex, fingerprint, encodeCursor, decodeCursor, paginate, exportPath };
