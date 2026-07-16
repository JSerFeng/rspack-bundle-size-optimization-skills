# HTML Bundle Report Design

Use this reference for the mandatory final artifact of every bundle-optimization run. The goal is a polished report that is specific enough for engineers to audit, but readable enough for a product or infra owner to decide the next step without decoding internal artifacts. JSON and Markdown are backing evidence; neither replaces the HTML.

## Renderer Input Contract

Normalize fresh artifacts into one JSON object before rendering. At minimum provide:

```json
{
  "runId": "same id as manifest and every shard",
  "title": "Project bundle audit",
  "summary": {
    "headline": "confirmed raw result",
    "statement": "classification sentence",
    "nextAction": "exact next action",
    "confirmedRawSavingBytes": 0,
    "confirmedGzipSavingBytes": 0,
    "unquantifiedCount": 0,
    "candidateRawBytes": 0,
    "diagnosticRawBytes": 0
  },
  "measurement": {},
  "checks": [{ "id": "baseline", "state": "completed", "result": "...", "evidence": "..." }],
  "optimizations": [],
  "modules": [],
  "sources": [],
  "analyses": [],
  "actions": []
}
```

All ten check ids are required: `baseline`, `reachability`, `retained-unused`, `side-effects`, `export-usage`, `rollup-diff`, `cjs2esm`, `splitchunks`, `ecma`, and `post-loader`. A missing or invalid row is rendered as `blocked`, not silently omitted.

Each module may reference `sourceId`; each source supplies `id`, `path`, readable `source` or `sourceFile`, source-quality metadata, and optional unused/highlight ranges. Each optimization includes status/classification, raw and gzip savings, reason, risk, evidence, and validation command. Related pages and actions must be explicit even when missing or empty.

Render with:

```bash
node scripts/render-bundle-report.cjs \
  --input <run>/report/bundle-report-data.json \
  --out-dir <run>/report
```

Use `--force-server` to test server mode on a small fixture. The renderer creates the HTML, core index, detail/source shards, performance/privacy manifest, CSS, and client script.

## Design Goal

Build a decision document, not a dashboard dump.

The report must feel intentionally designed rather than like generated debug output: use a coherent visual system, restrained color, clear hierarchy, generous but efficient spacing, and consistent interactions. Beauty must improve scanning and trust without hiding evidence.

The page should answer these questions in order:

1. What is the confirmed raw-size result?
2. Which changes are already production-comparable, which are candidates, and which are diagnostic only?
3. Why did each important item change?
4. Which code or export chain proves the explanation?
5. What should be validated next?
6. Where can I open the detailed analysis pages?

## Required Page Structure

Use this structure for the top-level HTML:

1. **Sticky side navigation**
   - Keep labels short and plain: `结论`, `数字说明`, `所有优化`, `相关分析页面`, `优化明细`, `实验项`, `验证队列`, `附录`.
   - Use anchors that work in local `file://` pages.
   - Keep navigation visually quiet; the content should be dominant.

2. **First screen**
   - Use a compact headline, not a marketing hero.
   - Show the primary raw-size result first, for example `120.1 KB raw`.
   - Put gzip on the second line or in supporting copy.
   - Include exactly one sentence explaining whether this number is a confirmed total, a lower bound, or a candidate upper bound.
   - Include one recommended next action.

3. **Metric strip**
   - Use 3-5 compact metric tiles.
   - Required tiles: confirmed raw saving, unquantified committed items, high-risk candidate/raw upper bound, diagnostic-only upper bound when present.
   - Each tile must include a status label such as `已确认`, `待量化`, `候选`, `诊断`.

4. **Measurement contract**
   - Define `raw`, `gzip`, `appJs`, `minify`, and `concatenateModules` in plain language.
   - State raw is the primary metric and gzip is secondary.
   - State exactly which build mode counts as production-comparable.

