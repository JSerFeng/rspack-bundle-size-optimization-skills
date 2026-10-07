const { mkdirSync, readFileSync, renameSync } = require('node:fs');
const { resolve, isAbsolute, relative } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore, setMeta, ensureModule, addEdge, hash, prepare } = require('./usage-store.cjs');

const NAME = 'UsageGraphCapturePlugin';
const safely = (read, fallback = null) => { try { return read() ?? fallback; } catch { return fallback; } };
const exportPath = value => value === null || (Array.isArray(value) && value.every(x => typeof x === 'string'));

class UsageGraphCapturePlugin {
  constructor(options = {}) { this.options = options; }

  apply(compiler) {
    const directory = resolve(compiler.context, this.options.directory || '.rspack-usage');
    const output = compiler.options.output?.path;
    if (output) {
      const rel = relative(resolve(output), directory);
      if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) {
        throw new Error(`${NAME}: snapshot directory must be outside output.path (output.clean can delete it)`);
      }
    }
    const locationSpace = this.options.locationSpace || 'auto';
    if (!['auto', 'resource', 'post-loader'].includes(locationSpace)) throw new Error('Invalid locationSpace');
    const columnBase = this.options.columnBase ?? 1;
    if (![0, 1].includes(columnBase)) throw new Error('columnBase must be 0 or 1');
    const Plugin = compiler.webpack.experiments?.RsdoctorPlugin;
    const captures = new WeakMap();
    let active = null;
    if (Plugin?.getCompilationHooks) new Plugin({
      moduleGraphFeatures: ['graph'], chunkGraphFeatures: false, exportUsageGraph: true,
    }).apply(compiler);

