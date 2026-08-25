# Data Capture

Use the capture plugin for compiler facts that source files and final assets
cannot reconstruct reliably.

## Set up the capture

Give every run a unique run id and every top-level compiler its own id and
fresh directory. Keep web, node, worker, and other compiler records separate
and use the real production command and environment.

In `audit-only`, attach capture through an existing audit hook or ignored
wrapper. A tracked capture integration belongs to `optimize` or separate user
authorization.

Add `scripts/rspack-data-capture-plugin.template.cjs` at the final Rspack
configuration hook:

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

For Rsbuild or another framework, use its final Rspack-config hook. Pass the
compiler instance already used by the build; export-usage graph objects must
come from that same instance.

The capture integration changes only evidence collection. Keep normal entries,
chunks, assets, and production settings stable. Disable the environment flag
and remove temporary ignored wrappers before delivery.

## Output files

- `compilation-data.json`: resolved config, Stats data, assets, modules, export
  states, chunks, groups, entrypoints, and connections.
- `export-usage.json`: raw Rsdoctor modules and export-usage edges when
  supported by the executing compiler.
- `post-loader-sources.jsonl`: complete `module.originalSource()` text received
  by Rspack after loaders.
- `post-loader-index.json`: source lookup data and hashes.
- `capture-manifest.json`: output sizes and hashes.

A complete capture comes from a successful production build. The tools use
fresh output paths and preserve earlier evidence. When export-usage data is
unavailable, record the gap; `requireExportUsage:true` makes that field a
required capture result.

## Read compiler data

```bash
jq '.assets' <capture>/compilation-data.json

jq '.modules[] | select(.usedExports == [])' \
  <capture>/compilation-data.json

jq '.chunks[] | {id, name, files, modules}' \
  <capture>/compilation-data.json

node <skill>/scripts/read-capture.cjs \
  --dir <capture> \
  --source "package/path.js"
```

Connect these records to importing source, package metadata, graph edges, and
emitted output during analysis.

## Read export-usage context

```bash
node <skill>/scripts/extract-export-usage-context.cjs \
  --dir <capture> \
  --project-root <audited-package-root> \
  --target "provider/package/path.js" \
  --export "exportName" \
  --out <run>/notes/export-context.json
```

Rspack records edges as `consumer -> provider`. The script retains every
matched edge and location, adds source context and containing declarations,
and shows nested callback ownership. Filter by provider or export; use
`--max-matches` explicitly when a wider result is intentional.

The script resolves `@babel/parser` from the audited package. Pass
`--project-root` when capture metadata cannot identify it. A nonzero exit and
`complete:false` identify missing or ambiguous source, locations, parser
results, or containing code; carry that gap into the affected conclusion.

For browser coverage, connect final module ids, concatenation membership, and
chunk files using [runtime-coverage.md](runtime-coverage.md).
