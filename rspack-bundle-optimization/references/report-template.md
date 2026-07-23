# Agent Report Template

The agent writes the report directly. Do not generate analytical prose with a
bundled script.

## Conclusion

- Baseline scope and exact raw/gzip bytes.
- Final scope and exact raw/gzip bytes.
- Confirmed delta.
- Whether the result is material for the stated goal.
- One plain-language sentence explaining the dominant result.

## Applied changes

For each change:

1. problem and byte surface;
2. source/config/package cause;
3. before and after code/config;
4. production A/B raw and gzip delta;
5. affected assets, chunks, modules, and requests;
6. risks checked;
7. build, test, and runtime validation.

## Runtime loading and execution

Include this section only when runtime coverage was captured.

Start with plain-language definitions:

- which scenario, repetition, cache policy, ready condition, and interaction
  window were measured;
- which page/iframe/worker targets were included;
- that a zero factory count means "not observed in this scenario", not
  "unused" or "safe to remove";
- that generated development factory bytes are diagnostic, not confirmed
  production savings.

Then give the integrity result: loaded resources versus coverage resources,
exact source matches, factory-boundary mapping, target coverage, browser
errors, instability between repetitions, and every unresolved failure with
its attempted remedy.

For each material agent-selected item, use:

1. observed resource/chunk/module fact;
2. browser initiator and Rspack loading cause;
3. relevant source and consumer code;
4. concrete before/after change;
5. why the product does or does not need it at that point;
6. production raw/gzip/request result;
7. scenario replay, critical interaction, and risk checks.

Do not paste an unexplained table of zero-count factories. Keep complete JSONL
as backing evidence and write the report for a reader who has not seen the
capture tooling.

## Measured but unapplied

Separate:

- policy-dependent results;
- dependency/upstream-package constraints;
- runtime or semantic risks;
- diagnostic-only upper bounds.

State the exact decision or validation that would clear each one.

## Rejected hypotheses

Record the comparable measurement or source/graph evidence that disproved the
hypothesis.

## Remaining large surfaces

List the largest unexplained or constrained byte surfaces and the next
agent action. Do not hide them behind a successful small optimization.

## Evidence

Link or name:

- run manifest;
- compiler captures;
- exact asset manifests;
- baseline and experiment measurements;
- source and package locations;
- build/test commands and results.

## Readability review

Before delivery, the agent must read the rendered or final report once and
fix it if:

- a metric appears before its definition or scope;
- an item lacks its loading cause, source evidence, code change, or reason;
- a capture/build/test failure lacks the actual error and attempted remedy;
- diagnostic bytes could be mistaken for confirmed savings;
- a conclusion cannot be traced to a named evidence artifact.
