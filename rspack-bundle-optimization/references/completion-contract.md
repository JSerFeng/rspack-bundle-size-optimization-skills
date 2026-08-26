# 完成状态契约

本契约防止“抓到了数据”或“尝试了一项优化”被误报为整个任务完成。
`manifest.json` 只记录命令和证据完整性；`audit-state.json` 记录覆盖范围、候选项、
实际修改与完成状态。只有 `scripts/audit-state.cjs validate` 可以判定 `complete`。

## 覆盖策略

- `comprehensive`：用于宽泛的包体积审计或优化请求。所有内置优化类别都必须评估，
  不能使用 `out-of-scope`。
- `targeted`：仅当用户明确限定某个机制、路由或问题时使用。仍保留完整矩阵，未进入
  本次范围的类别写成 `out-of-scope`，并用证据说明用户给出的边界。

创建 run 时会生成以下优化类别：

1. 入口、路由与懒加载边界；
2. import 形态、barrel 和 export usage；
3. side effects 与被保留代码；
4. 重复代码与依赖版本；
5. CommonJS、ESM 和预构建模块边界；
6. chunk、cache group、请求数与缓存；
7. 语法目标、transform helper 与 polyfill；
8. 生产环境 debug、locale、icon 等载荷；
9. 编译器版本与优化配置；
10. 指定页面或交互的运行时加载。

这些是覆盖类别，不是要求机械运行十套昂贵工具。每个类别都必须有证据化结论：

- `completed`：完成了适用性分析，所有发现的候选项都有终态；没有候选时说明为什么。
- `not-applicable`：对当前构建或目标不适用，并给出源码、配置或产物证据。
- `out-of-scope`：仅允许在 `targeted` 中使用，并说明用户限定的范围。
- `blocked`：已经具体尝试但缺少能力或前置条件；整个交付必须标记 `incomplete`。

`pending` 和 `in-progress` 不是终态。

每个终态类别都要填写 `discoveredCandidateCount`，校验器会与实际 candidate 数量核对。
`completed` 且发现数为 `0` 时，还必须填写 `noCandidateReason`，说明检查了什么以及为什么
没有形成候选项；不能只写“无优化”。

## 证据记录

分析笔记、构建日志、measurement、comparison、diff 和测试结果都放在 run 目录内，
再用 `create-audit-run.cjs record` 写入 manifest：

```bash
node <skill>/scripts/create-audit-run.cjs record \
  --run-dir <run> \
  --command "<实际执行的命令>" \
  --exit-code <退出码> \
  --output-dir "<production build 时填写 run 内的独立输出目录>" \
  --artifacts "<run 内相对路径，以逗号分隔>"
```

`audit-state.json` 中的 `evidence` 只能引用这些已经 fingerprint 的 run 内文件。
源码位置和推理写进简短的 note，再记录该 note。不要把聊天记录当作唯一证据。

创建 run 时会记录初始 Git 状态。`audit-only` 或没有任何 `applied` candidate 的 run 如果
改变了项目文件，completion gate 会失败；被忽略的 run 证据目录不会算作产品修改。

## Family 示例

```json
{
  "id": "import-export-shape",
  "label": "Import shape, barrels, and export usage",
  "status": "completed",
  "summary": "检查了前三个最大第三方包的完整 import/export 路径，发现 1 个宽泛导入。",
  "discoveredCandidateCount": 1,
  "noCandidateReason": null,
  "evidence": ["notes/import-export-shape.md"],
  "blocker": null
}
```

当状态为 `blocked` 时，必须填写：

```json
{
  "attemptedCommand": "实际尝试过的命令",
  "error": "原始错误摘要",
  "missingPrerequisite": "缺少什么",
  "nextAction": "解除阻塞后应执行的下一条命令"
}
```

## Candidate 终态

