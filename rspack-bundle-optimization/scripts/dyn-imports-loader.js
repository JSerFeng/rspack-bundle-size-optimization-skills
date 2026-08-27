/* eslint-disable max-lines, no-magic-numbers, @typescript-eslint/no-require-imports */
/**
 * Rspack 动态导入导出投影 loader。
 *
 * 这个 loader 在 Rspack 解析模块前分析一方源码中的 `import()`，只有能够静态证明完整
 * 导出集合时，才插入 `rspackExports` 魔法注释。无法证明的普通用法保持原样；可能让最终
 * 产物错误裁剪导出的情况会直接终止构建，而不是静默跳过。
 *
 * 支持的主要消费形态：
 * - `await import()` 后直接读取成员、绑定 namespace 后读取静态成员，或进行对象解构；
 * - `import().then()` 的单参数箭头回调，包括 namespace 成员读取和参数解构；
 * - `await Promise.all([import(), ...])` 直接绑定到数组 pattern，并按输入/结果槽位逐一推断。
 *
 * 一旦同一 namespace 除静态成员读取外还作为完整对象使用，就对该 import() 安全 bailout，
 * 保持源码原样。直接 `eval`、普通 `function` 形式的 `.then()` 回调，以及无法验证的手写导出
 * 注释属于最终产物安全边界，会 fail closed 并终止模块构建。
 *
 * 接入约束：
 * - 作为 `enforce: 'pre'` loader 使用，确保看到转换前的原始 `import()`；
 * - 默认只处理一方源码，不要未经源码和副作用审查直接覆盖 `node_modules`；
 * - 依赖从 loader 选项 `dependencyRoot`、环境变量
 *   `RSPACK_DYN_IMPORTS_LOADER_DEPENDENCY_ROOT`、脚本目录或当前目录解析；
 * - 自动修改只代表语法投影成立，真实包体积收益仍需生产构建 A/B 确认。
 */
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

