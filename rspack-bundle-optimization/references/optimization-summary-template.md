# Bundle Optimization Decision Report

Generated from:
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
- Exports usage HTML: `[exports usage / exports info usage html path, or "not generated: rerun Export Usage Roots"]`
- Export source confirmation HTML: `[source confirmation html path, or "not generated"]`
- Chunk graph HTML: `[chunk graph html path, or "not generated"]`

Related analysis pages:

| Page | Link / path | Why it matters |
| --- | --- | --- |
| Exports usage analysis | `[relative link to exports usage HTML]` | Shows who keeps each export alive, including root module, chain, and source location. |
| Export source confirmation | `[relative link to source confirmation HTML]` | Shows code snippets and highlighted usage locations for export-chain claims. |
| Chunk graph | `[relative link to chunk graph HTML]` | Shows async/shared JS loading relationships. |
| Raw data | `[JSON/Markdown paths]` | Lets reviewers audit the numbers behind this summary. |

Mandatory audit coverage:

| Check | State | Fresh artifact / evidence | Result | Attempted or next command |
| --- | --- | --- | --- | --- |
| Production baseline / resolved optimization config / quick triage | `[completed / completed-no-op / blocked]` | `[paths or evidence]` | `[result]` | `[command]` |
| Chunk-group reachability | `[completed / completed-no-op / blocked]` | `[path or evidence]` | `[result]` | `[command]` |
| Retained unused modules | `[completed / completed-no-op / blocked]` | `[path or evidence]` | `[result]` | `[command]` |
| Side-effects A/B | `[completed / completed-no-op / blocked]` | `[path or evidence]` | `[result]` | `[command]` |
| Export usage roots + post-loader confirmation | `[completed / completed-no-op / blocked]` | `[path or evidence]` | `[result]` | `[command]` |
| Rollup-vs-Rspack export diff | `[completed / completed-no-op / blocked]` | `[path or evidence]` | `[result]` | `[command]` |
| CJS-to-ESM package experiment | `[completed / completed-no-op / blocked]` | `[path or evidence]` | `[result]` | `[command]` |
| splitChunks A/B | `[completed / completed-no-op / blocked]` | `[path or evidence]` | `[result]` | `[command]` |
| ECMA target experiment | `[completed / completed-no-op / blocked]` | `[path or evidence]` | `[result]` | `[command]` |
| Post-loader source quality / compactness | `[completed / completed-no-op / blocked]` | `[path or evidence]` | `[result]` | `[command]` |

HTML rendering contract:

- Follow `references/html-report-design.md` when converting this report to HTML.
- First screen must fit the raw-size headline, status summary, metric strip, and next action.
- Every optimization must appear in the overview table and in one detail card.
- Detail cards must use this order: result -> why it changed -> evidence -> code snippet -> risk -> validation.
- Long code, raw tables, and export chains must be collapsible or linked to a drill-down page.
- Use raw size as the main visual metric; gzip is secondary.
- Keep paths, package names, exports, and snippets exact.
- Record `runId` in the core index and every lazy shard; reject mismatches instead of displaying stale evidence.
- Record core-index bytes, source-shard bytes, row count, delivery mode, and client cache limit. Use the local-only server when the budgets in `references/html-report-design.md` are exceeded.
- State that module/source-size sums are review scope, not removable bytes. Only production A/B emitted raw/gzip deltas count as savings.

HTML performance evidence:

| Field | Value |
| --- | --- |
| Core index | `[bytes and row count]` |
| Detail/source shards | `[bytes and shard count]` |
| Delivery mode | `[small embedded file / local server with exact command]` |
| Virtualization | `[list threshold, rendered rows, source visible-line overscan]` |
| Search protection | `[debounce, cancellation token, regex worker timeout]` |
| Client cache | `[LRU byte limit]` |
| Privacy | `[local-only / redacted publish copy]` |

## 1. One-Page Conclusion

| Question | Answer |
| --- | --- |
| Production-comparable saving | `[appJs raw delta first, appJs gzip delta second, from minified build with concatenateModules on]` |
| Recommended next action | `[specific source/config change to validate next]` |
| Highest-risk finding | `[measured saving that needs runtime validation]` |
| Diagnostic-only finding | `[useful lead that must not be counted as final saving]` |
| Dominant cause | `[one sentence root cause]` |
| Stop / continue | `[whether to keep investing in this route]` |

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

| Case | minify | concatenateModules | Same entries/config/deps | Counts as saving | Purpose |
| --- | --- | --- | --- | --- | --- |
| baseline | true | true | yes | yes | current production baseline |
| `[experiment]` | true | true | yes | yes/no | `[why]` |

Diagnostic-only cases:

| Case | Why diagnostic-only | What it can prove |
| --- | --- | --- |
| `[concat-off report]` | `[not a production build]` | `[source/root cause only]` |

### Resolved production optimization config

Read values from the fresh `optimization-config*.json` artifact captured from `compilation.options`; do not infer them from the author-written config.

| Option | Resolved value | Version default | Provenance | Status | Likely size impact | Evidence / next action |
| --- | --- | --- | --- | --- | --- | --- |
| `optimization.usedExports` | `[value]` | `[default]` | `[explicit / framework / default / unknown]` | `[ok / suspect / experiment / n/a]` | `[impact]` | `[evidence and exact A/B command]` |
| `optimization.sideEffects` | `[value]` | `[default]` | `[provenance]` | `[status]` | `[impact]` | `[evidence / action]` |
| `optimization.minimize` and minimizers | `[value]` | `[default]` | `[provenance]` | `[status]` | `[impact]` | `[evidence / action]` |
| `optimization.splitChunks` | `[value]` | `[default]` | `[provenance]` | `[status]` | `[impact]` | `[evidence / action]` |

