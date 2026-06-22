// @ts-nocheck
/**
 * Retained Unused Side Effects Report Plugin (CJS port)
 *
 * Finds modules with usedExports = [] that are still retained due to
 * side-effect bailouts.
 */
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { dirname, extname, isAbsolute, relative, resolve } = require('path');

const JS_LIKE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const SIDE_EFFECT_BAILOUT_PATTERN = /side[_ ]effects in source code/i;

const safeInvoke = (getter) => {
  try { return getter(); } catch { return undefined; }
};

const getModuleName = (compilation, module) => {
  const requestShortener = compilation?.requestShortener;
  return (
    safeInvoke(() => module?.readableIdentifier?.(requestShortener)) ??
    safeInvoke(() => module?.nameForCondition?.()) ??
    module?.resource ??
    safeInvoke(() => module?.identifier?.()) ??
    'unknown-module'
  );
};

const getModuleResource = (compilerContext, module) => {
  const candidates = [
    module?.resource,
    safeInvoke(() => module?.nameForCondition?.()),
    module?.rootModule?.resource,
  ].filter((c) => typeof c === 'string' && c.length > 0);
  if (candidates.length === 0) return null;
  return isAbsolute(candidates[0]) ? candidates[0] : resolve(compilerContext, candidates[0]);
};

const getModuleIdentifier = (compilerContext, compilation, module) =>
  String(safeInvoke(() => module?.identifier?.()) ?? getModuleResource(compilerContext, module) ?? getModuleName(compilation, module));

const isExternalModule = (compilation, module) => getModuleName(compilation, module).startsWith('external ');

const isJavaScriptLikeResource = (resource) => Boolean(resource && JS_LIKE_EXTENSIONS.has(extname(resource)));

const flattenStatsModules = (statsModules, parentMeta) => {
  const flattened = [];
  for (const statsModule of statsModules) {
    const inheritedChunks =
      Array.isArray(statsModule.chunks) && statsModule.chunks.length > 0
        ? statsModule.chunks
        : parentMeta?.chunks ?? [];
    const inheritedAssets =
      Array.isArray(statsModule.assets) && statsModule.assets.length > 0
        ? statsModule.assets
        : parentMeta?.assets ?? [];
    flattened.push({ ...statsModule, inheritedChunks, inheritedAssets });
    if (Array.isArray(statsModule.modules) && statsModule.modules.length > 0) {
      flattened.push(...flattenStatsModules(statsModule.modules, { chunks: inheritedChunks, assets: inheritedAssets }));
    }
  }
  return flattened;
};

class RetainedUnusedSideEffectsReportPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    compiler.hooks.done.tap('RetainedUnusedSideEffectsReportPlugin', (stats) => {
      const compilation = stats.compilation;
      const compilerContext = compiler.context;
      const reportPath = resolve(compilerContext, this.options.reportPath ?? './tmp/retained-unused-side-effects-report.md');
      const candidateJsonPath = resolve(compilerContext, this.options.candidateJsonPath ?? './tmp/retained-unused-side-effects-candidates.json');
      const summaryJsonPath = resolve(compilerContext, this.options.summaryJsonPath ?? './tmp/retained-unused-side-effects-summary.json');
      const accumulateEnvName = this.options.accumulateEnvName ?? 'CUSTOM_USE_SIDE_EFFECTS_FALSE_FROM_REPORT';

      mkdirSync(dirname(reportPath), { recursive: true });
      mkdirSync(dirname(candidateJsonPath), { recursive: true });
      mkdirSync(dirname(summaryJsonPath), { recursive: true });

      const statsData = stats.toJson({
        all: false,
        modules: true,
        nestedModules: true,
        usedExports: true,
        optimizationBailout: true,
        ids: true,
        chunks: true,
        chunkModules: true,
        source: false,
        reasons: false,
      });

      const modulesByIdentifier = new Map();
      const modulesByResource = new Map();
      const entryModuleIdentifiers = new Set();

      for (const module of Array.from(safeInvoke(() => compilation?.modules) ?? [])) {
        const identifier = getModuleIdentifier(compilerContext, compilation, module);
        modulesByIdentifier.set(identifier, module);
        const resource = getModuleResource(compilerContext, module);
        if (resource) modulesByResource.set(resource, module);
      }

      for (const chunk of Array.from(safeInvoke(() => compilation?.chunks) ?? [])) {
        for (const module of Array.from(safeInvoke(() => compilation?.chunkGraph?.getChunkEntryModulesIterable?.(chunk)) ?? [])) {
          entryModuleIdentifiers.add(getModuleIdentifier(compilerContext, compilation, module));
        }
      }

      const retainedUnusedEntries = flattenStatsModules(statsData.modules ?? [])
        .filter((m) => Array.isArray(m.usedExports) && m.usedExports.length === 0)
        .filter((m) => m.inheritedChunks.length > 0 || m.inheritedAssets.length > 0)
        .map((statsModule) => {
          const module =
            (typeof statsModule.identifier === 'string' && modulesByIdentifier.get(statsModule.identifier)) ||
            (typeof statsModule.name === 'string' && modulesByResource.get(resolve(compilerContext, statsModule.name))) ||
            null;
          if (!module || isExternalModule(compilation, module)) return null;
          const resource = getModuleResource(compilerContext, module);
          if (!isJavaScriptLikeResource(resource)) return null;

          const bailouts = (statsModule.optimizationBailout ?? []).filter((b) => typeof b === 'string' && b.length > 0);
          const sideEffectBailouts = bailouts.filter((b) => SIDE_EFFECT_BAILOUT_PATTERN.test(b));

          return {
            identifier: getModuleIdentifier(compilerContext, compilation, module),
            name: getModuleName(compilation, module),
            resource,
            relResource: relative(compilerContext, resource),
            size: Number(statsModule.size ?? 0),
            bailouts,
            sideEffectBailouts,
            isEntryModule: entryModuleIdentifiers.has(getModuleIdentifier(compilerContext, compilation, module)),
          };
        })
        .filter(Boolean);

      const freshCandidates = Array.from(
        new Set(
          retainedUnusedEntries
            .filter((e) => e.sideEffectBailouts.length > 0 && !e.isEntryModule)
            .map((e) => e.resource),
        ),
      ).sort();

      const persistedCandidates =
        process.env[accumulateEnvName] === 'true' && existsSync(candidateJsonPath)
          ? (() => { try { const p = JSON.parse(readFileSync(candidateJsonPath, 'utf8')); return Array.isArray(p) ? p.filter((v) => typeof v === 'string') : []; } catch { return []; } })()
          : [];

      const candidateResources = Array.from(new Set([...persistedCandidates, ...freshCandidates])).sort();

      const emittedJSAssets = Array.from(safeInvoke(() => compilation?.getAssets?.()) ?? [])
        .filter((a) => typeof a?.name === 'string' && a.name.endsWith('.js'));
      const emittedJSSize = emittedJSAssets.reduce((sum, a) => sum + Number(safeInvoke(() => a?.source?.size?.()) ?? 0), 0);

      const summary = {
        generatedAt: new Date().toISOString(),
        retainedUnusedJSModuleCount: retainedUnusedEntries.length,
        retainedUnusedWithAnyBailoutCount: retainedUnusedEntries.filter((e) => e.bailouts.length > 0).length,
        retainedUnusedWithSideEffectBailoutCount: retainedUnusedEntries.filter((e) => e.sideEffectBailouts.length > 0).length,
        uniqueCandidateResourceCount: candidateResources.length,
        emittedJSAssetCount: emittedJSAssets.length,
        emittedJSAssetSize: emittedJSSize,
        retainedUnusedEntries,
        candidateResources: candidateResources.map((r) => relative(compilerContext, r)),
      };

      writeFileSync(candidateJsonPath, JSON.stringify(candidateResources, null, 2) + '\n', 'utf8');
      writeFileSync(summaryJsonPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

      console.log(`[RetainedUnused] ${summary.retainedUnusedJSModuleCount} retained unused JS modules`);
      console.log(`[RetainedUnused] ${summary.retainedUnusedWithSideEffectBailoutCount} with side-effect bailout`);
      console.log(`[RetainedUnused] ${summary.uniqueCandidateResourceCount} unique candidate resources`);
      console.log(`[RetainedUnused] Emitted JS: ${emittedJSSize} B`);
      console.log(`[RetainedUnused] Written to ${summaryJsonPath}`);
    });
  }
}

module.exports = { RetainedUnusedSideEffectsReportPlugin };
