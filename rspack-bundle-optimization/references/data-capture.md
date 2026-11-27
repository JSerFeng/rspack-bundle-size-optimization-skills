# 数据抓取

构建采集、浏览器 coverage 录制、首屏耗时对比、sourcemap 分析及按需查询均由 Skill 的 scripts 提供。
需要 Node >=22.13；运行依赖安装在 Skill 内，被分析项目继续使用自己的 Rspack。

```sh
npm ci --prefix <skill>/scripts --omit=dev
node <skill>/scripts/query.cjs --help
```

## 保存同一次构建的证据

在项目最终生效的 Rspack 配置 hook 中临时追加内置插件。Rspack 配置示例：

```js
const { BundleEvidencePlugin } = require('/absolute/path/to/skill/scripts/capture-plugin.cjs');

// 追加到原有 plugins；Rsbuild/Rspeedy 在最终 Rspack 配置 hook 中接入。
plugins: [new BundleEvidencePlugin({ directory: '/absolute/path/to/build-evidence' })]
```

运行真实 production command。插件为每次成功构建保存独立 SQLite，并在 directory 的
latest.json 中记录 file/buildHash；stderr 也输出完整路径。每个 compiler 用独立目录。
失败构建不发布 complete 快照，不能沿用旧 latest 冒充新结果。
在 EdenX / Rsbuild / Modern.js 等框架中接入时，构建日志应出现 `[BundleEvidencePlugin]` 输出且目标目录生成 `latest.json`；若框架 hook 后续重置了 `config.plugins`（导致 `appendPlugins` 失效），请直接在最终生效的 `tools.rspack` 回调里追加到 `config.plugins` 并复核产物。

快照包含产物全文与 hash、asset sourcemap、模块完整 identifier/layer、构建时源码及
loader map、chunk 归属、chunk group/origin、module graph 和可用的原生 export usage graph。
插件保留项目优化设置，不关闭 minify、模块拼接或 tree-shaking；缺少原生图时声明不可用。
若按 SKILL 的 export usage 诊断步骤关闭 concatenateModules，另存该诊断构建及其浏览器录制，
不与保留原配置的生产基线混用；插件本身不会替 agent 改动此开关。

源码归因需要完整 sourcemap。已有 source-map/hidden-source-map 时直接捕获；未生成时
可临时使用 devtool: 'hidden-source-map'。插件不自动修改该配置，缺图时保留生成字节并报告
映射缺口。最终收益比较使用可比生产配置；分析结束移除临时插件和项目不需要的 map 设置。

## 浏览器首屏录制

页面导航、登录、操作、网络和 Performance trace 可使用已有 Chrome DevTools MCP 或 CLI。
精确 coverage 使用 scripts/record.cjs 连接同一个已开启远程调试的 Chrome，不需要 Puppeteer。
从 Chrome 的调试连接配置或 DevToolsActivePort 获取 endpoint，不猜端口，不另开一套登录会话。

```sh
node <skill>/scripts/record.cjs --help
node <skill>/scripts/record.cjs --endpoint http://127.0.0.1:<debug-port> \
  --url http://localhost:<app-port>/ \
  --ready-selector '[data-first-screen-ready]' \
  --out /absolute/path/to/recording.json --scenario first-screen
```

endpoint 也可传页面 WebSocket URL（注意：仅使用 `--remote-debugging-pipe` 的 Chrome DevTools MCP 实例不暴露 HTTP/WS 端口，需连接带 `--remote-debugging-port` 的 Chrome）。多个页面时用 --target <CDP-target-id> 选择，选择错误
会返回可用页面列表；CDP target ID 与 MCP 的 pageId 不同。
--ready-expression 'globalThis.appReady === true' 可替代 selector，必须明确一种首屏完成条件。
不要用未校验的固定等待时间代替业务就绪条件。默认超时 30 秒，--timeout 单位毫秒。

脚本在新文档导航前启动 per-block coverage 和网络监听，就绪后保存实际脚本文本、原始
V8 计数、请求清单、浏览器版本、采集边界及缺口。超时不写 complete 录制。
默认 --cache cold 只禁用 HTTP cache；warm 保留 HTTP cache，不清理登录、Service Worker
或 CacheStorage。记录实际环境，不把它自动称为全新浏览器的冷启动。

录制范围是选定页面的 JS isolate，暂不包含 worker 和跨进程 iframe，录制中会记录此缺口。
Network 中出现、但没有捕获到实际脚本文本/coverage 的资源，加载与执行归因为 unknown，
不能因为 coverage 中缺席就判为零执行。loaded 查询范围采用可确认的脚本观察。
precise coverage 会影响 V8 的优化执行，不能拿录制 coverage 的那轮结果当性能数据；首屏 FCP/LCP 需要用下面的 `scripts/scan.cjs` 单独测。
已有 Chrome Coverage JSON（url/text/ranges）可直接复用，无需重新录制。

## 首屏耗时对比

