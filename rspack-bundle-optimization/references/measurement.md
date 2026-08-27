# 测量

## 定义每个资源统计范围

每项结果都要注明编译器或输出目录，以及确切的资源集合：

- `总 JS`：单个 compiler 生成的全部 JavaScript；
- `入口初始资源`：Rspack 为具名入口标记为 initial 的 JavaScript；
- `浏览器观察到的路由资源`：在具名导航或交互期间额外请求的 JavaScript；

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

输出会记录产物体积、gzip 体积。

## 条件可比的生产环境

围绕目标变量保持以下条件不变：

- 入口、功能、依赖和 lockfile 状态；
- 无关的环境变量开关；
- 压缩、标识符混淆和模块拼接；
- 不相关的打包配置和运行时设置；
