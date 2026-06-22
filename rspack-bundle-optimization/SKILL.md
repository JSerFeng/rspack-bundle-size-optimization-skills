---
name: rspack-bundle-optimization
description: Analyze and optimize Rspack, Rsbuild, or Rspeedy web bundles. Use when the user wants bundle-size reports, chunk-group reachability, usedExports or optimizationBailout analysis, Rollup-vs-Rspack tree-shaking diffs, CJS-to-ESM experiments, side-effects experiments, splitChunks tuning, or measured optimization plans.
---

# Rspack Bundle Optimization

Use this skill when the task is to understand or reduce bundle size in a Rspack-family build.

This skill is intentionally generic. Apply it to direct `rspack` configs, `rsbuild`, or `rspeedy` projects by adapting the hook points to the local build system.

## Goals

Produce evidence, not guesses:

1. Establish a reproducible baseline.
2. Separate real opportunities from analysis noise.
3. Run env-gated experiments instead of changing defaults blindly.
4. Quantify gains in bytes and percent.
5. Stop when the remaining candidates are entries, real side effects, or tiny residuals.

## Mode Selection

On the first broad bundle-optimization request, briefly show the available modes once and recommend **Quick Triage**. Do not block on a choice unless the next step is expensive, changes build config, or will generate large artifacts.

If the user names a mode, run that mode directly. If the user says "全部", "一起做", "full", or similar, use **Full Pipeline** and confirm expected runtime/artifacts before the expensive run.

Available modes:

- **Quick Triage** (default): capture baseline size, output location, largest assets/modules, existing stats, and recommend the next mode from evidence.
- **Reachability**: analyze chunk-group reachability to detect async/shared chunks carrying modules the group does not need.
- **Retained Unused**: inspect `usedExports = []` modules, optimization bailouts, and side-effect candidates. Run with `concatenateModules: false` for discovery, then give EVERY such module a per-module disposition (keep / likely-removable / confirm-by-source / investigate) with evidence — not just a flat candidate list.
- **Side Effects Experiment**: env-gated `sideEffects: false` candidate experiments with before/after emitted JS deltas.
- **Export Usage Roots**: analyze all Rspack/Rsdoctor export usage chains, without Rollup comparison, and give EVERY used export a usage verdict (genuinely-used / needs-source-confirmation / over-retained-suspect) from where its chains terminate — so each export is individually verified, then rolled up to terminal roots and root-cause categories.
- **Rollup Diff**: compare Rollup vs Rspack export usage to find source-level bad-pattern hypotheses. Require reference chains and source inspection before calling a gap actionable.
- **CJS-to-ESM Experiment**: use the experimental loader to estimate package-patch upside if transpiled CJS became real ESM.
- **SplitChunks**: test cacheGroup `name` removal, `minSize: 0`, and shared-chunk tuning when reachability points to shared chunk fan-in.
- **ECMA Level Upgrade**: raise the output ECMA/syntax level in BOTH the transform (babel/swc) and the minifier (terser/swc), verify modern syntax is actually preserved (not downleveled) at each stage, then measure the emitted-JS delta with variables held constant. If the gain is large, re-verify it is syntax compaction (not changed module count / used exports / side effects).
- **Full Pipeline**: run Quick Triage, then the relevant analysis modes in evidence order; use this only when the user wants a comprehensive investigation.

Suggested first response for a broad request:

```text
I can run Quick Triage (recommended), Reachability, Retained Unused, Export Usage Roots, Rollup Diff, CJS-to-ESM Experiment, Side Effects Experiment, SplitChunks, or Full Pipeline. I will start with Quick Triage unless you want a specific mode.
```

Routing shortcuts:

- "rollup diff", "gap", "Rollup vs Rspack" -> Rollup Diff
- "export usage", "exports used chain", "usage chain", "公共 root", "root 根因" -> Export Usage Roots
- "去掉 rollup gap", "所有 export used 链条", "all used export chains" -> Export Usage Roots; the input snapshot must include all captured used exports, not only gap exports
- "cjs2esm", "esm loader", "transpiled cjs" -> CJS-to-ESM Experiment
- "chunk", "拆包", "shared chunk", "reachability" -> Reachability, then SplitChunks if shared chunk fan-in is confirmed
- "usedExports", "bailout", "side effects" -> Retained Unused, then Side Effects Experiment if candidates look safe
- "ecma", "es 版本", "提高 ecma", "syntax level", "target", "降级", "downlevel", "babel/swc target" -> ECMA Level Upgrade
- "全部", "一起做", "full pipeline" -> Full Pipeline

## Quick Start

1. Find the production build entrypoint:
   - direct `rspack -c ...`
   - `rsbuild build`
   - `rspeedy build`
2. Confirm the output directory and emitted JS assets.
3. Add analysis behind env flags. Never make heavy reports run on every normal build.
4. Capture the baseline:
   - emitted JS asset count
   - emitted JS asset size sum
   - largest JS assets
5. Run the analysis in this order:
   - chunk-group reachability
   - retained-unused plus optimization bailout (with `concatenateModules: false`)
   - side-effects experiments
   - export usage root aggregation for **all captured used exports**
   - Rollup-vs-Rspack export diff for possible bad patterns
   - CJS-to-ESM loader experiments for package patch potential
   - splitChunks tuning (remove fixed `name`, add `minSize: 0`)
   - ECMA level upgrade (raise transform + minifier target; verify modern syntax preserved at both stages; measure with variables held constant)
6. Record each round in a summary file so the work survives compaction or context loss.

## Baseline Capture

Before optimizing, collect:

- Build command used.
- Output directory.
- Sum of emitted `.js` asset sizes.
- Top 10 largest emitted JS assets.
- Any existing `stats.json`, Rsdoctor, or custom report hooks already in the repo.

Good baseline questions:

- Is the problem accidental inclusion, or are the async loads themselves huge?
- Is the gain likely in split-chunks cleanup, side-effects cleanup, duplicate deps, or route-level fan-in?

## Analysis 1: Chunk Group Reachability

Use this to answer:

"Does this chunk group contain JS modules that this load does not actually need?"

### Root selection

- Initial chunk group roots:
  `chunkGraph.getChunkEntryModulesIterable(chunk)` for each chunk in the group
- Async chunk group roots:
  Use multiple strategies in order:
  1. `origin.dependency` → `moduleGraph.getModule(dep)` (webpack-style, may be null in rspack)
  2. `origin.module.blocks[]` → iterate each block's `dependencies[]`, resolve via `moduleGraph.getModule(dep)`, keep targets that are in `actualModules` of this chunk group (required for rspack's ContextModule with many AsyncDependenciesBlocks)
  3. Fallback: chunk entry modules via `chunkGraph.getChunkEntryModulesIterable(chunk)`

