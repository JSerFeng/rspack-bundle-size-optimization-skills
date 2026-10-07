# Rspack Bundle Optimization Skill

A Codex skill for finding and reducing JavaScript emitted or loaded by Rspack,
Rsbuild, and Rspeedy projects.

## How it works

The skill includes a local export-usage capture plugin and an agent-facing JSON
query CLI. Capture a production build once, then search modules, page through
exports and references, trace bounded importer graphs, or load the source and AST
ownership for a single reference. SQLite indexes keep normal queries independent
of the full graph and source payloads. Mapping gaps and coordinate ambiguity are
returned explicitly. See the [query guide](rspack-bundle-optimization/references/usage-query.md).

For other measurements, the agent writes temporary scripts or plugins as needed
for the project's compiler version and the question being investigated, using
existing project tools where suitable.

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
- [usage-query.md](rspack-bundle-optimization/references/usage-query.md): install, capture, and query the local usage snapshot on demand.
- [usage-graph-source-mapping.md](rspack-bundle-optimization/references/usage-graph-source-mapping.md): native export chains, source-map projection, and source ownership.
- [measurement.md](rspack-bundle-optimization/references/measurement.md): exact asset measurement and comparison.
- [agent-analysis.md](rspack-bundle-optimization/references/agent-analysis.md): chunk, export-usage, and syntax-transform analysis.
- [report-template.md](rspack-bundle-optimization/references/report-template.md): final report structure.

## Install

```bash
npx skills add JSerFeng/rspack-bundle-size-optimization-skills \
  --skill rspack-bundle-optimization
```

Add `--global` only for a global installation.

The query tool requires Node.js 22.13+; install its dependencies with
`npm ci --prefix <installed-skill>/scripts --omit=dev`. It does not install Rspack
into the application or change its optimization settings.

## License

[MIT](LICENSE).
