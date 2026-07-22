# Analysis 04: Export Usage Roots and Whole-Module Causes

## Purpose

Explain why every captured export is used, which terminal roots retain it, and which import causes `usedExports:true`. Use the backing data as truth; HTML is only a navigation layer.

## Same-Run Capture

Capture from the same isolated run and compilation family used for the conclusion. Do not join a newer stats file to stale export edges.

For Rspack builds exposing builtin Rsdoctor export-usage edges, add `scripts/export-usage-capture-plugin.template.cjs` behind an audit flag with `concatenateModules:false`, `usedExports:true`, `minimize:false`, and readable loader output. Pass the already imported `rspack` instance into the plugin, plus explicit run/compiler identity and a fresh compiler-specific directory:

```js
new ExportUsageCapturePlugin({
  rspack,
  runId: process.env.RSPACK_AUDIT_RUN_ID,
  compilerId: "web",
  outDir: process.env.RSPACK_EXPORT_USAGE_OUT_DIR,
});
```

Use a separate `outDir` and unique `compilerId` for every top-level compiler. The plugin refuses a failed build, unsupported Rsdoctor API, missing graph hook, or existing artifact. It writes the raw graph only after the same successful compilation has completed the post-loader source inventory.

If the compiler lacks the required API, use a project-compatible Rsdoctor capture. Missing edges are `blocked`; never replace them with an unlabeled text-search approximation.

## Pipeline

```bash
node scripts/build-all-export-usage.template.cjs \
  --raw <run>/export-usage/rsdoctor-export-usage-raw.json \
  --out <run>/export-usage/rsdoctor-all-export-usage.json

node scripts/export-usage-root-analysis.template.cjs \
  --usage <run>/export-usage/rsdoctor-all-export-usage.json \
  --context <project-root> \
  --out-dir <run>/export-usage/roots
```

Capture all used exports, not only Rollup gaps. Preserve direct references, export-to-export propagation, namespace edges, dependency id, request, consumer-side `loc`, bounded chains, terminal kind, and cap counters.

Both transformation commands validate their input schema, `complete:true`, run id, compiler id, counts, and graph references before producing output. `{}`, malformed arrays, count mismatches, dangling edge endpoints, or capped chains are failure/review evidence, not empty successful captures. Preserve the run/compiler identity through the raw, expanded, and root-analysis artifacts.

## Chain Correctness

- A target export's chain must continue upstream past barrels until a terminal consumer/root or explicit cap.
- A chain containing only the target declaration is incomplete.
- `targetExports===null`, `viaNamespace`, or equivalent is a coarse whole-module edge; preserve it because it can keep every provider export alive.
- Rsdoctor `loc` belongs to the consumer/post-loader source. Never apply it directly to raw disk source without an approximate label.
- Count each terminal root once per target export; keep raw chain count separately.
- Report chain coverage, capped branches, missing sources, unknown exports, and missing locations.

## Per-Export Ledger

Every used export ends in one of:

- `genuinely-used`: at least one complete chain reaches a real runtime consumer;
- `confirmed-removable`: every chain is coarse/artifact-only and source inspection proves no genuine use;
- `still-unknown`: exact missing or conflicting evidence is recorded.

The analyzer may mechanically triage records, but the agent must read post-loader reference sites for every unresolved/suspect export. Process the checkpointed worklist locally by default. Use subagents only when higher-priority instructions and the user explicitly permit them.

For a `usedExports:true` provider, first identify the exact consumer import edge that made the namespace live. Read that consumer source at `loc`; do not infer from the provider alone.

## Evidence Handoff

Use post-loader reference sites for every source decision in this route. Analysis 09 owns the complete source-quality inventory and repair procedure. A missing or unreadable required source keeps the affected export verdict unresolved and blocks this route's supported conclusion.

## Required Artifacts

- `rsdoctor-export-usage-raw.json`
- `rsdoctor-all-export-usage.json`
- `post-loader-sources.jsonl` and index
- per-export/root analysis JSON and Markdown
- source-confirmed export ledger with coverage
- whole-module import-cause rows

Before project wiring, run:

```bash
node <skill>/scripts/export-usage-capture-plugin.template.cjs --self-test
node <skill>/scripts/build-all-export-usage.template.cjs --self-test
node <skill>/scripts/export-usage-root-analysis.template.cjs --self-test
```

## Completion Gate

Review every non-`genuinely-used` `exportVerdicts` row and every whole-module
consumer cause. `still-unknown`, `no-chain`, capped chains,
missing locations, and missing readable sources keep the affected candidate
non-terminal or blocked; they cannot coexist with a completed check. Resolve
every export, not only top roots or sample exports. A positive source rewrite
needs its own production Rspack A/B and auto-apply/risk decision.
