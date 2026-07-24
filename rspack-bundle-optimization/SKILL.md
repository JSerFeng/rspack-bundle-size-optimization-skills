---
name: rspack-bundle-optimization
description: Agent-driven Rspack, Rsbuild, and Rspeedy bundle auditing and optimization. Use for bundle-size investigations, reductions, reviews, measured reports, or Chrome runtime-coverage analysis of loaded chunks and module factories. Bundled JavaScript may only capture, persist, retrieve, hash, normalize, verify, and measure factual data; the agent must perform all candidate discovery, prioritization, semantic analysis, risk assessment, code changes, and conclusions.
---

# Rspack Bundle Optimization

Own the bundle investigation from a production baseline to a measured,
agent-supported conclusion.

## Mode

- Use `audit-only` for analysis, investigation, explanation, review, and
  report requests.
- Enter `optimize` only when the user explicitly asks to reduce, optimize,
  fix, apply, or implement changes.
- Do not commit, push, publish, change browser support, replace a dependency,
  or change product behavior unless the request authorizes that action.

## Build And Coverage Modes

Keep task mode separate from build mode. Use these build modes consistently:

- `development`: the project's ordinary development configuration. Use only
  for local debugging or capability checks. Do not report its bytes, requests,
  or coverage as production evidence.
- `production`: the unchanged production configuration. Use for confirmed
  emitted-byte, request, and user-facing savings.
- `production-debug`: production with compression/minimization disabled,
  `optimization.concatenateModules` disabled, and `optimization.moduleIds`
  set to `named`; keep every other production entry, feature flag, target,
  splitChunks, dependency, runtime, and plugin setting unchanged.

Use `production-debug` for Rspack chunk/runtime coverage and source-level
module-factory analysis. Treat its module and generated-byte facts as
diagnostic evidence; prove savings with `production`.

## Hard JavaScript Boundary

Bundled JavaScript is a data plane, never an analyst.

JavaScript may only:

- capture facts exposed by the compiler or filesystem;
- serialize raw stats, graph edges, module/chunk membership, resolved config,
  and post-loader source;
- create isolated directories and record commands;
- hash and verify evidence files;
- calculate exact raw/gzip bytes and arithmetic deltas;
- normalize exact browser coverage ranges and map them mechanically to
  generated Rspack module factories;
- retrieve a requested captured record or source range;
- mechanically join a requested set of export-usage edges to captured
  consumer locations, code snippets, enclosing declarations, and syntax
  owner chains.

JavaScript must never:

- create, rank, score, accept, reject, or disposition optimization candidates;
- infer genuine usage, removability, side-effect purity, compatibility, or
  semantic safety;
- label a module, export, package, chunk, or source pattern as an opportunity;
- choose an experiment or propose a code/config/dependency change;
- turn graph traversal or pattern matching into a root-cause conclusion;
- decide whether a route, audit, or optimization is complete;
- generate analytical prose or a final optimization report.

Compiler-provided fields such as `usedExports`, `providedExports`, bailouts,
reasons, and export-usage edges remain raw facts. Their meaning is decided by
the agent after reading the surrounding evidence.

Likewise, a browser coverage count of zero means only "not observed in this
recorded scenario." JavaScript must not rename that fact to "unused",
"unwanted", "removable", or "safe to defer".

## Agent Responsibilities

The agent must:

1. inspect applicable `AGENTS.md`, project scripts, package manager, actual
   compiler version, dirty state, browser/runtime policy, and validation
   commands;
2. define the production command and explicit asset scopes for total,
   initial, and important route JavaScript;
3. capture the unchanged baseline with the bundled data tools;
4. read the captured data and build its own byte-surface model;
5. form and prioritize hypotheses, starting with the largest plausible
   emitted-byte or loading-path impact;
6. when runtime loading is in scope, define repeatable browser scenarios,
   capture all relevant targets before navigation, and connect coverage facts
   to network initiators and compiler graph facts;
7. inspect source, post-loader source, package metadata, imports, graph
   connections, chunks, and generated output for each material hypothesis;
8. in optimize mode, implement and measure narrow changes without handing
   routine candidate decisions back to the user;
9. assess runtime, API, browser, dependency, side-effect-order, registration,
   loading-order, request, cache, CSS, worker, and product-policy risk;
10. keep agent-authored notes and conclusions under `<run>/notes/`;
11. write and then review the final report directly from verified evidence.

Read `references/agent-analysis.md` completely before analyzing a captured
bundle.

## Workflow

### 1. Create an isolated data run

Use:

```bash
node <skill>/scripts/create-audit-run.cjs \
  --project-root <project-root> \
  --root <ignored-project-local-root> \
  --build-command "<production command>" \
  --asset-scope "<plain-language scope>"
```

The tool creates storage and fingerprints. It does not create candidates,
route states, or conclusions.

### 2. Capture the unchanged production build

Read `references/data-capture.md`, then wire
`scripts/rspack-data-capture-plugin.template.cjs` behind an audit-only
environment flag.

Capture each top-level compiler separately with a unique compiler id and
directory. Refuse stale or overwritten artifacts.

### 3. Measure explicit asset scopes

Read `references/measurement.md`. Measure total, initial, and important route
assets separately when those scopes matter. Raw bytes are primary; gzip is
secondary.

