---
name: rspack-bundle-optimization
description: Optimize JavaScript emitted or loaded by Rspack, Rsbuild, or Rspeedy. Use for bundle-size audits, tree shaking, splitChunks, ECMAScript targets, browser loading analysis, or FCP/LCP validation of bundle changes.
---

# 分析已抓取的数据

按项目需要编写并接入数据收集插件，见 [data-capture](references/data-capture.md)。
默认使用 Skill 自带的 `scripts/capture-plugin.cjs` 保存构建，`scripts/record.cjs` 连接 Chrome
录制 coverage，再由 `scripts/query.cjs index` 一步完成 sourcemap 分析和建库，并通过 `status`/`chunks`/`modules`/`module`/`source`/`refs`/`chain` 按需查询（详见 [query-cli.md](references/query-cli.md)）。
逐个执行所有在下面列出的优化检查项目，必须全部项目都执行，如果有失败则尝试修复后重试。

## 真实启动项目

设法访问到项目中的 Rspack 配置，让 Rspack 可以在生产环境的条件下启动起来（主要是 providedExports, usedExports, innerGraph 一定需要开启才能分析 export），但需要关闭 concatenateModules 配置，因为他会妨碍后续对 export usage 的分析，可以关闭其他对产物无关的插件来验证，然后设法启动首屏，等待首屏的稳定，确保页面加载完成。

