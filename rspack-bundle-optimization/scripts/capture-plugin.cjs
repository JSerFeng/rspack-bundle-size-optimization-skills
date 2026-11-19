const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCapture, ensureModule, addEdge, addGap, prepare, setMeta, hash, id, json } = require('./lib/capture-store.cjs');

const NAME = 'BundleEvidencePlugin';
const safely = (read, fallback = null) => { try { return read() ?? fallback; } catch { return fallback; } };
const text = value => value == null ? null : Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
const exportPath = value => value === null || (Array.isArray(value) && value.every(name => typeof name === 'string'));

class BundleEvidencePlugin {
  constructor(options = {}) { this.options = options; }
  apply(compiler) {
    const directory = path.resolve(compiler.context, this.options.directory || '.rspack-bundle');
    const output = compiler.options.output?.path;
    const relative = output ? path.relative(path.resolve(output), directory) : '..';
    if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
      throw new Error(`${NAME}: evidence directory must be outside output.path.`);
    const Native = compiler.webpack.experiments?.RsdoctorPlugin;
    if (Native?.getCompilationHooks) new Native({ moduleGraphFeatures: ['graph'], chunkGraphFeatures: false, exportUsageGraph: true }).apply(compiler);
    const captures = new WeakMap(); let active;
    const closeFailed = () => {
      if (active && !active.closed) { setMeta(active.db, { status: 'failed' }); active.db.close(); active.closed = true; }
    };
    compiler.hooks.thisCompilation.tap(NAME, compilation => {
      closeFailed(); fs.mkdirSync(directory, { recursive: true });
      const run = `${Date.now()}-${randomUUID()}`;
      const pending = path.join(directory, `${run}.incomplete.sqlite`); const final = path.join(directory, `${run}.sqlite`);
      const db = createCapture(pending, { context: fs.realpathSync(compiler.context), compiler: compiler.name || compiler.options.name || null,
        rspackVersion: compiler.webpack.rspackVersion || null, run, columnBase: 1, locationSpace: this.options.locationSpace || 'post-loader',
        optimization: Object.fromEntries(['usedExports', 'innerGraph', 'sideEffects', 'concatenateModules', 'minimize'].map(key => [key, compiler.options.optimization?.[key] ?? null])) });
      const state = { db, pending, final, closed: false }; captures.set(compilation, state); active = state;
      const visit = (module, parent, seen, captureText) => {
        if (seen.has(module)) return ensureModule(db, module.identifier(), module.layer);
        seen.add(module); const key = ensureModule(db, module.identifier(), module.layer);
        const resource = safely(() => module.nameForCondition());
        if (captureText) {
          const source = safely(() => module.originalSource()); const pair = safely(() => source?.sourceAndMap({ columns: true }));
          const transformed = text(pair?.source ?? safely(() => source?.source()));
          const map = pair?.map ?? safely(() => source?.map({ columns: true }));
          const content = resource && path.isAbsolute(resource) ? safely(() => fs.readFileSync(resource, 'utf8')) : null;
          prepare(db, `UPDATE modules SET type=?,resource=?,parent_id=?,transformed=?,source_map=?,resource_content=?,
            transformed_hash=?,resource_hash=?,source_gap=? WHERE id=?`).run(module.type ?? null, resource, parent,
            transformed, map ? json(map) : null, content, transformed === null ? null : hash(transformed), content === null ? null : hash(content),
            transformed === null ? 'Post-loader source was not captured.' : null, key);
        }
        for (const child of module.modules || []) visit(child, key, seen, captureText);
        return key;
      };
      compilation.hooks.finishModules.tap(NAME, modules => {
        db.exec('BEGIN');
        try { const seen = new Set(); for (const module of modules) visit(module, null, seen, true); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      if (Native?.getCompilationHooks) Native.getCompilationHooks(compilation).moduleGraph.tapPromise(NAME, async payload => {
        if (state.closed || !Array.isArray(payload.exportUsageEdges)) return;
        db.exec('BEGIN');
        try {
          const lookup = new Map(); let discarded = 0;
          for (const m of payload.modules || []) if (Number.isSafeInteger(m.ukey) && typeof m.identifier === 'string') {
            const captured = prepare(db, 'SELECT id FROM modules WHERE identifier=? AND (resource IS NOT NULL OR transformed IS NOT NULL)').all(m.identifier);
            if (m.layer === undefined && captured.length === 1) lookup.set(m.ukey, captured[0].id);
            else if (m.layer === undefined && captured.length > 1) addGap(db, null, 'native-module-layer', { identifier: m.identifier, message: 'Native graph omits layer and several captured instances match.' });
            else lookup.set(m.ukey, ensureModule(db, m.identifier, m.layer));
          }
          db.exec('DELETE FROM edges;');
          for (const tuple of payload.exportUsageEdges) {
            if (!Array.isArray(tuple) || !lookup.has(tuple[0]) || !lookup.has(tuple[2]) || !exportPath(tuple[1]) || !exportPath(tuple[3]) ||
              typeof tuple[4] !== 'string' || (tuple[5] !== null && typeof tuple[5] !== 'string')) { discarded++; continue; }
            addEdge(db, { origin: lookup.get(tuple[0]), originExport: tuple[1], target: lookup.get(tuple[2]), targetExport: tuple[3], dependency: tuple[4], loc: tuple[5] });
          }
          setMeta(db, { graphAvailable: true, discardedEdges: discarded }); db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); setMeta(db, { graphAvailable: false, captureError: error.message }); }
      });
      // Runs after minimization and SourceMapDevToolPlugin. Keep production options intact.
      compilation.hooks.afterProcessAssets.tap(NAME, () => {
        db.exec('BEGIN');
        try {
          const assets = compilation.getAssets(); const byName = new Map(assets.map(asset => [asset.name, asset]));
          for (const asset of assets) {
            if (!/\.(?:js|mjs|cjs)$/i.test(asset.name)) continue;
            const generated = text(asset.source.source()); let map = null; let mapError = null;
            try {
              map = safely(() => asset.source.map({ columns: true }));
              const related = asset.info?.related?.sourceMap;
              const comment = [...generated.matchAll(/[#@]\s*sourceMappingURL=([^\s*]+)/g)].at(-1)?.[1];
              const mapName = typeof related === 'string' ? related : comment && !comment.startsWith('data:') ? path.posix.normalize(path.posix.join(path.posix.dirname(asset.name), comment)) : null;
              if (!map && mapName && byName.has(mapName)) map = JSON.parse(text(byName.get(mapName).source.source()));
              if (!map && comment?.startsWith('data:')) {
                const comma = comment.indexOf(','); const header = comment.slice(0, comma); const value = comment.slice(comma + 1);
                map = JSON.parse(header.includes(';base64') ? Buffer.from(value, 'base64').toString('utf8') : decodeURIComponent(value));
              }
              if (typeof map === 'string') map = JSON.parse(map);
              if (!map) mapError = 'No full asset source map was emitted. Use hidden-source-map or source-map for source attribution.';
            } catch (error) { mapError = error.message; }
            const publicPath = compiler.options.output?.publicPath;
            const url = typeof publicPath === 'string' && publicPath !== 'auto' ? `${publicPath.replace(/\/$/, '')}/${asset.name}` : `/${asset.name}`;
            prepare(db, 'INSERT OR REPLACE INTO assets VALUES (?,?,?,?,?,?,?,?,?)').run(id('asset', asset.name), asset.name, url, generated, hash(generated), map ? json(map) : null, mapError, '[]', 0);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      state.visit = visit;
    });
    compiler.hooks.done.tap(NAME, stats => {
      const state = captures.get(stats.compilation); if (!state || state.closed) return;
      if (stats.hasErrors()) { closeFailed(); return; }
      const { db } = state; const compilation = stats.compilation;
      db.exec('BEGIN');
      try {
        const runtimes = [...new Set([...compilation.chunks].flatMap(chunk => typeof chunk.runtime === 'string' ? [chunk.runtime] : [...(chunk.runtime || [])]))];
        const seen = new Set(); const update = (module, parent = null, inherited = []) => {
          const key = state.visit(module, parent, new Set(), false);
          for (const chunk of inherited) prepare(db, 'INSERT OR IGNORE INTO module_chunks VALUES (?,?)').run(key, chunk);
          if (seen.has(module)) { for (const child of module.modules || []) update(child, key, inherited); return; } seen.add(module);
          const provided = safely(() => compilation.moduleGraph.getProvidedExports(module));
          let used = null;
          try { used = compilation.moduleGraph.getUsedExports(module, runtimes); }
          catch (error) { addGap(db, key, 'used-exports', { message: error.message }); }
          prepare(db, 'UPDATE modules SET provided=?,used=?,parent_id=COALESCE(?,parent_id) WHERE id=?').run(json(Array.isArray(provided) ? provided : null), json(used instanceof Set ? [...used] : used ?? null), parent, key);
          for (const connection of safely(() => compilation.moduleGraph.getOutgoingConnections(module), [])) {
            const target = connection.module; const dep = connection.dependency; if (!target || !dep) continue;
            const value = { origin: key, target: ensureModule(db, target.identifier(), target.layer), type: dep.type ?? null, request: dep.request ?? null, loc: dep.loc ?? null };
            const active = safely(() => connection.isActive(runtimes));
            prepare(db, 'INSERT OR IGNORE INTO refs VALUES (?,?,?,?,?,?,?)').run(id('ref', value), value.origin, value.target, value.type, value.request, json(value.loc), active == null ? null : Number(active));
          }
          for (const child of module.modules || []) update(child, key, inherited);
        };
        for (const chunk of compilation.chunks) {
          const chunkId = String(chunk.id); const files = [...chunk.files];
          prepare(db, 'INSERT INTO chunks VALUES (?,?,?,?)').run(chunkId, Number(chunk.canBeInitial()), json(files), json(typeof chunk.runtime === 'string' ? [chunk.runtime] : [...(chunk.runtime || [])]));
          for (const module of compilation.chunkGraph.getChunkModulesIterable(chunk)) update(module, null, [chunkId]);
          for (const file of files) {
            const row = prepare(db, 'SELECT id,chunks,initial FROM assets WHERE name=?').get(file);
            if (row) prepare(db, 'UPDATE assets SET chunks=?,initial=? WHERE id=?').run(json([...new Set([...JSON.parse(row.chunks), chunkId])]), Number(Boolean(row.initial) || chunk.canBeInitial()), row.id);
          }
        }
        for (const module of compilation.modules) update(module);
        const groups = [...compilation.chunkGroups];
        const groupId = new Map(groups.map((group, i) => [group, String(group.id ?? i)]));
        for (const group of groups) {
          const origins = [...(group.origins || [])].map(origin => ({ moduleId: origin.module ? ensureModule(db, origin.module.identifier(), origin.module.layer) : null, request: origin.request ?? null, location: origin.loc ?? null }));
          const parents = safely(() => [...group.getParents()], []).map(parent => groupId.get(parent)).filter(Boolean);
          prepare(db, 'INSERT INTO chunk_groups VALUES (?,?,?,?,?)').run(groupId.get(group), json(group.chunks.map(chunk => String(chunk.id))), json(origins), json(parents), group.name ?? null);
        }
        setMeta(db, { status: 'complete', buildHash: stats.hash, completedAt: new Date().toISOString(), outputPath: compiler.options.output?.path ?? null });
        db.exec('COMMIT'); db.close(); state.closed = true;
        fs.linkSync(state.pending, state.final); fs.unlinkSync(state.pending);
        const pointer = path.join(directory, 'latest.json'); const temporary = `${pointer}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, json({ schemaVersion: 1, file: path.basename(state.final), buildHash: stats.hash })); fs.renameSync(temporary, pointer);
        process.stderr.write(`[${NAME}] ${state.final}\n`); this.options.onSnapshot?.(state.final);
      } catch (error) { if (!state.closed) { db.exec('ROLLBACK'); closeFailed(); } throw error; }
    });
    compiler.hooks.failed.tap(NAME, closeFailed); compiler.hooks.shutdown.tap(NAME, closeFailed);
  }
}
module.exports = { BundleEvidencePlugin };
