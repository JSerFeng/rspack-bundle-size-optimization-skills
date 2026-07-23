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
