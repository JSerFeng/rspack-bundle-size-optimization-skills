---
name: rspack-bundle-optimization
description: Audit and reduce Rspack, Rsbuild, or Rspeedy bundle size using production build data, source and export-usage analysis, and optional Chrome runtime coverage. Use for bundle-size investigations, implementation, reviews, or measured reports.
---

# Rspack Bundle Optimization

Find why JavaScript is emitted or loaded. When the user requests changes,
confirm each applied improvement with production output and the checks needed
for the affected behavior.

## Mode and permission

- Use `audit-only` for investigation, explanation, review, and report requests.
- Use `optimize` only when the user asks to optimize, reduce, fix, apply, or
  implement.
- Do not commit, push, publish, replace dependencies, change browser support,
  or change product behavior without authorization.

## Build modes

- `development`: use only for local debugging or tool checks. Do not report its
  bytes, requests, or coverage as production results.
- `production`: use the unchanged production configuration to confirm emitted
  bytes and requests. Claim a performance improvement only after measuring a
  named performance metric under the same conditions.
- `production-debug`: start from production, disable JavaScript minimization
  and `optimization.concatenateModules`, and set `optimization.moduleIds` to
  `named`. Keep entries, compilation targets, feature flags, splitChunks,
  dependencies, runtime, and existing production plugins unchanged. The
  capture plugin in [references/data-capture.md](references/data-capture.md)
  may also be enabled. Use this mode only to map chunks and generated module
  wrappers; confirm savings with `production`.

## Tools collect data; the agent decides

The supplied tools may capture compiler or browser data, save the JavaScript
passed to Rspack after loaders, link compiler and browser records to source
modules and emitted assets, verify files, and calculate raw/gzip bytes. They
must not choose what to inspect, infer source behavior, recommend a change,
assess risk, or write the conclusion.

Treat compiler fields such as `usedExports`, `providedExports`, bailouts, and
export-usage edges as build facts, not decisions about product intent. A
runtime count of zero means only that execution was not observed in the
recorded scenario.

## Workflow

### 1. Inspect the project

Read applicable `AGENTS.md` files and identify:

- the package manager, production command, actual compiler version, and dirty
  state;
- total, initial, and important route JavaScript scopes;
- browser/runtime requirements and relevant build, test, and runtime checks.

Read the production command before running it. If it can deploy, upload,
publish, or mutate an external system, isolate the local build step or ask for
authorization.

### 2. Create a data run

```bash
node <skill>/scripts/create-audit-run.cjs \
  --project-root <project-root> \
  --root <ignored-project-local-root> \
  --build-command "<production command>" \
  --asset-scope "<plain-language scope>"
```

Use a fresh run and output directory. Do not combine files from different run
ids or overwrite an earlier build.

### 3. Capture and measure the unchanged build

Read [references/data-capture.md](references/data-capture.md). In `audit-only`,
do not change tracked source or config unless the user separately authorizes a
temporary capture setup. Prefer an existing audit hook or ignored wrapper. If
neither works, report the missing data or ask for that authorization. Keep
each top-level compiler in its own capture directory.

Read [references/measurement.md](references/measurement.md) and measure the
exact assets in each relevant scope. Report raw bytes first and gzip second.

### 4. Capture browser loading only when needed

When the question concerns actual browser requests or execution during a page
or interaction, read
[references/runtime-coverage.md](references/runtime-coverage.md) completely.
Use `production-debug` for source-level mapping and `production` for final byte
or request comparisons. A static route chunk-group size question uses compiler
data and does not require browser coverage.

### 5. Analyze the evidence

Read [references/agent-analysis.md](references/agent-analysis.md) completely.
Start with the largest relevant source of initial, route, or total JavaScript.
For each important item, inspect the complete source on disk, source after
loaders, package metadata, consumers, graph connections, chunks, and emitted
output before deciding what it means.

State how items are selected: include the largest unexplained contributors and
anything large enough to affect the user's goal. Continue until the remaining
items are too small to affect that goal or each has a specific documented
reason it cannot be resolved.

For important export usage that resolves to a namespace:

1. find every source `import()` that creates the namespace;
2. inspect the original source before Babel or SWC lowers `await import()`;
3. combine export names from every property read, destructuring statement,
   alias, helper call, and downstream consumer;
4. do not guess a list when non-literal computed keys, rest/spread, enumeration,
   reflection, re-export, or unresolved namespace passing remains;
5. once every reachable consumer has been resolved and the complete export-name
   list is known, record the proposed comment without editing in `audit-only`;
6. in `optimize`, add `import(/* rspackExports: ["foo"] */ "pkg")`, then
   confirm in source after loaders that the dynamic `import()` and comment
   still reach Rspack before capturing export usage and output again.

The detailed rules and destructuring example are in
[references/agent-analysis.md](references/agent-analysis.md#dynamic-imports-used-as-namespaces).

### 6. Make and check changes

In `optimize` mode:

- change one thing at a time and use a fresh output directory;
- keep unrelated entries, dependencies, feature flags, minimization,
  concatenation, splitChunks, and runtime settings unchanged;
- compare the same total, initial, and route asset scopes before and after;
- inspect the emitted diff and run the checks required by the affected code;
- keep a change as a confirmed saving only when the production output improves
  for the intended reason and no required correctness, compatibility, or team
  check remains.

### 7. Finish and report

In `audit-only`, use the unchanged production build as the final measurement
when it can be captured. Otherwise, state what prevented the measurement. Do
not claim a confirmed saving. Finish when the important sources are explained,
missing data is named, and proposed changes are clearly marked as unmeasured.

In `optimize`, measure the final production build again. Finish when one of
these statements is supported:

- the important safe changes were applied and checked, with no larger
  in-scope item left unexamined;
- the remaining important items are blocked by a named risk, a user or team
  decision, or a dependency change, and the report states what would unblock
  them;
- required data could not be captured after a concrete attempt, and the report
  clearly marks the affected conclusion as incomplete.

Read [references/report-template.md](references/report-template.md). Separate
confirmed applied savings, measured but unapplied results, estimates from
non-production or otherwise non-comparable builds, changes that did not help,
blocked items, and remaining actions.
State what was checked and never claim absolute zero risk.