    compiler.hooks.thisCompilation.tap(NAME, compilation => {
      mkdirSync(directory, { recursive: true });
      const run = `${Date.now()}-${randomUUID()}`;
      const pendingPath = resolve(directory, `${run}.incomplete.sqlite`);
      const db = createStore(pendingPath, {
        run, compiler: compiler.name || compiler.options.name || null,
        context: compiler.context, rspackVersion: compiler.webpack.rspackVersion || null,
        createdAt: new Date().toISOString(), locationSpace, columnBase,
        coordinateUnit: 'unverified; queries use UTF-16',
        optimization: Object.fromEntries(['usedExports', 'innerGraph', 'sideEffects', 'concatenateModules']
          .map(key => [key, compiler.options.optimization[key] ?? null])),
      });
      const state = { db, pendingPath, finalPath: resolve(directory, `${run}.sqlite`), closed: false, richest: -1 };
      captures.set(compilation, state);
      active = state;
      // Keep source identities before concatenation or tree-shaking removes wrappers.
      compilation.hooks.finishModules.tap(NAME, modules => {
        const seen = new Set();
        const visit = (module, parent = null) => {
          if (seen.has(module)) return;
          seen.add(module);
          const identifier = module.identifier();
          const id = ensureModule(db, identifier, module.layer);
          const source = safely(() => module.originalSource());
          const sourceAndMap = safely(() => source?.sourceAndMap({ columns: true }));
          const rawText = sourceAndMap?.source ?? safely(() => source?.source());
          const transformed = rawText == null ? null : Buffer.isBuffer(rawText) ? rawText.toString('utf8') : String(rawText);
          const map = sourceAndMap?.map ?? safely(() => source?.map({ columns: true }));
          const resource = safely(() => module.nameForCondition());
          const content = resource && isAbsolute(resource) ? safely(() => readFileSync(resource, 'utf8')) : null;
          prepare(db, `UPDATE modules SET type=?, resource=?, parent_id=?, transformed=?, source_map=?,
            resource_content=?, transformed_hash=?, resource_hash=?, source_gap=? WHERE id=?`).run(
            module.type || null, resource, parent, transformed, map ? JSON.stringify(map) : null,
            content, transformed === null ? null : hash(transformed), content === null ? null : hash(content),
            transformed === null ? 'post-loader source unavailable' : null, id);
          for (const child of module.modules || []) visit(child, id);
        };
        db.exec('BEGIN');
        try { for (const module of modules) visit(module); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      if (Plugin?.getCompilationHooks) Plugin.getCompilationHooks(compilation).moduleGraph.tapPromise(NAME, async payload => {
        if (state.closed) return;
        if (!Array.isArray(payload.exportUsageEdges) || payload.exportUsageEdges.length <= state.richest) return;
        const lookup = new Map();
        let discarded = 0;
        db.exec('BEGIN');
        try {
          for (const module of payload.modules || []) {
            if (Number.isSafeInteger(module.ukey) && typeof module.identifier === 'string') {
              lookup.set(module.ukey, ensureModule(db, module.identifier, module.layer));
            }
          }
          db.exec('DELETE FROM targets; DELETE FROM edges;');
          for (const tuple of payload.exportUsageEdges) {
            if (!Array.isArray(tuple) || tuple.length < 6 || !lookup.has(tuple[0]) || !lookup.has(tuple[2]) ||
                !exportPath(tuple[1]) || !exportPath(tuple[3]) || typeof tuple[4] !== 'string' ||
                (tuple[5] !== null && typeof tuple[5] !== 'string')) { discarded++; continue; }
            addEdge(db, { origin: lookup.get(tuple[0]), originExport: tuple[1], target: lookup.get(tuple[2]),
              targetExport: tuple[3], dependency: tuple[4], loc: tuple[5] });
          }
          setMeta(db, { graphAvailable: true, discardedEdges: discarded, captureError: null });
          db.exec('COMMIT');
          state.richest = payload.exportUsageEdges.length;
        } catch (error) {
          db.exec('ROLLBACK');
          setMeta(db, { captureError: error.message });
          compilation.warnings.push(new Error(`${NAME}: usage graph capture failed: ${error.message}`));
        }
      });
    });

    compiler.hooks.done.tap(NAME, stats => {
      const state = captures.get(stats.compilation);
      if (!state || state.closed) return;
      const { db } = state;
      if (!stats.hasErrors()) {
        // ModuleGraph's binding accepts a runtime name or an array of names,
        // not webpack's internal Set representation or an omitted runtime.
        const runtimes = [...new Set([...stats.compilation.chunks].flatMap(chunk =>
          typeof chunk.runtime === 'string' ? [chunk.runtime] : [...(chunk.runtime || [])]))].sort();
        let usedExportsErrors = 0;
        const usedExportsErrorSamples = [];
        const seen = new Set();
        const visit = (module, parent = null) => {
          const id = ensureModule(db, module.identifier(), module.layer);
          if (parent) prepare(db, 'UPDATE modules SET parent_id=? WHERE id=?').run(parent, id);
          if (seen.has(module)) return;
          seen.add(module);
          const provided = safely(() => stats.compilation.moduleGraph.getProvidedExports(module));
          let used = null;
          try { used = stats.compilation.moduleGraph.getUsedExports(module, runtimes) ?? null; }
          catch (error) {
            usedExportsErrors++;
            if (usedExportsErrorSamples.length < 10) usedExportsErrorSamples.push({ module: id, error: error.message });
          }
          prepare(db, 'UPDATE modules SET provided=?, used=?, parent_id=COALESCE(?, parent_id) WHERE id=?')
            .run(JSON.stringify(provided), JSON.stringify(used instanceof Set ? [...used] : used), parent, id);
          for (const child of module.modules || []) visit(child, id);
        };
        // A large compilation can finalize tens of thousands of modules. Keep
        // these updates in one transaction, as in the earlier capture phases,
        // instead of committing (and syncing) every individual row to disk.
        db.exec('BEGIN');
        try {
          for (const module of stats.compilation.modules) visit(module);
          setMeta(db, { usedExportsRuntimes: runtimes, usedExportsErrors, usedExportsErrorSamples });
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      setMeta(db, { status: stats.hasErrors() ? 'failed' : 'complete', buildHash: stats.hash || null,
        moduleCount: db.prepare('SELECT count(*) AS n FROM modules').get().n,
        edgeCount: db.prepare('SELECT count(*) AS n FROM edges').get().n });
      db.close(); state.closed = true;
      if (!stats.hasErrors()) {
        renameSync(state.pendingPath, state.finalPath);
        process.stderr.write(`[${NAME}] ${state.finalPath}\n`);
        this.options.onSnapshot?.(state.finalPath);
      }
    });
    const closeIncomplete = () => {
      if (active && !active.closed) {
        setMeta(active.db, { status: 'failed' }); active.db.close(); active.closed = true;
      }
    };
    compiler.hooks.failed.tap(NAME, closeIncomplete);
    compiler.hooks.shutdown.tap(NAME, closeIncomplete);
  }
}

module.exports = { UsageGraphCapturePlugin };
