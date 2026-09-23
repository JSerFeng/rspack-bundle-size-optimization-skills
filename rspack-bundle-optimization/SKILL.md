---
name: rspack-bundle-optimization
description: Optimize JavaScript emitted or loaded by Rspack, Rsbuild, or Rspeedy. Use for bundle-size audits, optimization changes, measured reports, tree-shaking, splitChunks, ECMAScript targets, or browser runtime-loading analysis.
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
[references/data-capture.md](references/data-capture.md)。每个顶层 compiler 使用独立目录，
不要混合 web、node、worker 或不同 run 的数据。

记录成功构建对应的项目状态，使后续比较能够追溯到同一基线。

### 3. 分析并验证优化候选

阅读 [references/agent-analysis.md](references/agent-analysis.md)，逐项检查优化类别；
不适用或无法完成的项目说明原因。结合源码、编译器数据和产物解释每个候选。

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
