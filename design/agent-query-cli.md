# Skill 本地查询 CLI 设计

状态：第一版已在 `rspack-bundle-optimization/scripts/` 实现。实际调用见
[query-cli.md](../rspack-bundle-optimization/references/query-cli.md)。当前支持 build/loaded
及 source-line coverage；initial 独立字节和精确 generated ranges 缺少底层数据，明确报不可用。
0.2 版进一步自包含：内置 capture-plugin、Chrome CDP recorder 和 analyze，直接读取
本次构建快照及原始 coverage；采集、映射和查询均由 scripts 完成。

## 目标与职责

在 Skill 的 `scripts/` 内提供一个本地入口，让 Agent 按“排序发现目标 → 按 module ID
读取详情 → 追查引用和源码”的方式消费 coverage 映射与 export usage graph。
查询不依赖 UI、HTTP 服务或模型 API，也不执行生产构建或修改业务文件。

CLI 负责可重复的数据处理：索引、关联、筛选、排序、分页、图遍历和有界源码窗口。
输出是构建事实和录制证据，业务必要性、修改选择和优化结论由 Agent 分析。

## 文件组织与依赖

```text
rspack-bundle-optimization/
  SKILL.md
  scripts/
    capture-plugin.cjs
    record.cjs
    query.cjs
    lib/
      capture-store.cjs
      cdp.cjs
      coverage.cjs
      analyze.cjs
      index.cjs
      queries.cjs
      source.cjs
      adapters/
        coverage.cjs
        usage.cjs
    package.json
    package-lock.json
  references/
    query-cli.md
```

`SKILL.md` 链接使用说明。CLI 与依赖独立于被分析项目；使用 Node >=22.13 的
`node:sqlite`，避免为了查询引入数据库原生扩展。先复用输入已有的正确映射；需要 AST
归属和 map 查询时再加载固定版本的 Babel parser、trace-mapping。依赖通过 scripts 下的
lockfile 安装，不依赖开发者机器的全局包或绝对仓库路径。

## 输入与一次性索引

接入已有两类证据，允许单独使用：

1. coverage adapter：读取内置 analyze 输出的自包含 coverage SQLite，内含构建、录制、
   sourcemap、源码行指标及模块关系。映射逻辑不依赖外部分析器。
2. usage adapter：读取独立的 usage SQLite 快照及构建时源码/map，供没有浏览器录制的
   纯编译期分析使用。索引时检查 schema、complete 状态及 graphAvailable。

两者同时提供时，核对 compiler/build 身份和完整 module identifier/layer。ID 不同通过
映射表关联，禁止按 basename 合并。无法确认同一构建时返回 `INPUT_IDENTITY_MISMATCH`，
不强行拼接两次构建的数据。多个候选实例无法唯一对应时保留归因缺口。

```sh
# <skill>、<coverage-data> 等需替换为真实路径。
node <skill>/scripts/query.cjs analyze --build <build.sqlite> --coverage <recording.json> --out <coverage-data.sqlite>
node <skill>/scripts/query.cjs index --coverage <coverage-data> --out <index.sqlite>
node <skill>/scripts/query.cjs index --usage <usage.sqlite> --out <index.sqlite>
node <skill>/scripts/query.cjs index --coverage <coverage-data> --usage <usage.sqlite> --out <index.sqlite>
```

索引阶段把可排序的模块指标、源码关联、边和图统计写入派生 SQLite；脚本、map 和源码
侧文件继续按 ID 读取。目前接入两类 SQLite 快照，不直接接收任意 Rsdoctor JSON；额外
输入应先适配为兼容快照，不能在每次查询时反复解析整图。
派生库记录输入的绝对路径和不可变身份，使用期间须保留原始快照；输入被删除或替换时报错。

索引完成后再发布正式文件，失败/中断的 `.incomplete` 文件不能查询；默认不覆盖既有索引。
数据库初始化统计只扫描一次，常用排序和过滤建立组合索引。所有后续查询只读打开数据库。
CLI 可以减少后续 IO、内存和上下文开销；编译器生成原生整图回调的开销不由该索引消除。