### Traversal rule (BFS)

**Critical: BFS must traverse the FULL moduleGraph, not scoped to actualModules.**

Dependency chains pass through modules in other chunks. Only the final reachability check should filter to `actualModules`.

Follow `moduleGraph.getOutgoingConnections(module)`:
- Skip `conn.weak` connections
- Skip connections whose dependency belongs to an `AsyncDependenciesBlock` parent (do not cross async boundaries)
- Add `conn.module` to BFS queue

```js
const getOutgoingModules = (module) => {
  const targets = new Set();
  const connections = moduleGraph.getOutgoingConnections(module);
  for (const conn of connections || []) {
    if (!conn || !conn.module || conn.weak) continue;
    const dep = conn.dependency;
    if (dep) {
      const parentBlock = moduleGraph.getParentBlock(dep);
      if (parentBlock && parentBlock !== module &&
          parentBlock.constructor?.name?.includes('AsyncDependenciesBlock')) {
        continue; // skip cross-async-boundary edges
      }
    }
    targets.add(conn.module);
  }
  return targets;
};
```

### Module size

`chunkGraph.getModuleSize(module)` may return 0 for some modules. Use a robust fallback:

```js
const getModuleSizeRobust = (chunkGraph, module) => {
  let size = 0;
  try { size = chunkGraph.getModuleSize(module); } catch {}
  if (!size) try { size = module.size(); } catch {}
  if (!size) try {
    const sizes = module.getSourceTypes?.();
    if (sizes) for (const t of sizes) { size += module.size(t); }
  } catch {}
  return size || 0;
};
```

### Group total size tracking

For each chunk group, also compute `groupTotalJSSize` — the sum of all module sizes across all chunks in the group. This enables before/after comparison at the chunk-group level, not just the emitted-asset level.

### Candidate rule

For each chunk group:

- collect actual modules in the group's chunks (union of all chunks)
- BFS from roots through full moduleGraph
- `reachableModules` = intersection of `visited` and `actualModules`
- anything in actual but not reachable (and not external, not non-JS) is a "potentially removable JS-like module"

### Important filters

- Exclude externals.
- Do not treat asset/resource modules as JS opportunities.
- Report non-JS residuals separately so they do not pollute the optimization conclusion.

### Chunk Graph Visualization

The reachability plugin also generates an interactive HTML chunk graph (`chunk-graph.html`) that visualizes:

- **Nodes**: Every chunk group (entry groups in blue, async groups in green), sized proportionally to emitted JS bytes. Clicking a node shows:
  - Chunk group total emitted JS size
  - Each constituent chunk with its individual JS size and file names
- **Edges**: Each `import()` call that creates an async boundary. Clicking an edge shows:
  - The `import()` request string
  - Source file location (file:line:column)
  - Code snippet around the `import()` call (up to 3 lines)
- **Search**: Filter chunk groups by name to focus on a specific area

The graph data is also written as `chunk-graph.json` for programmatic consumption.

#### How it works

1. Scans all modules for `AsyncDependenciesBlock` instances (each represents an `import()`)
2. Uses `chunkGraph.getBlockChunkGroup(block)` to find the target chunk group
3. Determines source chunk groups by mapping the containing module back to its chunk groups
4. Reads the original source file at `block.loc` to extract the code snippet
5. Deduplicates edges: multiple identical `import()` locations between the same pair of chunk groups are collapsed

### Interpretation

- If removable JS-like size is near zero, splitChunks noise is not the real problem.
- If async groups are massive but removable JS-like size is zero, the problem is route/block fan-in, not accidental membership.
- **If removable modules are all polyfills (core-js, @swc/helpers) from a shared chunk**: these are likely injected by SWC's `env.mode: "usage"` into non-JS-source modules (e.g., SVG via @svgr/webpack), causing the shared polyfill chunk to carry modules that most async pages don't need. The fix is either:
  1. Remove `mode: "usage"` from non-primary loaders (e.g., SVG loader chain), or
  2. Tune splitChunks (see Analysis 6).

## Analysis 2: Retained Unused Exports Plus Bailouts

Use this to answer:

"Which modules have `usedExports = []`, still remain in output, and why?"

### CRITICAL: Disable concatenateModules first

**Always run this analysis with `concatenateModules: false`.**

When `concatenateModules` is enabled (the default), scope hoisting merges modules together. The inner modules of concatenated modules have their `usedExports` hidden — they appear as part of the concatenated module and rspack cannot report individual `usedExports` for them. This causes many ESM modules with `usedExports = []` to be invisible to the analysis.

With `concatenateModules: false`, every module is separate and its `usedExports` is individually reported. This exposes the full set of unused ESM modules that are retained only because of side-effect bailouts.

**Important**: `usedExports = null` means CJS module where rspack cannot determine export usage. `sideEffects: false` has no effect on these modules. Only `usedExports = []` (empty array) candidates are actionable.

After the analysis is done and candidates are identified, **restore `concatenateModules` to its original value** for production builds. The candidates found with concat=false are still valid with concat=true.

### Stats fields to enable

Enable at minimum:

- `modules: true`
- `nestedModules: true`
- `usedExports: true`
- `optimizationBailout: true`

If nested modules are possible, flatten them and inherit parent chunk or asset membership.

### Candidate rule

Start from modules where:

- `usedExports = []` (empty array, NOT null)
- module still belongs to emitted chunks or inherited chunk membership
- module is a real JS-like resource

Then inspect `optimizationBailout`.

### Side-effect bailout detection

Prefer the Rspack text form actually emitted by stats, for example:

- `Statement with side_effects in source code ...`
- `Decl with side_effects in source code ...`

Do not assume the text always uses `side effects` with a space. Match both `side_effects` and `side effects`.

### Snippets

When possible, extract snippets from `module.originalSource()` and use the bailout line directly as the snippet line.

Do not map back to pre-transform TS source unless the task explicitly asks for source-map mapping.

### Per-module disposition (complete, not sampled)

Listing `usedExports=[]` modules is not the deliverable. The deliverable is a **verdict for every one of them**, because "retained" alone does not say whether a module is genuinely dead (safe to drop / mark `sideEffects:false`) or kept for a real runtime side effect. A candidate list that lumps "mostly side effects" together hides the true removable upper bound and invites unsafe `sideEffects:false` edits.

After the plugin emits its summary, run `references/retained-unused-disposition.template.cjs` over `retained-unused-side-effects-summary.json`. It gives **every** module one disposition, backed by the bailout statement's source snippet:

