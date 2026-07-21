# Analysis 06: Conservative CJS-to-ESM Experiment

## Purpose

Estimate package-patch upside when transpiled static CommonJS becomes real ESM. This loader is diagnostic and env-gated; it must not edit `node_modules` or become production behavior without runtime validation.

## Loader Setup

Use `scripts/transpiled-cjs-to-esm-loader.cjs` before the normal JS transformer for a targeted package or candidate set:

```js
{
  test: /\.js$/,
  include: confirmedPackagePaths,
  use: [{
    loader: '<skill>/scripts/transpiled-cjs-to-esm-loader.cjs',
    options: {
      reportPath: '<run>/cjs2esm/loader-report.jsonl',
      projectRoot: '<project-root>'
    }
  }]
}
```

The loader resolves project-local `@swc/core`, parses the module, transforms only supported static transpiled-CJS shapes, and returns unchanged source with a skip reason for anything ambiguous.

## Eligibility and Guardrails

Require a recognizable `__esModule` marker and static top-level patterns. Supported transformations may include:

- top-level static `require()` bindings to imports;
- static `__exportStar(require("x"), exports)` to `export *`;
- `exports.name = localIdentifier` to a named export;
- `exports.default = localIdentifier` to a default export.

Skip the entire module when it contains dynamic/conditional/computed require, `module.exports`, computed or late export mutation, reassignment that changes semantics, top-level `this`, or an unsupported AST shape. Do not force the module type to `javascript/esm`; allow Rspack parser inference.

## Measurement

Use separate baseline and experiment outputs with the same production settings. Capture stats with assets, chunks, modules, nested modules, used/provided exports, and optimization bailouts.

Run:

```bash
node scripts/cjs2esm-package-size-diff.cjs \
  --baseline-stats <run>/baseline/stats.json \
  --experiment-stats <run>/cjs2esm/stats.json \
  --loader-report <run>/cjs2esm/loader-report.jsonl \
  --baseline-dist <run>/baseline/dist \
  --experiment-dist <run>/cjs2esm/dist \
  --out <run>/cjs2esm/package-size-diff.json \
  --markdown-out <run>/cjs2esm/package-size-diff.md
```

Report every touched npm package and every changed package:

- version, transformed count, skipped count, and skip reasons;
- stats `moduleSizeDelta` for direct package ranking;
- estimated attributed emitted raw/gzip delta, explicitly labeled estimated;
- actual overall emitted raw/gzip delta and changed assets.

Many transformed modules with no emitted reduction is not an optimization. Confirm that transformed source reached Rspack and inspect remaining side effects, namespace use, barrels, and concatenation.

An eligibility scan with zero safely transformable modules is `completed-no-op`. Missing SWC or a loader failure is `blocked`.

## Required Artifacts

- exact loader rule and scoped package/module include set;
- transformed, skipped, and ambiguous module inventory with reasons;
- touched-package and changed-package summaries;
- stats module-size delta labeled as attribution scope;
- production appJs/emitted-JS raw and gzip A/B totals;
- source-backed rewrite candidates and their terminal dispositions.

## Completion Gate

Account for every touched package, transformed module, and skip reason in the
worklist. The analysis loader itself is never promoted to production.
If the experiment exposes a real opportunity, analyze a separate source or
package-level change; only that change may pass the ordinary auto-apply gate.
Ambiguous transforms and unvalidated dependency patches are `risk-found`, not
silent skips.
