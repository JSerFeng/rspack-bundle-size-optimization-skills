# Agent Analysis

## Principle

The agent performs the analysis. Bundled scripts provide facts and arithmetic
only.

Do not follow a fixed script route merely because it exists. Start with the
largest plausible product impact, then request the evidence needed to accept
or disprove each hypothesis.

## Build the byte surface

From the production capture and measurements, the agent should distinguish:

- total emitted JavaScript;
- HTML-injected or entrypoint-initial JavaScript;
- important route or async-group JavaScript;
- first-party, third-party, runtime, helper, and polyfill scope;
- duplicated modules or package versions;
- opaque or poorly attributed large assets.

Module and source byte counts are triage scope, not confirmed savings.

## Runtime loading decision tree

When runtime coverage was requested, first verify the scenario before
prioritizing any row:

1. Did coverage start before navigation?
2. Did every loaded JavaScript resource enter coverage?
3. Were exact sources matched to V8 offsets?
4. Were relevant page, iframe, and worker targets captured?
5. Did repeated scenarios agree on resources, errors, and factory counts?

If a check fails, first attempt to repair or repeat the capture. Preserve the
failure reason and affected scope when it cannot be repaired.

For each material zero-count factory or zero-count-heavy loaded asset, the
agent then traces:

1. browser resource and network initiator;
2. Rspack asset, chunk, chunk group, entry/async root, and effective
   dynamic-import chunk-name and mode relationships;
3. applicable splitChunks rule;
4. importing module and source-level loading boundary;
5. complete module and consumer source, including callbacks and registration;
6. behavior in other required scenarios and critical interactions;
7. the user's intended availability and preload policy.

The agent may conclude, with evidence, that the observed fact comes from an
eager route import, coarse vendor sharing, speculative preload, delayed
callback, duplicated instance, concatenated factory, error-only path, or an
incomplete scenario. The data script must not make that classification.

Development factory bytes are useful for choosing what the agent reads first,
but remain diagnostic. Only a production-comparable asset/request delta is a
confirmed gain.

## Chunk loading-boundary analysis

Before attributing unexpected async fan-in or co-loading to `splitChunks`,
scan the audited project's user-owned disk and parser-visible post-loader
source for `webpackChunkName` and `rspackChunkName` magic comments on dynamic
`import()` calls. Start with a mechanical text search, but inspect each
complete import because a magic comment may span lines or contain multiple
directives. Include its effective `webpackMode` or `rspackMode`, including
project parser defaults, and keep top-level compilers separate.

For each matching import, record the source location, request or context
candidates, literal chunk-name and mode annotations, importer or route, and
captured chunk-group name and origins. Use compiler diagnostics and captured
output to resolve prefix precedence, ignored annotations, and `[request]` or
`[index]` expansion. An `eager` or `weak` import does not create the same lazy
loading boundary, while `lazy-once` can combine a context import's candidates
without repeated source annotations. Group imports by their effective captured
chunk group within one compiler, never by the literal comment alone.

Reusing one effective name across lazy dynamic imports connects their async
blocks to the same named chunk group. This can co-locate the target modules and
their synchronously reachable dependencies that were not already available or
subsequently extracted. Nested dynamic imports retain their own boundaries
unless their effective group options independently merge them. Later chunk
optimizations may also produce multiple chunks in that group. Triggering one
import can therefore load code introduced by another import with that
effective name. Verify the cause against captured group origins, module
membership, and generated output.

Only after accounting for shared effective chunk-name relationships should
the agent attribute the remaining fan-in, duplication, or co-loading to
`splitChunks`. Avoid giving many independent dynamic imports the same
effective name unless their co-loading is intentional and supported by route,
request, and cache policy. In optimize mode, test removing the shared name or
assigning separate names as a narrow experiment, then compare production
route bytes, requests, loading order, cache behavior, and the required
interaction.

## High-impact investigation order

Use project evidence to choose the order. Common high-value areas include:

1. large package or source contributions;
2. broad package/barrel imports when narrower public subpaths exist;
3. heavy features, editors, charts, SDKs, locales, icons, or renderers loaded
   before they are needed;
4. duplicate package versions or repeated code across chunks;
5. dev-only, mock, debug, or registration code present in production;
6. side-effect metadata or package-boundary problems that prevent pruning;
7. namespace/dynamic-import flows that keep whole modules live;
8. CommonJS or mixed-module packaging that prevents export pruning;
9. shared effective `webpackChunkName` or `rspackChunkName` fan-in across
   dynamic imports;
10. splitChunks fan-in, duplication, request, or cache tradeoffs;
11. transform targets, helpers, and polyfills;
12. CSS, WASM, workers, and other assets when they materially affect the user
    request.
13. loaded runtime assets whose module factories consistently have zero
    counts in complete, stable scenarios.

This is an agent checklist, not a list of mandatory scripts.

