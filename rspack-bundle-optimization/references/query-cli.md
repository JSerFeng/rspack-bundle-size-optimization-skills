# 按需查询 coverage 与 export usage

使用 Skill 自带的 `scripts/query.cjs`，先建一次 SQLite 索引，再按需返回有界结果。
**CLI 默认输出面向 AI 友好的紧凑文本（`--format text`）**——表格使用相对路径与可读字节/百分比，源码带行号与内联覆盖率，引用默认直接附带 map 回原始源码后的坐标、语法 owner 与代码片段；需要程序化解析时加 `--format json`（单行 JSON）。

查询不联网、不启动 UI/HTTP 服务，也不运行构建。CLI 提供事实与证据缺口，业务必要性、优化选择与实际收益由 Agent 结合源码和生产实验判断。

## 准备和建索引

需要 Node >=22.13。以下 `<skill>` 替换为当前 Skill 的绝对目录；依赖安装在 Skill 内：

```sh
npm ci --prefix <skill>/scripts --omit=dev
node <skill>/scripts/query.cjs --help
node <skill>/scripts/query.cjs refs --help
```

采集流程见 [data-capture.md](data-capture.md)。内置 `capture-plugin.cjs` 在成功构建后保存 `build.sqlite`；内置 `record.cjs` 连接现有 Chrome 录制精确 coverage。**一步完成 sourcemap 分析与建索引**：

```sh
# 一步分析 coverage + 建索引（推荐，无需中间 coverage.sqlite）
node <skill>/scripts/query.cjs index --build <build.sqlite> --coverage <recording.json> \
  --out <index.sqlite> --scenario first-screen

# 只做编译期 export usage / chunk 分析（无浏览器录制）
node <skill>/scripts/query.cjs index --build <build.sqlite> --out <index.sqlite>

# 兼容既有预分析 coverage.sqlite 或独立 usage.sqlite
node <skill>/scripts/query.cjs index --coverage <coverage.sqlite> [--usage <usage.sqlite>] --out <index.sqlite>
```

- `index` 接受内置录制或 Chrome Coverage JSON（`url/text/ranges`），支持 raw V8 `functions/ranges` 嵌套零区间；核对同一构建 URL 与脚本文本 SHA-256，解析普通/索引 sourcemap，将 UTF-16 区间转为生成 JS UTF-8 字节并关联源码行和模块。
- `--scenario` 标注场景，`--precision` 只描述已有录制精度（`per-block|per-function|unknown`），不升级证据。
- 默认不覆盖既有输出。保留原始输入文件，查询时检查路径、大小、mtime 和 inode，变化返回 `INPUT_CHANGED`。
- 内部索引 schema 现为 3（新增 chunks/chunk_groups、源码去重与 inline coverage sources），旧索引需用当前命令重建。

## 8 个核心命令速览

| 命令 | 核心职责 | 典型调用 |
| --- | --- | --- |
| `index` | 一步分析 coverage 并建索引 | `query.cjs index --build b.sqlite --coverage r.json --out i.sqlite` |
| `status` | 全局身份、字节总览、能力与缺口 | `query.cjs status --db i.sqlite` / `status --gaps` |
| `chunks` | Chunk Groups、origins 与多入口合并的非必要模块分析 | `query.cjs chunks --db i.sqlite` / `chunks --group <id>` |
| `modules` | 按覆盖率/未执行字节/引用数排序与筛选模块 | `query.cjs modules --db i.sqlite --scope loaded --max-ratio 0.2 --sort coverage.generated.unexecutedBytes:desc` |
| `module` | 单模块全景：coverage 摘要、chunks、去重源码视图与 exports | `query.cjs module --db i.sqlite --module <id> [--used used]` |
| `source` | 直接按 `--module` 读带行号和内联覆盖率的源码，或列未执行热点行 | `query.cjs source --db i.sqlite --module <id>` / `--unexecuted` / `--space post-loader` |
| `refs` | **按 export 分组返回所有使用处 + map 后源码坐标 + owner + 代码片段**，或批量展开指定边 | `query.cjs refs --db i.sqlite --module <id>` / `--edge e1,e2 --context 8` |
| `chain` | 向上追踪导出完整引用链（带相对路径、map 后坐标、代码预览、cycles/terminals/frontier） | `query.cjs chain --db i.sqlite --module <id> --export <name>` |

