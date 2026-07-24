#!/usr/bin/env node
// Join raw Rspack export-usage edges to captured post-loader source.
// This tool extracts locations and syntax relationships only. It never decides
// whether an export is intended, unwanted, removable, or worth optimizing.

const assert = require('assert');
const { createHash } = require('crypto');
const {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { createRequire } = require('module');
const { tmpdir } = require('os');
const {
  basename,
  resolve,
} = require('path');
const readline = require('readline');

const KIND = 'rspack-export-usage-context';

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function nonNegativeInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return number;
}

function modulePath(module) {
  return String(
    module?.path
    || module?.resource
    || module?.identifier
    || '',
  );
}

function canonicalResource(value) {
  let result = String(value || '').replace(/\\/g, '/');
  const loaderIndex = result.lastIndexOf('!');
  if (loaderIndex >= 0) result = result.slice(loaderIndex + 1);
  const queryIndex = result.search(/[?#]/);
  if (queryIndex >= 0) result = result.slice(0, queryIndex);
  return result;
}

function exportKey(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String).join('.');
  return String(value);
}

function exportMatches(value, query) {
  if (query === undefined) return true;
  const expected = String(query);
  const key = exportKey(value);
  return key === expected
    || (Array.isArray(value) && value.map(String).includes(expected));
}

function loadExportUsage(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value.modules) || !Array.isArray(value.edges)) {
    throw new Error(
      `Unsupported export-usage data in ${path}: modules/edges are required`,
    );
  }
  return value;
}

function selectEdges(data, args) {
  const filterNames = [
    'edge-index',
    'origin',
    'origin-export',
    'target',
    'export',
    'dependency-id',
    'loc',
  ];
  if (!filterNames.some((name) => args[name] !== undefined)) {
    throw new Error(
      'Provide at least one edge filter: --target, --export, --origin, '
      + '--origin-export, --dependency-id, --loc, or --edge-index',
    );
  }

  const modules = new Map(data.modules.map((module) => [module.ukey, module]));
  const edgeIndex = args['edge-index'] === undefined
    ? null
    : nonNegativeInteger(args['edge-index'], '--edge-index');
  const selected = [];
  data.edges.forEach((edge, index) => {
    if (!Array.isArray(edge) || edge.length < 4) return;
    if (edgeIndex !== null && edgeIndex !== index) return;
    const originModule = modules.get(edge[0]) || null;
    const targetModule = modules.get(edge[2]) || null;
    const originPath = modulePath(originModule);
    const targetPath = modulePath(targetModule);
    if (
      args.origin !== undefined
      && !originPath.includes(String(args.origin))
    ) return;
    if (
      args.target !== undefined
      && !targetPath.includes(String(args.target))
    ) return;
    if (!exportMatches(edge[1], args['origin-export'])) return;
    if (!exportMatches(edge[3], args.export)) return;
    if (
      args['dependency-id'] !== undefined
      && String(edge[4] ?? '') !== String(args['dependency-id'])
    ) return;
    if (
      args.loc !== undefined
      && String(edge[5] ?? '') !== String(args.loc)
    ) return;
    selected.push({
      edgeIndex: index,
      raw: edge,
      originModule,
      originPath,
      targetModule,
      targetPath,
    });
  });
  return selected;
}

function rowResource(row) {
  return String(row.resource || row.path || '');
}

function sourceRowKey(row) {
  const source = String(row.source || '');
  return row.sha256 || sha256(source);
}

