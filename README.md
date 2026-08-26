# Rspack Bundle Optimization Skill

A Codex skill for finding and reducing JavaScript emitted or loaded by Rspack,
Rsbuild, and Rspeedy projects.

## How it works

The bundled scripts record compiler data, the JavaScript Rspack receives after
Babel, SWC, and other loaders, browser request and execution coverage, and
exact raw/gzip bytes. A persistent audit state requires evidence for every
optimization family and candidate. The agent may say the work is complete only
after the deterministic completion gate verifies the final project files,
production builds, measurements, comparisons, and correctness checks.

The workflow is:

1. identify the real production command, compiler version, and JavaScript
   scopes to measure;
2. capture the unchanged build in a fresh data run;
3. evaluate every applicable optimization family and give every discovered
   candidate an evidence-backed terminal disposition;
4. when changes are requested, make and measure one focused change at a time;
5. apply safe positive candidates to the real project, rebuild the final state,
   and bind its files to final measurements and correctness checks;
6. pass the completion gate, then lead with a plain-language user report and
   keep compiler internals in a technical appendix.

Runtime coverage is optional. Use it only when the question concerns what a
page or interaction loads or executes.

## Contents

- `rspack-bundle-optimization/SKILL.md`: mode selection and main workflow.
- `references/data-capture.md`: capture-plugin setup and output files.
- `references/measurement.md`: exact asset measurement and comparison.
- `references/completion-contract.md`: coverage matrix, candidate states, and
  the deterministic completion requirements.
- `references/agent-analysis.md`: shared source, chunk, export-usage, and
  completion checks.
- `references/dynamic-imports.md`: dynamic-import grouping, magic comments,
  and namespace export lists.
- `references/ecmascript-target.md`: ECMAScript/browser target comparisons.
- `references/runtime-coverage.md`: Chrome/V8 capture, mapping, and replay.
- `references/report-template.md`: final report structure.

Scripts:

- `create-audit-run.cjs`: creates a run, initializes `audit-state.json`, and
  records file fingerprints.
- `audit-state.cjs`: snapshots the applied project state and rejects incomplete
  coverage, unapplied safe candidates, stale evidence, or unbound final output.
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
