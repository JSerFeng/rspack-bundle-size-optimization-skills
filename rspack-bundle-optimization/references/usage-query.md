# 按需查询 usage graph

用自带工具完成“采集一次，按需查询”。查询结果为 stdout 上的单个 JSON 对象；错误返回
`ok:false` 并以非零状态退出。SQLite 的 Node experimental warning 在 stderr，不影响 JSON。
查询只读本次构建快照，不读取当前磁盘源码，不联网，也不启动 UI。

## 安装与采集

Node.js >=22.13。下面的 `<skill>` 是安装后的 `rspack-bundle-optimization` 绝对路径，
`<snapshot>` 是构建结束打印的 `.sqlite` 绝对路径；实际调用前替换这些占位符。

```sh
npm ci --prefix <skill>/scripts --omit=dev
node <skill>/scripts/usage-query.cjs help
```

把插件接入项目最终 Rspack 配置的 `plugins`（Rsbuild/Rspeedy 通过其 Rspack 配置 hook 接入）：

```js
const { UsageGraphCapturePlugin } = require('<skill>/scripts/usage-capture-plugin.cjs');
// 追加到原有 plugins，不替换项目插件。
config.plugins.push(new UsageGraphCapturePlugin({
  directory: '/absolute/path/to/audit/usage', // 必须在 output.path 以外
}));
```

执行项目原本的 production build。每次 compilation 使用独立数据库，包含 compiler 名、
Rspack 版本、build hash、模块身份、原生 usage 边、构建时源码及 loader map。
成功完成才把 `.incomplete.sqlite` 发布成 `.sqlite`，并在 stderr 打印完整路径。
失败/中断的快照不能被 CLI 当作完整构建查询；watch 重建和 multi-compiler 不覆盖旧快照。

插件启用 Rsdoctor 原生 graph 采集，保持项目的 devtool、tree shaking、minifier 等配置。
loader 没有提供 map 时明确返回缺口；需要 map 的调查按项目方式开启 loader source map，
并记录这一诊断配置。不要为了获得 map 擅自变更生产优化目标。
源码在 `finishModules` 保存，最终补充 concatenation 父子关系；大图边和索引落入 SQLite。
源码、边和最终模块信息分别批量提交，避免大项目在每条模块更新后都同步磁盘。
Rsdoctor 回调本身仍需由 Rspack 生成完整 payload，因此采集仍有额外构建开销。

## 推荐的 agent 查询顺序

