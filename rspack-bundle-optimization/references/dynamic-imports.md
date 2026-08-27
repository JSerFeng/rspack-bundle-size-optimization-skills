# 动态导入分析

## Rspack 可识别的导出用法

当以下使用关系在 Rspack 解析时仍然可见，Rspack 可以只保留动态导入实际读取的导出：

```js
const ns = await import("@pkg");
use(ns.foo);

import("@pkg").then((ns) => use(ns.foo));

const [ns1, { bar }] = await Promise.all([
  import("@pkg1"),
  import("@pkg2"),
]);
use(ns1.foo, bar);
```

## 为什么有些导入会一起加载

在磁盘源码和 loader 处理后源码中搜索 `webpackChunkName`、`rspackChunkName`，以及
splitChunks cache group 的 `name` 配置。多个动态导入的实际名称相同时，可能先合并为同一个
chunk group；后续 chunk 优化还可能把该组拆成多个输出文件。必须结合执行构建的编译器配置、
抓取到的 chunk group 和最终产物判断真实边界，不能只看源码中的注释字面值。

## 为什么语法降级后优化会失效

如果 Babel、SWC 或其他 loader 在 Rspack 解析前，把 `await import()` 的消费关系降级为
generator 或运行时状态机，Rspack 可能只能看到命名空间对象被传递，无法再还原具体读取了哪些
导出。此时可以使用
[`scripts/dyn-imports-loader.js`](../scripts/dyn-imports-loader.js)，在转换前分析原始语法，并把
已经证明完整的导出集合通过 `rspackExports` 魔法注释传给 Rspack：

```js
const { foo, bar: localBar } = await import(
  /* rspackExports: ["foo", "bar"] */
  "@pkg"
);
```

## 接入 loader

loader 支持直接 `await import()`、箭头函数形式的 `.then()`，以及具名数组槽位中的
`await Promise.all([import(), ...])`。它只改写静态请求和可完整证明的使用关系；动态请求、
命名空间逃逸、计算属性、写操作、object rest 等场景保持原样，并在报告中记录为 `bailout`。
`Promise.all` 推断还要求使用未被局部变量遮蔽的全局 `Promise`、输入数组没有 spread，并且
await 结果直接绑定到数组 pattern；否则保守退出。

脚本依赖 `@swc/core`、`magic-string` 和 `@ampproject/remapping`。三个包必须能从同一个
项目依赖边界解析。通过 loader 选项 `dependencyRoot` 指向提供这些依赖的项目目录；也可以
设置 `RSPACK_DYN_IMPORTS_LOADER_DEPENDENCY_ROOT`。

在最终 Rspack 配置钩子中，将 loader 限制在已审查的一方源码，并设为 pre-loader：

```js
const path = require("node:path");

const loaderPath = path.resolve(
  "<skill>/scripts/dyn-imports-loader.js"
);
const { DynImportsReportPlugin } = require(loaderPath);

config.module.rules.unshift({
  test: /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/,
  include: [path.resolve(__dirname, "src")],
  exclude: /[\\/]node_modules[\\/]/,
  enforce: "pre",
  use: [
    {
      loader: loaderPath,
      options: {
        dependencyRoot: path.resolve("<project-dependency-root>"),
      },
    },
  ],
});

if (process.env.RSPACK_DYN_IMPORTS_REPORT === "1") {
  config.plugins.push(
    new DynImportsReportPlugin({ filename: "dyn-imports-report.json" })
  );
}
```

不要未经完整源码、副作用和使用方审查就把规则扩大到 `node_modules`。带 `?raw` 的资源会
原样透传。

## 安全边界

以下情况会直接终止模块构建，避免生成表面成功但运行时缺失导出的产物：

- SWC 无法解析包含动态导入的源码；
- 现有 `rspackExports` 或 `webpackExports` 无法解析、无法验证，或漏掉推断出的导出；
- `eval` 可能观察命名空间；
- 普通 `function` 形式的 `.then()` 回调可通过 `arguments` 访问完整模块对象。

其他 `bailout` 只表示当前 import 无法安全生成导出投影，不等于错误、未使用或可删除。现有
手写注释如果是推断集合的安全超集，会被验证并保留，不会由 loader 重写。生成注释时会编码
导出名中的原始 `*/`，避免意外提前结束块注释。

## 验证

确认动态 `import()` 及其注释经过后续 loader 后仍对实际执行的 Rspack 可见，并检查重新抓取
的 export usage 与输出产物。使用同一生产命令分别运行未启用和已启用该 loader 的构建，保持
入口、依赖、压缩、模块拼接和 splitChunks 不变；分别比较总量、初始加载和相关异步范围。只有
目标范围内的 JavaScript 原始字节数确实下降，并且相关测试或运行时检查通过时，才保留优化。
