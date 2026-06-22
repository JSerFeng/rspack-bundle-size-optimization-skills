# Rspack Bundle Size Optimization — Claude Code Skill

A [Claude Code](https://claude.com/claude-code) skill for **understanding and reducing bundle size** in Rspack-family builds (`rspack`, `rsbuild`, `rspeedy`). It is evidence-driven: it establishes a reproducible baseline, runs env-gated experiments, quantifies every change in bytes, and stops when only real residuals remain — instead of guessing.

## What it does

The skill drives a sequence of analyses, each with a clear stop condition:

| Mode | Question it answers |
|---|---|
| **Quick Triage** | Where is the size — initial vs async, largest assets/modules? |
| **Reachability** | Does a chunk group carry JS modules that load doesn't need? |
| **Retained-Unused** | Which `usedExports=[]` modules survive, and **per module**, is each genuinely dead or a real side effect? (keep / likely-removable / confirm-by-source / investigate, with the true removable upper bound) |
| **Export Usage Roots** | For **every used export**, is it really used or only conservatively retained? Per-export verdict (genuinely-used / needs-source-confirmation / over-retained-suspect), rolled up to terminal roots. |
| **Side Effects** | If candidates are marked `sideEffects:false`, how much JS shrinks? |
| **SplitChunks** | Can shared chunks be split finer to cut per-page load without duplication? |
| **ECMA Level Upgrade** | Does raising transform + minifier target (keeping modern syntax) shrink output? |
| **CJS-to-ESM** | Would a dependency shipping real ESM shake/concatenate better? |
| **Rollup Diff** | Rollup removed an export rspack kept — is there a source pattern to rewrite? |

Three things make the analysis *complete* rather than a sampled candidate list:

- **Per-module disposition** — every `usedExports=[]` module gets a verdict backed by its bailout statement's source snippet.
- **Per-export verification** — the script *triages* all used exports cheaply; an agent (Claude/Codex) then reads source to confirm every export the script could not clear (grouped by terminal root, fanned out with subagents, looped until covered with explicit coverage reporting). "The script said needs-confirmation" is not an acceptable final state for any export.
- **Reference-kind / artifact check (agent-driven)** — "used" can be a false positive: with `emitDecoratorMetadata` a type-only import becomes a runtime `_ts_metadata("design:type", X)` reference; swc `env.mode:"usage"` injects polyfills; barrels/helpers forward symbols. The skill captures the **post-loader source** (`module.originalSource()` — what rspack actually saw, where artifacts live) and the **agent reads each reference site and judges genuine-vs-artifact case by case** — it does *not* hard-code a pattern, so it isn't limited to the artifact shapes someone anticipated. The `show-post-loader` helper surfaces candidates and serves the source; the verdict is the agent's.

## Requirements

- Claude Code (the skill is invoked by the agent).
- A Rspack/Rsbuild/Rspeedy project to analyze.
- **Export Usage Roots** mode uses rspack's built-in export-usage graph (`experiments.RsdoctorPlugin({ exportUsageGraph: true })`), which requires **`@rspack/core` >= 2.1.0-beta.0**. Older versions: build a dev binding from `main`, or fall back to `@rsdoctor/rspack-plugin`.

## Install

Copy the skill folder into your Claude Code skills directory:

```bash
git clone https://github.com/JSerFeng/rspack-bundle-size-optimization-skills.git
cp -r rspack-bundle-size-optimization-skills/rspack-bundle-optimization ~/.claude/skills/
```

(or symlink it). Claude Code discovers it automatically — no config needed.

## Use

In a Rspack-family project, just ask Claude Code, e.g.:

- "Analyze and reduce my rspack bundle size."
- "Run the export-usage analysis and tell me which exports are really used."
- "Why is my initial chunk so big — is it carrying async-able modules?"

The skill starts with **Quick Triage** and recommends the next mode from evidence. The bundled scripts in [`rspack-bundle-optimization/references/`](rspack-bundle-optimization/references/) are wired in behind env flags so normal builds are unaffected.

## Layout

```
rspack-bundle-optimization/
├── SKILL.md                                         # the skill (workflow + all modes)
└── references/
    ├── chunk-group-reachability-plugin.template.cjs   # reachability + interactive chunk graph
    ├── retained-unused-side-effects-plugin.template.cjs # capture usedExports=[] modules + bailouts
    ├── retained-unused-disposition.template.cjs         # per-module verdict + true removable upper bound
    ├── export-usage-capture-plugin.template.cjs         # capture rspack exportUsageEdges + post-loader source store (rspack >= 2.1.0-beta.0)
    ├── build-all-export-usage.template.cjs              # edges -> per-export chains to terminal roots
    ├── export-usage-root-analysis.template.cjs          # per-export + per-root usage verdicts
    ├── show-post-loader.template.cjs                    # read post-loader source on demand so the agent judges reference-kind / artifacts
    ├── cjs2esm-package-size-diff.cjs                    # package-level size delta for CJS->ESM experiments
    └── optimization-summary-template.md                 # consistent report template
```

## License

[MIT](LICENSE).