## 统一身份与数据层次

所有响应带 `datasetId`、`buildId`、compiler 身份；运行证据带 `coverageRunId` 和 scenario。
第一版一个数据集绑定一个构建及至多一份录制；不同场景分别建索引。`--run` 用于核对
录制身份，也为后续同构建多录制查询保留接口，不隐式合并场景。
只导入 usage graph 时 coverage 能力不可用，但静态导出查询仍可执行。

- `moduleId`：数据集内的模块实例，保留完整 identifier、layer 和源工具 ID。
- `sourceId`：捕获文本身份，包含 hash 和坐标空间，区分 resource、post-loader、map source。
- `edgeId`：单条编译器/模块关系，保留 dependency ID 与原始位置。
- `exportPath`：字符串数组；名称自身含点与嵌套成员路径分别表示。

数据分三层：列表只含 ID、短路径、统计和少量标志；module 详情提供 coverage 摘要、导出
计数和进一步查询入口；源码、coverage 细节及引用分支按需单独请求。所有实体通过 ID 关联，
避免每条边重复嵌入完整模块、源码和邻居图。

## 命令接口

每条查询使用 `--db <index.sqlite>`。以下列表查询统一支持 `--limit`、`--cursor`。

| 命令 | 主要参数 | 默认内容 |
| --- | --- | --- |
| `describe` | 可选 `--command` | 命令、参数类型、必填项、默认值、可排序字段、字段语义和错误码 |
| `status` | 无 | 构建/录制身份、输入来源、capabilities、数据量、缺口摘要 |
| `modules` | `--search`、`--package`、`--run`、`--scope`、`--sort`、`--fields` | 按 `--sort` 指定的 coverage/usage 指标排序；未指定时按 moduleId 升序。返回模块索引，不附源码与图 |
| `module` | `--module`，可选 `--include` | 模块身份、coverage 摘要、导出/入出边计数和关联 source ID |
| `coverage` | `--module`、`--run`、`--view summary\|lines\|ranges`、`--state`、`--sort` | 对应模块的映射和执行证据，详情分页 |
| `exports` | `--module`、`--used`、`--sort` | 导出路径、编译期使用状态及捕获的具名引用计数；不补造声明位置 |
| `references` | `--module`、`--direction in\|out`、可选 `--export-path` | 直接引用，包括关系类型、路径和位置，源码通过 edge ID 另取 |
| `chain` | `--module`、`--export-path`、`--depth`、`--max-edges` | 有界 export 子图、未知终点、循环和待续查 frontier |
| `source` | `--source`、`--line`、`--column`、`--characters` | 某一坐标空间中的捕获文本窗口、hash 和 next 位置 |
| `sources` | `--module` | source ID、路径、坐标空间与 hash 的分页列表 |
| `reference` | `--edge`、`--context`、`--characters` | 消费处源码窗口、可取得的语法 owner、原始 loc 和映射精度 |
| `gaps` | 可选 `--module`、`--kind` | 可查询的缺失/歧义证据，不把整份诊断附在每个响应里 |

`module --include` 允许 `coverage,exports,reference-stats` 等白名单。附加列表仍使用独立预算
和续查位置，不展开所有导出和引用。大数组返回计数、短预览及对应列表查询入口。

### 排序与筛选

排序依据由 Agent 根据当前分析目标通过 `--sort` 显式指定，CLI 执行确定性的字段排序。
建议的选择如下；这些是调用时的选择依据，不是 CLI 自动切换的默认值：

| 分析目标 | 范围与排序依据 |
| --- | --- |
| 找首屏已交付但未执行的较大实现 | `--scope loaded`，按 `coverage.generated.unexecutedBytes:desc` |
| 找整个构建中体积较大的模块 | `--scope build`，按 `coverage.generated.emittedBytes:desc` |
| 找直接消费者较多的模块，调查引用影响面 | 按 `usage.distinctConsumers:desc`；这一指标不依赖浏览器录制 |

