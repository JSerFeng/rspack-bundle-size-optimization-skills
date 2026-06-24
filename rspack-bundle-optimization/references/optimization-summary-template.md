# Bundle Optimization Decision Report

Generated from:
- Baseline summary: `[baseline-summary.json]`
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

## 1. One-Page Conclusion

| Question | Answer |
| --- | --- |
| Production-comparable saving | `[appJs raw/gzip delta from minified build with concatenateModules on]` |
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
- `raw`: `[uncompressed file size]`
- `gzip`: `[compressed transfer-size proxy]`
- `minify`: `[JS compression step]`
- `concatenateModules`: `[Rspack module-merging optimization used in production]`
- `[other project-specific terms]`: `[plain-language definition]`

Only these cases count as production savings:

| Case | minify | concatenateModules | Same entries/config/deps | Counts as saving | Purpose |
| --- | --- | --- | --- | --- | --- |
| baseline | true | true | yes | yes | current production baseline |
| `[experiment]` | true | true | yes | yes/no | `[why]` |

Diagnostic-only cases:

| Case | Why diagnostic-only | What it can prove |
| --- | --- | --- |
| `[concat-off report]` | `[not a production build]` | `[source/root cause only]` |

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

`[Detailed explanation. Name the exact source pattern, module pattern, loader behavior, minifier behavior, or graph edge. Explain what existed in baseline, what changed in the experiment, which code/modules/assets disappeared or shrank, and why that changed final appJs raw/gzip. Do not use unexplained terms.]`

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