*(每个命令都支持 `<command> --help` 查看专属选项，以及 `--format text|json`。)*

## 典型消费步骤

### 1. 看全局与缺口（`status`）
```sh
node <skill>/scripts/query.cjs status --db <index.sqlite>
# 缺口 > 10 条或需按条件过滤时：
node <skill>/scripts/query.cjs status --db <index.sqlite> --gaps [--module <id>] [--kind <kind>]
```
`gaps <= 10` 时会在 `status` 中直接展开。

### 2. 查 Chunk Groups 与多 origin 合并（`chunks`）
```sh
# 一步筛选已完整加载的多 origin 合并 chunk group（支持 --multi-origin / --loaded / --search / --sort）
node <skill>/scripts/query.cjs chunks --db <index.sqlite> --multi-origin --loaded --sort unexecutedBytes:desc
# 下钻分析指定 chunk group（检查已执行 vs 未执行 origin 静态可达模块）：
node <skill>/scripts/query.cjs chunks --db <index.sqlite> --group <groupId-or-name>
# 大型 chunk group 分段翻页查看 origins / chunks / candidates：
node <skill>/scripts/query.cjs chunks --db <index.sqlite> --group <groupId> --section origins --offset 20 --limit 20
# 查看单个 chunk 内的模块列表（字节列为跨 chunk 模块汇总，chunks 列标明所属 chunk 数）：
node <skill>/scripts/query.cjs chunks --db <index.sqlite> --chunk <chunkId>
```

### 3. 排序与筛选目标模块（`modules`）
```sh
# 首屏已加载、低覆盖率（<=20%）、未执行体积大的模块
node <skill>/scripts/query.cjs modules --db <index.sqlite> --scope loaded \
  --max-ratio 0.2 --min-unexecuted 1024 \
  --sort coverage.generated.unexecutedBytes:desc --limit 20

# 纯副作用候选模块（编译器确认无任何导出被使用）
node <skill>/scripts/query.cjs modules --db <index.sqlite> --scope loaded \
  --used-state none --sort coverage.generated.unexecutedBytes:desc

# 按直接消费者影响面排序（不依赖浏览器录制）
node <skill>/scripts/query.cjs modules --db <index.sqlite> \
  --sort usage.distinctConsumers:desc --limit 20
```

| module 排序字段 | 含义 |
| --- | --- |
| `moduleId` / `id`、`path` | 稳定实例 ID、相对路径 |
| `coverage.generated.emittedBytes` | 当前范围可独占归因的最终 JS 字节 |
| `coverage.generated.loadedBytes` | 本次录制加载的生成字节 |
| `coverage.generated.unexecutedBytes` | `loaded - executed`，不直接换算成收益 |
| `coverage.generated.executionRatio` | `executed / loaded`，分母为零时 unknown |
| `coverage.retainedSource.unexecutedBytes` | 另一口径：保留映射源码行的未执行字节 |
| `usage.incomingReferences` | 原生图直接入边数 |
| `usage.distinctConsumers` | 原生图不同直接消费者数 |
| `usage.usedExportCount` | 编译器确认的具名使用导出数，unknown 不换算成零 |

`--scope build` 是整个构建；`--scope loaded` 仅列已加载资源中的模块；`--scope initial` 明确报不可用。未知值统一显示为 `unknown`（JSON 中为 `null`），升降序均排最后。

