# Runtime Loading and Execution Coverage

Use runtime coverage when the question concerns JavaScript requested or
executed by a page, route, or interaction. The evidence contract is a named
scenario, exact generated source, complete relevant runtime targets, separate
repetitions, and a production comparison for any confirmed loading result.

Rspack commonly places modules in generated wrappers, called module factories
in the tool output. Concatenated inner modules can share one wrapper. A V8
range count describes execution observed during its capture scenario.

## Build roles

- `production-debug`: map chunks, generated module wrappers, and source-level
  execution. Its generated sizes are diagnostic.
- `production`: confirm requested assets, bytes, and named performance metrics.
- `development`: debug the application or verify tool support.

Keep entries, compilation targets, feature flags, splitChunks, dependencies,
runtime, and plugins aligned between production and production-debug, apart
from the debug settings defined in `SKILL.md`. A compilation target is a
configured JavaScript/browser target; a runtime target is an observed page,
iframe, worker, or service worker.

## Capture through Chrome

Use the live Chrome DevTools tool list to select capabilities for:

- function-level precise JavaScript coverage;
- exact script source;
- loaded resources and network initiators;
- page, iframe, dedicated-worker, shared-worker, and service-worker targets.

Record the commands actually used. For the default page pass, use precise
coverage with `callCount: true` and `detailed: false`. Reserve block-level
coverage for focused follow-up.

When one of these facts is unavailable, record the missing capability or
error and use the strongest available fallback:

1. raw CDP with `Profiler.startPreciseCoverage`,
   `Profiler.takePreciseCoverage`, and `Debugger.getScriptSource`;
2. Puppeteer-style function coverage with exact source;
3. range-only or script-level data for conclusions at that same granularity.

Generated-wrapper execution requires function ranges and exact source from the
same build. Script-level evidence supports script-level conclusions.

### DevTools Coverage panel

The built-in Coverage panel is a range-only fallback. Select `Per function`,
exclude content scripts, and start before navigation. Save the original JSON
and its `text` before clearing the panel.

Report its observed source ranges as UTF-16 code-unit offsets. A separately
verified wrapper-boundary mapping is labeled `ui-range-inference` and records
asset URL, wrapper range, module id when available, observed range, source hash,
and a short excerpt. Keep this output separate from the precise-coverage
normalizer. Worker scenarios use an attachment-capable capture path because
the panel lacks worker startup and target evidence.

## Define and repeat scenarios

Name each scenario, for example:

- `first-screen-cold`: cold-cache load to a named ready condition;
- `first-screen-warm`: the same condition with the intended warm cache;
- `critical-interaction`: the action that must load deferred code.

Record run id, scenario id, build mode, repetition, URL, browser version,
viewport, user state, feature flags, locale, cache and service-worker settings,
coverage start, navigation start, ready condition, fixed wait, capture end,
interaction steps, expected and observed targets, browser errors, failed
requests, and loaded JavaScript.

Start coverage before navigation. Prefer an application-ready marker followed
by a fixed wait. Save every `takePreciseCoverage` result because taking a new
sample resets accumulated counters.

For a final runtime conclusion, capture three separate repetitions of every
build mode and state on which it depends. `audit-only` repeats the unchanged
state; `optimize` repeats unchanged and changed states, including affected
critical interactions. Keep runs separate and show instability.

## Serve a production-like build

Serve one fresh production-debug build through the project's production,
preview, or static serve path. Record the build and serve commands,
environment, URL, ready condition, server output, console errors, failed
requests, and important API responses. Confirm that served JavaScript matches
the measured build.

Before capture, verify asset paths, API status/content type/shape, SPA fallback,
auth/session dependencies, proxy behavior, and service-worker state. Preserve
the intended route, account state, cache, feature flags, production settings,
and product behavior. A repair that changes those inputs defines a different
scenario and needs user direction before it supports the requested conclusion.

For source/hash or V8-offset mismatch, stop incremental serving, create a fresh
build, and capture again. When the intended scenario still cannot run, retain
the command, error, attempted repair, affected scope, and required project
input as an incomplete runtime result.

