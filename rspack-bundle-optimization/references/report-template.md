# Report Template

Write for a reader who has not seen the capture tools. Lead with the result and
include only evidence that supports a decision, explains a material cause, or
defines remaining work.

## Result

For `audit-only`, state:

- unchanged production measurements for each requested scope, raw first and
  gzip second;
- the largest explained contributors and material unexplained remainder;
- evidence gaps that limit a conclusion;
- proposed changes labeled unapplied and unmeasured.

For `optimize`, state:

- unchanged and final production measurements for identical scopes;
- exact raw and gzip difference;
- whether the result meets the user's goal;
- the principal source-level cause in one sentence.

When several changes are accepted, show one unchanged-to-final table plus the
production effect of each isolated experiment. Present bundle bytes, requests,
and named performance metrics as separate results.

## Applied changes

For each accepted change, explain:

1. affected JavaScript and loading or emission cause;
2. relevant source, configuration, or package behavior;
3. concrete code or configuration change;
4. why the emitted or requested output changed;
5. production raw/gzip and request result for the affected scope;
6. correctness, runtime, browser, compatibility, and project checks that
   apply to the changed behavior.

## Runtime loading and execution

Include this section when runtime coverage contributed to the conclusion.
Define the page or interaction, cache setting, ready condition, capture window,
repetitions, included targets, browser errors, failed requests, and coverage
method.

Show each repetition, then identify results common to all valid runs. Label a
DevTools Coverage-panel mapping `ui-range-inference`. Interpret zero-count
generated wrappers as unobserved in the named scenario and use production
request or asset differences for confirmed loading results.

For each material runtime finding, report:

1. observed browser result;
2. network and Rspack loading cause;
3. relevant source and consumer;
4. proposal or applied change;
5. production byte/request measurement;
6. repeated scenario and critical-interaction check.

For deferred loading, identify assets removed from first screen and show their
on-demand loading during the required interaction.

## Open decisions

Include material unapplied findings that require a user or team decision,
dependency work, compatibility choice, runtime evidence, or correctness proof.
For each, state the potential scope and the exact decision or evidence needed.

Mention a rejected hypothesis or failed experiment only when its evidence
changes the recommended action or prevents likely duplicate investigation.
Summarize it in one sentence with the decisive measurement or source fact.

## Remaining material items

List material unexplained or constrained sources and one concrete next action
for each. Relate their importance to the user's requested scope rather than
enumerating every small contributor.

## Evidence

Link or name:

- run and capture manifests;
- exact asset lists and measurements;
- source and package locations;
- production build, test, and runtime commands with results.

## Final check

Every reported number has a named scope and unit; every accepted change has a
cause, comparable result, and relevant check; every limitation identifies its
affected conclusion. For HTML output, inspect representative findings and a
narrow viewport for readable layout and working evidence links.