async function loadSourceCandidates(path, originPaths) {
  const exact = new Map();
  const canonical = new Map();
  const byBasename = new Map();
  for (const originPath of originPaths) {
    exact.set(originPath, originPath);
    const normalized = canonicalResource(originPath);
    if (!canonical.has(normalized)) canonical.set(normalized, []);
    canonical.get(normalized).push(originPath);
    const name = basename(normalized);
    if (!byBasename.has(name)) byBasename.set(name, []);
    byBasename.get(name).push(originPath);
  }

  const candidates = new Map(
    [...originPaths].map((originPath) => [originPath, []]),
  );
  const failures = [];
  let lineNumber = 0;
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const currentLine = lineNumber++;
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      failures.push({
        code: 'invalid-source-jsonl-row',
        sourceLine: currentLine,
        reason: error.message,
      });
      continue;
    }
    const resource = rowResource(row);
    const normalized = canonicalResource(resource);
    const matched = new Map();
    if (exact.has(resource)) {
      matched.set(exact.get(resource), 'exact-resource');
    }
    for (const originPath of canonical.get(normalized) || []) {
      if (!matched.has(originPath)) {
        matched.set(originPath, 'canonical-resource');
      }
    }

    if (!matched.size && row.identifier) {
      const identifier = String(row.identifier);
      for (const [name, possibleOrigins] of byBasename) {
        if (!name || !identifier.includes(name)) continue;
        for (const originPath of possibleOrigins) {
          if (identifier.includes(originPath)) {
            matched.set(originPath, 'identifier-contains-resource');
          }
        }
      }
    }

    for (const [originPath, matchKind] of matched) {
      candidates.get(originPath).push({
        line: currentLine,
        matchKind,
        row,
      });
    }
  }
  return { candidates, failures, scannedRows: lineNumber };
}

function chooseSourceCandidate(originPath, candidates) {
  if (!candidates.length) {
    return {
      failure: {
        code: 'source-not-captured',
        originPath,
        reason:
          'No post-loader source row matched the export-usage consumer module',
      },
    };
  }
  const ranks = {
    'exact-resource': 0,
    'canonical-resource': 1,
    'identifier-contains-resource': 2,
  };
  const bestRank = Math.min(
    ...candidates.map((candidate) => ranks[candidate.matchKind] ?? 99),
  );
  const best = candidates.filter(
    (candidate) => (ranks[candidate.matchKind] ?? 99) === bestRank,
  );
  const bySource = new Map();
  for (const candidate of best) {
    const key = sourceRowKey(candidate.row);
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(candidate);
  }
  if (bySource.size > 1) {
    return {
      failure: {
        code: 'ambiguous-source-match',
        originPath,
        reason:
          'Multiple post-loader rows matched the consumer with different source hashes',
        candidates: best.map((candidate) => ({
          line: candidate.line,
          matchKind: candidate.matchKind,
          identifier: candidate.row.identifier || null,
          resource: rowResource(candidate.row) || null,
          sha256: sourceRowKey(candidate.row),
        })),
      },
    };
  }
  const identical = [...bySource.values()][0];
  const selected = identical[0];
  return {
    selected,
    duplicateIdenticalRows: identical.length - 1,
  };
}

function parseLocation(value) {
  const match = String(value || '').match(
    /^(\d+):(\d+)(?:-(?:(\d+):)?(\d+))?$/,
  );
  if (!match) return null;
  const startLine = Number(match[1]);
  const startColumn = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : startLine;
  const endColumn = match[4] ? Number(match[4]) : startColumn;
  if (
    startLine <= 0
    || endLine <= 0
    || startColumn <= 0
    || endColumn <= 0
    || endLine < startLine
    || (endLine === startLine && endColumn < startColumn)
  ) return null;
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
  };
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function locationOffsets(source, location) {
  const starts = lineStarts(source);
  const startBase = starts[location.start.line - 1];
  const endBase = starts[location.end.line - 1];
  if (startBase === undefined || endBase === undefined) return null;
  const startLineEnd = source.indexOf('\n', startBase);
  const endLineEnd = source.indexOf('\n', endBase);
  const startLimit = startLineEnd < 0 ? source.length : startLineEnd;
  const endLimit = endLineEnd < 0 ? source.length : endLineEnd;
  // Rspack dependency locations use one-based, inclusive columns. JavaScript
  // string offsets are zero-based with an exclusive end.
  const start = startBase + location.start.column - 1;
  const end = endBase + location.end.column;
  if (start > startLimit || end > endLimit || end < start) return null;
  return { start, end };
}

function offsetPoint(source, offset) {
  const starts = lineStarts(source);
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  return {
    line: lineIndex + 1,
    column: offset - starts[lineIndex],
  };
}