字节指标决定代码规模，引用指标描述图关系。排序提供调查顺序，不能直接给出可删除代码量
或预计优化收益。采用显式字段和方向，也支持少量复合排序：

```sh
node <skill>/scripts/query.cjs modules --db <index.sqlite> --run <run-id> --scope loaded \
  --sort coverage.generated.unexecutedBytes:desc --limit 20

node <skill>/scripts/query.cjs modules --db <index.sqlite> \
  --sort usage.incomingReferences:desc --limit 20

node <skill>/scripts/query.cjs modules --db <index.sqlite> --run <run-id> --scope loaded \
  --sort coverage.generated.unexecutedBytes:desc,usage.incomingReferences:desc --limit 10
```

首批可排序字段：

| 字段 | 含义与限制 |
| --- | --- |
| `coverage.generated.emittedBytes` | 统计范围内可归因的最终 JS 字节 |
| `coverage.generated.loadedBytes` | 当前录制加载到的可归因 JS 字节 |
| `coverage.generated.unexecutedBytes` | 当前录制已加载、未执行的生成字节 |
| `coverage.generated.executionRatio` | executed / loaded；分母为零时未知 |
| `coverage.retainedSource.unexecutedBytes` | 保留原始源码行中的未执行字节，只作为另一种调查指标 |
| `usage.incomingReferences` | 直接入边数量，不是独占依赖大小或收益 |
| `usage.distinctConsumers` | 不同直接消费者数量 |
| `usage.usedExportCount` | 已确认具名使用的导出数量，编译器 unknown 不换算成精确数 |

只接受白名单字段，不接收 SQL 或任意排序表达式。默认按 moduleId 稳定排序；每种显式
排序最终追加 moduleId。未知值在升降序中都排最后，响应报告排序字段的已知/未知数量。
不把缺失 coverage 的模块当作零执行或百分之百未使用。

`--scope build` 是整个编译输出，`initial` 是编译器标记的初始资源，`loaded` 是指定录制
加载的资源。`initial` 不等于首屏实际请求。筛选资源范围后重新聚合指标，不能仅筛出
“属于 initial 的 module”后继续使用其全构建字节。
缺少支持某种范围或指标的底层数据时，明确返回不可用能力；不暗中切换为别的统计口径。

### 排序后的读取与续查

`modules` 返回 moduleId；Agent 用同一 db 和 moduleId 获取详情，不依赖行号或列表排名。
详情不会因查询顺序而改变。列表 cursor 绑定 dataset、run、scope、filter、sort 和最后一个
排序键，采用 keyset 分页；更换任一条件或数据集时返回 `CURSOR_MISMATCH`。

`chain` 的 frontier 包含待查 module/exportPath 及邻接边 cursor。深度截断、宽节点截断
和未知关系分别表达；共享节点和循环去重复展开，但边仍保留。不能用一个 `truncated`
布尔值代替续查信息，也不能把所有终点标成业务入口。

## 返回格式与上下文预算

以下为字段示例，数值是示意数据，不代表实测结果：

```json
{
  "ok": true,
  "schemaVersion": 1,
  "datasetId": "dataset_1",
  "buildId": "build_1",
  "compiler": "web",
  "coverageRunId": "run_1",
  "query": {
    "resource": "modules",
    "scope": "loaded",
    "sort": "coverage.generated.unexecutedBytes:desc"
  },
  "items": [{
    "moduleId": "module_1",
    "path": "src/editor.ts",
    "coverage": {
      "generated": {"loadedBytes": 10000, "unexecutedBytes": 8000}
    },
    "usage": {"incomingReferences": 6},
    "detail": {"command": "module", "module": "module_1"}
  }],
  "page": {"total": 40, "returned": 1, "nextCursor": "opaque-cursor"},
  "ranking": {"known": 36, "unknown": 4},
  "gaps": {"count": 4, "command": "gaps"}
}
```