- **keep** — genuine module-level side effect: `entry`, `polyfill` (core-js/regenerator/tslib/@swc/helpers — `sideEffects:false` would break these), `style` (CSS-in-JS / vanilla-extract), `bootstrap/registration` (effect/register/setup modules). Never mark these.
- **likely-removable** — node_modules ESM with `usedExports=[]` retained only by a side-effect bailout: the package likely lacks `"sideEffects": false`. Override via a module rule / patch and re-measure. **The sum of these sizes is the true removable upper bound** — report it explicitly; it is usually far smaller than the raw candidate count suggests.
- **confirm-by-source** — app source with a side-effect statement; usually real. Read the snippet (and the file for borderline cases) before acting.
- **investigate** — `usedExports=[]` but no bailout: retained by chunk membership / concatenation / a re-export, not a side effect. Trace why it is still emitted.

Only the **likely-removable** set (plus any **confirm-by-source** the source proves pure) should enter the Side Effects Experiment below. Report the per-disposition counts and bytes so the accounting is complete; do not stop at a flat candidate list.

CJS modules (`usedExports=null`) are a separate, out-of-scope bucket — `sideEffects:false` cannot help them; note their count for context but do not disposition them here.

## Analysis 3: Side Effects Experiments

Use this to answer:

"If we mark the report candidates as `sideEffects: false`, how much emitted JS shrinks?"

### Safe workflow

1. Baseline build with analysis only (with `concatenateModules: false` to find candidates).
2. Generate candidate JSON from retained-unused modules with side-effect bailouts.
3. Exclude entry modules and mock files from the generated candidate list.
4. **Restore `concatenateModules` to default** for the experiment builds.
5. Apply an env-gated rule:

```ts
{
  test: (resource: string) => candidateSet.has(resource),
  sideEffects: false,
}
```

6. Rebuild and compare emitted JS asset size.
7. Regenerate the report after each round.
8. Accumulate candidates across rounds by union, rather than overwriting the prior list.

### ESM vs CJS candidates

Candidates split into two categories:

- **ESM candidates** (`usedExports = []`): These benefit from `sideEffects: false` — rspack can tree-shake the entire module.
- **CJS candidates** (`usedExports = null`): `sideEffects: false` has no effect because rspack cannot determine CJS export usage. Ignore these.

Focus effort on ESM candidates. They typically come from `node_modules` packages that lack `"sideEffects": false` in their `package.json`, or from project source files with side-effect bailouts.

### Why union matters

Without union accumulation, round 2 may only test the latest residual candidates and accidentally drop the already-proven profitable set.

## Analysis 4: Export Usage Roots

Use this to answer:

"Across all exports that Rspack marks used, which terminal roots keep the most exports alive, and what broad root-cause class dominates?"

This mode does **not** compare against Rollup and should not filter to Rollup gap exports. It is useful when the question is about the shape of the real Rspack export usage graph rather than a Rollup-vs-Rspack difference.

This mode has three required outputs:

1. **Export-used chain analysis**: for every captured target export, show the concrete chain that keeps it used, including intermediate re-exports, specifier dependencies, dependency locations, and terminal/root module. A selected target export view is only a drill-down into this complete dataset.
2. **Common-root aggregation**: across all captured used exports, group those chains by terminal/root module so the largest shared root causes are visible.
3. **Per-export usage verdict (EVERY used export, not just roots)**: aggregation only counts how many exports each root keeps alive — it does not say, for a given export, whether that export is *really used* or merely *conservatively retained*. Every used export must get its own verdict (see "Per-export & per-root usage verdict" below), derived from where its retention chains actually terminate. This is the primary unit; per-root is a roll-up. Without per-export verdicts the report cannot tell a genuinely-needed export from a removable one — which is the whole point. (Per-export is also strictly sharper: a root may be an over-retention suspect overall, yet most exports it keeps alive are independently reachable via other genuine chains, so only the exports with NO genuine path are real candidates.)

Do not collapse this analysis into a single "gap export" view. The same root can keep many unrelated exports alive, and that is often the real optimization signal.

When the overall goal is bundle-size optimization, run this mode even if the original lead came from retained-unused, side-effect, or Rollup-diff data. `usedExports` tells what is still alive; `exportsUsage` explains why it is alive.

### Required input

Prefer Rspack/Rsdoctor `exportsUsage` data that preserves export-to-export chains. Each record should include:

- target module/resource
- target export name
- direct imports with dependency request, location, referenced exports, origin export, and target export when available
- bounded `chains` from terminal/root modules to the target export
- terminal/root kind, for example `no-export-incoming` or `module-side-effect-or-unknown-export`

For this mode, the payload must represent **all captured used exports** from Rspack, not only exports that differ from Rollup. A gap-filtered payload is acceptable for Rollup Diff, but it is invalid for common-root conclusions because it hides roots that retain many used exports outside the gap set.

If a prior capture already wrote `rsdoctor-all-export-usage.json`, consume that file directly. Use `rsdoctor-filtered-export-usage.json` only for Rollup Diff or as an explicitly labeled fallback when an all-used capture is unavailable.

If the project uses Rspack's built-in Rsdoctor integration, prefer its `exportsUsage` output as the source of truth. The important requirement is preserving export-to-export chains and terminal/root kind; stats-only `usedExports` is not enough for this mode because it cannot answer which upstream root keeps a specific export alive.

### Capture requirements

Capture from the same Rspack compilation that produced the size artifact being analyzed. Do not mix a dev snapshot, minify-off debug snapshot, or Rollup materialized graph with a production-size conclusion unless the report labels it explicitly as debug-only.

If Rspack's built-in Rsdoctor plugin is available, use its `exportsUsage` helper data before inventing a new graph walker. The capture must include enough information to reconstruct:

- target module/resource and target export
- direct import/export references
- export-to-export propagation through re-export and namespace edges
- dependency request and dependency location
- matched specifier or referenced export
- terminal/root module and terminal/root kind

If any of these fields are missing, record the missing field as a data-quality issue and do not make source rewrites from that part of the report.

### End-to-end pipeline (capture → transform → analyze)

For rspack's built-in export-usage graph (`@rspack/core` >= 2.1.0-beta.0; the `exportUsageGraph` option is NOT in stable 2.0.8 — verify it exists, else build a dev binding from main or use `@rsdoctor/rspack-plugin`), the skill ships the whole pipeline:

1. **Capture** — add `references/export-usage-capture-plugin.template.cjs` to the production config behind an env flag, built with `optimization.concatenateModules:false, usedExports:true`. Pass the already-imported `rspack` into the plugin (`new ExportUsageCapturePlugin({ rspack, outDir })`) — a fresh `require('@rspack/core')` inside the `.cjs` can load the CJS dist and crash. It writes `rsdoctor-export-usage-raw.json` (`{modules, edges}`).
2. **Transform** — `node references/build-all-export-usage.template.cjs --raw rsdoctor-export-usage-raw.json --out rsdoctor-all-export-usage.json`. This reverse-BFSes each used export to its terminal roots, handles the namespace-edge gotcha (a `targetExports===null` edge keeps every export of the provider alive — propagate it; it also marks the resulting chain edges `viaNamespace` so the analyzer can tell precise from coarse retention), and caps depth/branches.
3. **Analyze (triage)** — `node references/export-usage-root-analysis.template.cjs --usage rsdoctor-all-export-usage.json --context "$PWD" --out-dir export-usage-roots`. Emits the per-export verdict distribution + the `confirmationWorklist`.
4. **Confirm (agent judges every unresolved export)** — work the `confirmationWorklist` with the agent: read each terminal root's source and resolve its exports to confirmed-used / confirmed-removable / still-unknown. Fan out with subagents for scale. See "Confirm every export with the model" below. The script triages; this step is where every export actually gets analyzed.

### Execution workflow

1. Capture or locate the Rspack/Rsdoctor export usage payload (see pipeline above).
   - Preferred file name when available: `rsdoctor-all-export-usage.json`.
   - Rollup Diff fallback file name: `rsdoctor-filtered-export-usage.json`.
   - The input must include all captured used exports, not only Rollup gap exports.
   - If the available report only contains Rollup gap exports, rerun or adjust the capture first. Do not use a gap-filtered payload for common-root conclusions.
2. Run an export-usage-root aggregation script. If the repository has one, use it instead of rewriting the logic. For example:

```bash
node tools/rspack-optimization/analyze-export-usage-roots.cjs \
  tmp/rspack-optimization/video/rollup-diff \
  "$PWD"
```

If the repository does not have a script yet, start from `references/export-usage-root-analysis.template.cjs` and wire its `--usage`, `--report`, `--context`, and `--out-dir` arguments to the local artifact paths.

3. Write both machine-readable and human-readable outputs, for example:
   - `export-usage-root-analysis.json`
   - `export-usage-root-analysis.md`
4. Inspect the top roots before changing code. Pick candidates whose root class is rewriteable and whose chains point to concrete source dependencies.
5. After each source rewrite, regenerate the export usage root report and compare:
   - impacted target export count per root
   - raw chain count per root
   - top root category distribution
   - whether the specific root disappeared or moved to a real product entry

### Chain quality audit

Before using the report to choose optimizations, audit the capture itself:

- Coverage: `usageWithChains / usageCount` should be high enough for the conclusion. If many records have no chains, fix capture or traversal before ranking roots.
- Specificity: a chain that only reaches the target module's own `export` statement is not a consumer chain. Continue upstream until a terminal/root consumer or explicit cap is reached.
- Export correctness: every edge shown for a target export must carry that target export, an origin export that propagates to it, or a namespace/unknown marker that honestly explains loss of precision. Do not display unrelated specifiers on the edge.
- Location correctness: source highlighting must use dependency/specifier `loc` from the edge. Text search for the export name is only a fallback and must be labeled as approximate.
- Re-export handling: `export { Foo } from "./foo"` and `export * from "./foo"` are intermediate edges, not terminal roots, unless the barrel itself is the terminal consumer.
- Cap reporting: depth, branch, chain-count, missing-source, and unknown-export caps must be counted in the JSON/Markdown output.
- Root dedupe: count one terminal root at most once per target export. Keep raw chain count separately.

If the audit fails, fix the report tooling before making optimization decisions. A visually convincing graph with wrong edges is worse than no graph.

### Export-used chain rule

For each target `(module, export)`:

- preserve direct imports separately from longer chains
- preserve each edge's origin module, target module, dependency request, dependency type/category, dependency location, referenced export/specifier, origin export, and target export when available
- distinguish import-site/specifier usage from implementation-site usage; when highlighting source, prefer the dependency/specifier location, not the first textual occurrence of the export name
- include re-export edges explicitly, because a short chain ending at `export { Foo } from "./foo"` is not necessarily the real consumer
- continue upstream through export-to-export usage until a terminal/root kind is reached, subject to explicit depth/branch caps
- mark capped or incomplete chains as data-quality limits instead of treating them as final roots

The per-export view must answer:

- who directly references this export
- which upstream export or module keeps that direct reference alive
- where the dependency is located in source
- the exact source snippet for the usage edge, preferring the dependency/specifier `loc`; if the usage edge has no loc, include an export-declaration snippet from the target module and label it as fallback
- why Rspack marks this export used, written as a short chain-backed reason that names the terminal/root module, the immediate consumer edge, and whether the chain is complete, capped, or module-side-effect/unknown
- whether the chain ends in an entry/bootstrap/registration root, a side-effect-or-unknown root, or a rewriteable utility/barrel/map root
- whether the chain is complete or capped/incomplete

If a chain only shows the target module's own export statement, the analysis is incomplete for "who consumes this export"; fix the upstream traversal or input payload before using it for source rewrites.

### Aggregation rule

For each `(target module, export)`:

- inspect all concrete `chains`
- treat `chain.terminal` as the root/terminal module
- count a root at most once per target export, even if multiple path samples hit the same root
- keep raw chain count separately as a secondary weight
- group by terminal kind and preserve examples with target module/export and edge count
- keep representative complete chains for the top roots, not only root names; every high-priority root needs at least one source-backed chain example

Report at minimum:

- total export usage records
- records with concrete chains vs records without concrete chains
- unique terminal root count
- top roots by impacted target export count
- top categories by impacted target export count
- examples for the leading roots
- top target exports per leading root
- per-root export details for every impacted target export, not only the top exports; each detail must include a code snippet and a chain-backed "why used" explanation
- representative chains for the leading roots, with dependency locations and referenced specifiers
- data-quality limits such as no-chain records, capped chains, missing source, or side-effect/unknown terminals

### Root-cause classification

Classify roots from source and materialized source features. Keep classifications heuristic and evidence-backed:

