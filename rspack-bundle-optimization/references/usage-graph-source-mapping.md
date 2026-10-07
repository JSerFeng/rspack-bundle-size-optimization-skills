# Usage graph 映射回源码

用于回答“这个导出被谁使用、用在哪里、为什么一路保留到入口”。日常使用
[查询 CLI](usage-query.md)；本页供理解其实现、验证映射及适配 Rspack 版本。
无需启动 Coverage UI，也不要求采集浏览器覆盖率。

例如图中的 `Editor.default -> debounce.default`，引用位置属于 **Editor**。
查询 `debounce.default` 的入边，映射 Editor 中的引用，再查询 `Editor.default` 的入边，
才能逐步得到 `入口 -> App.default -> Editor.default -> debounce.default`。
sourcemap 负责位置转换；导出之间的因果关系来自 usage graph。

## 1. 采集同一构建的数据

先检查项目实际安装的 Rspack API。参考实现使用
`compiler.webpack.experiments.RsdoctorPlugin`，启用
`{ moduleGraphFeatures: ["graph"], chunkGraphFeatures: false, exportUsageGraph: true }`，
在 `thisCompilation` 中订阅
`RsdoctorPlugin.getCompilationHooks(compilation).moduleGraph.tapPromise(...)`。
在 hook 内及时保存所需字段；不同版本不支持该接口时记录 `native graph unavailable`，
不要将普通 module graph 或源码推断冒充原生 export usage graph。

参考版本的 `exportUsageEdges` 每项为：

```text
[originUkey, originExportPath, targetUkey, targetExportPath, dependencyId, loc]
```

- 用同一 payload 的 `modules[].ukey` 解析到 `identifier`、`layer`，边方向是消费方
  `origin -> target`。保留 export path 的数组结构；不要把 `["a.b"]` 与 `["a", "b"]` 合并。
- `null`、`[]` 和具名路径分别保留，按当前版本契约解释；不能统一转成 `default`、
  空字符串或“未使用”。无具名导出归属的边仍然是有效证据。
- 模块身份包含 compiler/build、完整 identifier、layer/type 及必要的实例区分。
  同路径的不同 loader、query、layer 和 concatenation 内部模块不能合并成一个节点。
- 图数据缺失与成功采集到空数组分开记录；坏 tuple、未解析模块记录数量及原因。
  多个 RsdoctorPlugin 回调可能共享 hook，避免后来的空 payload 覆盖已捕获的图。

为消费模块保存 `module.originalSource()` 返回的 Source 的完整文本和
`sourceAndMap({ columns: true })` 结果（也可按当前 Source API 分别读 source/map）。
注意 `originalSource()` 的文本是 **loader 后、进入 Rspack 的代码**。另存 loader map 的
`sources`、`sourceRoot`、`sourcesContent`，以及构建时资源文本；不要事后读取已被修改的文件。
记录内容 hash，确保 graph、文本、map 来自同一 compiler 和成功构建。

需要普通依赖边作为后备时，可参考 `afterOptimizeModules` 采集拼接前 connections；
根据 dependency 的 parent module 找消费方，而不是一律归给拼接容器。最终收集模块时递归
保留内部模块及父子关系。大型项目按模块分批写入文件或数据库，避免在内存中复制整图和源码。

## 2. 统一坐标并确定坐标空间

内部统一为 `line` 从 1 开始、`column` 从 0 开始、范围 `[start, end)`。
参考实现解析 `L:C`、`L:C-C`、`L:C-L:C`，并把 Rspack dependency 的一基列减 1；
已经归一化的数据不得再减。**先用当前版本真实引用片段验证列基准及单位**，不要仅凭字段名猜。
JS 字符串、AST 和通常的 sourcemap 列用 UTF-16 code units；UTF-8 字节偏移必须通过文本转换，
不能直接作为 string slice 的索引。保留 CRLF，不在定位前格式化源码。

检查行列边界、end 是否在 start 之后；跨行 end 的 column 独立验证，不能用 start column
作为其下限。缺失 end 只记录起点，显示时可高亮一个字符，但不能宣称有精确范围。
保留原始 `loc` 和归一化结果，避免显示层的一基列回流到算法。

给每条位置标明 `resource`、`post-loader` 或 `unknown`：

1. 当前 API/构建验证能确认已经指向原始资源，并且对应引用在快照中吻合：直接使用原位置。
2. 确认属于 loader 后文本：使用该 **消费模块** 的 loader map 映射到原始资源。
3. 不能确认：分别保留直接定位和映射候选，结合真实依赖、局部 binding/AST 和片段检查；
   仍有歧义则标为 unavailable，不凭“行号没有越界”选择其中一个。

