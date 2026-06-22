#!/usr/bin/env node
// Analyze Rspack/Rsdoctor exportsUsage chains and group used exports by terminal root.
//
// Example:
//   node export-usage-root-analysis.template.cjs \
//     --usage tmp/rspack-optimization/rsdoctor-all-export-usage.json \
//     --report tmp/rspack-optimization/export-gap-report.json \
//     --context "$PWD" \
//     --out-dir tmp/rspack-optimization/export-usage-roots

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { basename, dirname, extname, relative, resolve } = require('path');

const JS_LIKE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const defaultAllUsagePath = resolve('tmp/rspack-optimization/rsdoctor-all-export-usage.json');
const defaultFilteredUsagePath = resolve('tmp/rspack-optimization/rsdoctor-filtered-export-usage.json');
const usagePath = resolve(args.usage || (existsSync(defaultAllUsagePath) ? defaultAllUsagePath : defaultFilteredUsagePath));
const optionalReportPath = args.report ? resolve(args.report) : null;
const compilerContext = resolve(args.context || process.cwd());
const outDir = resolve(args['out-dir'] || dirname(usagePath));
const jsonOutPath = resolve(outDir, args['json-out'] || 'export-usage-root-analysis.json');
const mdOutPath = resolve(outDir, args['markdown-out'] || 'export-usage-root-analysis.md');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function stripQuery(resource) {
  return typeof resource === 'string' ? resource.split('?')[0] : resource;
}

function prettyPath(resource) {
  const clean = stripQuery(resource);
  if (!clean) return '(unknown)';
  const rel = relative(compilerContext, clean);
  return rel.startsWith('..') ? clean : rel;
}

function isJavaScriptLike(resource) {
  const clean = stripQuery(resource);
  return Boolean(clean && JS_LIKE_EXTENSIONS.has(extname(clean)));
}

function readTextIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf8');
}

function buildMaterializedMap(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return new Map();
  const report = readJson(reportPath);
  const map = new Map();
  for (const item of report.materializedSources || []) {
    if (item?.moduleAbsolutePath && item?.materializedPath) {
      map.set(stripQuery(item.moduleAbsolutePath), resolve(dirname(reportPath), item.materializedPath));
    }
  }
  return map;
}

function sourceForResource(resource, materializedByResource) {
  const clean = stripQuery(resource);
  const source = readTextIfExists(clean);
  const materialized = readTextIfExists(materializedByResource.get(clean));
  return { source, materialized, combined: `${source}\n${materialized}` };
}

function lineCount(pattern, source) {
  return (source.match(pattern) || []).length;
}