5. **All optimizations overview**
   - Use a table or dense list that fits most rows in one screen.
   - Columns: item, status, class, raw delta, gzip delta, why it changed, next validation.
   - Sort by raw delta first, then risk/status.
   - Never hide unquantified committed work; show it as `待量化`, not as zero.

6. **Mandatory coverage matrix**
   - Show every skill check: production baseline plus resolved optimization config, reachability, retained unused, side effects, export usage roots, Rollup diff, CJS-to-ESM, splitChunks, ECMA level, and post-loader source quality.
   - Use only `completed`, `completed-no-op`, or `blocked` as execution states.
   - Show one fresh artifact or evidence statement and one result summary per row.
   - A blocked row must show the attempted command, exact failure, missing prerequisite, and next command. A no-op row must prove why no experiment was useful.

7. **Related analysis pages**
   - Link to exports usage / exports info usage HTML when generated.
   - Link to export source confirmation HTML when generated.
   - Link to chunk graph HTML when generated.
   - Link to raw JSON/Markdown artifacts.
   - If an expected page is missing, show `未生成` plus the check or command that would generate it. Do not omit missing pages.

8. **Detailed cards**
   - One card per optimization or candidate.
   - Every card must use the same order:
     1. Result
     2. Why it changed
     3. Evidence table
     4. Code snippet
     5. Risk
     6. Validation
   - The first two paragraphs should be understandable without reading code.
   - The evidence and code sections must preserve exact paths, package names, symbol names, and snippets.

9. **Experiments and diagnostics**
   - Keep diagnostic-only experiments separate from committed or production-ready changes.
   - Use raw-first numbers.
   - Explain why the result is not counted.

10. **Action queue**
   - Rank by expected raw-size impact and confidence.
   - Each row must have an exact validation command or report to rerun.

11. **Appendix**
   - Put full raw tables, failed experiments, data-quality limits, and artifact paths here.
   - Avoid forcing readers through appendix content to understand the decision.

## Component Rules

Use stable, utilitarian components:

- Status chips: `已确认`, `待量化`, `候选`, `诊断`, `阻塞`.
- Metric tiles with stable height and no layout shift.
- Tables for comparisons and overview.
- Cards only for individual optimization items; do not nest cards inside cards.
- Collapsible `<details>` for long evidence, raw tables, and full chains.
- Code panels with syntax highlighting and soft wrap.
- Link cards for related analysis pages.

## Visual System

- Use CSS custom properties for a small color system: canvas, surface, elevated surface, primary text, secondary text, border, accent, positive, warning, and blocked. Keep contrast accessible and never communicate state by color alone.
- Use one clean UI font stack and one monospace stack. Keep the headline compact; reserve monospace for metrics, paths, symbols, commands, and code.
- Use an 8px spacing rhythm, consistent radii, subtle one-pixel borders, and restrained shadows. Avoid arbitrary one-off spacing and decorative effects.
- Use responsive CSS grid: sticky side navigation on wide screens, a compact top navigation on narrow screens, and `minmax(0, 1fr)` for any flexible content column.
- Keep tables dense but legible with sticky headers, aligned numeric columns, zebra or hover state, and overflow handling. Add search and sort controls to the all-checks/optimization overview when rows exceed eight.
- Make selected, hover, focus, loading, empty, error, and disabled states visually explicit. Preserve keyboard focus outlines and use semantic buttons/links.
- Keep the report self-contained and offline-safe. Do not depend on remote fonts, CDN scripts, or network-loaded styles for the primary page.
- Use subtle motion only for state changes, respect `prefers-reduced-motion`, and avoid layout-shifting animations.

## Performance, Search, and Delivery Contract

Treat report responsiveness as part of correctness. A source viewer that freezes, loses selection, or jumps without highlighting is not complete.

### Delivery mode and budgets

