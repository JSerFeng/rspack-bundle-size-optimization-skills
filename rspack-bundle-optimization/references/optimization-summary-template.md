# Bundle Optimization Summary

Generated from:
- `[baseline-summary.json]`
- `[round1-summary.json]`
- `[round2-summary.json]`
- `[chunk-group-reachability.json]`

Build commands:
- Baseline: `[analysis-only build command]`
- Experiment: `[analysis + sideEffects experiment build command]`

Implementation:
- Analysis plugin: `[path]`
- Build config hook: `[path]`
- Env switches: `[path]`
- Latest report: `[path]`

Method:
- `[baseline capture rule]`
- `[candidate filter rule — note: run with concatenateModules:false to find ESM candidates]`
- `[side-effects experiment rule]`
- `[candidate accumulation rule]`
- `[splitChunks tuning rule — remove name, add minSize:0]`

## Baseline

- Retained unused JS modules: `[number]`
- Retained unused JS modules with any optimization bailout: `[number]`
- Retained unused JS modules with side-effect bailout: `[number]`
- Unique candidate resources: `[number]`
- Emitted JS assets: `[number]`
- Emitted JS asset size sum: `[bytes]`
- Entrypoint (首屏) chunk group size: `[bytes]`

## Side Effects Experiment

Round 1:
- Retained unused JS modules: `[number]`
- Retained unused JS modules with side-effect bailout: `[number]`
- Accumulated candidate resources: `[number]`
- Emitted JS assets: `[number]`
- Emitted JS asset size sum: `[bytes]`
- Delta vs baseline: `[bytes]` (`[percent]%`)

Round 2:
- Retained unused JS modules: `[number]`
- Retained unused JS modules with side-effect bailout: `[number]`
- Accumulated candidate resources: `[number]`
- Emitted JS assets: `[number]`
- Emitted JS asset size sum: `[bytes]`
- Delta vs baseline: `[bytes]` (`[percent]%`)

## Chunk Group Reachability

- Total chunk groups: `[number]`
- Async chunk groups with removable modules: `[number]`
- Total removable JS size (across async groups): `[bytes]`
- Removable module categories: `[e.g., core-js/internals, @swc/helpers]`
- Root cause: `[e.g., SWC polyfill injection via env.mode:"usage" in SVG loader]`

## SplitChunks Tuning (remove name + minSize:0)

| Metric | Baseline | Optimized | Diff |
|--------|----------|-----------|------|
| Emitted JS | `[bytes]` | `[bytes]` | `[diff bytes]` (`[percent]%`) |
| Entrypoint size | `[bytes]` | `[bytes]` | `[diff bytes]` (`[percent]%`) |
| Unique chunks | `[number]` | `[number]` | `[diff]` |
| Groups with removable | `[number]` | `[number]` | |
| Sum of group sizes | `[bytes]` | `[bytes]` | `[diff bytes]` (`[percent]%`) |
| Groups decreased | | `[number]` | |
| Groups increased | | `[number]` | |

## CJS-to-ESM Package Size Diff

Generated from:
- Baseline stats: `[baseline-stats.json]`
- Experiment stats: `[cjs2esm-stats.json]`
- Loader report: `[cjs2esm-loader-report.jsonl]`
- Package diff: `[cjs2esm-package-size-diff.json]`

Overall:
- Transformed modules: `[number]`
- Skipped modules: `[number]`
- Packages with transforms: `[number]`
- Packages with measured shrink: `[number]`
- Total module-size delta: `[bytes]` (`[percent]%` vs touched package baseline)
- Total attributed emitted raw delta: `[bytes]` (`estimated`)
- Total attributed emitted gzip delta: `[bytes]` (`estimated`)

Top package deltas:

| Package | Transformed | Skipped | Module Delta | Module % | Attributed Raw Delta | Attributed Gzip Delta | Notes |
|---------|------------:|--------:|-------------:|---------:|---------------------:|----------------------:|-------|
| `[pkg@version]` | `[n]` | `[n]` | `[bytes]` | `[percent]%` | `[bytes]` | `[bytes]` | `[safe/unsafe/residual]` |

Interpretation rules:
- Treat `moduleSizeDelta` as the package-level ranking signal because it comes directly from stats module sizes.
- Treat attributed emitted raw/gzip deltas as estimates because assets are distributed to packages by chunk module-size share.
- If a package has transformed modules but no `moduleSizeDelta`, do not claim it produced bundle-size gain; it only changed syntax shape or enabled a later hypothesis.

## Stopping Point

- `[what remains]`
- `[why this route is exhausted or not]`

## Risk

- `[high-risk candidate classes]`
- `[runtime validation warning]`

## Conclusion

- `[final gain statement for side effects]`
- `[final gain statement for splitChunks tuning]`
- `[dominant remaining problem]`
