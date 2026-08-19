# Analyzing Captured Data

Bundled scripts provide records and arithmetic. The agent decides why code is
present, whether it should change, and whether the result is safe.

## Start with the bytes that matter

Use the exact definitions in [measurement.md](measurement.md) and keep these
asset sets separate:

- total emitted JavaScript for one compiler;
- HTML-requested initial JavaScript;
- entrypoint-initial JavaScript;
- a static route or async chunk group;
- JavaScript actually requested during a route or interaction.

Within each set, distinguish first-party, third-party, runtime, helper, and
polyfill code, duplicate modules or package versions, and large assets whose
source is unclear.

Module size and source size help choose what to read first. They are not
confirmed savings.

Common areas worth checking include:

1. large packages or features loaded before they are needed;
2. broad package, barrel, namespace, or dynamic imports;
3. duplicate package versions or code repeated across chunks;
4. dev, mock, debug, registration, or side-effect code in production;
5. CommonJS or mixed-module packages that prevent export pruning;
6. shared dynamic-import names and splitChunks rules that load unrelated code
   together;
7. transform targets, helpers, locales, icons, and polyfills;
8. CSS, WASM, and workers when they affect the requested metric;
9. browser-loaded assets whose generated module wrappers did not run in any
   complete repeated scenario.

Choose the order from project evidence; this list is not a required sequence.

## When runtime data exists

