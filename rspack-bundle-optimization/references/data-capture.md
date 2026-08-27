# 数据抓取

当源码和最终资源无法可靠还原编译器事实时，使用抓取插件记录这些事实。

## 配置抓取

在最终的 Rspack 配置 hook 中引入
`scripts/rspack-data-capture-plugin.template.cjs`：

```js
const {
  RspackBundleDataCapturePlugin,
} = require("<skill>/scripts/rspack-data-capture-plugin.template.cjs");

if (process.env.RSPACK_BUNDLE_CAPTURE === "1") {
  config.plugins ||= [];
  config.plugins.push(
    new RspackBundleDataCapturePlugin({
      rspack,
      runId: process.env.RSPACK_BUNDLE_RUN_ID,
      compilerId: "web",
      outDir: process.env.RSPACK_BUNDLE_CAPTURE_DIR,
      captureExportUsage: true,
      captureSources: true,
    }),
  );
}
```

## 输出文件

- `compilation-data.json`：解析后的配置、Stats 数据、资源、模块、导出状态、chunk、
  chunk group、入口点和连接；
- `export-usage.json`：执行构建的编译器支持时，记录原始 Rsdoctor 模块和 export usage
  边；
- `post-loader-sources.jsonl`：Rspack 在 loader 处理后通过
  `module.originalSource()` 接收到的完整文本；
- `post-loader-index.json`：源码查询数据和哈希；
- `capture-manifest.json`：输出大小和哈希。

完整抓取必须来自成功的生产构建。工具使用全新的输出路径，并保留先前证据。无法获取
export usage 数据时，应记录该缺口；`requireExportUsage:true` 会把此字段设为必需的抓取
结果。

## 读取编译器数据

```bash
jq '.assets' <capture>/compilation-data.json

jq '.modules[] | select(.usedExports == [])' \
  <capture>/compilation-data.json

jq '.chunks[] | {id, name, files, modules}' \
  <capture>/compilation-data.json

node <skill>/scripts/read-capture.cjs \
  --dir <capture> \
  --source "package/path.js"
```

分析时，将这些记录与导入方源码、包元数据、图中的边以及输出产物关联起来。

## 读取 export usage 上下文

```bash
node <skill>/scripts/extract-export-usage-context.cjs \
  --dir <capture> \
  --project-root <audited-package-root> \
  --target "provider/package/path.js" \
  --export "exportName" \
  --out <run>/notes/export-context.json
```

Rspack 按 `consumer -> provider` 方向记录边。脚本会保留每一条匹配边及其位置，补充源码
上下文和所属声明，并展示嵌套回调的归属关系。按提供方或导出项筛选；只有确实希望扩大结果
范围时，才显式使用 `--max-matches`。

脚本从被审计的包中解析 `@babel/parser`。如果抓取元数据无法确定包根目录，请传入
`--project-root`。非零退出码和 `complete:false` 表示源码、位置、解析结果或所属代码缺失
或不明确；必须把该证据缺口带入受影响的结论。

进行浏览器覆盖率分析时，按照
[runtime-coverage.md](runtime-coverage.md) 将最终模块 ID、模块拼接关系和 chunk 文件关联
起来。
