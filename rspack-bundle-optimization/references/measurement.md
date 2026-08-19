# Measurement

## Choose what to measure

Name the compiler or output directory and the exact asset set for every
measurement. Keep these scopes distinct when they apply:

- `total emitted`: all selected JavaScript emitted by one compiler;
- `HTML-requested initial`: JavaScript requested by the initial document,
  including relevant preload or modulepreload requests;
- `entrypoint initial`: JavaScript Rspack marks as initial for a named entry;
- `static route group`: JavaScript in a named route or async chunk group;
- `browser-observed route`: additional JavaScript requested during a named
  navigation or interaction;
- a narrower application-specific set, defined by an explicit manifest and
  its exclusions.

HTML-requested and entrypoint-initial assets can differ; report both instead
of treating either as the universal meaning of “initial.” Count a shared asset
once inside each scope. Keep different compilers or output directories
separate, and sum them only when their assets do not overlap and the user wants
one project-wide total.

Preserve the exact included asset names. Do not silently use every `.js` file
when the intended product metric is narrower. Use compiler data for a static
route group and browser network data for what a route actually requested.

## Capture

Measure an output directory with either an explicit asset manifest or an
explicit regular expression:

```bash
node <skill>/scripts/measure-assets.cjs \
  --dir <unchanged-dist> \
  --manifest <app-js-assets.json> \
  --run-id <run-id> \
  --label unchanged-app-js \
  --out <run>/unchanged-app-js-measurement.json
```

The output contains:

- normalized asset names;
- SHA-256;
- raw bytes;
- deterministic per-asset gzip bytes using level 9;
- summed totals;
- the exact inclusion rule.

The script only calculates bytes. The agent decides whether the difference
matters, what caused it, and whether the change is safe.

## Compare

```bash
node <skill>/scripts/measure-assets.cjs compare \
  --baseline <run>/unchanged-app-js-measurement.json \
  --experiment <run>/changed-app-js-measurement.json \
  --out <run>/app-js-comparison.json
```

The two option names above are part of the existing command-line interface.
In analysis and reports, call their inputs the unchanged production build and
the changed production build.

The output lists the byte difference and which assets were added, removed, or
changed. The agent must decide whether the builds are comparable and explain
the cause.

Only whole-asset raw and gzip totals are exact. A breakdown by module or
package may be directly mapped or approximate; use it to locate likely
contributors, not as a replacement for the asset total. Rank contributions
inside one compiler and one named asset set, state which size source was used,
and count each emitted copy separately. Mark the result approximate when shared
or concatenated modules cannot be separated reliably. Group packages by
resolved package root and version, and compare only rankings calculated from
the same kind of size. Do not add per-module gzip estimates as though they
equal the asset's gzip total.

## Keep production settings the same

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
Fewer bytes or requests do not by themselves prove a faster user experience.
Make a performance claim only when a named metric was measured under the same
conditions.

## What does not count as confirmed savings

- disk source size;
- source size after loaders;
- stats module size;
- a non-production build with minimization or concatenation disabled;
- a size estimate from a browser-support target change that is not authorized
  for production;
- an estimated cause that was not verified;
- a changed asset set whose runtime behavior is unexplained.
