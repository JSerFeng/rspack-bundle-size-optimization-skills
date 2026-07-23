# Rspack Bundle Optimization Skill

An agent-driven skill for auditing and optimizing Rspack, Rsbuild, and
Rspeedy bundles.

The repository deliberately keeps JavaScript tooling small. Bundled scripts
may capture compiler facts, persist evidence, read captured source, and
measure emitted bytes. They must not rank opportunities, infer semantic
usage, decide purity, recommend changes, assign risk, or write the analysis
for the agent.

## Responsibility boundary

### JavaScript tools

- capture resolved Rspack configuration, stats, module/chunk relationships,
  export-usage edges, and post-loader source;
- create an isolated run and fingerprint evidence;
- measure exact raw and deterministic gzip bytes;
- compare two measurements without interpreting the delta;
- retrieve captured source on demand.

### Agent

- identify the largest byte surfaces;
- form and rank optimization hypotheses;
- inspect graph, source, package metadata, and generated output;
- distinguish real usage from mechanical retention;
- design and implement source/config/dependency changes;
- judge semantic and product risk;
- run production-comparable experiments and tests;
- author the final report and decide whether the audit reached a supported
  fixed point.

## Core workflow

1. Inspect the project, production command, compiler version, dirty state,
   supported browsers, and validation commands.
2. Create an isolated data run.
3. Capture an unchanged production baseline and exact asset measurements.
4. Let the agent analyze the captured facts, starting with the largest
   initial/route/total byte surfaces.
5. In optimize mode, test one agent-authored hypothesis at a time.
6. Apply only measured, source-backed changes whose relevant risks have been
   checked.
7. Capture a fresh final baseline and let the agent write the report.

## Scripts

```text
scripts/
├── create-audit-run.cjs
├── rspack-data-capture-plugin.template.cjs
├── measure-assets.cjs
└── read-capture.cjs
```

- `create-audit-run.cjs`: creates a run, records commands and artifact
  fingerprints, and verifies that recorded evidence has not changed.
- `rspack-data-capture-plugin.template.cjs`: captures raw compiler facts from
  a successful compilation.
- `measure-assets.cjs`: records exact raw/gzip asset data and mechanically
  compares two measurements.
- `read-capture.cjs`: lists or prints captured post-loader source without
  classifying it.

See:

- `references/data-capture.md`
- `references/agent-analysis.md`
- `references/measurement.md`
- `references/report-template.md`

## Install

```bash
npx skills add JSerFeng/rspack-bundle-size-optimization-skills \
  --skill rspack-bundle-optimization
```

Add `--global` only when a global installation is intended.

## License

[MIT](LICENSE).
