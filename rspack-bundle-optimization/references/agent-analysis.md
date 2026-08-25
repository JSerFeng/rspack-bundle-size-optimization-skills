# Analyzing Captured Data

Turn measured asset scopes into causal, source-backed findings.

## Prioritize the bytes that matter

Use the scope definitions in [measurement.md](measurement.md). Keep these
surfaces distinct:

- total emitted JavaScript for one compiler;
- HTML-requested and entrypoint-initial JavaScript;
- a static route or async chunk group;
- JavaScript requested during a named route or interaction.

Production whole-asset measurements confirm savings. Module, post-loader, and
disk-source sizes help rank investigation. Within the requested surface, start
with the largest unexplained contributors and classify first-party,
third-party, runtime, helper, polyfill, duplicated, and unmapped code.

Common high-impact causes include eager features, broad imports, duplicate
package versions, production registration or debug code, CommonJS boundaries,
merged dynamic-import groups, transform helpers, locales, icons, polyfills,
CSS, WASM, and workers. Choose from project evidence rather than following
this list as a checklist.

## Trace runtime loading

Verify runtime artifacts with
[runtime-coverage.md](runtime-coverage.md#verify-the-capture). For each
material loaded asset or generated module wrapper, connect:

1. browser URL and network initiator;
2. emitted asset, chunk, chunk group, entry, or async root;
3. matching splitChunks rule, when present;
4. importing module and source loading boundary;
5. complete module and consumer source;
6. required scenarios and product intent at that point.

Interpret an execution count as evidence for the recorded scenario. Use the
matching production asset or request difference to confirm a loading saving.

## Keep decision notes

Store concise notes for each material finding under `<run>/notes/`:

- affected scope, assets, chunks, modules, packages, and import sites;
- evidence files and source locations;
- loading or emission cause;
- proposed or applied change and expected mechanism;
- correctness and product risks;
- measurement, checks, and disposition.

Runtime notes also identify scenario, repetition, initiator, target type,
wrapper execution count, and critical-interaction result. Audit notes label
proposals as unmeasured; optimize notes include comparable production results.

## Read source before deciding

For side effects and export usage, inspect complete disk and post-loader
source, consumers, and the nearest `package.json`. Pay attention to top-level
calls, assignments, registration, mutation, DOM/style work, environment reads,
worker setup, import-only execution, `exports`, `sideEffects`, conditions,
`module`, `main`, `browser`, and `type`.

Compiler export fields describe one build. Source and consumers establish why
the product needs the code.

### Review export-usage edges

For an important provider or export, extract every matching edge:

```bash
node <skill>/scripts/extract-export-usage-context.cjs \
  --dir <capture> \
  --project-root <audited-package-root> \
  --target "provider/package/path.js" \
  --export "exportName" \
  --out <run>/notes/export-context.json
```

Read each snippet, its complete enclosing declaration, the path through nested
callbacks, the import boundary, and the complete source. Fields such as
`mechanicalOwnerToTargetExport` describe syntax; combine them with provider
semantics, route/chunk cause, runtime behavior, and production output.

Treat `complete:false`, missing locations, ambiguous sources, parser recovery,
or missing containing code as a named evidence gap affecting those edges.

## Verify an optimization

For each experiment:

- preserve the unchanged production measurement;
- isolate the causal source or configuration change;
- restore production minimization and concatenation for size measurement;
- keep unrelated entries, dependencies, feature flags, and settings stable;
- explain material asset, module, and chunk changes;
- repeat affected runtime scenarios and correctness checks;
- retain the change when the comparable result improves the intended scope
  and remains within the user's compatibility and product constraints.

## Complete the analysis

Finish with the material JavaScript sources examined, accepted or proposed
changes, comparable measurements, relevant checks, evidence gaps, and concrete
next decisions. Keep the conclusion centered on the user's goal and make any
material unexplained remainder visible.
