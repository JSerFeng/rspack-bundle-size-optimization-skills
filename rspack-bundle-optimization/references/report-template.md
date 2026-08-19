# Report Template

Write the report for a reader who has not seen the capture tools. Link the
evidence, but explain the source and result in the report itself.

## Result

For an `audit-only` report, state:

- the unchanged production scopes, with exact raw bytes first and gzip second;
- the largest explained sources and any important unexplained remainder;
- missing data or checks that limit the conclusion;
- proposed changes, clearly marked as not applied and not measured.

Do not invent a difference or confirmed saving for an audit-only run.

For an `optimize` report, state:

- the unchanged and final production scopes;
- exact raw bytes first and gzip second;
- the confirmed difference;
- whether that difference matters for the user's goal;
- the main reason for the result in one plain sentence.

If several changes were applied, show one unchanged-to-final table and the
separate production result of each change. Fewer bytes or requests are bundle
results, not proof of faster loading; name the separately measured performance
metric before making a performance claim.

## Applied changes (`optimize` only)

For each change, explain:

1. the problem and affected JavaScript;
2. the source, config, or package behavior that caused it;
3. the relevant code before and after;
4. why the new code emits or loads fewer bytes;
5. the exact production raw/gzip and request result for the affected scope;
6. the correctness, browser, runtime, compatibility, and agreed project checks
   that passed.

Do not make the reader infer the change from raw JSON or subtract tables
manually.

## Runtime loading and execution

Include this section only when runtime coverage was captured.

First define the capture in plain language:

- page or interaction, cache setting, ready condition, and capture window;
- runs performed and page, iframe, or worker contexts included;
- browser errors, failed requests, unstable results, missing data, and fixes
  attempted;
- whether exact Chrome protocol coverage or the limited DevTools Coverage
  panel export was used.

Show each run before the result common to every valid repeated run. If the
DevTools panel was used, label any mapped module-wrapper result
`ui-range-inference` rather than precise call-count coverage.

Say explicitly that a zero count for a generated module wrapper means “not
observed in this scenario,” not “unused” or “safe to remove.” Development or
`production-debug` wrapper bytes help locate code but are not confirmed
production savings.

For each important runtime item, show:

1. what the browser loaded or did not execute;
2. the network initiator and Rspack loading cause;
3. the relevant source and consumer;
4. in `audit-only`, the possible change and checks it would need; in `optimize`,
   the applied change and why required behavior is preserved;
5. the unchanged production byte/request facts and, in `optimize`, the measured
   difference;
6. the repeated scenario and, when loading changed, the critical-interaction
   check.

When a deferred-loading change was applied, name the assets removed from first
screen and show that the same assets load when the required interaction runs.

## Results not applied

Keep these separate:

- measured changes that need a user or team decision;
- limits in a dependency package;
- unresolved correctness or runtime risk;
- size estimates from non-production or otherwise non-comparable output.

For each item, state the exact decision, fix, or evidence needed before it can
be applied.

## Changes that did not help

Show the comparable measurement or source evidence that ruled out the expected
cause or saving.

## Remaining large items

List the largest unexplained or constrained sources of JavaScript and the next
action for each. Do not hide them behind a smaller successful change.

## Evidence

Link or name:

- run and capture manifests;
- exact asset lists and measurements;
- source and package locations;
- production build, test, and runtime commands with results.

## Final readability check

Read the report once before delivery. Fix it when:

- a number appears before its meaning or scope;
- a result lacks its loading cause, source, or explanation;
- an applied change is not shown concretely;
- a failed capture, build, or test lacks the actual error and attempted fix;
- non-production or non-comparable bytes look like confirmed savings;
- a conclusion cannot be traced to evidence.

For HTML, also inspect the result, one detailed finding or applied change, the
failure section, and a narrow viewport. Fix clipped text, unexplained
abbreviations, horizontal overflow, and broken evidence links.
