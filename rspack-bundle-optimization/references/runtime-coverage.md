# Runtime Loading and Execution Coverage

## Purpose and boundary

Use runtime coverage when the question concerns JavaScript that a browser
loads for a concrete page or interaction but does not execute during that
scenario.

A V8 function range with `count === 0` proves only that the function was not
observed during that capture window. It does not prove that the code is
unused, unwanted, removable, side-effect free, or safe to defer. The agent
must make those judgments from loading causes, compiler facts, source, product
behavior, and production-comparable experiments.

Runtime coverage complements rather than replaces production bundle
measurement:

- browser facts describe what one scenario loaded and executed;
- Rspack facts describe which assets, chunks, groups, modules, and imports
  caused that code to be emitted and loaded;
- production A/B output proves actual byte and request savings.

## Provider capability check

Before navigation, inspect the available Chrome DevTools MCP provider and
record which capabilities it exposes. Prefer the official MCP server configured
as:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest"]
    }
  }
}
```

Use this MCP directly when it can open or attach to Chrome, start and stop
JavaScript coverage, observe loaded resources, expose console/network facts,
and retrieve exact script source. Do not route through a custom browser shim
when the MCP can provide the same evidence with less translation loss.

Before the first capture, list the Chrome DevTools MCP tools available in the
current Codex session and record the exact coverage/source/network tool names
used. If the public tool reference is stale or incomplete, prefer the live MCP
tool list over the web page.

Preferred capability:

- V8/CDP precise JavaScript coverage with per-function call counts;
- exact script source retrieval through the debugger protocol;
- loaded-resource or network records;
- target discovery and attachment for page, iframe, dedicated worker, shared
  worker, and service worker execution contexts.

Use `callCount: true` and function-level coverage (`detailed: false`) for the
default whole-page pass. Use block-level coverage only for a narrow follow-up
where its additional volume is justified.

Fallbacks:

1. If Chrome DevTools MCP is not installed, not connected, or does not expose a
   required coverage/source/network fact, record that capability gap and the
   attempted MCP command.
2. A provider that can send raw Chrome DevTools Protocol commands may use
   `Profiler.startPreciseCoverage`, `Profiler.takePreciseCoverage`, and
   `Debugger.getScriptSource`.
3. Puppeteer-style JavaScript coverage may be used when it exposes equivalent
   function ranges and exact sources.
4. Range-only or script-level coverage may support script-level facts, but
   must not be reported as exact Rspack module-factory execution.

If the connected provider cannot supply the required facts, record the
missing capability and attempted fallback. Do not silently replace runtime
evidence with a stats-only guess.

## Scenario contract

Name and record every scenario. At minimum, consider:

- `first-screen-cold`: fresh page, intended cold-cache policy, no product
  interaction beyond reaching the explicit ready condition;
- `first-screen-warm`: same ready condition with the intended warm-cache
  policy when cache behavior matters;
- `critical-interaction`: one named product interaction whose deferred code
  must still work.

For each scenario, record:

- run id, scenario id, repetition, page URL, browser version, viewport, user
  state, feature flags, locale, cache policy, and service-worker policy;
- coverage start, navigation start, ready condition, stabilization window,
  capture end, and interaction steps;
- expected and observed targets;
- browser errors and failed requests;
- loaded JavaScript resources.

Start coverage before navigation. Prefer an application-ready marker plus a
fixed stabilization window over an open-ended `networkidle` wait. Run the
same scenario twice; run a third repetition when loaded resources, target
sets, factory counts, or errors differ materially. Keep repetitions separate
instead of merging away instability.

`takePreciseCoverage` resets accumulated counters. Preserve each raw result
before taking another sample.

## Target and worker coverage

A page-only capture is incomplete when the scenario creates JavaScript
workers or relevant iframes.

When raw CDP control is available:

1. enable target discovery and auto-attach;
2. attach with flattened sessions;
3. enable Debugger and Profiler coverage in every relevant target before
   allowing its startup code to continue;
4. record target id and target type on every script;
5. compare expected targets with targets represented in the raw coverage.

If a worker starts before the provider can attach, report that startup window
as missing evidence. Do not interpret absent worker counts as zero execution.

## Raw input contract

Preserve provider-native raw data. The normalizer accepts:

- a CDP `Profiler.takePreciseCoverage` object with `result`, or an array of
  such scripts;
- a multi-target object with
  `targets[].{targetId,targetType,result}`;
- optional loaded-script JSON containing URL strings or resource records;
- optional session JSON containing scenario and timing facts;
- an exact-source manifest;
- optional `compilation-data.json` from this skill.

Recommended exact-source manifest:

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

`sourcePath` relative to the manifest may replace inline `source`.
`Debugger.getScriptSource` is preferred. HTTP retrieval is an explicit
fallback and is accepted only when the JavaScript string length exactly
matches V8's maximum `endOffset`; redirects, rebuild races, source
transformations, or mismatched hashes are failures.

## Normalize factual records

Run:

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

Use `--fetch-sources` only when exact debugger sources were not captured and
the URLs can still return the identical build.

The normalizer writes factual artifacts only:

- `runtime-coverage-session.json`;
- `runtime-coverage-scripts.jsonl`;
- `runtime-coverage-modules.jsonl`;
- `runtime-coverage-summary.json`;
- `runtime-coverage-failures.jsonl`;
- `runtime-coverage-manifest.json`.

It performs arithmetic and exact mapping only. It does not create candidates,
rank rows, estimate removable bytes, propose changes, or write report prose.

## Rspack module-factory mapping

For development-style Rspack chunks, the normalizer:

1. finds the blank-name V8 function spanning the exact complete script;
2. builds function containment from outer ranges;
3. considers only direct children of the script root;
4. verifies that the source at the range begins with the JSON-encoded
   function name followed by Rspack object-method syntax;
5. records the outer factory range count and generated bytes.

This distinguishes a module factory that was invoked from a nested callback
inside that factory. Duplicate module ids remain separate instances.

When compiler data matches a concatenated module root, the record uses
`coarse-concatenated-factory` and lists its members. Coverage cannot assign
execution separately to inner concatenated modules. A runtime-only script
with no module factories is a valid factual result, not a mapping failure.

## Verify integrity

Run:

```bash
node <skill>/scripts/verify-runtime-coverage-artifacts.cjs \
  --dir <run>/runtime/<scenario>/<repetition> \
  --require-start-before-navigation \
  --require-target-types page,worker
