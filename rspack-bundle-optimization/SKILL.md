---
name: rspack-bundle-optimization
description: Run a comprehensive Rspack, Rsbuild, or Rspeedy bundle audit and deliver a polished interactive HTML report. Use when the user asks to execute a bundle-size investigation, optimization audit, or measured report. Once an execution audit starts, check every analysis route without asking the user to choose modes. For read-only review or explanation of existing artifacts, inspect them without starting builds or mutating the project.
---

# Rspack Bundle Optimization

Run one evidence-first audit across every supported optimization route. Do not show a mode picker and do not stop after quick triage.

## Metric Contract

- Rank and headline by emitted JavaScript `raw` bytes.
- Show `gzip` second as a transfer-size proxy.
- Define `appJs` with an explicit asset inclusion rule and persist the included asset list.
- Keep production savings separate from source/module-size sums, diagnostic upper bounds, estimated attribution, and debug-artifact changes.
- Count a saving only when baseline and experiment use the same entries, dependencies, feature flags, splitChunks rules, minimization, and `concatenateModules`, except for the single variable under test.

## Create an Isolated Project Run

Inspect the project before building. Choose a project-local ignored or temporary root, then create a unique run directory such as:

```text
<project-temp>/rspack-audit/<run-id>/
  manifest.json
  baseline/
  optimization-config/
  reachability/
  retained-unused/
  side-effects/
  export-usage/
  rollup-diff/
  cjs2esm/
  splitchunks/
  ecma/
  post-loader/
  report/
```

Use `scripts/create-audit-run.cjs` when practical. The agent may choose a different project-appropriate ignored root, but must preserve the same isolation and manifest rules.

Record in `manifest.json`:

- project root, run id, timestamp, build command, output metric rule;
- Git commit and dirty state when available;
- Node, package manager, Rspack/Rsbuild/Rspeedy and minifier versions;
- lockfile, build-config, and relevant environment fingerprints without secret values;
- every command, exit code, output directory, and artifact path.

Never reuse the production `dist`, overwrite another experiment, or mix stats/source/export-usage data from different run ids. Run builds sequentially when they share caches or framework temp state. A report must reject stale or mismatched artifacts.

## Mandatory Ten Checks

Execute all ten checks in this order. The HTML report is a deliverable after these checks, not an eleventh check.

1. **Production baseline, resolved optimization config, and quick triage** — emitted assets, raw/gzip totals, asset manifest, largest assets/modules, plus the effective size-related Rspack options captured from the real production compilation.
2. **Chunk-group reachability** — detect modules loaded by a group but unreachable from its roots; emit the chunk graph.
3. **Retained unused modules** — run with `concatenateModules:false`, enumerate every emitted `usedExports=[]` module and its bailout.
4. **Side-effects source/package audit and A/B** — inspect every candidate's source and package metadata; experiment only with agent-confirmed safe modules.
5. **Export Usage Roots** — trace every captured used export, whole-module cause, terminal root, and post-loader reference site.
6. **Rollup-vs-Rspack export diff** — materialize the same post-loader graph, run Rollup, and source-confirm actionable gaps.
7. **CJS-to-ESM experiment** — run the conservative loader and report package-level size deltas and skips.
8. **splitChunks A/B** — test one knob at a time, beginning with fixed cache-group names only when reachability provides a target.
9. **ECMA target experiment** — raise transform and minifier targets together, attribute generated-byte changes, and derive no-target-change rewrites.
10. **Post-loader source quality** — verify source readability, loader compactness, source locations, and evidence completeness.

Read the matching reference completely before executing each check:

| Check | Required reference |
| --- | --- |
| 1 | This file's metric, run, and resolved optimization config contracts |
| 2 | `references/analysis-01-reachability.md` |
| 3 | `references/analysis-02-retained-unused.md` |
| 4 | `references/analysis-03-side-effects.md` |
| 5 | `references/analysis-04-export-usage.md` |
| 6 | `references/analysis-05-rollup-diff.md` |
| 7 | `references/analysis-06-cjs-to-esm.md` |
| 8 | `references/analysis-07-splitchunks.md` |
| 9 | `references/analysis-08-ecma.md` |
| 10 | `references/analysis-04-export-usage.md` and `references/html-report-design.md` |