### 4. 单模块详情与源码/覆盖率（`module`、`source`）
```sh
# 一次拿齐 coverage 摘要、chunks 归属、去重源码视图、exports 列表（默认 30 条）
node <skill>/scripts/query.cjs module --db <index.sqlite> --module <module-id> --used used

# 直接读源码（自动选最优 resource/map-source，自带行号和每行覆盖率标注）
node <skill>/scripts/query.cjs source --db <index.sqlite> --module <module-id> --line 1

# 按未执行字节降序列出热点行及对应行代码（包含未执行行和部分执行行 `partial`；严格 0 执行行可用 `--state unexecuted`）
node <skill>/scripts/query.cjs source --db <index.sqlite> --module <module-id> --unexecuted --limit 20

# 排查语法降级时查看 loader 转换后产物
node <skill>/scripts/query.cjs source --db <index.sqlite> --module <module-id> --space post-loader
```

同一模块、同空间、同 hash 的源码已自动去重。按底部 `next window: --line X --column Y` 续读大文件。

### 5. 所有使用处代码片段与完整上游链（`refs`、`chain`）
```sh
# 一次查看该模块所有使用处（按 export 分组，默认已通过 loader sourcemap map 回原始源码坐标 + owner + 3 行代码片段）
node <skill>/scripts/query.cjs refs --db <index.sqlite> --module <module-id>

# 只看某个具名导出的使用处，或扩大上下文行数 / 纯列表无代码
node <skill>/scripts/query.cjs refs --db <index.sqlite> --module <module-id> --export foo --context 2
node <skill>/scripts/query.cjs refs --db <index.sqlite> --module <module-id> --export-path '["ns","foo"]'
node <skill>/scripts/query.cjs refs --db <index.sqlite> --module <module-id> --no-code

# 批量展开 1..20 条可疑使用处的更大上下文窗口
node <skill>/scripts/query.cjs refs --db <index.sqlite> --edge <edge1>,<edge2> --context 8

# 向上追踪某导出的完整引用链（自带模块相对路径、map 后坐标、聚焦代码行预览、cycles/terminals/frontier）
node <skill>/scripts/query.cjs chain --db <index.sqlite> --module <module-id> --export default --depth 5
```

- `capture-plugin.cjs` 默认标记 `locationSpace: "post-loader"`，CLI 自动通过 loader `source_map` 映射回原始 `.ts/.tsx` 源码坐标并用 SHA-256 核对 `resource`（输出标注 `mapped->resource`）。缺少 loader map 或 map 指向中间产物时，显式标注 `post-loader` / `map-source` 与缺口说明。
- 独立外部 usage 快照未声明 `locationSpace` 时保持 `auto`，保留候选并用 `--space resource|post-loader` 复查。
- `chain` 的 `terminals`（含 `no-named-origin-export`）与 `frontier` 均直接给出可复制的续查命令。

## 分页、预算与错误

- 列表默认 20 项（`module` exports 默认 30），最多 200；source 默认 4000、最多 12000 个 UTF-16 单元；chain 默认深度 5、100 边，上限 20/500。
- 单次响应硬上限 32 KiB，列表/源码/引用链会自动缩小当前页并给出 `--cursor` 或 `--line/--column` 续查入口。
- 传 `--cursor` 时重复原查询的 `run/scope/filters/sort/fields`（允许调整 `--limit` 和 `--format`），条件不匹配返回 `CURSOR_MISMATCH`。
- 失败时退出码非零：text 模式输出 `ERROR [CODE]: ...` 与合法选项提示，json 模式输出 `{ ok: false, error: { code, message, details } }`。

## 独立 usage SQLite 契约

优先使用内置 `capture-plugin.cjs`。接入其他采集器时，独立 usage SQLite 需满足 schema 1（表 `meta`、`modules`、`edges`，可选 `refs`、`chunks`、`module_chunks`、`chunk_groups`），`meta` 至少含 `schema:1`、`status:"complete"`、`graphAvailable:boolean`、`buildHash:string`、`context:string`，可含 `compiler`、`columnBase`（默认 1）、`locationSpace`（默认 `auto`）。

## 验证

```sh
npm ci --prefix <skill>/scripts
npm test --prefix <skill>/scripts
# 显式指定 Chrome，额外运行本地真实浏览器录制测试：
CHROME_PATH=<Chrome-executable> npm test --prefix <skill>/scripts
```
