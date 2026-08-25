# Dynamic Import Analysis

Read this reference when a material finding concerns dynamic-import grouping,
magic comments, or namespace export usage.

## Explain imports that load together

Search disk and post-loader source for `webpackChunkName`, `rspackChunkName`,
`webpackMode`, and `rspackMode`. Include parser defaults and keep top-level
compilers separate.

For each import, record its source location, requested module or context,
effective chunk name and mode, importing route, and captured chunk group. Use
compiler messages and emitted output to resolve comment recognition, prefix
precedence, and placeholder expansion.

Group imports by effective captured chunk group. Shared names can merge lazy
roots; `eager`, `weak`, and `lazy-once` create different boundaries; later
chunk optimization can split one group into several files. Compare route
bytes, requests, ordering, cache behavior, and required interactions for any
boundary change.

## Dynamic imports used as namespaces

A namespace use receives the module object. Map all export-usage rows back to
the original source `import()` before Babel or SWC lowering, then follow every
property read, destructuring statement, alias, helper call, return, assignment,
and stored reference reachable from that call site.

The export list is complete when every reachable use resolves to literal
provider names:

- `ns.foo` and `ns["foo"]` resolve to `foo`;
- destructuring records the provider name, including `default`, independently
  of the local alias;
- non-literal keys, rest, spread, enumeration, reflection, re-export, or
  unresolved passing, returning, or storage leave the list incomplete;
- import-only execution requires a side-effect conclusion.

When complete, record the proposed comment in `audit-only`. In `optimize`, add
the provider names to the original import:

```js
const { foo, bar: localBar } = await import(
  /* rspackExports: ["foo", "bar"] */
  "pkg"
);
```

Use one verified export-list comment and preserve unrelated magic comments.
Prefer `rspackExports`; retain an existing `webpackExports` convention when the
compiler that actually runs proves support for it.

Verify the executing compiler version, parser diagnostics, post-loader source,
recaptured export usage, and emitted output. The dynamic `import()` and comment
must remain visible to Rspack after loaders. Compare identical production
total, initial, and relevant async scopes; a retained optimization has a
measured effect in its intended scope.
