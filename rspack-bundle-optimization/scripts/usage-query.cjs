#!/usr/bin/env node
const { parseArgs } = require('node:util');
const { AnyMap } = require('@jridgewell/trace-mapping');
const { openStore, getMeta, hash } = require('./usage-store.cjs');
const { mapReference, boundedLines } = require('./usage-source.cjs');

const HELP = {
  usage: 'node usage-query.cjs <command> --db <snapshot.sqlite> [options]',
  commands: {
    status: 'Build identity, graph availability, counts and capture gaps',
    modules: 'Search module metadata: --search <substring> [--limit 20 --offset 0]',
    module: 'One module, no full source: --module <id>',
    exports: 'Provided/used exports and paginated native target paths: --module <id>',
    references: 'Paginated edges: --module <id> [--direction in|out --export <name>]',
    reference: 'Map one edge to source and AST owners: --edge <id> [--space auto|resource|post-loader --context 3 --column-base 1]',
    chain: 'Bounded reverse usage graph: --module <id> --export <name> [--depth 5 --limit 100]',
    source: 'Source window: --module <id> [--space resource|post-loader --source <map-source> --line 1 --context 3]',
  },
  exportPaths: '--export means one literal name (including dots); --export-path \'["ns","member"]\' means a nested path',
  limits: 'Lists default to 20 rows (max 200); chain defaults to 100 edges (max 500), depth <=20; context <=10; lines clipped to 500 characters.',
  workflow: ['status', 'modules --search <path>', 'exports --module <id>', 'references or chain', 'reference --edge <id>'],
  notes: ['JSON on stdout; errors have ok:false and nonzero exit status.',
    'Queries are read-only and use only the captured build, never current workspace files.',
    'An empty graph is distinct from an unavailable API. Unknown/namespace edges remain conservative.'],
};

const intOption = (value, fallback, max, min = 0) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`Expected integer in ${min}..${max}, received ${value}`);
  }
  return Number(value);
};
function selectedPath(args) {
  if (args.export !== undefined && args['export-path'] !== undefined) throw new Error('Use either --export or --export-path');
  if (args.export !== undefined) return [args.export];
  if (args['export-path'] === undefined) return undefined;
  const path = JSON.parse(args['export-path']);
  if (!Array.isArray(path) || !path.every(x => typeof x === 'string')) throw new Error('--export-path must be a JSON string array');
  return path;
}
const META_COLUMNS = 'id, identifier, layer, type, resource, parent_id, provided, used, transformed_hash, resource_hash, source_gap';
function moduleInfo(row) {
  const provided = JSON.parse(row.provided || 'null'), used = JSON.parse(row.used || 'null');
  return { ...row, provided: Array.isArray(provided) ? provided.slice(0, 20) : provided,
    used: Array.isArray(used) ? used.slice(0, 20) : used,
    providedCount: Array.isArray(provided) ? provided.length : null,
    usedCount: Array.isArray(used) ? used.length : null,
    exportsTruncated: (provided?.length || 0) > 20 || (used?.length || 0) > 20 };
}
function edgeInfo(row) {
  const originExport = JSON.parse(row.origin_export);
  const targetExport = JSON.parse(row.target_export);
  return { id: row.id, origin: row.origin, target: row.target, originExport, targetExport,
    dependencyId: row.dependency, rawLoc: row.loc,
    relationPrecision: targetExport?.length ? 'native' : 'conservative' };
}
function edgeFilter(module, direction, path) {
  const column = direction === 'in' ? 'target' : 'origin';
  if (path === undefined) return { sql: `e.${column} = ?`, params: [module] };
  if (direction === 'out') throw new Error('Export filtering applies to incoming target paths; use --direction in');
  return { sql: `e.id IN (SELECT edge FROM targets WHERE module=? AND path IN (?, 'null', '[]'))`,
    params: [module, JSON.stringify(path)] };
}