List every captured size-related option in the real report, not only the example rows above. Add each `suspect` or `experiment` row to the optimization overview and action queue; count bytes only after an isolated production A/B.

## 3. Result Classification

| Route | Class | appJs raw delta | appJs gzip delta | Count delta | Keep / reject / investigate |
| --- | --- | ---: | ---: | ---: | --- |
| `[route]` | production-ready saving | `[bytes]` | `[bytes]` | `[n]` | `[decision]` |
| `[route]` | high-risk saving | `[bytes]` | `[bytes]` | `[n]` | `[decision]` |
| `[route]` | diagnostic-only finding | `[bytes or n/a]` | `[bytes or n/a]` | `[n/a]` | `[decision]` |

Class definitions:

- **Production-ready saving**: measured in a normal production build with minify and `concatenateModules` enabled, and the risk is understood.
- **High-risk saving**: measured in production mode, but runtime behavior, asset loading, or side effects still need validation.
- **Diagnostic-only finding**: useful for understanding why code is kept or large, but not counted as final product saving.

## 4. Optimization Cards

Repeat this section for every route that was tested.

### 4.x `[Route Name]`

Result:

| Metric | Baseline | Experiment | Delta |
| --- | ---: | ---: | ---: |
| appJs raw | `[bytes]` | `[bytes]` | `[diff]` |
| appJs gzip | `[bytes]` | `[bytes]` | `[diff]` |
| emittedJs raw | `[bytes]` | `[bytes]` | `[diff]` |
| emittedJs gzip | `[bytes]` | `[bytes]` | `[diff]` |
| JS asset count | `[n]` | `[n]` | `[diff]` |
| Module count | `[n]` | `[n]` | `[diff]` |

Classification: `[production-ready saving / high-risk saving / diagnostic-only finding]`

Why it changed:

`[Detailed explanation. Name the exact source pattern, module pattern, loader behavior, minifier behavior, or graph edge. Explain what existed in baseline, what changed in the experiment, which code/modules/assets disappeared or shrank, and why that changed final appJs raw first and gzip second. Do not use unexplained terms.]`

Evidence:

| Evidence | Before | After | Delta | Explanation |
| --- | ---: | ---: | ---: | --- |
| `[asset/module/export/root]` | `[n]` | `[n]` | `[diff]` | `[why this supports the conclusion]` |

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

### 5.1 What disappeared

| Removed module | Removed bytes | Why it existed before | Why it disappeared |
| --- | ---: | --- | --- |
| `[core-js/helper/polyfill module]` | `[bytes]` | `[which old-browser compatibility need pulled it in]` | `[why higher target no longer needs it]` |

### 5.2 What stayed but got smaller

| Source module | Before bytes | After bytes | Delta | Expensive source pattern |
| --- | ---: | ---: | ---: | --- |
| `[module path]` | `[bytes]` | `[bytes]` | `[diff]` | `[async/await, optional chain, spread, class field, ...]` |

Detailed explanation:

`[Explain how this source pattern is converted for the current browser target, why that conversion is longer, and whether the same gain might be recoverable by local source changes.]`

Snippet:

```ts
// source or generated-code snippet showing the expensive pattern
```

### 5.3 No-ECMA-change rewrite candidates

| Priority | Module | Current pattern | Proposed bypass | Expected validation |
| --- | --- | --- | --- | --- |
| P0 | `[path]` | `[pattern]` | `[rewrite without changing target]` | `[production build metric]` |

## 6. Export Usage / Root Cause Page

Use this page when export-usage analysis ran.

| Metric | Value |
| --- | ---: |
| Export records | `[n]` |
| Records with concrete chains | `[n]` |
| Chain coverage | `[percent]` |
| Unique terminal roots | `[n]` |
| Whole-module import causes (`usedExports:true` leads) | `[n]` |
| Capped/incomplete chains | `[n]` |

Top roots:

| Root | Impacted exports | Category | Verdict | Why it keeps exports alive |
| --- | ---: | --- | --- | --- |
| `[root module]` | `[n]` | `[category]` | `[verdict]` | `[plain-language reason]` |

Representative chain:

```text
[entry/root] -> [consumer] -> [target export]
```

Source snippet:

```ts
// dependency/specifier location or fallback export declaration
```

Whole-module import causes:

| Provider module | Consumer import site | Request | Loc | Code snippet | Rewrite |
| --- | --- | --- | --- | --- | --- |
| `[module with usedExports:true]` | `[consumer module]` | `[request]` | `[loc]` | `[short snippet at consumer loc; label disk fallback if not post-loader]` | `[move named destructuring/member access to import site, split helper, or keep if genuine namespace use]` |

For HTML output, the whole-module import-cause section must link to or render an expanded source viewer for the consumer module. Do not rely only on a tiny table snippet when the reader needs to inspect surrounding code.

## 7. Action Queue

| Priority | Action | Expected upside | Risk | Validation | Owner area |
| --- | --- | ---: | --- | --- | --- |
| P0 | `[specific change]` | `[bytes or qualitative]` | `[low/medium/high]` | `[command/report]` | `[module/config]` |
| P1 | `[specific change]` | `[bytes or qualitative]` | `[low/medium/high]` | `[command/report]` | `[module/config]` |

## 8. Residuals and Stopping Point

- Remaining candidates: `[what remains]`
- Why not continue this route now: `[reason]`
- What would change the decision: `[new evidence required]`

## 9. Appendix

Raw artifact paths:

- `[path]`
- `[path]`

Failed or diagnostic-only experiments:

| Experiment | Result | Why excluded from headline |
| --- | --- | --- |
| `[name]` | `[success/failure]` | `[reason]` |

Data-quality limits:

- `[missing source, capped chains, non-production build, estimated attribution, etc.]`
