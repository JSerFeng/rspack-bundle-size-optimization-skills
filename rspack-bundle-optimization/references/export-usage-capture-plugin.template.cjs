// @ts-nocheck
// Capture rspack's builtin Rsdoctor export-usage graph (exportUsageEdges).
//
// Requires @rspack/core >= 2.1.0-beta.0 (feat(rsdoctor): expose export usage graph,
// #14291). NOT in latest stable 2.0.8 — check `experiments.RsdoctorPlugin` and the
// `exportUsageGraph` option exist before relying on this; otherwise build a dev
// binding from rspack main, or fall back to @rsdoctor/rspack-plugin.
//
// Output: rsdoctor-export-usage-raw.json
//   { modules:[{ukey,path,isEntry,kind,bailoutReason}], edges:[[oU,oExports|null,tU,tExports|null]] }
//   edge = origin(consumer) uses target(provider); oExports===null => module-level/terminal;
//          tExports===null => namespace (whole-module) usage.
//
// Wiring: add to the production config's plugins, behind an env flag, and build with
//   optimization.concatenateModules:false, usedExports:true   (per-module granularity).
// IMPORTANT: pass the already-imported rspack instance in (`new ExportUsageCapturePlugin({ rspack })`).
// A fresh `require('@rspack/core')` inside this .cjs can load the CJS dist and crash at init.
const { writeFileSync, mkdirSync } = require('fs');
const { resolve } = require('path');

class ExportUsageCapturePlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    const rspack = this.options.rspack || require('@rspack/core');
    const RsdoctorPlugin = rspack.experiments && rspack.experiments.RsdoctorPlugin;
    if (!RsdoctorPlugin || typeof RsdoctorPlugin.getCompilationHooks !== 'function') {
      console.warn('[ExportUsageCapture] RsdoctorPlugin.getCompilationHooks unavailable — need @rspack/core >= 2.1.0-beta.0; skipping');
      return;
    }
    new RsdoctorPlugin({
      moduleGraphFeatures: ['graph'],
      chunkGraphFeatures: false,
      exportUsageGraph: true,
    }).apply(compiler);

    compiler.hooks.thisCompilation.tap('ExportUsageCapturePlugin', (compilation) => {
      const hooks = RsdoctorPlugin.getCompilationHooks(compilation);
      hooks.moduleGraph.tapPromise('ExportUsageCapturePlugin', async (mg) => {
        try {
          const outDir = resolve(this.options.outDir || './tmp');
          mkdirSync(outDir, { recursive: true });
          const modules = (mg.modules || []).map((m) => ({
            ukey: m.ukey,
            path: m.path,
            isEntry: m.isEntry,
            kind: m.kind,
            bailoutReason: m.bailoutReason || [],
          }));
          const edges = mg.exportUsageEdges || [];
          const outPath = resolve(outDir, 'rsdoctor-export-usage-raw.json');
          writeFileSync(outPath, JSON.stringify({ moduleCount: modules.length, edgeCount: edges.length, modules, edges }));
          console.log(`[ExportUsageCapture] ${modules.length} modules, ${edges.length} export-usage edges -> ${outPath}`);
        } catch (e) {
          console.error('[ExportUsageCapture] failed:', e && e.stack ? e.stack : e);
        }
        return undefined; // do not bail
      });
    });

    // Reference-site capture: dump POST-LOADER source for modules that contain
    // decorator/metadata emit, so the usage-kind analysis can tell whether an
    // export is genuinely used or only referenced by a `_ts_metadata`/`_ts_decorate`
    // artifact (e.g. emitDecoratorMetadata turning a type-only import into a runtime
    // `_ts_metadata("design:type", X)` reference). originalSource() is post-loader
    // (what rspack actually saw), where these artifacts live; .ts on disk is pre-transform.
    const MARKER = /_ts_metadata|__metadata\(|Reflect\.metadata|_ts_decorate|__decorate\(/;
    compiler.hooks.done.tap('ExportUsageCapturePlugin', (stats) => {
      try {
        const outDir = resolve(this.options.outDir || './tmp');
        mkdirSync(outDir, { recursive: true });
        const compilation = stats.compilation;
        const out = [];
        let scanned = 0;
        for (const m of compilation.modules || []) {
          const resource = m.resource || (m.nameForCondition && m.nameForCondition());
          if (!resource || !/\.[cm]?[jt]sx?$/.test(resource)) continue;
          scanned++;
          let src = '';
          try { src = m.originalSource && m.originalSource() ? m.originalSource().source().toString() : ''; } catch {}
          if (src && MARKER.test(src)) out.push({ path: resource, source: src });
        }
        const outPath = resolve(outDir, 'rsdoctor-marker-sources.json');
        writeFileSync(outPath, JSON.stringify({ scanned, markerModuleCount: out.length, modules: out }));
        console.log(`[ExportUsageCapture] ${out.length}/${scanned} modules with decorator/metadata markers -> ${outPath}`);
      } catch (e) {
        console.error('[ExportUsageCapture] marker-source capture failed:', e && e.stack ? e.stack : e);
      }
    });
  }
}

module.exports = { ExportUsageCapturePlugin };
