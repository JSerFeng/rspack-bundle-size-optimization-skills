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

function classifyRoot(resource, terminalKinds, textInfo, graphInfo = {}) {
  const clean = stripQuery(resource) || '';
  const rel = prettyPath(clean);
  const source = textInfo.source || '';
  const combined = textInfo.combined || '';
  const moduleLevelImportCount = Array.isArray(graphInfo.moduleLevelImportCauses)
    ? graphInfo.moduleLevelImportCauses.length
    : 0;
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
    wholeModuleImport: moduleLevelImportCount > 0,
    sideEffectUnknown: terminalKinds.has('module-side-effect-or-unknown-export'),
    noExportIncoming: terminalKinds.has('no-export-incoming'),
  };

  let category = 'other';
  let cause = 'ordinary import/export chain; inspect source manually';
  if (featureFlags.entryBootstrap) {
    category = 'entry/bootstrap root';
    cause = 'application entry or service registration root keeps downstream exports live';
  } else if (featureFlags.wholeModuleImport) {
    category = 'whole-module import root';
    cause = 'a whole-module import/namespace edge involving this root makes a provider exports object live';
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
      moduleLevelImportCount,
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
  if (category === 'whole-module import root') {
    if (coarseShare >= 0.5) {
      return {
        usageVerdict: 'over-retained-suspect',
        usageReason:
          `${Math.round(coarseShare * 100)}% of chains retain exports through whole-module import/namespace usage; inspect the recorded import loc and narrow the import site`,
        rewriteHint:
          'move named destructuring/member access to the import site; avoid helpers that return or store the entire import() namespace; split helpers per export when needed',
        coarseShare,
      };
    }
    return {
      usageVerdict: 'review',
      usageReason: 'module has whole-module import causes, but most retained chains are precise; inspect the import loc before rewriting',
      rewriteHint: 'inspect moduleLevelImportCauses and narrow only the broad import sites that are not genuine namespace use',
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

function normalizeModuleLevelImports(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    targetResource: stripQuery(item.targetResource || item.target || item.toResource || item.to || item.module || item.resource),
    targetPretty: prettyPath(item.targetResource || item.target || item.toResource || item.to || item.module || item.resource),
    originResource: stripQuery(item.originResource || item.origin || item.fromResource || item.from || item.consumer || item.importer),
    originPretty: prettyPath(item.originResource || item.origin || item.fromResource || item.from || item.consumer || item.importer),
    originExport: item.originExport || item.originExports || item.fromExport || item.fromExports || null,
    request: item.request || item.dependencyRequest || null,
    dependencyId: item.dependencyId || item.depId || null,
    loc: item.loc || item.location || item.dependencyLoc || null,
    importShape: item.importShape || item.kind || 'whole-module-import',
  })).filter((item) => item.targetResource && item.originResource);
}

function normalizeExportName(item) {
  return item.exportName || item.name || item.targetExport || item.export || '(unknown)';
}

function buildExportNamesByResource(usageRecords) {
  const exportsByResource = new Map();
  for (const item of usageRecords) {
    const resource = normalizeResource(item);
    const exportName = normalizeExportName(item);
    if (!resource || !isJavaScriptLike(resource) || !exportName || exportName === '(unknown)') continue;
    if (!exportsByResource.has(resource)) exportsByResource.set(resource, new Set());
    exportsByResource.get(resource).add(exportName);
  }
  return exportsByResource;
}

function singleKnownExport(exportsByResource, resource) {
  const names = Array.from(exportsByResource.get(stripQuery(resource)) || []);
  return names.length === 1 ? names[0] : null;
}

