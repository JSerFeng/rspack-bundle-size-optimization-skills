# Data Capture

## Purpose

Capture facts that the agent cannot reconstruct reliably from source files or
the final output alone.

The capture tool does not identify candidates or explain the data.

## Required identity

Every capture requires:

- a run id;
- a unique top-level compiler id;
- a fresh output directory inside the isolated run;
- the real production build command and environment.

Use a separate compiler id and directory for web, node, worker, or other
top-level compilers. Never merge records from different compilers implicitly.

## Wiring

Copy or reference
`scripts/rspack-data-capture-plugin.template.cjs` from the final Rspack config
mutation point.

Direct Rspack example:

```js
const {
  RspackBundleDataCapturePlugin,
} = require("<skill>/scripts/rspack-data-capture-plugin.template.cjs");

if (process.env.RSPACK_BUNDLE_CAPTURE === "1") {
  config.plugins ||= [];
  config.plugins.push(
    new RspackBundleDataCapturePlugin({
      rspack,
      runId: process.env.RSPACK_BUNDLE_RUN_ID,
      compilerId: "web",
      outDir: process.env.RSPACK_BUNDLE_CAPTURE_DIR,
      captureExportUsage: true,
      captureSources: true,
    }),
  );
}
```

For Rsbuild or another framework, inject the same plugin through its final
Rspack configuration hook. Pass the already imported `rspack` object when
export-usage capture is requested; do not load a second compiler instance.

## Artifacts

The plugin writes factual artifacts only:

- `compilation-data.json`
  - resolved configuration snapshot;
  - raw Stats JSON;
  - emitted asset records;
  - module identifiers, final module ids, concatenation membership, and
    compiler-provided export states;
  - chunk records with asset files and id-to-identifier mappings;
  - chunk-group, entrypoint, and connection records;
- `export-usage.json`
  - raw Rsdoctor modules and export-usage edges when supported;
- `post-loader-sources.jsonl`
  - complete captured `module.originalSource()` text;
- `post-loader-index.json`
  - module identifier/resource, line, byte count, and source hash for lookup;
- `capture-manifest.json`
  - artifact sizes and hashes.

The artifacts intentionally contain no `candidate`, `opportunity`, `verdict`,
`priority`, `risk`, or `rootCause` fields.

## Agent use

The agent reads and queries these artifacts with ordinary tools such as
`jq`, `rg`, `scripts/read-capture.cjs`, and
`scripts/extract-export-usage-context.cjs`.

Examples:

```bash
jq '.assets' <capture>/compilation-data.json

jq '.modules[] | select(.usedExports == [])' \
  <capture>/compilation-data.json

jq '.chunks[] | {id, name, files, modules}' \
  <capture>/compilation-data.json

node <skill>/scripts/read-capture.cjs \
  --dir <capture> \
  --source "package/path.js"

node <skill>/scripts/extract-export-usage-context.cjs \
  --dir <capture> \
  --project-root <audited-package-root> \
  --target "provider/package/path.js" \
  --export "highImpactExport" \
  --out <run>/notes/high-impact-export-context.json
```

Those queries expose facts. The agent must read the importing source, graph
context, package metadata, and output before drawing a conclusion.

The export-context query reads raw edges in Rspack's
`consumer -> provider` direction. It preserves every matched edge and its
dependency id/location, extracts a bounded consumer snippet, and reports the
complete enclosing top-level syntax owner plus nested callable chain when
the captured source can be parsed. It refuses an unfiltered whole-graph dump
and an implicit truncation. Raise `--max-matches` explicitly or narrow the
provider/export filters.

The script resolves `@babel/parser` from the audited package. Pass
`--project-root` when capture metadata does not identify a package that
provides it. A missing parser still permits location snippets to be captured,
but the output is `complete:false`, exits non-zero, and names every affected
edge. Source ambiguity, missing `loc`, out-of-bounds coordinates, parser
recovery, and missing owners are likewise explicit failures rather than
silent negative results.

When browser runtime coverage is in scope, the final module ids,
concatenation membership, and chunk asset files provide the compiler side of
the mapping. Read `runtime-coverage.md`; do not infer runtime execution from
compiler membership alone.

## Failure handling

- A failed production compilation produces no complete capture.
- Existing artifacts are never overwritten.
- Missing Rsdoctor export-usage support is recorded as unavailable data unless
  `requireExportUsage:true` was requested.
- A missing source is a factual gap, not evidence that a module is unused or
  removable.
- A browser coverage export, source, target, or module-boundary mismatch must
  retain its concrete failure reason. Attempt a fresh capture or exact-source
  repair before accepting an incomplete runtime scope.