## Coverage States

Give every check exactly one machine state and a localized display label:

| Machine state | Chinese label | Meaning |
| --- | --- | --- |
| `completed` | 已完成 | Fresh artifacts and a supported conclusion exist. |
| `completed-no-op` | 已检查，无可执行候选 | The check ran far enough to prove no experiment is useful. |
| `blocked` | 受阻 | A concrete missing capability or failed command prevents completion. |

For `blocked`, record the attempted command, exact error, missing prerequisite, and next command. A report may still be delivered with blocked rows, but the overall audit status is `incomplete`, not successful.

Use these minimum no-op proofs:

- Reachability: a successful graph traversal found zero removable JS-like members.
- Retained unused: a successful concat-off capture found zero emitted `usedExports=[]` modules.
- Side effects: the agent reviewed every candidate source and package, and confirmed zero modules safe for an experiment.
- Rollup diff: Rollup ran against the captured graph and found zero export gaps.
- CJS-to-ESM: an eligibility scan found zero safely transformable static transpiled-CJS modules.
- splitChunks: config plus reachability proves no fixed-name/shared-fan-in target exists.
- ECMA: both stages already use the comparison target or a successful comparison produces no relevant change.
- Post-loader: no source-backed candidate exists, or all captured sources pass the quality thresholds.

Missing tools or incompatible compiler APIs are `blocked`, never `completed-no-op`.

## Resolved Optimization Configuration Gate

Do not infer effective optimization values from the author-written config or by serializing all of `compiler.options`. During check 1, use `scripts/optimization-config-check-plugin.template.cjs` behind `RSPACK_OPT_CONFIG=1` and run the otherwise unchanged production build.

- Direct Rspack: append the plugin to `plugins`.
- Rsbuild: append it from `tools.rspack` with `appendPlugins`.
- Other frameworks: inject it through their final Rspack-config mutation API.

Require one fresh `optimization-config*.json` artifact for every top-level production compiler. The capture must come from `compilation.options`, include the installed Rspack version, and cover:

- pruning: `nodeEnv`, `providedExports`, `usedExports`, `sideEffects`, `innerGraph`, `concatenateModules`, and supported `inlineExports`;
- minification and naming: `minimize`, every JavaScript/CSS minimizer, and `mangleExports`;
- chunk cleanup and layout: `mergeDuplicateChunks`, `removeEmptyChunks`, `splitChunks`, `runtimeChunk`, `chunkIds`, and `moduleIds`;
- ESM library output: supported `avoidEntryIife` and the constraints under which it applies.

For each option, compare the resolved artifact with the author config, framework mutations, and version-matched default. Record provenance as `explicit`, `framework`, `default`, or `unknown`; never guess. Write `optimization-config-check.md` with resolved value, default, provenance, status (`ok`, `suspect`, `experiment`, or `n/a`), likely size impact, evidence, and next action.

Run each suspect or experiment independently and env-gated against the original production baseline. If an unexpectedly disabled core pruning/minification option is corrected, recapture the resolved config and baseline before continuing. Keep `concatenateModules:false` only in diagnostics that require it. A missing or wrong-target capture makes check 1 `blocked`.

## Side-Effects Safety Gate

Never infer purity from `node_modules`, ESM syntax, `usedExports=[]`, a package missing `sideEffects`, or a bailout string.

For every side-effect candidate, the agent must inspect:

- complete readable post-loader source and the corresponding source file;
- the exact top-level bailout statement and all top-level calls, assignments, getters, registrations, imports, and global mutations;
- nearest package `package.json`, including `sideEffects`, `exports`, `module`, `main`, `type`, browser conditions, and package version;
- package entry/barrel relationships and whether importing this module intentionally registers runtime behavior, styles, metadata, polyfills, workers, or plugins.

