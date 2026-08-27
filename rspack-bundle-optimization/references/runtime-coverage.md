# 运行时加载与执行覆盖率

当问题涉及页面、路由或交互请求或执行了哪些 JavaScript 时，使用运行时覆盖率。证据契约
包括：具名场景、准确的生成源码、所有相关运行时目标（target）、彼此独立的重复采集，以及用于确认
加载结果的生产对比。

Rspack 通常把模块放入生成的包装函数中，工具输出将其称为模块工厂。经过拼接的内部模块
可能共用一个包装函数。V8 区间计数只描述在其采集场景中观察到的执行情况。

## 各类构建的用途

- `production-debug`：映射 chunk、生成的模块包装函数和源码级执行情况；其中生成代码的
  大小只用于诊断。
- `production`：确认实际请求的资源、字节数和具名性能指标。
- `development`：调试应用或验证工具支持情况。

除 `SKILL.md` 中定义的调试设置外，`production` 和 `production-debug` 的入口、编译目标、
功能开关、splitChunks、依赖、运行时和插件必须保持一致。编译目标是配置中的 JavaScript
或浏览器目标；运行时目标（target）是实际观察到的页面、iframe、worker 或 service worker。

## 通过 Chrome 采集

根据当前可用的 Chrome DevTools 工具能力，选择能够取得以下数据的工具：

- 函数级精确 JavaScript 覆盖率；
- 准确的脚本源码；
- 已加载资源和网络请求发起方；
- page、iframe、dedicated worker、shared worker 和 service worker target。

记录实际使用的命令。默认页面采集使用 `callCount: true`、`detailed: false` 的精确覆盖率；
块级覆盖率只用于聚焦的后续调查。

如果无法取得其中某项数据，记录缺失的能力或错误，并使用能取得最强证据的后备方案：

1. 通过原始 CDP 调用 `Profiler.startPreciseCoverage`、
   `Profiler.takePreciseCoverage` 和 `Debugger.getScriptSource`；
2. 使用 Puppeteer 风格的函数覆盖率和准确源码；
3. 只使用区间级或脚本级数据，并把结论限制在同一粒度。

分析生成的包装函数执行情况时，函数区间和准确源码必须来自同一次构建。脚本级证据只能支撑
脚本级结论。

### DevTools Coverage 面板

内置的 Coverage 面板是只有区间数据时的后备方案。选择 `Per function`，排除内容脚本，并在
导航前开始采集。清空面板前，保存原始 JSON 及其中的 `text`。

将观察到的源码区间按 UTF-16 代码单元偏移量报告。单独校验过的包装函数边界映射应标为
`ui-range-inference`，并记录资源 URL、包装函数区间、可用时的模块 ID、观察到的区间、
源码哈希和简短片段。该输出必须与精确覆盖率标准化工具的输出分开保存。由于该面板无法提供
worker 启动和 target 证据，worker 场景必须使用支持附加 target 的采集方式。

## 定义并重复场景

为每个场景命名，例如：

- `first-screen-cold`：冷缓存加载，直到达到具名就绪条件；
- `first-screen-warm`：使用预期的热缓存达到相同条件；
- `critical-interaction`：必须加载延后代码的操作。

记录运行 ID、场景 ID、构建模式、重复序号、URL、浏览器版本、视口、用户状态、功能开关、
locale、缓存和 service worker 设置、覆盖率开始时间、导航开始时间、就绪条件、固定等待
时间、采集结束时间、交互步骤、预期和实际观察到的 target、浏览器错误、失败请求以及已加载
的 JavaScript。

在导航前开始覆盖率采集。优先使用应用就绪标记，随后追加固定等待。每次
`takePreciseCoverage` 都会重置累计计数，因此应保存每一份结果。

形成最终运行时结论前，对结论依赖的每种构建模式和状态分别采集三次。`audit-only` 模式只
重复未修改状态；`optimize` 模式同时重复未修改和修改后的状态，包括受影响的关键交互。
不同轮次必须分开保存，并展示不稳定性。

## 提供类生产环境构建

通过项目的生产服务、预览服务或静态服务方式，提供一次全新的 `production-debug` 构建。记录
构建命令和服务命令、环境、URL、就绪条件、服务输出、控制台错误、失败请求和重要 API
响应。确认服务实际返回的 JavaScript 与被测构建一致。

采集前，验证资源路径、API 状态、内容类型和数据结构、SPA fallback、身份验证或会话依赖、
代理行为和 service worker 状态。保持预期路由、账号状态、缓存、功能开关、生产设置和产品
行为不变。如果修复改变了这些输入，就形成了不同的场景；在用户决定前，该场景不能用于支撑
原请求的结论。