```

Set required target types from the actual application, not from a generic
checklist. The verifier reports every integrity failure and exits nonzero. It
checks artifact hashes, row/count/byte arithmetic, source lengths,
normalization errors, start order when required, and target coverage.

Important explicit failures include:

- zero-byte or malformed provider export;
- loaded script missing from coverage;
- missing or changed script source;
- source length/hash mismatch;
- unrecognized Rspack factory boundary;
- coverage starting after navigation;
- expected page/iframe/worker/service-worker target missing;
- artifact modification after normalization.

Warnings and failures remain in the final evidence. The agent should first
attempt a recapture or narrower mapping fix. If the problem cannot be solved,
state the failed attempt, affected scope, and why the conclusion remains
incomplete.

## Agent analysis

The agent, not the normalizer, selects the highest-impact runtime rows and
answers:

1. Was the asset actually requested in the scenario, and by which initiator?
2. Which entry, async boundary, chunk group, splitChunks rule, or runtime
   request caused it to load?
3. Which factory counts were zero in every stable repetition, and which were
   unstable or observed in another required scenario?
4. Does source inspection show eager registration, lazy callbacks, error
   paths, duplicated instances, optional product features, or an overly broad
   import?
5. Does the user intend that feature to be available at this point?
6. What narrow source/config experiment could change the loading boundary
   without changing required behavior?

Inspect the complete source around each material module, its consumers,
package metadata, graph connections, chunk-group roots, and network
initiators. A zero-count factory may still be intentionally preloaded,
registered for later use, retained for side-effect order, or missed because
the scenario or target capture was incomplete.

## Validation and reporting

After a change:

- rebuild the same production configuration;
- compare exact total, initial, and route asset scopes;
- replay the same runtime scenarios with the same cache/user/flag policy;
- compare loaded requests and mapped execution facts;
- run the critical interaction that should still load deferred code;
- inspect browser errors, failed requests, and worker behavior.

Development generated bytes and zero-count factory bytes are diagnostic
scope, not confirmed savings. Report production raw/gzip deltas and request
changes separately.

The final report must explain each material item in this order:

1. observed runtime fact;
2. why the asset loaded;
3. relevant source and code change;
4. why that change is semantically appropriate;
5. production byte/request result;
6. scenario replay and risk checks.

After writing the report, the agent must review it once for readability:
definitions precede metrics, conclusions link to evidence, failures have
reasons, code changes are concrete, and diagnostic facts are not presented as
confirmed savings.