- **namespace utility root**: broad utility class/object/module such as `VideoUtils`, `TextTemplateUtils`, `SegmentUtils`, or static utility modules that import many schema/helper exports.
- **decorated side-effect root**: materialized source contains legacy decorator helpers such as `_ts_decorate`, `_ts_metadata`, `_ts_param`, or source-level decorators; these roots are often side-effectful or unknown to export pruning.
- **entry/bootstrap root**: app entry, route flow, service registration, or bootstrap task roots; these often represent real runtime reachability rather than an optimization bug.
- **registry/contribution root**: contribution modules, registration modules, or runtime plugin registries that intentionally keep imported APIs live.
- **runtime registry/map root**: object maps such as `mutationMap` or constructor maps; dynamic key lookup keeps all referenced constructors live.
- **runtime enum/schema root**: value enums or schema objects imported at runtime.
- **barrel/re-export root**: broad `index.ts` or `export *` fan-in where consumers could potentially import defining modules directly.
- **module side-effect or unknown export root**: Rspack reports a module terminal without precise export-to-export attribution; treat as real but less actionable until source inspection confirms why.

### Per-export & per-root usage verdict

The base unit is the **export**: give every used export a verdict for "is it really used", then roll up to roots. `references/export-usage-root-analysis.template.cjs` does both.