以下是单个目标的取证顺序。系统性优化分析必须先按
[分析流程](agent-analysis.md#分析-export-usage) 建立影响面排序和台账，再对清单中的目标
执行并续查所有分支；执行这些命令或抽样查询成功本身不满足分析完成条件。

1. 查 `status`，确认 compiler/build 正确、`graphAvailable:true`、`captureError` 为空，
   检查 `discardedEdges`、`modulesWithoutSource` 和 `modulesWithLoaderMap`。缺图不等于无引用。
   新采集还需检查 `usedExportsRuntimes`、`usedExportsErrors` 和 `usedExportsErrorSamples`：
   采集器把当前 compiler 的 chunk runtime 名称转换成数组后查询 `getUsedExports`。
   这里的 `used` 是该 compiler 所有 runtime 的并集，不是某次页面实际执行的 Coverage。
   旧快照未记录这些字段、或查询报错时，不能把 `used:null` 解读成没有使用；保留未知状态。
2. 用 `modules --search` 找目标，使用返回的 module ID 精确查询，不按 basename 合并模块。
3. 用 `exports` 看分页导出路径与引用数，或用 `references` 看直接引用。
4. 用 `chain` 追到上游导出，保留返回的边结构；共享节点和循环不会丢边。
5. 只有需要阅读引用时才用 `reference --edge`。它加载单个消费模块的文本/map，返回
   原始 loc、映射候选、源码片段、函数/类/回调 ownerChain 和精度；无需把整份源码塞进上下文。
6. 需要更多上下文时用 `source --line` 分窗查询。先前结果中的 sourceHash 可用于核对来源。

系统性审计将上述查询证据填入 [实现保留证据记录](retention-evidence.md)，不能把查询
结果本身当作五环完成。`ownerChain` 只说明引用所在语法结构，不自动追踪变量别名、
函数参数的接收方、对象枚举或 CJS 导出包装；这些位置需继续查询并阅读实际源码。
准备修改的目标都要交叉核对模块图；遇到匿名终点或缺失 native 边时继续补查消费者
契约，保留 native 与源码推断的区别。
产物存在/消失需另读构建 JS 与对应 map；CLI 的引用源码映射不等于产物删除证明。

```sh
node <skill>/scripts/usage-query.cjs status --db <snapshot>
node <skill>/scripts/usage-query.cjs modules --db <snapshot> --search lodash-es/_getRawTag --limit 10
node <skill>/scripts/usage-query.cjs module --db <snapshot> --module mod_...
node <skill>/scripts/usage-query.cjs exports --db <snapshot> --module mod_... --limit 20
node <skill>/scripts/usage-query.cjs references --db <snapshot> --module mod_... --export default --limit 20
node <skill>/scripts/usage-query.cjs chain --db <snapshot> --module mod_... --export default --depth 5 --limit 100
node <skill>/scripts/usage-query.cjs reference --db <snapshot> --edge edge_... --context 3
node <skill>/scripts/usage-query.cjs source --db <snapshot> --module mod_... --line 40 --context 5
```

`--export 'a.b'` 是名字包含点的单个导出；嵌套成员用 `--export-path '["a","b"]'`。
`references --direction out` 查看该模块的全部出边；导出过滤只用于入边。
`exports` 合并编译器 provided exports 与原生 target path/prefix，`incomingReferences:0`
只表示没有捕获到该具名路径的入边，不代表可以删除。模块元数据中的 `used` 可能为 null，
不能将未知状态解释成 false。

列表默认 20 项、最多 200 项，返回 `total/offset/limit/nextOffset`；继续查询时传
`--offset <nextOffset>`。`module` 元数据中 provided/used 最多各显示 20 名，完整导出列表
通过 `exports` 分页。`chain` 默认最多 100 条边、最多 500 条，深度默认 5、最多 20。
`truncated:true` 时对 `frontier` 的 module/exportPath 继续查询；宽节点可按
`nextReferenceOffset` 用 `references` 分页。frontier 表示尚未完成的调查，不是无引用终点。

源码默认前后各 3 行，`--context` 最多 10；每行最多显示 500 字符并标 truncated。
`reference` 另返回引用附近的 `focus` 窗口，便于检查 minified 长行。
`source` 可加 `--space post-loader` 查看编译器实际输入，或用 `--source <resolved-source>`
读取 map 内的一份源码；可选路径在 `mapSources` 中分页列出。

## 坐标空间与精度

默认 `auto`。原文与 loader 后文本一致、候选 source 身份也一致时直接保留原列坐标，
不会因为附带的行级 identity map 把它误报成歧义；转换后存在坐标歧义时返回
`candidates`、`mappingGaps`、`locationPrecision:unavailable`，保留 native edge。
先结合候选片段和当前编译器验证坐标，再用 `reference --space resource` 或
`reference --space post-loader` 明确选择；这是 agent 的分析步骤，不需要用户逐条审批。

确认整个采集采用同一坐标契约后，可在插件中设置 `locationSpace` 和 `columnBase`。
默认列基准为 1，CLI 的 `--column-base 0|1` 可用于验证。内部坐标保持 line 1-based、
column 0-based、UTF-16；该坐标契约需在当前 Rspack 版本及实际 loader 链中核对。
工具不自动猜测字节列偏移；若当前 API 返回 UTF-8 字节坐标，需要先增加对应适配。

通过 map 得到的范围保守标为 `approximate`：两个映射端点不证明中间每个字符精确对应。
无有效 end 时只返回起点并设置 `endEstimated`；AST 归属解析失败时保留引用和 `astGap`。
`sourceIdentity.matchesCapturedResource` 表示所展示文本与构建时保存的资源内容一致；
`matchesPostLoader` 表示它与 loader 后文本一致。map 的 source 名仍为 `.ts/.tsx` 并不证明
内容就是原 TS/TSX。若 map 实际指向转换后的同一份文本，工具返回明确 gap，不能把该行号
链接到原文件。其他上游或虚拟 source 可能与两者都不同，需要检查来源，不能仅按 hash 不同
判定 map 错误。

业务实测中遇到前置转换 loader 显式设置 `sourceMaps:false`，后续 loader 重新生成 map：
这种 map 只能到达中间代码。先记录原配置的缺口，再单独启用该 loader 的 source map 做
诊断构建，保留其他优化配置；不要用文本搜索或 AST 猜测替代缺失的 map。
还应检查后续 loader 是否传递 map：只返回文本的 loader 即使没有改动代码，也会截断映射。
诊断适配可以在输出文本与输入完全一致时原样传递输入 map（JSON 字符串需转为对象以适配
后续 loader）。输出发生变化时必须生成并组合新 map，不能套用旧 map；也不要跳过业务或
安全插桩来伪造完整映射。记录这些适配与原构建的差异，并单独比较实际产物。
`relationPrecision:native` 与位置精度彼此独立。`null`/空 target path 作为 conservative
候选返回；不将它们强制解释为某个具名导出。

工具只返回编译器关系及语法归属，没有用 AST 猜测缺失的跨模块因果边，也不把一次源码命中
视为浏览器已执行或可删除证据。算法及来源见 [usage-graph-source-mapping.md](usage-graph-source-mapping.md)。

## 在项目构建中核对

```sh
node <skill>/scripts/usage-query.cjs status --db <snapshot>
node <skill>/scripts/usage-query.cjs reference --db <snapshot> --edge <edge-id> --context 3
```

使用项目成功构建产生的快照，先核对 graphAvailable、采集错误与 runtime，再抽查实际
引用的模块/导出身份、分支及源码片段。核对 loader 位移、map 缺口和坐标空间；有映射
位置不自动代表已回到原始资源。采集 API 不支持或来源不明确时保留缺口，不推断兼容。
比较接入采集前后的实际产物，确认采集没有改变业务输出；候选优化仍按生产 A/B 验证。
