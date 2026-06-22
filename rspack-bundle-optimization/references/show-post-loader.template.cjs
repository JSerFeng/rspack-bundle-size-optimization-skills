#!/usr/bin/env node
// Read POST-LOADER module source on demand, so an agent (Claude/Codex) can open each
// module and confirm — case by case — whether an export is genuinely used or only
// referenced by an artifact (decorator metadata, injected polyfill, re-export passthrough,
// helper wrapper, …). This tool only SHOWS source; it makes no genuine-vs-artifact verdict.
// That judgement is the agent's, from reading the actual code.
//
// Inputs (from export-usage-capture-plugin):
//   post-loader-sources.jsonl   one {path, markers[], source} per line
//   post-loader-index.json      { index: { path -> {line, markers[]} } }
//
// Usage:
//   node show-post-loader.cjs --list                     # list modules with artifact markers (candidates to inspect)
//   node show-post-loader.cjs --list --marker decorator-metadata
//   node show-post-loader.cjs <pathSubstring>            # print a module's full post-loader source (line-numbered)
//   node show-post-loader.cjs <pathSubstring> --symbol Foo   # show only the lines where Foo is referenced (+context)

const { readFileSync, existsSync } = require('fs');
const { resolve } = require('path');

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) {
      const k = x.slice(2);
      const n = argv[i + 1];
      if (!n || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(x);
  }
  return a;
}

const args = parseArgs(process.argv);
const dir = resolve(args.dir || '.');
const jsonlPath = resolve(args.jsonl || `${dir}/post-loader-sources.jsonl`);
const indexPath = resolve(args.index || `${dir}/post-loader-index.json`);
if (!existsSync(jsonlPath)) { console.error(`Missing ${jsonlPath} — run the capture build first.`); process.exit(1); }

function loadLines() { return readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean); }

if (args.list) {
  const idx = JSON.parse(readFileSync(indexPath, 'utf8')).index || {};
  const rows = Object.entries(idx)
    .filter(([, v]) => v.markers && v.markers.length && (!args.marker || v.markers.includes(args.marker)))
    .sort((a, b) => b[1].markers.length - a[1].markers.length);
  console.log(`${rows.length} modules with artifact markers${args.marker ? ` (${args.marker})` : ''} — inspect each to confirm usage:`);
  for (const [p, v] of rows) console.log(`  [${v.markers.join(',')}]  ${p}`);
  console.log('\nThese are CANDIDATES to read, not verdicts. Open each with: node show-post-loader.cjs <pathSubstring> --symbol <export>');
  process.exit(0);
}

const needle = args._[0];
if (!needle) { console.error('Provide a path substring, or --list. See header for usage.'); process.exit(1); }

const lines = loadLines();
const matches = lines.map((l) => JSON.parse(l)).filter((m) => m.path.includes(needle));
if (matches.length === 0) { console.error(`No captured module matches "${needle}".`); process.exit(1); }
if (matches.length > 5 && !args.symbol) {
  console.log(`${matches.length} modules match "${needle}" — narrow the substring, or pick one:`);
  for (const m of matches.slice(0, 40)) console.log(`  ${m.path}`);
  process.exit(0);
}

for (const m of matches) {
  console.log(`\n===== ${m.path}  [markers: ${m.markers.join(',') || 'none'}] =====`);
  const srcLines = m.source.split('\n');
  if (args.symbol) {
    const sym = String(args.symbol);
    const re = new RegExp('\\b' + sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    let shown = 0;
    for (let i = 0; i < srcLines.length; i++) {
      if (re.test(srcLines[i])) {
        shown++;
        const from = Math.max(0, i - 1), to = Math.min(srcLines.length - 1, i + 1);
        for (let j = from; j <= to; j++) console.log(`${String(j + 1).padStart(5)}${j === i ? ' >' : '  '} ${srcLines[j]}`);
        console.log('  ---');
      }
    }
    console.log(shown ? `(${shown} reference site(s) of \`${sym}\` — judge each: genuine call/new/JSX/extends vs decorator-metadata / polyfill / passthrough artifact)` : `\`${sym}\` not found in post-loader source.`);
  } else {
    srcLines.forEach((l, i) => console.log(`${String(i + 1).padStart(5)}  ${l}`));
  }
}
