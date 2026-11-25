const { fail, json, integer, float, displayPath, paginate, exportPath } = require('./common.cjs');
const sourceLib = require('./source.cjs');

const MODULE_SORT = {
  id: 'm.id', moduleId: 'm.id', path: 'm.display_path',
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
  if (!row) fail('MODULE_NOT_FOUND', `Unknown module ID: ${moduleId}. Find module IDs with \`modules\`.`);
  return row;
}
function checkRun(ctx) {
  if (ctx.args.run && ctx.args.run !== ctx.meta.coverageRunId)
    fail('INPUT_IDENTITY_MISMATCH', 'Requested coverage run does not match the indexed recording.');
}
function scope(ctx) {
  const value = ctx.args.scope || 'build';
  if (!['build', 'loaded', 'initial'].includes(value)) fail('INVALID_ARGUMENT', '--scope must be build, loaded, or initial.');
  if (!ctx.meta.scopes.includes(value)) fail('METRIC_UNAVAILABLE', `Scope ${value} cannot be reconstructed from these inputs.`, { supported: ctx.meta.scopes });
  checkRun(ctx);
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
  return {
    available: true, scope: currentScope, generated: metrics(row, 'g'), retainedSource: metrics(row, 's'),
    generatedAttribution: row?.ge === null ? 'unknown-or-shared-source' : 'captured-source-and-chunk-membership',
  };
}
function usedSummary(row) {
  const raw = JSON.parse(row.used);
  const state = raw === false ? 'none' : Array.isArray(raw) ? (raw.length ? 'named' : 'none') : raw === true ? 'all' : 'unknown';
  return { state, count: row.used_count };
}
function usageSummary(row) {
  const used = usedSummary(row);
  return { incomingReferences: row.incoming, distinctConsumers: row.consumers, usedExportCount: row.used_count, usedState: row.used_state, usedDetail: used.state };
}
function compactModule(row, context = null) {
  return {
    moduleId: row.id, path: displayPath(row.display_path, context), identifier: row.identifier,
    layer: row.layer, package: row.package, type: row.type,
    loaded: row.loaded === null ? null : Boolean(row.loaded),
    initial: row.initial === null ? null : Boolean(row.initial),
  };
}
function projection(item, fields) {
  if (!fields) return item;
  const allowed = new Set([
    'moduleId', 'path', 'identifier', 'layer', 'package', 'type', 'loaded', 'initial',
    'coverage', 'coverage.generated', 'coverage.retainedSource', 'usage',
    'usage.usedState', 'usage.usedDetail',
    ...Object.keys(MODULE_SORT).filter(key => key.includes('.')),
  ]);
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

function modulePathMap(ctx, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = ctx.db.prepare(`SELECT id, display_path FROM modules WHERE id IN (${unique.map(() => '?').join(',')})`).all(...unique);
  return new Map(rows.map(row => [row.id, displayPath(row.display_path, ctx.meta.context)]));
}

function queryStatus(ctx) {
  checkRun(ctx);
  if (ctx.args.gaps) {
    const where = []; const params = [];
    if (ctx.args.module) { moduleRow(ctx); where.push('g.module_id=?'); params.push(ctx.args.module); }
    if (ctx.args.kind) { where.push('g.kind=?'); params.push(ctx.args.kind); }
    return {
      mode: 'gaps',
      ...paginate(ctx, {
        from: 'FROM gaps g LEFT JOIN modules m ON m.id=g.module_id',
        select: 'g.*, m.display_path AS module_path',
        where: where.join(' AND ') || '1', params, sort: { id: 'g.id' },
        map: row => ({ gapId: row.id, moduleId: row.module_id, modulePath: row.module_path ?? null, kind: row.kind, detail: JSON.parse(row.detail) }),
      }),
    };
  }
  const gapsPreview = ctx.meta.counts.gaps > 0 && ctx.meta.counts.gaps <= 10
    ? ctx.db.prepare('SELECT g.*, m.display_path AS module_path FROM gaps g LEFT JOIN modules m ON m.id=g.module_id ORDER BY g.id LIMIT 10').all()
        .map(row => ({ gapId: row.id, moduleId: row.module_id, modulePath: row.module_path ?? null, kind: row.kind, detail: JSON.parse(row.detail) }))
    : null;
  const gapKinds = ctx.meta.counts.gaps > 0
    ? ctx.db.prepare('SELECT kind, count(*) AS count FROM gaps GROUP BY kind ORDER BY count DESC, kind ASC').all()
        .map(row => ({ kind: row.kind, count: row.count }))
    : [];
  return {
    mode: 'summary',
    compiler: ctx.meta.compiler, context: ctx.meta.context, scenario: ctx.meta.scenario,
    coveragePrecision: ctx.meta.coveragePrecision,
    capabilities: { coverage: ctx.meta.coverageAvailable, nativeUsage: ctx.meta.graphAvailable, scopes: ctx.meta.scopes },
    counts: ctx.meta.counts,
    generated: ctx.meta.coverageTotals ?? null,
    recording: ctx.meta.coverageImportSummary ? {
      matchedAssets: ctx.meta.coverageImportSummary.matchedAssets,
      ignoredScripts: ctx.meta.coverageImportSummary.ignoredEntries?.length || 0,
      mappingWarnings: ctx.meta.coverageImportSummary.warnings?.length || 0,
      scopeGaps: ctx.meta.coverageImportSummary.recordingGaps?.length || 0,
    } : null,
    inputs: ctx.meta.inputs.map(input => ({ path: input.path, bytes: Number(input.size) })),
    ...(gapKinds.length ? { gapKinds } : {}),
    ...(gapsPreview ? { gapsPreview } : {}),
  };
}

function queryModules(ctx) {
  const currentScope = scope(ctx);
  if ((ctx.args.sort || '').includes('coverage.') && !ctx.meta.coverageAvailable)
    fail('METRIC_UNAVAILABLE', 'Coverage sort requires a coverage input.');
  if (/usage\.(incomingReferences|distinctConsumers)/.test(ctx.args.sort || '') && !ctx.meta.graphAvailable)
    fail('METRIC_UNAVAILABLE', 'This sort requires a native usage graph.');
  const params = [currentScope]; const where = [];
  if (ctx.args.search) {
    where.push("(instr(m.display_path,?)>0 OR instr(m.identifier,?)>0 OR instr(COALESCE(m.resource,''),?)>0)");
    params.push(ctx.args.search, ctx.args.search, ctx.args.search);
  }
  if (ctx.args.package) { where.push('m.package=?'); params.push(ctx.args.package); }
  if (currentScope === 'loaded') where.push('m.loaded=1');
  if (ctx.args['max-ratio'] !== undefined) {
    if (!ctx.meta.coverageAvailable) fail('METRIC_UNAVAILABLE', '--max-ratio requires a coverage input.');
    const maxRatio = float(ctx.args['max-ratio'], undefined, 1, 0, 'max-ratio');
    where.push('c.gr IS NOT NULL AND c.gr <= ?'); params.push(maxRatio);
  }
  if (ctx.args['min-unexecuted'] !== undefined) {
    if (!ctx.meta.coverageAvailable) fail('METRIC_UNAVAILABLE', '--min-unexecuted requires a coverage input.');
    const minUnexec = integer(ctx.args['min-unexecuted'], undefined, Number.MAX_SAFE_INTEGER, 0, 'min-unexecuted');
    where.push('c.gu IS NOT NULL AND c.gu >= ?'); params.push(minUnexec);
  }
  if (ctx.args['used-state'] !== undefined) {
    if (!['none', 'named', 'unknown'].includes(ctx.args['used-state']))
      fail('INVALID_ARGUMENT', '--used-state must be none, named, or unknown.');
    where.push('m.used_state=?'); params.push(ctx.args['used-state']);
  }
  return {
    scope: currentScope,
    coverageAvailable: ctx.meta.coverageAvailable,
    ...(ctx.args.fields ? { fields: ctx.args.fields.split(',') } : {}),
    ...paginate(ctx, {
      from: 'FROM modules m JOIN metrics c ON c.module_id=m.id',
      where: ['c.scope=?', ...where].join(' AND '), params,
      select: 'm.*,c.ge,c.gl,c.gx,c.gu,c.gr,c.se,c.sl,c.sx,c.su,c.sr',
      sort: MODULE_SORT,
      map: row => projection({
        ...compactModule(row, ctx.meta.context),
        coverage: { generated: metrics(row, 'g'), retainedSource: metrics(row, 's') },
        usage: usageSummary(row),
      }, ctx.args.fields),
    }),
  };
}

function queryModule(ctx) {
  const module = moduleRow(ctx);
  const currentScope = scope(ctx);
  const sources = ctx.db.prepare('SELECT s.id,s.path,s.space,s.hash FROM sources s JOIN module_sources ms ON s.id=ms.source_id WHERE ms.module_id=? ORDER BY s.id LIMIT 20').all(module.id);
  const sourceTotal = ctx.db.prepare('SELECT count(*) AS n FROM module_sources WHERE module_id=?').get(module.id).n;
  const chunks = ctx.db.prepare('SELECT c.id,c.initial,c.loaded,c.files FROM chunks c JOIN module_chunks mc ON mc.chunk_id=c.id WHERE mc.module_id=? ORDER BY c.id').all(module.id)
    .map(row => ({ chunkId: row.id, initial: Boolean(row.initial), loaded: row.loaded === null ? null : Boolean(row.loaded), files: JSON.parse(row.files) }));
  const where = ['e.module_id=?']; const params = [module.id];
  if (ctx.args.used) {
    if (!['used', 'unused', 'unknown'].includes(ctx.args.used)) fail('INVALID_ARGUMENT', '--used must be used, unused, or unknown.');
    where.push('e.used=?'); params.push(ctx.args.used);
  }
  const exportsPage = paginate(ctx, {
    command: 'module-exports',
    defaultLimit: 30,
    budget: 14 * 1024,
    from: 'FROM exports e', select: 'e.*', where: where.join(' AND '), params,
    sort: { id: 'e.id', name: 'e.path', 'usage.incomingReferences': 'e.incoming' },
    map: row => ({ exportId: row.id, exportPath: JSON.parse(row.path), compilerUsage: row.used, incomingReferences: row.incoming }),
  });
  return {
    ...compactModule(module, ctx.meta.context),
    scope: currentScope,
    chunks,
    usage: usageSummary(module),
    coverage: coverageSummary(ctx, module.id),
    providedExportCount: JSON.parse(module.provided)?.length ?? null,
    usedExports: usedSummary(module),
    moduleReferences: { incoming: module.module_incoming, outgoing: module.module_outgoing },
    sources: { items: sources.map(row => ({ sourceId: row.id, path: displayPath(row.path, ctx.meta.context), coordinateSpace: row.space, sourceHash: row.hash })), total: sourceTotal },
    exports: { providedExportsKnown: module.provided !== 'null', ...exportsPage },
    originalIds: ctx.db.prepare('SELECT adapter,original_id AS moduleId FROM aliases WHERE module_id=? ORDER BY adapter').all(module.id),
  };
}

function querySource(ctx) {
  checkRun(ctx);
  const hotspotMode = Boolean(ctx.args.unexecuted) || ctx.args.state !== undefined;
  if (hotspotMode) {
    for (const name of ['line', 'column', 'characters', 'map-source']) {
      if (ctx.args[name] !== undefined) fail('INVALID_ARGUMENT', `--${name} cannot be combined with --unexecuted or --state.`);
    }
    const module = moduleRow(ctx);
    if (!ctx.meta.coverageAvailable) fail('FEATURE_UNAVAILABLE', 'No coverage recording is indexed.');
    const currentScope = scope(ctx);
    const state = ctx.args.state;
    if (state && !['executed', 'unexecuted', 'partial', 'not-loaded', 'unknown'].includes(state))
      fail('INVALID_ARGUMENT', '--state must be executed, unexecuted, partial, not-loaded, or unknown.');
    const where = ['l.module_id=?']; const params = [module.id];
    if (ctx.args.space !== undefined) {
      if (!['resource', 'map-source', 'post-loader'].includes(ctx.args.space))
        fail('INVALID_ARGUMENT', '--space must be resource, map-source, or post-loader.');
      where.push('s.space=?'); params.push(ctx.args.space);
    }
    if (ctx.args.source) {
      const row = sourceLib.sourceRow(ctx, ctx.args.source);
      const ids = [...new Set([row.id, ...sourceLib.coverageSourceIds(ctx, row, module.id)])];
      where.push(`l.source_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
    }
    if (currentScope === 'loaded') where.push('l.gl>0');
    if (state === 'partial') {
      where.push('l.gx > 0 AND l.gu > 0');
    } else if (state) {
      where.push('l.state=?'); params.push(state);
      if (ctx.args.unexecuted) where.push('l.gu > 0');
    } else if (ctx.args.unexecuted) {
      // Include both strict unexecuted lines (gx == 0) and partially executed lines (gx > 0 && gu > 0).
      where.push('l.gu > 0');
    }
    const defaultSort = (ctx.args.unexecuted || state === 'partial') ? 'unexecutedBytes:desc' : 'line:asc';
    const session = sourceLib.createSession();
    const linesCache = new Map();
    const getLineText = (sourceId, lineNum) => {
      if (!linesCache.has(sourceId)) {
        try {
          const srow = ctx.db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
          const loaded = srow ? sourceLib.loadSource(srow, undefined, ctx.db, session) : null;
          linesCache.set(sourceId, loaded ? loaded.text.split('\n') : null);
        } catch { linesCache.set(sourceId, null); }
      }
      const list = linesCache.get(sourceId);
      if (!list || lineNum < 1 || lineNum > list.length) return null;
      const raw = list[lineNum - 1];
      const clean = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      return clean.length > 200 ? `${clean.slice(0, 200)}...` : clean;
    };
    try {
      const page = paginate(ctx, {
        from: 'FROM coverage_lines l JOIN sources s ON s.id=l.source_id', select: 'l.*', where: where.join(' AND '), params,
        defaultSort,
        sort: { id: 'l.id', line: 'l.line', generatedBytes: 'l.ge', unexecutedBytes: 'l.gu', 'coverage.generated.unexecutedBytes': 'l.gu' },
        map: row => {
          const parsedRanges = row.ranges ? JSON.parse(row.ranges) : null;
          const sourceRangeCount = Array.isArray(parsedRanges) ? parsedRanges.length : (typeof parsedRanges === 'number' ? parsedRanges : null);
          return {
            lineId: row.id, sourceId: row.source_id, line: row.line, runtimeState: row.state,
            partial: Boolean(row.gx > 0 && row.gu > 0),
            generated: row.ge === null ? null : { emittedBytes: row.ge, loadedBytes: row.gl, executedBytes: row.gx, unexecutedBytes: row.gu },
            code: getLineText(row.source_id, row.line),
            sourceRangeCount, rangePrecision: row.range_precision,
          };
        },
      });
      let lineSummary = null;
      if (page.page.total === 0) {
        const stats = ctx.db.prepare(`
          SELECT count(*) AS totalLines,
            COALESCE(sum(CASE WHEN state = 'unexecuted' THEN 1 ELSE 0 END), 0) AS unexecutedLines,
            COALESCE(sum(CASE WHEN gx > 0 AND gu > 0 THEN 1 ELSE 0 END), 0) AS partialLines,
            COALESCE(sum(CASE WHEN state = 'executed' AND (gu IS NULL OR gu = 0) THEN 1 ELSE 0 END), 0) AS fullyExecutedLines,
            COALESCE(sum(CASE WHEN state = 'not-loaded' THEN 1 ELSE 0 END), 0) AS notLoadedLines,
            COALESCE(sum(CASE WHEN state = 'unknown' THEN 1 ELSE 0 END), 0) AS unknownLines
          FROM coverage_lines WHERE module_id=?
        `).get(module.id);
        const modMetric = ctx.db.prepare('SELECT ge, gl, gx, gu FROM metrics WHERE module_id=? AND scope=?').get(module.id, currentScope);
        lineSummary = { ...stats, moduleGeneratedUnexecutedBytes: modMetric?.gu ?? null };
      }
      return {
        mode: 'lines',
        moduleId: module.id,
        modulePath: displayPath(module.display_path, ctx.meta.context),
        scope: currentScope,
        granularity: 'source-line',
        population: 'mapped-lines-only',
        ...(lineSummary ? { lineSummary } : {}),
        ...page,
      };
    } finally { session.close(); }
  }

  for (const name of ['limit', 'cursor', 'sort']) {
    if (ctx.args[name] !== undefined) fail('INVALID_ARGUMENT', `--${name} applies to --unexecuted or --state.`);
  }

  let moduleId = ctx.args.module ?? null;
  let modulePath = null;
  if (moduleId) modulePath = moduleRow(ctx, moduleId).display_path;
  if (!moduleId && !ctx.args.source) fail('INVALID_ARGUMENT', 'source requires --module or --source.');
  const row = moduleId ? sourceLib.resolveModuleSource(ctx, moduleId) : sourceLib.sourceRow(ctx, ctx.args.source);
  const value = sourceLib.loadSource(row, ctx.args['map-source'], ctx.db);
  const win = sourceLib.sourceWindow(value, ctx.args);
  const result = { mode: 'window', sourceId: row.id, moduleId, modulePath, ...win };
  if (moduleId && ctx.meta.coverageAvailable && ['resource', 'map-source'].includes(value.space)) {
    const sourceIds = [...new Set([row.id, ...sourceLib.coverageSourceIds(ctx, value, moduleId)])];
    const params = [moduleId, ...sourceIds, win.start.line, win.end.line];
    const where = `module_id=? AND source_id IN (${sourceIds.map(() => '?').join(',')}) AND line BETWEEN ? AND ?`;
    const allRows = ctx.db.prepare(`SELECT line,state,ge,gl,gx,gu FROM coverage_lines WHERE ${where} ORDER BY line`).all(...params);
    const allItems = allRows.map(r => ({
      line: r.line, runtimeState: r.state,
      emittedBytes: r.ge, loadedBytes: r.gl, executedBytes: r.gx, unexecutedBytes: r.gu,
    }));
    // Keep JSON coverage overlay within budget while passing complete items for text rendering.
    const budgeted = []; let bytes = 0;
    for (const item of allItems) {
      const sz = Buffer.byteLength(json(item));
      if (bytes + sz > 8 * 1024 && budgeted.length) break;
      budgeted.push(item); bytes += sz;
    }
    result.coverage = {
      items: budgeted,
      total: allItems.length,
      truncated: budgeted.length < allItems.length,
      sourceIds,
    };
    // Attach full map non-enumerably so text formatter can annotate every line in the window without bloating JSON.
    Object.defineProperty(result, '_coverageByLine', { value: new Map(allItems.map(item => [item.line, item])), enumerable: false });
  }
  return result;
}

function referenceWhere(ctx, moduleId, names = exportPath(ctx.args)) {
  const direction = ctx.args.direction || 'in';
  if (!['in', 'out'].includes(direction)) fail('INVALID_ARGUMENT', '--direction must be in or out.');
  if (names && direction !== 'in') fail('INVALID_ARGUMENT', 'Export filtering is supported for incoming references only.');
  const kind = ctx.args.relation || (names ? 'native' : 'all');
  if (!['native', 'module-graph', 'all'].includes(kind)) fail('INVALID_ARGUMENT', '--relation must be all, native, or module-graph.');
  const where = [`e.${direction === 'in' ? 'target' : 'origin'}=?`]; const params = [moduleId];
  if (kind !== 'all') { where.push('e.kind=?'); params.push(kind); }
  if (names) {
    const ancestors = ['null', '[]', ...names.slice(0, -1).map((_, index) => json(names.slice(0, index + 1)))];
    where.push(`e.kind='native' AND (e.id IN (SELECT edge_id FROM targets WHERE module_id=? AND path=?) OR e.target_export IN (${ancestors.map(() => '?').join(',')}))`);
    params.push(moduleId, json(names), ...ancestors);
  }
  return { where: where.join(' AND '), params, direction };
}

function edgeItem(row, paths = null, context = null) {
  return {
    edgeId: row.id,
    originModuleId: row.origin,
    originPath: displayPath(paths?.get(row.origin) ?? row.origin_path ?? null, context),
    targetModuleId: row.target,
    targetPath: displayPath(paths?.get(row.target) ?? row.target_path ?? null, context),
    originExport: JSON.parse(row.origin_export),
    targetExport: JSON.parse(row.target_export),
    relationEvidence: row.kind,
    dependencyId: row.dependency,
    dependencyType: row.dependency_type,
    rawLocation: JSON.parse(row.raw_loc),
    sourcePath: row.source_path,
    sourceLocation: JSON.parse(row.source_loc),
    active: row.active === null ? null : Boolean(row.active),
  };
}

function queryRefs(ctx) {
  checkRun(ctx);
  if (ctx.args.edge && ctx.args.module) fail('INVALID_ARGUMENT', 'Use --module or --edge, not both.');
  if (!ctx.args.edge && !ctx.args.module) fail('INVALID_ARGUMENT', 'refs requires --module or --edge.');

  if (ctx.args.edge) {
    const edgeIds = ctx.args.edge.split(',').map(s => s.trim()).filter(Boolean);
    if (!edgeIds.length || edgeIds.length > 20) fail('INVALID_ARGUMENT', '--edge accepts 1..20 comma-separated edge IDs.');
    const session = sourceLib.createSession();
    try {
      const items = [];
      let bytes = 0;
      for (const edgeId of edgeIds) {
        const row = ctx.db.prepare(`
          SELECT e.*, mo.display_path AS origin_path, mt.display_path AS target_path
          FROM edges e
          LEFT JOIN modules mo ON mo.id=e.origin
          LEFT JOIN modules mt ON mt.id=e.target
          WHERE e.id=?
        `).get(edgeId);
        if (!row) fail('REFERENCE_NOT_FOUND', `Unknown edge ID: ${edgeId}`);
        const item = { edge: edgeItem(row, null, ctx.meta.context), mapping: sourceLib.reference(ctx, row, { compact: false, session }) };
        const sz = Buffer.byteLength(json(item));
        if (bytes + sz > 26 * 1024 && items.length) break;
        items.push(item); bytes += sz;
      }
      return { mode: 'edges', items, totalRequested: edgeIds.length, returned: items.length };
    } finally { session.close(); }
  }

  const module = moduleRow(ctx);
  const filter = referenceWhere(ctx, module.id);
  const includeCode = !ctx.args['no-code'];
  const contextLines = integer(ctx.args.context, 1, 10, 0, 'context');
  const session = sourceLib.createSession();
  try {
    const page = paginate(ctx, {
      from: 'FROM edges e LEFT JOIN modules mo ON mo.id=e.origin LEFT JOIN modules mt ON mt.id=e.target',
      select: 'e.*, mo.display_path AS origin_path, mt.display_path AS target_path',
      where: filter.where, params: filter.params,
      sort: { id: 'e.id' },
      budget: 22 * 1024,
      map: row => {
        const item = edgeItem(row, null, ctx.meta.context);
        if (includeCode) {
          item.mapping = sourceLib.reference(ctx, row, { compact: true, includeCode: true, context: contextLines, session });
        } else {
          item.mapping = sourceLib.reference(ctx, row, { compact: true, includeCode: false, context: 0, session });
        }
        return item;
      },
    });
    return {
      mode: 'module',
      moduleId: module.id,
      modulePath: displayPath(module.display_path, ctx.meta.context),
      direction: filter.direction,
      contextLines: includeCode ? contextLines : null,
      graphAvailable: ctx.meta.graphAvailable,
      ...page,
    };
  } finally { session.close(); }
}

function chainEdgeItem(row, context = null) {
  const rawLocation = JSON.parse(row.raw_loc);
  const sourceLocation = JSON.parse(row.source_loc);
  return {
    edgeId: row.id,
    originModuleId: row.origin,
    originPath: displayPath(row.origin_path ?? null, context),
    targetModuleId: row.target,
    targetPath: displayPath(row.target_path ?? null, context),
    originExport: JSON.parse(row.origin_export),
    targetExport: JSON.parse(row.target_export),
    ...(rawLocation !== null ? { rawLocation } : {}),
    ...(row.source_path ? { sourcePath: row.source_path } : {}),
    ...(sourceLocation !== null ? { sourceLocation } : {}),
  };
}

function queryChain(ctx) {
  checkRun(ctx);
  const root = moduleRow(ctx);
  const names = exportPath(ctx.args);
  if (!names) fail('INVALID_ARGUMENT', 'chain requires --export-path or --export.');
  if (!ctx.meta.graphAvailable) fail('FEATURE_UNAVAILABLE', 'Native export graph is unavailable. Inspect module-graph references with `refs --relation module-graph`.');
  const maxDepth = integer(ctx.args.depth, 5, 20, 1, 'depth');
  const maxEdges = integer(ctx.args['max-edges'], 100, 500, 1, 'max-edges');
  const wantCode = !ctx.args['no-code'];
  const contextLines = integer(ctx.args.context, 0, 5, 0, 'context');

  const rawEdgeRows = new Map();
  const runBfs = budget => {
    const queue = [{ moduleId: root.id, exportPath: names, depth: 0, ancestors: [] }];
    const visited = new Set(); const ids = new Set(); const edges = []; const frontier = []; const terminals = []; const cycles = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { ancestors, ...state } = queue[cursor]; const key = json([state.moduleId, state.exportPath]);
      if (visited.has(key)) continue; visited.add(key);
      const args = { module: state.moduleId, 'export-path': json(state.exportPath), direction: 'in', relation: 'native', limit: String(Math.min(200, Math.max(1, budget - edges.length))) };
      const child = { ...ctx, command: 'refs', args };
      const filter = referenceWhere(child, state.moduleId, state.exportPath);
      const total = ctx.db.prepare(`SELECT count(*) AS n FROM edges e WHERE ${filter.where}`).get(...filter.params).n;
      if (!total) { terminals.push({ ...state, reason: 'no-captured-incoming-edge' }); continue; }
      if (state.depth >= maxDepth || edges.length >= budget) { frontier.push({ ...state, reason: 'query-budget', query: { command: 'refs', ...args } }); continue; }
      const page = paginate(child, {
        from: 'FROM edges e LEFT JOIN modules mo ON mo.id=e.origin LEFT JOIN modules mt ON mt.id=e.target',
        select: 'e.*, mo.display_path AS origin_path, mt.display_path AS target_path',
        where: filter.where, params: filter.params, sort: { id: 'e.id' },
        map: row => { rawEdgeRows.set(row.id, row); return chainEdgeItem(row, ctx.meta.context); },
      });
      for (const edge of page.items) {
        if (!ids.has(edge.edgeId)) { ids.add(edge.edgeId); edges.push(edge); }
        if (edge.originExport?.length) {
          const nextKey = json([edge.originModuleId, edge.originExport]);
          if ([...ancestors, key].includes(nextKey)) cycles.push({ edgeId: edge.edgeId, moduleId: edge.originModuleId, exportPath: edge.originExport });
          else queue.push({ moduleId: edge.originModuleId, exportPath: edge.originExport, depth: state.depth + 1, ancestors: [...ancestors, key] });
        } else {
          terminals.push({ moduleId: edge.originModuleId, edgeId: edge.edgeId, reason: 'no-named-origin-export' });
        }
      }
      if (page.page.nextCursor) frontier.push({ ...state, reason: 'page-budget', query: { command: 'refs', ...args, cursor: page.page.nextCursor } });
    }
    const involvedIds = [
      root.id,
      ...edges.flatMap(e => [e.originModuleId, e.targetModuleId]),
      ...terminals.map(t => t.moduleId),
      ...cycles.map(c => c.moduleId),
      ...frontier.map(f => f.moduleId),
    ];
    const paths = modulePathMap(ctx, involvedIds);
    const uniqueModIds = [...paths.keys()];
    const modStats = uniqueModIds.length
      ? ctx.db.prepare(`
          SELECT m.id, m.display_path, m.loaded, c.gu, c.gr
          FROM modules m LEFT JOIN metrics c ON c.module_id=m.id AND c.scope='build'
          WHERE m.id IN (${uniqueModIds.map(() => '?').join(',')})
          ORDER BY m.id
        `).all(...uniqueModIds).map(r => ({
          moduleId: r.id, path: displayPath(r.display_path, ctx.meta.context),
          loaded: r.loaded === null ? null : Boolean(r.loaded),
          unexecutedBytes: r.gu ?? null, executionRatio: r.gr ?? null,
        }))
      : [];
    return {
      root: { moduleId: root.id, path: displayPath(root.display_path, ctx.meta.context), exportPath: names },
      coverageAvailable: ctx.meta.coverageAvailable,
      edges,
      terminals: terminals.map(t => ({ ...t, path: paths.get(t.moduleId) ?? null })),
      cycles: cycles.map(c => ({ ...c, path: paths.get(c.moduleId) ?? null })),
      frontier: frontier.map(f => ({ ...f, path: paths.get(f.moduleId) ?? null })),
      modules: modStats,
      truncated: frontier.length > 0, maxDepth, maxEdges: budget,
    };
  };

  let budget = maxEdges;
  let result = runBfs(budget);
  // Attach mapped locations and code previews when chain is compact enough to stay within budget.
  const attachSnippets = (res, withCode) => {
    const session = sourceLib.createSession();
    try {
      return {
        ...res,
        edges: res.edges.map(edge => {
          const rawRow = rawEdgeRows.get(edge.edgeId);
          if (!rawRow) return edge;
          return { ...edge, mapping: sourceLib.reference(ctx, rawRow, { compact: true, includeCode: withCode, context: contextLines, session }) };
        }),
      };
    } finally { session.close(); }
  };

  if (result.edges.length <= 25) {
    const enriched = attachSnippets(result, wantCode);
    if (Buffer.byteLength(json(enriched)) <= 28 * 1024) return enriched;
    if (wantCode) {
      const noCode = attachSnippets(result, false);
      if (Buffer.byteLength(json(noCode)) <= 28 * 1024) return noCode;
    }
  }
  while (Buffer.byteLength(json(result)) > 28 * 1024 && budget > 1) {
    budget = Math.max(1, Math.floor(budget / 2));
    result = runBfs(budget);
  }
  return result;
}

function budgetItems(rows, maxBytes, maxCount = rows.length) {
  const out = []; let bytes = 0;
  for (const item of rows) {
    if (out.length >= maxCount) break;
    const sz = Buffer.byteLength(json(item)) + 1;
    if (bytes + sz > maxBytes && out.length) break;
    out.push(item); bytes += sz;
  }
  return out;
}

function queryChunks(ctx) {
  checkRun(ctx);
  if (ctx.args.group && ctx.args.chunk) fail('INVALID_ARGUMENT', 'Use --group or --chunk, not both.');
  const section = ctx.args.section;
  if ((section && !ctx.args.group) || (ctx.args.offset !== undefined && !section))
    fail('INVALID_ARGUMENT', '--section requires --group, and --offset requires --section.');
  if (section && !['chunks', 'origins', 'candidates'].includes(section))
    fail('INVALID_ARGUMENT', '--section must be chunks, origins, or candidates.');
  if ((ctx.args.group || ctx.args.chunk) && (ctx.args['multi-origin'] || ctx.args.loaded || ctx.args.search !== undefined))
    fail('INVALID_ARGUMENT', '--multi-origin, --loaded, and --search apply to the chunks overview (without --group/--chunk).');

  if (ctx.args.chunk) {
    const chunk = ctx.db.prepare('SELECT * FROM chunks WHERE id=?').get(ctx.args.chunk);
    if (!chunk) fail('CHUNK_NOT_FOUND', `Unknown chunk ID: ${ctx.args.chunk}. List chunks with \`chunks\`.`);
    const defaultSort = ctx.meta.coverageAvailable ? 'coverage.generated.unexecutedBytes:desc' : 'id:asc';
    return {
      mode: 'chunk',
      coverageAvailable: ctx.meta.coverageAvailable,
      chunk: {
        chunkId: chunk.id, initial: Boolean(chunk.initial),
        loaded: chunk.loaded === null ? null : Boolean(chunk.loaded),
        files: JSON.parse(chunk.files), runtime: JSON.parse(chunk.runtime),
        generated: chunk.emitted_bytes === null ? null : {
          emittedBytes: chunk.emitted_bytes, loadedBytes: chunk.loaded_bytes,
          executedBytes: chunk.executed_bytes, unexecutedBytes: chunk.unexecuted_bytes,
          executionRatio: chunk.loaded_bytes > 0 && chunk.executed_bytes !== null ? chunk.executed_bytes / chunk.loaded_bytes : null,
        },
      },
      ...paginate(ctx, {
        from: 'FROM module_chunks mc JOIN modules m ON m.id=mc.module_id JOIN metrics c ON c.module_id=m.id',
        where: "mc.chunk_id=? AND c.scope='build'",
        params: [chunk.id],
        select: 'm.*,c.ge,c.gl,c.gx,c.gu,c.gr,c.se,c.sl,c.sx,c.su,c.sr,(SELECT count(*) FROM module_chunks mc2 WHERE mc2.module_id=m.id) AS chunk_count',
        defaultSort,
        sort: MODULE_SORT,
        map: row => ({ ...compactModule(row, ctx.meta.context), chunkCount: row.chunk_count, coverage: { generated: metrics(row, 'g') }, usage: usageSummary(row) }),
      }),
    };
  }

  if (ctx.args.group) {
    let group = ctx.db.prepare('SELECT * FROM chunk_groups WHERE id=?').get(ctx.args.group);
    if (!group) {
      const byName = ctx.db.prepare('SELECT * FROM chunk_groups WHERE name=?').all(ctx.args.group);
      if (byName.length === 1) group = byName[0];
    }
    if (!group) fail('CHUNK_GROUP_NOT_FOUND', `Unknown chunk group: ${ctx.args.group}. List chunk groups with \`chunks\`.`);
    const chunkIds = JSON.parse(group.chunks);
    const originsRaw = JSON.parse(group.origins);
    const parents = JSON.parse(group.parents).filter(p => p && p !== 'undefined');
    const chunks = chunkIds.length
      ? ctx.db.prepare(`SELECT * FROM chunks WHERE id IN (${chunkIds.map(() => '?').join(',')}) ORDER BY id`).all(...chunkIds).map(row => ({
          chunkId: row.id, initial: Boolean(row.initial),
          loaded: row.loaded === null ? null : Boolean(row.loaded),
          files: JSON.parse(row.files),
          moduleCount: ctx.db.prepare('SELECT count(*) AS n FROM module_chunks WHERE chunk_id=?').get(row.id).n,
          generated: row.emitted_bytes === null ? null : {
            emittedBytes: row.emitted_bytes, loadedBytes: row.loaded_bytes,
            executedBytes: row.executed_bytes, unexecutedBytes: row.unexecuted_bytes,
          },
        }))
      : [];
    const groupModRows = chunkIds.length
      ? ctx.db.prepare(`
          SELECT DISTINCT m.id, m.display_path, m.loaded, c.ge, c.gl, c.gx, c.gu, c.gr
          FROM module_chunks mc
          JOIN modules m ON m.id=mc.module_id
          LEFT JOIN metrics c ON c.module_id=m.id AND c.scope='build'
          WHERE mc.chunk_id IN (${chunkIds.map(() => '?').join(',')})
          ORDER BY m.id
        `).all(...chunkIds)
      : [];
    const groupModMap = new Map(groupModRows.map(r => [r.id, r]));
    const groupModSet = new Set(groupModMap.keys());

    const adj = new Map();
    if (groupModSet.size) {
      const placeholders = [...groupModSet].map(() => '?').join(',');
      const edgeRows = ctx.db.prepare(`
        SELECT origin, target, kind, dependency_type
        FROM edges
        WHERE origin IN (${placeholders}) AND target IN (${placeholders})
      `).all(...groupModSet, ...groupModSet);
      for (const e of edgeRows) {
        if (e.kind === 'module-graph' && /import\(\)|context|async/i.test(e.dependency_type || '')) continue;
        if (!adj.has(e.origin)) adj.set(e.origin, new Set());
        adj.get(e.origin).add(e.target);
      }
    }

    const originPaths = modulePathMap(ctx, originsRaw.map(o => o.moduleId));
    const bfsFrom = seeds => {
      const visited = new Set(seeds.filter(id => groupModSet.has(id)));
      const queue = [...visited];
      for (let i = 0; i < queue.length; i++) {
        for (const next of adj.get(queue[i]) || []) {
          if (!visited.has(next)) { visited.add(next); queue.push(next); }
        }
      }
      return visited;
    };

    const origins = originsRaw.map(origin => {
      const modId = origin.moduleId;
      const entryIds = new Set();
      if (modId && groupModSet.has(modId)) entryIds.add(modId);
      if (modId && groupModSet.size) {
        if (origin.request) {
          const matched = ctx.db.prepare('SELECT DISTINCT target FROM edges WHERE origin=? AND request=?').all(modId, origin.request);
          for (const row of matched) if (groupModSet.has(row.target)) entryIds.add(row.target);
        }
        if (!entryIds.size) {
          const out = ctx.db.prepare('SELECT DISTINCT target FROM edges WHERE origin=?').all(modId);
          for (const row of out) if (groupModSet.has(row.target)) entryIds.add(row.target);
        }
      }
      const reachable = bfsFrom([...entryIds]);
      const entryStats = [...entryIds].map(id => groupModMap.get(id)).filter(Boolean);
      const anyExecuted = entryStats.some(m => m.gx !== null && m.gx > 0);
      const allKnownZero = entryStats.length > 0 && entryStats.every(m => m.gx !== null && m.gx === 0);
      const status = !ctx.meta.coverageAvailable || !entryStats.length ? 'unknown'
        : anyExecuted ? 'executed' : allKnownZero ? 'unexecuted' : 'unknown';
      return {
        moduleId: modId,
        path: originPaths.get(modId) ?? null,
        request: origin.request,
        entryModuleIds: [...entryIds],
        entryPaths: [...entryIds].map(id => displayPath(groupModMap.get(id)?.display_path ?? null, ctx.meta.context)),
        executionStatus: status,
        reachableModuleCount: reachable.size,
        _reachable: reachable,
      };
    });

    const executedOrigins = origins.filter(o => o.executionStatus === 'executed');
    const unexecutedOrigins = origins.filter(o => o.executionStatus === 'unexecuted');
    const executedReachable = new Set();
    for (const o of executedOrigins) for (const id of o._reachable) executedReachable.add(id);
    const unexecutedOnlyIds = new Set();
    if (executedOrigins.length > 0 && unexecutedOrigins.length > 0) {
      for (const o of unexecutedOrigins) {
        for (const id of o._reachable) if (!executedReachable.has(id)) unexecutedOnlyIds.add(id);
      }
    }
    const toCandidate = m => ({
      moduleId: m.id, path: displayPath(m.display_path, ctx.meta.context),
      emittedBytes: m.ge ?? null, loadedBytes: m.gl ?? null, executedBytes: m.gx ?? null, unexecutedBytes: m.gu ?? null,
    });
    const unnecessaryCandidates = [...unexecutedOnlyIds].map(id => groupModMap.get(id)).filter(Boolean)
      .sort((a, b) => (b.gu ?? -1) - (a.gu ?? -1) || a.id.localeCompare(b.id));
    const candidateBytes = unnecessaryCandidates.reduce((sum, m) => sum + (m.gu ?? 0), 0);
    const allOrigins = origins.map(({ _reachable, ...rest }) => rest);
    const allCandidates = unnecessaryCandidates.map(toCandidate);

    const loadedChunksCount = chunks.filter(c => c.loaded === true).length;
    const unknownChunksCount = chunks.filter(c => c.loaded === null).length;
    const groupMeta = {
      groupId: group.id, name: group.name, parents,
      multiOrigin: origins.length > 1,
      totalModules: groupModRows.length,
      chunksTotal: chunks.length,
      loadedChunks: ctx.meta.coverageAvailable ? loadedChunksCount : null,
      unknownChunks: ctx.meta.coverageAvailable ? unknownChunksCount : null,
      originsTotal: allOrigins.length,
    };
    const analysisBase = {
      coverageAvailable: ctx.meta.coverageAvailable,
      executedOriginCount: executedOrigins.length,
      unexecutedOriginCount: unexecutedOrigins.length,
      unnecessaryCandidateCount: allCandidates.length,
      unnecessaryCandidateBytes: ctx.meta.coverageAvailable ? candidateBytes : null,
    };

    if (section) {
      const rows = { chunks, origins: allOrigins, candidates: allCandidates }[section];
      const offset = integer(ctx.args.offset, 0, Number.MAX_SAFE_INTEGER, 0, 'offset');
      const limit = integer(ctx.args.limit, 20, 200, 1, 'limit');
      const slice = rows.slice(offset, offset + limit);
      const items = budgetItems(slice, 24 * 1024, limit);
      const nextOffset = offset + items.length < rows.length ? offset + items.length : null;
      return {
        mode: 'group',
        section,
        sectionPage: { offset, total: rows.length, returned: items.length, nextOffset },
        group: groupMeta,
        chunks: section === 'chunks' ? items : [],
        origins: section === 'origins' ? items : [],
        analysis: { ...analysisBase, candidates: section === 'candidates' ? items : [] },
      };
    }

    return {
      mode: 'group',
      group: groupMeta,
      chunks: budgetItems(chunks, 6 * 1024, 30),
      origins: budgetItems(allOrigins, 8 * 1024, 30),
      analysis: { ...analysisBase, candidates: budgetItems(allCandidates, 8 * 1024, 30) },
    };
  }

  // Default: list chunk groups (with optional --multi-origin, --loaded, --search filters)
  const where = []; const params = [];
  if (ctx.args['multi-origin']) where.push('json_array_length(cg.origins) > 1');
  if (ctx.args.loaded) {
    if (!ctx.meta.coverageAvailable) fail('METRIC_UNAVAILABLE', '--loaded requires a coverage input.');
    // Require ALL chunks in the group to be loaded so unloaded async groups sharing a loaded common chunk do not false-positive.
    where.push('json_array_length(cg.chunks) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(cg.chunks) jc LEFT JOIN chunks ch ON ch.id=jc.value WHERE ch.loaded IS NULL OR ch.loaded != 1)');
  }
  if (ctx.args.search) {
    where.push("(instr(COALESCE(cg.name,''),?)>0 OR instr(cg.id,?)>0 OR instr(cg.origins,?)>0)");
    params.push(ctx.args.search, ctx.args.search, ctx.args.search);
  }
  const chunkGroupSort = {
    id: 'cg.id',
    name: 'cg.name',
    originCount: 'json_array_length(cg.origins)',
    emittedBytes: '(SELECT CASE WHEN count(*)=0 OR sum(CASE WHEN ch.emitted_bytes IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE sum(ch.emitted_bytes) END FROM json_each(cg.chunks) jc JOIN chunks ch ON ch.id=jc.value)',
    unexecutedBytes: '(SELECT CASE WHEN count(*)=0 OR sum(CASE WHEN ch.unexecuted_bytes IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE sum(ch.unexecuted_bytes) END FROM json_each(cg.chunks) jc JOIN chunks ch ON ch.id=jc.value)',
  };
  const groupsPage = paginate(ctx, {
    command: 'chunks',
    defaultLimit: 20,
    budget: 20 * 1024,
    from: 'FROM chunk_groups cg',
    select: 'cg.*',
    where: where.join(' AND ') || '1', params,
    sort: chunkGroupSort,
    map: row => {
      const chunkIds = JSON.parse(row.chunks);
      const originsRaw = JSON.parse(row.origins);
      const originPaths = modulePathMap(ctx, originsRaw.map(o => o.moduleId));
      const chunkRows = chunkIds.length
        ? ctx.db.prepare(`SELECT * FROM chunks WHERE id IN (${chunkIds.map(() => '?').join(',')}) ORDER BY id`).all(...chunkIds)
        : [];
      const modCount = chunkIds.length
        ? ctx.db.prepare(`SELECT count(DISTINCT module_id) AS n FROM module_chunks WHERE chunk_id IN (${chunkIds.map(() => '?').join(',')})`).get(...chunkIds).n
        : 0;
      const totalChunks = chunkRows.length;
      const loadedChunks = chunkRows.filter(c => c.loaded === 1).length;
      const unloadedChunks = chunkRows.filter(c => c.loaded === 0).length;
      const unknownChunks = chunkRows.filter(c => c.loaded === null).length;
      const loadState = !totalChunks ? 'unknown'
        : loadedChunks === totalChunks ? 'loaded'
        : unloadedChunks > 0 ? (loadedChunks > 0 ? 'shared-only' : 'not-loaded')
        : (loadedChunks > 0 ? 'partial-unknown' : 'unknown');
      const loaded = loadState === 'loaded' ? true : (loadState === 'not-loaded' || loadState === 'shared-only') ? false : null;
      const emittedSum = chunkRows.length && chunkRows.every(c => c.emitted_bytes !== null)
        ? chunkRows.reduce((s, c) => s + c.emitted_bytes, 0) : null;
      const unexecSum = chunkRows.length && chunkRows.every(c => c.unexecuted_bytes !== null)
        ? chunkRows.reduce((s, c) => s + c.unexecuted_bytes, 0) : null;
      return {
        groupId: row.id, name: row.name, chunkIds,
        files: chunkRows.flatMap(c => JSON.parse(c.files)),
        initial: chunkRows.some(c => c.initial === 1),
        loaded,
        loadState,
        loadedChunks,
        totalChunks,
        unknownChunks,
        moduleCount: modCount,
        emittedBytes: emittedSum,
        unexecutedBytes: unexecSum,
        originCount: originsRaw.length,
        multiOrigin: originsRaw.length > 1,
        origins: originsRaw.slice(0, 5).map(o => ({ moduleId: o.moduleId, path: originPaths.get(o.moduleId) ?? null, request: o.request })),
      };
    },
  });
  const chunkTotal = ctx.db.prepare('SELECT count(*) AS n FROM chunks').get().n;
  const totalGroupsAll = ctx.db.prepare('SELECT count(*) AS n FROM chunk_groups').get().n;
  // Only include standalone chunk list when the dataset has no chunk_groups (avoid dumping 50 chunks on every overview).
  const chunkRows = [];
  if (totalGroupsAll === 0) {
    const chunkLimit = integer(ctx.args.limit, 20, 200, 1, 'limit');
    let chunkBytes = 0;
    for (const row of ctx.db.prepare('SELECT * FROM chunks ORDER BY id LIMIT ?').iterate(chunkLimit)) {
      const item = {
        chunkId: row.id, initial: Boolean(row.initial),
        loaded: row.loaded === null ? null : Boolean(row.loaded),
        files: JSON.parse(row.files),
        moduleCount: ctx.db.prepare('SELECT count(*) AS n FROM module_chunks WHERE chunk_id=?').get(row.id).n,
        generated: row.emitted_bytes === null ? null : {
          emittedBytes: row.emitted_bytes, loadedBytes: row.loaded_bytes,
          executedBytes: row.executed_bytes, unexecutedBytes: row.unexecuted_bytes,
        },
      };
      const sz = Buffer.byteLength(json(item));
      if (chunkBytes + sz > 16 * 1024 && chunkRows.length) break;
      chunkRows.push(item); chunkBytes += sz;
    }
  }
  return {
    mode: 'overview',
    coverageAvailable: ctx.meta.coverageAvailable,
    filters: {
      ...(ctx.args['multi-origin'] ? { multiOrigin: true } : {}),
      ...(ctx.args.loaded ? { loaded: true } : {}),
      ...(ctx.args.search ? { search: ctx.args.search } : {}),
    },
    ...groupsPage,
    chunks: { items: chunkRows, total: chunkTotal },
  };
}

function runQuery(ctx) {
  if (ctx.command === 'status') return queryStatus(ctx);
  if (ctx.command === 'chunks') return queryChunks(ctx);
  if (ctx.command === 'modules') return queryModules(ctx);
  if (ctx.command === 'module') return queryModule(ctx);
  if (ctx.command === 'source') return querySource(ctx);
  if (ctx.command === 'refs') return queryRefs(ctx);
  if (ctx.command === 'chain') return queryChain(ctx);
  fail('INVALID_ARGUMENT', `Unknown command: ${ctx.command}.`);
}

module.exports = { runQuery, MODULE_SORT, metrics, referenceWhere };
