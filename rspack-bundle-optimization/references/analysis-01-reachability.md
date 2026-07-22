# Analysis 01: Chunk-Group Reachability

## Purpose

Determine whether a chunk group loads JavaScript modules that are not synchronously reachable from that group's roots. This diagnoses accidental membership and shared-chunk fan-in; it is not tree shaking by itself.

## Capture

Start from `scripts/chunk-group-reachability-plugin.template.cjs`. Run it in the current isolated run directory and preserve the production entry graph and splitChunks configuration.

For each group, record:

- group kind, name, chunks, JS assets, and request count;
- `groupTotalJSSize` from all JS-like modules in its chunks;
- roots and how each root was discovered;
- reachable, unreachable, external, and non-JS module counts and sizes;
- import-boundary edges with request, source module, `loc`, and snippet.

## Root Discovery

For initial groups, use `chunkGraph.getChunkEntryModulesIterable(chunk)`.

For async groups, try in order:

1. `origin.dependency` through `moduleGraph.getModule(dep)`;
2. every dependency under `origin.module.blocks[]`, keeping targets that belong to the group's actual modules;
3. chunk entry modules as a labeled fallback.

Do not silently accept an empty root set. Persist the group with `analysisStatus: "blocked"`, every attempted strategy, and a `missing-root-modules` data-quality issue. The bundled plugin writes the partial evidence and then fails the capture so a rootless group cannot become a zero-impact conclusion.

## Traversal

Run BFS over the full `moduleGraph`, not only modules inside the current chunk group. Dependency paths often pass through modules emitted in other chunks.

For each outgoing connection:

- skip missing targets and `weak` connections;
- skip an edge whose dependency belongs to a different `AsyncDependenciesBlock` so the traversal does not cross another async boundary;
- otherwise enqueue `conn.module`.

Only intersect the visited set with the group's actual modules after traversal.

Use a robust module-size fallback: `chunkGraph.getModuleSize(module)`, then `module.size()`, then the sum of `module.size(sourceType)`.

## Candidate Rule

`potentiallyRemovableJsLike = actualJsLikeModules - reachableJsLikeModules`.

Exclude externals and asset/resource modules. Keep CSS and other non-JS residuals in a separate diagnostic bucket. A module being unreachable from the selected roots is a lead; verify the root set and chunk semantics before claiming a saving.

## Chunk Graph

Generate `chunk-graph.json` plus `chunk-graph.html`. Every async edge must retain its `import()` request and consumer-side source location. Deduplicate identical locations between the same groups.

## Interpretation

- Zero removable JS-like modules after a successful traversal supports `completed-no-op` for reachability and usually for fixed-name splitChunks tuning.
- Huge async groups with zero unreachable membership point to real route/block fan-in.
- Polyfills or helpers appearing unreachable can come from loader injection such as SWC `env.mode:"usage"`; trace incoming connections before changing splitChunks.
- A fixed cache-group name may turn otherwise distinct module sets into shared fan-in. Pass that evidence to Analysis 07.

## Required Artifacts

- `reachability-summary.json`
- `chunk-graph.json`
- `chunk-graph.html`
- build command and run-manifest update

Before project wiring, run:

```bash
node <skill>/scripts/chunk-group-reachability-plugin.template.cjs --self-test
```

## Completion Gate

Use the complete `removableJSModules` arrays as the worklist, never a
display-ranked subset. Every unreachable JS-like member must end as `applied`,
`validated-opportunity`, `keep`, `risk-found`, `rejected`, or `blocked` after root
and source inspection. A graph capture with nonzero candidates is
`review-required`, not completed. If a source change is applied, rerun the
full audit from a new production baseline pass. A missing root set or failed
chunk-graph generation is `blocked`; it is never equivalent to zero removable
modules.