改动可能影响首屏加载时，先在原生产构建上用 `scripts/validate.cjs` 保存 FCP/LCP 基线。改动后用相同生产配置重建，在同一页面和就绪条件下用 `--against` 复测。计时与 coverage 独立进行。若页面或基线不可用，仍可报告体积与归因结果，并说明首屏计时未验证。见[首屏计时验证](references/data-capture.md#首屏计时验证)。

## 检查 Chunk 是否包含非必要 Module

由 SplitChunks 的 `name` 配置或 `webpackChunkName` 注释产生的 Chunk 可能是由多个 Chunk 的 Module 聚合，这种 Chunk 可能包含有不必要的体积加载。
设法访问到 Rspack 配置，给 Rspack 配置中增加一个插件访问所有的 Chunk Group 中所有的 chunks，收集到他们包含的所有 modules。
一个 Chunk Group 可能有多个 origins，每一个 origin 代表一个入口 module，如果是由 `name` 或 `webpackChunkName` 形成的 Chunk Group，他们的 origins 就可能有多个，分别分析各个 origin 的静态依赖 module，会分别形成不同的 module 图，页面真正需要的 module 取决于页面是从哪一个 origin 开始执行的。例如 entry 用 `import()` 依赖了 A、B，然后用 `webpackChunkName` 或者 `cacheGroup.name`，生成了一个包含 A、B 所有 modules 的 Chunk，假设从 A 开始执行的话，那 B 的 modules 就是非必要的，可以从 coverage 数据中看到所有被执行的 origin 对应的 module factory，然后就能发现哪些 chunk 的哪些 module 是某次启动实际需要的，哪些是不需要的，把这些收集起来报告给用户，可以让用户通过删掉 `__webpack_chunk_name__` 或 `cacheGroup.name` 来优化这部分。

实现上可以直接运行 `scripts/query.cjs chunks --db <index.sqlite>` 识别标有 `[MULTI]` 的多 origin Chunk Group，再用 `chunks --group <groupId>` 查看每个 origin 的执行状态以及仅从“未执行 origin”静态可达的候选非必要 module。确认是非必要 module 后，再排查原因（如 `__webpack_chunk_name__` 或 `cacheGroup.name` 配置），报告给用户。

## 分析 export usage

拿到页面执行的 coverage 后，分析各个模块的执行覆盖率情况，分析：

- 完全没有执行的 module
- 覆盖率较低的 module

可以按照覆盖率从低到高的顺序依次分析，优先处理完全没有执行的 module，然后再处理覆盖率较低的 module，用 cli 查询他的 export usage 数据，查询已使用的导出，然后查询对应的使用链，分析出是否是真的被使用。

除此以外还可以按照导出影响面范围排序依次分析，什么叫导出影响面，就是导出的使用链影响到的下游模块数量，将影响面大的模块全部分析完，结合 coverage 分析。

### 如何分析

在判断导出是否真的被使用，你需要去查询该导出所有的使用方，使用方可能会有非常多层级，每一层都要分析，是否当前层真的用到了对应的导出，怎样界定用到？以用户的视角去看，是用户的逻辑中就是想要以这样的方式去使用，而不是因为编译器或打包器的分析结果而误判、或是因为降级 polyfill 等代码会导致意外的编译器无法识别的访问等。

拿到 export usage 的 reference 中的每一层所有的 importer 都要分析，并且分析到每一条入边的根，所有根都分析好才算做这一个导出分析，要对所有可疑 module 的所有导出都进行分析。分析每一层的时候，你会得到 module 到 symbol 的信息，用 coverage 和 sourcemap 映射回源码，拿到这个源码然后去分析这个 symbol 是否是用户期望使用到的，才算做这一层的这一个 symbol 分析完。

当某个导出的 originExport 为 null 时，有下面几种情况：
- 正常的模块级使用	比如顶层初始化调用，不依赖某个具名导出是否被使用
- 没有导出归属分析结果	比如 innerGraph 关闭，或该模块因 eval 退出分析
- 因潜在副作用而保留	即使没有具名导出使用，初始化中的调用仍可能需要保留
- 无法确定 export * 的导出名称	按整个转导出关系保守记录
- 转导出的所属模块关联缺失	找不到对应模块时的保守记录，属于需要排查的异常情况
那你就需要去找到对应的源码的位置，然后检查是否是用户预期的被使用。只有所有的 root importer 和每一层的源码全部都分析完，才算完成对这一个导出的分析。你需要对所有低覆盖率的模块的所有导出都进行类似的分析，并且分析的时候要确认也去看每一层 importer 的源码，确保每一层导出的使用情况全部都被彻底验证后才算单个 export 的完成，单个module的所有 export 都被分析完才算这一个 module 分析完。要对所有低覆盖率的module都进行分析。没有分析完就不要停下工作，不要提前报告用户说已完成。

### 分析边界

仅使用本 Skill 提供的采集、查询和分析工具。
不得自行编写或运行替代逐条源码分析的归类、评分、判定脚本。
不得根据导出名、函数名、关键词或语法节点匹配，每条引用是否符合业务预期，必须由 Agent 阅读实际源码、结合原生 exportUsageGraph 逐层判断，并说明证据与理由。批量查询、遍历数量、名称匹配和自动标签均不能代替这个过程。

### 分析数量

覆盖率很低的所有 module 都需要走完这一套分析，但优先级你可以自行决定。

如果有任何入边没分析完，遇到了错误，都需要报告出来给用户，需要用户协助的时候询问用户，但仍要继续剩下的分析。如果你想要优化某个 module，先不要停止当前的分析过程，记录下优化的思路和待处理的模块，待所有需要分析的 module 全部分析完成后再进行优化。最终要让所有低覆盖且占用体积较大的 module 都做完所有的分析，并记录下所有的优化思路，最后尝试一个一个去优化，列一个表格记录下所有的分析结果，和改动 diff。

## namespace star export

观察是否有些导出的使用来自上游打包器对 `export * as ns from '@pkg'` 等 namespace 语义的提前物化。Rollup 可能生成 `Object.freeze({ __proto__: null, foo, bar })`，esbuild 可能生成结构化 export helper 加 getter map；Rspack 此时看到的是普通运行时对象，并且 Rspack 没有对象 tree shaking 能力，会导致整个包被使用，这种情况尝试获取该包的源码，从源码中引入对应导出也许有帮助。


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

## 交付要求

需要向用户说明 coverage 每个模块的情况，包括哪些模块覆盖率低、哪些模块完全没有执行，以及每个模块的导出使用情况和分析结果。
然后你需要再次确认这些覆盖率低的所有 module 的所有使用的 export 是否全部通过 cli 查询到了各自的 root，并且完整确认了每一层的源代码，如果有任何还没有通过检查的 export，不能够完成你的任务，而是应该继续去查询，直到全部 export 都确实查询了源代码，并且确实每一层的使用方式都确认是满足用户预期的使用，才可以完成任务。

以及检查完整你记录的需要优化的模块是否真的全部优化完毕，如果没有也需要返工去检查，不断检查，直到所有记录的优化点都确认优化完成。

最终需要向用户交付一份完整的分析报告，包含每个模块的覆盖率、导出使用情况、分析过程、优化思路以及改动 diff。报告应清晰展示每个模块的分析结果和优化状态，确保用户能够理解每一项优化的依据和效果。

首屏优化同时报告生产 JS 体积变化、FCP/LCP 基线与改动后的中位数、样本和判定。任一 paint 回退时先排查再认定收益。对改动涉及的交互运行项目测试或手动验证。