Write `side-effects-decisions.json`. Each row must be `safe-experiment`, `keep`, or `unknown`, with source evidence, package evidence, review timestamp, and matching disk-source, post-loader-source, and package hashes from the fresh worklist. Only a hash-valid `safe-experiment` row may enter the env-gated `sideEffects:false` rule. Source/module-size sums are review scope only; the production A/B emitted raw delta is the only saving.

Do not delegate this decision to a filename regex. Subagents may help only when higher-priority instructions and the user explicitly permit them; otherwise process the checkpointed worklist locally.

## Capability Preflight

Before the first expensive build, resolve the required project-local capabilities:

- Rspack/Rsbuild/Rspeedy compiler and production command;
- installed Rspack version and the version-matched optimization defaults used for comparison;
- Rollup and optional `@rollup/plugin-commonjs`;
- `@swc/core` for the conservative CJS loader;
- `@jridgewell/trace-mapping` or compatible sourcemap reader;
- a browser/runtime for HTML validation.

Do not change the project's dependency manifest merely to run the audit unless the user authorizes it. The bundled tools resolve dependencies from the project root and emit actionable failures when unavailable.

## Required Tools

Use or adapt these bundled scripts instead of rewriting them each run:

- `scripts/create-audit-run.cjs` — isolated run directory and manifest.
- `scripts/optimization-config-check-plugin.template.cjs` — capture normalized effective size-related options from the real compilation.
- `scripts/chunk-group-reachability-plugin.template.cjs` — reachability and chunk graph capture.
- `scripts/retained-unused-side-effects-plugin.template.cjs` — retained-unused capture.
- `scripts/retained-unused-disposition.template.cjs` — conservative worklist plus agent-decision merge; never auto-approves purity.
- `scripts/side-effects-review-worklist.cjs` — collect full source and nearest package metadata for agent review.
- `scripts/export-usage-capture-plugin.template.cjs`, `scripts/build-all-export-usage.template.cjs`, `scripts/export-usage-root-analysis.template.cjs`, `scripts/show-post-loader.template.cjs` — export-usage pipeline.
- `scripts/rollup-graph-capture-plugin.cjs` and `scripts/run-rollup-export-diff.cjs` — capture and execute the Rollup comparison.
- `scripts/transpiled-cjs-to-esm-loader.cjs` and `scripts/cjs2esm-package-size-diff.cjs` — conservative CJS experiment and attribution.
- `scripts/sourcemap-generated-byte-attribution.cjs` — baseline/experiment generated-byte attribution.
- `scripts/render-bundle-report.cjs` — normalized data to interactive HTML.
- `scripts/serve-bundle-report.cjs` — safe project-run-local server for on-demand data.

## HTML Deliverable

After all checks reach a coverage state, read `references/html-report-design.md` completely and generate `<run-dir>/report/bundle-optimization-report.html` from fresh artifacts.

The report must:

- include all ten checks and their states;
- include the resolved optimization-config table, provenance, suspects, and measured follow-up experiments;
- lead with confirmed emitted raw savings, then gzip;
- separate production-comparable savings, high-risk results, optimization potential, and blocked work;
- support search, sorting, selection, code/source drill-down, exact highlighting, and links to backing artifacts;
- use lazy/on-demand data and a local server for large reports according to the HTML performance contract;
- remain local-only by default because it can contain proprietary source and absolute paths; require explicit redaction before publishing.

Validate desktop and narrow layouts, keyboard focus, search/sort, selection, lazy loads, source highlighting, console errors, and stale-artifact rejection. Give the user a clickable report path and, for server mode, the local URL and server command.

## Completion Contract

The audit is complete only when:

- the production baseline and resolved optimization-config capture succeeded;
- every mandatory check is `completed` or evidence-backed `completed-no-op`;
- no headline saving comes from source size, estimated attribution, or a diagnostic build;
- every side-effects experiment candidate has an agent-authored source/package decision;
- the browser-validated HTML report and backing manifest are present.

If any mandatory check is `blocked`, deliver the report but label the overall audit `incomplete` and name the exact unblock action.
