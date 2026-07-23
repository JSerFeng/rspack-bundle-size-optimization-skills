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
