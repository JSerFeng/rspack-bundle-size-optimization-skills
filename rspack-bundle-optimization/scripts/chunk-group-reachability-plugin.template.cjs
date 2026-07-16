// @ts-nocheck
/**
 * Chunk Group Reachability Analysis Plugin
 *
 * Analyzes each chunk group to find JS modules that are included but not
 * reachable from the group's root modules via the moduleGraph.
 */
const { mkdirSync, readFileSync, writeFileSync } = require('fs');
const { extname, isAbsolute, relative, resolve } = require('path');

const JS_LIKE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

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

const isExternalModule = (compilation, module) => getModuleName(compilation, module).startsWith('external ');

const isJavaScriptLikeResource = (resource) => Boolean(resource && JS_LIKE_EXTENSIONS.has(extname(resource)));

const getModuleSizeRobust = (chunkGraph, module) => {
  let size = 0;
  try { size = chunkGraph.getModuleSize(module); } catch {}
  if (!size) {
    try { size = module.size(); } catch {}
  }
  if (!size) {
    try {
      const types = module.getSourceTypes?.();
      if (types) { for (const t of types) { size += module.size(t); } }
    } catch {}
  }
  return size || 0;
};

function getOutgoingModules(moduleGraph, module) {
  const targets = new Set();
  try {
    const connections = moduleGraph.getOutgoingConnections(module);
    for (const conn of connections || []) {
      if (!conn || !conn.module) continue;
      if (conn.weak) continue;
      const dep = conn.dependency;
      if (dep) {
        const parentBlock = safeInvoke(() => moduleGraph.getParentBlock(dep));
        if (parentBlock && parentBlock !== module &&
            parentBlock.constructor?.name?.includes('AsyncDependenciesBlock')) {
          continue;
        }
      }
      targets.add(conn.module);
    }
  } catch {}
  return targets;
}

