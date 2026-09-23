# 分析已抓取的数据

把已测量的资源统计范围转化为有因果解释、源码支撑。

使用 [measurement.md](measurement.md) 中的统计范围定义。

按项目需要编写并接入数据收集插件，见 [data-capture](data-capture.md)。
逐个执行所有在下面列出的优化检查项目，必须全部项目都执行，如果有失败则尝试修复后重试，如果仍然失败则记录失败原因：

## 检查 Chunk 是否包含非必要 Module

由 SplitChunks 的 `name` 配置或 `webpackChunkName` 注释产生的 Chunk 可能是由多个 Chunk 的 Module 聚合，这种 Chunk 可能包含有不必要的体积加载。设法访问到 Rspack 配置，给 Rspack 配置中增加一个插件访问所有的 Chunk Group 中所有的 chunks，收集到他们所有 modules。一个 Chunk Group 可能有多个 origins，每一个 origin 代表一个入口 module，如果是由 `name` 或 `webpackChunkName` 形成的 Chunk Group，他们的 origins 就可能有多个，分别分析各个 origin 所有静态依赖 module，然后看对应的 origin 造成的所有静态依赖 module，是否刚好等于该 chunk group 的所有 module，如果相等说明刚好是加载了需要的 module，反之则说明不同 origin 各有一些 unused modules 加载。

找出所有 unused modules 加载，随后分析是 splitChunks name 或 `webpackChunkName` 导致的还是其他，然后优化可以通过去掉对应的 name / `webpackChunkName` 来尝试优化的收益。

这是编译时分析；需要确认页面实际加载和执行情况时，按
[数据抓取中的浏览器运行数据说明](data-capture.md#浏览器运行数据按需) 补充验证。

## 分析 export usage

通过 rspack 内置的 RsdoctorPlugin 对外暴露的 export usage graph 数据分析产物导出，按照导出影响面范围排序依次分析，将影响面大的模块全部分析完。Rspack 目前缺乏一些分析能力，通过源码 https://github.com/web-infra-dev/rspack/ 的 inner_graph 和 side effect plugin 章节确定可以优化的语法和不能优化的语法。

除了通用的分析外，可以关注下很多导出往往是因为误判有副作用，或是被 loader transform 后变成无法分析的产物，例如 polyfill 后的 await import() 等等 polyfill 后的 syntax。
观察是否有些导出的使用来自上游打包器对 `export * as ns from '@pkg'` 等 namespace 语义的提前物化。Rollup 可能生成 `Object.freeze({ __proto__: null, foo, bar })`，esbuild 可能生成结构化 export helper 加 getter map；Rspack 此时看到的是普通运行时对象，并且 Rspack 没有对象 tree shaking 能力，会导致整个包被使用，这种情况尝试获取该包的源码，从源码中引入对应导出也许有帮助。

查看是否有模块是纯因为 side effects 而被引入，这种模块的 exports 都没有被 used 或者 used unknown，这种模块也许可以完全删除。

所有的分析要结合真实 export usage graph 的数据，数据会提供某模块的导出所有上游的分支，某个export fn被上游class用到，而上游 class 又被 上游实例化，都可以通过这个数据得知。分析的时候是直接去分析该模块的源码，分析 export 是否真的确实被导出。

分析出有未使用的被误判时，想办法解决，例如 `@__PURE__` `@__NO_SIDE_EFFECTS__` 或者 `pure_functions` 等等，如果没有合适的办法解决，也想办法验证解决后的收益。

## 语法降级造成的优化效果不佳

通过将 swc-loader 或 babel-loader 的 target 配置成最新的 ecma 版本（需要注意如果配置了 env，swc-loader 会忽略 target），然后执行一次正常的构建，构建后查看体积是否明显降低，如果降幅明显，则继续检查是否有 module 数量的降低，因为更高级别的 ecma 等级可能让某些语法不再被 bundler 视为有副作用。如果发现 module 数量有降低，则记录下所有减少的 module，然后通过上一步的 export 和源码信息分析是什么语法降级导致优化没有了。

重点检查 dynamic import：比较转换前后 `import()` 结果的消费方式，确认 namespace
成员读取是否变成编译器无法识别的普通对象访问。根据当前版本支持的语法或导出提示，
优先尝试局部源码修改；需要批量处理时，再由 agent 编写适合当前项目的 loader。
只有能确认完整使用的导出集合时才添加导出限制，namespace 作为完整对象传递或动态取值
时不能仅凭局部读取推断。对转换后的代码验证行为，并通过生产 A/B 构建确认收益。

提高 target 的实验用于定位原因。调查结束后恢复项目原本的 target，再优化调查出的
模块，并通过生产构建验证最终修改满足实际支持的运行环境。
