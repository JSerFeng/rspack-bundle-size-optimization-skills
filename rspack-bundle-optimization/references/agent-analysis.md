# 分析已抓取的数据

把已测量的资源统计范围转化为有因果解释、源码支撑。

使用 [measurement.md](measurement.md) 中的统计范围定义。

在 Rspack 配置中加入优化需要的数据收集插件，见 [data-capture](data-capture.md)。
逐个执行所有在下面列出的优化检查项目，必须全部项目都执行，如果有失败则尝试修复后重试，如果仍然失败则记录失败原因：

## 检查 Chunk 是否包含非必要 Module

由 SplitChunks 的 `name` 配置或 `webpackChunkName` 注释产生的 Chunk 可能是由多个 Chunk 的 Module 聚合，这种 Chunk 可能包含有不必要的体积加载。设法访问到 Rspack 配置，给 Rspack 配置中增加一个插件访问所有的 Chunk Group 中所有的 chunks，收集到他们所有 modules。一个 Chunk Group 可能有多个 origins，每一个 origin 代表一个入口 module，如果是由 `name` 或 `webpackChunkName` 形成的 Chunk Group，他们的 origins 就可能有多个，分别分析各个 origin 所有静态依赖 module，然后看对应的 origin 造成的所有静态依赖 module，是否刚好等于该 chunk group 的所有 module，如果相等说明刚好是加载了需要的 module，反之则说明不同 origin 各有一些 unused modules 加载。

找出所有 unused modules 加载，随后分析是 splitChunks name 或 `webpackChunkName` 导致的还是其他，然后优化可以通过去掉对应的 name / `webpackChunkName` 来尝试优化的收益。

这个是编译时分析的，真实情况还需要参考下面的 coverage 检查。

## 通过追踪运行时的 coverage 来检查未使用代码

按照 [runtime-coverage.md](runtime-coverage.md#校验采集结果) 校验运行时产物。对每个重要的
已加载资源或生成的模块包装函数，建立以下关联：

1. 浏览器 URL 和网络请求发起方；
2. 对应的输出资源、chunk、chunk group、入口或异步根节点；
3. 对应的 splitChunks 规则，可以通过 chunk.chunkReason 查到；
4. 发起导入的模块及源码中的加载边界；
5. 完整的模块源码和使用方源码；

分析网页的首屏 url，然后打开页面执行，分析每一个 chunk 运行后 coverage，判断是否有 module 完全未执行而依然存在于首屏。如果发现则列出，并且列出是为什么在首屏，很有可能是 splitChunks name 配置或 webpackChunkName 导致与其他 chunk modules 进行了聚合。

## 检查使用的所有导出

对于重要的提供方或导出项，提取每一条匹配边：

```bash
node <skill>/scripts/extract-export-usage-context.cjs \
  --dir <capture> \
  --project-root <audited-package-root> \
  --target "provider/package/path.js" \
  --export "exportName" \
  --out <run>/notes/export-context.json
```

分析该 export usage graph，其中包含了每一个 module 每一个 export 的传播路径。按照影响范围排序，优先处理影响范围大的 export，影响范围定义为：该 export 造成多少 module 数量被判定为使用因此被打包进产物。

分析副作用和导出使用情况时，应查看完整的磁盘源码、loader 处理后的源码（可以从 rspack 插件中获取到）、使用方源码以及
最近的 `package.json`。重点关注顶层调用、赋值、语法降级后造成了副作用、worker 初始化、仅为执行副作用的导入。分析出该 export 被使用到底是因为真的是用户实现所必需的，还是因为降级或其他原因意外导致被使用的。

然后再重点查看由 namespace 使用引入的 module，很多时候都是因为语法降级，polyfill 等原因被视为使用。Rspack 支持 `export * from '@pkg'` 的优化，重导出能找到 root 使用的是什么导出，从而优化，但如果 barrel file 中还同时包含 `export * from 'unknown-exports-module'`，其中 `unknonw-exports-module` 的 exports type 是 unknown，那么这种情况难以优化，会造成 @pkg 的 namespace 被视为使用到。

还要重点观察没有任何导出被使用，但仍然存在产物中的，这部分很大概率是由于被判定成了包含副作用，重点检查这部分包的描述文件（package.json）中是否包含了 esm 和 cjs 两个入口，以及 sideEffects 是否写对。

总之 Export usage graph 是优化重点，要每一条都真的通过源码和转换后的源码分析。

## 语法降级造成的优化效果不佳

通过将 swc-loader 或 babel-loader 的 target 配置成最新的 ecma 版本（需要注意如果配置了 env，swc-loader 会忽略 target），然后执行一次正常的构建，构建后查看体积是否明显降低，如果降幅明显，则继续检查是否有 module 数量的降低，因为更高级别的 ecma 等级可能让某些语法不再被 bundler 视为有副作用。如果发现 module 数量有降低，则记录下所有减少的 module，然后通过上一步的 export 和源码信息分析是什么语法降级导致优化没有了。

其中最有可能发生的是 dynamic import 的优化失效，见
[references/dynamic-imports.md](dynamic-imports.md)。