function analyzeChunkGroupReachability(compilation, compilerContext) {
  const chunkGraph = compilation.chunkGraph;
  const moduleGraph = compilation.moduleGraph;
  if (!chunkGraph || !moduleGraph) {
    return { error: 'chunkGraph or moduleGraph not available' };
  }

  const chunkModulesMap = new Map();
  for (const chunk of compilation.chunks || []) {
    const mods = new Set();
    for (const m of safeInvoke(() => chunkGraph.getChunkModulesIterable(chunk)) || []) {
      mods.add(m);
    }
    chunkModulesMap.set(chunk, mods);
  }

  const getGroupModules = (chunkGroup) => {
    const mods = new Set();
    for (const chunk of chunkGroup.chunks || []) {
      for (const m of chunkModulesMap.get(chunk) || []) {
        mods.add(m);
      }
    }
    return mods;
  };

  const results = [];

  for (const chunkGroup of compilation.chunkGroups || []) {
    const isAsync = !!chunkGroup.isInitial && !chunkGroup.isInitial();
    const groupName = chunkGroup.name || chunkGroup.id || 'unnamed';
    const actualModules = getGroupModules(chunkGroup);
    if (actualModules.size === 0) continue;

    const rootModules = new Set();

    if (chunkGroup.isInitial && chunkGroup.isInitial()) {
      for (const chunk of chunkGroup.chunks || []) {
        for (const m of safeInvoke(() => chunkGraph.getChunkEntryModulesIterable(chunk)) || []) {
          rootModules.add(m);
        }
      }
    } else {
      for (const origin of chunkGroup.origins || []) {
        if (origin.dependency) {
          const targetModule = safeInvoke(() => moduleGraph.getModule(origin.dependency));
          if (targetModule) { rootModules.add(targetModule); continue; }
        }
        if (origin.module) {
          const blocks = safeInvoke(() => origin.module.blocks) || [];
          for (const block of blocks) {
            for (const dep of block.dependencies || []) {
              const targetModule = safeInvoke(() => moduleGraph.getModule(dep));
              if (targetModule && actualModules.has(targetModule)) {
                rootModules.add(targetModule);
              }
            }
          }
        }
      }
      if (rootModules.size === 0) {
        for (const chunk of chunkGroup.chunks || []) {
          for (const m of safeInvoke(() => chunkGraph.getChunkEntryModulesIterable(chunk)) || []) {
            rootModules.add(m);
          }
        }
      }
    }

    if (rootModules.size === 0) continue;

    const visited = new Set();
    const queue = [...rootModules];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const target of getOutgoingModules(moduleGraph, current)) {
        if (!visited.has(target)) {
          queue.push(target);
        }
      }
    }

    const reachableModules = new Set();
    for (const m of actualModules) {
      if (visited.has(m)) reachableModules.add(m);
    }

    let groupTotalJSSize = 0;       // source-level (module sizes)
    let groupEmittedJSSize = 0;     // emitted (minified) JS asset sizes
    const groupChunkNames = [];
    const groupChunkFiles = [];
    for (const chunk of chunkGroup.chunks || []) {
      groupChunkNames.push(chunk.name || chunk.id || 'unnamed');
      for (const m of chunkModulesMap.get(chunk) || []) {
        groupTotalJSSize += getModuleSizeRobust(chunkGraph, m);
      }
      // Sum emitted JS file sizes from compilation.assets
      const chunkModuleList = [];
      for (const file of chunk.files || []) {
        if (!file.endsWith('.js')) continue;
        const asset = compilation.assets[file];
        if (asset) {
          const assetSize = typeof asset.size === 'function' ? asset.size() : 0;
          groupEmittedJSSize += assetSize;
          // Collect modules in this chunk for per-chunk detail
          for (const m of chunkModulesMap.get(chunk) || []) {
            chunkModuleList.push({
              name: getModuleName(compilation, m),
              size: getModuleSizeRobust(chunkGraph, m),
            });
          }
          chunkModuleList.sort((a, b) => b.size - a.size);
          groupChunkFiles.push({ file, size: assetSize, modules: chunkModuleList.slice(0, 20) });
        }
      }
    }

    const removableJSModules = [];
    let removableJSSize = 0;
    let nonJSResidualCount = 0;

    for (const module of actualModules) {
      if (reachableModules.has(module)) continue;
      if (isExternalModule(compilation, module)) continue;

      const resource = getModuleResource(compilerContext, module);
      const size = getModuleSizeRobust(chunkGraph, module);

      if (isJavaScriptLikeResource(resource)) {
        removableJSModules.push({
          name: getModuleName(compilation, module),
          resource: resource ? relative(compilerContext, resource) : null,
          size,
        });
        removableJSSize += size;
      } else {
        nonJSResidualCount++;
      }
    }

    results.push({
      groupName,
      isAsync,
      chunks: groupChunkNames,
      chunkFiles: groupChunkFiles,
      groupEmittedJSSize,
      groupTotalJSSize,
      actualModuleCount: actualModules.size,
      rootModuleCount: rootModules.size,
      reachableModuleCount: reachableModules.size,
      removableJSModuleCount: removableJSModules.length,
      removableJSSize,
      nonJSResidualCount,
      removableJSModules: removableJSModules.sort((a, b) => b.size - a.size).slice(0, 50),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Chunk Graph Visualization
// ---------------------------------------------------------------------------

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(2) : val < 100 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/**
 * Scan the compilation and build a serialisable chunk-graph data structure.
 *
 * Returns { nodes, edges } where:
 *   node = { id, name, isInitial, totalEmittedSize, chunks: [{ name, size, files }] }
 *   edge = { from, to, imports: [{ loc, request, snippet }] }
 */
function buildChunkGraphData(compilation, compilerContext) {
  const chunkGraph = compilation.chunkGraph;

  // chunk -> Set<ChunkGroup>
  const chunkToGroups = new Map();
  for (const cg of compilation.chunkGroups || []) {
    for (const chunk of cg.chunks || []) {
      if (!chunkToGroups.has(chunk)) chunkToGroups.set(chunk, new Set());
      chunkToGroups.get(chunk).add(cg);
    }
  }

  // resource path -> Set<ChunkGroup>
  // Cannot use module object identity or identifier because rspack's
  // concatenateModules merges inner modules into ConcatenatedModules;
  // origin.module points to the inner module which doesn't appear directly
  // in chunkGraph.getChunkModulesIterable(). Fall back to resource path matching.
  const resourceToGroups = new Map();
  for (const chunk of compilation.chunks || []) {
    const groups = chunkToGroups.get(chunk) || new Set();
    for (const m of safeInvoke(() => chunkGraph.getChunkModulesIterable(chunk)) || []) {
      // Direct resource
      const res = m?.resource || safeInvoke(() => m?.nameForCondition?.());
      if (res) {
        if (!resourceToGroups.has(res)) resourceToGroups.set(res, new Set());
        for (const g of groups) resourceToGroups.get(res).add(g);
      }
      // For concatenated modules, also register the root module's resource
      const rootRes = m?.rootModule?.resource;
      if (rootRes && rootRes !== res) {
        if (!resourceToGroups.has(rootRes)) resourceToGroups.set(rootRes, new Set());
        for (const g of groups) resourceToGroups.get(rootRes).add(g);
      }
      // Also try inner modules of concatenated modules (rspack)
      const modules = safeInvoke(() => m.modules);
      if (modules) {
        for (const inner of modules) {
          const innerRes = inner?.resource || safeInvoke(() => inner?.nameForCondition?.());
          if (innerRes) {
            if (!resourceToGroups.has(innerRes)) resourceToGroups.set(innerRes, new Set());
            for (const g of groups) resourceToGroups.get(innerRes).add(g);
          }
        }
      }
    }
  }

  // --- Nodes ---
  const cgIdMap = new Map();
  const nodes = [];
  let idx = 0;

  for (const cg of compilation.chunkGroups || []) {
    const name = cg.name || String(cg.id ?? idx);
    const id = `cg_${idx++}`;
    cgIdMap.set(cg, id);

    const isInitial = !!cg.isInitial?.();
    let totalEmittedSize = 0;
    const chunks = [];

    for (const chunk of cg.chunks || []) {
      let chunkJSSize = 0;
      const jsFiles = [];
      for (const file of chunk.files || []) {
        if (!file.endsWith('.js')) continue;
        const asset = compilation.assets[file];
        if (asset) {
          const s = typeof asset.size === 'function' ? asset.size() : 0;
          chunkJSSize += s;
          jsFiles.push(file);
        }
      }
      totalEmittedSize += chunkJSSize;
      chunks.push({ name: String(chunk.name ?? chunk.id ?? '?'), size: chunkJSSize, files: jsFiles });
    }

    nodes.push({ id, name, isInitial, totalEmittedSize, chunks });
  }

  // --- Edges ---
  // In rspack, block.loc is undefined (native binding).
  // Use chunkGroup.origins[] which has loc, request, and module info.
  const edgeMap = new Map();
  const sourceFileCache = new Map();

  const readLines = (absPath) => {
    if (sourceFileCache.has(absPath)) return sourceFileCache.get(absPath);
    try {
      const lines = readFileSync(absPath, 'utf8').split('\n');
      sourceFileCache.set(absPath, lines);
      return lines;
    } catch {
      sourceFileCache.set(absPath, null);
      return null;
    }
  };

  for (const cg of compilation.chunkGroups || []) {
    if (cg.isInitial?.()) continue;
    const targetId = cgIdMap.get(cg);
    if (!targetId) continue;

    for (const origin of cg.origins || []) {
      if (!origin.module) continue;

      const loc = origin.loc;
      const request = origin.request || '';
      const originModule = origin.module;
      const moduleResource = getModuleResource(compilerContext, originModule);
      const relPath = moduleResource ? relative(compilerContext, moduleResource) : null;

      // Read code snippet from the source file at import() location
      let snippet = '';
      if (moduleResource && loc?.start?.line) {
        const lines = readLines(moduleResource);
        if (lines) {
          const startLine = Math.max(0, loc.start.line - 1);
          const endLine = loc.end?.line ? Math.min(lines.length, loc.end.line) : startLine + 1;
          snippet = lines
            .slice(startLine, Math.min(endLine, startLine + 3))
            .map((l, i) => `${startLine + i + 1} | ${l}`)
            .join('\n');
        }
      }

      const locStr = loc?.start
        ? `${relPath || '?'}:${loc.start.line}:${loc.start.column}`
        : relPath || '';

      // Find source chunk groups via resource path
      const originResource = originModule?.resource || safeInvoke(() => originModule?.nameForCondition?.());
      const sourceGroups = (originResource && resourceToGroups.get(originResource)) || new Set();

      for (const sourceCG of sourceGroups) {
        const sourceId = cgIdMap.get(sourceCG);
        if (!sourceId || sourceId === targetId) continue;

        const edgeKey = `${sourceId}->${targetId}`;
        if (!edgeMap.has(edgeKey)) {
          edgeMap.set(edgeKey, { from: sourceId, to: targetId, imports: [] });
        }
        const edge = edgeMap.get(edgeKey);
        if (!edge.imports.some((i) => i.loc === locStr && i.request === request)) {
          edge.imports.push({ loc: locStr, request, snippet });
        }
      }
    }
  }

  return { nodes, edges: [...edgeMap.values()] };
}

function generateChunkGraphHTML(graphData) {
  const nodesJSON = JSON.stringify(graphData.nodes);
  const edgesJSON = JSON.stringify(graphData.edges);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Chunk Graph Visualization</title>
<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"><\/script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; height: 100vh; overflow: hidden; }
#graph { flex: 1; background: #0d1117; }
#sidebar { width: 460px; background: #161b22; border-left: 1px solid #30363d; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
#sidebar h2 { font-size: 14px; color: #58a6ff; border-bottom: 1px solid #21262d; padding-bottom: 8px; }
#sidebar h3 { font-size: 13px; color: #8b949e; margin-top: 8px; }
.info-block { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 12px; font-size: 13px; line-height: 1.6; }
.chunk-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #21262d; }
.chunk-row:last-child { border-bottom: none; }
.chunk-name { color: #c9d1d9; font-family: monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.chunk-files { color: #8b949e; font-family: monospace; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.chunk-size { color: #7ee787; font-family: monospace; font-size: 12px; white-space: nowrap; }
.import-card { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 10px; margin-bottom: 8px; }
.import-loc { color: #d2a8ff; font-family: monospace; font-size: 11px; word-break: break-all; }
.import-request { color: #ffa657; font-family: monospace; font-size: 12px; margin: 4px 0; }
.import-snippet { background: #161b22; border: 1px solid #21262d; border-radius: 4px; padding: 8px; font-family: monospace; font-size: 11px; line-height: 1.5; white-space: pre; overflow-x: auto; color: #c9d1d9; margin-top: 6px; }
.placeholder { color: #484f58; font-style: italic; padding: 40px 0; text-align: center; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
.badge-initial { background: #1f6feb33; color: #58a6ff; }
.badge-async { background: #23863633; color: #7ee787; }
.size-total { font-size: 18px; color: #e6edf3; font-weight: 700; margin: 4px 0; }
.size-dedup { font-size: 14px; color: #ffa657; font-weight: 600; margin: 2px 0; }
.path-info { background: #1c1f26; border: 1px solid #30363d; border-radius: 6px; padding: 10px; margin-top: 8px; font-size: 12px; }
.path-info .label { color: #8b949e; }
.dedup-chunk { display: flex; justify-content: space-between; padding: 2px 0; font-family: monospace; font-size: 11px; }
.dedup-chunk .name { color: #c9d1d9; }
.dedup-chunk .size { color: #7ee787; }
#search { width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 13px; margin-bottom: 4px; }
#search::placeholder { color: #484f58; }
#search:focus { outline: none; border-color: #58a6ff; }
.legend { display: flex; gap: 16px; padding: 8px 0; font-size: 12px; }
.legend-item { display: flex; align-items: center; gap: 6px; }
.legend-dot { width: 12px; height: 12px; border-radius: 50%; }
</style>
</head>
<body>
<div id="graph"></div>
<div id="sidebar">
  <input id="search" type="text" placeholder="Search chunk groups..." />
  <div class="legend">
    <span class="legend-item"><span class="legend-dot" style="background:#1f6feb"></span> Entry</span>
    <span class="legend-item"><span class="legend-dot" style="background:#238636"></span> Async</span>
  </div>
  <div id="detail"><div class="placeholder">Click a node or edge to see details</div></div>
</div>

<script>
const RAW_NODES = ${nodesJSON};
const RAW_EDGES = ${edgesJSON};

function fmt(bytes) {
  if (bytes === 0) return '0 B';
  const u = ['B','KB','MB','GB'];
  const i = Math.min(Math.floor(Math.log(bytes)/Math.log(1024)), u.length-1);
  const v = bytes / Math.pow(1024, i);
  return (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Build adjacency for path finding (reverse edges: child -> parents)
const reverseAdj = {};  // targetId -> [sourceId]
const forwardAdj = {}; // sourceId -> [targetId]
RAW_EDGES.forEach(e => {
  if (!reverseAdj[e.to]) reverseAdj[e.to] = [];
  reverseAdj[e.to].push(e.from);
  if (!forwardAdj[e.from]) forwardAdj[e.from] = [];
  forwardAdj[e.from].push(e.to);
});

const nodeMap = {};
RAW_NODES.forEach(n => { nodeMap[n.id] = n; });

// Find all concrete paths from any entry to targetId via DFS (capped at 30)
function findAllPaths(targetId) {
  const entries = RAW_NODES.filter(n => n.isInitial).map(n => n.id);
  const paths = [];
  const MAX_PATHS = 30;
  function dfs(cur, target, visited, path) {
    if (paths.length >= MAX_PATHS) return;
    if (cur === target) { paths.push([...path]); return; }
    for (const next of forwardAdj[cur] || []) {
      if (!visited.has(next)) {
        visited.add(next);
        path.push(next);
        dfs(next, target, visited, path);
        path.pop();
        visited.delete(next);
      }
    }
  }
  for (const entry of entries) {
    dfs(entry, targetId, new Set([entry]), [entry]);
    if (paths.length >= MAX_PATHS) break;
  }
  // For entry nodes themselves, return a single self-path
  if (paths.length === 0 && entries.includes(targetId)) {
    paths.push([targetId]);
  }
  return paths;
}

// Compute deduplicated chunks for a single path (array of node ids)
function computePathChunks(path) {
  const seen = new Map();
  for (const nodeId of path) {
    const node = nodeMap[nodeId];
    if (!node) continue;
    for (const chunk of node.chunks) {
      if (!seen.has(chunk.name)) seen.set(chunk.name, chunk);
    }
  }
  const chunks = [...seen.entries()].sort((a, b) => b[1].size - a[1].size);
  let total = 0;
  for (const c of seen.values()) total += c.size;
  return { total, chunks };
}

// Collect all nodes on any path for highlighting
function allNodesOnPaths(paths) {
  const s = new Set();
  for (const p of paths) for (const n of p) s.add(n);
  return s;
}

function findEdgesOnPath(nodesOnPath) {
  const edgeIds = [];
  visEdges.forEach(e => {
    if (nodesOnPath.has(e.from) && nodesOnPath.has(e.to)) edgeIds.push(e.id);
  });
  return edgeIds;
}

const maxSize = Math.max(1, ...RAW_NODES.map(n => n.totalEmittedSize));
const visNodes = RAW_NODES.map(n => {
  const scale = Math.max(15, Math.min(50, 15 + 35 * Math.sqrt(n.totalEmittedSize / maxSize)));
  const color = n.isInitial ? '#1f6feb' : '#238636';
  const borderColor = n.isInitial ? '#58a6ff' : '#7ee787';
  return {
    id: n.id, label: n.name + '\\n' + fmt(n.totalEmittedSize), size: scale,
    color: { background: color, border: borderColor, highlight: { background: color, border: '#f0f6fc' } },
    font: { color: '#c9d1d9', size: 11, face: 'monospace' }, shape: 'dot', _raw: n,
    _origColor: { background: color, border: borderColor, highlight: { background: color, border: '#f0f6fc' } },
  };
});

const visEdges = RAW_EDGES.map((e, i) => ({
  id: 'e_' + i, from: e.from, to: e.to, arrows: 'to',
  label: e.imports.length > 1 ? e.imports.length + ' imports' : '',
  color: { color: '#30363d', highlight: '#58a6ff' },
  font: { color: '#8b949e', size: 9, face: 'monospace', strokeWidth: 0 },
  width: Math.min(4, 1 + e.imports.length * 0.5), _raw: e,
}));

const container = document.getElementById('graph');
const data = { nodes: new vis.DataSet(visNodes), edges: new vis.DataSet(visEdges) };
const options = {
  physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -80, centralGravity: 0.01, springLength: 150 }, stabilization: { iterations: 200 } },
  interaction: { hover: true, tooltipDelay: 200 },
  edges: { smooth: { type: 'continuous' } },
};
const network = new vis.Network(container, data, options);

const detail = document.getElementById('detail');

function resetHighlight() {
  data.nodes.update(visNodes.map(n => ({
    id: n.id,
    color: n._origColor,
    opacity: 1.0,
  })));
  data.edges.update(visEdges.map(e => ({
    id: e.id,
    color: { color: '#30363d', highlight: '#58a6ff' },
    width: Math.min(4, 1 + e._raw.imports.length * 0.5),
  })));
}

function highlightPaths(nodesOnPath, pathEdgeIds) {
  const pathEdgeSet = new Set(pathEdgeIds);
  data.nodes.update(visNodes.map(n => ({
    id: n.id,
    color: nodesOnPath.has(n.id) ? n._origColor : { background: '#21262d', border: '#30363d' },
    opacity: nodesOnPath.has(n.id) ? 1.0 : 0.2,
  })));
  data.edges.update(visEdges.map(e => ({
    id: e.id,
    color: pathEdgeSet.has(e.id) ? { color: '#f0883e', highlight: '#ffa657' } : { color: '#21262d' },
    width: pathEdgeSet.has(e.id) ? 3 : 1,
  })));
}

function showNodeDetail(raw) {
  // Chunk list with file names and chunk id
  const chunksHTML = raw.chunks.map(c => {
    const files = (c.files || []).join(', ');
    return '<div class="chunk-row"><div><span class="chunk-name" title="' + esc(c.name) + '">chunk: ' + esc(c.name) + '</span>' +
      (files ? '<br/><span class="chunk-files" title="' + esc(files) + '">' + esc(files) + '</span>' : '') +
      '</div><span class="chunk-size">' + fmt(c.size) + '</span></div>';
  }).join('');

  // Collect all import() origins pointing to this chunk group
  const inboundEdges = RAW_EDGES.filter(e => e.to === raw.id);
  let originsHTML = '';
  if (inboundEdges.length > 0) {
    originsHTML = '<h3>Origins (import() calls that load this group)</h3>';
    for (const edge of inboundEdges) {
      const fromNode = RAW_NODES.find(n => n.id === edge.from);
      const fromLabel = fromNode ? fromNode.name : edge.from;
      for (const imp of edge.imports) {
        originsHTML += '<div class="import-card">' +
          '<div style="color:#8b949e;font-size:11px;margin-bottom:4px;">from <span style="color:#58a6ff">' + esc(fromLabel) + '</span></div>' +
          (imp.request ? '<div class="import-request">import(' + esc(JSON.stringify(imp.request)) + ')</div>' : '') +
          (imp.loc ? '<div class="import-loc">' + esc(imp.loc) + '</div>' : '') +
          (imp.snippet ? '<div class="import-snippet">' + esc(imp.snippet) + '</div>' : '') +
          '</div>';
      }
    }
  }

  // Find all concrete paths from entries to this node
  const paths = findAllPaths(raw.id);
  const nodesOnPath = allNodesOnPaths(paths);
  const pathEdgeIds = findEdgesOnPath(nodesOnPath);
  highlightPaths(nodesOnPath, pathEdgeIds);

  // Per-path load size breakdown
  let pathsHTML = '';
  if (paths.length > 0) {
    pathsHTML = '<h3>Load paths from entry (' + paths.length + ')</h3>';
    for (let pi = 0; pi < paths.length; pi++) {
      const path = paths[pi];
      const { total, chunks } = computePathChunks(path);
      const pathLabel = path.map(id => { const n = nodeMap[id]; return n ? n.name : id; }).join(' \\u2192 ');
      const chunkRows = chunks.map(([name, c]) => {
        const files = (c.files || []).join(', ');
        return '<div class="dedup-chunk"><span class="name" title="' + esc(files) + '">' + esc(name) + (files ? ' <span style="color:#484f58;font-size:10px">(' + esc(files) + ')</span>' : '') + '</span><span class="size">' + fmt(c.size) + '</span></div>';
      }).join('');
      pathsHTML += '<div class="path-info" style="margin-bottom:10px">' +
        '<div style="font-size:11px;color:#8b949e;margin-bottom:6px">' + esc(pathLabel) + '</div>' +
        '<div class="size-dedup" style="margin-bottom:6px">' + fmt(total) + ' <span style="font-size:11px;color:#8b949e">(' + chunks.length + ' unique chunks)</span></div>' +
        chunkRows +
        '</div>';
    }
  }

  detail.innerHTML =
    '<h2>' + esc(raw.name) + '</h2>' +
    '<span class="badge ' + (raw.isInitial ? 'badge-initial' : 'badge-async') + '">' + (raw.isInitial ? 'Entry' : 'Async') + '</span>' +
    '<div class="size-total">' + fmt(raw.totalEmittedSize) + ' <span style="font-size:12px;color:#8b949e">(group own)</span></div>' +
    originsHTML +
    '<h3>Chunks in this group (' + raw.chunks.length + ')</h3>' +
    '<div class="info-block">' + (chunksHTML || '<span style="color:#484f58">No JS chunks</span>') + '</div>' +
    pathsHTML;
}

function showEdgeDetail(raw) {
  const fromNode = RAW_NODES.find(n => n.id === raw.from);
  const toNode = RAW_NODES.find(n => n.id === raw.to);
  const importsHTML = raw.imports.map(imp =>
    '<div class="import-card">' +
      (imp.request ? '<div class="import-request">import(' + esc(JSON.stringify(imp.request)) + ')</div>' : '') +
      (imp.loc ? '<div class="import-loc">' + esc(imp.loc) + '</div>' : '') +
      (imp.snippet ? '<div class="import-snippet">' + esc(imp.snippet) + '</div>' : '') +
    '</div>'
  ).join('');
  detail.innerHTML =
    '<h2>' + esc((fromNode?.name || raw.from) + ' \\u2192 ' + (toNode?.name || raw.to)) + '</h2>' +
    '<h3>import() calls (' + raw.imports.length + ')</h3>' + importsHTML;
}

network.on('click', function(params) {
  if (params.nodes.length > 0) {
    const node = visNodes.find(n => n.id === params.nodes[0]);
    if (node) showNodeDetail(node._raw);
  } else if (params.edges.length > 0) {
    resetHighlight();
    const edge = visEdges.find(e => e.id === params.edges[0]);
    if (edge) showEdgeDetail(edge._raw);
  } else {
    resetHighlight();
    detail.innerHTML = '<div class="placeholder">Click a node or edge to see details</div>';
  }
});

document.getElementById('search').addEventListener('input', function(e) {
  const q = e.target.value.toLowerCase();
  if (!q) {
    resetHighlight();
    data.nodes.update(visNodes.map(n => ({ id: n.id, hidden: false })));
    data.edges.update(visEdges.map(e => ({ id: e.id, hidden: false })));
    return;
  }
  const matchedIds = new Set();
  visNodes.forEach(n => { const m = n._raw.name.toLowerCase().includes(q); if (m) matchedIds.add(n.id); data.nodes.update({ id: n.id, hidden: !m }); });
  visEdges.forEach(e => { const show = matchedIds.has(e.from) || matchedIds.has(e.to); data.edges.update({ id: e.id, hidden: !show }); });
});
<\/script>
</body>
</html>`;
}

class ChunkGroupReachabilityPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    compiler.hooks.done.tap('ChunkGroupReachabilityPlugin', (stats) => {
      const compilation = stats.compilation;
      const compilerContext = compiler.context;
      const outDir = resolve(compilerContext, this.options.outDir ?? './tmp');

      mkdirSync(outDir, { recursive: true });

      const results = analyzeChunkGroupReachability(compilation, compilerContext);
      const outPath = resolve(outDir, 'chunk-group-reachability.json');
      writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n', 'utf8');

      const asyncGroups = Array.isArray(results) ? results.filter((g) => g.isAsync) : [];
      const removableGroups = asyncGroups.filter((g) => g.removableJSModuleCount > 0);
      const totalRemovable = removableGroups.reduce((s, g) => s + g.removableJSSize, 0);

      console.log(`[ChunkGroupReachability] ${results.length} groups, ${removableGroups.length} with removable modules (${totalRemovable} B)`);
      console.log(`[ChunkGroupReachability] Written to ${outPath}`);

      // --- Chunk graph visualization ---
      try {
        const graphData = buildChunkGraphData(compilation, compilerContext);
        const graphJsonPath = resolve(outDir, 'chunk-graph.json');
        writeFileSync(graphJsonPath, JSON.stringify(graphData, null, 2) + '\n', 'utf8');

        const htmlPath = resolve(outDir, 'chunk-graph.html');
        writeFileSync(htmlPath, generateChunkGraphHTML(graphData), 'utf8');

        console.log(`[ChunkGroupReachability] Chunk graph: ${graphData.nodes.length} groups, ${graphData.edges.length} edges`);
        console.log(`[ChunkGroupReachability] Graph visualization written to ${htmlPath}`);
      } catch (err) {
        console.warn(`[ChunkGroupReachability] Failed to generate chunk graph: ${err.message}`);
      }
    });
  }
}

module.exports = { ChunkGroupReachabilityPlugin, analyzeChunkGroupReachability, buildChunkGraphData, generateChunkGraphHTML };
