# 数据抓取

内置 CLI 查询时，使用 [query-cli.md](query-cli.md#准备和输入)

## 导出使用与源码上下文

Rspack 的内置 RsdoctorPlugin 提供了 exportUsageGraph 数据，用于分析模块的导出使用情况，用 [查询 CLI](query-cli.md) 按模块或导出查询 references/chain，再用 reference 查询消费处及语法归属。

分析时结合导入方源码、包元数据、图中的边和输出产物。位置与源码不匹配、源码缺失或解析
不完整时，记录受影响的结论；不要仅根据导出名或原始业务源码猜测引用关系。

## 浏览器运行数据（按需）

用户关心页面或交互实际加载、执行的代码时，再采集浏览器网络请求和 Chrome/V8 精确覆盖率。
记录页面、操作步骤、采集时机和目标范围；分析首屏时应在导航前启动采集。

coverage 默认采用无报告 UI 的数据流程：保存录制，将覆盖率关联到浏览器执行的同一份
脚本文本，再输出可查询的数据目录。应用本身仍可在浏览器运行；数据分析不依赖报告页面、
截图、颜色高亮或人工点击。已有正确录制与映射时直接复用。

使用支持 Agent CLI 的 `rspack-coverage` 时：

```js
new RspackCoveragePlugin({ server: false, dataDir: '/absolute/path/to/web-build-data' });
```

运行项目 production command，保存成功构建。插件会报告分析所需的配置调整；如它改变了
生产优化设置，将其标为诊断构建，不把其体积当作正常生产收益。
按现有采集方式获得 Chrome Coverage JSON 后：

```sh
rspack-coverage analyze --help
rspack-coverage analyze --data-dir /absolute/path/to/web-build-data \
  --coverage /absolute/path/to/Coverage.json --output /absolute/path/to/first-screen-data \
  --scenario first-screen --precision per-block
node <skill>/scripts/query.cjs index --coverage /absolute/path/to/first-screen-data \
  --out /absolute/path/to/first-screen.sqlite
node <skill>/scripts/query.cjs status --db /absolute/path/to/first-screen.sqlite
node <skill>/scripts/query.cjs modules --db /absolute/path/to/first-screen.sqlite \
  --scope loaded --sort coverage.generated.unexecutedBytes:desc --limit 20
```

CLI 的依赖安装及后续查询见 [query-cli.md](query-cli.md)。先确认当前 rspack-coverage 版本
支持 analyze；Skill 的 query.cjs 不会为旧版本补上导出接口。`--precision` 应与录制方式相符，
不清楚时保持 `unknown`。旧工具缺少这些接口时，按下述约定编写数据适配工具，不能假定
`serve --no-open` 已经提供无服务进程的数据输出。

数据交付采用三层，原始脚本、录制、map 和大图保留在磁盘：

| 数据 | Agent 默认读取的内容 |
| --- | --- |
| 摘要 | schema 版本、build/snapshot/录制身份、场景、精度、匹配数量、统计口径及证据缺口 |
| 分页索引 | 按未执行字节排序的 source/module，稳定 ID、资源归属、执行统计；不含整份源码和全图 |
| 单项详情 | 按 ID 查询导出、直接引用、export chain 和带位置的源码窗口；返回下一页或待续查分支 |

所有后续查询使用 Skill 的 `query.cjs <command> --db <index.sqlite>`，module/source/edge ID
均从该索引查询获得，不混用原工具的 ID。按 module、coverage、references/reference 逐步
展开；源码按 next 续读，chain 按 frontier 续查。完整选项从 describe 或查询说明读取。
