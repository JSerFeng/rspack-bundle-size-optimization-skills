---
name: rspack-bundle-optimization
description: Optimization JavaScript emitted or loaded by Rspack, Rsbuild, or Rspeedy. Use for bundle-size audits, optimization changes, measured reports, tree-shaking, splitChunks, dependency duplication, ECMAScript targets, or browser runtime-loading analysis. Broad requests require evidence for every optimization family; never claim completion unless the audit-state completion gate returns complete.
---

# Rspack Bundle Optimization

找到真正影响用户目标的 JavaScript，应用所有安全且经过生产测量的优化，并诚实区分
“已完成”“部分完成”和“仅有建议”。数据抓取、一次实验或生成报告都不等于完成。

## 工作流

### 1. 定义用户目标和可比范围

读取适用的 `AGENTS.md`，确认真实 production command、包管理器、编译器版本、dirty
state 和可用验证命令。

### 2. 创建独立 run

```bash
node <skill>/scripts/create-audit-run.cjs \
  --project-root <project-root> \
  --root <ignored-project-local-root> \
  --mode <audit-only|optimize> \
  --coverage <comprehensive|targeted> \
  --goal "<普通用户能理解的目标>" \
  --build-command "<production command>" \
  --asset-scope "<明确的 asset scope>"
```

命令会同时创建 `audit-state.json`。它是本次任务的持久状态，不得用聊天上下文或临时
task plan 代替。

### 3. 建立 unchanged production baseline

先运行未修改的 production build，再记录构建产物、命令和 measurement。阅读
[references/measurement.md](references/measurement.md)，分别保存用户关心的 scope。

需要 compiler graph、chunk、export usage 或 post-loader source 时，阅读
[references/data-capture.md](references/data-capture.md)。每个顶层 compiler 使用独立目录，
不要混合 web、node、worker 或不同 run 的数据。

把 baseline production build 和 measurement 写入 `audit-state.json`。没有成功 baseline
build 与至少一个 production measurement，完成校验必然失败。

### 4. 完成优化覆盖矩阵

阅读 [references/agent-analysis.md](references/agent-analysis.md)，处理每个优化类别：

以下情况按需读取专门参考：

- dynamic import、magic comment、namespace export：
  [references/dynamic-imports.md](references/dynamic-imports.md)
- ECMAScript target、transform helper、polyfill：
  [references/ecmascript-target.md](references/ecmascript-target.md)
- 页面、路由、交互实际加载或执行：完整阅读
  [references/runtime-coverage.md](references/runtime-coverage.md)

### 5. 逐个验证并真正应用

`optimize` 中每个候选项使用独立输出目录，同时满足以下条件才能写成 `applied`：

- 完整源码和消费者证明修改符合产品语义；
- production-comparable A/B 在目标 scope 中减少 raw JavaScript；
- gzip、请求数、缓存和命名性能指标分别报告，没有用其中一个冒充另一个；
- emitted diff 与预期机制一致；
- production build 和相关 test、runtime、typecheck 或其他正确性检查通过。

安全且测得正向收益的候选必须应用。不能应用时，必须使用 `keep`、`rejected`、
`risk-found` 或 `blocked`，并写具体证据。

### 6. 基于最终代码重新测量

应用接受的修改后，重新运行最终 production build。不要把独立实验 measurement 当成最终
结果。为同一 scope 生成新的 final measurement 和 comparison，并写入 `audit-state.json`。

保存每个 `applied` candidate 的 patch、修改文件、独立 comparison、final comparison 和
正确性 check id。随后执行：

```bash
node <skill>/scripts/audit-state.cjs snapshot-final --run-dir <run>
node <skill>/scripts/audit-state.cjs validate --run-dir <run>
```

### 7. 写给普通用户的报告

完整阅读 [references/report-template.md](references/report-template.md)。正文默认使用用户的
语言；中文用户使用中文：

1. 总 JS、首屏/目标路由分别减少多少；
2. 真正改了什么；
3. 哪些没有落地，为什么；
4. 用户是否还需要做决定。

正文禁止堆砌互联网行业黑话等内部术语，通俗易懂但又详细的语言解释给普通用户。

## 最终交付边界

确认完成 skills 中的所有优化项。
