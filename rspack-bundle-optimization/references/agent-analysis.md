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
2. Rspack asset, chunk, chunk group, entry/async root, and splitChunks rule;
3. importing module and source-level loading boundary;
4. complete module and consumer source, including callbacks and registration;
5. behavior in other required scenarios and critical interactions;
6. the user's intended availability and preload policy.

The agent may conclude, with evidence, that the observed fact comes from an
eager route import, coarse vendor sharing, speculative preload, delayed
callback, duplicated instance, concatenated factory, error-only path, or an
incomplete scenario. The data script must not make that classification.

Development factory bytes are useful for choosing what the agent reads first,
but remain diagnostic. Only a production-comparable asset/request delta is a
confirmed gain.

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
9. splitChunks fan-in, duplication, request, or cache tradeoffs;
10. transform targets, helpers, and polyfills;
11. CSS, WASM, workers, and other assets when they materially affect the user
    request.
12. loaded runtime assets whose module factories consistently have zero
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
