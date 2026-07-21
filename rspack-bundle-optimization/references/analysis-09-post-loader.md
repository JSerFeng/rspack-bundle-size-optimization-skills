# Analysis 09: Post-Loader Source Quality

## Purpose

Prove that every source-backed conclusion uses complete, readable loader output with trustworthy locations. This route validates evidence quality; it does not infer removability.

## Capture

Capture post-loader sources from the same run and compilation family used by retained-unused, side-effects, export-usage, Rollup-diff, and ECMA conclusions. Reuse the shared capture when it is fresh; do not rebuild merely to create a second copy.

Use:

- `scripts/export-usage-capture-plugin.template.cjs` for the complete source capture;
- `scripts/show-post-loader.template.cjs --list --minified` to inspect inventory and `sourceQuality`;
- the route-specific source indexes and hashes to join candidates to their exact captures.

`optimization.minimize:false` is not proof of readable source because an upstream Babel, SWC, or custom loader may still emit compact one-line output.

## Complete Worklist

Account for:

- every candidate referenced by another route;
- every missing post-loader source or missing source location;
- every source flagged compact, minified, truncated, malformed, or hash-stale;
- every candidate whose disk source and post-loader source disagree materially;
- every whole-module or namespace import whose consumer location needs source confirmation.

A top-N source list is not sufficient. A candidate without readable post-loader evidence remains unresolved even when its disk source is readable.

## Repair Low-Quality Evidence

For every low-quality capture:

1. capture the loader chain or trace;
2. identify the compactor or source-loss stage;
3. disable only that audit-time compaction when safe and bust its cache identifier;
4. recapture into a fresh artifact path;
5. verify line count, maximum line length, syntax readability, source location, and hash linkage.

Do not change the normal production transformation to make an optimization result look better. Audit-only readability changes are diagnostic and cannot contribute confirmed savings.

## Required Artifacts

- complete post-loader source inventory and index;
- immutable source artifacts and hashes for every cross-route candidate;
- source-quality findings and repair commands;
- candidate-to-source/location coverage summary;
- explicit blocked rows for evidence that cannot be made readable.

## Completion Gate

Complete this route only when every cross-route candidate has fresh, readable post-loader evidence and a trustworthy source location, or has an evidence-backed `blocked` disposition. Zero flagged sources is `completed-no-op` only after a successful complete inventory. Missing capture capability, unreadable required sources, stale hashes, or unresolved locations are blockers, not no-op proofs.