默认列表 20 项，最多 200；source 默认 4000 字符，最多 12000；chain 默认深度 5、100 条
边。单次响应默认总预算 32 KiB。达到预算时减少当前页并返回续查位置，不把完整对象打印
后再截断 JSON。单个不可拆分的记录过大时返回摘要与明确的缩小窗口方法。

标准输出为一个 JSON 对象，进度和运行时 warning 使用 stderr。错误有非零退出码和
`error.code/message/details`，例如 `METRIC_UNAVAILABLE`、`FEATURE_UNAVAILABLE`、
`INPUT_IDENTITY_MISMATCH`、`CURSOR_MISMATCH`、`SOURCE_UNAVAILABLE`。不联网或启动 UI。

## coverage 与 graph 的关联语义

1. coverage 执行状态和编译期 export 使用状态分别提供。`used` 不代表录制中执行过，
   `unexecuted` 不证明整个应用无需实现，也不代表可节省 gzip。
2. 若输入以后保留 generated asset/offset 与 source/range 的关联，ranges 才能开放，并须
   标注偏移单位、文本 hash 和映射精度。当前只开放行级证据，原始代码与 post-loader 坐标不混用。
3. 生成字节与保留映射源码行字节分开统计；同一 source 对应多个 module 实例时，用具体
   asset/chunk 归属核对。仍不能唯一归因的指标为 null，保留共享 source 及关联实例，
   不按比例摊分或重复累计。Network 观察到、但未捕获脚本文本/coverage 的资源也保留未知。
4. 目前已有的原始源码行状态不能还原成精确的函数/区块执行状态。输入只有行级映射时，
   提供 `coverage --view lines`；请求 ranges 而无底层区间时返回不可用。需要更精细的
   generated ranges 或 asset 级范围排序，须让 coverage 输出侧保留这些事实。
5. graph 关系记录 native / module-graph / source-inferred 来源；语法 owner 仅表示归属。
   未命名/namespace 边和缺失 dependency 类型保留为未知或补查入口，不合成为精确调用链。

## Agent 的典型消费过程

```sh
node <skill>/scripts/query.cjs status --db <index.sqlite>
node <skill>/scripts/query.cjs modules --db <index.sqlite> --run <run-id> --scope loaded \
  --sort coverage.generated.unexecutedBytes:desc --limit 10
node <skill>/scripts/query.cjs module --db <index.sqlite> --module <module-id> --include coverage,exports
node <skill>/scripts/query.cjs coverage --db <index.sqlite> --module <module-id> --run <run-id> --view lines --state unexecuted --limit 20
node <skill>/scripts/query.cjs references --db <index.sqlite> --module <module-id> --direction in --limit 20
node <skill>/scripts/query.cjs reference --db <index.sqlite> --edge <edge-id> --context 3
node <skill>/scripts/query.cjs chain --db <index.sqlite> --module <module-id> --export-path '["default"]' --depth 3 --max-edges 50
```

Agent 得到同一模块的 coverage、导出和消费位置，再决定继续查询或开展实验。CLI 的返回
不预写“可以删除”“预计优化百分比”等结论。当前任务的选择范围和未查分支由 Agent 保留。

## 第一版实现顺序与验收

1. 实现 adapters、身份核对、SQLite 索引，支持 `describe/status/modules/module` 及排序。
2. 接入分页 coverage、exports/references、有界 source/reference 和可续查 chain。
3. 在已有同构建的 coverage 数据与 usage 快照上联调，最后把实际命令接入 Skill。

验收关注实际数据行为：大量同分值分页无重复遗漏；更换 run/filter/sort 后旧 cursor 报错；
共享 source 不重复归因；unknown 不变零；有环/宽图保留边与 frontier；缺图/缺 map 能继续
读取已有事实；源码窗口可准确续读；输入不同构建时拒绝关联；查询不修改输入或启动服务。
同时记录大快照下的索引耗时、单次查询耗时/内存及输出字节，验证按需读取确实减少代价。