function edgeSummary(edge) {
  return {
    fromResource: stripQuery(edge.from || edge.fromResource || edge.originModule || edge.origin),
    toResource: stripQuery(edge.to || edge.toResource || edge.targetModule || edge.target),
    from: prettyPath(edge.from || edge.fromResource || edge.originModule || edge.origin),
    to: prettyPath(edge.to || edge.toResource || edge.targetModule || edge.target),
    request: edge.request || null,
    dependencyId: edge.dependencyId || edge.depId || null,
    viaNamespace: Boolean(edge.viaNamespace),
    matchedExport: edge.matchedExport || edge.referencedExport || null,
    originExport: edge.originExport || null,
    targetExport: edge.targetExport || null,
    loc: edge.loc || edge.location || null,
  };
}

function formatLoc(loc) {
  if (!loc) return '';
  if (typeof loc === 'string') return loc;
  if (typeof loc === 'number') return String(loc);
  if (typeof loc === 'object') {
    const start = loc.start || loc;
    const end = loc.end;
    if (start && typeof start.line !== 'undefined') {
      const startColumn = typeof start.column === 'undefined' ? 0 : start.column;
      if (end && typeof end.line !== 'undefined') {
        const endColumn = typeof end.column === 'undefined' ? 0 : end.column;
        return `${start.line}:${startColumn}-${end.line}:${endColumn}`;
      }
      return `${start.line}:${startColumn}`;
    }
    return JSON.stringify(loc);
  }
  return String(loc);
}

function formatExportValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.join('.');
  return String(value);
}

function rootTriggerKey(root, trigger) {
  if (!trigger) return `${root}\n(no-trigger)`;
  return [
    root,
    formatLoc(trigger.loc) || 'loc:unknown',
    trigger.request || 'request:unknown',
    trigger.dependencyId || 'dependency:unknown',
  ].join('\n');
}

function buildChainVisual(edges, root, resource, exportName, exportsByResource) {
  const rootToTargetEdges = edges.slice().reverse();
  if (rootToTargetEdges.length === 0) {
    const rootExportFallback = root === resource ? null : singleKnownExport(exportsByResource, root || resource);
    return {
      rootTrigger: null,
      rootToTargetEdges,
      nodes: [
        {
          resource: root || resource,
          prettyPath: prettyPath(root || resource),
          role: root === resource ? 'terminal-root-and-target-export' : 'terminal-root',
          activeExport: root === resource ? exportName : rootExportFallback,
          activeExportSource: rootExportFallback ? 'module-used-export' : undefined,
        },
        ...(root && root !== resource
          ? [{
              resource,
              prettyPath: prettyPath(resource),
              role: 'target-export-endpoint',
              activeExport: exportName,
            }]
          : []),
      ],
    };
  }

  const firstEdge = rootToTargetEdges[0];
  const firstActiveExport = formatExportValue(firstEdge.originExport);
  const firstFallbackExport = firstActiveExport ? null : singleKnownExport(exportsByResource, firstEdge.fromResource || root);
  const nodes = [
    {
      resource: firstEdge.fromResource || root,
      prettyPath: firstEdge.from || prettyPath(root),
      role: 'terminal-root',
      activeExport: firstActiveExport || firstFallbackExport,
      activeExportSource: firstFallbackExport ? 'module-used-export' : undefined,
      outgoingEdgeIndex: 0,
    },
  ];
  rootToTargetEdges.forEach((edge, index) => {
    nodes.push({
      resource: edge.toResource,
      prettyPath: edge.to,
      role: index === rootToTargetEdges.length - 1 ? 'target-export-endpoint' : 'intermediate-module',
      activeExport: index === rootToTargetEdges.length - 1 ? exportName : formatExportValue(edge.targetExport),
      incomingEdgeIndex: index,
      outgoingEdgeIndex: index + 1 < rootToTargetEdges.length ? index + 1 : null,
    });
  });
  return {
    rootTrigger: {
      from: firstEdge.from,
      to: firstEdge.to,
      loc: firstEdge.loc || null,
      request: firstEdge.request || null,
      dependencyId: firstEdge.dependencyId || null,
      viaNamespace: Boolean(firstEdge.viaNamespace),
    },
    rootToTargetEdges,
    nodes,
  };
}

