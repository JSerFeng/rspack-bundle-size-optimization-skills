# Analysis 03: Side-Effects Source and Package Audit

## Contents

- [Purpose](#purpose)
- [Safety Rule](#safety-rule)
- [Build the Review Worklist](#build-the-review-worklist)
- [Agent Review for Every Candidate](#agent-review-for-every-candidate)
- [Decision Ledger](#decision-ledger)
- [A/B Experiment](#ab-experiment)
- [Required Artifacts](#required-artifacts)
- [Reporting](#reporting)
- [Completion Gate](#completion-gate)

## Purpose

Resolve every retained-unused side-effect candidate through complete source and package review, then measure only agent-confirmed safe experiments in a production-comparable build.

## Safety Rule

Never treat `node_modules`, ESM syntax, an absent `sideEffects` field, `usedExports=[]`, or a bailout string as proof of purity. The agent must inspect the source and package before approving any experiment.

## Build the Review Worklist

Capture readable post-loader sources during the concat-off retained-unused diagnostic build by also enabling `scripts/export-usage-capture-plugin.template.cjs` with `captureAllSources:true`. This shared evidence capture does not complete Analysis 10 early; Analysis 10 later evaluates its quality and completeness.

Run:

```bash
node scripts/side-effects-review-worklist.cjs \
  --summary <run>/retained-unused/retained-unused-side-effects-summary.json \
  --post-loader-jsonl <run>/post-loader/post-loader-sources.jsonl \
  --out <run>/side-effects/side-effects-review-worklist.json \
  --project-root <project-root>
```

The tool collects evidence; it does not make a verdict. Process every row and checkpoint decisions in `<run>/side-effects/side-effects-decisions.json`.

The worklist writes immutable disk-source and post-loader-source artifacts for every captured row, records the nearest package metadata, and fingerprints all three inputs. Open and read both complete source artifacts and the referenced `package.json`; do not decide from the worklist summary fields alone.

## Agent Review for Every Candidate

Read, rather than infer from names:

1. Complete readable post-loader source when captured.
2. Corresponding on-disk source and the exact bailout statement.
3. Every top-level call, assignment, getter, class/static initializer, import-only execution, registration, global mutation, DOM/style operation, worker setup, and environment read.
4. Nearest package `package.json`: name, version, `sideEffects`, `exports`, conditions, `module`, `main`, `browser`, and `type`.
5. Package entry/barrel path and whether import order or re-export evaluation is semantically required.
6. Incoming consumers and whether they import the module only for execution.

When package metadata declares `sideEffects:false`, still inspect the concrete module if Rspack emitted a side-effect bailout; metadata can be stale or overridden by loaders.

## Decision Ledger

Use this schema:

```json
{
  "version": 1,
  "decisions": [
    {
      "resource": "/absolute/module.js",
      "decision": "safe-experiment",
      "packageJson": "/absolute/package.json",
      "sourceHash": "sha256 copied from the fresh worklist",
      "postLoaderSourceArtifact": "/absolute/review-post-loader-sources/module.js.txt",
      "postLoaderSourceHash": "sha256 copied from the fresh worklist",
      "postLoaderSourceReadable": true,
      "packageJsonHash": "sha256 copied from the fresh worklist",
      "sourceEvidence": ["top-level declarations only", "no import-time call"],
      "packageEvidence": ["sideEffects:false", "direct ESM subpath"],
      "risk": "low",
      "reviewedAt": "ISO timestamp"
    }
  ]
}
```

Allowed decisions are `safe-experiment`, `keep`, and `unknown`. `safe-experiment` requires affirmative source and package reasoning. `unknown` must state the missing evidence.

`unknown` is a checkpoint, not a completed conclusion. Any `unknown` or `source-review-required` row keeps this check `blocked`; it cannot be used to claim `completed-no-op`.

Merge the ledger back into the complete retained-unused set:

```bash
node scripts/retained-unused-disposition.template.cjs \
  --summary <run>/retained-unused/retained-unused-side-effects-summary.json \
  --decisions <run>/side-effects/side-effects-decisions.json \
  --context <project-root> \
  --out-dir <run>/side-effects
```

Set `postLoaderSourceReadable:true` only after opening the full artifact and confirming it is not compact/minified beyond reliable review. The merge rejects empty evidence, missing review timestamps, unreadable captures, stale disk-source hashes, stale post-loader-source hashes, and stale package hashes. A side-effect bailout without a valid ledger row remains `source-review-required`. The generated `safeExperimentResources` is the only set allowed into the A/B rule.

## A/B Experiment

Generate the candidate set only from `safe-experiment` rows. Restore production `concatenateModules`, minimization, entries, and splitChunks. Apply an env-gated exact-resource rule:

```js
{ test: resource => confirmedSafeSet.has(resource), sideEffects: false }
```

Build into a new isolated output directory. Compare:

- app-JS and emitted-JS raw first, gzip second;
- assets, chunks, request counts, and module membership;
- removed modules and whether the result matches the approved set.

Run the project's relevant runtime smoke tests before calling the change production-ready. Accumulate approved candidates by explicit union; never carry a module forward after its source changes without re-review.

## Required Artifacts

- complete `side-effects-review-worklist.json` and immutable source artifacts;
- fresh disk-source, post-loader-source, and package hashes;
- agent-authored `side-effects-decisions.json`;
- merged retained-unused disposition JSON and Markdown;
- production A/B asset manifests and raw/gzip comparison;
- build and runtime/test validation results.

## Reporting

Report separately:

- reviewed module count and decision coverage;
- `keep`, `unknown`, and `safe-experiment` module-size scope;
- production A/B emitted raw/gzip delta;
- exact source/package evidence for every experimented module.

Zero safe candidates after every row is reviewed is evidence-backed `completed-no-op`.

## Completion Gate

The agent, not the user, processes every worklist entry. Decision coverage must
be exactly `reviewed == reviewCount`, with zero `unknown`, stale hashes,
`source-review-required`, or unreadable post-loader sources. In `optimize` mode,
a hash-valid safe candidate must proceed through the production A/B and strict
auto-apply gate; otherwise record its concrete residual risk and do not edit.