function query(db, command, args) {
  const meta = getMeta(db);
  const envelope = { ok: true, command, build: { run: meta.run, compiler: meta.compiler, buildHash: meta.buildHash },
    graphAvailable: meta.graphAvailable, coordinateUnit: meta.coordinateUnit };
  const limit = intOption(args.limit, command === 'chain' ? 100 : 20, command === 'chain' ? 500 : 200, 1);
  const pageOffset = intOption(args.offset, 0, Number.MAX_SAFE_INTEGER);
  const context = intOption(args.context, 3, 10);
  const space = args.space || meta.locationSpace || 'auto';
  if (!['auto', 'resource', 'post-loader'].includes(space)) throw new Error('Invalid --space');
  const path = selectedPath(args);
  const getModule = (full = false) => {
    if (!args.module) throw new Error('--module is required; use modules --search first');
    const row = db.prepare(`SELECT ${full ? '*' : META_COLUMNS} FROM modules WHERE id=?`).get(args.module);
    if (!row) throw new Error(`Unknown module: ${args.module}`);
    return row;
  };
  const page = (items, total) => ({ items, total, offset: pageOffset, limit,
    nextOffset: pageOffset + items.length < total ? pageOffset + items.length : null });
  if (command === 'status') return { ...envelope, ...meta,
    modulesWithoutSource: db.prepare('SELECT count(*) AS n FROM modules WHERE transformed IS NULL').get().n,
    modulesWithLoaderMap: db.prepare('SELECT count(*) AS n FROM modules WHERE source_map IS NOT NULL').get().n };
  if (command === 'modules') {
    const search = args.search || '';
    const where = 'instr(identifier, ?) > 0 OR instr(COALESCE(resource, \'\'), ?) > 0';
    const total = db.prepare(`SELECT count(*) AS n FROM modules WHERE ${where}`).get(search, search).n;
    const items = db.prepare(`SELECT ${META_COLUMNS} FROM modules WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`)
      .all(search, search, limit, pageOffset).map(moduleInfo);
    return { ...envelope, ...page(items, total) };
  }
  if (command === 'module') return { ...envelope, module: moduleInfo(getModule()),
    sourceCounts: { loaderMap: Boolean(db.prepare('SELECT source_map IS NOT NULL AS yes FROM modules WHERE id=?').get(args.module).yes) } };
  if (command === 'exports') {
    const module = moduleInfo(getModule());
    const union = `SELECT path FROM targets WHERE module=? UNION
      SELECT json_array(j.value) AS path FROM modules m, json_each(m.provided) j
      WHERE m.id=? AND json_type(m.provided)='array'`;
    const paths = db.prepare(`SELECT p.path,
      (SELECT count(*) FROM targets t WHERE t.module=? AND t.path=p.path) AS incomingReferences
      FROM (${union}) p ORDER BY p.path LIMIT ? OFFSET ?`)
      .all(args.module, args.module, args.module, limit, pageOffset)
      .map(row => ({ path: JSON.parse(row.path), incomingReferences: row.incomingReferences }));
    const total = db.prepare(`SELECT count(*) AS n FROM (${union})`).get(args.module, args.module).n;
    return { ...envelope, module, ...page(paths, total), note: 'Target paths include prefixes; an absent path does not prove an unused export.' };
  }
  if (command === 'references') {
    getModule();
    const direction = args.direction || 'in';
    if (!['in', 'out'].includes(direction)) throw new Error('--direction must be in or out');
    const filter = edgeFilter(args.module, direction, path);
    const total = db.prepare(`SELECT count(*) AS n FROM edges e WHERE ${filter.sql}`).get(...filter.params).n;
    const items = db.prepare(`SELECT e.* FROM edges e WHERE ${filter.sql} ORDER BY e.id LIMIT ? OFFSET ?`)
      .all(...filter.params, limit, pageOffset).map(edgeInfo);
    return { ...envelope, ...page(items, total) };
  }
  if (command === 'reference') {
    if (!args.edge) throw new Error('--edge is required');
    const row = db.prepare('SELECT * FROM edges WHERE id=?').get(args.edge);
    if (!row) throw new Error(`Unknown edge: ${args.edge}`);
    const module = db.prepare('SELECT * FROM modules WHERE id=?').get(row.origin);
    const edge = edgeInfo(row);
    const mapping = mapReference(module, row.loc, { space, context,
      columnBase: intOption(args['column-base'], meta.columnBase ?? 1, 1) });
    return { ...envelope, edge, mapping: { ...mapping, relationPrecision: edge.relationPrecision } };
  }
  if (command === 'source') {
    const module = getModule(true);
    let content = space === 'post-loader' ? module.transformed : module.resource_content;
    let sourcePath = space === 'post-loader' ? module.identifier : module.resource;
    let mapSources = [];
    if (module.source_map) {
      const trace = AnyMap(JSON.parse(module.source_map));
      mapSources = trace.resolvedSources;
      if (args.source !== undefined) {
        const index = mapSources.indexOf(args.source);
        if (index < 0) throw new Error('Unknown --source; use source without --source to list map sources');
        content = trace.sourcesContent?.[index] ?? null; sourcePath = mapSources[index];
      }
    } else if (args.source !== undefined) throw new Error('No loader map sources captured');
    const line = intOption(args.line, 1, Number.MAX_SAFE_INTEGER, 1);
    if (content !== null && line > content.split('\n').length) throw new Error('--line is outside captured source');
    const sourceHash = content === null ? null : hash(content);
    const sourceIdentity = {
      matchesCapturedResource: content !== null && module.resource_content !== null && content === module.resource_content,
      matchesPostLoader: content !== null && module.transformed !== null && content === module.transformed,
    };
    const intermediateMap = args.source !== undefined && sourceIdentity.matchesPostLoader &&
      module.resource_content !== null && !sourceIdentity.matchesCapturedResource;
    return { ...envelope, moduleId: module.id, sourcePath,
      coordinateSpace: args.source !== undefined ? 'loader-map-source' : space === 'post-loader' ? 'post-loader' : 'resource',
      mapSources: page(mapSources.slice(pageOffset, pageOffset + limit), mapSources.length),
      sourceHash, sourceIdentity, excerpt: content === null ? null : boundedLines(content, line, context),
      gap: content === null ? 'Source unavailable; select --source from mapSources or --space post-loader' :
        intermediateMap ? 'Loader map points to post-loader text; mapping to the captured resource is unavailable' : null };
  }
  if (command === 'chain') {
    getModule();
    if (!path?.length) throw new Error('chain requires --export or a nonempty --export-path');
    const maxDepth = intOption(args.depth, 5, 20, 1);
    const root = { module: args.module, exportPath: path, depth: 0 };
    const queue = [root], expanded = new Set(), edgeIds = new Set(), edges = [], frontier = [];
    const nodeIds = new Set([args.module]);
    const terminals = [];
    let cursor = 0;
    while (cursor < queue.length) {
      const state = queue[cursor++];
      const key = JSON.stringify([state.module, state.exportPath]);
      if (expanded.has(key)) continue;
      expanded.add(key);
      const filter = edgeFilter(state.module, 'in', state.exportPath);
      const total = db.prepare(`SELECT count(*) AS n FROM edges e WHERE ${filter.sql}`).get(...filter.params).n;
      if (!total) { terminals.push({ ...state, reason: meta.graphAvailable ? 'no-captured-incoming-edge' : 'native-graph-unavailable' }); continue; }
      if (state.depth >= maxDepth || edges.length >= limit) {
        frontier.push({ ...state, reason: state.depth >= maxDepth ? 'depth-limit' : 'edge-limit', total }); continue;
      }
      // Fetch at most the global edge budget, plus a sentinel, per state.
      const incoming = db.prepare(`SELECT e.* FROM edges e WHERE ${filter.sql} ORDER BY e.id LIMIT ?`).all(...filter.params, limit + 1);
      let consumed = 0;
      for (const row of incoming) {
        if (!edgeIds.has(row.id) && edges.length >= limit) break;
        consumed++;
        const edge = edgeInfo(row);
        if (!edgeIds.has(edge.id)) { edgeIds.add(edge.id); edges.push(edge); }
        nodeIds.add(edge.origin); nodeIds.add(edge.target);
        if (edge.originExport?.length) queue.push({ module: edge.origin, exportPath: edge.originExport, depth: state.depth + 1 });
        else terminals.push({ module: edge.origin, exportPath: edge.originExport, reason: 'no-named-origin-export', edge: edge.id });
      }
      if (consumed < total) frontier.push({ ...state, reason: 'edge-limit', total,
        nextReferenceOffset: consumed });
    }
    return { ...envelope, root, edges, nodes: [...nodeIds].map(id => moduleInfo(db.prepare(`SELECT ${META_COLUMNS} FROM modules WHERE id=?`).get(id))),
      truncated: frontier.length > 0, frontier, terminals, maxDepth, limit,
      note: 'Graph preserves shared and cycle edges. Query frontier states as new chain roots; use references pagination for wide states.' };
  }
  throw new Error(`Unknown command: ${command}`);
}