function makeSnippet(source, location, contextLines) {
  const lines = source.split('\n');
  const startLine = Math.max(1, location.start.line - contextLines);
  const endLine = Math.min(lines.length, location.end.line + contextLines);
  return {
    startLine,
    endLine,
    source: lines.slice(startLine - 1, endLine).join('\n'),
  };
}

function inferCaptureProjectRoots(captureDir, explicitRoot) {
  const roots = [];
  if (explicitRoot) roots.push(resolve(explicitRoot));
  const compilationPath = resolve(captureDir, 'compilation-data.json');
  if (existsSync(compilationPath)) {
    try {
      const data = JSON.parse(readFileSync(compilationPath, 'utf8'));
      if (data.compiler?.context) roots.push(resolve(data.compiler.context));
      if (data.resolvedConfig?.context) {
        roots.push(resolve(data.resolvedConfig.context));
      }
    } catch {
      // The main capture verifier owns compilation-data integrity. Parser
      // resolution will retain its own concrete attempts below.
    }
  }
  roots.push(process.cwd());
  return [...new Set(roots)];
}

function loadBabelParser(captureDir, args) {
  const attempts = [];
  if (args['parser-path']) {
    const parserPath = resolve(String(args['parser-path']));
    try {
      return {
        parser: require(parserPath),
        resolvedPath: parserPath,
        projectRoot: null,
        attempts,
      };
    } catch (error) {
      attempts.push({ parserPath, reason: error.message });
    }
  }
  for (
    const projectRoot of inferCaptureProjectRoots(
      captureDir,
      args['project-root'],
    )
  ) {
    const packagePath = resolve(projectRoot, 'package.json');
    if (!existsSync(packagePath)) {
      attempts.push({
        projectRoot,
        reason: `Missing ${packagePath}`,
      });
      continue;
    }
    try {
      const projectRequire = createRequire(packagePath);
      const resolvedPath = projectRequire.resolve('@babel/parser');
      return {
        parser: projectRequire('@babel/parser'),
        resolvedPath,
        projectRoot,
        attempts,
      };
    } catch (error) {
      attempts.push({ projectRoot, reason: error.message });
    }
  }
  return {
    parser: null,
    resolvedPath: null,
    projectRoot: null,
    attempts,
  };
}

const BASE_PARSER_PLUGINS = [
  'jsx',
  'decorators-legacy',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'dynamicImport',
  'importMeta',
  'topLevelAwait',
  'exportDefaultFrom',
  'exportNamespaceFrom',
];

function parseSource(parser, source, filename) {
  const attempts = [
    { mode: 'javascript', plugins: BASE_PARSER_PLUGINS },
    { mode: 'typescript', plugins: [...BASE_PARSER_PLUGINS, 'typescript'] },
    { mode: 'flow', plugins: [...BASE_PARSER_PLUGINS, 'flow', 'flowComments'] },
  ];
  const failures = [];
  let recovered = null;
  for (const attempt of attempts) {
    try {
      const ast = parser.parse(source, {
        sourceType: 'unambiguous',
        sourceFilename: filename,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: attempt.plugins,
      });
      const recoveries = (ast.errors || []).map((error) => ({
        message: error.message,
        reasonCode: error.reasonCode || null,
        loc: error.loc || null,
      }));
      if (!recoveries.length) {
        return {
          ast,
          mode: attempt.mode,
          recoveries: [],
          attempts: failures,
          clean: true,
        };
      }
      if (!recovered) {
        recovered = {
          ast,
          mode: attempt.mode,
          recoveries,
          attempts: failures,
          clean: false,
        };
      }
      failures.push({
        mode: attempt.mode,
        reason: `Parser recovered from ${recoveries.length} syntax error(s)`,
        recoveries,
      });
    } catch (error) {
      failures.push({
        mode: attempt.mode,
        reason: error.message,
        loc: error.loc || null,
      });
    }
  }
  if (recovered) {
    recovered.attempts = failures;
    return recovered;
  }
  return { ast: null, attempts: failures, clean: false };
}