function chainSummary(chain, root, resource, exportName, exportsByResource) {
  const edges = Array.isArray(chain.edges) ? chain.edges.map(edgeSummary) : [];
  const visual = buildChainVisual(edges, root, resource, exportName, exportsByResource);
  return {
    terminal: root,
    terminalPretty: prettyPath(root),
    terminalKind: chain.terminalKind || chain.rootKind || 'unknown',
    targetModule: resource,
    targetModulePretty: prettyPath(resource),
    exportName,
    endpoint: `${prettyPath(resource)} :: ${exportName}`,
    edgeCount: edges.length,
    capped: Boolean(chain.capped),
    rootTrigger: visual.rootTrigger,
    rootToTargetEdges: visual.rootToTargetEdges,
    nodes: visual.nodes,
    edges,
  };
}

function groupChainsByRootTrigger(chains) {
  const groups = new Map();
  chains.forEach((chain, index) => {
    const key = rootTriggerKey(chain.terminal, chain.rootTrigger);
    if (!groups.has(key)) {
      groups.set(key, {
        rootTrigger: chain.rootTrigger || null,
        chainIndexes: [],
      });
    }
    groups.get(key).chainIndexes.push(index);
  });
  return Array.from(groups.values()).map((group) => ({
    rootTrigger: group.rootTrigger,
    chainCount: group.chainIndexes.length,
    chainIndexes: group.chainIndexes,
  }));
}

function groupRootTriggers(exports) {
  const groups = new Map();
  exports.forEach((exportRow, exportIndex) => {
    exportRow.chains.forEach((chain, chainIndex) => {
      const key = rootTriggerKey(chain.terminal, chain.rootTrigger);
      if (!groups.has(key)) {
        groups.set(key, {
          rootTrigger: chain.rootTrigger || null,
          exportIndexes: new Set(),
          chainRefs: [],
        });
      }
      const group = groups.get(key);
      group.exportIndexes.add(exportIndex);
      group.chainRefs.push({ exportIndex, chainIndex });
    });
  });
  return Array.from(groups.values()).map((group) => ({
    rootTrigger: group.rootTrigger,
    impactedExportCount: group.exportIndexes.size,
    chainCount: group.chainRefs.length,
    chainRefs: group.chainRefs,
  })).sort((a, b) => b.impactedExportCount - a.impactedExportCount || b.chainCount - a.chainCount);
}

