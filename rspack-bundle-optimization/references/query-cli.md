# 按需查询 coverage 与 export usage

使用 Skill 自带的 `scripts/query.cjs`，先建立一次 SQLite 索引，再给 Agent 返回有界 JSON。
查询不联网、不启动 UI/HTTP 服务，也不运行构建。CLI 提供事实与证据缺口，业务必要性、
优化选择与实际收益由 Agent 结合源码和生产实验判断。

## 准备和输入

需要 Node >=22.13。以下 `<skill>` 替换为当前 Skill 的绝对目录；依赖安装在 Skill 内：

```sh
npm ci --prefix <skill>/scripts --omit=dev
node <skill>/scripts/query.cjs describe
node <skill>/scripts/query.cjs describe --command modules
```

支持两种输入，可单独使用：

- `--coverage`：`rspack-coverage analyze` 导出的 Agent 数据目录，包含 `dataset.json`
  schema 1、v2 快照、complete report、`report.sources` 及索引、`snapshot.sqlite`。
  采集方法见 [data-capture.md](data-capture.md#浏览器运行数据按需)。
- `--usage`：已有独立 usage SQLite 快照（schema 1），含编译期关系和构建时源码/map，
  不需要浏览器录制。契约见下文；任意 Stats 或 Rsdoctor JSON 不能直接传入。

```sh
node <skill>/scripts/query.cjs index --coverage <agent-data-dir> --out <index.sqlite>
node <skill>/scripts/query.cjs index --usage <usage.sqlite> --out <index.sqlite>
node <skill>/scripts/query.cjs index --coverage <agent-data-dir> --usage <usage.sqlite> --out <index.sqlite>
node <skill>/scripts/query.cjs status --db <index.sqlite>
```

索引是派生数据，不覆盖已有文件。两类输入同时提供时须有相同 build hash、context、
已知 compiler，以及可精确对齐的完整 identifier/layer，不按文件名合并。原生 export 图
采用 usage 输入，coverage 输入补充 module graph 与录制证据。

一个索引绑定一个构建和至多一份录制，不同场景分别建索引。保留原始目录/数据库，
源码/map 在查询时按 ID 读取。每次查询检查路径、大小、mtime 和 inode，变化返回
`INPUT_CHANGED`，需要重建索引。该检查发现意外变更，不是逐次全文件校验和审计。

## 排序后读取模块

不传 `--sort` 时按稳定 moduleId 升序。调查首屏已加载而未执行的较大实现：

```sh
node <skill>/scripts/query.cjs modules --db <index.sqlite> --scope loaded \
  --sort coverage.generated.unexecutedBytes:desc --limit 10
node <skill>/scripts/query.cjs module --db <index.sqlite> --module <module-id> --include exports
```

调查全构建大模块用 `coverage.generated.emittedBytes:desc`；调查直接消费者多的模块用
`usage.distinctConsumers:desc`。最多组合三个字段，例如
`coverage.generated.unexecutedBytes:desc,usage.incomingReferences:desc`。

| module 排序字段 | 含义 |
| --- | --- |
| `moduleId` / `id`、`path` | 稳定实例 ID、完整资源路径 |
| `coverage.generated.emittedBytes` | 当前范围可独占归因的最终 JS 字节 |
| `coverage.generated.loadedBytes` | 本次录制加载的生成字节 |
| `coverage.generated.unexecutedBytes` | loaded - executed，不直接换算成收益 |
| `coverage.generated.executionRatio` | executed / loaded，分母为零时 null |
| `coverage.retainedSource.unexecutedBytes` | 另一口径：保留原始源码行的未执行字节 |
| `usage.incomingReferences` | 原生图直接入边数 |
| `usage.distinctConsumers` | 原生图不同直接消费者数 |
| `usage.usedExportCount` | 编译器确认的具名使用导出数，unknown 不换算成零 |

`--scope build` 是整个构建；`--scope loaded` 仅列出已加载资源中的模块，并以加载字节
重算 emitted。当前输入无法重建 initial 资源的独立字节，`--scope initial` 明确报不可用。
module 的 initial 标志只表示编译器资源归属，不表示页面确实请求了它。

列表不带源码/全图。`--search <substring>`、`--package <exact-package-name>` 筛选，
`--fields path,coverage.generated,usage` 缩小字段，moduleId 始终保留。未知指标为 null，
升降序都排最后，同指标再按 ID 排序。`ranking.known/unknown` 表示首排序字段的完整性。
共享 source 无法拆到实例的生成指标为 null；源码指标也只采用真实 per-instance 数据。
两种字节不能相加，均不代表 gzip 收益。

## 按证据逐步展开

```sh
node <skill>/scripts/query.cjs coverage --db <index.sqlite> --module <module-id>
node <skill>/scripts/query.cjs coverage --db <index.sqlite> --module <module-id> \
  --view lines --state unexecuted --sort unexecutedBytes:desc --limit 20
node <skill>/scripts/query.cjs exports --db <index.sqlite> --module <module-id> --used used
node <skill>/scripts/query.cjs references --db <index.sqlite> --module <module-id> --direction in
node <skill>/scripts/query.cjs reference --db <index.sqlite> --edge <edge-id> --context 3 --characters 2000
node <skill>/scripts/query.cjs chain --db <index.sqlite> --module <module-id> \
  --export-path '["default"]' --depth 3 --max-edges 50
node <skill>/scripts/query.cjs gaps --db <index.sqlite> --module <module-id>
```

- `coverage` 默认摘要；`--view lines` 返回已映射源码行的生成字节及录制状态。缺少
  per-instance 行数据时为 unknown，未映射行缺席也不证明未使用。当前格式未保留精确
  generated offset-to-source ranges，`--view ranges` 返回 `FEATURE_UNAVAILABLE`。
- `exports` 返回 exportPath、编译期状态和已捕获具名入边计数，不生成未捕获的声明位置。
  计数不包含所有可能的 namespace 使用，核对具体引用请查 references。
- `references --relation native|module-graph|all` 区分关系来源，默认 all。
  `--export-path '["ns","foo"]'` 按成员路径查询，保留祖先和 unknown/namespace 边，默认
  native；`--export 'ns.foo'` 则是名称中含点的一个导出。
  module 详情的 moduleReferences 仅计 module-graph，usage 统计仅计 native；默认 references
  同时返回两类关系，所以总数可以不同。
- `chain` 返回原生编译期子图、cycles、未知终点及 frontier。按 frontier 的 query.command
  及选项继续查询直接引用；边取完后用其 originModuleId/originExport 发起下一段 chain。
  缺少具名 origin 时补查 reference/module graph，不能据此宣布到达业务入口。
- `reference` 返回 raw location、可用映射/候选窗口及语法 owner，owner 只证明源码归属。
  坐标为 line 1-based、column 0-based UTF-16。独立 usage 坐标不确定时保留候选，核对
  采集方式后才用 `--space resource|post-loader`、`--column-base 0|1` 复查。

源码用 module/sources 返回的 sourceId，保留 coordinateSpace/sourceHash：

```sh
node <skill>/scripts/query.cjs sources --db <index.sqlite> --module <module-id>
node <skill>/scripts/query.cjs source --db <index.sqlite> --source <source-id> \
  --module <module-id> --line 1 --column 0 --characters 4000
```

按 `next.line/column` 续读，不用当前磁盘源码冒充构建文本。map 候选的 sourceQuery 带有
`map-source` 时，使用 `source --map-source <captured-map-source>`。大于 2 MiB 的文本仍可
分窗读取，语法 owner 会说明 AST 预算缺口。图关系不等于运行时调用，未执行不证明可删。

## 分页、预算与错误

列表默认 20、最多 200 项。传 `page.nextCursor` 时重复原查询的 run/scope/filter/sort/
fields，允许改变 limit；cursor 绑定 dataset/查询，条件改变返回 `CURSOR_MISMATCH`。
`--run` 只核对当前 coverageRunId，不选择或合并其他录制。

source 默认 4000、最多 12000 个 UTF-16 单元；chain 默认深度 5、100 边，上限 20/500。
单次 JSON 最多 32 KiB，列表/源码/子图可能提前缩小并给续查入口，Unicode 文本也受 UTF-8
字节预算限制。不可拆分的超大记录返回 `RECORD_TOO_LARGE`，可改用 fields、更小源码窗口
或图预算。stdout 一个 JSON 对象，warning 在 stderr；失败非零退出码，读取
`error.code/message/details`。status 声明能力，gaps 查询采集/归因缺口；不可用指标不换算成零。
gaps=0 不代表已确认业务必要性、所有运行场景或实际优化收益。

## 独立 usage SQLite 契约

adapter 读取已有快照，不捆绑生产采集器。需要采集时按当前 Rspack API 实现临时插件，
写入以下 schema，完整文本保留在 SQLite，查询时不重建全图 JSON：

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); -- JSON values
CREATE TABLE modules(
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, layer TEXT, type TEXT,
  resource TEXT, parent_id TEXT, provided TEXT, used TEXT,
  transformed TEXT, source_map TEXT, resource_content TEXT,
  transformed_hash TEXT, resource_hash TEXT, source_gap TEXT
);
CREATE TABLE edges(
  id TEXT PRIMARY KEY, origin TEXT NOT NULL, target TEXT NOT NULL,
  origin_export TEXT NOT NULL, target_export TEXT NOT NULL,
  dependency TEXT NOT NULL, loc TEXT
);
```

meta 至少含 schema:1、status:"complete"、graphAvailable:boolean、buildHash:string、
context:string，可含 compiler、columnBase（默认 1）、locationSpace（默认 auto）。
provided/used 为 JSON：provided 是 string[] 或 null，used 是 string[]、boolean 或 null；
origin_export/target_export 是 JSON string[] 或 null。loc 是捕获位置文本，如 `2:4-12`。
source_map 是 Source Map v3 JSON 文本，hash 为捕获文本的 SHA-256 hex。缺图时必须记录
graphAvailable=false，不能把未抓到的事实写成空图且声明图可用。

## 验证

```sh
npm test --prefix <skill>/scripts
# 真实编译/导出集成测试需要另有已构建的 rspack-coverage checkout：
RSPACK_COVERAGE_REPO=<coverage-repo> npm test --prefix <skill>/scripts
```

默认测试含分页、未知归因、映射、图预算及 1 万模块/3 万边合成测试。真实集成测试要求
该 checkout 已提供 server:false/analyze。已发布旧版本缺少这些接口时先适配导出侧，
本 Skill CLI 不负责采集或重做 coverage 映射。