function isAstNode(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.type === 'string',
  );
}

function astChildren(node) {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'loc'
      || key === 'start'
      || key === 'end'
      || key === 'extra'
      || key === 'errors'
      || key === 'comments'
      || key === 'tokens'
    ) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) children.push(item);
      }
    } else if (isAstNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function findContainingPath(root, start, end) {
  let best = [];
  function visit(node, path) {
    if (!isAstNode(node)) return;
    if (
      typeof node.start === 'number'
      && typeof node.end === 'number'
      && (node.start > start || node.end < end)
    ) return;
    const next = [...path, node];
    if (next.length > best.length) best = next;
    for (const child of astChildren(node)) visit(child, next);
  }
  visit(root, []);
  return best;
}

function identifierName(node) {
  if (!node) return null;
  if (node.type === 'Identifier' || node.type === 'PrivateName') {
    return node.name || identifierName(node.id) || null;
  }
  if (
    node.type === 'StringLiteral'
    || node.type === 'NumericLiteral'
    || node.type === 'Literal'
  ) return String(node.value);
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'ObjectPattern' || node.type === 'ArrayPattern') {
    return `<${node.type}>`;
  }
  return null;
}

function nodeName(node, parent) {
  const own = identifierName(node.id) || identifierName(node.key);
  if (own) return own;
  if (
    parent?.type === 'VariableDeclarator'
    || parent?.type === 'ObjectProperty'
    || parent?.type === 'ClassProperty'
    || parent?.type === 'ClassPrivateProperty'
  ) return identifierName(parent.id) || identifierName(parent.key);
  if (parent?.type === 'AssignmentExpression') {
    return identifierName(parent.left);
  }
  return null;
}

function nodePoint(node, edge, source) {
  if (node?.loc?.[edge]) {
    return {
      line: node.loc[edge].line,
      column: node.loc[edge].column,
    };
  }
  const offset = node?.[edge];
  return typeof offset === 'number' ? offsetPoint(source, offset) : null;
}

function describeNode(node, parent, source) {
  return {
    type: node.type,
    name: nodeName(node, parent),
    start: nodePoint(node, 'start', source),
    end: nodePoint(node, 'end', source),
  };
}

function findTopLevelNodes(path) {
  const programIndex = path.findIndex((node) => node.type === 'Program');
  if (programIndex < 0 || !path[programIndex + 1]) {
    return { statement: null, owner: null };
  }
  const statement = path[programIndex + 1];
  let owner = statement;
  if (
    statement.type === 'ExportNamedDeclaration'
    || statement.type === 'ExportDefaultDeclaration'
  ) {
    const declaration = path[programIndex + 2];
    if (declaration && statement.declaration === declaration) owner = declaration;
  }
  if (owner.type === 'VariableDeclaration') {
    const declarator = path.find(
      (node, index) =>
        index > programIndex
        && node.type === 'VariableDeclarator',
    );
    if (declarator) owner = declarator;
  }
  return { statement, owner };
}

const CALLABLE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);

const CLASS_TYPES = new Set([
  'ClassDeclaration',
  'ClassExpression',
]);

function completeNodeSource(node, source, maxOwnerBytes) {
  if (
    !node
    || typeof node.start !== 'number'
    || typeof node.end !== 'number'
  ) return null;
  const text = source.slice(node.start, node.end);
  const bytes = Buffer.byteLength(text);
  return {
    bytes,
    sha256: sha256(text),
    source: bytes <= maxOwnerBytes ? text : null,
    sourceStatus: bytes <= maxOwnerBytes
      ? 'complete'
      : `omitted-over-${maxOwnerBytes}-bytes`,
  };
}

