#!/usr/bin/env node
const { parseArgs } = require('node:util');
const { fail, json, openIndex } = require('./lib/common.cjs');
const { buildIndex } = require('./lib/index.cjs');
const { runQuery, MODULE_SORT } = require('./lib/queries.cjs');
const { formatText, formatErrorText } = require('./lib/format.cjs');

const BOOL_FLAGS = new Set(['help', 'gaps', 'unexecuted', 'no-code', 'multi-origin', 'loaded']);
const COMMAND_SPECS = {
  index: {
    summary: 'Build a query index from a build capture (and optional browser recording or pre-analyzed coverage).',
    usage: 'query.cjs index --build <build.sqlite> [--coverage <recording.json>] --out <index.sqlite>',
    options: ['build', 'coverage', 'usage', 'out', 'scenario', 'precision', 'format'],
    required: ['--build, --coverage, or --usage', '--out'],
    details: [
      'One-step: --build <build.sqlite> --coverage <recording.json> --out <index.sqlite> analyzes sourcemaps + coverage and builds the index directly.',
      'Compile-time only: --build <build.sqlite> --out <index.sqlite> (or --usage <usage.sqlite>).',
      'Pre-analyzed coverage SQLite: --coverage <coverage.sqlite> [--usage <usage.sqlite>] --out <index.sqlite>.',
      '--scenario labels the recording scenario; --precision describes recording precision (per-block|per-function|unknown).',
    ],
    examples: [
      'query.cjs index --build build.sqlite --coverage recording.json --out index.sqlite',
      'query.cjs index --build build.sqlite --out index.sqlite',
    ],
  },
  status: {
    summary: 'Show build/recording identity, totals, capabilities, and capture/mapping gaps.',
    usage: 'query.cjs status --db <index.sqlite> [--gaps] [--module <id>] [--kind <kind>]',
    options: ['db', 'run', 'format', 'gaps', 'module', 'kind', 'limit', 'cursor'],
    required: ['--db'],
    details: [
      'Default shows dataset overview and inlines gaps when gaps <= 10.',
      'Pass --gaps to paginate/filter all capture and attribution gaps.',
    ],
    examples: [
      'query.cjs status --db index.sqlite',
      'query.cjs status --db index.sqlite --gaps --kind shared-source',
    ],
  },
  chunks: {
    summary: 'Inspect chunk groups, origins, chunk sizes, and candidate unnecessary modules from merged chunks.',
    usage: 'query.cjs chunks --db <index.sqlite> [--multi-origin] [--loaded] [--search <str>] | --group <id|name> [--section chunks|origins|candidates --offset <n>] | --chunk <id>',
    options: ['db', 'run', 'format', 'group', 'chunk', 'multi-origin', 'loaded', 'search', 'section', 'offset', 'limit', 'cursor', 'sort'],
    required: ['--db'],
    sortFields: ['id', 'name (overview)', '...module sort fields (with --chunk)'],
    details: [
      'Overview lists chunk groups; filter with --multi-origin, --loaded, or --search <substring>.',
      '--group <id|name> inspects origins, execution status, and modules statically reachable only from unexecuted origins.',
      'For large groups, paginate one section with --group <id> --section chunks|origins|candidates --offset <n> --limit <m>.',
      '--chunk <id> lists modules inside a chunk sorted by unexecuted bytes.',
    ],
    examples: [
      'query.cjs chunks --db index.sqlite --multi-origin --loaded',
      'query.cjs chunks --db index.sqlite --group vendors',
      'query.cjs chunks --db index.sqlite --group vendors --section origins --offset 20',
      'query.cjs chunks --db index.sqlite --chunk main',
    ],
  },
  modules: {
    summary: 'Find, filter, and rank modules by coverage bytes, execution ratio, or export usage.',
    usage: 'query.cjs modules --db <index.sqlite> [--scope build|loaded] [--sort <field:dir>] [filters]',
    options: ['db', 'run', 'scope', 'format', 'limit', 'cursor', 'sort', 'search', 'package', 'max-ratio', 'min-unexecuted', 'used-state', 'fields'],
    required: ['--db'],
    sortFields: Object.keys(MODULE_SORT),
    details: [
      '--scope build (default) or loaded; unsupported scopes fail explicitly.',
      'Filters: --search <substring>, --package <exact-pkg>, --max-ratio <0..1>, --min-unexecuted <bytes>, --used-state none|named|unknown.',
      '--sort accepts up to 3 comma-separated whitelist fields with :asc or :desc; nulls sort last.',
      'Pagination: pass --cursor <token> repeating the same filters/sort/scope (--limit and --format may change).',
    ],
    examples: [
      'query.cjs modules --db index.sqlite --scope loaded --max-ratio 0.2 --sort coverage.generated.unexecutedBytes:desc --limit 20',
      'query.cjs modules --db index.sqlite --used-state none --min-unexecuted 1024',
    ],
  },
  module: {
    summary: 'Inspect one module: coverage summary, chunks, deduplicated sources, and exports.',
    usage: 'query.cjs module --db <index.sqlite> --module <moduleId> [--used used|unused|unknown]',
    options: ['db', 'run', 'scope', 'format', 'module', 'used', 'limit', 'cursor', 'sort'],
    required: ['--db', '--module'],
    sortFields: ['id', 'name', 'usage.incomingReferences'],
    details: [
      'Includes coverage summary, chunk membership, available source spaces, and paginated exports (default limit 30).',
      'Use --used used|unused|unknown to filter exports.',
    ],
    examples: [
      'query.cjs module --db index.sqlite --module mod_xxx',
      'query.cjs module --db index.sqlite --module mod_xxx --used used',
    ],
  },
  source: {
    summary: 'Read module source with line numbers + inline coverage, or rank unexecuted hot lines with code.',
    usage: 'query.cjs source --db <index.sqlite> --module <moduleId> [--line 1] [--space resource|map-source|post-loader] [--unexecuted]',
    options: ['db', 'run', 'scope', 'format', 'module', 'source', 'space', 'map-source', 'line', 'column', 'characters', 'unexecuted', 'state', 'limit', 'cursor', 'sort'],
    required: ['--db', '--module or --source'],
    sortFields: ['id', 'line', 'generatedBytes', 'unexecutedBytes', 'coverage.generated.unexecutedBytes'],
    details: [
      'Automatically selects the best readable source for --module (prefers resource with coverage, then map-source, then post-loader).',
      'Pass --space post-loader to inspect loader-transformed JS (e.g., syntax downleveling).',
      'Pass --unexecuted (or --state executed|unexecuted|not-loaded|unknown) to list mapped lines with inline code text.',
      'Window reads default to 4000 UTF-16 chars (max 12000); resume with --line and --column.',
    ],
    examples: [
      'query.cjs source --db index.sqlite --module mod_xxx --line 1',
      'query.cjs source --db index.sqlite --module mod_xxx --unexecuted --limit 20',
      'query.cjs source --db index.sqlite --module mod_xxx --space post-loader',
    ],
  },
  refs: {
    summary: 'Show all use sites of a module with mapped source coordinates, syntax owner, and code snippets (or expand specific edges).',
    usage: 'query.cjs refs --db <index.sqlite> (--module <moduleId> | --edge <id1,id2,...>) [options]',
    options: ['db', 'run', 'format', 'module', 'edge', 'direction', 'export', 'export-path', 'relation', 'context', 'characters', 'no-code', 'space', 'column-base', 'limit', 'cursor'],
    required: ['--db', '--module or --edge'],
    details: [
      'With --module: returns incoming (default) or outgoing refs grouped by export, with mapped original-source line:col, owner, and 3-line snippets (--context 1 default).',
      'Filter by export with --export <literalName> or --export-path \'["ns","foo"]\' (incoming only); --relation all|native|module-graph.',
      'With --edge <id1,id2,...>: expands 1..20 specific use sites with wider context (--context 3 default, up to 10).',
      'Pass --no-code for a compact list without code snippets; --space auto|resource|post-loader overrides coordinate mapping.',
    ],
    examples: [
      'query.cjs refs --db index.sqlite --module mod_xxx',
      'query.cjs refs --db index.sqlite --module mod_xxx --export foo --context 2',
      'query.cjs refs --db index.sqlite --edge edge_1,edge_2 --context 8',
    ],
  },
  chain: {
    summary: 'Trace upstream export usage chain with module paths, mapped source locations, code previews, terminals, cycles, and frontier.',
    usage: 'query.cjs chain --db <index.sqlite> --module <moduleId> (--export <name> | --export-path <json>) [--depth 5]',
    options: ['db', 'run', 'format', 'module', 'export', 'export-path', 'depth', 'max-edges', 'context', 'no-code', 'space', 'column-base'],
    required: ['--db', '--module', '--export or --export-path'],
    details: [
      'Default --depth 5 (max 20), --max-edges 100 (max 500), --context 0 (1-line focused preview when chain fits budget).',
      'Preserves cycles, unknown/module-level terminals, and explicit frontier continuation hints.',
    ],
    examples: [
      'query.cjs chain --db index.sqlite --module mod_xxx --export default --depth 5',
      'query.cjs chain --db index.sqlite --module mod_xxx --export-path \'["ns","foo"]\' --no-code',
    ],
  },
};

