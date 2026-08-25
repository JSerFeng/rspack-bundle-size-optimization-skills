# Measurement

## Define each asset scope

Name the compiler or output directory and exact asset set for every result:

- `total emitted`: all selected JavaScript emitted by one compiler;
- `HTML-requested initial`: JavaScript requested by the initial document,
  including relevant preload and modulepreload requests;
- `entrypoint initial`: JavaScript Rspack marks initial for a named entry;
- `static route group`: JavaScript in a named route or async chunk group;
- `browser-observed route`: additional JavaScript requested during a named
  navigation or interaction;
- an application-specific set defined by an explicit manifest and exclusions.

HTML-requested and entrypoint-initial sets can differ, so report both when they
matter. Count a shared asset once within each scope. Keep compilers and output
directories separate; create a project-wide sum only from non-overlapping
assets when that aggregate answers the user's question.

Preserve the included asset names with the measurement. Use compiler data for
a static route group and browser network data for observed route loading.

## Capture

Measure with an explicit asset manifest or regular expression:

```bash
node <skill>/scripts/measure-assets.cjs \
  --dir <unchanged-dist> \
  --manifest <app-js-assets.json> \
  --run-id <run-id> \
  --label unchanged-app-js \
  --out <run>/unchanged-app-js-measurement.json
```

The output records normalized names, SHA-256, raw bytes, deterministic level-9
gzip bytes, totals, and the exact inclusion rule.

## Compare

```bash
node <skill>/scripts/measure-assets.cjs compare \
  --baseline <run>/unchanged-app-js-measurement.json \
  --experiment <run>/changed-app-js-measurement.json \
  --out <run>/app-js-comparison.json
```

`--baseline` and `--experiment` are command-line option names. In analysis,
call them the unchanged and changed production builds. The comparison records
the total delta and added, removed, and changed assets.

Whole-asset raw and gzip totals are exact. Module and package breakdowns are
diagnostic rankings: state their size source, count every emitted copy, group
packages by resolved root and version, and label shared or concatenated
attribution as approximate. Compare rankings derived from the same size kind.

## Comparable production conditions

Hold these constant around the intended variable:

- entries, features, dependency and lockfile state;
- unrelated environment flags;
- minimization, mangling, and concatenation;
- splitChunks and runtime settings;
- asset inclusion rule.

Report raw bytes as the primary bundle metric and gzip second. Treat request
count, initial/route bytes, cache behavior, CSS, and named performance metrics
as separate results.

## Evidence threshold

A confirmed saving is a comparable production whole-asset difference in the
intended scope, supported by an emitted-output explanation and applicable
correctness checks. Source size, post-loader size, Stats module size,
production-debug output, and per-module gzip attribution remain diagnostic or
estimated evidence. A user-facing speed claim additionally requires the named
performance metric under matching conditions.
