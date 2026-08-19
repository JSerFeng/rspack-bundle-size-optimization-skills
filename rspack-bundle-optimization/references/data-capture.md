# Data Capture

Use the capture plugin for compiler data that cannot be reconstructed reliably
from source files or final assets alone. The plugin records data; it does not
recommend or rank changes.

## Set up the capture

Each capture needs:

- a run id;
- a unique id for each top-level compiler;
- a fresh directory inside that run;
- the real production command and environment.

Keep web, node, worker, and other top-level compilers in separate directories.
Do not merge their records.

In `audit-only`, do not change tracked source or config unless the user
separately authorizes a temporary capture setup. Prefer an existing audit hook
or an ignored wrapper. If neither works, report the missing data or ask for
that authorization.

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
already imported `rspack` object when capturing export usage; loading a second
compiler instance can produce incompatible graph data.

The capture setup—the plugin and any wrapper used to inject it—must be the only
temporary build change and must not alter normal entries, chunks, or assets.
Before delivery, disable its environment flag and remove any temporary wrapper;
verify that no audit setup enters the normal production build or the requested
source diff.

## Output files

- `compilation-data.json`: resolved config, raw Stats JSON, assets, modules,
  export states, chunks, groups, entrypoints, and connections.
- `export-usage.json`: raw Rsdoctor modules and export-usage edges when the
  compiler supports them.
- `post-loader-sources.jsonl`: complete `module.originalSource()` text after
  loaders; this is the source Rspack parses.
- `post-loader-index.json`: source lookup data and hashes.
- `capture-manifest.json`: output sizes and hashes.

A failed production build does not produce a complete capture. Existing output
files are never overwritten.

If Rsdoctor export-usage data is unavailable, record that gap. Fail the build
for it only when `requireExportUsage:true` was requested.

## Read the data

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

These commands expose build facts. Read the importing source, package metadata,
graph connection, and emitted output before drawing a conclusion.

## Read export-usage context

```bash
node <skill>/scripts/extract-export-usage-context.cjs \
  --dir <capture> \
  --project-root <audited-package-root> \
  --target "provider/package/path.js" \
  --export "exportName" \
  --out <run>/notes/export-context.json
```

Rspack records edges as `consumer -> provider`. The script keeps every matched
edge and location, adds a short source excerpt, includes the complete top-level
function, variable, or export containing the use, and shows the path through
nested functions or callbacks.

Always filter by provider or export. The script refuses an unfiltered graph and
does not silently truncate matches; narrow the filters or raise
`--max-matches` explicitly.

The script loads `@babel/parser` from the audited package. Pass
`--project-root` when the capture does not identify that package. Missing or
ambiguous source, invalid locations, parser recovery, and missing containing
code make the result `complete:false` and exit nonzero. Treat those as missing
data, not as proof that no usage exists.

For browser coverage, final module ids, concatenation membership, and chunk
files connect compiler data to generated code. Continue with
[runtime-coverage.md](runtime-coverage.md).