- Keep the initial core index below 2 MB uncompressed and below 2,000 list rows when embedding it in the HTML. Keep all embedded detail/source shards together below 2 MB and total embedded source below 5 MB.
- If any threshold is exceeded, generate a small boot page plus `report-core.json` and per-item/per-source shards, then use `scripts/serve-bundle-report.cjs` on `127.0.0.1`. Do not make a large `file://` page parse one giant JSON/script payload.
- Small reports may embed their complete shards for a true offline `file://` fallback. Large reports must show the exact local-server command when opened through `file://`.
- Full source, export chains, and optimization evidence load only after selection. Check each shard's `runId` against the core index and reject stale or mixed-run data.
- Cap the client cache, for example with a 16 MB LRU, and abort an in-flight detail/source request when selection changes. Avoid unbounded `Promise.all` over source shards.

### Virtual rendering

- Virtualize module/root lists once they exceed 200 rows. Render the visible window plus a small overscan, keep a stable row height, and preserve the selected row through search and sort.
- Never append the whole source file as thousands of DOM rows. Split it into logical lines in memory and render only visible lines plus overscan; keep line numbers fixed-width and jump by scroll offset.
- Long tables that cannot be virtualized should default to a short ranked view with an explicit expansion or a dedicated drill-down page.

### Search and selection

- Debounce list and source search by 150-200 ms. Give every request a monotonically increasing token or `AbortController`, and ignore late results from an older query/selection.
- Plain-text search is the default. Regex input must have a length cap, reject dangerous constructs such as nested quantifiers/backreferences, run in a Web Worker, and be terminated on a short timeout. Show invalid-regex and timeout states without freezing the UI.
- Keep module-list search and source search distinct. Selecting a list match must visibly select the row; searching source must jump to the exact line and wrap the exact matched columns in a red highlight. `jump to hit` must never reuse a stale path, line, or query from the previous selection.
- Support previous/next source matches, Enter/Shift+Enter, empty results, keyboard focus, and search cancellation. Search/sort state may live in the URL, but source text and absolute paths must not be placed there.

### Privacy and publication

- Bind the report server to `127.0.0.1` by default, serve only real paths inside the report directory, disable permissive CORS, and send restrictive content/security headers.
- Reports are local-only by default because shards may contain proprietary post-loader source, absolute paths, package versions, flags, and build commands.
- Before publishing, create a redacted copy: remove or relativize paths, strip source not needed for the claim, remove environment fingerprints and internal URLs, and re-run link/search/source validation on the redacted copy.

For exports usage / exports info usage drill-down pages:

- Use a module-first drill-down layout. The left sidebar is the terminal module/root list and defaults to sorting by downstream impacted modules (`impactedModuleCount`), then impacted exports, then chain count. Provide sort switches for impacted modules, impacted exports, chain count, verdict/category, and module path.
- The left sidebar search must accept path regex input and match the root module path shown in the left list. A query such as `node_modules`, `lv-bedrock.*async`, or `src/editor/.*/controller\\.tsx` should filter the root list to roots whose own module path matches. Do not include downstream module/export paths in this search; those belong in the right-side export search.
- The left root row is an evidence row, not a navigation label only. It must show path, category/verdict, impacted module count, impacted export count, chain count, and the best available root trigger location (`loc`, `request`, `dependencyId`, or `近似` if found by search).
- The right top area is the complete `Used exports caused by this root` list. It shows all distinct export endpoints retained by the selected module/root, not a top-N sample. Each export row should show target module, export name, verdict/status, chain count, precise-vs-namespace/coarse signal, and whether the chain data is complete, capped, unknown, or sample-only.
- If the selected module/root appears in the `usedExports:true` / whole-module import audit, show `Import sites causing full export usage` before the export list. Each row must show the importing consumer module, request, `loc`, dependency id, import shape, and the consumer code at that `loc`. A compact row snippet is fine for scanning, but the HTML must also provide an expanded source viewer or collapsible full source for that consumer module, highlight the `loc`, and offer a wider context mode such as `±40 lines`. Prefer captured post-loader source for the source viewer; if only disk source is available, label it as `disk source fallback` and treat the loc as approximate. This section answers which import made the provider namespace live; it is the starting point for rewrites such as moving destructuring into `await import("pkg")` instead of returning the import namespace from a helper.
- Clicking an export endpoint opens its usage chains in the right lower area. A chain is a sequence of module nodes connected by edge metadata; there can be many chains for one export. If one root line causes multiple downstream exports to be used, group the chains by root trigger site and show the downstream export count in that group.
- Keep chain and source data complete without bloating the first page load. The root metadata, per-root export list, and source index can stay lightweight, while complete chain graph details should live in lazy shards such as `chains-data/root-N.json` or `chains-data/root-N/export-M.json`, and full source should live in source shards such as `sources-data/source-N.json`. The source index must cover every JS-like module node shown in a chain, including third-party `node_modules` modules. Prefer captured post-loader source; if a node lacks captured post-loader source but its path exists on disk, the page may add a clearly labeled `disk source fallback` shard for readability, not final evidence. Embed these shards only when the small-report budgets above pass; otherwise fetch them through the local-only report server. Do not show "inspect raw JSON" as the normal way to reach omitted chains.
- The chain visualization must have a clear direction: terminal root at the left/top, final endpoint at the right/bottom. The last node must explicitly read as `target module :: export`, because the endpoint of the chain is a specific export, not just a module. Each node should show the active export on that hop when known. For upstream/root-consumer nodes where the edge has no `originExport`, use the backing all-export usage data as a conservative fallback: if that consumer module has exactly one used export, show that export on the node while leaving the edge `originExport` empty. Each edge label should render `request`, `originExport`, `targetExport`, `loc`, and `dependencyId` when available; mark `viaNamespace` / barrel / coarse edges differently from precise named-export edges.
- Selecting a chain shows its module nodes in order, with both graph and compact list affordances if space allows. Selecting a module node opens the source panel below and moves the active edge/loc highlight to that node. The selected root, export endpoint, chain, and node must all have visible selected-state feedback.
- Rsdoctor edge `loc` is located in the consumer/source module. When clicking a chain node, use that node's outgoing edge `loc` if the edge starts from the selected module; terminal/root nodes have no incoming edge, so this outgoing-edge mapping is what highlights the root trigger line. Only fall back to an incoming edge if the incoming edge's source module is the selected module; otherwise show no highlight rather than reusing a neighboring module's loc.
- Source panels for chain nodes must use readable, non-minimized post-loader source captured from `module.originalSource()` with `optimization.minimize:false`. After the source shard loads, render the complete source by default and scroll/highlight the exact export-used dependency/specifier `loc` from Rsdoctor. Do not crop to a partial line range such as `showing lines X-Y` unless the page also offers a clear full-source mode. If only minified/compact source or disk fallback source is available, label it as data-quality loss and regenerate before drawing conclusions; disk fallback loc highlighting is approximate because Rsdoctor loc belongs to post-loader source.
- If captured source has `sourceQuality.probablyMinified`, a tiny `lineCount`, or extreme `maxLineLength`, show a visible source-quality warning in the source viewer and report header. The report should name the suspected compacting loader when a loader trace exists and should not treat the source as final evidence until loader output compaction is disabled for the analysis build.
- Put chain samples or node lists above the source viewer, then render the selected source viewer as a full-width block below. Do not put a long post-loader source panel in a narrow side column; compact or transformed sources become unreadable when wrapped every few characters.
- Source tabs and graph/list nodes must give visible selected-state feedback. Clicking a source tab must update the active tab, source title, source body, and the selected dependency location used by the "jump to hit" action.
- Do not put source paths, loc strings, or JSON-stringified values inside inline `onclick` attributes. A path value wrapped in double quotes will be parsed as broken HTML, so the click silently does nothing. Use `data-*` attributes plus event delegation for source tabs, chain buttons, and graph nodes.
- Track the selected source path and selected loc separately. Do not let "jump to hit" reuse a stale loc from a previous chain or another source file.
- Source line highlighting must use the post-loader source for the loc, because Rsdoctor export-usage loc values are after loader transforms. If the page uses `disk source fallback`, keep the highlight but label it approximate.
- Syntax highlighting must tokenize the raw source and escape text while emitting spans. Do not run regex replacements over already escaped HTML or previously inserted `<span>` tags; that can leak markup such as `class="str"` into the visible code.
- Use fixed-width line numbers and a `minmax(0, 1fr)` code column. Use soft wrap for long transformed lines, but give the viewer enough width before allowing emergency word breaks.