function syntaxContext(
  ast,
  source,
  offsets,
  targetExport,
  maxOwnerBytes,
) {
  const path = findContainingPath(ast, offsets.start, offsets.end);
  if (!path.length) return null;
  const { statement, owner } = findTopLevelNodes(path);
  const ownerIndex = owner ? path.indexOf(owner) : -1;
  const ownerChain = [];
  for (
    let index = Math.max(0, ownerIndex);
    index < path.length;
    index++
  ) {
    const node = path[index];
    if (!CALLABLE_TYPES.has(node.type) && !CLASS_TYPES.has(node.type)) continue;
    const parent = index > 0 ? path[index - 1] : null;
    const description = describeNode(node, parent, source);
    if (!description.name) {
      description.name =
        `<anonymous@${description.start?.line || '?'}:`
        + `${description.start?.column || '?'}>`;
    }
    ownerChain.push(description);
  }
  const ownerParentIndex = owner ? path.indexOf(owner) - 1 : -1;
  const ownerDescription = owner
    ? {
        ...describeNode(
          owner,
          ownerParentIndex >= 0 ? path[ownerParentIndex] : null,
          source,
        ),
        ...completeNodeSource(owner, source, maxOwnerBytes),
      }
    : null;
  const statementParentIndex = statement ? path.indexOf(statement) - 1 : -1;
  const statementDescription = statement
    ? {
        ...describeNode(
          statement,
          statementParentIndex >= 0 ? path[statementParentIndex] : null,
          source,
        ),
        ...completeNodeSource(statement, source, maxOwnerBytes),
      }
    : null;
  const ownerLabel =
    ownerDescription?.name
    || ownerChain[0]?.name
    || '<top-level>';
  const targetLabel = exportKey(targetExport) || '<module>';
  return {
    usageNode: describeNode(
      path.at(-1),
      path.length > 1 ? path.at(-2) : null,
      source,
    ),
    ancestorChain: path.map((node, index) =>
      describeNode(node, index > 0 ? path[index - 1] : null, source)),
    topLevelStatement: statementDescription,
    topLevelOwner: ownerDescription,
    ownerChain,
    mechanicalOwnerToTargetExport: `${ownerLabel} -> ${targetLabel}`,
  };
}

function sourceMatchRecord(selected, duplicateIdenticalRows) {
  const row = selected.row;
  const source = String(row.source || '');
  return {
    jsonlLine: selected.line,
    matchKind: selected.matchKind,
    duplicateIdenticalRows,
    identifier: row.identifier || null,
    resource: rowResource(row) || null,
    bytes: row.bytes ?? Buffer.byteLength(source),
    sha256: row.sha256 || sha256(source),
  };
}

