---
name: rspack-bundle-optimization
description: Autonomously audit and, when explicitly requested, optimize Rspack, Rsbuild, or Rspeedy bundles. Use for bundle-size investigations, reductions, optimizations, reviews, or measured reports. Exhaust all ten analysis routes and every discovered candidate; data capture alone is never completion. Treat analysis, investigation, review, and report requests as audit-only. Apply project changes only when the user explicitly asks to reduce, optimize, fix, or implement; then require source-backed production measurements, validation, and a fresh fixed-point pass.
---

# Rspack Bundle Optimization

Own the bundle audit from baseline through validated fixed point. Treat the HTML report as the final deliverable, never as a substitute for analysis.

## Operating Contract

- Infer `audit-only` for analysis, investigation, explanation, review, and report requests. Enter `optimize` only when the user explicitly asks to reduce, optimize, fix, apply, or implement changes.
- In `optimize` mode, inspect source, run experiments, make safe edits, and validate them without handing candidate decisions back to the user.
- Keep the ten high-level routes in the host agent's native task plan. Persist every complete candidate worklist, terminal disposition, route coverage count, and artifact identity under the isolated run directory; never use the task plan or conversation context as the only source of audit state. The ledger is a durable record, not a scheduler; do not create a daemon, controller, or work queue for agent orchestration.
- Treat analyzer output as evidence. A successful capture command creates work; it does not complete a route that has findings.
- Continue while runnable or unresolved work remains. Elapsed time, context compaction, a partial report, or one successful optimization is not a stopping condition.
- Do not commit, push, publish, or change product policy unless the user separately requests it.

## Fixed-Point Workflow

1. Read applicable `AGENTS.md` files and inspect the project, production command, package manager, compiler version, dirty state, and available validation commands.
2. Create a fresh isolated run with `scripts/create-audit-run.cjs`. Record commands, fingerprints, outputs, and artifacts in its manifest, and maintain the generated `candidate-ledger.json` as the durable route/candidate state.
3. Capture the production baseline and resolved optimization configuration.
4. Execute all ten routes below. Read each route's reference completely before running it and resolve its complete candidate worklist.
5. For each candidate, inspect graph evidence, source, package/config context, generated output, and the route-specific risk boundary.
6. In `optimize` mode, run a narrow production-comparable experiment. Promote the change only if it passes the auto-apply gate.
7. If any change is applied, discard stale comparisons and restart the full workflow from a fresh production baseline.
8. When a complete pass applies no new change and every candidate is terminal, render and browser-validate the final report.

If a route is blocked, record the blocker and continue every independent route.

## Measurement Contract

- Rank and headline emitted JavaScript `raw` bytes; show `gzip` second.
- Define `appJs` with an explicit asset inclusion rule and preserve the included asset manifest.
- Count savings only from production-comparable A/B builds with the same entries, dependencies, feature flags, splitChunks rules, minimization, and concatenation, except for the one variable under test.
- Keep source/module-size scope, diagnostic upper bounds, estimated attribution, debug output, and browser-target experiments separate from confirmed production savings.
- Never reuse production `dist`, overwrite another experiment, or combine artifacts from different run ids.

## Mandatory Routes

| # | Route | Required reference |
| --- | --- | --- |
| 1 | Production baseline, resolved optimization config, and quick triage | `references/analysis-00-baseline-config.md` |
| 2 | Chunk-group reachability and chunk graph | `references/analysis-01-reachability.md` |
| 3 | Retained unused modules with concatenation disabled | `references/analysis-02-retained-unused.md` |
| 4 | Side-effects source/package audit and production A/B | `references/analysis-03-side-effects.md` |
| 5 | Export Usage Roots and whole-module import causes | `references/analysis-04-export-usage.md` |
| 6 | Rollup-vs-Rspack export diff | `references/analysis-05-rollup-diff.md` |
| 7 | Conservative CJS-to-ESM experiment | `references/analysis-06-cjs-to-esm.md` |
| 8 | splitChunks single-variable A/B | `references/analysis-07-splitchunks.md` |
| 9 | ECMA producer/minifier cost and root-cause attribution | `references/analysis-08-ecma.md` |
| 10 | Post-loader source quality and evidence completeness | `references/analysis-09-post-loader.md` |

Execute the routes in this priority order unless a blocked dependency requires continuing an independent route first. Do not use a presentation table or top-N sample as a worklist.

## Candidate Contract

Record the discovered count for every route. Give every candidate exactly one terminal disposition:

