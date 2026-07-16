// Conservative analysis-only loader for recognizable transpiled CommonJS.
// Configure it as a pre-loader for a narrowly scoped A/B rule. Unsupported or
// ambiguous modules are returned unchanged and logged as skipped.

const { appendFileSync, existsSync, mkdirSync, readFileSync } = require('fs');
const { dirname, resolve } = require('path');

const IDENT = '[A-Za-z_$][\\w$]*';
const REQUIRE_RE = new RegExp(`^(?:var|let|const)\\s+(${IDENT})\\s*=\\s*require\\s*\\(\\s*(["'])([^"']+)\\2\\s*\\)\\s*;?$`, 's');
const EXPORT_STAR_RE = /^__exportStar\s*\(\s*require\s*\(\s*(["'])([^"']+)\1\s*\)\s*,\s*exports\s*\)\s*;?$/s;
const EXPORT_ASSIGN_RE = new RegExp(`^exports\\.(${IDENT}|default)\\s*=\\s*(${IDENT})\\s*;?$`, 's');
const ESM_MARKER_RE = /^Object\.defineProperty\s*\(\s*exports\s*,\s*(["'])__esModule\1\s*,\s*\{\s*value\s*:\s*true\s*\}\s*\)\s*;?$/s;
const STRICT_RE = /^(["'])use strict\1\s*;?$/s;

function getOptions(loaderContext) {
  if (typeof loaderContext.getOptions === 'function') return loaderContext.getOptions() || {};
  return loaderContext.query && typeof loaderContext.query === 'object' ? loaderContext.query : {};
}

function resolveSwc(projectRoot) {
  try { return require(require.resolve('@swc/core', { paths: [projectRoot] })); }
  catch (error) { throw new Error(`transpiled-cjs-to-esm-loader requires project-local @swc/core: ${error.message}`); }
}

function sliceSpan(source, program, span) {
  const buffer = Buffer.from(source);
  const base = Number(program.span?.start || 1);
  const start = Math.max(0, Number(span.start || base) - base);
  const end = Math.max(start, Number(span.end || base) - base);
  return { start, end, text: buffer.subarray(start, end).toString('utf8') };
}

function classifyStatement(text) {
  const trimmed = text.trim();
  if (STRICT_RE.test(trimmed)) return { kind: 'remove-strict' };
  if (ESM_MARKER_RE.test(trimmed)) return { kind: 'remove-marker' };
  let match = REQUIRE_RE.exec(trimmed);
  if (match) return { kind: 'require-binding', local: match[1], request: match[3], replacement: `import * as ${match[1]} from ${JSON.stringify(match[3])};` };
  match = EXPORT_STAR_RE.exec(trimmed);
  if (match) return { kind: 'export-star', request: match[2], replacement: `export * from ${JSON.stringify(match[2])};` };
  match = EXPORT_ASSIGN_RE.exec(trimmed);
  if (match) return { kind: 'export-binding', exported: match[1], local: match[2], replacement: `export { ${match[2]} as ${match[1]} };` };
  return { kind: 'other' };
}

function declaredTopLevelNames(program) {
  const names = new Set();
  const addPattern = (pattern) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') names.add(pattern.value || pattern.name);
    else if (pattern.type === 'ArrayPattern') for (const item of pattern.elements || []) addPattern(item);
    else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties || []) addPattern(property.value || property.argument || property.key);
    else if (pattern.type === 'RestElement') addPattern(pattern.argument);
    else if (pattern.type === 'AssignmentPattern') addPattern(pattern.left);
  };
  for (const statement of program.body || []) {
    if (statement.type === 'VariableDeclaration') for (const declaration of statement.declarations || []) addPattern(declaration.id);
    else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') addPattern(statement.identifier);
    else if (statement.type === 'ImportDeclaration') for (const specifier of statement.specifiers || []) addPattern(specifier.local);
  }
  return names;
}

function applyReplacements(source, replacements) {
  let buffer = Buffer.from(source);
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    buffer = Buffer.concat([buffer.subarray(0, replacement.start), Buffer.from(replacement.text), buffer.subarray(replacement.end)]);
  }
  return buffer.toString('utf8');
}

function transformCjsSource(source, swc, filename = 'module.js') {
  let program;
  try {
    program = swc.parseSync(source, { syntax: 'ecmascript', jsx: /\.[jt]sx$/.test(filename), dynamicImport: true });
  } catch (error) {
    return { transformed: false, reason: `parse-error: ${error.message}` };
  }

  const statements = (program.body || []).map((statement) => {
    const span = sliceSpan(source, program, statement.span);
    return { statement, ...span, classification: classifyStatement(span.text) };
  });
  if (!statements.some((row) => row.classification.kind === 'remove-marker')) {
    return { transformed: false, reason: 'missing recognizable __esModule marker' };
  }

  const fullText = source;
  const unsafePatterns = [
    [/\bmodule\s*\.\s*exports\b/, 'module.exports usage'],
    [/\bexports\s*\[/, 'computed exports usage'],
    [/\brequire\s*\.\s*(resolve|cache|main|extensions)\b/, 'require API usage'],
    [/\b(?:__dirname|__filename)\b/, 'CommonJS path globals'],
    [/(^|[^.\w$])this\b/, 'top-level this may differ in ESM'],
  ];
  for (const [pattern, reason] of unsafePatterns) if (pattern.test(fullText)) return { transformed: false, reason };

  const handled = new Set(['remove-strict', 'remove-marker', 'require-binding', 'export-star', 'export-binding']);
  for (const row of statements) {
    if (handled.has(row.classification.kind)) continue;
    const text = row.text;
    if (/\brequire\s*\(/.test(text)) return { transformed: false, reason: 'unsupported nested, dynamic, conditional, or multi-declarator require' };
    if (/\bexports\b/.test(text)) return { transformed: false, reason: 'unsupported exports reference or assignment' };
  }

  const declared = declaredTopLevelNames(program);
  const imported = new Set(statements.filter((row) => row.classification.kind === 'require-binding').map((row) => row.classification.local));
  const exportRows = statements.filter((row) => row.classification.kind === 'export-binding');
  const seenExports = new Set();
  for (const row of exportRows) {
    const { exported, local } = row.classification;
    if (seenExports.has(exported)) return { transformed: false, reason: `export ${exported} is assigned more than once` };
    seenExports.add(exported);
    if (!declared.has(local) && !imported.has(local)) return { transformed: false, reason: `export ${exported} references undeclared local ${local}` };
  }

  const transformRows = statements.filter((row) => handled.has(row.classification.kind));
  if (!transformRows.some((row) => ['require-binding', 'export-star', 'export-binding'].includes(row.classification.kind))) {
    return { transformed: false, reason: 'no supported CommonJS import/export statements' };
  }
  const replacements = transformRows.map((row) => ({
    start: row.start,
    end: row.end,
    text: row.classification.replacement || '',
  }));
  return {
    transformed: true,
    code: applyReplacements(source, replacements),
    operations: transformRows.map((row) => ({ kind: row.classification.kind, request: row.classification.request, exported: row.classification.exported })),
  };
}

function nearestPackage(resource) {
  let current = dirname(resource);
  while (dirname(current) !== current) {
    const candidate = resolve(current, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
        return { packageJson: candidate, name: parsed.name || null, version: parsed.version || null };
      } catch { return { packageJson: candidate, name: null, version: null }; }
    }
    current = dirname(current);
  }
  return null;
}

function appendReport(reportPath, row) {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(row)}\n`);
}

function loader(source, inputSourceMap) {
  this.cacheable?.(true);
  const callback = this.async();
  const options = getOptions(this);
  const rootContext = this.rootContext || process.cwd();
  const projectRoot = options.projectRoot ? resolve(rootContext, options.projectRoot) : rootContext;
  const reportPath = options.reportPath ? resolve(projectRoot, options.reportPath) : null;
  const resource = this.resourcePath;
  try {
    const swc = resolveSwc(projectRoot);
    const result = transformCjsSource(String(source), swc, resource);
    const packageInfo = nearestPackage(resource);
    if (!result.transformed) {
      appendReport(reportPath, {
        resource,
        resourcePath: resource,
        package: packageInfo,
        status: 'skipped',
        action: 'skipped',
        transformed: false,
        reason: result.reason,
        skipReason: result.reason,
        moduleType: this._module?.type || 'javascript/auto',
      });
      return callback(null, source, inputSourceMap);
    }
    const printed = swc.transformSync(result.code, {
      filename: resource,
      sourceMaps: true,
      sourceFileName: resource,
      jsc: { parser: { syntax: 'ecmascript', jsx: /\.[jt]sx$/.test(resource) }, target: 'es2022' },
      module: { type: 'es6' },
      minify: false,
    });
    appendReport(reportPath, {
      resource,
      resourcePath: resource,
      package: packageInfo,
      status: 'transformed',
      action: 'transformed',
      transformed: true,
      operations: result.operations,
      moduleType: this._module?.type || 'javascript/auto',
    });
    return callback(null, printed.code, printed.map ? JSON.parse(printed.map) : null);
  } catch (error) {
    appendReport(reportPath, {
      resource,
      resourcePath: resource,
      status: 'error',
      action: 'error',
      transformed: false,
      reason: error.message,
      skipReason: `loader-error: ${error.message}`,
      moduleType: this._module?.type || 'javascript/auto',
    });
    return callback(error);
  }
}

if (require.main === module && process.argv.includes('--self-test')) {
  const rows = [
    classifyStatement('const dep = require("dep");').kind,
    classifyStatement('exports.value = value;').kind,
    classifyStatement('Object.defineProperty(exports, "__esModule", { value: true });').kind,
  ];
  if (rows.join(',') !== 'require-binding,export-binding,remove-marker') throw new Error('self-test failed');
  const statements = [
    'Object.defineProperty(exports, "__esModule", { value: true });',
    'const dep = require("dep");',
    'const value = dep.value;',
    'exports.value = value;',
  ];
  const sample = statements.join('\n');
  let byteOffset = 1;
  const body = statements.map((statement, index) => {
    const start = byteOffset;
    const end = start + Buffer.byteLength(statement);
    byteOffset = end + (index < statements.length - 1 ? 1 : 0);
    if (index === 1) return { type: 'VariableDeclaration', span: { start, end }, declarations: [{ id: { type: 'Identifier', value: 'dep' } }] };
    if (index === 2) return { type: 'VariableDeclaration', span: { start, end }, declarations: [{ id: { type: 'Identifier', value: 'value' } }] };
    return { type: 'ExpressionStatement', span: { start, end } };
  });
  const transformed = transformCjsSource(sample, { parseSync: () => ({ span: { start: 1, end: byteOffset }, body }) }, 'fixture.js');
  if (!transformed.transformed || !transformed.code.includes('import * as dep from "dep";') || !transformed.code.includes('export { value as value };') || transformed.code.includes('__esModule')) throw new Error('transform self-test failed');
  console.log('transpiled-cjs-to-esm-loader self-test passed');
}

module.exports = loader;
module.exports.applyReplacements = applyReplacements;
module.exports.classifyStatement = classifyStatement;
module.exports.transformCjsSource = transformCjsSource;