async function run(args) {
  const captureDir = resolve(args.dir || '.');
  const exportUsagePath = resolve(
    args['export-usage'] || resolve(captureDir, 'export-usage.json'),
  );
  const sourcesPath = resolve(
    args.sources || resolve(captureDir, 'post-loader-sources.jsonl'),
  );
  if (!existsSync(exportUsagePath)) {
    throw new Error(`Missing export-usage input: ${exportUsagePath}`);
  }
  if (!existsSync(sourcesPath)) {
    throw new Error(`Missing post-loader source input: ${sourcesPath}`);
  }

  const data = loadExportUsage(exportUsagePath);
  const selectedEdges = selectEdges(data, args);
  if (!selectedEdges.length) {
    throw new Error('No export-usage edge matched the requested filters');
  }
  const maxMatches = positiveInteger(
    args['max-matches'],
    '--max-matches',
    500,
  );
  if (selectedEdges.length > maxMatches) {
    throw new Error(
      `Matched ${selectedEdges.length} edges, exceeding --max-matches `
      + `${maxMatches}; refine the filters or raise the explicit limit`,
    );
  }
  const contextLines = nonNegativeInteger(
    args['context-lines'],
    '--context-lines',
    2,
  );
  const maxOwnerBytes = positiveInteger(
    args['max-owner-bytes'],
    '--max-owner-bytes',
    100000,
  );

  const originPaths = new Set(
    selectedEdges.map((edge) => edge.originPath).filter(Boolean),
  );
  const loaded = await loadSourceCandidates(sourcesPath, originPaths);
  const sourceByOrigin = new Map();
  const failures = [...loaded.failures];
  for (const originPath of originPaths) {
    const choice = chooseSourceCandidate(
      originPath,
      loaded.candidates.get(originPath) || [],
    );
    sourceByOrigin.set(originPath, choice);
    if (choice.failure) failures.push(choice.failure);
  }

  const parserLoad = loadBabelParser(captureDir, args);
  if (!parserLoad.parser) {
    failures.push({
      code: 'babel-parser-unavailable',
      reason:
        'Could not resolve @babel/parser. Retry with --project-root pointing '
        + 'to the audited package that provides @babel/parser, or pass '
        + '--parser-path.',
      attempts: parserLoad.attempts,
    });
  }

  const parsedByOrigin = new Map();
  if (parserLoad.parser) {
    for (const [originPath, choice] of sourceByOrigin) {
      if (!choice.selected) continue;
      const source = String(choice.selected.row.source || '');
      const parsed = parseSource(parserLoad.parser, source, originPath);
      parsedByOrigin.set(originPath, parsed);
      if (!parsed.ast) {
        failures.push({
          code: 'source-parse-failed',
          originPath,
          reason: 'Every Babel parser mode failed',
          attempts: parsed.attempts,
        });
      } else if (!parsed.clean) {
        failures.push({
          code: 'source-parse-recovered',
          originPath,
          reason:
            'Only a parser result with syntax recoveries was available; '
            + 'owner relationships may be incomplete',
          mode: parsed.mode,
          recoveries: parsed.recoveries,
          attempts: parsed.attempts,
        });
      }
    }
  }

  const usages = selectedEdges.map((edge) => {
    const edgeFailures = [];
    const choice = sourceByOrigin.get(edge.originPath);
    const source = choice?.selected
      ? String(choice.selected.row.source || '')
      : null;
    let location = null;
    let offsets = null;
    let snippet = null;
    let context = null;
    if (!choice?.selected) {
      edgeFailures.push(choice?.failure?.code || 'source-not-captured');
    } else if (!edge.raw[5]) {
      edgeFailures.push('missing-edge-location');
      failures.push({
        code: 'missing-edge-location',
        edgeIndex: edge.edgeIndex,
        originPath: edge.originPath,
        reason:
          'Rspack did not provide a consuming reference location for this edge',
      });
    } else {
      location = parseLocation(edge.raw[5]);
      if (!location) {
        edgeFailures.push('invalid-edge-location');
        failures.push({
          code: 'invalid-edge-location',
          edgeIndex: edge.edgeIndex,
          originPath: edge.originPath,
          loc: edge.raw[5],
          reason: 'The Rspack location string did not match a supported form',
        });
      } else {
        offsets = locationOffsets(source, location);
        if (!offsets) {
          edgeFailures.push('edge-location-out-of-bounds');
          failures.push({
            code: 'edge-location-out-of-bounds',
            edgeIndex: edge.edgeIndex,
            originPath: edge.originPath,
            loc: edge.raw[5],
            reason:
              'The consuming location is outside the captured post-loader source',
          });
        } else {
          snippet = {
            ...makeSnippet(source, location, contextLines),
            highlight: source.slice(offsets.start, offsets.end),
          };
          const parsed = parsedByOrigin.get(edge.originPath);
          if (!parserLoad.parser) {
            edgeFailures.push('babel-parser-unavailable');
          } else if (!parsed?.ast) {
            edgeFailures.push('source-parse-failed');
          } else {
            if (!parsed.clean) edgeFailures.push('source-parse-recovered');
            context = syntaxContext(
              parsed.ast,
              source,
              offsets,
              edge.raw[3],
              maxOwnerBytes,
            );
            if (!context) {
              edgeFailures.push('ast-node-not-found');
              failures.push({
                code: 'ast-node-not-found',
                edgeIndex: edge.edgeIndex,
                originPath: edge.originPath,
                loc: edge.raw[5],
                reason:
                  'No parsed syntax node contained the consuming location',
              });
            } else if (!context.topLevelOwner) {
              edgeFailures.push('top-level-owner-not-found');
              failures.push({
                code: 'top-level-owner-not-found',
                edgeIndex: edge.edgeIndex,
                originPath: edge.originPath,
                loc: edge.raw[5],
                reason:
                  'A syntax path was found but no top-level owner was resolved',
              });
            } else {
              const omitted = [
                context.topLevelStatement,
                context.topLevelOwner,
              ].filter(
                (node) =>
                  node
                  && node.sourceStatus !== 'complete',
              );
              if (omitted.length) {
                edgeFailures.push('owner-source-omitted');
                failures.push({
                  code: 'owner-source-omitted',
                  edgeIndex: edge.edgeIndex,
                  originPath: edge.originPath,
                  loc: edge.raw[5],
                  reason:
                    'The complete top-level syntax source exceeded '
                    + `--max-owner-bytes ${maxOwnerBytes}; retry with a `
                    + 'larger explicit limit or read the captured source',
                  omitted: omitted.map((node) => ({
                    type: node.type,
                    name: node.name,
                    bytes: node.bytes,
                    sourceStatus: node.sourceStatus,
                  })),
                });
              }
            }
          }
        }
      }
    }

    return {
      edgeIndex: edge.edgeIndex,
      origin: {
        ukey: edge.raw[0],
        path: edge.originPath || null,
        export: edge.raw[1] ?? null,
      },
      target: {
        ukey: edge.raw[2],
        path: edge.targetPath || null,
        export: edge.raw[3] ?? null,
      },
      dependencyId: edge.raw[4] ?? null,
      loc: edge.raw[5] ?? null,
      sourceMatch: choice?.selected
        ? sourceMatchRecord(
            choice.selected,
            choice.duplicateIdenticalRows,
          )
        : null,
      location,
      snippet,
      syntaxContext: context,
      failures: edgeFailures,
    };
  });

  const complete = failures.length === 0
    && usages.every((usage) => usage.failures.length === 0);
  return {
    schemaVersion: 1,
    kind: KIND,
    complete,
    generatedAt: new Date().toISOString(),
    inputs: {
      captureDir,
      exportUsage: exportUsagePath,
      postLoaderSources: sourcesPath,
      filters: Object.fromEntries(
        [
          'edge-index',
          'origin',
          'origin-export',
          'target',
          'export',
          'dependency-id',
          'loc',
        ]
          .filter((key) => args[key] !== undefined)
          .map((key) => [key, args[key]]),
      ),
      contextLines,
      maxOwnerBytes,
      maxMatches,
    },
    parser: parserLoad.parser
      ? {
          name: '@babel/parser',
          resolvedPath: parserLoad.resolvedPath,
          projectRoot: parserLoad.projectRoot,
          resolutionAttemptsBeforeSuccess: parserLoad.attempts,
        }
      : {
          name: '@babel/parser',
          resolvedPath: null,
          projectRoot: null,
          resolutionAttempts: parserLoad.attempts,
        },
    counts: {
      exportUsageModules: data.modules.length,
      exportUsageEdges: data.edges.length,
      matchedEdges: selectedEdges.length,
      uniqueConsumerModules: originPaths.size,
      postLoaderRowsScanned: loaded.scannedRows,
      usagesWithSnippet: usages.filter((usage) => usage.snippet).length,
      usagesWithSyntaxContext: usages.filter(
        (usage) => usage.syntaxContext,
      ).length,
      failedUsages: usages.filter((usage) => usage.failures.length).length,
      failures: failures.length,
    },
    usages,
    failures,
  };
}