function main(argv) {
  const names = ['db', 'search', 'module', 'edge', 'export', 'export-path', 'direction', 'limit', 'offset', 'depth', 'space', 'context', 'line', 'source', 'column-base'];
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: Object.fromEntries(names.map(name => [name, { type: 'string' }]).concat([['help', { type: 'boolean' }]])) });
  if (values.help || positionals[0] === 'help' || !positionals.length) return { ok: true, ...HELP };
  if (positionals.length !== 1) throw new Error('Expected one command');
  const commandOptions = {
    status: [], modules: ['search', 'limit', 'offset'], module: ['module'],
    exports: ['module', 'limit', 'offset'], references: ['module', 'direction', 'export', 'export-path', 'limit', 'offset'],
    reference: ['edge', 'space', 'column-base', 'context'],
    chain: ['module', 'export', 'export-path', 'limit', 'depth'],
    source: ['module', 'space', 'source', 'line', 'context', 'limit', 'offset'],
  };
  const allowed = commandOptions[positionals[0]];
  if (!allowed) throw new Error(`Unknown command: ${positionals[0]}; use help`);
  for (const name of Object.keys(values)) {
    if (name !== 'db' && !allowed.includes(name)) throw new Error(`--${name} is not supported by ${positionals[0]}`);
  }
  if (!values.db) throw new Error('--db is required');
  const db = openStore(values.db);
  try { return query(db, positionals[0], values); } finally { db.close(); }
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; }
}
module.exports = { query, main };
