# Analysis 08: ECMA Target Cost

## Purpose

Temporarily raise the transform and minifier output levels together to expose old-browser conversion costs. Treat the result as optimization potential and a source-rewrite guide, not as permission to change supported browsers.

## Identify Both Stages

Inspect the real project configuration:

- SWC/Babel/esbuild transform target;
- SWC/Terser/esbuild minifier output target;
- browserslist and nested loader rules such as SVG transforms;
- polyfill mode and helper/runtime injection.

Do not introduce a second transformer. SWC `jsc.target` and `env` are mutually exclusive; update the project's existing control point.

## Isolated Comparison

Choose a concrete comparison target such as ES2022. Change only:

1. every applicable loader/transform target;
2. minifier compress and format/output ECMA targets.

Keep entries, dependencies, features, splitChunks, mangle/compress passes, sideEffects, usedExports, and concatenation unchanged.

Verify before measuring:

- readable pre-minify output retains expected modern syntax;
- final output also retains it;
- downlevel helpers such as regenerator, async/class/spread helpers, and injected polyfill counts change as expected.

If the configured target did not actually reach both stages, repair the experiment rather than interpreting the bytes.

## Generated-Byte Attribution

Run:

```bash
node scripts/sourcemap-generated-byte-attribution.cjs \
  --baseline-dir <run>/baseline/dist \
  --experiment-dir <run>/ecma/dist \
  --project-root <project-root> \
  --out <run>/ecma/generated-byte-attribution.json
```

The script resolves project-local `@jridgewell/trace-mapping`, attributes generated segments to source files, and emits:

- common retained, retained shrunk, retained grown;
- removed from app JS and added to app JS;
- mapped and unmapped bytes per asset and source.

Keep emitted asset raw/gzip totals as the headline. Sourcemap attribution explains the delta; it does not replace it.

## Re-verify Large Wins

Compare module presence, used exports, retained side-effect modules, entry/chunk membership, and polyfill/helper counts. Separate:

- retained modules shortened by output shape;
- helpers/polyfills removed from app JS;
- added or grown offsets.

Do not describe a win as module removal when retained-source compaction dominates.

## No-Target-Change Rewrites

For top contributors, inspect source and propose local rewrites that preserve production browser support, for example:

- direct Promise returns instead of trivial async wrappers;
- narrower or hoisted repeated optional chains;
- avoiding repeated spread in large constructors;
- moving APIs that trigger polyfills into an existing lazy boundary.

Each rewrite remains a hypothesis until a normal production A/B proves emitted raw/gzip reduction.

If production already uses the comparison target at both stages, record evidence-backed `completed-no-op`. Missing sourcemaps or attribution capability is `blocked`, not zero impact.