function hasStaticUtilityClass(source) {
  return (
    /\bexport\s+class\s+\w*Utils?\b/.test(source) ||
    /\bclass\s+\w*Utils?\b/.test(source) ||
    /\bexport\s+const\s+\w*Utils?\s*=\s*\{/.test(source) ||
    /\bstatic\s+\w+\s*\(/.test(source)
  );
}

function classifyRoot(resource, terminalKinds, textInfo) {
  const clean = stripQuery(resource) || '';
  const rel = prettyPath(clean);
  const source = textInfo.source || '';
  const combined = textInfo.combined || '';
  const exportFromCount = lineCount(/\bexport\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+['"]/g, source);
  const localExportCount = lineCount(/\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|enum|interface|type)\s+/g, source);
  const importCount = lineCount(/\bimport\s+[\s\S]*?\s+from\s+['"]/g, source);
  const decoratorCount = lineCount(/\b_ts_decorate\b|\b__decorate\b|@swc\/helpers\/_\/_ts_decorate|^\s*@\w+/gm, combined);
  const metadataCount = lineCount(/\b_ts_metadata\b|\b__metadata\b|Reflect\.metadata/g, combined);
  const enumCount = lineCount(/\bexport\s+(?:const\s+)?enum\b|\bconst\s+\w+\s*=\s*\{[\s\S]{0,200}?\bas\s+const\b/g, source);
  const registryCount = lineCount(/\b(register[A-Z]\w*|registry|Registry|Contribution|contribution|mutationMap)\b/g, source);
  const runtimeMapCount = lineCount(/\bmutationMap\b|new\s+Map\s*\(|Record<[^>]+,\s*typeof\b/g, source);
  const factorySwitchCount = lineCount(/\bswitch\s*\(|\bcase\s+|\bcreate\w+\s*\(/g, source);

  const featureFlags = {
    barrelLike: exportFromCount >= 5 || (/\/index\.[cm]?[tj]sx?$/.test(rel) && exportFromCount >= 2),
    decorated: decoratorCount > 0,
    metadata: metadataCount > 0,
    enumLike: enumCount > 0 || /\/model\/enum\//.test(rel),
    namespaceUtility: hasStaticUtilityClass(source) || (/\/utils?\//.test(rel) && /\b(Utils?|Helper|Util)\b/.test(source.slice(0, 2000))),
    registryLike: registryCount >= 2 || runtimeMapCount > 0 || /\/contribution\//.test(rel),
    runtimeMapLike: runtimeMapCount > 0 || /\/mutation-map\.[cm]?[tj]sx?$/.test(rel),
    factorySwitch: factorySwitchCount >= 8,
    entryBootstrap: /(^|\/)(apps?\/|src\/main|src\/entry|packages\/entry\/)/.test(rel),
    sideEffectUnknown: terminalKinds.has('module-side-effect-or-unknown-export'),
    noExportIncoming: terminalKinds.has('no-export-incoming'),
  };

  let category = 'other';
  let cause = 'ordinary import/export chain; inspect source manually';
  if (featureFlags.entryBootstrap) {
    category = 'entry/bootstrap root';
    cause = 'application entry or service registration root keeps downstream exports live';
  } else if (featureFlags.barrelLike) {
    category = 'barrel/re-export root';
    cause = 'broad index/barrel module fans out through many re-exports';
  } else if (featureFlags.decorated) {
    category = 'decorated side-effect root';
    cause = 'legacy decorator emit makes the root module side-effectful or unknown to export pruning';
  } else if (featureFlags.namespaceUtility) {
    category = 'namespace utility root';
    cause = 'broad utility class/module import retains multiple helper exports together';
  } else if (featureFlags.runtimeMapLike) {
    category = 'runtime registry/map root';
    cause = 'runtime map or registry object keeps every referenced constructor/export live';
  } else if (featureFlags.registryLike) {
    category = 'registry/contribution root';
    cause = 'runtime registry or contribution module keeps imported APIs live';
  } else if (featureFlags.enumLike) {
    category = 'runtime enum/schema root';
    cause = 'runtime enum/schema object is imported as a value and keeps related exports live';
  } else if (featureFlags.factorySwitch) {
    category = 'factory/switch root';
    cause = 'factory or switch-style module references many constructors/helpers from one live path';
  } else if (featureFlags.sideEffectUnknown) {
    category = 'module side-effect or unknown export root';
    cause = 'Rspack terminal is module-level side effect or unknown export, not a concrete export-to-export root';
  } else if (featureFlags.noExportIncoming) {
    category = 'top-level used root';
    cause = 'root has no export-level incoming edge and acts as a terminal consumer';
  }

  return {
    category,
    cause,
    featureFlags,
    metrics: {
      exportFromCount,
      localExportCount,
      importCount,
      decoratorCount,
      metadataCount,
      enumCount,
      registryCount,
      runtimeMapCount,
      factorySwitchCount,
      sourceBytes: Buffer.byteLength(source, 'utf8'),
    },
  };
}

function addToMapSet(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

// Per-root "is it really used?" verdict.
// Aggregation tells us how many exports a root keeps alive; this answers whether
// those exports are genuinely referenced (real runtime reachability) or merely
// retained conservatively. The signal is precise vs coarse edges: a coarse edge
// (`viaNamespace`, i.e. the provider was consumed as a whole module / `import *`)
// keeps an export alive even if no concrete specifier ever references it.
const GENUINELY_USED_CATEGORIES = new Set([
  'entry/bootstrap root',
  'top-level used root',
  'decorated side-effect root',
  'registry/contribution root',
  'runtime registry/map root',
  'runtime enum/schema root',
  'factory/switch root',
]);

function computeUsageVerdict(category, coarseChainCount, chainCount) {
  const coarseShare = chainCount ? coarseChainCount / chainCount : 0;
  if (GENUINELY_USED_CATEGORIES.has(category)) {
    return {
      usageVerdict: 'genuinely-used',
      usageReason:
        'runtime root (entry / route / registration / decorator / value-map) — the kept exports serve a live feature; not an over-retention bug',
      rewriteHint: null,
      coarseShare,
    };
  }
  if (category === 'namespace utility root' || category === 'barrel/re-export root') {
    if (coarseShare >= 0.5) {
      return {
        usageVerdict: 'over-retained-suspect',
        usageReason: `${Math.round(coarseShare * 100)}% of chains retain exports via namespace/barrel edges, not precise references — kept-alive exports may never be referenced`,
        rewriteHint:
          category === 'namespace utility root'
            ? 'replace the wide namespace import (`import * as X`) with named imports of the few members actually used'
            : 'import the defining modules directly instead of through the barrel, or split the barrel',
        coarseShare,
      };
    }
    return {
      usageVerdict: 'genuinely-used',
      usageReason: 'barrel/namespace-shaped, but retention is mostly via precise references',
      rewriteHint: null,
      coarseShare,
    };
  }
  if (category === 'module side-effect or unknown export root') {
    return {
      usageVerdict: 'needs-source-confirmation',
      usageReason:
        'Rspack terminal is a module-level side effect / unknown export, not a precise export-to-export cause — confirm by reading the root before calling it used or removable',
      rewriteHint: null,
      coarseShare,
    };
  }
  return {
    usageVerdict: 'review',
    usageReason: 'ordinary import/export chain; inspect source to decide',
    rewriteHint: null,
    coarseShare,
  };
}

function normalizeChainTerminal(chain) {
  return stripQuery(chain.terminal || chain.root || chain.terminalModule || chain.rootModule);
}

function normalizeChains(item) {
  return item.usage?.chains || item.chains || [];
}

function normalizeResource(item) {
  return stripQuery(item.resource || item.moduleAbsolutePath || item.module || item.targetModule);
}

function normalizeExportName(item) {
  return item.exportName || item.name || item.targetExport || item.export || '(unknown)';
}

function edgeSummary(edge) {
  return {
    from: prettyPath(edge.from || edge.fromResource || edge.originModule || edge.origin),
    to: prettyPath(edge.to || edge.toResource || edge.targetModule || edge.target),
    request: edge.request || null,
    matchedExport: edge.matchedExport || edge.referencedExport || null,
    originExport: edge.originExport || null,
    targetExport: edge.targetExport || null,
    loc: edge.loc || edge.location || null,
  };
}

function main() {
  if (!existsSync(usagePath)) {
    throw new Error(`Missing exportsUsage snapshot: ${usagePath}`);
  }

  const usageSnapshot = readJson(usagePath);
  const usageRecords = usageSnapshot.usages || usageSnapshot.exportsUsage || usageSnapshot.records || [];
  const materializedByResource = buildMaterializedMap(optionalReportPath);
  const roots = new Map();
  const categoryExportKeys = new Map();
  const categoryRootKeys = new Map();
  const noChain = [];

  for (const item of usageRecords) {
    const resource = normalizeResource(item);
    const exportName = normalizeExportName(item);
    const exportKey = `${resource}\n${exportName}`;
    const chains = normalizeChains(item);
    if (chains.length === 0) {
      noChain.push({ resource, exportName, directImportCount: item.usage?.directImportCount || item.directImportCount || 0 });
      continue;
    }

    const seenRootsForExport = new Set();
    for (const chain of chains) {
      const root = normalizeChainTerminal(chain);
      if (!root || !isJavaScriptLike(root)) continue;
      if (!roots.has(root)) {
        roots.set(root, {
          root,
          prettyRoot: prettyPath(root),
          impactedExports: new Set(),
          impactedModules: new Set(),
          chainCount: 0,
          coarseChainCount: 0,
          preciseChainCount: 0,
          terminalKinds: new Map(),
          firstEdges: [],
          examples: [],
        });
      }
      const row = roots.get(root);
      const terminalKind = chain.terminalKind || chain.rootKind || 'unknown';
      row.chainCount += 1;
      // A chain is "coarse" if any edge keeps its export alive via a namespace
      // (whole-module) consumption rather than a precise named reference.
      const isCoarseChain = Array.isArray(chain.edges) && chain.edges.some((e) => e && e.viaNamespace);
      if (isCoarseChain) row.coarseChainCount += 1;
      else row.preciseChainCount += 1;
      row.impactedExports.add(exportKey);
      row.impactedModules.add(resource);
      row.terminalKinds.set(terminalKind, (row.terminalKinds.get(terminalKind) || 0) + 1);
      if (!seenRootsForExport.has(root) && row.examples.length < 12) {
        row.examples.push({
          target: prettyPath(resource),
          exportName,
          terminalKind,
          edgeCount: Array.isArray(chain.edges) ? chain.edges.length : 0,
        });
      }
      seenRootsForExport.add(root);
      if (row.firstEdges.length < 5 && Array.isArray(chain.edges) && chain.edges[0]) {
        row.firstEdges.push(edgeSummary(chain.edges[0]));
      }
    }
  }

  const rootRows = Array.from(roots.values()).map((row) => {
    const classification = classifyRoot(row.root, row.terminalKinds, sourceForResource(row.root, materializedByResource));
    addToMapSet(categoryRootKeys, classification.category, row.root);
    for (const key of row.impactedExports) addToMapSet(categoryExportKeys, classification.category, key);
    const verdict = computeUsageVerdict(classification.category, row.coarseChainCount, row.chainCount);
    return {
      root: row.root,
      prettyRoot: row.prettyRoot,
      category: classification.category,
      cause: classification.cause,
      usageVerdict: verdict.usageVerdict,
      usageReason: verdict.usageReason,
      rewriteHint: verdict.rewriteHint,
      coarseChainCount: row.coarseChainCount,
      preciseChainCount: row.preciseChainCount,
      coarseSharePct: Math.round(verdict.coarseShare * 100),
      impactedExportCount: row.impactedExports.size,
      impactedModuleCount: row.impactedModules.size,
      chainCount: row.chainCount,
      terminalKinds: Object.fromEntries(Array.from(row.terminalKinds.entries()).sort((a, b) => b[1] - a[1])),
      featureFlags: classification.featureFlags,
      metrics: classification.metrics,
      examples: row.examples,
      firstEdges: row.firstEdges,
    };
  }).sort((a, b) => b.impactedExportCount - a.impactedExportCount || b.chainCount - a.chainCount);

  const categoryRows = Array.from(categoryExportKeys.entries()).map(([category, exportSet]) => ({
    category,
    impactedExportCount: exportSet.size,
    rootCount: categoryRootKeys.get(category)?.size || 0,
    topRoots: rootRows
      .filter((row) => row.category === category)
      .slice(0, 8)
      .map((row) => ({ root: row.prettyRoot, impactedExportCount: row.impactedExportCount, chainCount: row.chainCount })),
  })).sort((a, b) => b.impactedExportCount - a.impactedExportCount);

  // ---- PER-EXPORT verdict (the primary unit) ----
  // Every used export gets a verdict, derived from where its retention chains
  // actually terminate. An export is genuinely used if ANY chain reaches a
  // genuinely-used root (one real consumer is enough to need it); it is an
  // over-retained suspect only when EVERY chain terminates at an over-retained
  // root (no genuine path keeps it alive). This answers "is each export really
  // used", not just "how big is each root".
  const rootVerdictByPath = new Map(rootRows.map((r) => [r.root, r.usageVerdict]));
  const EXPORT_VERDICT_PRIORITY = {
    'genuinely-used': 3,
    'needs-source-confirmation': 2,
    review: 1,
    'over-retained-suspect': 0,
  };
  const exportVerdictDistribution = {};
  const overRetainedExports = [];
  for (const item of usageRecords) {
    const resource = normalizeResource(item);
    const exportName = normalizeExportName(item);
    const chains = normalizeChains(item);
    let best = null;
    let coarseOnly = true;
    for (const chain of chains) {
      const root = normalizeChainTerminal(chain);
      const v = rootVerdictByPath.get(root) || 'review';
      if (best === null || EXPORT_VERDICT_PRIORITY[v] > EXPORT_VERDICT_PRIORITY[best]) best = v;
      if (!(Array.isArray(chain.edges) && chain.edges.some((e) => e && e.viaNamespace))) coarseOnly = false;
    }
    const verdict = chains.length === 0 ? 'no-chain' : best || 'review';
    exportVerdictDistribution[verdict] = (exportVerdictDistribution[verdict] || 0) + 1;
    if (verdict === 'over-retained-suspect') {
      overRetainedExports.push({ module: prettyPath(resource), exportName, coarseOnly });
    }
  }
  // group the suspect exports by provider module so the rewrite target is obvious
  const overRetainedExportsByModule = {};
  for (const e of overRetainedExports) {
    (overRetainedExportsByModule[e.module] ||= []).push(e.exportName);
  }

  // Model-confirmation worklist. The script can mechanically clear `genuinely-used`
  // exports (a chain reaches a real entry/route — no judgment needed), but it
  // CANNOT decide `needs-source-confirmation` (side-effect/unknown terminals) or
  // `over-retained-suspect`. Those need an agent (Claude/Codex) to read the source
  // and judge per export. Grouping by terminal root is the efficient unit: every
  // export sharing a root resolves from the same source read.
  const exportsNeedingModelAnalysis =
    (exportVerdictDistribution['needs-source-confirmation'] || 0) +
    (exportVerdictDistribution['over-retained-suspect'] || 0) +
    (exportVerdictDistribution.review || 0);
  const confirmationWorklist = rootRows
    .filter((r) => r.usageVerdict === 'needs-source-confirmation' || r.usageVerdict === 'over-retained-suspect' || r.usageVerdict === 'review')
    .map((r) => ({
      root: r.prettyRoot,
      verdict: r.usageVerdict,
      impactedExportCount: r.impactedExportCount,
      rewriteHint: r.rewriteHint,
      sampleExports: r.examples.slice(0, 8).map((e) => `${e.target} :: ${e.exportName}`),
    }));

  // Per-root usage verdict distribution: every root gets a verdict, so this is a
  // complete accounting of how much of the kept-alive surface is genuine runtime
  // reachability vs over-retention vs unverified.
  const verdictDistribution = {};
  for (const row of rootRows) {
    const v = (verdictDistribution[row.usageVerdict] ||= { roots: 0, impactedExports: 0 });
    v.roots += 1;
    v.impactedExports += row.impactedExportCount;
  }
  const overRetainedSuspects = rootRows
    .filter((row) => row.usageVerdict === 'over-retained-suspect')
    .slice(0, 40)
    .map((row) => ({
      root: row.prettyRoot,
      impactedExportCount: row.impactedExportCount,
      coarseSharePct: row.coarseSharePct,
      rewriteHint: row.rewriteHint,
    }));

  const summary = {
    generatedAt: new Date().toISOString(),
    source: relative(process.cwd(), usagePath),
    usageCount: usageRecords.length,
    usageWithChains: usageRecords.length - noChain.length,
    noChainCount: noChain.length,
    chainCount: rootRows.reduce((sum, row) => sum + row.chainCount, 0),
    uniqueRootCount: rootRows.length,
    uniqueTargetExportCount: new Set(usageRecords.map((item) => `${normalizeResource(item)}\n${normalizeExportName(item)}`)).size,
    topRootCoverage: rootRows.slice(0, 10).reduce((sum, row) => sum + row.impactedExportCount, 0),
    exportVerdictDistribution,
    overRetainedExportCount: overRetainedExports.length,
    exportsNeedingModelAnalysis,
    confirmationWorklistRootCount: confirmationWorklist.length,
    verdictDistribution,
    overRetainedSuspectRootCount: rootRows.filter((row) => row.usageVerdict === 'over-retained-suspect').length,
  };

  const result = {
    summary,
    exportVerdictDistribution,
    overRetainedExportsByModule,
    confirmationWorklist,
    categories: categoryRows,
    roots: rootRows,
    overRetainedSuspects,
    noChain: noChain.slice(0, 200),
  };
  mkdirSync(dirname(jsonOutPath), { recursive: true });
  writeFileSync(jsonOutPath, `${JSON.stringify(result, null, 2)}\n`);

  const lines = [];
  lines.push('# Export Usage Root Analysis');
  lines.push('');
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Export usage records: ${summary.usageCount}`);
  lines.push(`- Records with concrete chains: ${summary.usageWithChains}`);
  lines.push(`- Records without concrete chains: ${summary.noChainCount}`);
  lines.push(`- Concrete chain samples: ${summary.chainCount}`);
  lines.push(`- Unique terminal roots: ${summary.uniqueRootCount}`);
  lines.push(`- Unique target exports: ${summary.uniqueTargetExportCount}`);
  lines.push('');
  lines.push('## Per-Export Usage Verdict (every export)');
  lines.push('');
  lines.push('Each used export is verified individually: genuinely-used if any of its retention chains reaches a real runtime root, over-retained-suspect only if every chain terminates at an over-retained root.');
  lines.push('');
  lines.push('| verdict | exports |');
  lines.push('| --- | ---: |');
  for (const [verdict, count] of Object.entries(summary.exportVerdictDistribution).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${verdict} | ${count} |`);
  }
  lines.push('');
  const suspectModules = Object.entries(overRetainedExportsByModule).sort((a, b) => b[1].length - a[1].length);
  if (suspectModules.length > 0) {
    lines.push(`### Over-retained exports (${summary.overRetainedExportCount}) by provider module`);
    lines.push('');
    lines.push('These exports are kept alive only through over-retained roots — the actionable per-export set. Narrow the consuming import (named instead of namespace/barrel) and re-measure.');
    lines.push('');
    lines.push('| provider module | # exports | exports |');
    lines.push('| --- | ---: | --- |');
    for (const [mod, exps] of suspectModules.slice(0, 60)) {
      lines.push(`| ${mod} | ${exps.length} | ${exps.slice(0, 25).join(', ')}${exps.length > 25 ? ' …' : ''} |`);
    }
    lines.push('');
  } else {
    lines.push('_No over-retained exports: every used export reaches a genuine runtime root (or a side-effect/unknown terminal that needs source confirmation). Size is feature-driven._');
    lines.push('');
  }
  lines.push('## Model-Confirmation Worklist');
  lines.push('');
  lines.push(`The script cleared **${summary.exportVerdictDistribution['genuinely-used'] || 0}** exports as genuinely-used (a chain reaches a real entry/route — no judgment needed). The remaining **${summary.exportsNeedingModelAnalysis}** exports across **${summary.confirmationWorklistRootCount}** terminal roots are NOT decided by the script — an agent must read each root's source and judge whether those exports are really used. Work top-down by impact; resolve all exports under a root from one source read; do not stop until every export has a model-confirmed verdict (or record the explicit residual).`);
  lines.push('');
  lines.push('| root | verdict | exports to confirm | rewrite (if suspect) |');
  lines.push('| --- | --- | ---: | --- |');
  for (const w of confirmationWorklist.slice(0, 60)) {
    lines.push(`| ${w.root} | ${w.verdict} | ${w.impactedExportCount} | ${w.rewriteHint || ''} |`);
  }
  if (confirmationWorklist.length > 60) lines.push(`| … and ${confirmationWorklist.length - 60} more roots | | | |`);
  lines.push('');
  lines.push('## Per-Root Usage Verdict');
  lines.push('');
  lines.push('Roll-up of the above by terminal root — whether the exports a root keeps alive are genuinely referenced or only conservatively retained.');
  lines.push('');
  lines.push('| verdict | roots | impacted exports | meaning |');
  lines.push('| --- | ---: | ---: | --- |');
  const verdictMeaning = {
    'genuinely-used': 'real runtime root (entry/route/registration/decorator/value-map); not a bug',
    'over-retained-suspect': 'kept alive mostly via namespace/barrel edges; likely narrowable — see rewrite hint',
    'needs-source-confirmation': 'side-effect/unknown terminal; read the root to decide',
    review: 'ordinary chain; inspect source',
  };
  for (const [verdict, stats] of Object.entries(summary.verdictDistribution).sort((a, b) => b[1].impactedExports - a[1].impactedExports)) {
    lines.push(`| ${verdict} | ${stats.roots} | ${stats.impactedExports} | ${verdictMeaning[verdict] || ''} |`);
  }
  lines.push('');
  if (overRetainedSuspects.length > 0) {
    lines.push('### Over-retained suspects (actionable)');
    lines.push('');
    lines.push('| root | impacted exports | coarse % | rewrite |');
    lines.push('| --- | ---: | ---: | --- |');
    for (const s of overRetainedSuspects) {
      lines.push(`| ${s.root} | ${s.impactedExportCount} | ${s.coarseSharePct}% | ${s.rewriteHint || ''} |`);
    }
    lines.push('');
  } else {
    lines.push('_No over-retained suspects: every root is a genuine runtime root or needs source confirmation — size is feature-driven, not a tree-shaking gap._');
    lines.push('');
  }
  lines.push('## Root Cause Categories');
  lines.push('');
  lines.push('| category | impacted exports | roots | leading roots |');
  lines.push('| --- | ---: | ---: | --- |');
  for (const category of categoryRows) {
    const topRoots = category.topRoots.map((root) => `${root.root} (${root.impactedExportCount})`).join('<br>');
    lines.push(`| ${category.category} | ${category.impactedExportCount} | ${category.rootCount} | ${topRoots} |`);
  }
  lines.push('');
  lines.push('## Top Common Roots');
  lines.push('');
  lines.push('| rank | root | category | verdict | coarse % | impacted exports | chains | cause |');
  lines.push('| ---: | --- | --- | --- | ---: | ---: | ---: | --- |');
  rootRows.slice(0, 30).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.prettyRoot} | ${row.category} | ${row.usageVerdict} | ${row.coarseSharePct}% | ${row.impactedExportCount} | ${row.chainCount} | ${row.cause} |`);
  });
  lines.push('');
  lines.push('## Top Root Examples');
  for (const row of rootRows.slice(0, 12)) {
    lines.push('');
    lines.push(`### ${row.prettyRoot}`);
    lines.push('');
    lines.push(`- Category: ${row.category}`);
    lines.push(`- Usage verdict: **${row.usageVerdict}** — ${row.usageReason}`);
    if (row.rewriteHint) lines.push(`- Rewrite: ${row.rewriteHint}`);
    lines.push(`- Retention: ${row.preciseChainCount} precise chains, ${row.coarseChainCount} coarse (namespace/barrel) chains (${row.coarseSharePct}% coarse)`);
    lines.push(`- Impacted exports: ${row.impactedExportCount}`);
    lines.push(`- Chain samples: ${row.chainCount}`);
    lines.push(`- Cause: ${row.cause}`);
    lines.push(`- Feature flags: ${Object.entries(row.featureFlags).filter(([, enabled]) => enabled).map(([name]) => name).join(', ') || 'none'}`);
    lines.push('- Examples:');
    for (const example of row.examples.slice(0, 8)) {
      lines.push(`  - ${example.target} :: ${example.exportName} (${example.terminalKind}, ${example.edgeCount} edges)`);
    }
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- This consumes Rspack/Rsdoctor exportsUsage chains only; it does not compare against Rollup output.');
  lines.push('- Counts dedupe one root per target export, so repeated path samples do not inflate impacted export counts.');
  lines.push('- `module-side-effect-or-unknown-export` roots are real Rspack terminals but not precise export-to-export causes.');
  writeFileSync(mdOutPath, `${lines.join('\n')}\n`);

  console.log(`Wrote ${relative(process.cwd(), jsonOutPath)}`);
  console.log(`Wrote ${relative(process.cwd(), mdOutPath)}`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