function main() {
  if (!existsSync(usagePath)) {
    throw new Error(`Missing exportsUsage snapshot: ${usagePath}`);
  }

  const usageSnapshot = readJson(usagePath);
  const usageRecords = usageSnapshot.usages || usageSnapshot.exportsUsage || usageSnapshot.records || [];
  const moduleLevelImports = normalizeModuleLevelImports(
    usageSnapshot.moduleLevelImports || usageSnapshot.moduleNamespaceImports || usageSnapshot.wholeModuleImports || [],
  );
  const moduleLevelImportsByTarget = new Map();
  const moduleLevelImportsByOrigin = new Map();
  for (const cause of moduleLevelImports) {
    if (!moduleLevelImportsByTarget.has(cause.targetResource)) moduleLevelImportsByTarget.set(cause.targetResource, []);
    moduleLevelImportsByTarget.get(cause.targetResource).push(cause);
    if (!moduleLevelImportsByOrigin.has(cause.originResource)) moduleLevelImportsByOrigin.set(cause.originResource, []);
    moduleLevelImportsByOrigin.get(cause.originResource).push(cause);
  }
  const exportsByResource = buildExportNamesByResource(usageRecords);
  const materializedByResource = buildMaterializedMap(optionalReportPath);
  const roots = new Map();
  const categoryExportKeys = new Map();
  const categoryModuleKeys = new Map();
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
          exportsByKey: new Map(),
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
      if (!row.exportsByKey.has(exportKey)) {
        row.exportsByKey.set(exportKey, {
          targetModule: resource,
          targetModulePretty: prettyPath(resource),
          exportName,
          chains: [],
        });
      }
      row.exportsByKey.get(exportKey).chains.push(chainSummary(chain, root, resource, exportName, exportsByResource));
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
    const rootAsConsumerCauses = (moduleLevelImportsByOrigin.get(stripQuery(row.root)) || [])
      .map((cause) => ({ ...cause, rootRole: 'consumer' }));
    const rootAsProviderCauses = (moduleLevelImportsByTarget.get(stripQuery(row.root)) || [])
      .map((cause) => ({ ...cause, rootRole: 'provider' }));
    const moduleLevelImportCauses = rootAsConsumerCauses.concat(rootAsProviderCauses).slice(0, 20);
    const classification = classifyRoot(
      row.root,
      row.terminalKinds,
      sourceForResource(row.root, materializedByResource),
      { moduleLevelImportCauses },
    );
    addToMapSet(categoryRootKeys, classification.category, row.root);
    for (const key of row.impactedExports) addToMapSet(categoryExportKeys, classification.category, key);
    for (const key of row.impactedModules) addToMapSet(categoryModuleKeys, classification.category, key);
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
      exports: (() => {
        const exports = Array.from(row.exportsByKey.values()).map((exportRow) => {
          const coarseChainCount = exportRow.chains.filter((chain) => chain.rootToTargetEdges.some((edge) => edge.viaNamespace)).length;
          return {
            ...exportRow,
            endpoint: `${exportRow.targetModulePretty} :: ${exportRow.exportName}`,
            chainCount: exportRow.chains.length,
            coarseChainCount,
            preciseChainCount: exportRow.chains.length - coarseChainCount,
            chainGroups: groupChainsByRootTrigger(exportRow.chains),
          };
        }).sort((a, b) => b.chainCount - a.chainCount || a.targetModulePretty.localeCompare(b.targetModulePretty) || a.exportName.localeCompare(b.exportName));
        return exports;
      })(),
      topImpactedModules: Array.from(row.impactedModules).sort().slice(0, 12).map(prettyPath),
      chainCount: row.chainCount,
      terminalKinds: Object.fromEntries(Array.from(row.terminalKinds.entries()).sort((a, b) => b[1] - a[1])),
      featureFlags: classification.featureFlags,
      metrics: classification.metrics,
      moduleLevelImportCauses,
      examples: row.examples,
      firstEdges: row.firstEdges,
    };
  }).map((row) => ({
    ...row,
    triggerGroups: groupRootTriggers(row.exports),
  })).sort((a, b) => b.impactedModuleCount - a.impactedModuleCount || b.impactedExportCount - a.impactedExportCount || b.chainCount - a.chainCount);

  const categoryRows = Array.from(categoryExportKeys.entries()).map(([category, exportSet]) => ({
    category,
    impactedExportCount: exportSet.size,
    impactedModuleCount: categoryModuleKeys.get(category)?.size || 0,
    rootCount: categoryRootKeys.get(category)?.size || 0,
    topRoots: rootRows
      .filter((row) => row.category === category)
      .slice(0, 8)
      .map((row) => ({
        root: row.prettyRoot,
        impactedExportCount: row.impactedExportCount,
        impactedModuleCount: row.impactedModuleCount,
        chainCount: row.chainCount,
      })),
  })).sort((a, b) => b.impactedModuleCount - a.impactedModuleCount || b.impactedExportCount - a.impactedExportCount);

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

  // Source-review worklist. The script can mechanically clear `genuinely-used`
  // exports (a chain reaches a real entry/route — no judgment needed), but it
  // CANNOT decide `needs-source-confirmation` (side-effect/unknown terminals) or
  // `over-retained-suspect`. Those require source inspection and a per-export
  // verdict. Grouping by terminal root is the efficient unit: every
  // export sharing a root resolves from the same source read.
  const exportsNeedingSourceReview =
    (exportVerdictDistribution['needs-source-confirmation'] || 0) +
    (exportVerdictDistribution['over-retained-suspect'] || 0) +
    (exportVerdictDistribution.review || 0);
  const confirmationWorklist = rootRows
    .filter((r) => r.usageVerdict === 'needs-source-confirmation' || r.usageVerdict === 'over-retained-suspect' || r.usageVerdict === 'review')
    .map((r) => ({
      root: r.prettyRoot,
      verdict: r.usageVerdict,
      impactedExportCount: r.impactedExportCount,
      impactedModuleCount: r.impactedModuleCount,
      rewriteHint: r.rewriteHint,
      moduleLevelImportCauses: r.moduleLevelImportCauses.slice(0, 5).map((cause) => ({
        origin: cause.originPretty,
        target: cause.targetPretty,
        rootRole: cause.rootRole,
        request: cause.request,
        loc: formatLoc(cause.loc),
        dependencyId: cause.dependencyId,
        importShape: cause.importShape,
      })),
      sampleExports: r.examples.slice(0, 8).map((e) => `${e.target} :: ${e.exportName}`),
    }));

  // Per-root usage verdict distribution: every root gets a verdict, so this is a
  // complete accounting of how much of the kept-alive surface is genuine runtime
  // reachability vs over-retention vs unverified.
  const verdictDistribution = {};
  for (const row of rootRows) {
    const v = (verdictDistribution[row.usageVerdict] ||= { roots: 0, impactedExports: 0, impactedModules: 0 });
    v.roots += 1;
    v.impactedExports += row.impactedExportCount;
    v.impactedModules += row.impactedModuleCount;
  }
  const overRetainedSuspects = rootRows
    .filter((row) => row.usageVerdict === 'over-retained-suspect')
    .slice(0, 40)
    .map((row) => ({
      root: row.prettyRoot,
      impactedExportCount: row.impactedExportCount,
      impactedModuleCount: row.impactedModuleCount,
      coarseSharePct: row.coarseSharePct,
      rewriteHint: row.rewriteHint,
    }));
  const wholeModuleImportAudits = Array.from(moduleLevelImportsByTarget.entries())
    .map(([targetResource, causes]) => ({
      providerModule: targetResource,
      providerModulePretty: prettyPath(targetResource),
      causeCount: causes.length,
      consumers: causes.slice(0, 20).map((cause) => ({
        consumerModule: cause.originResource,
        consumerModulePretty: cause.originPretty,
        originExport: cause.originExport,
        request: cause.request,
        loc: cause.loc,
        locText: formatLoc(cause.loc),
        dependencyId: cause.dependencyId,
        importShape: cause.importShape,
      })),
      rewriteHint:
        'inspect the consumer loc; move named destructuring/member access to the import site, split namespace-returning helpers per export, or keep only if genuine namespace semantics are required',
    }))
    .sort((a, b) => b.causeCount - a.causeCount || a.providerModulePretty.localeCompare(b.providerModulePretty));

  const summary = {
    generatedAt: new Date().toISOString(),
    source: relative(process.cwd(), usagePath),
    usageCount: usageRecords.length,
    usageWithChains: usageRecords.length - noChain.length,
    noChainCount: noChain.length,
    chainCount: rootRows.reduce((sum, row) => sum + row.chainCount, 0),
    uniqueRootCount: rootRows.length,
    uniqueTargetExportCount: new Set(usageRecords.map((item) => `${normalizeResource(item)}\n${normalizeExportName(item)}`)).size,
    uniqueTargetModuleCount: new Set(usageRecords.map((item) => normalizeResource(item))).size,
    moduleLevelImportCauseCount: moduleLevelImports.length,
    moduleLevelImportTargetCount: moduleLevelImportsByTarget.size,
    topRootCoverage: rootRows.slice(0, 10).reduce((sum, row) => sum + row.impactedExportCount, 0),
    topRootModuleCoverage: rootRows.slice(0, 10).reduce((sum, row) => sum + row.impactedModuleCount, 0),
    exportVerdictDistribution,
    overRetainedExportCount: overRetainedExports.length,
    exportsNeedingSourceReview,
    confirmationWorklistRootCount: confirmationWorklist.length,
    wholeModuleImportAuditCount: wholeModuleImportAudits.length,
    verdictDistribution,
    overRetainedSuspectRootCount: rootRows.filter((row) => row.usageVerdict === 'over-retained-suspect').length,
  };

  const result = {
    summary,
    exportVerdictDistribution,
    overRetainedExportsByModule,
    moduleLevelImports,
    wholeModuleImportAudits,
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
  lines.push(`- Unique target modules: ${summary.uniqueTargetModuleCount}`);
  lines.push(`- Whole-module import causes: ${summary.moduleLevelImportCauseCount}`);
  lines.push(`- Whole-module import target modules: ${summary.moduleLevelImportTargetCount}`);
  lines.push('');
  if (wholeModuleImportAudits.length > 0) {
    lines.push('## Whole-Module Import Audit (`usedExports:true` leads)');
    lines.push('');
    lines.push('These provider modules are consumed through a whole-module / namespace edge. Inspect the consumer loc first; this is how to find helpers that return an `import()` namespace and make all provider exports live.');
    lines.push('');
    lines.push('| provider module | import causes | leading consumer import sites | rewrite |');
    lines.push('| --- | ---: | --- | --- |');
    for (const audit of wholeModuleImportAudits.slice(0, 40)) {
      const consumers = audit.consumers.slice(0, 5).map((cause) => {
        const details = [
          cause.request ? `request ${cause.request}` : null,
          cause.locText ? `loc ${cause.locText}` : null,
          cause.dependencyId ? `dependency ${cause.dependencyId}` : null,
          cause.importShape ? `shape ${cause.importShape}` : null,
        ].filter(Boolean).join('; ');
        return `${cause.consumerModulePretty}${details ? ` (${details})` : ''}`;
      }).join('<br>');
      lines.push(`| ${audit.providerModulePretty} | ${audit.causeCount} | ${consumers} | ${audit.rewriteHint} |`);
    }
    if (wholeModuleImportAudits.length > 40) {
      lines.push(`| … and ${wholeModuleImportAudits.length - 40} more providers | | | |`);
    }
    lines.push('');
  }
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
  lines.push('## Source-Review Worklist');
  lines.push('');
  lines.push(`The script cleared **${summary.exportVerdictDistribution['genuinely-used'] || 0}** exports as genuinely-used (a chain reaches a real entry/route — no judgment needed). The remaining **${summary.exportsNeedingSourceReview}** exports across **${summary.confirmationWorklistRootCount}** terminal roots are NOT decided by the script — read each root's source and determine whether those exports are really used. Work top-down by impacted module count first, then impacted export count; resolve all exports under a root from one source read; do not stop until every export has a source-backed verdict (or record the explicit residual).`);
  lines.push('');
  lines.push('| root | verdict | exports to confirm | modules to inspect | rewrite (if suspect) |');
  lines.push('| --- | --- | ---: | ---: | --- |');
  for (const w of confirmationWorklist.slice(0, 60)) {
    lines.push(`| ${w.root} | ${w.verdict} | ${w.impactedExportCount} | ${w.impactedModuleCount} | ${w.rewriteHint || ''} |`);
  }
  if (confirmationWorklist.length > 60) lines.push(`| … and ${confirmationWorklist.length - 60} more roots | | | |`);
  lines.push('');
  lines.push('## Per-Root Usage Verdict');
  lines.push('');
  lines.push('Roll-up of the above by terminal root — whether the exports a root keeps alive are genuinely referenced or only conservatively retained.');
  lines.push('');
  lines.push('| verdict | roots | impacted exports | impacted modules | meaning |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  const verdictMeaning = {
    'genuinely-used': 'real runtime root (entry/route/registration/decorator/value-map); not a bug',
    'over-retained-suspect': 'kept alive mostly via namespace/barrel edges; likely narrowable — see rewrite hint',
    'needs-source-confirmation': 'side-effect/unknown terminal; read the root to decide',
    review: 'ordinary chain; inspect source',
  };
  for (const [verdict, stats] of Object.entries(summary.verdictDistribution).sort((a, b) => b[1].impactedExports - a[1].impactedExports)) {
    lines.push(`| ${verdict} | ${stats.roots} | ${stats.impactedExports} | ${stats.impactedModules} | ${verdictMeaning[verdict] || ''} |`);
  }
  lines.push('');
  if (overRetainedSuspects.length > 0) {
    lines.push('### Over-retained suspects (actionable)');
    lines.push('');
    lines.push('| root | impacted exports | impacted modules | coarse % | rewrite |');
    lines.push('| --- | ---: | ---: | ---: | --- |');
    for (const s of overRetainedSuspects) {
      lines.push(`| ${s.root} | ${s.impactedExportCount} | ${s.impactedModuleCount} | ${s.coarseSharePct}% | ${s.rewriteHint || ''} |`);
    }
    lines.push('');
  } else {
    lines.push('_No over-retained suspects: every root is a genuine runtime root or needs source confirmation — size is feature-driven, not a tree-shaking gap._');
    lines.push('');
  }
  lines.push('## Root Cause Categories');
  lines.push('');
  lines.push('| category | impacted exports | impacted modules | roots | leading roots |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const category of categoryRows) {
    const topRoots = category.topRoots.map((root) => `${root.root} (${root.impactedExportCount} exports / ${root.impactedModuleCount} modules)`).join('<br>');
    lines.push(`| ${category.category} | ${category.impactedExportCount} | ${category.impactedModuleCount} | ${category.rootCount} | ${topRoots} |`);
  }
  lines.push('');
  lines.push('## Top Common Roots');
  lines.push('');
  lines.push('| rank | root | category | verdict | coarse % | impacted exports | impacted modules | chains | cause |');
  lines.push('| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- |');
  rootRows.slice(0, 30).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.prettyRoot} | ${row.category} | ${row.usageVerdict} | ${row.coarseSharePct}% | ${row.impactedExportCount} | ${row.impactedModuleCount} | ${row.chainCount} | ${row.cause} |`);
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
    lines.push(`- Impacted modules: ${row.impactedModuleCount}`);
    if (row.moduleLevelImportCauses.length > 0) {
      lines.push('- Whole-module import causes:');
      for (const cause of row.moduleLevelImportCauses.slice(0, 5)) {
        const loc = formatLoc(cause.loc);
        const edge = `${cause.originPretty} -> ${cause.targetPretty}`;
        const details = [
          cause.request ? `request ${cause.request}` : null,
          loc ? `loc ${loc}` : null,
          cause.dependencyId ? `dependency ${cause.dependencyId}` : null,
          cause.importShape ? `shape ${cause.importShape}` : null,
          cause.rootRole ? `root role ${cause.rootRole}` : null,
        ].filter(Boolean).join('; ');
        lines.push(`  - ${edge}${details ? ` (${details})` : ''}`);
      }
    }
    if (row.topImpactedModules.length > 0) lines.push(`- Top impacted modules: ${row.topImpactedModules.join(', ')}`);
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
  lines.push('- Root rows are sorted by impacted modules first because this better reflects how much downstream module surface a root keeps alive; impacted exports are the second sort key.');
  lines.push('- `module-side-effect-or-unknown-export` roots are real Rspack terminals but not precise export-to-export causes.');
  writeFileSync(mdOutPath, `${lines.join('\n')}\n`);

  console.log(`Wrote ${relative(process.cwd(), jsonOutPath)}`);
  console.log(`Wrote ${relative(process.cwd(), mdOutPath)}`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
