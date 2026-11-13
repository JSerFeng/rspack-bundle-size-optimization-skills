---
name: rspack-bundle-optimization
description: Optimize JavaScript emitted or loaded by Rspack, Rsbuild, or Rspeedy. Use for bundle-size audits, optimization changes, measured reports, tree-shaking, splitChunks, ECMAScript targets, or browser runtime-loading analysis.
---

# 分析已抓取的数据

按项目需要编写并接入数据收集插件，见 [data-capture](references/data-capture.md)。
逐个执行所有在下面列出的优化检查项目，必须全部项目都执行，如果有失败则尝试修复后重试。

## 真实启动项目

设法访问到项目中的 Rspack 配置，让 Rspack 可以在生产环境的条件下启动起来，可以关闭对产物无关的插件来验证，然后设法启动首屏，等待首屏的稳定，确保页面加载完成。

## 检查 Chunk 是否包含非必要 Module

由 SplitChunks 的 `name` 配置或 `webpackChunkName` 注释产生的 Chunk 可能是由多个 Chunk 的 Module 聚合，这种 Chunk 可能包含有不必要的体积加载。
设法访问到 Rspack 配置，给 Rspack 配置中增加一个插件访问所有的 Chunk Group 中所有的 chunks，收集到他们包含的所有 modules。
一个 Chunk Group 可能有多个 origins，每一个 origin 代表一个入口 module，如果是由 `name` 或 `webpackChunkName` 形成的 Chunk Group，他们的 origins 就可能有多个，分别分析各个 origin 的静态依赖 module，会分别形成不同的 module 图，页面真正需要的 module 取决于页面是从哪一个 origin 开始执行的。例如 entry 用 `import()` 依赖了 A、B，然后用 `webpackChunkName` 或者 `cacheGroup.name`，生成了一个包含 A、B 所有 modules 的 Chunk，假设从 A 开始执行的话，那 B 的 modules 就是非必要的，可以从 coverage 数据中看到所有被执行的 origin 对应的 module factory，然后就能发现哪些 chunk 的哪些 module 是某次启动实际需要的，哪些是不需要的，把这些收集起来报告给用户，可以让用户通过删掉 `__webpack_chunk_name__` 或 `cacheGroup.name` 来优化这部分。

实现上可以通过查询 coverage 所有的 origin 即可计算出非必要的 module，因为只需要扫描真正执行到的 origin 对应所有的静态依赖，和 chunk group 中的所有 chunk 取一个非即可找到所有的不必要 module。如果是非必要 module 那就可以找出原因，是 `__webpack_chunk_name__` 还是 `cacheGroup.name` 等配置导致，报告给用户。

## 分析 export usage

拿到页面执行的 coverage 后，分析各个模块的执行覆盖率情况，分析：

- 完全没有执行的 module
- 覆盖率较低的 module

可以按照覆盖率从低到高的顺序依次分析，优先处理完全没有执行的 module，然后再处理覆盖率较低的 module，用 cli 查询他的 export usage 数据，查询已使用的导出，然后查询对应的使用链，分析出是否是真的被使用。

除此以外还可以按照导出影响面范围排序依次分析，什么叫导出影响面，就是导出的使用链影响到的下游模块数量，将影响面大的模块全部分析完，结合 coverage 分析。

### 如何分析

在判断导出是否真的被使用，你需要去查询该导出所有的使用方，使用方可能会有非常多层级，每一层都要分析，是否当前层真的用到了对应的导出，怎样界定用到？以用户的视角去看，是用户的逻辑中就是想要以这样的方式去使用，而不是因为编译器或打包器的分析结果而误判、或是因为降级 polyfill 等代码会导致意外的编译器无法识别的访问等。

拿到 export usage 的 reference 中的每一层所有的 importer 都要分析，并且分析到每一条入边的根，所有根都分析好才算做这一个导出分析，要对所有可疑 module 的所有导出都进行分析。分析每一层的时候，你会得到 module 到 symbol 的信息，用 coverage 和 sourcemap 映射回源码，拿到这个源码然后去分析这个 symbol 是否是用户期望使用到的，才算做这一层的这一个 symbol 分析完。

观察是否有些导出的使用来自上游打包器对 `export * as ns from '@pkg'` 等 namespace 语义的提前物化。Rollup 可能生成 `Object.freeze({ __proto__: null, foo, bar })`，esbuild 可能生成结构化 export helper 加 getter map；Rspack 此时看到的是普通运行时对象，并且 Rspack 没有对象 tree shaking 能力，会导致整个包被使用，这种情况尝试获取该包的源码，从源码中引入对应导出也许有帮助。

### 分析数量

覆盖率很低的所有 module 都需要走完这一套分析，但优先级你可以自行决定。

如果有任何入边没分析完，遇到了错误，都需要报告出来给用户，需要用户协助的时候询问用户。

## 纯副作用引入

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
