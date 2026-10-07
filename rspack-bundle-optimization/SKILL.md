---
name: rspack-bundle-optimization
description: Optimize JavaScript emitted or loaded by Rspack, Rsbuild, or Rspeedy. Use for bundle-size audits, optimization changes, measured reports, tree-shaking, export usage graphs and source mapping, splitChunks, ECMAScript targets, or browser runtime-loading analysis.
---

# Rspack Bundle Optimization

找到真正影响用户目标的 JavaScript，应用所有安全且经过生产测量的优化，并诚实区分
“已完成”“部分完成”和“仅有建议”。数据抓取、一次实验或生成报告都不等于完成。

## 工作流

### 1. 定义用户目标和可比范围

读取适用的 `AGENTS.md`，确认真实 production command、包管理器、编译器版本、dirty
state 和可用验证命令。明确用户要仅分析还是实际修改，以及关心总 JS、首屏还是目标路由。

### 2. 建立未修改的生产基线

先运行未修改的 production build，再保存构建产物、命令和测量结果。阅读
[references/measurement.md](references/measurement.md)，分别记录用户关心的资源统计范围。

需要 compiler graph、chunk、export usage 或 post-loader source 时，阅读
[references/data-capture.md](references/data-capture.md)。每个顶层 compiler 使用独立快照（目录或数据库），
不要混合 web、node、worker 或不同 run 的数据。

需要从某个导出追溯使用链、定位调用处或解释源码为何被保留时，阅读
[references/usage-query.md](references/usage-query.md)，使用自带采集插件保存快照，再用
`scripts/usage-query.cjs` 按需查询模块、导出、引用链和单条引用的源码归属。
先查 metadata 和分页索引，需要源码时再查单条引用，避免把整图灌入上下文。
排查映射精度或适配其他 API 版本时再阅读
[references/usage-graph-source-mapping.md](references/usage-graph-source-mapping.md)。

记录成功构建对应的项目状态，使后续比较能够追溯到同一基线。

### 3. 分析并验证优化候选

阅读 [references/agent-analysis.md](references/agent-analysis.md)，逐项检查优化类别；
不适用或无法完成的项目说明原因。结合源码、编译器数据和产物解释每个候选。

包体积审计或 export usage 优化分析必须完成该文档中的系统性引用分析：先建立影响面
排序和分析台账，再逐项追完高影响模块的引用分支、阅读源码并形成候选结论。
每个高影响目标按 [实现保留证据规范](references/retention-evidence.md) 拆成具体实现记录，
串起“具体实现 → 保留引用与操作 → 等价修改 → 产物证据 → 行为验证”。
一个候选验证成功不能代替整个目标完成；扫描数、导出数下降和状态字段不能代替这五环证据。
抽样查询、映射成功、CLI 测试通过只能证明工具有效，不能代替优化分析；用户仅要求
工具测试或某条引用定位时，按其指定范围执行，不扩展为全项目审计。

需要实验时，一次只改变一个目标变量，执行生产构建并比较同一统计范围。实际修改任务中，
应用安全且经实测有效的优化；仅分析任务中，保留结论与验证证据，不留下实验修改。

### 4. 基于最终代码重新测量

应用接受的修改后，重新运行最终 production build。不要把独立实验 measurement 当成最终
结果。按相同统计口径重新测量并与基线比较，执行与修改相关的正确性检查。

记录修改文件、每项独立收益、最终合并收益和验证结果。最终测量使用正常生产配置，
清理临时接入的采集插件或实验开关；需要长期保留的优化代码按项目代码维护。

### 5. 写给普通用户的报告

完整阅读 [references/report-template.md](references/report-template.md)。正文默认使用用户的
语言：

1. 总 JS、首屏/目标路由分别减少多少；
2. 真正改了什么；
3. 哪些没有落地，为什么；
4. 用户是否还需要做决定。

正文禁止堆砌互联网行业黑话等内部术语，通俗易懂但又详细的语言解释给普通用户。

### 6. 最终交付边界

确认请求范围内的优化项均已检查，交付结果有对应的生产测量和验证证据。存在未完成项时
明确说明原因，不把实验结果或建议写成已落地收益。
系统性 export usage 分析还须核对影响面清单与台账：高影响项均有结论，待续查分支
已处理，未决项明确列出。仍有未分析项、截断分支或关键证据缺口时，只能报告部分完成。
交付前核对实现记录、目标状态和报告是否一致，按证据规范分别统计结构检查、目标分析
完成与候选验证完成；不得用一个合计数字掩盖未完成项。