`rspack-coverage` 的 `traceReferenceLocation` 有一个防重复映射分支：若 trace 结果指向
模块自己的 resource，就保留原 loc。它针对该实现所观察到的 Rspack dependency 坐标行为。
移植时要验证这一前提；同一文件也可能经 loader 大幅改写，路径相同本身不证明无需映射。
例如同路径 loader 在文件开头插入两行，原生 loc 若属于 post-loader 空间，第 2 行的
引用就会移到第 4 行，必须通过 loader map 才能还原。工具因此不使用同路径跳过规则。

## 3. 对 post-loader 位置应用消费方 sourcemap

使用项目中可用的成熟库，例如 `@jridgewell/trace-mapping`：

```js
const trace = new TraceMap(loaderMap);
const start = originalPositionFor(trace, {
  line: location.start.line,
  column: location.start.column,
  bias: GREATEST_LOWER_BOUND,
});
```

`loaderMap` 必须把此次消费模块的 post-loader 文本映射到原始源码。
不要把模块内 loc 直接送进最终 chunk/minifier map。loader 链需要已组合的 map；若只有某一层，
显式补齐并组合其前置 map，否则只报告可到达的中间源码。indexed map 应使用库支持的
flatten/索引接口（如 `AnyMap`）处理，不把它强行当作普通 `mappings` map。

具体投影步骤：

1. start 的 `source/line/column` 全部存在才算有映射；无映射 segment 不能向前任意借用位置。
2. 从 `trace.resolvedSources` 找 source index，取同 index 的 `sourcesContent`，不要总取第一份
   source。保留 resolved source 与原始 source 名；按 sourceRoot/map 基址解析路径。
3. 有 end 时同样 trace。仅在它属于同一 source、位置向前且落在文本内时接受为范围候选。
   两端映射不能证明中间每个字符一一对应；跨 source、不连续或坍缩的范围降为起点/近似范围。
4. 无有效 end 时可借用原范围同一行的宽度（至少 1）做 UI 高亮，并裁剪到源行末；标明
   `endEstimated: true`。多行跨度不平移为原始源码跨度。
5. 在选中的原文上验证起点、范围、片段和对应 binding。稀疏/cheap map 只有行精度时标为
   `line-only`；GLB 返回了一个位置并不自动意味着整段引用精确。

没有 map、映射失败、没有 sourcesContent、来源冲突时保留原边和明确 gap。
只有能验证属于本次构建的资源快照才能补充缺失的 source 内容。可以展示 post-loader 片段，
但要标注坐标空间；不要把 post-loader 行号配上原始文件名。

校验 `sourcesContent` 的内容身份：同时比较构建时资源和 post-loader 文本的 hash。
前置 loader 关闭 source map 后，后续 loader 可能为已经转换的文本重新生成 map，仍使用
原来的 `.ts/.tsx` source 名。若 map 内容等于 post-loader 文本却不同于资源，必须报告
原始资源映射缺口；本工具通过 `sourceIdentity` 暴露这两个比较结果。上游文件、虚拟 source
或中间文本可能与两者都不同，此时保留真实 source 内容和身份，不自行替换为磁盘原文件。

路径归一化只用于查找源码：先去 loader 前缀，再处理资源 query/fragment、斜线、
webpack/rspack/file scheme 和构建 context。完整 module identifier 始终保留。
同名文件或多个匹配候选不能用 basename 或任意第一个结果决胜；需要模块归属、完整路径或
内容 hash 消歧。虚拟模块也可通过 sourcesContent 提供源码，不要求必须存在磁盘文件。

## 4. 从目标导出反向构造完整使用图

先为每条具名 target path 建立前缀索引：`["ns", "fn"]` 同时索引到 `["ns"]` 和
`["ns", "fn"]`。这样查询整个 `ns` 会包含它的成员使用，查询某成员不会错误包含其他成员。
`null`/空路径单独保存；按当前 API 确认的 whole-module/namespace 语义作为保守候选，
不要伪造为精确成员边。只查具名前缀没有结果，不能据此证明未使用。

```text
queue = [(targetModuleInstance, selectedExportPath)]
expanded = set()
resultEdges = map()  // 以原始边身份去重，保留所有不同引用及分支
while queue 非空:
  state = queue.pop()
  if state in expanded: continue
  expanded.add(state)
  for edge in incomingByTargetPrefix(state):
    resultEdges.add(edge)  // 即使 origin 状态已经展开，也先保留这条边
    attachSourceEvidence(edge.origin, edge.loc)
    if edge.originExportPath 是可追溯的具名路径:
      queue.push((edge.originModuleInstance, edge.originExportPath))
    else:
      记录无具名导出归属的消费；必要时单独展开普通模块依赖后备
```

边身份至少包含 origin/target 实例、双方导出路径、dependencyId 和 loc。
同一依赖/位置由多个 origin export 使用时，可以合并展示，但必须保留全部 origin export，
并逐个继续追踪。状态去重阻止循环，不删除菱形汇合边；若展示树，给共享节点回链，不把
全局 visited 的首条路径当成唯一原因。设置节点数/深度上限时报告 `truncated` 和未展开状态，
不可称为完整链。原生关系、source-inferred 后备关系及未知终点分别标明。

