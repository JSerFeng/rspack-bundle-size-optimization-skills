# Rspack Bundle Optimization Skill

A Codex skill for finding and reducing JavaScript emitted or loaded by Rspack,
Rsbuild, and Rspeedy projects.

## How it works

The bundled scripts record compiler data, the JavaScript Rspack receives after
Babel, SWC, and other loaders, browser request and execution coverage, and
exact raw/gzip bytes. They only collect facts. The agent decides what should
change and, when changes are requested, verifies any savings in a production
build.

The workflow is:

1. identify the real production command, compiler version, and JavaScript
   scopes to measure;
2. capture the unchanged build in a fresh data run;
3. inspect the largest relevant sources of total, initial, or route JavaScript;
4. when changes are requested, make one focused change at a time;
5. compare the same production scopes before and after, then run the required
   correctness checks;
6. for analysis only, report the unchanged build and unmeasured suggestions;
   after edits, measure the final build and separate confirmed changes, changes
   that did not help, blocked items, and remaining work.

Runtime coverage is optional. Use it only when the question concerns what a
page or interaction loads or executes.

## Contents

- `rspack-bundle-optimization/SKILL.md`: mode selection and main workflow.
- `references/data-capture.md`: capture-plugin setup and output files.
- `references/measurement.md`: exact asset measurement and comparison.
- `references/agent-analysis.md`: source, chunk, export-usage, namespace, and
  completion checks.
- `references/runtime-coverage.md`: Chrome/V8 capture, mapping, and replay.
- `references/report-template.md`: final report structure.

Scripts:

- `create-audit-run.cjs`: creates a run and records file fingerprints.
- `rspack-data-capture-plugin.template.cjs`: captures compiler, graph,
  chunk, export-usage, and source data.
- `measure-assets.cjs`: measures exact raw/gzip bytes and compares two
  measurements.
- `read-capture.cjs`: lists or reads captured source.
- `extract-export-usage-context.cjs`: joins export-usage edges to source
  locations and containing code.
- `normalize-runtime-coverage.cjs`: maps exact Chrome/V8 coverage to
  generated wrappers around Rspack modules.
- `verify-runtime-coverage-artifacts.cjs`: checks runtime-capture files for
  missing or inconsistent data.

## Install

```bash
npx skills add JSerFeng/rspack-bundle-size-optimization-skills \
  --skill rspack-bundle-optimization
```

Add `--global` only for a global installation.

## License

[MIT](LICENSE).
