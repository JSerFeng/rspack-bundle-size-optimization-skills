---
name: rspack-bundle-optimization
description: Audit and reduce JavaScript emitted or loaded by Rspack, Rsbuild, or Rspeedy. Use for bundle-size audits, optimization changes, measured reports, tree-shaking, splitChunks, dependency duplication, ECMAScript targets, or browser runtime-loading analysis. Broad requests require evidence for every optimization family; never claim completion unless the audit-state completion gate returns complete.
---

# Rspack Bundle Optimization

找到真正影响用户目标的 JavaScript，应用所有安全且经过生产测量的优化，并诚实区分
“已完成”“部分完成”和“仅有建议”。数据抓取、一次实验或生成报告都不等于完成。

## 先确定工作模式

- `audit-only`：用户要求分析、调查、解释、review 或报告。可以收集证据和做隔离实验，
  但不修改项目源码或受版本控制的配置。
- `optimize`：用户明确要求减少、优化、修复、应用或实现。需要把安全且有效的候选项
  真正应用到项目，再基于最终代码重建和测量。

宽泛的“分析/优化包体积”默认使用 `comprehensive`。只有用户明确限定某个机制、路由、
入口或问题时才能使用 `targeted`；agent 不得为了缩短工作自行缩小范围。

## 不可绕过的完成契约

开始前完整阅读 [references/completion-contract.md](references/completion-contract.md)。

- `manifest.json` 只证明命令与证据文件的身份。
- `audit-state.json` 保存优化覆盖矩阵、每个候选项的终态、构建、测量、实际修改和检查。
- `create-audit-run.cjs verify` 只验证 evidence integrity，不判断任务完成。
- 只有 `audit-state.cjs validate` 输出 `status: "complete"`，最终正文才可以写“已完成”。
- 输出 `incomplete` 时，继续所有仍可执行且在授权范围内的工作；真实 blocker 可以交付，
  但标题必须是“未完成”或“部分完成”，并给出解除方法。

## 工作流

### 1. 定义用户目标和可比范围

读取适用的 `AGENTS.md`，确认真实 production command、包管理器、编译器版本、dirty
state 和可用验证命令。用普通语言写清：

- 用户要减少的是总产物、HTML 初始 JS、某个入口、静态路由组，还是浏览器实际加载；
- 哪些 asset 属于该 scope，哪些明确排除；
- 是否需要请求数、缓存、FCP、TTU 或具体交互证据。

不要用模块数、source size、Stats size 或运行时覆盖率代替最终产物收益。

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

阅读 [references/agent-analysis.md](references/agent-analysis.md)，按用户目标先处理最大项，
但不能只做 Top-N 后停止。对 `audit-state.json` 中每个优化类别：

1. 检查它是否适用于当前构建和目标；
2. 记录源码、配置、compiler、产物或运行时证据；
3. 列出全部 material candidate，而不是只挑容易处理的项；
4. 填写 `discoveredCandidateCount`；没有候选时填写 `noCandidateReason`；
5. 给每个 candidate 一个证据化终态。

以下情况按需读取专门参考：

- dynamic import、magic comment、namespace export：
  [references/dynamic-imports.md](references/dynamic-imports.md)
- ECMAScript target、transform helper、polyfill：
  [references/ecmascript-target.md](references/ecmascript-target.md)
- 页面、路由、交互实际加载或执行：完整阅读
  [references/runtime-coverage.md](references/runtime-coverage.md)

Runtime coverage 只证明指定场景中观察到了什么。`0` 次执行不能直接证明可删除；必须继续
追踪 network initiator、chunk/loading root、完整源码、消费者和产品行为。

### 5. 逐个验证并真正应用

`optimize` 中每个候选项使用独立输出目录，一次实验只改变一个因果变量。只有同时满足
以下条件才能写成 `applied`：

- 完整源码和消费者证明修改符合产品语义；
- production-comparable A/B 在目标 scope 中减少 raw JavaScript；
- gzip、请求数、缓存和命名性能指标分别报告，没有用其中一个冒充另一个；
- emitted diff 与预期机制一致；
- 修改已经进入最终项目文件，不只存在于实验目录；
- production build 和相关 test、runtime、typecheck 或其他正确性检查通过。

安全且测得正向收益的候选必须应用。不能应用时，必须使用 `keep`、`rejected`、
`risk-found` 或 `blocked`，并写具体证据；禁止用“可能有风险”敷衍。

### 6. 基于最终代码重新测量

应用接受的修改后，重新运行最终 production build。不要把独立实验 measurement 当成最终
结果。为同一 scope 生成新的 final measurement 和 comparison，并写入 `audit-state.json`。

保存每个 `applied` candidate 的 patch、修改文件、独立 comparison、final comparison 和
正确性 check id。随后执行：

```bash
node <skill>/scripts/audit-state.cjs snapshot-final --run-dir <run>
node <skill>/scripts/audit-state.cjs validate --run-dir <run>
```

如果 seal 后项目文件变化，必须重新构建、测量、snapshot 和 validate。

### 7. 写给普通用户的报告

完整阅读 [references/report-template.md](references/report-template.md)。正文默认使用用户的
语言；中文用户使用中文。先回答：

1. 到底完成没有；
2. 总 JS、首屏/目标路由分别减少多少；
3. 真正改了什么；
4. 哪些没有落地，为什么；
5. 用户是否还需要做决定。

正文禁止堆砌 `usedExports`、chunk graph、post-loader、module wrapper、manifest、hash 等
内部术语。需要这些证据时放进“技术附录”，正文只解释它支持了哪个决定。

## 测量规则

- raw JavaScript 是主 bundle 指标，gzip 第二；同时给出易读单位、绝对值和百分比。
- total emitted、HTML initial、entrypoint initial、static route group、browser-observed route
  始终分开。
- production A/B 除单一变量外保持 entry、dependency、feature flag、splitChunks、minimize、
  concatenateModules 和 asset inclusion rule 一致。
- source/module size、production-debug、浏览器目标试验和估算归因只能标为诊断或上限。
- 性能结论必须有同条件下对应的 FCP、TTU 或用户指定指标；包体积下降不自动等于性能提升。

## 最终交付边界

- 不因 elapsed time、context compaction、一次成功实验或报告文件已生成而停止。
- 不提交、推送、发布或改变产品兼容策略，除非用户另行要求。
- 不修改与任务无关的 dirty changes。
- `complete` 报告必须附 completion gate 的 run id、状态和关键计数。
- `incomplete` 报告不得使用“优化完成”“全部处理完毕”等措辞。