First verify the capture using
[runtime-coverage.md](runtime-coverage.md#verify-the-capture). For each
important loaded asset or generated module wrapper with no observed execution,
trace:

1. browser URL and network initiator;
2. Rspack asset, chunk, chunk group, entry or async root;
3. the splitChunks rule, when one applies;
4. importing module and source-level loading boundary;
5. complete module and consumer source;
6. other required scenarios and critical interactions;
7. whether the product intends the feature to be available at that point.

A zero count alone does not show that code is unused or safe to defer.
`production-debug` byte counts for generated module wrappers help locate code;
only the matching production request or asset difference confirms a saving.

## Explain why dynamic imports load together

Before blaming splitChunks, search both disk source and source after loaders
for `webpackChunkName`, `rspackChunkName`, `webpackMode`, and `rspackMode`
on dynamic `import()` calls. Include project parser defaults and keep
top-level compilers separate.

For each import, record its source location; the requested module, or all
possible modules for a context import; the chunk name and import mode Rspack
actually used; the importing module or route; and the chunk group recorded by
the compiler. Use compiler messages and emitted output to resolve ignored
comments, prefix precedence, and `[request]` or `[index]` expansion.

`eager` and `weak` do not create the same lazy boundary as an ordinary dynamic
import. `lazy-once` can group all requests from one context import.

Group imports by the captured effective chunk group, not by comment text alone.
Reusing one effective name can connect several lazy imports to the same group,
so triggering one import can load modules introduced by another. Nested
dynamic imports keep their own boundary unless their effective options also
merge them. Later chunk optimization may split one group into several files.

Only after checking those relationships should splitChunks be treated as the
cause. When changing the boundary, compare route bytes, requests, loading
order, cache behavior, and the interaction that must still work.

## Keep notes for each important item

Store agent-written notes under `<run>/notes/`. Record:

- affected assets, chunks, modules, packages, and import sites;
- evidence files and source locations;
- why the code is present;
- the change being considered and its likely effect;
- correctness and product risks;
- final conclusion.

In `audit-only`, record the unchanged production measurement and mark every
suggested change as unmeasured. In `optimize`, also record the before/after
production result and the relevant build, test, and runtime checks.

For runtime items, also record the scenario, run number, initiator, target
type, loading cause, module-wrapper execution count, and required-interaction
result.

## Read source before deciding

For side effects and export usage, inspect:

- complete disk source and source after loaders;
- top-level calls, assignments, registration, mutation, DOM/style work,
  environment reads, worker setup, and import-only execution;
- the nearest `package.json`, especially `exports`, `sideEffects`,
  conditions, `module`, `main`, `browser`, and `type`;
- consumer import/reference sites;
- relevant entries, async boundaries, chunks, and runtime behavior.

`usedExports`, `providedExports`, bailouts, and export-usage edges describe
one build. They do not decide whether the product needs the code.

### Review export usage in source

For an important provider/export, inspect every resolved use, not only the
aggregate `usedExports` value:

```bash
node <skill>/scripts/extract-export-usage-context.cjs \
  --dir <capture> \
  --project-root <audited-package-root> \
  --target "provider/package/path.js" \
  --export "exportName" \
  --out <run>/notes/export-context.json
```

Read each snippet, the complete top-level function, variable, or export that
contains it, the path through nested callbacks, the import boundary, and then
the complete source.

The field `mechanicalOwnerToTargetExport`, for example
`foo -> usedFoo`, describes syntax only. Confirm product intent from the
provider and consumer source, route/chunk reason, runtime behavior, and
production output.

Missing locations, ambiguous source, parser recovery, omitted containing code,
or a missing callback path must not become “no usage.” Fix the capture or
record the exact missing data and affected edges.

#### Dynamic imports used as namespaces

A namespace use receives the module object instead of one named export. When
namespace rows are numerous or affect large modules, map every row back to the
source `import()` that created it. One import can create several graph rows,
so graph-row count is not the number of source edits.

Start with the original source before Babel or SWC transforms it. Follow every
property read, destructuring statement, alias, helper call, return, assignment,
and stored reference. A transform may keep the `import()` call while breaking
Rspack's link from later property reads back to that import; this is why the
export list must be derived before lowering.

Collect names with these rules:

- `ns.foo` and `ns["foo"]` use `foo`;
- destructuring uses the imported property name, including `default`, not its
  local alias;
- a non-literal key, rest property, spread, enumeration, reflection,
  re-export, or unresolved passing/returning/storing means the list is not
  complete;
- an import used only to run a module requires side-effect analysis; do not
  infer an empty export list from the absence of property reads.

Combine names from every consumer reachable from the result of the same source
`import()` call site. Do not use one graph row, one destructuring statement,
or one runtime scenario as the complete list.

Once every reachable consumer has been resolved and the complete export-name
list is known, record the proposed comment without editing tracked source in
`audit-only`. In `optimize`, add `rspackExports` at the original dynamic
import:

```js
const ns = await import(
  /* rspackExports: ["foo"] */
  "pkg"
);
ns.foo();
```

For destructuring, the comment still uses provider export names:

```js
const { foo, bar: localBar } = await import(
  /* rspackExports: ["foo", "bar"] */
  "pkg"
);
```

Use `rspackExports` for Rspack. Preserve unrelated magic comments. If the
import already has `rspackExports` or `webpackExports`, update one verified
list instead of leaving duplicate or conflicting export lists. Keep
`webpackExports` only when existing project code already uses it and a build
with the compiler that actually runs proves that name is recognized.

Verification means identifying the compiler version that actually runs,
checking any parser warning or error, recapturing export usage, and inspecting
the emitted output. A package manifest version alone is not enough when the
project can load another compiler installation.

Then inspect source after loaders. Babel or SWC may lower the surrounding
`await` flow, but the dynamic `import()` and comment must still be present
where Rspack can parse them. If any namespace use remains unknown, do not guess
the list.

Capture export usage again and confirm that Rspack now treats only the intended
named exports as used. Inspect emitted chunks and compare total, initial, and
relevant async raw bytes before and after with the same production settings;
show gzip second. If the output does not improve, report no measured
bundle-size effect.

### Explain ECMAScript target changes

When a newer ECMAScript target changes size, do not attribute the entire
difference to polyfills or newer syntax. Separate:

- polyfill assets and modules;
- modules added or removed;
- modules present in both builds whose generated bytes changed;
- loader, transpiler, and runtime-helper output;
- chunk membership and concatenation changes.

Inspect source before and after loaders for the largest changed modules. If
source maps or per-module details are incomplete, report the missing data
instead of assigning the unexplained bytes to the target change.

## Compare a change (`optimize` only)

- Change one thing at a time.
- Preserve the unchanged production build and measurement.
- Restore production minimization and concatenation for size measurement.
- Keep entries, dependencies, feature flags, and unrelated config unchanged.
- Explain each meaningful asset, module, or chunk change.
- Repeat the same runtime scenario when initial or route loading changes.
- Drop a change when a comparable build shows no relevant improvement or
  disproves its cause.
- Do not keep a browser-support target, dependency, public API, or product
  behavior change without authorization.

## Finish the analysis

Before finishing, show:

- which large sources of JavaScript were examined;
- which important changes were proposed or, in `optimize`, applied and checked;
- what remains unexplained;
- which remaining items are required, too risky, need a user or team decision,
  depend on another package, were ruled out, or are blocked;
- the unchanged production measurement in `audit-only`, or a fresh final
  production measurement after applied changes in `optimize`.

Do not present a small saving as the whole result while larger in-scope items
remain unexplained.