## Hypothesis record

Keep an agent-authored record under `<run>/notes/`. For each material
hypothesis, record:

- affected assets, chunks, modules, packages, and import sites;
- factual evidence paths and relevant source locations;
- plausible emitted-byte or loading-path impact;
- why the code is present;
- proposed experiment;
- semantic and product risks;
- production A/B result;
- tests or runtime checks;
- final agent conclusion.

For a runtime-loading hypothesis, also record the scenario/repetition,
resource initiator, target type, factory count evidence, loading cause, and
critical-interaction replay.

Do not let a filename, regex, stats field, or graph edge supply the
conclusion.

## Required source reasoning

For side effects and export usage, inspect:

- complete disk source and post-loader source;
- top-level calls, assignments, registration, mutation, style/DOM work,
  environment reads, worker setup, and import-only execution;
- nearest `package.json`, including `exports`, `sideEffects`, conditions,
  `module`, `main`, `browser`, and `type`;
- the consumer import/reference site;
- relevant entry, async boundary, chunk, and runtime behavior.

Compiler `usedExports`, `providedExports`, bailouts, and export-usage edges are
facts about a build. They are not semantic verdicts.

### Export-usage semantic review

`used` proves that a build found a consumption path. It does not prove that
the product intends to consume the export, that the importing feature belongs
in the measured route, or that the broad loading boundary is appropriate.

For every high-impact export, the factual capture should give the agent:

- every resolved usage location, not only the first one;
- a bounded post-loader code snippet around each usage;
- the complete enclosing top-level declaration or exported symbol;
- the chain from a nested callback usage back to that top-level owner;
- the importer/consumer snippet and relevant dynamic-import or registration
  boundary.

For example, if `usedFoo` appears only inside `bar`, which is returned by
top-level `foo`, the fact record should make the relationship
`foo -> usedFoo` visible instead of handing the agent an isolated identifier:

```js
function foo() {
  return function bar() {
    console.log(usedFoo);
  };
}
```

A bundled script may extract locations, syntax relationships, hashes, and
snippets. The agent must still read the complete source and decide whether
the usage is intended, eager by mistake, registration-only, feature-gated, or
otherwise optimizable.

Use the factual extractor for each high-impact provider/export rather than
handing the agent only an aggregate `usedExports` value:

```bash
node <skill>/scripts/extract-export-usage-context.cjs \
  --dir <capture> \
  --project-root <audited-package-root> \
  --target "provider/package/path.js" \
  --export "exportName" \
  --out <run>/notes/exportName-context.json
```

Review every matched edge. The extracted
`mechanicalOwnerToTargetExport`, such as `foo -> usedFoo`, is only a syntax
relationship. Confirm product intent from the complete consumer/provider
source, import or registration boundary, route/chunk reason, runtime
behavior, and production-comparable experiment.

The extractor must not silently turn a missing location, source mismatch,
ambiguous post-loader row, parser failure/recovery, oversized omitted owner
source, or missing syntax owner into “no usage.” Retry with the correct
capture/package root or read the raw source directly. If the gap cannot be
resolved, record its exact reason and affected edge/module count and keep the
semantic review incomplete for that scope.

### ECMAScript target attribution

When raising the ECMAScript target produces a material size change, do not
attribute the full delta to polyfills or newer syntax from the top-level total
alone. Partition the A/B into:

- polyfill assets and modules;
- non-polyfill modules removed or added;
- modules present in both builds whose generated bytes changed;
- loader/transpiler/runtime-helper output changes;
- chunk membership and concatenation changes.

Compare module inventory and per-module generated bytes first. For each large
non-polyfill delta, inspect disk source and post-loader source in both builds
and have the agent explain the concrete transform difference. If source maps
or module attribution are incomplete, record that failure and do not report
an unexplained residual as confirmed ECMA savings.

## Experiment design

- Change one hypothesis at a time.
- Preserve the original production baseline.
- Restore production minimization and concatenation for size measurements.
- Use the same entries, dependencies, feature flags, and unrelated config.
- Explain every meaningful asset/module/chunk change.
- Replay the same runtime scenario when the hypothesis changes initial or
  route loading, and exercise the interaction that should load deferred code.
- Reject a hypothesis when a comparable build shows no relevant improvement
  or disproves its cause.
- Do not promote a browser target, dependency replacement, public API change,
  or product behavior change without the required authority.

## Completion

Candidate-count closure is not enough. Before finishing, the agent must show:

- which byte surfaces were examined;
- which material hypotheses were tested;
- what remains unexplained or unattributed;
- whether remaining large opportunities are required, risky, policy-bound,
  upstream-bound, rejected, or blocked;
- a fresh final production measurement after applied changes.

If only small improvements are safe, say so and provide the evidence that the
larger surfaces were investigated. Do not present a few kilobytes as a
material success merely because a checklist is complete.