- `proposed-unmeasured`：只允许 `audit-only`；有源码依据，但未获修改授权，未声称收益。
- `validated-opportunity`：只允许 `audit-only`；隔离实验已测得收益，但未修改项目。
- `applied`：只允许 `optimize`；修改仍存在于最终项目，且隔离实验和最终生产构建均证明收益。
- `keep`：源码或产品行为证明必须保留。
- `rejected`：假设被源码推翻，或生产实验没有正向 raw JS 收益。
- `risk-found`：存在具体剩余风险，并写明失败模式和解除条件。
- `blocked`：证据无法取得；整个交付为 `incomplete`。

`discovered`、`investigating`、`experimenting`、`ready-to-apply` 都表示仍有工作。
在 `optimize` 中不能留下 `proposed-unmeasured` 或 `validated-opportunity`：安全且有效就应用，
否则必须给出 `keep`、`rejected`、`risk-found` 或 `blocked` 的真实依据。

`validated-opportunity` 必须包含
`experiment.buildCheckId`、`experiment.comparison` 和 `experiment.checkIds`；校验器会重新读取
measurement，核对 comparison 算术、run id、构建输出目录、时间顺序和正确性检查。

## Applied candidate 示例

```json
{
  "id": "replace-broad-turf-import",
  "familyId": "import-export-shape",
  "title": "把 @turf/turf 宽泛导入改为子路径导入",
  "status": "applied",
  "summary": "最终生产构建仍保留该修改，并减少目标 scope 的 raw JS。",
  "evidence": ["notes/replace-broad-turf-import.md"],
  "change": {
    "changedFiles": ["src/map.ts"],
    "diffEvidence": "experiments/replace-broad-turf-import/change.diff",
    "experimentBuildCheckId": "replace-turf-production-build",
    "isolatedComparison": "experiments/replace-broad-turf-import/comparison.json",
    "finalComparison": "final/app-js-comparison.json",
    "checkIds": ["map-unit-test", "map-runtime-smoke"]
  }
}
```

`applied` 的硬条件：

1. `changedFiles` 在最终项目中存在；
2. `diffEvidence` 是非空 patch，且包含所有 `changedFiles`；
3. 独立实验使用成功的 production build，且 raw JS delta 为负；
4. 最终 production build 重新测量，使用另一个 comparison，raw JS delta 仍为负；
5. 至少一个相关正确性检查通过；
6. `snapshot-final` 后项目文件没有变化。

## Build 和 measurement 绑定

`checks` 中的 production build 必须引用 `manifest.commands` 的序号：

```json
{
  "id": "final-production-build",
  "kind": "production-build",
  "status": "passed",
  "commandIndex": 7,
  "summary": "最终生产构建成功并记录了输出目录。"
}
```

Production build 必须填写 `outputDirectory`，并记录至少一个位于该目录内的输出 artifact；
measurement 的 `outputDirectory` 必须指向这次构建目录。`baseline.measurements` 必须晚于 baseline build；
存在 `applied` 候选时，`final.measurements` 必须晚于 final build，并由
`final.comparisons` 与 baseline 的同一 scope 比较。Baseline 中声明的每个 scope 都必须有
同名 final measurement 和 comparison，不能只汇报表现最好的一项。

## 最终封存与校验

完成最终构建、测量和检查后：

```bash
node <skill>/scripts/audit-state.cjs snapshot-final --run-dir <run>

node <skill>/scripts/audit-state.cjs validate --run-dir <run>
```

`snapshot-final` 记录最终 Git diff、untracked 文件，以及每个 `applied` 候选声明的
修改文件内容哈希。之后任何变化都会使校验失败。

校验结果只有两种：

- `status: "complete"`：允许正文写“已完成”。
- `status: "incomplete"`：正文必须写“未完成”或“部分完成”，逐条转述 `issues`；
  如果仍有安全、授权范围内且可执行的工作，继续做，而不是提前交付。

不要把 `create-audit-run.cjs verify` 的 `evidenceIntegrity: "verified"` 当作完成；
它会明确输出 `auditCompletion: "not-evaluated"`。
