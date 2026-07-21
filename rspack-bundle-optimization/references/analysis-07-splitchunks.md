# Analysis 07: splitChunks A/B

## Purpose

Measure whether chunk grouping makes a page or async block load code it does not need. This changes loading boundaries, not tree shaking.

## Preconditions

Inspect the current `splitChunks` config and Analysis 01 output. A valid target requires evidence such as:

- a fixed `cacheGroups.*.name` shared by unrelated async groups;
- reachability showing removable members caused by shared fan-in;
- a large shared chunk loaded by routes that need different subsets.

If no fixed-name/fan-in target exists, record the config and reachability evidence as `completed-no-op`. Do not invent a cache group merely to run an experiment.

## Experiment A: Fixed Name Only

Remove only the selected fixed `cacheGroup.name`. Preserve:

- `chunks`, `test`, `priority`, `minSize`, `minSizeReduction`, and `minChunks`;
- request limits, `enforceSizeThreshold`, `enforce`, and `reuseExistingChunk`;
- every other cache group and entry setting.

Build in an isolated output and compare:

- emitted JS raw/gzip total;
- entrypoint and every affected async-group JS total;
- chunks and request counts;
- duplicate module bytes;
- groups with unreachable JS-like members;
- asset/chunk name and cacheability changes.

## Follow-Up Knobs

Only after Experiment A identifies a separate bottleneck, test one follow-up variable per build:

- targeted `minSize` or `minSizeReduction` when extraction thresholds cause duplication;
- targeted `enforceSizeThreshold` when request limits block a measured candidate;
- `maxSize` when the problem is an intentionally shared but oversized chunk.

Do not combine a name change with threshold/request changes in one headline result.

## Interpretation and Risk

- Lower per-route bytes with flat or larger emitted total is a loading tradeoff, not global tree shaking.
- More chunks increase request and cache-management cost.
- Fixed names may intentionally improve cache stability.
- Extracted CSS can have different grouping/order semantics; measure it separately.

Keep only results whose route-level benefit, global bytes, request count, and runtime behavior are all understood.

## Required Artifacts

- baseline and each single-variable config diff
- per-asset and per-group size comparison
- request/chunk/duplication comparison
- refreshed reachability and chunk graph
- decision with runtime validation command

## Completion Gate

Review every reachability-backed cache-group target and every tested knob as a
separate candidate. A size win with changed requests, loading order, cache
behavior, route membership, or CSS grouping has residual risk and must not be
promoted without route/runtime evidence that clears each point. After an
accepted change, refresh the baseline, reachability, chunk graph, and all later
checks in a new pass.
