# 测量

## 定义每个资源统计范围

每项结果都要注明编译器或输出目录，以及确切的资源集合：

- `全部输出`：单个编译器生成的全部所选 JavaScript；
- `HTML 请求的初始资源`：初始文档请求的 JavaScript，包括相关的 preload 和
  modulepreload 请求；
- `入口初始资源`：Rspack 为具名入口标记为 initial 的 JavaScript；
- `静态路由组`：具名路由或异步 chunk group 中的 JavaScript；
- `浏览器观察到的路由资源`：在具名导航或交互期间额外请求的 JavaScript；
- 由明确清单和排除规则定义的应用专属集合。

HTML 请求的初始集合和入口初始集合可能不同，因此两者都与问题相关时应分别报告。每个统计
范围内，共享资源只计算一次。编译器和输出目录必须相互隔离；只有当不重叠资源的项目总和能
回答用户问题时，才创建项目级汇总。

在测量记录中保留纳入统计的资源名称。静态路由组使用编译器数据，浏览器观察到的路由加载
使用浏览器网络数据。

## 采集测量数据

通过明确的资源清单或正则表达式进行测量：

```bash
node <skill>/scripts/measure-assets.cjs \
  --dir <unchanged-dist> \
  --manifest <app-js-assets.json> \
  --run-id <run-id> \
  --label unchanged-app-js \
  --out <run>/unchanged-app-js-measurement.json
```

输出会记录标准化名称、SHA-256、原始字节数、确定性的 level-9 gzip 字节数、总计以及准确的
纳入规则。

## 对比

```bash
node <skill>/scripts/measure-assets.cjs compare \
  --baseline <run>/unchanged-app-js-measurement.json \
  --experiment <run>/changed-app-js-measurement.json \
  --out <run>/app-js-comparison.json
```

`--baseline` 和 `--experiment` 是命令行选项名称。在分析说明中，应称为未修改的生产构建和
修改后的生产构建。对比记录包含总差值以及新增、删除和发生变化的资源。

完整资源的原始字节总量和 gzip 总量是精确值。模块和包的明细仅用于确定诊断优先级：注明
大小数据来源，统计每一份输出副本，按解析后的根目录和版本对包分组，并把共享代码或模块
拼接后的归因标为近似值。只有大小口径相同的排序才可互相比较。

## 条件可比的生产环境

围绕目标变量保持以下条件不变：

- 入口、功能、依赖和 lockfile 状态；
- 无关的环境变量开关；
- 压缩、标识符混淆和模块拼接；
- splitChunks 和运行时设置；
- 资源纳入规则。

以原始字节数作为主要包体积指标，gzip 作为次要指标。请求数、初始或路由字节数、缓存行为、
CSS 和具名性能指标都应作为独立结果报告。

## 证据门槛

只有目标统计范围内、条件可比的生产完整资源差异，且有输出产物解释和适用的正确性检查
支撑，才能确认节省。源码大小、loader 处理后源码大小、Stats 模块大小、production-debug
输出和逐模块 gzip 归因都只能作为诊断或估算证据。面向用户的速度结论还必须有相同条件下
测得的具名性能指标。