- `applied`: promoted in `optimize` mode and fully validated;
- `validated-opportunity`: safe and measured, but retained unapplied only in `audit-only` mode;
- `keep`: source or runtime evidence proves the retained behavior is required;
- `risk-found`: a plausible optimization has a concrete residual risk;
- `rejected`: the production experiment has no positive raw-byte result or its hypothesis is disproved;
- `blocked`: required evidence cannot be obtained after a concrete attempt.

Analyzer labels such as `investigate`, `unknown`, `no-chain`, `source-review-required`, or `review-required` are non-terminal. A route cannot complete until its terminal count equals its discovered count.

Persist each candidate id, evidence, and disposition in `<run>/candidate-ledger.json`; derive the report's per-route coverage from that ledger. Before rendering, run `node <skill>/scripts/create-audit-run.cjs validate-ledger --run-dir <run>`. A missing candidate, non-terminal disposition, duplicate id, inconsistent count, evidence-free decision, incomplete blocker metadata, or underspecified `risk-found` fails validation.

For every `risk-found` candidate, record:

- the concrete failure mode;
- the source, graph, output, or policy evidence exposing it;
- the exact validation or product decision that could clear it.

Do not use a generic label such as “possibly risky.”

## Auto-Apply Gate

Promote an optimization only when all conditions hold:

- the change is concrete, narrow, source-backed, and contains no unrelated edits;
- a production-comparable A/B proves a positive emitted-JavaScript raw-byte reduction;
- the output diff is fully explained by the intended transformation;
- review finds no observed residual semantic, public-API, browser-support, dependency, side-effect-order, registration, loading-order, chunk/request, cache, CSS, worker, or product-policy risk;
- the production build and the most relevant tests or runtime smoke checks pass.

If any condition is unproven, do not promote the change. Classify it as `risk-found`, `rejected`, or `blocked` with evidence. Never claim absolute zero risk; claim only that no residual risk was observed within the stated checks.

## Route States

Use `pending`, `running`, and `review-required` only while work remains. Give each route one terminal report state:

| State | Meaning |
| --- | --- |
| `completed` | Fresh artifacts, complete candidate coverage, and a supported conclusion exist. |
| `completed-no-op` | The route-specific no-op proof succeeded and discovered no actionable experiment. |
| `blocked` | A concrete failed command or missing capability prevents a supported conclusion. |

For `blocked`, record the attempted command, exact error, missing prerequisite, and next command. Missing tooling or incompatible compiler APIs are blockers, never no-op proofs.

## Script Boundary

- Use bundled scripts for deterministic capture, transformation, byte accounting, comparison, and rendering.
- Resolve bundled script and reference paths from this skill's directory, not from the audited project's current working directory; only copied or adapted project wiring belongs under the project root.
- Require machine-readable backing data to remain exhaustive; presentation views may rank or truncate it.
- Do not let scripts infer semantic safety, side-effect purity, compatibility, or the final candidate disposition.
- Resolve optional analysis packages from the project. Do not modify the project's dependency manifest solely for audit tooling without user authorization.

## Report Delivery

After the fixed point:

1. Read `references/html-report-design.md` and `references/optimization-summary-template.md` completely.
2. Validate `candidate-ledger.json`, then render the report from the final fresh pass with `scripts/render-bundle-report.cjs`.
3. Validate desktop and narrow layouts, interaction, source drill-down, console output, evidence links, and stale-artifact handling.
4. Perform the agent readability review defined by the report reference and run `--finalize-readability`.
5. Give the user the local report path or server URL. Keep proprietary source and absolute paths local unless the user requests a redacted publication.

## Completion Contract

Return final only when:

- the production baseline and resolved configuration capture succeeded;
- every route is `completed`, evidence-backed `completed-no-op`, or a genuine `blocked`;
- every discovered candidate has a fresh, source-backed terminal disposition;
- every safe positive candidate was applied and validated in `optimize` mode;
- in `optimize` mode, every unapplied opportunity has concrete residual-risk evidence and a clearing condition;
- in `audit-only` mode, a safe measured `validated-opportunity` may remain unapplied solely because edits were not authorized; record that mode boundary instead of inventing residual risk;
- the final complete pass applied no new change;
- no diagnostic or estimated byte count is reported as confirmed savings;
- every independent route was exhausted despite any blocker;
- the final report passed browser and readability validation.

A run with any blocked route is deliverable only as `incomplete`, with the exact unblock action. Never return final while runnable or unresolved work remains.
