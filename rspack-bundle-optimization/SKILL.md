---
name: rspack-bundle-optimization
description: Agent-driven Rspack, Rsbuild, and Rspeedy bundle auditing and optimization. Use for bundle-size investigations, reductions, reviews, or measured reports. Bundled JavaScript may only capture, persist, retrieve, hash, and measure factual data; the agent must perform all candidate discovery, prioritization, semantic analysis, risk assessment, code changes, and conclusions.
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

## Hard JavaScript Boundary

Bundled JavaScript is a data plane, never an analyst.

JavaScript may only:

- capture facts exposed by the compiler or filesystem;
- serialize raw stats, graph edges, module/chunk membership, resolved config,
  and post-loader source;
- create isolated directories and record commands;
- hash and verify evidence files;
- calculate exact raw/gzip bytes and arithmetic deltas;
- retrieve a requested captured record or source range.

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
6. inspect source, post-loader source, package metadata, imports, graph
   connections, chunks, and generated output for each material hypothesis;
7. in optimize mode, implement and measure narrow changes without handing
   routine candidate decisions back to the user;
8. assess runtime, API, browser, dependency, side-effect-order, registration,
   loading-order, request, cache, CSS, worker, and product-policy risk;
9. keep agent-authored notes and conclusions under `<run>/notes/`;
10. write the final report directly from verified evidence.

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

### 4. Agent analysis

The agent analyzes the raw capture. It must not treat module/source size,
`usedExports=[]`, a bailout, namespace use, a Rollup result, or a source
pattern as removable bytes without source inspection and a
production-comparable experiment.

Start with high-impact surfaces instead of exhausting tiny rows first. Keep
the complete backing data, but prioritize agent work by plausible product
impact and evidence quality.

### 5. Experiments and edits

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

### 6. Fixed point

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
