---
name: rspack-bundle-optimization
description: Investigate and reduce JavaScript emitted or loaded by Rspack, Rsbuild, or Rspeedy. Use for bundle-size audits, optimization changes, measured reports, and browser runtime-loading analysis.
---

# Rspack Bundle Optimization

Explain why relevant JavaScript is emitted or loaded, then verify requested
improvements against comparable production output.

## Choose the task mode

- `audit-only`: investigate, explain, review, or report. Use existing or
  ignored capture hooks and record proposals as unmeasured. A tracked capture
  setup requires separate authorization and is removed before delivery.
- `optimize`: implement bundle reductions when the user requests changes.

## Evidence model

- `production` is the source of confirmed emitted-byte and request results.
- `production-debug` starts from production, disables JavaScript minimization
  and `optimization.concatenateModules`, and uses named module ids. Use it to
  map chunks, generated module wrappers, and post-loader source while keeping
  entries, targets, feature flags, dependencies, splitChunks, runtime, and
  existing production plugins unchanged apart from the capture plugin.
- `development` supports local debugging and tool checks.

Report raw JavaScript bytes first and gzip second. Keep total, initial, static
route-group, and browser-observed route scopes distinct. A user-facing
performance conclusion also requires the named performance metric measured
under comparable conditions.

Compiler fields such as `usedExports`, `providedExports`, bailouts, and
export-usage edges describe the captured build. Runtime counts describe the
recorded scenario. Decide product intent and semantic safety from source,
consumers, loading causes, runtime behavior, and emitted production output.

The bundled scripts capture, join, normalize, verify, and measure evidence.
The agent selects findings, interprets source behavior, evaluates risk, and
writes conclusions.

## Workflow

### 1. Define the scope

Read applicable `AGENTS.md` files and the actual production command. Identify:

- package manager and compiler version used by the build;
- dirty state and relevant source/config ownership;
- exact total, initial, and important route JavaScript scopes;
- applicable build, test, browser, and runtime checks.

### 2. Capture the unchanged build

Create one fresh run:

```bash
node <skill>/scripts/create-audit-run.cjs \
  --project-root <project-root> \
  --root <ignored-project-local-root> \
  --build-command "<production command>" \
  --asset-scope "<plain-language scope>"
```

Read [references/data-capture.md](references/data-capture.md) when compiler
graph, chunk, export-usage, or post-loader source data is needed. Keep each
top-level compiler in its own capture directory.

Read [references/measurement.md](references/measurement.md) and measure the
explicit production asset sets for the requested scopes.

### 3. Add runtime evidence when the question needs it

For browser-request or execution questions, read
[references/runtime-coverage.md](references/runtime-coverage.md) completely.
Capture named, repeatable scenarios with `production-debug` for mapping and
`production` for final request or byte comparisons. Compiler data is enough
for a static route chunk-group question.

### 4. Explain the important bytes

Read [references/agent-analysis.md](references/agent-analysis.md).
Start with the largest contributor relevant to the user's total, initial, or
route goal. Trace each material finding through complete disk and post-loader
source, package metadata, consumers, graph connections, chunk membership,
loading cause, and emitted output.

Keep the analysis proportional to the goal: explain contributors that can
materially affect it and record concrete reasons for the remaining material
items.

For dynamic-import grouping, magic comments, or namespace export analysis,
read [references/dynamic-imports.md](references/dynamic-imports.md). For an
ECMAScript/browser target experiment, read
[references/ecmascript-target.md](references/ecmascript-target.md).

### 5. Implement and verify requested changes

In `optimize` mode, isolate one causal change per experiment and use a fresh
output directory. Compare the same production scopes, inspect meaningful
emitted changes, and run checks for the affected behavior. Retain confirmed
savings whose output change matches the source-level explanation.

Measure the final production state after the accepted changes.

### 6. Report the result

Read [references/report-template.md](references/report-template.md). Lead with
the measured result, scope, and cause. Include applied changes, material open
decisions, and evidence needed for remaining work. Mention rejected
hypotheses or failed experiments only when they explain a decision or prevent
likely repeated work.

An `audit-only` result includes the unchanged production measurement when
available, explained material sources, evidence gaps, and proposals labeled
unmeasured. An `optimize` result includes unchanged-to-final production
measurements, accepted changes and checks, plus any material item blocked by a
named risk or decision.