### 4. Capture runtime loading when relevant

When the request concerns first-screen or route resources, loaded chunks, or
code not executed during a scenario, read
`references/runtime-coverage.md` completely.

Prefer the official Chrome DevTools MCP server when it is available. Use its
coverage tools as the primary capture path, together with its exact script
source, loaded-resource/network, console, navigation, and target facts. If the
MCP is unavailable or a required coverage/source/network fact is missing,
record the concrete missing tool or capability and only then use a lower-level
CDP or Puppeteer fallback. Normalize the raw capture and run the integrity
verifier. First attempt to solve any capture or mapping failure. If it remains
unsolved, report its reason and affected scope; do not silently continue with
a complete-sounding conclusion.

For Rspack chunk/runtime coverage, use `production-debug`. First start a local
production server, preview server, or serve command for that build, then probe
the target home page and important APIs. For the real capture, start coverage
first, then reload or navigate to the home page. If startup, navigation,
login/session, proxy, API, or asset serving fails, inspect logs and try only
safe, non-semantic fixes. Ask the user before applying or relying on a fix that
changes the scenario, product behavior, auth state, API behavior,
browser-support policy, feature flags, proxy/mocking strategy, or production
comparability. If the correct fix is unclear, ask the user for help instead of
inventing a local workaround and treating the capture as valid.

Use the built-in Chrome DevTools Coverage panel only when the live MCP tool
list lacks required coverage/source capability, or when the MCP coverage
command fails and the exact error is recorded. Treat the panel export as the
explicitly degraded fallback described in the reference; do not mislabel its
used ranges as precise call counts. A stable first-screen production A/B uses
three separate repetitions for baseline and candidate, followed by the
critical interaction that must load deferred code.

Runtime coverage is conditional evidence. Do not run it merely to add a
metric when the user asks only about emitted production bytes.

### 5. Agent analysis

The agent analyzes the raw capture. It must not treat module/source size,
`usedExports=[]`, a bailout, namespace use, a Rollup result, or a source
pattern as removable bytes without source inspection and a
production-comparable experiment.

Start with high-impact surfaces instead of exhausting tiny rows first. Keep
the complete backing data, but prioritize agent work by plausible product
impact and evidence quality.

When runtime facts exist, the agent must determine why each material asset
loaded and whether the observed product scenario actually wants the retained
feature. A zero-count factory alone is not an optimization conclusion.

For high-impact `usedExports` or export-usage questions, run
`scripts/extract-export-usage-context.cjs` with a narrow provider/export
filter. Read every returned consumer snippet, complete top-level owner, nested
owner chain, importing boundary, and then the complete source. The script
only exposes syntax facts. The agent decides whether the consumption is
product-intended, accidentally eager, registration-only, feature-gated, or
otherwise optimizable. Resolve any missing location, source match, parser, or
owner failure first; if it remains unresolved, retain the exact reason and
affected edge count in the report.

### 6. Experiments and edits

In optimize mode:

- change one hypothesis at a time;
- use a fresh experiment output;
- hold entries, dependencies, feature flags, minimization, concatenation, and
  splitChunks constant except for the intended variable;
- compare exact asset scopes;
- inspect the output diff and run relevant tests/runtime checks;
- apply only changes supported by the evidence and authorized policy.

Small positive deltas may be retained when the change is worthwhile, but they
do not prove that the bundle has no larger opportunity.

### 7. Fixed point

After applying changes, capture a fresh production baseline. Finish only when
the agent can support one of these conclusions:

- material safe opportunities were applied and validated, and no larger
  in-scope hypothesis remains unexamined;
- the remaining material opportunities have concrete risk, policy, or
  upstream-package constraints and a clearing condition;
- required factual data cannot be captured after a concrete attempt, in which
  case the report is explicitly incomplete.

No JavaScript validator decides this state.

## Measurement Rules

- Headline emitted JavaScript raw bytes; show gzip second.
- Keep total emitted, initial, and route-level scopes separate.
- Preserve the exact included-asset list for every measurement.
- Count only production-comparable A/B output as confirmed savings.
- Keep source size, stats module size, diagnostic potential, and predicted
  attribution separate from confirmed emitted-byte deltas.
- Never reuse production `dist`, overwrite an experiment, or combine
  artifacts from different run ids.

## Safety Gate

An optimization may be promoted only when:

- the agent explains the source/config/package cause;
- a production-comparable A/B proves the relevant improvement;
- the output change matches the intended transformation;
- no unresolved in-scope correctness or policy risk remains;
- the production build and relevant tests or runtime smoke checks pass.

The agent must state what was checked. Never claim absolute zero risk.

## Delivery

Read `references/report-template.md`. The agent writes the final Markdown or
requested document directly. A report renderer is not part of this skill.

The report must separate:

- confirmed applied savings;
- measured but unapplied results;
- diagnostic upper bounds;
- rejected experiments;
- blocked or policy-dependent opportunities;
- remaining high-impact actions.

When runtime coverage was used, include its scenario, target, source-mapping,
failure, loading-cause, and replay evidence. Review the finished report once
for readability and correct any unexplained metric, missing failure reason,
or diagnostic byte count that could be mistaken for confirmed savings.
