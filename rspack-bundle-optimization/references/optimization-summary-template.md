# Bundle Optimization Decision Report

## Contents

- [One-Page Conclusion](#1-one-page-conclusion)
- [Measurement Contract](#2-measurement-contract)
- [Result Classification](#3-result-classification)
- [Optimization Cards](#4-optimization-cards)
- [ECMA Diagnostic Page](#5-ecma-diagnostic-page)
- [Export Usage / Root Cause Page](#6-export-usage--root-cause-page)
- [Action Queue](#7-action-queue)
- [Residuals and Stopping Point](#8-residuals-and-stopping-point)
- [Appendix](#9-appendix)

Generated from:

- Validated candidate ledger: `[candidate-ledger.json and validate-ledger command]`
- Baseline summary: `[baseline-summary.json]`
- Resolved optimization config: `[optimization-config*.json]`
- Optimization config review: `[optimization-config-check.md]`
- Production experiment summaries: `[experiment-summary.json...]`
- Diagnostic reports: `[reachability/export-usage/ecma/cjs2esm reports...]`

Build commands:

- Baseline production build: `[command]`
- Experiment production build: `[command]`
- Diagnostic build/report command: `[command]`

Artifacts:
- Output directory: `[dist path]`
- Latest Markdown report: `[report path]`
- Machine-readable report: `[json path]`
- HTML summary report: `[html path]`
- Agent readability review: `[readability-review.md path, pass/fail, finalization command]`
- Delivery manifest: `[report-manifest.json path, auditStatus, readabilityReview.status, deliveryStatus, overallStatus]`
- Exports usage HTML: `[exports usage / exports info usage html path, or "not generated: rerun Export Usage Roots"]`
- Export source confirmation HTML: `[source confirmation html path, or "not generated"]`
- Chunk graph HTML: `[chunk graph html path, or "not generated"]`

Related analysis pages:

| Page                       | Link / path                                   | Why it matters                                                                        |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Exports usage analysis     | `[relative link to exports usage HTML]`       | Shows who keeps each export alive, including root module, chain, and source location. |
| Export source confirmation | `[relative link to source confirmation HTML]` | Shows code snippets and highlighted usage locations for export-chain claims.          |
| Chunk graph                | `[relative link to chunk graph HTML]`         | Shows async/shared JS loading relationships.                                          |
| Raw data                   | `[JSON/Markdown paths]`                       | Lets reviewers audit the numbers behind this summary.                                 |

Mandatory audit coverage:

| Check                                                             | State                                     | Fresh artifact / evidence | Result     | Candidate coverage `[d/t/u/a/r]` | Attempted command | Exact error     | Missing prerequisite     | Next command     |
| ----------------------------------------------------------------- | ----------------------------------------- | ------------------------- | ---------- | -------------------------------- | ----------------- | --------------- | ------------------------ | ---------------- |
| Production baseline / resolved optimization config / quick triage | `[completed / completed-no-op / blocked]` | `[paths or evidence]`     | `[result]` | `[0 / 0 / 0 / 0 / 0]`            | `[attempted]`     | `[exact error]` | `[missing prerequisite]` | `[next command]` |
| Chunk-group reachability                                          | `[completed / completed-no-op / blocked]` | `[path or evidence]`      | `[result]` | `[0 / 0 / 0 / 0 / 0]`            | `[attempted]`     | `[exact error]` | `[missing prerequisite]` | `[next command]` |
| Retained unused modules                                           | `[completed / completed-no-op / blocked]` | `[path or evidence]`      | `[result]` | `[0 / 0 / 0 / 0 / 0]`            | `[attempted]`     | `[exact error]` | `[missing prerequisite]` | `[next command]` |
| Side-effects A/B                                                  | `[completed / completed-no-op / blocked]` | `[path or evidence]`      | `[result]` | `[0 / 0 / 0 / 0 / 0]`            | `[attempted]`     | `[exact error]` | `[missing prerequisite]` | `[next command]` |
| Export usage roots and whole-module import causes                 | `[completed / completed-no-op / blocked]` | `[path or evidence]`      | `[result]` | `[0 / 0 / 0 / 0 / 0]`            | `[attempted]`     | `[exact error]` | `[missing prerequisite]` | `[next command]` |
| Rollup-vs-Rspack export diff                                      | `[completed / completed-no-op / blocked]` | `[path or evidence]`      | `[result]` | `[0 / 0 / 0 / 0 / 0]`            | `[attempted]`     | `[exact error]` | `[missing prerequisite]` | `[next command]` |
| CJS-to-ESM package experiment                                     | `[completed / completed-no-op / blocked]` | `[path or evidence]`      | `[result]` | `[0 / 0 / 0 / 0 / 0]`            | `[attempted]`     | `[exact error]` | `[missing prerequisite]` | `[next command]` |
| splitChunks A/B                                                   | `[completed / completed-no-op / blocked]` | `[path or evidence]`      | `[result]` | `[0 / 0 / 0 / 0 / 0]`            | `[attempted]`     | `[exact error]` | `[missing prerequisite]` | `[next command]` |
| ECMA target experiment                                            | `[completed / completed-no-op / blocked]` | `[path or evidence]`      | `[result]` | `[0 / 0 / 0 / 0 / 0]`            | `[attempted]`     | `[exact error]` | `[missing prerequisite]` | `[next command]` |
| Post-loader source quality / compactness                          | `[completed / completed-no-op / blocked]` | `[path or evidence]`      | `[result]` | `[0 / 0 / 0 / 0 / 0]`            | `[attempted]`     | `[exact error]` | `[missing prerequisite]` | `[next command]` |

Candidate coverage must also be shown for every row as
`discovered / terminal / unresolved / applied / risk-found`. A generated
capture with unresolved candidates is not a completed check. The report input
must match the final fresh pass exactly.

HTML rendering contract:

- Follow `references/html-report-design.md` when converting this report to HTML.
- First screen must fit the raw-size headline, status summary, metric strip, and next action.
- Every optimization must appear in the overview table and in one detail card.
- Bind an optimization to an existing detail with `detailItemId`; otherwise let the renderer create its detail. Preserve status/classification, risk, evidence, and validation, and separate actionable `optimization` rows from diagnostic/no-op/rejected `experiment` rows.
- Detail cards must use this order: result -> why it changed -> evidence -> code snippet -> risk -> validation.
- Long code, raw tables, and export chains must be collapsible or linked to a drill-down page.
- Use raw size as the main visual metric; gzip is secondary.
- Keep paths, package names, exports, and snippets exact.
- Record `runId` in the core index and every lazy shard; reject mismatches instead of displaying stale evidence.
- Record core-index bytes, source-shard bytes, row count, delivery mode, and client cache limit. Use the local-only server when the budgets in `references/html-report-design.md` are exceeded.
- State that module/source-size sums are review scope, not removable bytes. Only production A/B emitted raw/gzip deltas count as savings.
- When an ECMA experiment crosses the materiality gate in `references/analysis-08-ecma.md`, show the baseline/experiment module counts, inventory-derived added and removed modules, retained source-map sources that shrank and grew, proven one-to-one module joins only, post-loader source differences, mapped/unmapped residual, and the agent's plain-language root-cause conclusion. An asset-total-only ECMA card is incomplete and must render the ECMA check as `blocked`.
- Before delivery, open the final rendered report at laptop and narrow viewports, exercise the required detail/source paths, capture screenshots, and write the hash-bound metadata from `references/html-report-design.md` into `<run-dir>/report/readability-review.md`. Run `node scripts/render-bundle-report.cjs --finalize-readability --out-dir <run-dir>/report`; only a manifest with `readabilityReview.status: "passed"`, `deliveryStatus: "ready"`, and `overallStatus: "complete"` represents a complete audit.

HTML performance evidence:

| Field                | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| Core index           | `[bytes and row count]`                                         |
| Detail/source shards | `[bytes and shard count]`                                       |
| Delivery mode        | `[small embedded file / local server with exact command]`       |
| Virtualization       | `[list threshold, rendered rows, source visible-line overscan]` |
| Search protection    | `[debounce, cancellation token, regex worker timeout]`          |
| Client cache         | `[LRU byte limit]`                                              |
| Privacy              | `[local-only / redacted publish copy]`                          |

## 1. One-Page Conclusion

| Question                     | Answer                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Production-comparable saving | `[appJs raw delta first, appJs gzip delta second, from minified build with concatenateModules on]` |
| Recommended next action      | `[specific source/config change to validate next]`                                                 |
| Highest-risk finding         | `[measured saving that needs runtime validation]`                                                  |
| Diagnostic-only finding      | `[useful lead that must not be counted as final saving]`                                           |
| Dominant cause               | `[one sentence root cause]`                                                                        |
| Stop / continue              | `[whether to keep investing in this route]`                                                        |

Decision:

`[Plain-language recommendation. State what should be productized, what should stay env-gated, and what should be investigated next.]`

## 2. Measurement Contract

Define terms before using them:

- `appJs`: `[business JavaScript files included in the product metric]`
- `raw`: `[uncompressed file size; primary metric for ranking, totals, and headline conclusions]`
- `gzip`: `[compressed transfer-size proxy; secondary metric, shown after raw unless the request is specifically about transfer size]`
- `minify`: `[JS compression step]`
- `concatenateModules`: `[Rspack module-merging optimization used in production]`
- `[other project-specific terms]`: `[plain-language definition]`

Metric priority:

Use `appJs raw` as the primary size metric. Sort opportunities by raw bytes saved and write headline totals as raw first, gzip second, for example `120.1 KB raw / 31.6 KB gzip`. Do not lead with gzip unless the user explicitly asks for download transfer-size analysis.

Only these cases count as production savings:

| Case           | minify | concatenateModules | Same entries/config/deps | Counts as saving | Purpose                     |
| -------------- | ------ | ------------------ | ------------------------ | ---------------- | --------------------------- |
| baseline       | true   | true               | yes                      | yes              | current production baseline |
| `[experiment]` | true   | true               | yes                      | yes/no           | `[why]`                     |

Diagnostic-only cases:

| Case                  | Why diagnostic-only        | What it can prove          |
| --------------------- | -------------------------- | -------------------------- |
| `[concat-off report]` | `[not a production build]` | `[source/root cause only]` |

### Resolved production optimization config

Read values from the fresh `optimization-config*.json` artifact captured from `compilation.options`; do not infer them from the author-written config.

| Option                                 | Resolved value | Version default | Provenance                                   | Status                              | Likely size impact | Evidence / next action             |
| -------------------------------------- | -------------- | --------------- | -------------------------------------------- | ----------------------------------- | ------------------ | ---------------------------------- |
| `optimization.usedExports`             | `[value]`      | `[default]`     | `[explicit / framework / default / unknown]` | `[ok / suspect / experiment / n/a]` | `[impact]`         | `[evidence and exact A/B command]` |
| `optimization.sideEffects`             | `[value]`      | `[default]`     | `[provenance]`                               | `[status]`                          | `[impact]`         | `[evidence / action]`              |
| `optimization.minimize` and minimizers | `[value]`      | `[default]`     | `[provenance]`                               | `[status]`                          | `[impact]`         | `[evidence / action]`              |
| `optimization.splitChunks`             | `[value]`      | `[default]`     | `[provenance]`                               | `[status]`                          | `[impact]`         | `[evidence / action]`              |

List every captured size-related option in the real report, not only the example rows above. Add each `suspect` or `experiment` row to the optimization overview and action queue; count bytes only after an isolated production A/B.

## 3. Result Classification

| Route     | Class                   |  appJs raw delta | appJs gzip delta | Count delta | Keep / reject / investigate |
| --------- | ----------------------- | ---------------: | ---------------: | ----------: | --------------------------- |
| `[route]` | production-ready saving |        `[bytes]` |        `[bytes]` |       `[n]` | `[decision]`                |
| `[route]` | high-risk saving        |        `[bytes]` |        `[bytes]` |       `[n]` | `[decision]`                |
| `[route]` | diagnostic-only finding | `[bytes or n/a]` | `[bytes or n/a]` |     `[n/a]` | `[decision]`                |

Class definitions:

- **Production-ready saving**: measured in a normal production build with minify and `concatenateModules` enabled, and the risk is understood.
- **High-risk saving**: measured in production mode, but runtime behavior, asset loading, or side effects still need validation.
- **Diagnostic-only finding**: useful for understanding why code is kept or large, but not counted as final product saving.

## 4. Optimization Cards

Repeat this section for every route that was tested.

### 4.x `[Route Name]`

Result:

| Metric         |  Baseline | Experiment |    Delta |
| -------------- | --------: | ---------: | -------: |
| appJs raw      | `[bytes]` |  `[bytes]` | `[diff]` |
| appJs gzip     | `[bytes]` |  `[bytes]` | `[diff]` |
| emittedJs raw  | `[bytes]` |  `[bytes]` | `[diff]` |
| emittedJs gzip | `[bytes]` |  `[bytes]` | `[diff]` |
| JS asset count |     `[n]` |      `[n]` | `[diff]` |
| Module count   |     `[n]` |      `[n]` | `[diff]` |

Classification: `[production-ready saving / high-risk saving / diagnostic-only finding]`

Why it changed:

`[Detailed explanation. Name the exact source pattern, module pattern, loader behavior, minifier behavior, or graph edge. Explain what existed in baseline, what changed in the experiment, which code/modules/assets disappeared or shrank, and why that changed final appJs raw first and gzip second. Do not use unexplained terms.]`

Evidence:

| Evidence                     | Before | After |    Delta | Explanation                          |
| ---------------------------- | -----: | ----: | -------: | ------------------------------------ |
| `[asset/module/export/root]` |  `[n]` | `[n]` | `[diff]` | `[why this supports the conclusion]` |

Code snippet:

```ts
// Keep this snippet short. It should show the exact source pattern or usage edge
// that explains the measured change.
```

If recommending a source rewrite, include current code and proposed code:

```ts
// current
```

```ts
// proposed
```

Risk:

`[Runtime, browser-support, side-effect, request-count, or correctness risk.]`

Validation:

`[Exact production build/report command and success condition.]`

Decision:

`[Keep, reject, investigate, or rerun with narrower scope.]`

## 5. ECMA Diagnostic Page

Use this page when an ECMA/target experiment ran. This page is a cause-analysis page, not a recommendation to raise browser support.

### 5.1 Materiality and delta reconciliation

Using unrounded bytes, compute `rawDelta = experiment - baseline` and `materialThreshold = min(51_200 B, baseline * 0.01)`. Treat either a win or regression as material when `abs(rawDelta) >= materialThreshold`. Also force deep attribution when logical-module identity/count, chunk membership, runtime, polyfills, or helpers change unexpectedly, even below that threshold. Record a project-specific override explicitly.

| Field                                      | Value                                |
| ------------------------------------------ | ------------------------------------ |
| Baseline / experiment target               | `[targets]`                          |
| Materiality threshold                      | `[default or explicit override]`     |
| Observed appJs raw delta                   | `[bytes and percent]`                |
| Deep attribution required                  | `[yes/no and why]`                   |
| Baseline / experiment module count         | `[n / n]`                            |
| Added / removed / retained modules         | `[n / n / n]`                        |
| Retained attributed sources shrunk / grown | `[n / n]`                            |
| Mapped source-attributed delta             | `[bytes]`                            |
| Runtime/helper/polyfill delta              | `[bytes]`                            |
| Unmapped residual                          | `[bytes and percent of asset delta]` |

Reconciliation:

`[Explain how the module-set, retained-source, runtime/helper/polyfill, and residual buckets add up to the measured emitted appJs raw delta. State any attribution tolerance.]`

Rspack stats `module.size` is diagnostic review scope, not minified emitted bytes. Use source-map or equivalent emitted-code attribution for the byte columns below, and label estimates explicitly.

### 5.2 Module-set changes

Removed modules:

| Removed module                     | One-to-one source-attributed bytes or n/a | Baseline chunks | Why it existed before                               | Why it disappeared                        |
| ---------------------------------- | ----------------------------------------: | --------------- | --------------------------------------------------- | ----------------------------------------- |
| `[core-js/helper/polyfill/module]` |                                 `[bytes]` | `[chunks]`      | `[which target, import, or transform pulled it in]` | `[why the experiment no longer needs it]` |

Added modules:

| Added module               | One-to-one source-attributed bytes or n/a | Experiment chunks | Why it appeared                                  | Impact on the net result                 |
| -------------------------- | ----------------------------------------: | ----------------- | ------------------------------------------------ | ---------------------------------------- |
| `[module/helper/polyfill]` |                                 `[bytes]` | `[chunks]`        | `[target, transform, graph, or chunking reason]` | `[why it offsets or changes the saving]` |

### 5.3 Retained attributed sources that shrank or grew

| Source-map source | Baseline attributed bytes | Experiment attributed bytes |    Delta | Direction        | Module join                                       | Suspected cause                                                                          |
| ----------------- | ------------------------: | --------------------------: | -------: | ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `[source path]`   |                 `[bytes]` |                   `[bytes]` | `[diff]` | `[shrunk/grown]` | `[one-to-one: module path / source-only: reason]` | `[syntax transform, helper, minifier, loader output, concatenation, chunk context, ...]` |

List both major shrinkers and major growers. Source-map attribution is per source, not automatically per module; show a module only for a demonstrably one-to-one join. A net reduction does not justify hiding sources or proven module joins that became larger.

### 5.4 Post-loader source comparison

Capture complete readable `module.originalSource()` output for the highest-impact removed modules and the top retained source rows whose join to a module is demonstrably one-to-one. For retained modules, compare both builds; for added or removed modules, preserve the available side and prove the graph/injection reason. Prioritize by source-attributed emitted-byte impact. Do not use a truncated preview as the comparison source.

| Module          | Baseline post-loader UTF-8 bytes/hash | Experiment post-loader UTF-8 bytes/hash | Loader output changed  | Relevant source difference                                 | Agent explanation                                        |
| --------------- | ------------------------------------: | --------------------------------------: | ---------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `[module path]` |  `[bytes/hash or unavailable reason]` |    `[bytes/hash or unavailable reason]` | `[yes/no/unavailable]` | `[syntax/helper/import/export difference, or "identical"]` | `[why this did or did not cause the emitted-byte delta]` |

Interpretation:

- Source changed: identify the responsible loader/plugin/target transform and explain the emitted consequence qualitatively; the combined A/B does not quantify the loader's byte share.
- Source is identical but attributed size changed: investigate parser/code generation, dependency templates, concatenation, minifier context, runtime helpers, or chunk placement instead of blaming the loader.
- Module was removed: trace the graph, condition, or polyfill/helper injection rule that removed it.
- A trustworthy source comparison is still unavailable after retries: mark ECMA attribution `blocked`, record every attempted command and exact failure, and do not publish the material saving as an explained headline.

### 5.5 Agent root-cause conclusion

Dominant cause:

`[State whether the result comes primarily from fewer modules, retained attributed sources shrinking/growing, loader-output changes, later code generation/minification, or a combination. Name the top contributors and explain countervailing growth.]`

Confidence and remaining uncertainty:

`[High/medium/low, the evidence supporting it, the unmapped residual, and the exact next action needed to close any gap.]`

Snippet:

```ts
// source or generated-code snippet showing the expensive pattern
```

### 5.6 No-ECMA-change rewrite candidates

| Priority | Module   | Current pattern | Proposed bypass                     | Expected validation         |
| -------- | -------- | --------------- | ----------------------------------- | --------------------------- |
| P0       | `[path]` | `[pattern]`     | `[rewrite without changing target]` | `[production build metric]` |

## 6. Export Usage / Root Cause Page

Use this page when export-usage analysis ran.

| Metric                                                |       Value |
| ----------------------------------------------------- | ----------: |
| Export records                                        |       `[n]` |
| Records with concrete chains                          |       `[n]` |
| Chain coverage                                        | `[percent]` |
| Unique terminal roots                                 |       `[n]` |
| Whole-module import causes (`usedExports:true` leads) |       `[n]` |
| Capped/incomplete chains                              |       `[n]` |

Top roots:

| Root            | Impacted exports | Category     | Verdict     | Why it keeps exports alive |
| --------------- | ---------------: | ------------ | ----------- | -------------------------- |
| `[root module]` |            `[n]` | `[category]` | `[verdict]` | `[plain-language reason]`  |

Representative chain:

```text
[entry/root] -> [consumer] -> [target export]
```

Source snippet:

```ts
// dependency/specifier location or fallback export declaration
```

Whole-module import causes:

| Provider module                  | Consumer import site | Request     | Loc     | Code snippet                                                              | Rewrite                                                                                                   |
| -------------------------------- | -------------------- | ----------- | ------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `[module with usedExports:true]` | `[consumer module]`  | `[request]` | `[loc]` | `[short snippet at consumer loc; label disk fallback if not post-loader]` | `[move named destructuring/member access to import site, split helper, or keep if genuine namespace use]` |

For HTML output, the whole-module import-cause section must link to or render an expanded source viewer for the consumer module. Do not rely only on a tiny table snippet when the reader needs to inspect surrounding code.

## 7. Action Queue

| Priority | Action              |          Expected upside | Risk                | Validation         | Owner area        |
| -------- | ------------------- | -----------------------: | ------------------- | ------------------ | ----------------- |
| P0       | `[specific change]` | `[bytes or qualitative]` | `[low/medium/high]` | `[command/report]` | `[module/config]` |
| P1       | `[specific change]` | `[bytes or qualitative]` | `[low/medium/high]` | `[command/report]` | `[module/config]` |

## 8. Residuals and Stopping Point

- Remaining candidates: `[what remains]`
- Why not continue this route now: `[reason]`
- What would change the decision: `[new evidence required]`

## 9. Appendix

Raw artifact paths:

- `[path]`
- `[path]`

Failed or diagnostic-only experiments:

| Experiment | Result              | Why excluded from headline |
| ---------- | ------------------- | -------------------------- |
| `[name]`   | `[success/failure]` | `[reason]`                 |

Data-quality limits:

- `[missing source, capped chains, non-production build, estimated attribution, etc.]`
