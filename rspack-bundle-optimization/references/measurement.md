# Measurement

## Scope

Define every measured asset set explicitly. At minimum, distinguish:

- total emitted JavaScript;
- application JavaScript, if different;
- initial JavaScript;
- important route or async-group JavaScript when relevant.

Preserve the exact included asset names. Do not silently use every `.js` file
when the intended product metric is narrower.

## Capture

Measure an output directory with either an explicit asset manifest or an
explicit regular expression:

```bash
node <skill>/scripts/measure-assets.cjs \
  --dir <baseline-dist> \
  --manifest <app-js-assets.json> \
  --run-id <run-id> \
  --label baseline-app-js \
  --out <run>/baseline/app-js-measurement.json
```

The output contains:

- normalized asset names;
- SHA-256;
- raw bytes;
- deterministic per-asset gzip bytes using level 9;
- summed totals;
- the exact inclusion rule.

The script does not call a delta good, bad, material, safe, or actionable.

## Compare

```bash
node <skill>/scripts/measure-assets.cjs compare \
  --baseline <run>/baseline/app-js-measurement.json \
  --experiment <run>/experiments/example/app-js-measurement.json \
  --out <run>/experiments/example/app-js-comparison.json
```

The comparison contains arithmetic deltas and asset-set differences. The agent
must decide whether the builds are comparable and what caused the change.

## Production comparability

Hold constant:

- entries and features;
- dependency and lockfile state;
- unrelated environment flags;
- minimization and mangling;
- concatenation;
- splitChunks and runtime settings, unless one of them is the tested variable;
- asset inclusion rule.

Use raw bytes as the primary bundle-size metric and gzip second. Request count,
initial/route bytes, cache behavior, and CSS may be separate product metrics.

## What does not count as confirmed savings

- disk source size;
- post-loader source size;
- stats module size;
- a diagnostic build with minimization or concatenation disabled;
- a browser-target upper bound not authorized for production;
- predicted attribution;
- a changed asset set whose runtime behavior is unexplained.
