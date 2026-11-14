const { fail, json, decode, integer, paginate, exportPath } = require('./common.cjs');

const MODULE_SORT = {
  id: 'm.id', moduleId: 'm.id', path: 'COALESCE(m.resource,m.identifier)',
  'coverage.generated.emittedBytes': 'c.ge', 'coverage.generated.loadedBytes': 'c.gl',
  'coverage.generated.unexecutedBytes': 'c.gu', 'coverage.generated.executionRatio': 'c.gr',
  'coverage.retainedSource.unexecutedBytes': 'c.su',
  'usage.incomingReferences': 'm.incoming', 'usage.distinctConsumers': 'm.consumers', 'usage.usedExportCount': 'm.used_count',
};
function required(args, name) {
  if (!args[name]) fail('INVALID_ARGUMENT', `--${name} is required.`);
  return args[name];
}
function moduleRow(ctx, moduleId = required(ctx.args, 'module')) {
  const row = ctx.db.prepare('SELECT * FROM modules WHERE id=?').get(moduleId);
  if (!row) fail('MODULE_NOT_FOUND', 'Unknown module ID. Find it with modules.');
  return row;
}
function scope(ctx) {
  const value = ctx.args.scope || 'build';
  if (!['build', 'loaded', 'initial'].includes(value)) fail('INVALID_ARGUMENT', 'scope must be build, loaded, or initial.');
  if (!ctx.meta.scopes.includes(value)) fail('METRIC_UNAVAILABLE', `Scope ${value} cannot be reconstructed from these inputs.`, { supported: ctx.meta.scopes });
  if (ctx.args.run && ctx.args.run !== ctx.meta.coverageRunId) fail('INPUT_IDENTITY_MISMATCH', 'Requested coverage run does not match the indexed recording.');
  return value;
}
function metrics(row, prefix) {
  if (!row || row[`${prefix}e`] === null || row[`${prefix}e`] === undefined) return null;
  return { emittedBytes: row[`${prefix}e`], loadedBytes: row[`${prefix}l`], executedBytes: row[`${prefix}x`], unexecutedBytes: row[`${prefix}u`], executionRatio: row[`${prefix}r`] ?? null };
}
function coverageSummary(ctx, moduleId) {
  if (!ctx.meta.coverageAvailable) return { available: false, generated: null, retainedSource: null };
  const currentScope = scope(ctx);
  const row = ctx.db.prepare('SELECT * FROM metrics WHERE module_id=? AND scope=?').get(moduleId, currentScope);
  return { available: true, runId: ctx.meta.coverageRunId, scope: currentScope, generated: metrics(row, 'g'), retainedSource: metrics(row, 's'),
    generatedAttribution: row?.ge === null ? 'unknown-or-shared-source' : 'captured-source-and-chunk-membership',
    metricBasis: { generated: 'final-JavaScript-UTF8-bytes', retainedSource: 'retained-mapped-source-line-UTF8-bytes' } };
}
function usageSummary(row) { return { incomingReferences: row.incoming, distinctConsumers: row.consumers, usedExportCount: row.used_count }; }
function compactModule(row) {
  return { moduleId: row.id, path: row.resource || row.identifier, identifier: row.identifier, layer: row.layer, package: row.package, type: row.type,
    loaded: row.loaded === null ? null : Boolean(row.loaded), initial: row.initial === null ? null : Boolean(row.initial) };
}
function projection(item, fields) {
  if (!fields) return item;
  const allowed = new Set(['moduleId', 'path', 'identifier', 'layer', 'package', 'type', 'loaded', 'initial', 'coverage', 'coverage.generated', 'coverage.retainedSource', 'usage', ...Object.keys(MODULE_SORT).filter(key => key.includes('.'))]);
  const result = { moduleId: item.moduleId };
  for (const name of fields.split(',')) {
    if (!allowed.has(name)) fail('INVALID_ARGUMENT', `Unknown projection field: ${name}`);
    const keys = name.split('.'); let target = result; let value = item;
    for (const key of keys) value = value === null || value === undefined ? null : value[key];
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = value;
  }
  return result;
}
function queryModules(ctx) {
  const currentScope = scope(ctx);
  if ((ctx.args.sort || '').includes('coverage.') && !ctx.meta.coverageAvailable) fail('METRIC_UNAVAILABLE', 'Coverage sort requires a coverage input.');
  if (/usage\.(incomingReferences|distinctConsumers)/.test(ctx.args.sort || '') && !ctx.meta.graphAvailable)
    fail('METRIC_UNAVAILABLE', 'This sort requires a native usage graph.');
  const params = [currentScope]; const where = [];
  if (ctx.args.search) { where.push('(instr(m.identifier,?)>0 OR instr(COALESCE(m.resource,\'\'),?)>0)'); params.push(ctx.args.search, ctx.args.search); }
  if (ctx.args.package) { where.push('m.package=?'); params.push(ctx.args.package); }
  if (currentScope === 'loaded') where.push('m.loaded=1');
  return paginate(ctx, { from: 'FROM modules m JOIN metrics c ON c.module_id=m.id', where: ['c.scope=?', ...where].join(' AND '), params,
    select: 'm.*,c.ge,c.gl,c.gx,c.gu,c.gr,c.se,c.sl,c.sx,c.su,c.sr', sort: MODULE_SORT,
    map: row => projection({ ...compactModule(row), coverage: { generated: metrics(row, 'g'), retainedSource: metrics(row, 's') }, usage: usageSummary(row), detail: { command: 'module', module: row.id } }, ctx.args.fields) });
}
function queryExports(ctx) {
  const module = moduleRow(ctx); const where = ['e.module_id=?']; const params = [module.id];
  if (ctx.args.used) {
    if (!['used', 'unused', 'unknown'].includes(ctx.args.used)) fail('INVALID_ARGUMENT', '--used must be used, unused, or unknown.');
    where.push('e.used=?'); params.push(ctx.args.used);
  }
  return { moduleId: module.id, providedExportsKnown: module.provided !== 'null', ...paginate(ctx, {
    from: 'FROM exports e', select: 'e.*', where: where.join(' AND '), params,
    sort: { id: 'e.id', name: 'e.path', 'usage.incomingReferences': 'e.incoming' },
    map: row => ({ exportId: row.id, exportPath: JSON.parse(row.path), compilerUsage: row.used, incomingReferences: row.incoming }),
  }) };
}
function referenceWhere(ctx, module, names = exportPath(ctx.args)) {
  const direction = ctx.args.direction || 'in';
  if (!['in', 'out'].includes(direction)) fail('INVALID_ARGUMENT', '--direction must be in or out.');
  if (names && direction !== 'in') fail('INVALID_ARGUMENT', 'Export filtering is supported for incoming references only.');
  const kind = ctx.args.relation || (names ? 'native' : 'all');
  if (!['native', 'module-graph', 'all'].includes(kind)) fail('INVALID_ARGUMENT', 'Unknown relation type.');
  const where = [`e.${direction === 'in' ? 'target' : 'origin'}=?`]; const params = [module];
  if (kind !== 'all') { where.push('e.kind=?'); params.push(kind); }
  if (names) {
    const ancestors = ['null', '[]', ...names.slice(0, -1).map((_, index) => json(names.slice(0, index + 1)))];
    where.push(`e.kind='native' AND (e.id IN (SELECT edge_id FROM targets WHERE module_id=? AND path=?) OR e.target_export IN (${ancestors.map(() => '?').join(',')}))`);
    params.push(module, json(names), ...ancestors);
  }
  return { where: where.join(' AND '), params };
}
function edgeItem(row) {
  return { edgeId: row.id, originModuleId: row.origin, targetModuleId: row.target,
    originExport: JSON.parse(row.origin_export), targetExport: JSON.parse(row.target_export),
    relationEvidence: row.kind, dependencyId: row.dependency, dependencyType: row.dependency_type,
    rawLocation: JSON.parse(row.raw_loc), sourcePath: row.source_path, sourceLocation: JSON.parse(row.source_loc),
    active: row.active === null ? null : Boolean(row.active) };
}
function queryReferences(ctx) {
  const module = moduleRow(ctx);
  const filter = referenceWhere(ctx, module.id);
  return { moduleId: module.id, graphAvailable: ctx.meta.graphAvailable, ...paginate(ctx, {
    from: 'FROM edges e', select: 'e.*', ...filter, sort: { id: 'e.id' }, map: edgeItem,
  }), note: 'Captured compile-time relations only. Missing/anonymous paths are not proof of no runtime use.' };
}
function queryCoverage(ctx) {
  const module = moduleRow(ctx);
  if (!ctx.meta.coverageAvailable) fail('FEATURE_UNAVAILABLE', 'No coverage recording is indexed.');
  const currentScope = scope(ctx); const view = ctx.args.view || 'summary';
  if (view === 'summary') {
    for (const name of ['limit', 'cursor', 'sort', 'state', 'source']) if (ctx.args[name] !== undefined) fail('INVALID_ARGUMENT', `--${name} applies to --view lines.`);
    return { moduleId: module.id, ...coverageSummary(ctx, module.id) };
  }
  if (view === 'ranges') fail('FEATURE_UNAVAILABLE', 'This input stores source-line evidence, not generated offset-to-source ranges.', { supportedViews: ['summary', 'lines'] });
  if (view !== 'lines') fail('INVALID_ARGUMENT', 'Unknown coverage view.');
  const where = ['l.module_id=?']; const params = [module.id];
  if (ctx.args.source) {
    const source = require('./source.cjs'); const row = source.sourceRow(ctx, ctx.args.source);
    const ids = [...new Set([row.id, ...source.coverageSourceIds(ctx, row)])];
    where.push(`l.source_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
  }
  if (currentScope === 'loaded') where.push('l.gl>0');
  if (ctx.args.state) {
    if (!['executed', 'unexecuted', 'not-loaded', 'unknown'].includes(ctx.args.state)) fail('INVALID_ARGUMENT', 'Unknown coverage state.');
    where.push('l.state=?'); params.push(ctx.args.state);
  }
  return { moduleId: module.id, granularity: 'source-line', population: 'mapped-lines-only',
    note: 'Unmapped source lines are not indexed and have unknown evidence; absence is not a deletion verdict.',
    ...paginate(ctx, { from: 'FROM coverage_lines l', select: 'l.*', where: where.join(' AND '), params,
      sort: { id: 'l.id', line: 'l.line', generatedBytes: 'l.ge', unexecutedBytes: 'l.gu', 'coverage.generated.unexecutedBytes': 'l.gu' },
      map: row => ({ lineId: row.id, sourceId: row.source_id, line: row.line, runtimeState: row.state,
        generated: row.ge === null ? null : { emittedBytes: row.ge, loadedBytes: row.gl, executedBytes: row.gx, unexecutedBytes: row.gu },
        sourceRangeCount: JSON.parse(row.ranges)?.length ?? null, rangePrecision: row.range_precision,
        sourceQuery: { command: 'source', source: row.source_id, module: module.id, line: row.line } }),
    }) };
}
function queryGaps(ctx) {
  const where = []; const params = [];
  if (ctx.args.module) { moduleRow(ctx); where.push('g.module_id=?'); params.push(ctx.args.module); }
  if (ctx.args.kind) { where.push('g.kind=?'); params.push(ctx.args.kind); }
  return paginate(ctx, { from: 'FROM gaps g', select: 'g.*', where: where.join(' AND ') || '1', params, sort: { id: 'g.id' },
    map: row => ({ gapId: row.id, moduleId: row.module_id, kind: row.kind, detail: JSON.parse(row.detail) }) });
}
function queryChain(ctx) {
  const root = moduleRow(ctx); const names = exportPath(ctx.args);
  if (!names) fail('INVALID_ARGUMENT', 'chain requires --export-path or --export.');
  if (!ctx.meta.graphAvailable) fail('FEATURE_UNAVAILABLE', 'Native export graph is unavailable. Inspect module-graph references where available.');
  const maxDepth = integer(ctx.args.depth, 5, 20, 1); const maxEdges = integer(ctx.args['max-edges'], 100, 500, 1);
  const run = budget => {
    const queue = [{ moduleId: root.id, exportPath: names, depth: 0, ancestors: [] }];
    const visited = new Set(); const ids = new Set(); const edges = []; const frontier = []; const terminals = []; const cycles = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { ancestors, ...state } = queue[cursor]; const key = json([state.moduleId, state.exportPath]);
      if (visited.has(key)) continue; visited.add(key);
      const args = { module: state.moduleId, 'export-path': json(state.exportPath), direction: 'in', relation: 'native', limit: String(Math.min(200, Math.max(1, budget - edges.length))) };
      const child = { ...ctx, command: 'references', args };
      const filter = referenceWhere(child, state.moduleId, state.exportPath);
      const total = ctx.db.prepare(`SELECT count(*) AS n FROM edges e WHERE ${filter.where}`).get(...filter.params).n;
      if (!total) { terminals.push({ ...state, reason: 'no-captured-incoming-edge', next: { command: 'references', module: state.moduleId } }); continue; }
      if (state.depth >= maxDepth || edges.length >= budget) { frontier.push({ ...state, reason: 'query-budget', query: { command: 'references', ...args } }); continue; }
      const result = queryReferences(child);
      for (const edge of result.items) {
        if (!ids.has(edge.edgeId)) { ids.add(edge.edgeId); edges.push(edge); }
        if (edge.originExport?.length) {
          const nextKey = json([edge.originModuleId, edge.originExport]);
          if ([...ancestors, key].includes(nextKey)) cycles.push({ edgeId: edge.edgeId, moduleId: edge.originModuleId, exportPath: edge.originExport });
          else queue.push({ moduleId: edge.originModuleId, exportPath: edge.originExport, depth: state.depth + 1, ancestors: [...ancestors, key] });
        }
        else terminals.push({ moduleId: edge.originModuleId, edgeId: edge.edgeId, reason: 'no-named-origin-export', next: { command: 'reference', edge: edge.edgeId } });
      }
      if (result.page.nextCursor) frontier.push({ ...state, reason: 'page-budget', query: { command: 'references', ...args, cursor: result.page.nextCursor } });
    }
    return { root: { moduleId: root.id, exportPath: names }, edges, frontier, terminals, cycles, truncated: frontier.length > 0, maxDepth, maxEdges: budget,
      note: 'Native compile-time graph; unknown terminals may need module-graph and source investigation.' };
  };
  let budget = maxEdges; let result = run(budget);
  while (Buffer.byteLength(json(result)) > 24 * 1024 && budget > 1) { budget = Math.max(1, Math.floor(budget / 2)); result = run(budget); }
  return result;
}
function queryModule(ctx) {
  const module = moduleRow(ctx);
  const sources = ctx.db.prepare('SELECT s.id,s.path,s.space,s.hash FROM sources s JOIN module_sources ms ON s.id=ms.source_id WHERE ms.module_id=? ORDER BY s.id LIMIT 21').all(module.id);
  const sourceCount = ctx.db.prepare('SELECT count(*) AS n FROM module_sources WHERE module_id=?').get(module.id).n;
  const result = { ...compactModule(module), usage: usageSummary(module), coverage: coverageSummary(ctx, module.id),
    originalIds: ctx.db.prepare('SELECT adapter,original_id AS moduleId FROM aliases WHERE module_id=? ORDER BY adapter').all(module.id),
    providedExportCount: JSON.parse(module.provided)?.length ?? null, usedExports: { state: Array.isArray(JSON.parse(module.used)) ? 'named' : JSON.parse(module.used), count: module.used_count },
    moduleReferences: { relationEvidence: 'module-graph', incoming: module.module_incoming, outgoing: module.module_outgoing },
    sources: { items: sources.slice(0, 20).map(row => ({ sourceId: row.id, path: row.path, coordinateSpace: row.space, sourceHash: row.hash })), total: sourceCount,
      nextQuery: sourceCount > 20 ? { command: 'sources', module: module.id } : null } };
  const include = ctx.args.include ? ctx.args.include.split(',') : [];
  for (const name of include) if (!['coverage', 'exports', 'reference-stats'].includes(name)) fail('INVALID_ARGUMENT', `Unknown include: ${name}`);
  if (include.includes('exports')) result.exports = queryExports({ ...ctx, command: 'exports', args: { module: module.id, limit: '5' } });
  return result;
}
function runQuery(ctx) {
  scope(ctx);
  if (ctx.command === 'status') return { compiler: ctx.meta.compiler, context: ctx.meta.context, scenario: ctx.meta.scenario, coveragePrecision: ctx.meta.coveragePrecision,
    capabilities: { coverage: ctx.meta.coverageAvailable, nativeUsage: ctx.meta.graphAvailable, coverageViews: ctx.meta.coverageAvailable ? ['summary', 'lines'] : [], scopes: ctx.meta.scopes },
    counts: ctx.meta.counts, generated: ctx.meta.coverageTotals ?? null, recording: ctx.meta.coverageImportSummary ? {
      matchedAssets: ctx.meta.coverageImportSummary.matchedAssets,
      ignoredScripts: ctx.meta.coverageImportSummary.ignoredEntries?.length || 0,
      mappingWarnings: ctx.meta.coverageImportSummary.warnings?.length || 0,
      scopeGaps: ctx.meta.coverageImportSummary.recordingGaps?.length || 0,
    } : null, inputs: ctx.meta.inputs.map(input => ({ path: input.path, bytes: Number(input.size) })),
    semantics: { generated: 'final emitted JavaScript UTF-8 bytes', retainedSource: 'retained captured map-source line UTF-8 bytes', graph: 'compile-time relations, not a runtime call graph', unknown: 'null, never zero or unused', scope: 'initial compiler assets and observed recording scripts are different sets' } };
  if (ctx.command === 'modules') return queryModules(ctx);
  if (ctx.command === 'module') return queryModule(ctx);
  if (ctx.command === 'exports') return queryExports(ctx);
  if (ctx.command === 'references') return queryReferences(ctx);
  if (ctx.command === 'chain') return queryChain(ctx);
  if (ctx.command === 'coverage') return queryCoverage(ctx);
  if (ctx.command === 'gaps') return queryGaps(ctx);
  if (ctx.command === 'sources') {
    const module = moduleRow(ctx);
    return paginate(ctx, { from: 'FROM sources s JOIN module_sources ms ON ms.source_id=s.id', select: 's.id,s.path,s.space,s.hash', where: 'ms.module_id=?', params: [module.id],
      sort: { id: 's.id', path: 's.path' }, map: row => ({ sourceId: row.id, path: row.path, coordinateSpace: row.space, sourceHash: row.hash }) });
  }
  if (ctx.command === 'source') {
    const source = require('./source.cjs'); const row = source.sourceRow(ctx, required(ctx.args, 'source'));
    const value = source.loadSource(row, ctx.args['map-source']);
    const result = { sourceId: row.id, moduleId: ctx.args.module ?? null, ...source.sourceWindow(value, ctx.args) };
    if (ctx.args.module && ['resource', 'map-source'].includes(value.space)) {
      const sourceIds = [...new Set([row.id, ...source.coverageSourceIds(ctx, value)])];
      const params = [ctx.args.module, ...sourceIds, result.start.line, result.end.line];
      const where = `module_id=? AND source_id IN (${sourceIds.map(() => '?').join(',')}) AND line BETWEEN ? AND ?`;
      const total = ctx.db.prepare(`SELECT count(*) AS n FROM coverage_lines WHERE ${where}`).get(...params).n;
      const items = ctx.db.prepare(`SELECT line,state,ge,gl,gx,gu FROM coverage_lines WHERE ${where} ORDER BY line LIMIT 20`).all(...params);
      result.coverage = { items, total, sourceIds, nextQuery: total > items.length ? { command: 'coverage', module: ctx.args.module, source: row.id, view: 'lines', sort: 'line:asc' } : null };
    }
    return result;
  }
  if (ctx.command === 'reference') {
    const row = ctx.db.prepare('SELECT * FROM edges WHERE id=?').get(required(ctx.args, 'edge'));
    if (!row) fail('REFERENCE_NOT_FOUND', 'Unknown edge ID.');
    return { edge: edgeItem(row), mapping: require('./source.cjs').reference(ctx, row) };
  }
  fail('INVALID_ARGUMENT', 'Unknown query command.');
}
module.exports = { runQuery, MODULE_SORT, metrics, referenceWhere, queryReferences };
