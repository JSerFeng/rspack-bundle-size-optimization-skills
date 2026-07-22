// @ts-nocheck
// Capture rspack's builtin Rsdoctor export-usage graph (exportUsageEdges).
//
// Requires @rspack/core >= 2.1.0 (feat(rsdoctor): expose export usage graph,
// #14291). This is not available in 2.0.8 — check `experiments.RsdoctorPlugin` and the
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
const { existsSync, writeFileSync, mkdirSync } = require('fs');
const { resolve } = require('path');

const PLUGIN_NAME = 'ExportUsageCapturePlugin';

function captureIdentity(options, compiler) {
  const runId = String(options.runId || process.env.RSPACK_AUDIT_RUN_ID || '').trim();
  const compilerId = String(options.compilerId || '').trim();
  const requestedOutDir = options.outDir || process.env.RSPACK_EXPORT_USAGE_OUT_DIR;
  if (!runId) throw new Error(`${PLUGIN_NAME}: runId is required`);
  if (!compilerId) throw new Error(`${PLUGIN_NAME}: compilerId is required`);
  if (!requestedOutDir) throw new Error(`${PLUGIN_NAME}: outDir is required and must be inside the isolated audit run`);
  return {
    runId,
    compilerId,
    outDir: resolve(compiler.context || process.cwd(), requestedOutDir),
  };
}

function writeFresh(path, body) {
  if (existsSync(path)) throw new Error(`${PLUGIN_NAME}: refusing to overwrite an existing audit artifact: ${path}`);
  writeFileSync(path, body);
}

class ExportUsageCapturePlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    const identity = captureIdentity(this.options, compiler);
    const rspack = this.options.rspack || require('@rspack/core');
    const RsdoctorPlugin = rspack.experiments && rspack.experiments.RsdoctorPlugin;
    if (!RsdoctorPlugin || typeof RsdoctorPlugin.getCompilationHooks !== 'function') {
      throw new Error('[ExportUsageCapture] RsdoctorPlugin.getCompilationHooks unavailable — need @rspack/core >= 2.1.0 or a compatible Rsdoctor capture');
    }
    new RsdoctorPlugin({
      moduleGraphFeatures: ['graph'],
      chunkGraphFeatures: false,
      exportUsageGraph: true,
    }).apply(compiler);

    let rawCapture = null;
    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      const hooks = RsdoctorPlugin.getCompilationHooks(compilation);
      hooks.moduleGraph.tapPromise(PLUGIN_NAME, async (mg) => {
        if (!Array.isArray(mg.modules) || !Array.isArray(mg.exportUsageEdges)) {
          throw new Error(`${PLUGIN_NAME}: Rsdoctor module graph is missing modules or exportUsageEdges arrays`);
        }
        mkdirSync(identity.outDir, { recursive: true });
        const modules = mg.modules.map((m) => ({
          ukey: m.ukey,
          path: m.path,
          isEntry: m.isEntry,
          kind: m.kind,
          bailoutReason: m.bailoutReason || [],
        }));
        const edges = mg.exportUsageEdges;
        rawCapture = {
          schemaVersion: 1,
          kind: 'rspack-export-usage-capture',
          complete: true,
          generatedAt: new Date().toISOString(),
          runId: identity.runId,
          compilerId: identity.compilerId,
          moduleCount: modules.length,
          edgeCount: edges.length,
          modules,
          edges,
        };
        console.log(`[ExportUsageCapture] captured ${modules.length} modules and ${edges.length} export-usage edges; waiting for a successful compilation before writing`);
        return undefined; // do not bail
      });
    });

    // Post-loader source capture. `originalSource()` is what rspack actually saw
    // (after loaders / swc transform) — where artifacts live that the pre-transform
    // `.ts` on disk does NOT show: decorator emit (`_ts_metadata`/`_ts_decorate`),
    // injected polyfills, re-export passthroughs, helper wrappers, etc.
    //
    // This does NOT decide anything. It makes the post-loader source readable so each
    // module can be reviewed case by case to determine whether an export is genuinely
    // used or only referenced by an artifact. Hard-coding a
    // single pattern (e.g. a `_ts_metadata` regex) would miss every other artifact shape;
    // the verdict must come from reading the actual code.
    //
    // Output:
    //   post-loader-sources.jsonl   one {path, bytes, markers[], sourceQuality} + source per line
    //   post-loader-index.json      { path -> {line, bytes, markers[], sourceQuality} }  so a reviewer/helper can locate a module fast
    const ARTIFACT_MARKERS = [
      ['decorator', /_ts_decorate|__decorate\(/],
      ['decorator-metadata', /_ts_metadata|__metadata\(|Reflect\.metadata|design:(type|paramtypes|returntype)/],
      ['polyfill', /core-js|regeneratorRuntime|@swc[\\/]helpers/],
      ['reexport', /__export\(|__reExport\(|Object\.defineProperty\(exports/],
    ];
    const isFirstParty = (p) => !/[\\/]node_modules[\\/]/.test(p);
    const computeSourceQuality = (src) => {
      const sourceLines = src.split(/\r?\n/);
      let maxLineLength = 0;
      let maxLineNo = 1;
      let totalLineLength = 0;
      let longLineCount = 0;
      let nonEmptyLineCount = 0;
      for (let i = 0; i < sourceLines.length; i++) {
        const len = sourceLines[i].length;
        totalLineLength += len;
        if (sourceLines[i].trim()) nonEmptyLineCount++;
        if (len > maxLineLength) {
          maxLineLength = len;
          maxLineNo = i + 1;
        }
        if (len > 240) longLineCount++;
      }
      const lineCount = sourceLines.length;
      const averageLineLength = Math.round(totalLineLength / Math.max(1, lineCount));
      const probablyMinified =
        (src.length > 1000 && lineCount <= 3) ||
        (src.length > 5000 && averageLineLength > 400) ||
        maxLineLength > 1200;
      return {
        lineCount,
        nonEmptyLineCount,
        averageLineLength,
        maxLineLength,
        maxLineNo,
        longLineCount,
        probablyMinified,
      };
    };
    compiler.hooks.done.tap(PLUGIN_NAME, (stats) => {
      if (typeof stats.hasErrors === 'function' && stats.hasErrors()) {
        throw new Error(`${PLUGIN_NAME}: refusing to complete capture for a failed compilation`);
      }
      if (!rawCapture) throw new Error(`${PLUGIN_NAME}: moduleGraph hook did not produce a capture`);
      mkdirSync(identity.outDir, { recursive: true });
      const compilation = stats.compilation;
      const lines = [];
      const index = {};
      let scanned = 0;
      let lineNo = 0;
      for (const m of compilation.modules || []) {
        const resource = m.resource || (m.nameForCondition && m.nameForCondition());
        if (!resource || !/\.[cm]?[jt]sx?$/.test(resource)) continue;
        let src = '';
        try { src = m.originalSource && m.originalSource() ? m.originalSource().source().toString() : ''; } catch {}
        if (!src) continue;
        scanned++;
        const markers = ARTIFACT_MARKERS.filter(([, re]) => re.test(src)).map(([k]) => k);
        const sourceQuality = computeSourceQuality(src);
        // Capture every JS-like module by default so the HTML chain node viewer can
        // open third-party modules too. Pass { captureAllSources: false } only for a
        // narrow artifact audit where first-party + marker modules are enough.
        const captureAllSources = this.options.captureAllSources !== false;
        if (!captureAllSources && !isFirstParty(resource) && markers.length === 0) continue;
        index[resource] = { line: lineNo, bytes: Buffer.byteLength(src, 'utf8'), markers, sourceQuality };
        lines.push(JSON.stringify({ runId: identity.runId, compilerId: identity.compilerId, path: resource, bytes: Buffer.byteLength(src, 'utf8'), markers, sourceQuality, source: src }));
        lineNo++;
      }
      const rawPath = resolve(identity.outDir, 'rsdoctor-export-usage-raw.json');
      const sourcesPath = resolve(identity.outDir, 'post-loader-sources.jsonl');
      const indexPath = resolve(identity.outDir, 'post-loader-index.json');
      for (const path of [rawPath, sourcesPath, indexPath]) {
        if (existsSync(path)) throw new Error(`${PLUGIN_NAME}: refusing to overwrite an existing audit artifact: ${path}`);
      }
      writeFresh(sourcesPath, `${lines.join('\n')}\n`);
      writeFresh(indexPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: 'rspack-post-loader-source-index',
        complete: true,
        generatedAt: new Date().toISOString(),
        runId: identity.runId,
        compilerId: identity.compilerId,
        scanned,
        captured: lines.length,
        index,
      }, null, 2)}\n`);
      // Write the raw graph last. A complete raw capture therefore proves that
      // the same successful build also finished its required source inventory.
      writeFresh(rawPath, `${JSON.stringify(rawCapture)}\n`);
      const withMarker = Object.values(index).filter((v) => v.markers.length).length;
      const probablyMinified = Object.values(index).filter((v) => v.sourceQuality && v.sourceQuality.probablyMinified).length;
      console.log(`[ExportUsageCapture] captured post-loader source for ${lines.length}/${scanned} modules (${withMarker} with artifact markers, ${probablyMinified} probably compact/minified) -> post-loader-sources.jsonl`);
      console.log(`[ExportUsageCapture] finalized export-usage graph -> ${rawPath}`);
    });
  }
}

function selfTest() {
  const assert = require('assert');
  const compiler = { context: '/project' };
  assert.throws(() => captureIdentity({}, compiler), /runId is required/);
  assert.throws(() => captureIdentity({ runId: 'run' }, compiler), /compilerId is required/);
  const identity = captureIdentity({ runId: 'run', compilerId: 'web', outDir: 'tmp/audit' }, compiler);
  assert.equal(identity.runId, 'run');
  assert.equal(identity.compilerId, 'web');
  assert.equal(identity.outDir, resolve('/project/tmp/audit'));
  console.log('export-usage-capture-plugin self-test passed');
}

if (require.main === module && process.argv.includes('--self-test')) selfTest();

module.exports = { ExportUsageCapturePlugin, captureIdentity };