**Per-root signal — precise vs coarse retention.** A chain edge is *coarse* when the provider was consumed as a whole module / `import *` (`viaNamespace`, i.e. the raw edge's `targetExports===null`): such an edge keeps an export alive even if no concrete specifier ever references it. A *precise* edge carries a named export. Each root is classified from its coarse-vs-precise chain mix and category:

- **genuinely-used** — runtime root (entry / route / registration / decorator / value-map), or a barrel/namespace shape whose retention is mostly precise. The kept exports serve a live feature; not a bug.
- **over-retained-suspect** — a namespace/barrel root where most chains retain exports via coarse edges (≥50%). The report names the concrete rewrite (named imports instead of `import *`; import defining modules instead of the barrel).
- **needs-source-confirmation** — terminal kind `module-side-effect-or-unknown-export`: Rspack could not attribute a precise export-to-export cause. Real terminal, but read the root before calling it used or removable. Do not silently fold these into "used".
- **review** — ordinary chain; inspect source.

**Per-export verdict (primary).** Each used export inherits a verdict from where its chains terminate, with the rule that *one genuine path is enough to need it*:

- **genuinely-used** — at least one chain reaches a genuinely-used root.
- **needs-source-confirmation** — no genuine path, but at least one chain terminates at a side-effect/unknown root.
- **over-retained-suspect** — **every** chain terminates at an over-retained root. These, and only these, are real removal candidates: the export is kept alive solely through narrowable namespace/barrel consumption with no genuine consumer. The report lists them grouped by provider module.

This per-export rule is why the analysis must not stop at roots: an over-retained *root* often keeps many exports alive that are *also* reached by genuine chains elsewhere, so they are genuinely-used; only the exports with no genuine path at all are candidates. Report both distributions (per-export is the headline) and the grouped over-retained-export list. Zero over-retained exports is a positive finding (size is feature-driven, no export-pattern gap) — state it explicitly, do not present it as an empty result.

### Confirm every export with the model (script triages, the agent judges)

The script verdict is a **triage, not the final word**. `genuinely-used` is mechanically safe — a chain reaches a real entry/route, so the export is needed; no source read required, and that bucket is usually the majority. But `needs-source-confirmation` (side-effect / unknown terminals) and `over-retained-suspect` are exactly the cases the graph cannot decide. Treat them as a **worklist for the agent (Claude/Codex), not a verdict**: shipping "needs-source-confirmation" as a result means the export was never actually analyzed.

So the complete analysis is: **script enumerates and triages all exports → the agent reads source and judges every export the script could not clear.** The analyzer emits `confirmationWorklist` (and a "Model-Confirmation Worklist" table) grouped by terminal root for exactly this.

How to do it without drowning:

- **Group by terminal root.** Every export under one root is kept alive by the same mechanism, so one source read of that root (and the chain into it) resolves all of its exports together. Iterate the worklist top-down by `impactedExportCount`.
- **For each root**, read the terminal module and the representative chain, then decide for its exports: *confirmed-used* (the root genuinely invokes/registers/renders them — e.g. an effects-registration chain, a route component, a runtime map), *confirmed-removable* (kept alive only by a namespace/barrel consumption nothing actually calls → apply the rewrite hint), or *still-unknown* (record why).
- **Fan out for scale.** When the worklist is large (hundreds of roots), spawn subagents — one per root, or one per cluster of related roots/module — each returning a per-export determination for its group. Merge into one ledger. This is where Codex / Claude subagents do the per-export reasoning the script can't.
- **Loop until covered.** Keep going until every export has an agent-confirmed verdict. If you must stop early, report coverage explicitly (`N of M exports confirmed`, which roots remain) — never let an unread bucket masquerade as analyzed. Silent truncation is the failure mode this whole step exists to prevent.

The deliverable is a **per-export ledger** where every used export ends at one of: genuinely-used (script-cleared or agent-confirmed), confirmed-removable (with the rewrite), or explicitly-still-unknown — with the agent's evidence for every non-trivial one. "The script said needs-source-confirmation" is not an acceptable final state for any export.

### Interpretation

Do not call every common root a bug. Separate:

- **real product roots**: entries, bootstrap flows, registrations, active UI contributions
- **rewrite opportunities**: broad utility modules, barrel fan-in, constructor maps, decorated roots that import wide APIs
- **data-quality limits**: records without concrete chains, `module-side-effect-or-unknown-export` terminals, truncated chains

A high-priority candidate is a root that impacts many exports and has a rewriteable source pattern. Typical fixes are splitting broad utility modules, importing narrower helpers, moving side-effectful registration away from pure exports, replacing dynamic constructor maps with narrower lazy maps, or isolating decorator-bearing facades from heavy helper imports.

## Analysis 5: Rollup-vs-Rspack Export Diff

Use this to answer:

"Rollup can remove this export, but rspack kept it. Is there a source-level bad pattern we can rewrite so rspack also optimizes it?"

This is an investigation tool, not proof that rspack is wrong. Treat each `gapExport` as a hypothesis until it is backed by rspack reference chains and source inspection.

### Setup

Run this behind env flags. Do not make the Rollup diff plugin part of normal production builds.

For debuggability:

- set `optimization.moduleIds = "named"` or equivalent
- set `optimization.concatenateModules = false`
- disable minification, or at least disable mangle, while inspecting output
- keep production-ish feature/env flags the same as the target build
- do not exclude `node_modules` if package-level bad patterns or patch opportunities are in scope

The Rollup input must be the same loader-processed module graph rspack saw:

- capture module sources after loaders
- materialize the graph to disk
- let `@rollup/plugin-commonjs` handle CommonJS; do not invent custom CJS special cases in the diff path
- write both Rollup input and Rollup output to disk
- include `moduleAbsolutePath`, `gapExports`, `rspackUsedExports`, `rollupRemovedExports`, and `rspackReferenceChains` in the report

### Reference chains

The useful signal is not only "Rollup removed it"; it is "who in rspack kept it".

For every gap, preserve:

- `directReferences`: immediate incoming rspack references to the module/export
- `chains`: bounded incoming paths from the entry module to the direct reference
- dependency type/category/request/loc when available

If many `chains` are empty, fix the report first. Empty chains usually mean the graph identity mapping or traversal caps are wrong; do not triage optimization candidates from that report.

For large graphs, use bounded linear BFS with explicit depth, branch, and expansion caps. Avoid path-enumerating BFS that copies a `visited Set` per candidate path; it can explode on app-scale cyclic graphs.

### Actionable patterns

Prioritize gaps whose chain points to a rewriteable source pattern:

- barrel re-export fan-in where the consumer can import the defining module directly
- namespace import or namespace object propagation where named imports would preserve finer usage
- circular barrel dependencies that force conservative retention
- source-local no-op wrappers or exported helpers that can be inlined, split, or made private
- mixed registration modules where pure exports can be separated from side-effectful startup code

Do not classify a case as actionable just because it is large. Confirm the reference chain, inspect the source, and verify the rewritten build shrinks.

### Common false positives

Deprioritize or mark as residual when:

- the chain shows an entry, route registration, runtime bootstrap, or service registration genuinely reaches the module
- the module has explicit runtime side effects
- Rollup needed stubs/externals that do not match rspack runtime semantics
- Rollup warns about circular chunk re-exports that could change execution order
- CommonJS remains statically incomparable after `@rollup/plugin-commonjs`

## Analysis 6: CJS-to-ESM Loader Experiments

Use this to answer:

"If this dependency shipped real ESM instead of transpiled CommonJS, would rspack shake or concatenate it better?"

This loader is an experiment to estimate package-patch upside. It is not the same thing as the Rollup diff plugin and should not be integrated into the Rollup diff path by default.

### Loader design guardrails

Keep the loader narrow and reversible:

- run it only behind an env flag
- return transformed ESM source from the loader; do not edit `node_modules`
- do not create sidecar mirrors or add `.mjs` suffixes
- do not force `type: "javascript/esm"` or override explicit module type in rules
- let rspack's normal parser/module-type inference run on the returned source
- only transform transpiled CJS with an `__esModule` marker and recognizable static patterns
- skip dynamic CommonJS or modules whose `this._module.type` indicates dynamic/non-module CJS behavior
- use an AST parser/transformer such as SWC async APIs; avoid broad string replacement

Expected safe-ish rewrites include:

- top-level `require("./x")` bindings to top-level `import`
- `__exportStar(require("./x"), exports)` to `export * from "./x"`
- `exports.foo = bar` to `export { bar as foo }`
- `exports.default = value` to `export default value` when ordering and semantics are safe

If a file mixes dynamic require, conditional export mutation, computed export names, or late export assignment, report it as skipped instead of forcing a transform.

### Measurement workflow

1. Capture a baseline production build with the same env flags.
2. Enable the loader for all modules, or for a target package, depending on the question.
3. Write a hit report with:
   - transformed module count
   - skipped modules with reasons
   - modules containing `__esModule` that did not transform
   - package-level hit counts
4. Dump baseline and experiment stats with `assets`, `chunks`, `modules`, `nestedModules`, `usedExports`, `providedExports`, and `optimizationBailout`.
5. Generate a package-level size delta report. The report must include every npm package touched by the loader and every package whose size changed:
   - package name and version when inferable from pnpm/npm paths
   - transformed, skipped, and skip-reason counts
   - baseline vs experiment stats module size and delta
   - attributed emitted raw/gzip delta per package when chunk/asset data is available
6. Rebuild and compare emitted JS bytes, top changed assets, package-level deltas, and relevant stats fields such as `usedExports`, `providedExports`, and concatenation behavior.
7. Inspect debug-friendly output to confirm the loader-transformed source actually reached rspack.
8. Keep the result only as evidence for a package patch or upstream ESM migration unless runtime validation proves it is safe.

Use `references/cjs2esm-package-size-diff.cjs` as the default postprocess helper:

```bash
node references/cjs2esm-package-size-diff.cjs \
  --baseline-stats tmp/baseline-stats.json \
  --experiment-stats tmp/cjs2esm-stats.json \
  --loader-report tmp/cjs2esm-loader-report.jsonl \
  --baseline-dist dist-baseline \
  --experiment-dist dist-cjs2esm \
  --out tmp/cjs2esm-package-size-diff.json \
  --markdown-out tmp/cjs2esm-package-size-diff.md
```

The helper reports two package-size metrics:

- `moduleSizeDelta`: directly attributable from stats module sizes; use this for package ranking.
- `attributedEmittedRaw/GzipDelta`: estimated by distributing each JS asset to packages by module-size share inside the chunk; label this as an estimate, not exact emitted bytes.

### Interpretation

A good result is a measured shrink or clearer export usage for a specific package. If many modules transform but emitted size does not move, verify:

- the transformed modules are on the critical chunk path
- the package still has real top-level side effects
- consumers still use namespace imports or barrels that keep everything reachable
- the module is still CommonJS-like after transform because of skipped dynamic patterns
- minification and concatenation settings in the experiment match the question being asked

If a package has many transformed modules but no package-level `moduleSizeDelta`, do not call it an optimization. It may only improve syntax shape without changing retained code.

`javascript/auto` can still parse harmony syntax; do not require the transformed module to be labeled `javascript/esm` before considering the experiment valid.

### Stopping conditions

Stop when one of these is true:

- only entry modules remain
- the remaining candidates are clearly real runtime side effects or polyfills
- the next round gain is tiny
- the regression risk outweighs the measured bytes saved

## Analysis 7: SplitChunks Tuning

Use this to answer:

"Can we reduce per-page load size by splitting shared chunks more finely?"

### When to apply

Apply when chunk-group reachability shows many async groups carrying removable modules from shared chunks (e.g., `lib-polyfill`, `lib-react`, `lib-lodash`). This means shared chunks with fixed `name` are forcing all their modules onto every chunk group, even groups that don't need them.

### Method

1. **Baseline**: Build with current splitChunks config (fixed `name` per cacheGroup).
2. **Experiment**: Remove ALL `name` properties from cacheGroups AND set `minSize: 0`:

```js
splitChunks: {
  chunks: "all",
  minSize: 0,  // ← critical: prevents module duplication
  cacheGroups: {
    "lib-polyfill": {
      test: /[\\/]node_modules[\\/](tslib|core-js|...)[\\/]/,
      priority: 0,
      // name: "lib-polyfill",  ← REMOVE
      reuseExistingChunk: true
    },
    // same for all other cacheGroups
  }
}
```

3. Compare:
   - **Emitted JS total** (should decrease, not increase)
   - **Entrypoint chunk group total size** (首屏体积)
   - **Each async chunk group total size**
   - **Number of chunks** (will increase — that's expected)
   - **Groups with removable modules** (should go to 0)

### Why `minSize: 0` is critical

Without `minSize: 0`, removing `name` causes rspack to duplicate small shared modules into each consuming chunk (because they're below the default `minSize` threshold for extraction into a separate chunk). This makes **total emitted JS increase** even though per-group sizes decrease.

With `minSize: 0`, even tiny shared modules get extracted into their own shared chunk, eliminating duplication entirely.

### Expected results

- **Emitted JS**: decreases (no duplication with minSize:0)
- **Unique chunks**: increases (more fine-grained shared chunks)
- **Per-group sizes**: decrease (each group only loads modules it actually needs)
- **Entrypoint**: may decrease slightly (entry doesn't load library modules only needed by async pages)
- **0 groups size increased**: all changes should be decreases

### Risk

- More chunks = more HTTP requests. For HTTP/2 this is usually fine.
- Named chunks are easier to debug. Consider using `name` as a function for readable chunk names in development, while omitting it in production.

## Analysis 8: ECMA Level Upgrade

Use this to answer:

"If we raise the output ECMA/syntax level so modern syntax is preserved instead of downleveled, how much emitted JS do we save?"

Downleveling modern syntax to ES5/ES2015 (old browser targets) inflates output: arrow functions become `function` expressions, `async/await` becomes regenerator/state-machine code, `class` becomes prototype boilerplate, `?.`/`??`/logical-assignment become verbose guards, object spread becomes helper calls, `for...of` becomes index loops, plus injected runtime helpers (`@swc/helpers`, `@babel/runtime`, `regenerator-runtime`) and `core-js` polyfills. Raising the target keeps the compact native syntax and drops the helper/polyfill tax.

There are TWO independent stages that each have their own ECMA/target setting, and BOTH must be raised or the lower one wins:

1. the **transform/loader** stage (babel or swc) — controls what syntax the loader emits;
2. the **minifier** stage (terser or the swc/rspack minimizer) — can re-downlevel or refuse to emit modern syntax even if the loader kept it.

### Step 1: identify the transform tool

Inspect the config and `package.json`. It is one of:

- **swc** — `builtin:swc-loader`, `@rspack/core` defaults, `rsbuild` (swc), `swc-loader`. ECMA is set via `jsc.target` (e.g. `"es2022"`) OR `env.targets` (browserslist). `jsc.target` and `env` are mutually exclusive in swc — do not set both.
- **babel** — `babel-loader` + `@babel/preset-env`. ECMA is set via preset-env `targets`; raising targets (or dropping preset-env for already-modern code) reduces transforms.
- **esbuild** (some rsbuild/tsup setups) — `target` option.

Match the project's actual tool; do not introduce a second transform.

### Step 2: raise the transform ECMA level (env-gated)

Pick a concrete high target and apply it to **every** loader rule that transforms JS/TS (it is common to miss a secondary rule, e.g. an SVG/`@svgr` loader chain with its own `env`). For swc prefer an explicit `jsc.target: "es2022"` (or `esnext`); for browserslist use a modern line like `["chrome >= 100"]`.

If the loader uses swc `env.mode: "usage"` for core-js, a higher target also shrinks injected polyfills; record polyfill module-count before/after.

### Step 3: verify the loader actually preserved modern syntax

Do NOT trust the config — verify the emitted loader output. Build, then grep the emitted (pre-minify, or `optimization.minimize: false`) assets for syntax that MUST survive at the new level:

- `=>` (arrow), `async ` / `await ` (native async, not `regeneratorRuntime`/`_asyncToGenerator`), `class ` , `?.` , `??` , `??=`/`||=`/`&&=` , `...` spread.
- Confirm DISAPPEARANCE of downlevel tells: `regeneratorRuntime`, `_asyncToGenerator`, `_createClass`, `_slicedToArray`/`_sliced_to_array`, `_objectSpread`, `core-js/modules/es.*` count drops.

If advanced syntax is still downleveled, the target did not take effect (wrong rule, `env` overriding `jsc.target`, a browserslist file/`.browserslistrc` still pinning old browsers, or a nested config). Fix before continuing.

### Step 4: raise the minifier ECMA level (multiple places)

The minifier has its own ECMA gate and will keep output at the lower level even if the loader emitted modern syntax. Raise it everywhere:

- **swc / rspack `SwcJsMinimizerRspackPlugin`**: set `minimizerOptions.compress.ecma`, `minimizerOptions.format.ecma`, and `minimizerOptions.compress.{arrows,...}` as available; align with the loader target.
- **terser (`TerserPlugin`)**: set `terserOptions.ecma`, `terserOptions.compress.ecma`, `terserOptions.format.ecma`, and `terserOptions.compress.{arrows, drop_console-unrelated}`; also `terserOptions.module: true` for ESM output.
- **esbuild minify**: `target`.

ECMA is configured in MORE THAN ONE place (compress AND format, sometimes a top-level `ecma`/`target`). Set them all.

### Step 5: verify the minifier output kept modern syntax

Re-grep the FINAL minified assets for the same modern-syntax markers from Step 3. A common failure is the loader keeping `?.`/arrows but the minifier lowering them because its `ecma` defaulted to 5. Only proceed when the final output is confirmed modern.

### Step 6: measured production build, variables held constant

Run a normal production build with EVERYTHING else identical (same entry, same deps, same splitChunks, same mangle/compress passes, same `usedExports`/`sideEffects`/`concatenateModules`). The ONLY change is the ECMA level (loader + minifier). Compare emitted JS total and per-asset, raw and gzip.

### Step 7: if the gain is very large, re-verify it is really ECMA

A large drop is suspicious — confirm it is the syntax level, not an accidental change to WHAT is bundled. Re-run with the same `usedExports`/stats capture and check these are UNCHANGED vs the baseline:

- **module count** (a different count means resolution/target changed which files are pulled, e.g. fewer polyfills — that is legitimate but should be attributed separately as "polyfill reduction", not "syntax level");
- **used exports count** (`usedExports`) — must match;
- **retained side-effect-only modules** — must match;
- entry/chunk membership — must match.

Attribute the delta across three buckets and report each: (a) native-syntax compaction, (b) dropped transpiler helpers (`@swc/helpers`/`@babel/runtime`/regenerator), (c) reduced `core-js` polyfills. If module count / used exports / side-effects changed, the headline number is NOT pure ECMA — split it.

### Risk

- Raising the target drops support for old browsers. Confirm the project's real browser support policy before recommending it as a default; otherwise keep it env-gated and report it as an upper bound.
- Some libraries ship code relying on transforms; verify runtime, not just size.

## Reporting Template

For each project, produce a short summary with:

- build command
- output location
- baseline emitted JS asset size
- round 1 emitted JS asset size and delta
- round 2 emitted JS asset size and delta
- retained-unused module counts across rounds, plus the **per-module disposition table** (keep / likely-removable / confirm-by-source / investigate) and the true removable upper bound in bytes
- side-effect bailout counts across rounds
- export usage: chain coverage, the **per-export usage-verdict distribution** over ALL used exports (genuinely-used / needs-source-confirmation / over-retained-suspect), plus the **per-export ledger after agent confirmation** — every needs-source-confirmation / suspect export resolved by the agent to confirmed-used / confirmed-removable / still-unknown, with coverage (N of M exports confirmed) so no bucket is left unread; then the per-root roll-up (top roots, categories, root verdicts)
- Rollup-vs-Rspack gap count, chain coverage, and top actionable bad-pattern candidates
- CJS-to-ESM loader hit/skip counts, emitted JS delta, and package-level size delta table
- splitChunks tuning results (entrypoint and per-group deltas)
- ECMA level upgrade: transform tool, old vs new target, loader-output verification (modern syntax preserved), minifier-output verification, emitted-JS delta with variables held constant, and the delta split into native-syntax / dropped-helpers / reduced-polyfills (plus confirmation that module count, used exports, and side-effects are unchanged)
- final residual candidates
- conclusion on whether this route is worth keeping

Good conclusion language:

- "This route is exhausted; only entry modules remain."
- "This route yields a small upper bound and should stay env-gated."
- "The dominant problem is still oversized async loads, not side-effects noise."

## Risk Rules

Be careful with:

- polyfills
- editor contribution modules
- metadata libraries
- runtime registration modules
- style loader entrypoints

Measured shrinkage is not enough to justify keeping the optimization on by default. Side-effect candidates often carry real runtime behavior.

If the candidate set is dominated by these modules, keep the experiment behind env flags unless runtime validation proves safety.

## Practical Heuristics

- **Disable `concatenateModules` to find ESM unused modules.** This is the single most important technique. Many unused ESM modules are invisible when concat is on.
- Large editor ecosystems often surface removable contribution modules.
- `module size` from reports is useful for ranking, but it is not a one-to-one map to final emitted asset deltas.
- A small side-effects win with huge async groups usually means the real next step is route-level or block-level dependency splitting.
- If chunk-group reachability shows zero removable JS-like modules, do not keep pushing splitChunks cleanup. Move on.
- Rollup diff gaps are only leads. Trust cases with non-empty rspack reference chains and source-backed rewrite hypotheses.
- Use the CJS-to-ESM loader to estimate package patch upside; do not present loader-only success as a production-safe fix without runtime validation.
- **SWC `env.mode: "usage"` injects polyfills at compile time**, not through standard imports. This creates moduleGraph edges from unexpected modules (e.g., SVG files via @svgr/webpack) to core-js. If polyfill modules appear as "removable" in chunk groups, trace their incoming connections to find the injection source.
- **splitChunks with fixed `name` + `minSize: 0`** is the safest way to reduce per-page load without module duplication. Always test with `minSize: 0` when removing `name`.

## Deliverables

At the end of the work, aim to leave behind:

- a reusable report plugin or analysis hook
- a candidate JSON file for iterative experiments
- a summary markdown with baseline and round deltas
- a clear statement of whether the route is worth productizing

## Minimal Success Criteria

This skill is successful when it leaves the repo with:

- reproducible baseline numbers
- at least one report that explains the dominant source of size
- a measured experiment, not just advice
- a written stopping-point conclusion

## Bundled References

Read these only when you need them:

- [references/retained-unused-side-effects-plugin.template.cjs](references/retained-unused-side-effects-plugin.template.cjs)
  Use when you want a starting plugin for retained-unused plus side-effects reporting, candidate JSON generation, and round-by-round accumulation.
- [references/retained-unused-disposition.template.cjs](references/retained-unused-disposition.template.cjs)
  Run over the plugin's `retained-unused-side-effects-summary.json` to give EVERY usedExports=[] module a disposition (keep / likely-removable / confirm-by-source / investigate) with a source snippet, and to compute the true removable upper bound. This is what makes Analysis 2 complete instead of a flat candidate list.
- [references/chunk-group-reachability-plugin.template.cjs](references/chunk-group-reachability-plugin.template.cjs)
  Use when you want a starting plugin for chunk-group reachability analysis with correct BFS traversal and async root finding.
- [references/cjs2esm-package-size-diff.cjs](references/cjs2esm-package-size-diff.cjs)
  Use after a CJS-to-ESM experiment to compare baseline and experiment stats at npm package granularity.
- [references/export-usage-capture-plugin.template.cjs](references/export-usage-capture-plugin.template.cjs)
  Capture rspack's builtin Rsdoctor export-usage graph (`exportUsageEdges`) into `rsdoctor-export-usage-raw.json`. Needs `@rspack/core` >= 2.1.0-beta.0. First step of the Export Usage Roots pipeline.
- [references/build-all-export-usage.template.cjs](references/build-all-export-usage.template.cjs)
  Transform the raw `exportUsageEdges` into `rsdoctor-all-export-usage.json` (per-export chains to terminal roots, namespace-edge handling, `viaNamespace` flag for precise-vs-coarse). Second step of the pipeline.
- [references/export-usage-root-analysis.template.cjs](references/export-usage-root-analysis.template.cjs)
  Analyze all Rspack/Rsdoctor exportsUsage chains. Emits a per-EXPORT usage verdict for every used export (genuinely-used / needs-source-confirmation / over-retained-suspect, with suspects grouped by provider module) as the primary output, plus a per-root roll-up and root-cause categories. Third step of the pipeline.
- [references/optimization-summary-template.md](references/optimization-summary-template.md)
  Use when you want a consistent markdown summary for baseline, experiment rounds, risk, and final conclusion.