function describe(command) {
  if (command && !Object.hasOwn(COMMAND_SPECS, command))
    fail('INVALID_ARGUMENT', `Unknown command: ${command}.`, { commands: Object.keys(COMMAND_SPECS) });
  return {
    ok: true, schemaVersion: 1, command: 'help', name: 'rspack-bundle-query',
    usage: 'node <skill>/scripts/query.cjs <command> [options]',
    singleCommand: command || null,
    commands: command ? { [command]: COMMAND_SPECS[command] } : COMMAND_SPECS,
    defaults: { format: 'text', scope: 'build', sort: 'id:asc', limit: 20, maxLimit: 200, characters: 4000, maxCharacters: 12000, depth: 5, maxDepth: 20, maxEdges: 100, maxEdgeLimit: 500, outputBytes: 32768 },
    errors: ['INVALID_ARGUMENT', 'INVALID_SORT', 'INVALID_INPUT', 'INVALID_INDEX', 'OUTPUT_EXISTS', 'INPUT_CHANGED', 'INPUT_IDENTITY_MISMATCH', 'CURSOR_MISMATCH', 'METRIC_UNAVAILABLE', 'FEATURE_UNAVAILABLE', 'MODULE_NOT_FOUND', 'CHUNK_NOT_FOUND', 'CHUNK_GROUP_NOT_FOUND', 'SOURCE_UNAVAILABLE', 'REFERENCE_NOT_FOUND', 'RECORD_TOO_LARGE'],
  };
}

