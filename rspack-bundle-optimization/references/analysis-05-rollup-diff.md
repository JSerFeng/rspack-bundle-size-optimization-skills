# Analysis 05: Rollup-vs-Rspack Export Diff

## Purpose

Use Rollup as a diagnostic comparator for the same loader-processed graph. A Rollup-removed export is a hypothesis, not proof that Rspack is wrong or that application code can be deleted.

## Capture the Rspack Graph

Add `scripts/rollup-graph-capture-plugin.cjs` to the isolated diagnostic build:

```js
const {
  RollupGraphCapturePlugin,
} = require("<skill>/scripts/rollup-graph-capture-plugin.cjs");

plugins.push(
  new RollupGraphCapturePlugin({
    graphPath: "<run>/rollup-diff/rollup-graph.json",
  }),
);
```

Use `optimization.concatenateModules:false`, named module ids, and readable non-minimized post-loader source. The capture records module ids, source, entry status, Rspack provided/used exports, and request-to-target edges.

## Execute Rollup

```bash
node scripts/run-rollup-export-diff.cjs \
  --graph <run>/rollup-diff/rollup-graph.json \
  --project-root <project-root> \
  --out-dir <run>/rollup-diff
```

The runner resolves Rollup from the project, loads captured sources through a virtual plugin, uses captured dependency edges for resolution, applies project-local `@rollup/plugin-commonjs` when available, and writes Rollup inputs/output plus an export-diff report.

Its gap rows include direct incoming references and bounded module-level upstream chains. These chains are deliberately labeled coarse; merge them with Analysis 04's export-specific roots and consumer `loc` evidence before recommending a rewrite.

Do not silently externalize a captured dependency. Any unresolved captured edge, parse failure, unsupported module type, or Rollup semantic warning must appear in the data-quality section. If the materialized graph cannot preserve runtime semantics, the check is `blocked`.

## Required Gap Evidence

For every gap, preserve:

- module absolute path and export;
- Rspack used/provided exports;
- Rollup rendered/removed exports;
- direct Rspack references and bounded upstream chains;
- request, dependency id/type, and consumer-side `loc`;
- readable source around the reference.

If many gaps have no reference chain, repair the capture before triage.

## Source Confirmation

Prioritize source patterns that can be rewritten without semantic change:

- barrel re-export fan-in;
- namespace object propagation where named access is possible;
- circular barrels that force conservative retention;
- helpers that return or store a whole dynamic-import namespace;
- mixed registration and pure exports.

Reject or label residual:

- real entries, routes, bootstrap, service/plugin registration;
- real top-level effects;
- Rollup stubs or externals that do not match Rspack;
- circular chunk warnings with possible execution-order change;
- CommonJS that remains incomparable.

Only a source-backed rewrite followed by an isolated production Rspack A/B can become a saving. Zero gaps after a successful Rollup run is `completed-no-op`.

## Required Artifacts

- `rollup-graph.json`
- materialized Rollup input and output
- `rollup-export-diff.json` and `.md`
- warning/unresolved-edge ledger
- source-confirmed candidate ledger

## Completion Gate

`run-rollup-export-diff.cjs` returns `review-required` whenever it finds gaps.
Review all `gaps[]` rows and read the corresponding Rspack
consumer/post-loader source for each one. The comparator command succeeding is
not completion. Every gap must be rejected, kept, risk-documented, blocked, or
validated by a source rewrite plus production Rspack A/B.