## Include relevant runtime targets

Capture every page, iframe, and worker that participates in the scenario. For
raw CDP worker coverage:

1. enable target discovery and flattened auto-attach;
2. enable Debugger and Profiler coverage before startup continues in each
   target;
3. record target id and type on every script;
4. compare expected targets with captured targets.

Record any worker startup window that precedes attachment as a coverage gap.

## Save and normalize raw data

Keep Chrome's original response. The normalizer accepts a CDP precise-coverage
result, an array of script results, or
`targets[].{targetId,targetType,result}`, plus optional loaded-script, session,
exact-source, and compiler data.

Recommended source manifest:

```json
{
  "scripts": [
    {
      "targetId": "page-target-id",
      "scriptId": "123",
      "url": "https://example.test/static/js/page.js",
      "source": "exact source returned by Debugger.getScriptSource",
      "sha256": "..."
    }
  ]
}
```

`sourcePath` relative to the manifest can replace inline `source`.
`Debugger.getScriptSource` is preferred. HTTP retrieval is suitable when its
length and hash match the script observed by V8.

Normalize:

```bash
node <skill>/scripts/normalize-runtime-coverage.cjs \
  --coverage <raw-precise-coverage.json> \
  --loaded-scripts <loaded-scripts.json> \
  --session <session.json> \
  --source-manifest <script-sources.json> \
  --compilation <capture>/compilation-data.json \
  --include-url-prefix <application-origin-or-asset-prefix> \
  --out-dir <run>/runtime/<scenario>/<repetition>
```

Use `--fetch-sources` when debugger source was unavailable and the URLs still
serve the identical build.

The normalizer writes:

- `runtime-coverage-session.json`;
- `runtime-coverage-scripts.jsonl`;
- `runtime-coverage-modules.jsonl`;
- `runtime-coverage-summary.json`;
- `runtime-coverage-failures.jsonl`;
- `runtime-coverage-manifest.json`.

## Generated-wrapper mapping

For production-debug or development-style Rspack chunks, the normalizer finds
the top-level V8 function for the script, builds function containment, checks
its direct children against Rspack object-method syntax and encoded names, and
records wrapper execution count and generated bytes. This keeps nested
callbacks inside their wrapper. Duplicate module ids remain separate.

A concatenated root is labeled `coarse-concatenated-factory`; coverage applies
to the shared wrapper rather than individual inner modules. Runtime-only
scripts without wrappers remain valid script records.

## Verify the capture

```bash
node <skill>/scripts/verify-runtime-coverage-artifacts.cjs \
  --dir <run>/runtime/<scenario>/<repetition> \
  --require-start-before-navigation \
  --require-target-types page,worker
```

Set target types from the application. The verifier checks structure, loaded
scripts against coverage, source identity, wrapper recognition, capture timing,
expected targets, and artifact hashes. Preserve warnings and failures. Retry a
fresh capture or focused mapping correction; unresolved failures define the
affected incomplete scope.

## Analyze and validate changes

Keep every valid repetition. Call an asset or request stable when it appears in
all valid runs and show other results as unstable. Identify assets by normalized
URL or emitted path, compiler, and content hash. Pair renamed content-hashed
assets through entry and chunk relationships.

Report stable production requests and exact raw/gzip bytes, changed assets,
unstable assets, wrapper execution as supporting scenario evidence, and shared
chunk-group assets separately. Connect each material item to its network
initiator, Rspack loading root, complete source and consumers, product need,
and focused loading-boundary change.

After a change, rebuild production, compare identical scopes, repeat the same
scenarios, and run the critical interaction. For deferred loading, use a fresh
interaction capture and verify on-demand asset loading, wrapper execution,
visible completion, network behavior, and console state. For worker changes,
replay creation, readiness or first message, error/fallback behavior, affected
consumers, and normal termination.

A production request or byte difference confirms a loading change. A speed
conclusion uses the named performance metric with matching cache, page,
user-state, and interaction conditions.
