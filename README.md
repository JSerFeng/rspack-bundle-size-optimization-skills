# Rspack Bundle Size Optimization Skill

A skill for **analyzing and reducing bundle size** in Rspack-family builds (`Rspack`, `Rsbuild`, `Rspeedy`). It is evidence-driven: it establishes a reproducible baseline, runs env-gated experiments, quantifies every change in bytes, and stops when only real residuals remain — instead of guessing.

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
- **Per-export verification** — the script *triages* all used exports cheaply; unresolved exports are then confirmed through source inspection, grouped by terminal root and processed until coverage is explicit. "The script said needs-confirmation" is not an acceptable final state for any export.
- **Reference-kind / artifact check (source-backed)** — "used" can be a false positive: with `emitDecoratorMetadata` a type-only import becomes a runtime `_ts_metadata("design:type", X)` reference; swc `env.mode:"usage"` injects polyfills; barrels/helpers forward symbols. The skill captures the **post-loader source** (`module.originalSource()` — what rspack actually saw, where artifacts live) so every reference site can be classified as genuine use or an artifact from the actual code. It does *not* hard-code a pattern, so it is not limited to artifact shapes anticipated in advance. The `show-post-loader` helper surfaces candidates and their source; source inspection determines the verdict.

## Requirements

- A skill-compatible coding environment with local filesystem and shell access.
- A Rspack/Rsbuild/Rspeedy project to analyze.
- **Export Usage Roots** mode uses rspack's built-in export-usage graph (`experiments.RsdoctorPlugin({ exportUsageGraph: true })`), which requires **`@rspack/core` >= 2.1.0**. Older versions: build a dev binding from `main`, or fall back to `@rsdoctor/rspack-plugin`.

## Install

### Install with the Skills CLI (recommended)

Install into the current project:

```bash
npx skills add JSerFeng/rspack-bundle-size-optimization-skills --skill rspack-bundle-optimization
```

To make the skill available across projects, add `--global`:

```bash
npx skills add JSerFeng/rspack-bundle-size-optimization-skills --skill rspack-bundle-optimization --global
```

### Install manually

Copy the skill folder into the skills directory used by your coding environment:

```bash
git clone https://github.com/JSerFeng/rspack-bundle-size-optimization-skills.git
SKILLS_DIR=/path/to/your/skills
cp -r rspack-bundle-size-optimization-skills/rspack-bundle-optimization "$SKILLS_DIR/"
```

(or symlink it). The exact directory and discovery mechanism depend on the environment.

## Use

In a Rspack-family project, invoke the skill or ask your coding environment, e.g.:

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
    ├── show-post-loader.template.cjs                    # read post-loader source for reference-kind / artifact review
    ├── cjs2esm-package-size-diff.cjs                    # package-level size delta for CJS->ESM experiments
    └── optimization-summary-template.md                 # consistent report template
```

## License

[MIT](LICENSE).
