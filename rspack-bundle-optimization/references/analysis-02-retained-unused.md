# Analysis 02: Retained Unused Modules

## Purpose

Enumerate every emitted JS-like module whose exports are unused and explain why it remains. This stage creates a review worklist; it never decides that a side effect is safe to remove.

## Diagnostic Build

Run a production-like diagnostic build with `optimization.concatenateModules:false`. Restore the production value for all size experiments.

Enable stats fields:

- `modules`, `nestedModules`, `chunks`, `assets`, and `reasons`;
- `usedExports`, `providedExports`, and `optimizationBailout`.

Flatten nested modules and inherit chunk/asset membership where required.

## Candidate Rule

Include modules that:

- have `usedExports=[]`, not `null`;
- belong to emitted chunks directly or through a concatenated parent;
- are real JS-like resources.

`usedExports=null` is a separate CommonJS/unknown bucket. A `sideEffects:false` rule cannot make its individual exports analyzable.

Match both `side_effects in source code` and `side effects in source code` bailout text. Preserve the full bailout, line/column, readable post-loader snippet, original resource, source/module size, chunks, and package identity.

## Tools

1. Add `scripts/retained-unused-side-effects-plugin.template.cjs` behind an audit environment flag.
2. Run:

```bash
node scripts/retained-unused-disposition.template.cjs \
  --summary <run>/retained-unused/retained-unused-side-effects-summary.json \
  --out-dir <run>/retained-unused \
  --context <project-root> \
  --decisions <run>/side-effects/side-effects-decisions.json
```

Without a valid agent decisions file, every side-effect bailout remains `source-review-required`; rows without that bailout remain `investigate`. The postprocessor must produce zero `keep` or `safe-experiment` rows by inference alone.

## Conservative Dispositions

- `keep`: agent-verified entry, polyfill, style injection, bootstrap, registration, worker, metadata, or other real import-time behavior.
- `source-review-required`: a side-effect bailout whose complete source and package have not yet been judged by the agent.
- `investigate`: retained without a side-effect bailout or with incomplete graph evidence.
- `safe-experiment`: present only after an explicit matching row in `side-effects-decisions.json` records source and package evidence.
- `unknown`: source/package evidence remains incomplete.

Do not call the sum of source/module sizes removable bytes. Report it as worklist scope. Only an isolated production A/B emitted raw delta is a size result.

## Required Artifacts

- `retained-unused-side-effects-summary.json`
- `retained-unused-disposition.json` and `.md`
- complete per-module rows, including the CJS/unknown context bucket
- a handoff worklist for Analysis 03

The check is `completed-no-op` only when a successful concat-off capture finds zero emitted `usedExports=[]` modules.