如果源码或哈希不匹配，或者 V8 偏移量不匹配，应停止增量服务，创建全新构建后重新采集。
预期场景仍无法运行时，把命令、错误、尝试过的修复、受影响的范围和所需项目输入保留下来，
并将其记为未完成的运行时结果。

## 纳入所有相关运行时目标

采集参与场景的每个 page、iframe 和 worker。使用原始 CDP 采集 worker 覆盖率时：

1. 开启 target 发现和扁平化自动附加；
2. 在每个 target 继续启动前启用 Debugger 和 Profiler 覆盖率；
3. 为每个脚本记录 target ID 和类型；
4. 对比预期 target 与实际抓取到的 target。

如果 worker 在附加前已经开始运行，应把这段启动窗口记录为覆盖率缺口。

## 保存并标准化原始数据

保留 Chrome 的原始响应。标准化工具支持以下输入：CDP 精确覆盖率结果、脚本结果数组，或
`targets[].{targetId,targetType,result}`；还可附带已加载脚本、会话、准确源码和编译器
数据。

推荐的源码清单：

```json
{
  "scripts": [
    {
      "targetId": "page-target-id",
      "scriptId": "123",
      "url": "https://example.test/static/js/page.js",
      "source": "Debugger.getScriptSource 返回的准确源码",
      "sha256": "..."
    }
  ]
}
```

可以用相对于清单的 `sourcePath` 代替内联 `source`。优先使用
`Debugger.getScriptSource`。只有 HTTP 响应的长度和哈希与 V8 观察到的脚本一致时，才可
使用 HTTP 获取的源码。

执行标准化：

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

如果无法从 Debugger 获取源码，而 URL 仍提供完全相同的构建，则使用
`--fetch-sources`。

标准化工具会生成：

- `runtime-coverage-session.json`；
- `runtime-coverage-scripts.jsonl`；
- `runtime-coverage-modules.jsonl`；
- `runtime-coverage-summary.json`；
- `runtime-coverage-failures.jsonl`；
- `runtime-coverage-manifest.json`。

## 生成代码包装函数映射

对于 production-debug 或 development 风格的 Rspack chunk，标准化工具会找到脚本的顶层
V8 函数，建立函数包含关系，检查其直接子函数是否符合 Rspack 对象方法语法及编码后的名称，
并记录包装函数执行次数和生成字节数。这样可确保嵌套回调仍归属其包装函数。重复的模块 ID
保持为独立记录。

拼接后的根模块标为 `coarse-concatenated-factory`；覆盖率适用于共享包装函数，而不是单个
内部模块。没有包装函数的仅运行时脚本仍是有效的脚本记录。

## 校验采集结果

```bash
node <skill>/scripts/verify-runtime-coverage-artifacts.cjs \
  --dir <run>/runtime/<scenario>/<repetition> \
  --require-start-before-navigation \
  --require-target-types page,worker
```

根据应用实际情况设置 target 类型。校验器会检查数据结构、已加载脚本与覆盖率的一致性、
源码身份、包装函数识别、采集时序、预期 target 和产物哈希。保留所有警告和失败。应重新
执行一次全新采集，或进行聚焦的映射修正；仍未解决的失败会使受影响范围保持未完成。

## 分析并验证修改

保留每一次有效的重复采集。只有资源或请求出现在所有有效轮次中，才能称为稳定；其他结果
应标为不稳定。通过标准化 URL 或输出路径、编译器和内容哈希识别资源。使用入口和 chunk
关系匹配经过内容哈希重命名的资源。

分别报告稳定的生产请求及其精确原始字节数或 gzip 字节数、发生变化的资源、不稳定资源、
作为场景辅助证据的包装函数执行情况，以及共享 chunk group 资源。把每个重要项关联到网络
请求发起方、Rspack 加载根节点、完整源码和使用方、产品需求以及聚焦的加载边界修改。

修改后，重新构建 production，比较完全相同的统计范围，重复相同场景并执行关键交互。验证
延后加载时，使用全新的交互采集，并检查按需资源加载、包装函数执行、可见结果完成、网络
行为和控制台状态。修改 worker 时，重放创建过程、就绪或第一条消息、错误或 fallback 行为、
受影响的使用方以及正常终止过程。

生产请求或字节差异可以确认加载变化。速度结论必须使用具名性能指标，并保持缓存、页面、
用户状态和交互条件一致。
