# Analysis 08: ECMA Target Cost

## Contents

- [Purpose](#purpose)
- [Identify Every Effective Stage](#identify-every-effective-stage)
- [Isolated Combined Comparison](#isolated-combined-comparison)
- [Materiality Gate](#materiality-gate)
- [Capture the AppJs-Scoped Module Set and Post-Loader Sources](#capture-the-appjs-scoped-module-set-and-post-loader-sources)
- [Per-Source Generated-Byte Attribution](#per-source-generated-byte-attribution)
- [Build the Module Diff and Source Review Worklist](#build-the-module-diff-and-source-review-worklist)
- [Mandatory Deep Attribution for Material Results](#mandatory-deep-attribution-for-material-results)
- [Separate Producer and Minifier Contributions When Needed](#separate-producer-and-minifier-contributions-when-needed)
- [No-Target-Change Rewrites](#no-target-change-rewrites)
- [Required Artifacts](#required-artifacts)
- [Tool Self-Tests](#tool-self-tests)
- [Completion Gate](#completion-gate)

## Purpose

Temporarily raise the JavaScript producer and minifier output levels to expose old-browser conversion costs. Treat the result as diagnostic optimization potential and a source-rewrite guide, not as permission to change supported browsers or as a production saving.

The primary experiment changes the coordinated **target policy**. It measures the combined effect of all stages changed by that policy; one combined A/B cannot independently quantify each stage.

## Identify Every Effective Stage

Inspect the resolved project configuration and record:

- SWC/Babel/esbuild loader transform targets, including nested rules such as SVG or worker transforms;
- Rspack `target` and resolved `output.environment`, which can change runtime code generation;
- the installed minimizer and its version-specific effective ECMA/output target;
- browserslist, polyfill mode, and helper/runtime injection.

Do not introduce a second transformer. SWC `jsc.target` and `env` are mutually exclusive; update the project's existing control point. Do not assume Terser-shaped `compress.ecma` or `format.ecma` fields control another minimizer. For current `SwcJsMinimizerRspackPlugin`, inspect and set the effective `minimizerOptions.ecma`; `format.ecma` may be a no-op in the installed version. Always verify the final emitted syntax.

State whether the experiment covers only loader plus minimizer output, or also raises Rspack runtime/output capabilities. Do not call a loader-only experiment the complete ECMA target cost.

## Isolated Combined Comparison

Choose a concrete comparison target such as ES2022. Change only the coordinated target policy:

1. every applicable loader/transform target;
2. Rspack runtime/output target or `output.environment`, when included in the declared scope;
3. the installed minimizer's effective ECMA/output target.

Keep entries, dependencies, features, splitChunks, mangle/compress passes, sideEffects, usedExports, and concatenation unchanged. Record every changed target field; a target policy is the single experimental variable, even though it is applied at multiple required stages.

Verify before measuring:

- captured `module.originalSource()` contains the expected post-loader modern syntax for representative modules;
- a readable `optimization.minimize:false` diagnostic output contains the expected post-codegen/pre-minifier syntax when that boundary matters;
- final output retains syntax permitted by the comparison target;
- Rspack runtime templates change as expected when runtime/output capabilities are in scope;
- downlevel helpers such as regenerator, async/class/spread helpers, and injected polyfill inventories change as expected when the application uses those constructs.

`module.originalSource()` is post-loader and pre-Rspack-codegen. It is not the final pre-minifier chunk input: dependency templates, DefinePlugin-style substitutions, used-export code generation, concatenation wrappers, and runtime templates happen later.

If the configured target did not reach every declared stage, repair the experiment rather than interpreting the bytes.

## Materiality Gate

Decide and record the materiality formula before interpreting the experiment. Define, using unrounded bytes:

```text
rawDelta = experiment.appJs.raw - baseline.appJs.raw
materialThreshold = min(51_200 B, baseline.appJs.raw * 0.01)
```

Unless the project or user supplies a different explicit formula, the result is material when `abs(rawDelta) >= materialThreshold`. This is equivalent to the previous “50 KiB OR 1%” rule; state it as a formula so the smaller-threshold behavior is not mistaken for an AND rule. Classify the result as a win when `rawDelta < 0` and a regression when `rawDelta > 0`.

Also force deep investigation when the logical-module count or identity set, entry/chunk membership, Rspack runtime inventory, or helper/polyfill inventory changes unexpectedly, even below the byte threshold. Gzip alone does not trigger or prove materiality.

A below-threshold nonzero result still needs normal emitted-byte and source-map attribution, then finishes as `completed` with a non-material conclusion. It is not `completed-no-op`. Reserve `completed-no-op` for all applicable stages already using the comparison target, or for a successful comparison with zero raw/gzip, graph, helper/polyfill, emitted-syntax, and post-loader-source change within a pre-recorded measurement-noise policy.

A material regression receives the same attribution depth as a material win. A material result may not stop at asset totals or a generic statement such as “newer syntax is smaller.”

The normalized HTML input must encode a material result as `ecmaAttribution` with these machine-checkable fields:

- `appJsRawDeltaBytes` (or `rawDeltaBytes`) and `baselineAppJsRawBytes`;
- `baselineModuleCount`, `experimentModuleCount`, inventory-derived `addedModules`, and inventory-derived `removedModules`;
- source-map-derived `retainedShrunkSources`, `retainedGrownSources`, and `topGeneratedByteContributors`;
- `postLoaderSourceDiffConclusion` and the agent-authored `rootCause`;
- `mappedBytes`, `unmappedBytes`, and non-empty `artifacts` links/paths.

Legacy `*ReductionBytes` and `retained*Modules` input names are accepted by the renderer, but new producers must use delta direction and source-level names. A retained source row may include `modulePath`/`confidence` only with `joinKind: "one-to-one"`. Added/removed modules come from the module inventory only; a missing source-map row never proves module addition or removal. If any required structured field is absent for a material win or regression, the renderer forces the ECMA check to `blocked` and lists every missing field plus the next command.

## Capture the AppJs-Scoped Module Set and Post-Loader Sources

Copy or adapt `scripts/ecma-compilation-tree-capture-plugin.template.cjs` into the project and wire it behind an environment flag. This wrapper uses the lower-level `ecma-module-capture-plugin.template.cjs` for each active compilation partition and is the default capture path because appJs assets may be owned by child compilations such as worker or loader compilers.

Use one explicit `compilerId`, fresh output directory, and index file per top-level compiler:

```js
const {
  EcmaCompilationTreeCapturePlugin,
} = require("<skill>/scripts/ecma-compilation-tree-capture-plugin.template.cjs");

if (process.env.RSPACK_ECMA_CAPTURE === "1") {
  config.plugins ||= [];
  config.plugins.push(
    new EcmaCompilationTreeCapturePlugin({
      runId: process.env.RSPACK_AUDIT_RUN_ID,
      variant: process.env.RSPACK_ECMA_VARIANT,
      compilerId: "web",
      outDir: process.env.RSPACK_ECMA_OUT_DIR,
      indexFile: process.env.RSPACK_ECMA_INDEX,
      appJsRuleId:
        "<the same persisted inclusion-rule id used by the size metric>",
      appJsAssetFilter(name, info) {
        return; /* the exact appJs inclusion rule, not an ad hoc all-JS scan */
      },
    }),
  );
}
```

`appJsAssetFilter` runs against the top-level emitted assets and persists the exact selected list. Never rely on the plugin to infer all JavaScript implicitly. The tree index proves which compilation owns each selected asset, visits inactive child partitions explicitly, and writes one module inventory per active partition without merging canonical identities across compilers.

Run the otherwise unchanged baseline and target-policy builds sequentially:

```bash
RSPACK_ECMA_CAPTURE=1 \
RSPACK_AUDIT_RUN_ID=<run-id> \
RSPACK_ECMA_VARIANT=baseline \
RSPACK_ECMA_OUT_DIR=<run>/ecma/baseline \
RSPACK_ECMA_INDEX=<run>/ecma/module-inventory-baseline.index.json \
<production-build-command>

RSPACK_ECMA_CAPTURE=1 \
RSPACK_AUDIT_RUN_ID=<run-id> \
RSPACK_ECMA_VARIANT=target-policy \
RSPACK_ECMA_OUT_DIR=<run>/ecma/target-policy \
RSPACK_ECMA_INDEX=<run>/ecma/module-inventory-experiment.index.json \
<target-policy-build-command>
```

For multiple top-level compilers, repeat the complete pair with unique compiler ids, directories, and index filenames; never merge their counts. Within one top-level compiler, compare only baseline/experiment partitions with the same stable `partitionId`. Every selected appJs asset must have exactly one compilation owner, the selected-asset union must match the index, and every active partition inventory must be complete. Ambiguous partition signatures, missing/multiple asset owners, incomplete inventories, or a baseline/experiment partition mismatch block the ECMA conclusion.

The old single-compilation `EcmaModuleCapturePlugin` remains a lower-level helper and is valid only when evidence proves the selected appJs asset set has no child-compilation owners. Do not use it as the default merely because the top-level compiler produced the final output directory.

The capture scope is logical modules connected through selected appJs chunks. Concatenated inner modules inherit their container's chunk membership and count as logical modules; concatenated containers are recorded separately and do not inflate the logical-module count. Runtime, external, context, and virtual modules are categorized explicitly.

Canonical identity uses:

- normal modules: normalized resource **including query and fragment**, plus module type and layer;
- modules without a resource: category plus normalized identifier, type, and layer.

Raw `module.identifier()` is evidence, not the primary identity for normal modules because loader requests and target options can change it. Issuers, chunks, and entrypoints are comparison attributes, not identity fields. Any canonical-key collision remains `ambiguous`; never use raw identifier, stats size, array order, or a guessed issuer to force-pair it.

Each inventory records run/compiler identity, the exact appJs asset list, canonical and raw identities, category, memberships, issuers, and hash-addressed complete `module.originalSource()` artifacts with SHA-256, UTF-8 bytes, and readability metadata. Post-loader UTF-8 bytes are diagnostic source scope only.

## Per-Source Generated-Byte Attribution

Use final minified source maps from builds with the same target-policy variables and exact appJs inclusion rule:

```bash
node scripts/sourcemap-generated-byte-attribution.cjs \
  --baseline-dir <run>/baseline/dist \
  --experiment-dir <run>/ecma/dist \
  --baseline-asset-manifest <run>/ecma/module-inventory-baseline.index.json \
  --experiment-asset-manifest <run>/ecma/module-inventory-experiment.index.json \
  --baseline-reviewed-unmapped-manifest <run>/ecma/reviewed-unmapped-baseline.json \
  --experiment-reviewed-unmapped-manifest <run>/ecma/reviewed-unmapped-experiment.json \
  --project-root <project-root> \
  --require-complete-maps \
  --out <run>/ecma/generated-byte-attribution.json
```

The compilation-tree index files are valid asset manifests because they persist the complete top-level `scope.appJsAssets`. The script must analyze exactly those assets; its recursive all-JS fallback is not valid for an audit conclusion.

This index-scoped attribution reconciles the headline appJs delta. Also run the same command once per matching compilation partition, using that partition's baseline and experiment inventory files as the two asset manifests and a partition-specific output path. A partition inventory persists only the assets owned by that compilation, so its attribution is the input to that partition's module diff. Do not pass the aggregate all-appJs attribution to a partition diff whose asset scope is narrower.

The attribution tool must use the same gzip metric as the emitted-asset measurement: compress each selected asset independently with Node `zlib.gzipSync(..., { level: 9 })`, then sum the compressed byte counts. Record that level in the attribution artifact; do not compare its default-level gzip output with a level-9 headline.

Dependency resolution stays project-local and never installs anything. The tool first accepts normal Node resolution only when the real path remains inside `<projectRoot>/node_modules`. If pnpm has not linked the package at the root, it scans only `<projectRoot>/node_modules/.pnpm`, selects the highest valid semantic version of an installed `@jridgewell/trace-mapping` package, and breaks an exact-version tie by package-root lexical order. The JSON output records the method, selected version/path, deterministic rule, all discovered candidates, and the original Node-resolution error. Do not add a dependency or access the network to repair this capability.

If production does not emit source maps, run a paired hidden-source-map diagnostic build with the same settings on both sides and no `sourceMappingURL` trailer. Verify that every included JavaScript asset is byte-identical to the corresponding headline production A/B output, apart from filenames when content hashes are proven from identical bytes. If that proof fails, headline raw/gzip remains from the production builds and the source-map build is diagnostic only; a material result without trustworthy attribution is `blocked`.

`--require-complete-maps` fails after writing the artifact when any selected asset has a missing/invalid map or an attribution-byte mismatch. A selected tiny JavaScript asset that genuinely has no source-backed mappings may pass this gate only after an agent inspects its complete emitted source and lists it in the matching side's explicit reviewed-unmapped manifest:

```json
{
  "schemaVersion": 1,
  "kind": "reviewed-unmapped-app-js",
  "side": "baseline",
  "reviewer": "agent identity",
  "reviewedAt": "2026-01-02T03:04:05.000Z",
  "assets": [
    {
      "asset": "static/js/tiny.js",
      "sha256": "<64 lowercase hex characters>",
      "rawBytes": 123,
      "reason": "Exact source inspection conclusion explaining why no original source map can exist."
    }
  ]
}
```

Use `side: "experiment"` for the experiment manifest. `rawBytes` is optional but, when present, is validated. The tool always verifies the emitted-file SHA-256, rejects duplicate/out-of-scope entries, rejects an entry when a source map actually exists, and fails independently of `--require-complete-maps` on a stale path, side, size, or hash. Do not use this mechanism for an invalid source map or merely inconvenient attribution. The JSON and Markdown output list each accepted asset, reason, reviewer, review time, raw/gzip bytes, and hash separately; these bytes remain part of the unmapped residual.

Also report mapped and unmapped bytes and the baseline-to-experiment unmapped delta. Unmapped runtime/license scaffolding can be legitimate, but if the unexplained residual is large enough to change the root-cause conclusion, the check is `blocked` until resolved.

The script attributes generated UTF-8 segment spans to source-map `source` rows and emits retained/shrunk/grown plus source-presence added/removed rows. These are **per-source diagnostic allocations**, not module sizes. “Source removed from included appJs” does not prove a module was removed; only the module inventory can make that claim.

Keep emitted asset raw/gzip totals as the headline. Source-map attribution explains the delta; it does not replace it.

## Build the Module Diff and Source Review Worklist

Read both tree indexes, pair active partitions by the same stable `partitionId`, and run one comparison per matching partition. For example, the root `web` partition uses:

```bash
node scripts/ecma-module-diff.cjs \
  --baseline <run>/ecma/baseline/module-inventory.web.json \
  --experiment <run>/ecma/target-policy/module-inventory.web.json \
  --generated-attribution <run>/ecma/attribution/web/generated-byte-attribution.json \
  --require-generated-attribution \
  --out-dir <run>/ecma/diffs/web
```

Repeat for every child partition listed as active in either index. Do not compare a child inventory to the root inventory, deduplicate matching canonical keys across partitions, or omit a partition that appears on only one side; a missing pair is a graph change requiring explicit resolution.

Each partition comparison writes:

- `ecma/module-diff.json`;
- `ecma/post-loader-source-diff.json`;
- `ecma/post-loader-source-worklist.md`.

It verifies run id, compiler id/context, appJs rule id, exact per-side attribution asset lists, source artifact hashes/UTF-8 bytes, and source-map data quality. It exits nonzero after writing the artifacts when identity or data-quality problems make the diff incomplete. Record that exit and resolve it; do not silently continue.

The diff joins a source-map row to a module only when the source key has exactly one module owner. A source can represent multiple module instances, and one module can contribute through multiple source rows. Ambiguous or missing joins remain source-level evidence and must not be presented as per-module generated bytes.

Rspack stats `module.size` is useful for inventory and prioritization, but is not a minified emitted-byte measurement. The capture deliberately does not use it. Use emitted asset totals for savings, source-map spans for per-source allocation, and label all post-loader source-byte comparisons as diagnostic only.

## Mandatory Deep Attribution for Material Results

For each material result, the module diff and worklist must report at least:

- baseline and experiment logical-module counts, with concatenated containers separate;
- added, removed, retained, and ambiguous canonical identities;
- entry/chunk/issuer membership changes;
- retained source-map sources whose attributed generated bytes shrank or grew, including join status;
- helper, Rspack runtime, and polyfill modules added or removed;
- mapped and unmapped emitted-byte residuals;
- post-loader source status, SHA-256, UTF-8 diagnostic byte counts, readability, and artifact paths.

Then investigate the largest contributors in this order:

1. **Module-set change** — explain why each important logical module was added or removed. Check resolution conditions, injected polyfills/helpers, side-effect retention, used exports, and chunk/entry membership; do not assume a newer target caused tree shaking.
2. **Retained per-source generated-byte change** — rank both shrunk and grown retained source rows by absolute raw delta. Keep source-only rows separate unless the source-to-module join is one-to-one.
3. **Post-loader source change** — for every top joined contributor, read the complete baseline and experiment source artifacts and run the recorded `diff -u` command. Name the smallest explanatory transform; an automated changed-region preview is navigation, not the conclusion.
4. **Agent root-cause review** — identify the actual construct: async/generator lowering, class transforms, object/array spread, optional chaining, helper imports, regenerator/runtime code, polyfill injection, Rspack runtime/code generation, or minifier-only output.

Use these interpretation rules:

- Post-loader source changed and generated bytes changed: this proves loader output changed, but the combined A/B does not by itself quantify the loader's share.
- Post-loader source is identical but generated bytes changed: investigate Rspack parser/codegen and dependency templates, used-export rendering, concatenation/chunk/runtime context, minimizer output, and source-map residuals.
- A logical module disappeared: prove the connection, resolution, helper, or polyfill injection rule that previously included it.
- A module or source grew: state why, whether growth is offset by a larger reduction, and whether it signals an invalid comparison.

Category totals must reconcile with the emitted asset delta within the explicitly reported mapped/unmapped residual. Do not describe a win as module removal when retained-source compaction dominates, or as syntax compaction when helper/polyfill removal dominates.

## Separate Producer and Minifier Contributions When Needed

The combined target-policy A/B is the headline diagnostic. If a material result requires numeric separation, add staged experiments while holding every other variable fixed:

1. old producer target + old minifier target — baseline;
2. modern producer target + old minifier target — only when the old minifier accepts and validly emits the modern producer syntax;
3. modern producer target + modern minifier target — combined experiment;
4. optionally old producer target + modern minifier target — when needed to test interaction.

Here “producer” includes the declared loader and Rspack runtime/output target scope. If a staged combination is invalid, record that limitation and report only the combined result. Do not manufacture separate byte numbers from post-loader source length or source-map allocation.

## No-Target-Change Rewrites

For top contributors, inspect source and propose local rewrites that preserve production browser support, for example:

- removing a trivial async wrapper only when Promise identity, thenable adoption, and synchronous-throw versus rejected-Promise semantics are proven irrelevant and behavior-tested;
- narrower or hoisted repeated optional chains;
- avoiding repeated spread in large constructors;
- moving APIs that trigger usage-based polyfills into an existing lazy boundary, while reporting initial-JS and total-appJs effects separately.

Each rewrite remains a hypothesis until behavior tests and a normal production A/B prove emitted raw/gzip reduction.

If every applicable stage already uses the comparison target, record evidence-backed `completed-no-op`. Missing source maps, an appJs scope mismatch, unresolved canonical collisions affecting the conclusion, unreadable/missing post-loader artifacts, or a failed attribution command is `blocked`, not zero impact. Record the command, exact error, artifact, retry, and next action.

## Required Artifacts

- coordinated baseline/experiment target-policy diff;
- baseline and experiment appJs asset manifests and raw/gzip totals;
- baseline and experiment compilation-tree indexes, including every visited active/inactive partition and exact selected-asset ownership;
- module, chunk, runtime, helper, and polyfill inventories for both variants;
- canonical module diff per matching compilation partition, with ambiguous joins and unmatched partitions kept separate;
- aggregate and per-partition generated-byte attribution with mapped/unmapped reconciliation;
- complete post-loader source review worklist and agent-authored source-diff conclusions;
- failed-command/retry ledger and production A/B rewrite results.

## Tool Self-Tests

Run these before wiring project builds when the skill was freshly updated or copied:

```bash
node scripts/ecma-compilation-tree-capture-plugin.template.cjs --self-test
node scripts/ecma-module-capture-plugin.template.cjs --self-test
node scripts/sourcemap-generated-byte-attribution.cjs --self-test
node scripts/ecma-module-diff.cjs --self-test
```

The compilation-tree self-test covers root/child/inactive partitions, exact asset ownership, stable child registration identity across content-hash changes, and real Rspack version selection. The module capture self-test covers query/fragment identity, concatenated-container separation, UTF-8 byte counts, issuers, and collision detection. The source-map self-test covers explicit appJs selection, preserved source query/fragment, highest-version pnpm fallback, and deterministic tie-breaking. The diff self-test covers added/removed/retained/ambiguous classification, one-to-one generated-byte joining, source diffs, hash validation, and artifact generation.

## Completion Gate

A browser/ECMA target increase always carries product compatibility policy risk
and is never promoted automatically by this skill. Resolve every material contributor and
every proposed no-target-change rewrite. Local behavior-preserving rewrites may
pass the normal production A/B and auto-apply gate; the target experiment
itself remains diagnostic/risk-found unless the user separately changes the
support policy.