Avoid:

- Oversized hero typography that hides the summary.
- Decorative gradients, orbs, bokeh, or unrelated illustration.
- One huge table as the whole report.
- Long paragraphs without labels.
- Raw JSON pasted into the main flow.
- Gzip-led badges unless the user explicitly asked for transfer size.

## Copy Rules

Write for a reader who knows the product but may not know bundler internals.

- Start each section with the decision, then explain evidence.
- Use plain Chinese for labels and explanations.
- Define technical terms before relying on them.
- Keep real identifiers exact: paths, package names, exports, chunk names, and code snippets must not be paraphrased.
- Prefer `为什么变小`, `证据`, `风险`, `怎么验证` over abstract labels.
- For every optimization, include a "why used / why retained / why removed" explanation tied to the actual source or export chain.
- When evidence is weak, say so directly: `待量化`, `需要 A/B`, `只能作为诊断`, or `loc 缺失，使用搜索近似`.

## Evidence Rules

A readable report is still evidence-first.

Each claimed optimization must include:

- Raw delta first, gzip delta second.
- The affected asset or module names.
- A short code snippet or source-chain snippet when it explains the mechanism.
- A validation command or report name.
- A status saying whether it counts as production-comparable.

For export usage analysis, each root or export detail should include:

- Which export is being kept alive.
- Which root or consumer keeps it alive.
- The source line or post-loader source snippet.
- Whether the chain is exact, capped, or approximate.
- A link to the full exports usage HTML page when available.

## Visual Density Rules

Aim for dense but readable.

- First screen should fit conclusion, metric strip, and next action on a typical laptop viewport.
- Detail cards can be long, but the default open portion should fit within about one viewport.
- Use collapsible sections for lists longer than 8 rows, code longer than 30 lines, or chain samples longer than 5 items.
- Use tables for repeated facts; use paragraphs only for reasoning.
- Use subdued borders and background bands to separate sections. Do not rely on color alone for status.

## Validation Checklist

Before delivering an HTML report:

1. Open or parse the HTML and confirm it is valid enough to load.
2. Confirm no text overlaps at desktop and mobile widths if a browser check is available.
3. Confirm the first screen states raw-size result first.
4. Confirm every visible gzip value has a raw value before it or next to it.
5. Confirm every committed item is either quantified or marked `待量化`.
6. Confirm every diagnostic or candidate result says why it is not counted.
7. Confirm "Related analysis pages" links exist or are explicitly marked `未生成`.
8. Search for unexplained terms such as `sideEffects`, `concatenateModules`, `usedExports`, `root`, `chunk`, `ECMA`, and define or replace them in visible text.
9. Confirm the coverage matrix contains all ten mandatory checks, including the resolved optimization-config evidence in the baseline row, and every row is `completed`, `completed-no-op`, or `blocked` with evidence.
10. Exercise overview search, every sort control, card anchors, collapsible sections, drill-down selection, and source highlighting; fix console errors before delivery.
11. Capture or inspect both a desktop viewport and a narrow/mobile viewport, checking overflow, sticky navigation, table scrolling, code wrapping, and focus visibility.
12. Test a source query end to end: select its module, wait for the shard, jump to the result, and confirm the exact columns are red-highlighted; then switch selection during a slow load and confirm stale data never appears.
13. Verify list and source DOM node counts stay near the visible window on a large fixture, regex timeout/cancellation works, and the configured core/shard/cache budgets are shown in the report.
14. In server mode, confirm traversal attempts are rejected and every served shard has the report's `runId`. In publish mode, confirm a separate redacted copy passed the same checks.
