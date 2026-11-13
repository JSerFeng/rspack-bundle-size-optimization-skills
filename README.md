# Rspack Bundle Optimization Skill

A Codex skill for finding and reducing JavaScript emitted or loaded by Rspack,
Rsbuild, and Rspeedy projects.

## How it works

The skill bundles a local query CLI in `scripts/`. It indexes captured coverage
and export-usage evidence, then returns bounded JSON for sorted module lists,
coverage lines, references, export chains, and source windows without a report UI.
The agent writes temporary capture plugins when needed for the project's compiler
version and measures optimization results with the project's production tools.

The workflow is:

1. identify the real production command, compiler version, and JavaScript
   scopes to measure;
2. save an unchanged production baseline and its measurements;
3. evaluate every applicable optimization family and explain the evidence for
   each candidate;
4. when changes are requested, make and measure one focused change at a time;
5. apply safe positive candidates to the real project, rebuild the final state,
   and verify the final measurements and correctness;
6. report the measured results, applied changes, and remaining gaps in plain
   language.

Runtime coverage is optional. Use it only when the question concerns what a
page or interaction loads or executes.

## Contents

- [SKILL.md](rspack-bundle-optimization/SKILL.md): main workflow and on-demand tooling.
- [data-capture.md](rspack-bundle-optimization/references/data-capture.md): compiler facts, source context, and optional runtime coverage.
- [query-cli.md](rspack-bundle-optimization/references/query-cli.md): local indexing, ranking, pagination, and evidence queries (Node >=22.13).

## Install

```bash
npx skills add JSerFeng/rspack-bundle-size-optimization-skills \
  --skill rspack-bundle-optimization
```

Add `--global` only for a global installation.

## License

[MIT](LICENSE).
