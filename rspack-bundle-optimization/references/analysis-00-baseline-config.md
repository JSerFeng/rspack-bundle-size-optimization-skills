# Analysis 00: Production Baseline and Resolved Configuration

## Purpose

Establish the only baseline from which confirmed savings may be counted, capture the effective size-related compiler configuration, and turn every suspicious resolved option into an isolated experiment.

## Capability Preflight

Before the first expensive build, identify:

- the production Rspack, Rsbuild, or Rspeedy command and all top-level compilers;
- the installed compiler, framework, package-manager, and minifier versions;
- the project's build, test, and runtime-smoke commands;
- project-local Rollup, optional `@rollup/plugin-commonjs`, `@swc/core`, a compatible source-map reader, and a browser/runtime for later routes.

Do not modify the project's dependency manifest merely to add audit tooling without user authorization. Missing optional tooling blocks only the routes that require it.

## Isolated Run

Create a project-local ignored or temporary run with `scripts/create-audit-run.cjs`. Use distinct directories for baseline, resolved config, every experiment, route artifacts, and the final report.

Record in `manifest.json`:

- project root, run id, timestamp, production command, and appJs inclusion rule;
- Git commit and dirty state when available;
- runtime and package versions;
- lockfile, build-config, and relevant non-secret environment fingerprints;
- every command, exit code, output directory, and artifact path.

Maintain the generated sibling `candidate-ledger.json` throughout the run. It is the durable source for all ten route states, exhaustive candidate ids, terminal dispositions, evidence, and coverage counts; the task plan or conversation is not an audit ledger. Run the bundled `validate-ledger` command before report rendering.

Never overwrite production `dist`, reuse an old experiment directory, or join artifacts from different run ids. Run builds sequentially when they share caches or framework temporary state.

## Production Baseline

Run the unchanged production build into the isolated baseline directory. Capture:

- every emitted JavaScript asset and the explicit appJs asset manifest;
- raw and deterministic gzip totals, with raw as the primary metric;
- chunks, entries, request counts, module membership, and source maps when supported;
- largest assets and modules for triage, clearly labeled as scope rather than removable bytes.

If the project has multiple production compilers, capture and label each one. A failed or wrong-target production build blocks this route.

## Resolved Optimization Configuration

Use `scripts/optimization-config-check-plugin.template.cjs` behind `RSPACK_OPT_CONFIG=1` in the otherwise unchanged production build. Inject it through the framework's final Rspack-config mutation API. Pass a run id, a unique top-level compiler id, and the isolated route directory explicitly:

```js
new OptimizationConfigCheckPlugin({
  runId: process.env.RSPACK_AUDIT_RUN_ID,
  compilerId: "web",
  outDir: process.env.RSPACK_OPT_CONFIG_OUT_DIR,
});
```

Use a different `compilerId` for every top-level compiler. The plugin writes `optimization-config.<safe-run-id>.<safe-compiler-id>.json`, refuses to overwrite an existing artifact, and refuses to complete a failed build. Point `RSPACK_OPT_CONFIG_OUT_DIR` at a fresh empty directory inside the current run; never reuse a shared `tmp` path.

Require one fresh identity-bearing `optimization-config*.json` for every top-level production compiler. Verify its `runId` and `compiler.id` before use. Capture values from `compilation.options`, not from author-written config serialization. Include:

- pruning: `nodeEnv`, `providedExports`, `usedExports`, `sideEffects`, `innerGraph`, `concatenateModules`, and supported `inlineExports`;
- minification and naming: `minimize`, JavaScript/CSS minimizers, and `mangleExports`;
- chunk cleanup and layout: `mergeDuplicateChunks`, `removeEmptyChunks`, `splitChunks`, `runtimeChunk`, `chunkIds`, and `moduleIds`;
- ESM-library output: supported `avoidEntryIife` and its applicability constraints;
- effective producer and minifier targets needed by the ECMA route.

Compare each resolved value with author config, framework mutations, and the installed-version default. Record provenance as `explicit`, `framework`, `default`, or `unknown`; never guess.

## Candidate Worklist

Write `optimization-config-check.md` with resolved value, version-matched default, provenance, status, likely size effect, evidence, and next action. Treat every `suspect`, `experiment`, or `unknown` row as non-terminal.

Run each viable option independently against the original production baseline. Restore production concatenation outside diagnostics that explicitly disable it. If a safe core pruning or minification correction is applied, recapture this route and restart the full audit from a fresh baseline.

## Required Artifacts

- production asset and appJs manifests;
- raw/gzip totals and stats for every compiler;
- `optimization-config*.json` and `optimization-config-check.md`;
- complete resolved-option candidate dispositions;
- validated `candidate-ledger.json` with all ten routes and exact coverage;
- updated run manifest.

## Tool Self-Tests

```bash
node <skill>/scripts/create-audit-run.cjs --self-test
node <skill>/scripts/optimization-config-check-plugin.template.cjs --self-test
```

## Completion Gate

Complete this route only when the unchanged production baseline is reproducible, every compiler has a fresh resolved-config capture, and every suspicious or unknown option has a terminal agent disposition. A missing capture, guessed provenance, stale baseline, or unresolved config experiment is `blocked` or `review-required`, never `completed-no-op`.