function writeResult(result, args) {
  const body = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) {
    const outputPath = resolve(String(args.out));
    writeFileSync(outputPath, body, { flag: 'wx' });
    process.stdout.write(
      `${KIND}: complete=${result.complete} `
      + `usages=${result.counts.matchedEdges} -> ${outputPath}\n`,
    );
  } else {
    process.stdout.write(body);
  }
}

async function selfTest() {
  assert.deepEqual(parseLocation('4:16-23'), {
    start: { line: 4, column: 16 },
    end: { line: 4, column: 23 },
  });
  assert.deepEqual(parseLocation('4:16-5:3'), {
    start: { line: 4, column: 16 },
    end: { line: 5, column: 3 },
  });
  assert.equal(parseLocation('bad'), null);
  assert.equal(
    exportMatches(
      ['ChatTeaMessageResult', 'RESULT_STREAM_TIMEOUT'],
      'ChatTeaMessageResult',
    ),
    true,
  );

  const source = [
    "import { usedFoo } from './dep';",
    'export function foo() {',
    '  return function bar() {',
    '    console.log(usedFoo);',
    '  };',
    '}',
    '',
  ].join('\n');
  const usedStart = source.lastIndexOf('usedFoo');
  const usedEnd = usedStart + 'usedFoo'.length;
  const barStart = source.indexOf('function bar');
  const barEnd = source.indexOf('  };') + 3;
  const fooStart = source.indexOf('function foo');
  const fooEnd = source.indexOf('\n}', fooStart) + 2;
  const exportStart = source.indexOf('export function');
  const ast = {
    type: 'File',
    start: 0,
    end: source.length,
    program: {
      type: 'Program',
      start: 0,
      end: source.length,
      body: [{
        type: 'ExportNamedDeclaration',
        start: exportStart,
        end: fooEnd,
        declaration: {
          type: 'FunctionDeclaration',
          start: fooStart,
          end: fooEnd,
          id: { type: 'Identifier', name: 'foo' },
          body: {
            type: 'BlockStatement',
            start: source.indexOf('{', fooStart),
            end: fooEnd,
            body: [{
              type: 'ReturnStatement',
              start: source.indexOf('return'),
              end: barEnd,
              argument: {
                type: 'FunctionExpression',
                start: barStart,
                end: barEnd,
                id: { type: 'Identifier', name: 'bar' },
                body: {
                  type: 'BlockStatement',
                  start: source.indexOf('{', barStart),
                  end: barEnd,
                  body: [{
                    type: 'ExpressionStatement',
                    start: source.indexOf('console.log'),
                    end: source.indexOf(';', usedStart) + 1,
                    expression: {
                      type: 'CallExpression',
                      start: source.indexOf('console.log'),
                      end: source.indexOf(')', usedStart) + 1,
                      arguments: [{
                        type: 'Identifier',
                        name: 'usedFoo',
                        start: usedStart,
                        end: usedEnd,
                      }],
                    },
                  }],
                },
              },
            }],
          },
        },
      }],
    },
  };
  const context = syntaxContext(
    ast,
    source,
    { start: usedStart, end: usedEnd },
    ['usedFoo'],
    100000,
  );
  assert.equal(context.topLevelOwner.name, 'foo');
  assert.deepEqual(
    context.ownerChain.map((owner) => owner.name),
    ['foo', 'bar'],
  );
  assert.equal(context.mechanicalOwnerToTargetExport, 'foo -> usedFoo');
  assert.match(context.topLevelStatement.source, /^export function foo/);

  const fixtureRoot = mkdtempSync(
    resolve(tmpdir(), 'export-usage-context-'),
  );
  try {
    const sourcesPath = resolve(fixtureRoot, 'post-loader-sources.jsonl');
    writeFileSync(
      sourcesPath,
      `${JSON.stringify({
        identifier: 'javascript/auto|/fixture/consumer.js',
        resource: '/fixture/consumer.js',
        source,
      })}\n`,
    );
    const loaded = await loadSourceCandidates(
      sourcesPath,
      new Set(['/fixture/consumer.js']),
    );
    const choice = chooseSourceCandidate(
      '/fixture/consumer.js',
      loaded.candidates.get('/fixture/consumer.js'),
    );
    assert.equal(choice.selected.matchKind, 'exact-resource');
    assert.equal(loaded.failures.length, 0);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  process.stdout.write('extract-export-usage-context self-test passed\n');
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const result = await run(args);
  writeResult(result, args);
  if (!result.complete) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: KIND,
        complete: false,
        fatal: {
          name: error.name,
          reason: error.message,
        },
      }, null, 2)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  canonicalResource,
  chooseSourceCandidate,
  exportMatches,
  findContainingPath,
  loadSourceCandidates,
  parseLocation,
  run,
  selectEdges,
  syntaxContext,
};