## 5. 定位源码中的引用与归属

解析 **最终选定坐标空间中的同一份文本**，使用能处理该文件 JS/TS/JSX 语法的 AST parser。
内置工具返回引用处的 AST 祖先。若需要额外展示导出声明或做源码推断，再建立 export name
到 local binding/declaration 的索引，处理 default、别名、re-export、namespace 与 type-only；
导出声明位置和消费者引用位置是两种不同证据。

用验证后的范围找最小包含节点，再沿祖先链返回函数、类/方法、箭头函数及嵌套回调。
例如输出 `Editor -> useEffect callback -> debounce(...)`，同时保留原生图的
`originExportPath=["default"]`；局部函数可能通过另一个函数被导出使用，不能靠文本包含关系
覆盖编译器 inner-graph 归属。需要源码推断时解析作用域/binding，避免同名变量遮蔽，
并标 `source-inferred`，不能仅搜索导出名后取第一次命中。

源码匹配只能提供候选时降级精度；找不到函数归属可保留 module-level 引用。
AST 解析失败或原文缺失不应丢掉原生 usage edge。每条结果至少输出：

```text
build/compiler、origin/target 模块实例、origin/target export path、dependencyId
rawLoc、normalizedLoc、coordinateSpace、sourcePath、sourceLocation、sourceHash
sourceIdentity(matchesCapturedResource/matchesPostLoader)
snippet、ownerChain、relationPrecision(native/source-inferred/conservative)
locationPrecision(exact/line-only/approximate/unavailable)、endEstimated、gap
```

将引用位置、原始片段和所属函数/类与优化候选一起解释。这里的“使用”是编译器关系，
不是已被浏览器执行；源码高亮的长度也不是产物字节数或可节省体积。

## 6. 验证和适配

用当前 Rspack 生产构建做一个小样例：包含 import alias/default/re-export、多消费分支、
嵌套回调，以及一个改变行列的 loader。对比原生 tuple、post-loader 文本、map 和原始片段，
确认 `consumer -> provider` 方向及坐标规则。分别验证已经是 resource 坐标的边不会重复映射，
post-loader 坐标确实通过消费方 map 回到预期引用。

再覆盖实现相关的失败边界：多 source/虚拟 source、缺 map/缺内容、无 loc、跨行与
CRLF/非 ASCII、循环/菱形、多 layer/拼接模块、空图与不支持 API、遍历截断。
关键断言是片段及模块/导出身份正确、分支不丢、失败保持 unknown，而不是只检查返回了行号。
在真实数据中抽查目标导出的几条不同层级引用，再用于优化判断。

## 参考来源

算法对照 `SyMind/rspack-coverage` 的
[`b64e1f6`](https://github.com/SyMind/rspack-coverage/tree/b64e1f636f737216cbd317bdf98d6bac0f1a8a4f)
（2026-09-28 核对）。以下路径均相对 `packages/rspack-coverage/src/`：

- [`plugin/exportUsageCapture.ts`](https://github.com/SyMind/rspack-coverage/blob/b64e1f636f737216cbd317bdf98d6bac0f1a8a4f/packages/rspack-coverage/src/plugin/exportUsageCapture.ts)：原生 tuple、模块身份与采集。
- [`plugin/snapshot.ts`](https://github.com/SyMind/rspack-coverage/blob/b64e1f636f737216cbd317bdf98d6bac0f1a8a4f/packages/rspack-coverage/src/plugin/snapshot.ts)：`collectOriginalSources`、`parseRspackLocation`、`traceReferenceLocation`、`collectExportUsageEdges`。
- [`server/exportUsageStore.ts`](https://github.com/SyMind/rspack-coverage/blob/b64e1f636f737216cbd317bdf98d6bac0f1a8a4f/packages/rspack-coverage/src/server/exportUsageStore.ts) 与 [`server/InvestigationModel.ts`](https://github.com/SyMind/rspack-coverage/blob/b64e1f636f737216cbd317bdf98d6bac0f1a8a4f/packages/rspack-coverage/src/server/InvestigationModel.ts)：导出前缀索引、反向链和引用源码定位。
- [`server/exportAnalysis.ts`](https://github.com/SyMind/rspack-coverage/blob/b64e1f636f737216cbd317bdf98d6bac0f1a8a4f/packages/rspack-coverage/src/server/exportAnalysis.ts)：导出声明、局部 binding 和源码推断。

这里保留核心算法，并增加坐标空间显式标记、歧义/估算范围降级和完整分支保留要求。
不照搬 UI 的显示限制、路径猜测或配置修改；实际采集按项目版本适配。