const BUILD_INFO_KEY = 'rspackExports';
const LOADER_VERSION = 5;
const DEPENDENCY_ROOT_ENV = 'RSPACK_DYN_IMPORTS_LOADER_DEPENDENCY_ROOT';
const RUNTIME_DEPENDENCY_IDS = ['@swc/core', 'magic-string', '@ampproject/remapping'];
const runtimeDependencyCache = new Map();
const DYNAMIC_IMPORT_PATTERN = /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\(/;
const MAGIC_COMMENT_PATTERN = /\b(?:rspack|webpack)Exports\s*:/;
const SPAN_SENTINEL = '\n0;';
const SAFETY_CRITICAL_BAILOUT_REASONS = new Set(['direct-eval', 'unsupported-then-callback']);
const TRANSPARENT_EXPRESSION_TYPES = new Set([
  'ParenthesisExpression',
  'TsAsExpression',
  'TsConstAssertion',
  'TsInstantiation',
  'TsNonNullExpression',
  'TsSatisfiesExpression',
  'TsTypeAssertion',
]);

// Loader 位于 Skill 目录时，Node 不会自动去业务项目的 node_modules 中找依赖。
// 因此所有外部依赖都从一个明确的项目根目录解析；把三个包放在同一依赖边界内，避免混用
// 不同 workspace 或不同版本的 SWC、MagicString 和 source-map remapper。
function dependencyAnchors(explicitRoot) {
  const roots = [
    explicitRoot,
    process.env[DEPENDENCY_ROOT_ENV],
    __dirname,
    process.cwd(),
  ].filter(Boolean);
  return [
    ...new Set(
      roots.map((root) => {
        const resolved = path.resolve(String(root));
        return path.basename(resolved) === 'package.json'
          ? resolved
          : path.join(resolved, 'package.json');
      }),
    ),
  ];
}

function loadRuntimeDependencies(explicitRoot) {
  const failures = [];
  for (const anchor of dependencyAnchors(explicitRoot)) {
    if (runtimeDependencyCache.has(anchor)) {
      return runtimeDependencyCache.get(anchor);
    }

    try {
      const projectRequire = createRequire(anchor);
      const swc = projectRequire('@swc/core');
      const magicStringModule = projectRequire('magic-string');
      const remappingModule = projectRequire('@ampproject/remapping');
      const dependencies = {
        parseSync: swc.parseSync,
        MagicString: magicStringModule.default || magicStringModule,
        remapping: remappingModule.default || remappingModule,
        anchor,
      };
      if (
        typeof dependencies.parseSync !== 'function' ||
        typeof dependencies.MagicString !== 'function' ||
        typeof dependencies.remapping !== 'function'
      ) {
        throw new TypeError('resolved package does not expose the expected CommonJS API');
      }
      runtimeDependencyCache.set(anchor, dependencies);
      return dependencies;
    } catch (error) {
      failures.push(`${anchor}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `[dyn-imports-loader] 无法从同一项目依赖边界解析 ${RUNTIME_DEPENDENCY_IDS.join(', ')}。\n` +
      `请安装这些依赖，并通过 loader 选项 dependencyRoot 或环境变量 ${DEPENDENCY_ROOT_ENV} ` +
      `指向包含 package.json 的目录。\n尝试记录：\n${failures.map((item) => `- ${item}`).join('\n')}`,
  );
}

// ── AST 基础设施与解析配置 ──────────────────────────────────────────────────

function isAstNode(value) {
  return Boolean(value && typeof value === 'object' && typeof value.type === 'string');
}

function walkAst(value, visitor, parentNode = null) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkAst(item, visitor, parentNode);
    }
    return;
  }

  const currentNode = isAstNode(value) ? value : parentNode;
  if (isAstNode(value)) {
    visitor(value, parentNode);
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'span' || key === 'ctxt') {
      continue;
    }
    walkAst(child, visitor, currentNode);
  }
}

function createParentMap(ast) {
  const parentMap = new WeakMap();
  walkAst(ast, (node, parent) => {
    if (parent) {
      parentMap.set(node, parent);
    }
  });
  return parentMap;
}

function getParserOptions(resourcePath) {
  const extension = path.extname(resourcePath).toLowerCase();
  const isTypeScript = ['.ts', '.tsx', '.mts', '.cts'].includes(extension);

  if (isTypeScript) {
    return {
      syntax: 'typescript',
      tsx: extension === '.tsx',
      decorators: true,
      dynamicImport: true,
      target: 'es2022',
    };
  }

  return {
    syntax: 'ecmascript',
    jsx: extension === '.jsx',
    decorators: true,
    dynamicImport: true,
    target: 'es2022',
  };
}

function isImportCall(node) {
  return node?.type === 'CallExpression' && node.callee?.type === 'Import';
}

function getImportArgument(callExpression) {
  const firstArgument = callExpression.arguments?.[0];
  if (!firstArgument || firstArgument.spread || !firstArgument.expression) {
    return null;
  }
  return firstArgument.expression;
}

function getStaticImportRequest(callExpression) {
  const argument = getImportArgument(callExpression);
  return argument?.type === 'StringLiteral' ? argument.value : null;
}

function getStaticPropertyName(property) {
  if (!property) {
    return null;
  }
  if (property.type === 'Identifier' || property.type === 'StringLiteral') {
    return property.value;
  }
  if (property.type === 'NumericLiteral') {
    return String(property.value);
  }
  if (property.type === 'Computed') {
    const { expression } = property;
    if (expression?.type === 'StringLiteral') {
      return expression.value;
    }
    if (expression?.type === 'NumericLiteral') {
      return String(expression.value);
    }
    return null;
  }
  return null;
}

function unique(values) {
  return [...new Set(values)];
}

// ── 动态导入的导出使用推断 ──────────────────────────────────────────────────

function exportsFromObjectPattern(pattern) {
  const exports = [];
  for (const property of pattern.properties || []) {
    if (property.type === 'RestElement') {
      return { reason: 'object-rest' };
    }

    let name = null;
    if (property.type === 'AssignmentPatternProperty') {
      name = getStaticPropertyName(property.key);
    } else if (property.type === 'KeyValuePatternProperty') {
      name = getStaticPropertyName(property.key);
    }

    if (name === null) {
      return { reason: 'computed-destructuring-key' };
    }
    exports.push(name);
  }

  if (exports.length === 0) {
    return { reason: 'empty-destructuring' };
  }
  return { exports: unique(exports), kind: 'object-destructuring' };
}

function identifierKey(identifier) {
  return `${identifier.value}:${identifier.ctxt ?? 0}`;
}

function isTransparentExpressionWrapper(parent, child) {
  return Boolean(parent && parent.expression === child && TRANSPARENT_EXPRESSION_TYPES.has(parent.type));
}

function unwrapTransparentExpression(expression) {
  let current = expression;
  while (current?.expression && TRANSPARENT_EXPRESSION_TYPES.has(current.type)) {
    current = current.expression;
  }
  return current;
}

function containsDirectEval(root) {
  let found = false;
  walkAst(root, (node) => {
    if (found || node.type !== 'CallExpression') {
      return;
    }
    const callee = unwrapTransparentExpression(node.callee);
    if (callee?.type === 'Identifier' && callee.value === 'eval') {
      found = true;
    }
  });
  return found;
}

function isTypeOnlyReference(node, parentMap) {
  let current = node;
  while (current) {
    const parent = parentMap.get(current);
    if (!parent) {
      return false;
    }
    if (isTransparentExpressionWrapper(parent, current)) {
      current = parent;
      continue;
    }

    // 限定成员既可能出现在类型位置，也可能出现在运行时表达式中。继续向上查找，直到确定
    // 外层语境，不能只凭 MemberExpression 本身把它误判成类型引用。
    if (parent.type === 'MemberExpression' && parent.object === current) {
      current = parent;
      continue;
    }
    if (parent.type === 'TsQualifiedName' && parent.left === current) {
      current = parent;
      continue;
    }

    // 这些 Ts 前缀节点包含 TypeScript 转换后仍会存在的运行时表达式。
    if (parent.type === 'TsExportAssignment' && parent.expression === current) {
      return false;
    }
    if (parent.type === 'TsEnumMember' && parent.init === current) {
      return false;
    }
    if (parent.type === 'TsImportEqualsDeclaration' && parent.moduleRef === current) {
      return Boolean(parent.declare || parent.isTypeOnly);
    }
    if (parent.type === 'TsParameterProperty' && parent.param === current) {
      return false;
    }

    return parent.type.startsWith('Ts');
  }
  return false;
}

function getStaticNamespaceMemberName(node, parentMap) {
  let current = node;
  let parent = parentMap.get(current);
  while (isTransparentExpressionWrapper(parent, current)) {
    current = parent;
    parent = parentMap.get(current);
  }

  if (parent?.type === 'MemberExpression' && parent.object === current) {
    return getStaticPropertyName(parent.property);
  }
  if (parent?.type === 'TsQualifiedName' && parent.left === current) {
    return getStaticPropertyName(parent.right);
  }
  return null;
}

function isAssignmentTarget(node, parentMap) {
  let current = node;
  while (current) {
    const parent = parentMap.get(current);
    if (!parent) {
      return false;
    }
    if (parent.type === 'AssignmentExpression') {
      return parent.left === current;
    }
    if (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') {
      return parent.left === current;
    }
    if (isTransparentExpressionWrapper(parent, current)) {
      current = parent;
      continue;
    }
    if (parent.type === 'RestElement' && parent.argument === current) {
      current = parent;
      continue;
    }
    if (parent.type === 'AssignmentPattern' && parent.left === current) {
      current = parent;
      continue;
    }
    if (parent.type === 'KeyValuePatternProperty' && parent.value === current) {
      current = parent;
      continue;
    }
    if (
      (parent.type === 'ObjectPattern' && parent.properties?.includes(current)) ||
      (parent.type === 'ArrayPattern' && parent.elements?.includes(current))
    ) {
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

function isWriteAccess(memberExpression, parentMap) {
  let current = memberExpression;
  while (isTransparentExpressionWrapper(parentMap.get(current), current)) {
    current = parentMap.get(current);
  }
  const parent = parentMap.get(current);
  return Boolean(
    isAssignmentTarget(current, parentMap) ||
      (parent?.type === 'UpdateExpression' && parent.argument === current) ||
      (parent?.type === 'UnaryExpression' && parent.operator === 'delete' && parent.argument === current),
  );
}

function exportsFromIdentifierReferences(root, binding, parentMap) {
  if (containsDirectEval(root)) {
    return { reason: 'direct-eval' };
  }

  const expectedKey = identifierKey(binding);
  const exports = [];
  let reason = null;

  walkAst(root, (node, parent) => {
    if (reason || node === binding || node.type !== 'Identifier' || identifierKey(node) !== expectedKey) {
      return;
    }
    if (isTypeOnlyReference(node, parentMap)) {
      // 后续 decorator metadata 转换可能把类型位置的 `ns.Type` 重新变成运行时属性读取。
      // 因此，即使当前 TypeScript 转换会删除它，也要把静态成员名保留在导出投影中。裸命名
      // 空间引用无法用导出白名单表达，必须对该 import() 保守退出。
      const typeMemberName = getStaticNamespaceMemberName(node, parentMap);
      if (typeMemberName === null) {
        reason = 'type-namespace-reference';
        return;
      }
      exports.push(typeMemberName);
      return;
    }

    let reference = node;
    let referenceParent = parent;
    while (isTransparentExpressionWrapper(referenceParent, reference)) {
      reference = referenceParent;
      referenceParent = parentMap.get(reference);
    }

    if (referenceParent?.type !== 'MemberExpression' || referenceParent.object !== reference) {
      reason = 'namespace-escape';
      return;
    }

    if (isWriteAccess(referenceParent, parentMap)) {
      reason = 'namespace-property-write';
      return;
    }

    const name = getStaticPropertyName(referenceParent.property);
    if (name === null) {
      reason = 'computed-member';
      return;
    }
    exports.push(name);
  });

  if (reason) {
    return { reason };
  }
  if (exports.length === 0) {
    return { reason: 'no-static-member-read' };
  }
  return { exports: unique(exports), kind: 'namespace-member-read' };
}

function climbImportValue(callExpression, parentMap) {
  let current = callExpression;
  let sawAwait = false;

  while (true) {
    const parent = parentMap.get(current);
    if (parent?.type === 'AwaitExpression' && parent.argument === current) {
      sawAwait = true;
      current = parent;
      continue;
    }
    if (isTransparentExpressionWrapper(parent, current)) {
      current = parent;
      continue;
    }
    return { current, parent, sawAwait };
  }
}

function getCallbackParameter(callback) {
  if (callback?.type === 'ArrowFunctionExpression') {
    return callback.params?.length === 1 ? callback.params[0] : null;
  }
  return null;
}

function inferThenCallback(callExpression, parentMap) {
  let current = callExpression;
  while (isTransparentExpressionWrapper(parentMap.get(current), current)) {
    current = parentMap.get(current);
  }

  const memberExpression = parentMap.get(current);
  if (
    memberExpression?.type !== 'MemberExpression' ||
    memberExpression.object !== current ||
    getStaticPropertyName(memberExpression.property) !== 'then'
  ) {
    return null;
  }

  const thenCall = parentMap.get(memberExpression);
  if (thenCall?.type !== 'CallExpression' || thenCall.callee !== memberExpression) {
    return null;
  }

  const callback = thenCall.arguments?.[0]?.expression;
  const parameter = getCallbackParameter(callback);
  if (!callback || !parameter) {
    return { reason: 'unsupported-then-callback' };
  }
  if (parameter.type === 'ObjectPattern') {
    return exportsFromObjectPattern(parameter);
  }
  if (parameter.type === 'Identifier') {
    return exportsFromIdentifierReferences(callback, parameter, parentMap);
  }
  return { reason: 'unsupported-then-parameter' };
}

function inferExportsFromBindingPattern(pattern, root, parentMap) {
  let current = pattern;
  while (current?.type === 'AssignmentPattern') {
    current = current.left;
  }
  if (current?.type === 'ObjectPattern') {
    return exportsFromObjectPattern(current);
  }
  if (current?.type === 'Identifier') {
    return exportsFromIdentifierReferences(root, current, parentMap);
  }
  return { reason: 'unsupported-binding-pattern' };
}

function promiseAllCalleeStatus(callee) {
  const unwrapped = unwrapTransparentExpression(callee);
  if (
    unwrapped?.type !== 'MemberExpression' ||
    unwrapped.object?.type !== 'Identifier' ||
    unwrapped.object.value !== 'Promise' ||
    getStaticPropertyName(unwrapped.property) !== 'all'
  ) {
    return 'not-promise-all';
  }

  // parseSync 会把未绑定的全局标识符放在 ctxt=1；局部变量或参数使用其他 binding ctxt。
  // 只接受真正的全局 Promise，避免把用户自定义的同名对象当成标准 Promise.all。
  return unwrapped.object.ctxt === 1 ? 'supported' : 'shadowed-promise-all';
}

function inferAwaitedPromiseAllElement(callExpression, ast, parentMap) {
  let current = callExpression;
  while (isTransparentExpressionWrapper(parentMap.get(current), current)) {
    current = parentMap.get(current);
  }

  const values = parentMap.get(current);
  if (values?.type !== 'ArrayExpression') {
    return null;
  }
  if (values.elements?.some((element) => element?.spread)) {
    return { reason: 'promise-all-spread' };
  }

  const valueIndex = values.elements?.findIndex(
    (element) => element && unwrapTransparentExpression(element.expression) === callExpression,
  );
  if (valueIndex === undefined || valueIndex < 0) {
    return null;
  }

  let arrayValue = values;
  while (isTransparentExpressionWrapper(parentMap.get(arrayValue), arrayValue)) {
    arrayValue = parentMap.get(arrayValue);
  }
  const promiseAllCall = parentMap.get(arrayValue);
  if (promiseAllCall?.type !== 'CallExpression') {
    return null;
  }

  const calleeStatus = promiseAllCalleeStatus(promiseAllCall.callee);
  if (calleeStatus === 'not-promise-all') {
    return null;
  }
  if (calleeStatus !== 'supported') {
    return { reason: calleeStatus };
  }

  const argument = promiseAllCall.arguments?.[0];
  if (
    promiseAllCall.arguments?.length !== 1 ||
    !argument ||
    argument.spread ||
    unwrapTransparentExpression(argument.expression) !== values
  ) {
    return { reason: 'unsupported-promise-all-call' };
  }

  let resultValue = promiseAllCall;
  let resultParent = parentMap.get(resultValue);
  while (isTransparentExpressionWrapper(resultParent, resultValue)) {
    resultValue = resultParent;
    resultParent = parentMap.get(resultValue);
  }
  if (resultParent?.type !== 'AwaitExpression' || resultParent.argument !== resultValue) {
    return { reason: 'promise-all-not-awaited' };
  }

  resultValue = resultParent;
  resultParent = parentMap.get(resultValue);
  while (isTransparentExpressionWrapper(resultParent, resultValue)) {
    resultValue = resultParent;
    resultParent = parentMap.get(resultValue);
  }

  let resultPattern = null;
  if (resultParent?.type === 'VariableDeclarator' && resultParent.init === resultValue) {
    resultPattern = resultParent.id;
  } else if (resultParent?.type === 'AssignmentExpression' && resultParent.right === resultValue) {
    resultPattern = resultParent.left;
  }
  if (resultPattern?.type !== 'ArrayPattern') {
    return { reason: 'unsupported-promise-all-result' };
  }

  const slotPattern = resultPattern.elements?.[valueIndex];
  if (!slotPattern) {
    return { reason: 'unused-promise-all-slot' };
  }
  if (slotPattern.type === 'RestElement') {
    return { reason: 'promise-all-rest-binding' };
  }

  // Promise.all 保持输入与结果的槽位顺序。逐槽位分析可以让每个 import() 得到自己的
  // 导出投影，同时不会把相邻动态导入的使用关系混在一起。
  const inference = inferExportsFromBindingPattern(slotPattern, ast, parentMap);
  return inference.exports ? { ...inference, kind: `promise-all-${inference.kind}` } : inference;
}

function inferExports(callExpression, ast, parentMap) {
  const thenInference = inferThenCallback(callExpression, parentMap);
  if (thenInference) {
    return thenInference;
  }

  const promiseAllInference = inferAwaitedPromiseAllElement(callExpression, ast, parentMap);
  if (promiseAllInference) {
    return promiseAllInference;
  }

  const { current, parent, sawAwait } = climbImportValue(callExpression, parentMap);
  if (!sawAwait) {
    return { reason: 'unsupported-import-context' };
  }

  if (parent?.type === 'MemberExpression' && parent.object === current) {
    if (isWriteAccess(parent, parentMap)) {
      return { reason: 'namespace-property-write' };
    }
    const name = getStaticPropertyName(parent.property);
    return name === null ? { reason: 'computed-member' } : { exports: [name], kind: 'await-member-read' };
  }

  if (parent?.type === 'VariableDeclarator' && parent.init === current) {
    if (parent.id.type === 'ObjectPattern') {
      return exportsFromObjectPattern(parent.id);
    }
    if (parent.id.type === 'Identifier') {
      return exportsFromIdentifierReferences(ast, parent.id, parentMap);
    }
    return { reason: 'unsupported-binding-pattern' };
  }

  if (
    parent?.type === 'AssignmentExpression' &&
    parent.right === current &&
    parent.left.type === 'ObjectPattern'
  ) {
    const inference = exportsFromObjectPattern(parent.left);
    return inference.exports ? { ...inference, kind: 'object-destructuring-assignment' } : inference;
  }

  return { reason: 'unsupported-import-context' };
}

function byteOffsetToLocation(sourceBuffer, offset) {
  const prefix = sourceBuffer.subarray(0, Math.max(0, offset)).toString('utf8');
  const lines = prefix.split('\n');
  return {
    line: lines.length,
    column: [...lines.at(-1)].length + 1,
  };
}

function toLocalBytePosition(position, fileSpanStart) {
  return position - fileSpanStart;
}

function magicCommentRange(sourceBuffer, callExpression, fileSpanStart) {
  const argument = getImportArgument(callExpression);
  if (!argument) {
    return null;
  }
  const start = toLocalBytePosition(callExpression.callee.span.end, fileSpanStart);
  const end = toLocalBytePosition(argument.span.start, fileSpanStart);
  return { start, end, text: sourceBuffer.subarray(start, end).toString('utf8') };
}

// ── 现有魔法注释的解析与 fail-closed 校验 ────────────────────────────────────

function extractExistingExportsExpression(text) {
  const matches = [...text.matchAll(/\b(?:rspack|webpack)Exports\s*:/g)];
  if (matches.length !== 1) {
    return null;
  }

  let index = matches[0].index + matches[0][0].length;
  while (/\s/.test(text[index] || '')) {
    index += 1;
  }
  const start = index;
  const first = text[index];
  if (first === '"' || first === "'") {
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === first) {
        return text.slice(start, index + 1);
      }
      index += 1;
    }
    return null;
  }
  if (first !== '[') {
    return null;
  }

  let depth = 0;
  let quote = null;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function parseExistingExports(text, parseSync) {
  const expression = extractExistingExportsExpression(text);
  if (!expression) {
    return null;
  }
  try {
    const ast = parseSync(`const __rspack_exports__ = ${expression};`, getParserOptions('comment.js'));
    const declaration = ast.body[0]?.declarations?.[0];
    const value = declaration?.init;
    if (value?.type === 'StringLiteral') {
      return [value.value];
    }
    if (value?.type !== 'ArrayExpression') {
      return null;
    }
    const exports = [];
    for (const element of value.elements || []) {
      if (!element || element.spread || element.expression?.type !== 'StringLiteral') {
        return null;
      }
      exports.push(element.expression.value);
    }
    return exports;
  } catch {
    return null;
  }
}

function missingStrings(required, available) {
  const availableSet = new Set(available || []);
  return unique((required || []).filter((item) => !availableSet.has(item)));
}

function existingCommentStatus(inference, existingExports) {
  if (!existingExports) {
    return 'existing-comment-unparseable';
  }
  if (!inference.exports) {
    return 'existing-comment-unvalidated';
  }
  return missingStrings(inference.exports, existingExports).length === 0
    ? 'existing-comment-validated'
    : 'existing-comment-mismatch';
}

function isFatalRecord(record) {
  return (
    record.status === 'parse-error' ||
    record.status === 'existing-comment-mismatch' ||
    record.status === 'existing-comment-unparseable' ||
    record.status === 'existing-comment-unvalidated' ||
    (record.status === 'bailout' && SAFETY_CRITICAL_BAILOUT_REASONS.has(record.reason))
  );
}

function createSafetyError(resourcePath, records) {
  const details = records.map((record) => {
    const location = record.location ? `${record.location.line}:${record.location.column}` : 'unknown';
    const request = record.request ?? '<dynamic request>';
    if (record.status === 'parse-error') {
      return `${location}: SWC parse failed: ${record.reason}`;
    }
    if (record.status === 'existing-comment-mismatch') {
      return `${location} ${request}: missing inferred export(s) ${record.missingExports
        .map((name) => JSON.stringify(name))
        .join(', ')}`;
    }
    if (record.status === 'existing-comment-unparseable') {
      return `${location} ${request}: unparseable rspackExports/webpackExports value`;
    }
    return `${location} ${request}: ${record.reason}`;
  });
  return new Error(
    `[dyn-imports-loader] Refusing unsafe or unproven dynamic import usage in ${resourcePath}:\n${details
      .map((detail) => `- ${detail}`)
      .join('\n')}`,
  );
}

// ── 注释写入与 source map 合成 ──────────────────────────────────────────────

function serializeMagicCommentExport(name) {
  // 块注释遇到第一段原始 `*/` 就会结束，即使它看起来位于字符串内也一样。只编码其中的
  // 斜杠；SWC 和 Rspack 会把 `\u002f` 还原成真正的导出名称。
  return JSON.stringify(name).replaceAll('*/', '*\\u002f');
}

function createMagicComment(exports) {
  return `/* rspackExports: [${exports.map(serializeMagicCommentExport).join(', ')}] */ `;
}

function byteOffsetToCodeUnitOffset(sourceBuffer, offset) {
  return sourceBuffer.subarray(0, offset).toString('utf8').length;
}

function applyInsertions(sourceText, sourceBuffer, insertions, resourcePath, sourceMap, MagicString) {
  const output = new MagicString(sourceText);
  for (const insertion of insertions) {
    output.appendLeft(byteOffsetToCodeUnitOffset(sourceBuffer, insertion.offset), insertion.text);
  }

  return {
    code: output.toString(),
    map: sourceMap
      ? output.generateMap({
          source: resourcePath,
          includeContent: true,
          hires: true,
        })
      : undefined,
  };
}

function normalizeSourceMap(sourceMap) {
  if (Buffer.isBuffer(sourceMap)) {
    return JSON.parse(sourceMap.toString('utf8'));
  }
  return typeof sourceMap === 'string' ? JSON.parse(sourceMap) : sourceMap;
}

function composeSourceMaps(generatedSourceMap, inputSourceMap, remapping) {
  if (!generatedSourceMap) {
    return inputSourceMap;
  }
  if (!inputSourceMap) {
    return generatedSourceMap;
  }
  return remapping([normalizeSourceMap(generatedSourceMap), normalizeSourceMap(inputSourceMap)], () => null);
}

function transformSource(source, resourcePath = 'unknown.ts', options = {}) {
  const sourceText = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  if (!DYNAMIC_IMPORT_PATTERN.test(sourceText)) {
    return { code: sourceText, records: [], changed: false };
  }

  const dependencies = options.dependencies || loadRuntimeDependencies(options.dependencyRoot);
  const { parseSync, MagicString } = dependencies;
  const sourceBuffer = Buffer.from(sourceText);
  let ast;
  let fileSpanStart;
  try {
    ast = parseSync(`${sourceText}${SPAN_SENTINEL}`, getParserOptions(resourcePath));
    const sentinelStatement = ast.body.at(-1);
    if (sentinelStatement?.type !== 'ExpressionStatement') {
      throw new Error('Unable to locate the SWC span sentinel');
    }
    fileSpanStart = sentinelStatement.span.start - sourceBuffer.length - 1;
    ast.body.pop();
  } catch (error) {
    return {
      code: sourceText,
      changed: false,
      records: [
        {
          status: 'parse-error',
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const parentMap = createParentMap(ast);
  const imports = [];
  walkAst(ast, (node) => {
    if (isImportCall(node)) {
      imports.push(node);
    }
  });

  const records = [];
  const insertions = [];
  for (const callExpression of imports) {
    const argument = getImportArgument(callExpression);
    const request = getStaticImportRequest(callExpression);
    const baseRecord = {
      request,
      startByte: toLocalBytePosition(callExpression.span.start, fileSpanStart),
      endByte: toLocalBytePosition(callExpression.span.end, fileSpanStart),
      argumentStartByte: argument ? toLocalBytePosition(argument.span.start, fileSpanStart) : null,
    };
    baseRecord.location = byteOffsetToLocation(sourceBuffer, baseRecord.startByte);

    const commentRange = magicCommentRange(sourceBuffer, callExpression, fileSpanStart);
    const hasExistingComment = Boolean(commentRange && MAGIC_COMMENT_PATTERN.test(commentRange.text));
    if (hasExistingComment) {
      const inference = inferExports(callExpression, ast, parentMap);
      // 手写投影比自动推断更危险：一旦少列导出，最终产物可能正常构建却在运行时缺失符号。
      // 所以这里只接受可解析且覆盖完整推断集合的注释；其余情况交给 fatal gate 终止构建。
      const existingExports = parseExistingExports(commentRange.text, parseSync);
      const missingExports =
        inference.exports && existingExports ? missingStrings(inference.exports, existingExports) : undefined;
      records.push({
        ...baseRecord,
        status: existingCommentStatus(inference, existingExports),
        reason: inference.reason,
        kind: inference.kind,
        inferredExports: inference.exports,
        existingExports,
        ...(missingExports?.length ? { missingExports } : {}),
      });
      continue;
    }

    const inference = inferExports(callExpression, ast, parentMap);
    if (request === null) {
      const reason = SAFETY_CRITICAL_BAILOUT_REASONS.has(inference.reason)
        ? inference.reason
        : 'dynamic-request';
      records.push({ ...baseRecord, status: 'bailout', reason });
      continue;
    }

    if (!inference.exports) {
      records.push({ ...baseRecord, status: 'bailout', reason: inference.reason });
      continue;
    }

    insertions.push({
      offset: toLocalBytePosition(argument.span.start, fileSpanStart),
      text: createMagicComment(inference.exports),
    });
    records.push({
      ...baseRecord,
      status: 'transformed',
      kind: inference.kind,
      exports: inference.exports,
    });
  }

  const output =
    insertions.length > 0
      ? applyInsertions(
          sourceText,
          sourceBuffer,
          insertions,
          resourcePath,
          options.sourceMap,
          MagicString,
        )
      : { code: sourceText, map: undefined };
  return {
    ...output,
    records,
    changed: insertions.length > 0,
  };
}

// ── Rspack loader 与可选事实报告插件 ────────────────────────────────────────

function rspackExportsLoader(source, inputSourceMap, meta) {
  this.cacheable?.(true);
  const callback = this.async?.();

  if (/(?:^|[?&])raw(?:[=&]|$)/.test(this.resourceQuery || '')) {
    if (callback) {
      callback(null, source, inputSourceMap, meta);
      return;
    }
    return source;
  }

  const loaderOptions = this.getOptions?.() || {};
  const dependencies = loadRuntimeDependencies(loaderOptions.dependencyRoot || this.rootContext);
  const result = transformSource(source, this.resourcePath, {
    sourceMap: Boolean(this.sourceMap || inputSourceMap),
    dependencies,
  });
  if (this._module?.buildInfo) {
    this._module.buildInfo[BUILD_INFO_KEY] = {
      version: LOADER_VERSION,
      resource: this.resourcePath,
      records: result.records,
    };
  }

  const fatalRecords = result.records.filter(isFatalRecord);
  if (fatalRecords.length > 0) {
    const error = createSafetyError(this.resourcePath, fatalRecords);
    if (callback) {
      callback(error);
      return;
    }
    throw error;
  }

  if (callback) {
    callback(null, result.code, composeSourceMaps(result.map, inputSourceMap, dependencies.remapping), meta);
    return;
  }
  return result.code;
}

class RspackExportsReportPlugin {
  constructor(options = {}) {
    this.filename = options.filename || 'rspack-exports-report.json';
  }

  apply(compiler) {
    const pluginName = 'RspackExportsReportPlugin';
    compiler.hooks.thisCompilation.tap(pluginName, (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: pluginName,
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
        },
        () => {
          const modules = [];
          for (const module of compilation.modules) {
            const facts = module.buildInfo?.[BUILD_INFO_KEY];
            if (facts?.records?.length) {
              modules.push(facts);
            }
          }
          modules.sort((left, right) => left.resource.localeCompare(right.resource));

          const statusCounts = {};
          for (const module of modules) {
            module.records.sort((left, right) => (left.startByte ?? -1) - (right.startByte ?? -1));
            for (const record of module.records) {
              statusCounts[record.status] = (statusCounts[record.status] || 0) + 1;
            }
          }

          const report = JSON.stringify(
            {
              version: LOADER_VERSION,
              compiler: compiler.name || null,
              statusCounts,
              modules,
            },
            null,
            2,
          );
          compilation.emitAsset(this.filename, new compiler.webpack.sources.RawSource(`${report}\n`));
        },
      );
    });
  }
}

module.exports = rspackExportsLoader;
module.exports.RspackExportsReportPlugin = RspackExportsReportPlugin;
module.exports.DynImportsReportPlugin = RspackExportsReportPlugin;
module.exports.transformSource = transformSource;
