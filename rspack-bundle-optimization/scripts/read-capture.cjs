#!/usr/bin/env node
// Retrieve records from captured post-loader source data.
// This tool prints matching data and makes no semantic judgment.

const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { resolve } = require('path');
const { tmpdir } = require('os');

function parseArgs(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) values[key] = true;
    else {
      values[key] = next;
      index++;
    }
  }
  return values;
}

function loadIndex(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (
    value.schemaVersion !== 1
    || value.kind !== 'rspack-post-loader-source-index'
    || !Array.isArray(value.sources)
  ) {
    throw new Error('Unsupported or missing post-loader source index schema');
  }
  return value;
}

function loadRows(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function selectRows(rows, needle) {
  const query = String(needle || '');
  if (!query) return rows;
  return rows.filter((row) =>
    String(row.resource || '').includes(query)
    || String(row.identifier || '').includes(query));
}

function sourceLines(row, contains, context) {
  const lines = String(row.source || '').split('\n');
  if (!contains) {
    return lines.map((line, index) => ({
      line: index + 1,
      text: line,
      match: false,
    }));
  }
  const selected = new Set();
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].includes(contains)) continue;
    for (
      let current = Math.max(0, index - context);
      current <= Math.min(lines.length - 1, index + context);
      current++
    ) {
      selected.add(current);
    }
  }
  return [...selected].sort((left, right) => left - right).map((index) => ({
    line: index + 1,
    text: lines[index],
    match: lines[index].includes(contains),
  }));
}

function run(args) {
  const directory = resolve(args.dir || '.');
  const actualIndexPath = resolve(
    args.index || resolve(directory, 'post-loader-index.json'),
  );
  const actualSourcesPath = resolve(
    args.jsonl || resolve(directory, 'post-loader-sources.jsonl'),
  );
  if (!existsSync(actualIndexPath)) throw new Error(`Missing ${actualIndexPath}`);
  if (!existsSync(actualSourcesPath)) throw new Error(`Missing ${actualSourcesPath}`);

  const index = loadIndex(actualIndexPath);
  if (args['list-sources']) {
    return {
      runId: index.runId,
      compilerId: index.compilerId,
      sources: index.sources,
    };
  }
  if (!args.source) {
    throw new Error('Provide --list-sources or --source <path-or-identifier-substring>');
  }

  const rows = selectRows(loadRows(actualSourcesPath), args.source);
  if (!rows.length) throw new Error(`No captured source matches: ${args.source}`);
  const context = args.context === undefined ? 1 : Number(args.context);
  if (!Number.isSafeInteger(context) || context < 0) {
    throw new Error('--context must be a non-negative integer');
  }
  return {
    runId: index.runId,
    compilerId: index.compilerId,
    query: {
      source: String(args.source),
      contains: args.contains ? String(args.contains) : null,
      context,
    },
    matches: rows.map((row) => ({
      identifier: row.identifier,
      resource: row.resource,
      bytes: row.bytes,
      sha256: row.sha256,
      lines: sourceLines(
        row,
        args.contains ? String(args.contains) : null,
        context,
      ),
    })),
  };
}

function selfTest() {
  const assert = require('assert');
  const root = mkdtempSync(resolve(tmpdir(), 'read-capture-'));
  try {
    mkdirSync(root, { recursive: true });
    const source = 'export const alpha = 1;\nconsole.log(alpha);\n';
    const row = {
      identifier: 'javascript/auto|/fixture/a.js',
      resource: '/fixture/a.js',
      bytes: Buffer.byteLength(source),
      sha256: 'a'.repeat(64),
      source,
    };
    writeFileSync(
      resolve(root, 'post-loader-sources.jsonl'),
      `${JSON.stringify(row)}\n`,
    );
    writeFileSync(
      resolve(root, 'post-loader-index.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'rspack-post-loader-source-index',
        runId: 'run',
        compilerId: 'web',
        sources: [{
          line: 0,
          identifier: row.identifier,
          resource: row.resource,
          bytes: row.bytes,
          sha256: row.sha256,
        }],
      })}\n`,
    );
    const result = run({
      dir: root,
      source: 'a.js',
      contains: 'alpha',
      context: '0',
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].lines.length, 2);
    assert.equal(selectRows([row], 'missing').length, 0);
    process.stdout.write('read-capture self-test passed\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  process.stdout.write(`${JSON.stringify(run(args), null, 2)}\n`);
}

if (require.main === module) main();

module.exports = {
  loadIndex,
  loadRows,
  run,
  selectRows,
  sourceLines,
};