function parseCli(argv) {
  const allOptions = [...new Set(Object.values(COMMAND_SPECS).flatMap(spec => spec.options))];
  const optionDefs = {
    ...Object.fromEntries(allOptions.map(name => [name, { type: BOOL_FLAGS.has(name) ? 'boolean' : 'string' }])),
    help: { type: 'boolean', short: 'h' },
  };
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: optionDefs }); }
  catch (error) { fail('INVALID_ARGUMENT', error.message); }
  const { values, positionals } = parsed;
  if (values.format !== undefined && !['text', 'json'].includes(values.format))
    fail('INVALID_ARGUMENT', '--format must be text or json.');
  return { values, positionals, format: values.format || 'text' };
}

function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseCli(argv);
  if (!positionals.length) return describe();
  const command = positionals[0];
  if (command === 'help') {
    if (positionals.length > 2) fail('INVALID_ARGUMENT', 'Usage: query.cjs help [command]');
    return describe(positionals[1]);
  }
  if (positionals.length !== 1 || !Object.hasOwn(COMMAND_SPECS, command))
    fail('INVALID_ARGUMENT', `Unknown command: ${command}.`, { commands: Object.keys(COMMAND_SPECS) });
  if (values.help) return describe(command);
  const allowed = COMMAND_SPECS[command].options;
  for (const name of Object.keys(values)) {
    if (name === 'help') continue;
    if (!allowed.includes(name)) fail('INVALID_ARGUMENT', `--${name} is not supported by ${command}.`);
  }
  if (command === 'index') return buildIndex(values);
  if (!values.db) fail('INVALID_ARGUMENT', '--db is required.');
  const ctx = { ...openIndex(values.db), command, args: values };
  try {
    const data = runQuery(ctx);
    const usesScope = command === 'modules' || command === 'module' || (command === 'source' && data.mode === 'lines');
    const result = {
      ok: true, schemaVersion: 1, command,
      datasetId: ctx.meta.datasetId, buildId: ctx.meta.buildId,
      ...(ctx.meta.compiler ? { compiler: ctx.meta.compiler } : {}),
      ...(ctx.meta.coverageRunId ? { coverageRunId: ctx.meta.coverageRunId } : {}),
      ...(ctx.meta.scenario ? { scenario: ctx.meta.scenario } : {}),
      gapsCount: ctx.meta.counts.gaps,
      query: {
        resource: command,
        ...(usesScope ? { scope: values.scope || 'build' } : {}),
        ...(values.sort ? { sort: values.sort } : {}),
      },
      ...data,
    };
    if (Buffer.byteLength(json(result)) > 32768) fail('RECORD_TOO_LARGE', 'Response exceeds 32 KiB. Request fewer fields, --no-code, or smaller source/graph budgets.');
    return result;
  } finally { ctx.db.close(); }
}

function wantsJson(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--format=json') return true;
    if (argv[i] === '--format' && argv[i + 1] === 'json') return true;
  }
  return false;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const asJson = wantsJson(argv);
  try {
    const result = main(argv);
    const out = asJson ? json(result) : formatText(result.command || 'help', result);
    process.stdout.write(`${out}\n`);
  } catch (error) {
    if (asJson) {
      process.stdout.write(`${json({ ok: false, schemaVersion: 1, error: { code: error.code || 'QUERY_FAILED', message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } })}\n`);
    } else {
      process.stdout.write(`${formatErrorText(error)}\n`);
    }
    process.exitCode = 1;
  }
}

module.exports = { main, describe, formatText };