用同一个 Chrome 标签页和 URL 分别测优化前后的生产构建，开跑前先确认页面实际加载的是目标产物。`--endpoint`、`--target` 和就绪条件沿用上面 `record.cjs` 的写法；就绪条件要对应真实首屏内容（比如列表数据行或页面主体），不要只判断骨架或空容器。

```sh
node <skill>/scripts/scan.cjs --endpoint http://127.0.0.1:<debug-port> \
  --url http://localhost:<app-port>/ \
  --ready-selector '[data-first-screen-ready]' \
  --out /absolute/path/to/before.json

# 用相同生产配置重建并部署到同一 URL 后复测
node <skill>/scripts/scan.cjs --endpoint http://127.0.0.1:<debug-port> \
  --url http://localhost:<app-port>/ \
  --ready-selector '[data-first-screen-ready]' \
  --against /absolute/path/to/before.json \
  --out /absolute/path/to/after.json
```

每组默认先预热 1 次、正式采样 3 次，可用 `--runs` 调大到最多 30 次。每次都会重新加载文档，等标签页可见、`load` 完成、就绪条件满足且 FCP/LCP 都拿到后再继续观察 1 秒，期间如果 LCP 有更新就重新计时，直到稳定（`--settle-ms` 默认 `1000`，`--timeout` 默认 `30000`，单位都是毫秒）。遇到异步晚加载内容或前后 LCP 元素变化时，结合报告里的 `lcpElement`（标签和面积）核对页面实际渲染情况。

默认 `--cache cold` 禁用 HTTP cache，保留登录态和 Service Worker；需要测缓存命中时传 `--cache warm`。默认不限速，传 `--throttle mobile` 会模拟 150 ms RTT、1.6 Mbit/s 下行和 4× CPU 降速。前后两组必须在同一台机器、同一浏览器和相同的视口、限速、缓存设置下测，工具会把这些环境信息记入报告并在对比时校验。测速期间保持标签页可见，不要操作页面，也不要同时开 coverage 或其他 DevTools 录制/模拟；构建版本、登录态和后端数据的一致性仍需按实际场景确认。

输出 JSON 保存每次采样和 FCP/LCP 中位数，变化阈值取 `max(30 ms, 基线中位数的 2%)`。FCP 或 LCP 任一项回退达到阈值就判为 `regressed` 并返回退出码 1（报告照常写入）；没有回退且至少一项改善判为 `improved`，其余为 `within-noise`。环境条件不一致或采样失败时直接报错，不写输出文件。这个阈值只是经验值，结果贴近边界时建议看样本分布并增加 `--runs` 重测。

## 内置分析和查询

```sh
# 一步完成 sourcemap/coverage 分析与建索引（默认输出 AI 友好文本，加 --format json 输出 JSON）
node <skill>/scripts/query.cjs index --build <build.sqlite> \
  --coverage /absolute/path/to/recording.json --out /absolute/path/to/index.sqlite
node <skill>/scripts/query.cjs status --db /absolute/path/to/index.sqlite
node <skill>/scripts/query.cjs chunks --db /absolute/path/to/index.sqlite
node <skill>/scripts/query.cjs modules --db /absolute/path/to/index.sqlite --scope loaded \
  --max-ratio 0.2 --sort coverage.generated.unexecutedBytes:desc --limit 20
```

`index --build --coverage` 直接处理内置录制或 Chrome Coverage JSON，核对 URL 与脚本文本 SHA-256，读取同一构建的 sourcemap，将生成区间映射到 source/行，并计算加载、执行和未执行字节。
同名 URL 的文本不匹配构建时拒绝分析。第三方脚本单独记录，不强行归入项目模块。
原始 V8 的零执行子区间覆盖外层正计数；重复采样的执行范围取并集，不重复累计。

构建快照与录制文件作为不可变输入保留；查询时自动校验输入签名，stdout 默认输出紧凑可读文本（`--format text`），大数据留在 SQLite。
对于旧的平面 Coverage JSON，`--precision per-block/per-function` 必须与实际采集方式一致，不清楚则保持 `unknown`；该参数不会把函数级录制变成区块级精度。

源码归因以完整路径、文本身份和 chunk 归属关联模块；共享 source 无法唯一归因时返回 unknown，不按比例摊分。asset map 若只指向 loader 中间产物，会保留 `map-source` 坐标空间；不把文件名像 TS/TSX 当作已验证的原始源码映射。

只调查编译期导出或 chunk 结构时，无需录制：

```sh
node <skill>/scripts/query.cjs index --build <build.sqlite> --out <index.sqlite>
```

## 按需分析

具体选项见 [query-cli.md](query-cli.md)。先用 `status` 确认构建身份、场景、总字节与缺口，用 `chunks` 检查多 origin 合并的 chunk group，再用 `modules`、`module`、`source`、`refs`、`chain` 逐层阅读真实源码与引用链。

原生图反映编译期关系，源码语法 owner 只表明归属，不是运行时调用证明。未执行不等于可删。
生成 JS UTF-8 字节与保留映射源码行字节分别报告；检查 coordinateSpace、hash 和映射缺口。
源码按 next 续读，列表按 cursor、图按 frontier 续查，避免把完整源码和大图放进上下文。
