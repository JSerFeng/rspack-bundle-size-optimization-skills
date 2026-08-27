# 动态导入分析

Rspack 支持 tree shaking 下面的 dynamic import 场景：

- `const ns = await import('@pkg'); use(ns.foo)` 
- `import('@pkg').then((ns) => use(ns.foo));` 
- `const [ns1, { bar }] = await Promise.all([import('@pkg1'), import('@pkg2')]); use(ns1.foo, bar);`

## 为什么有些导入会一起加载

在磁盘源码和 loader 处理后源码中搜索 `webpackChunkName`、`rspackChunkName`、splitChunks cacheGroups 中的 name 配置，他们共用名称会合并成同一个 Chunk Group 节点；

## 降级后优化会失败

如果目标 target 不支持 async await 语法，则会将 `await import('@pkg')` 转换成 generator 语法或纯运行时的状态机，这两种都无法被 Rspack 优化，造成最后形成 namespace 使用，即整个 module 所有导出被使用。

这种情况可以给配置中加入对应优化 loader 参考 [scripts/dyn-imports-loader.js]，能直接分析出克优化的 dynamic imports，随后将分析出的导出直接通过magic comment 传给 Rspack，例如：

```js
const { foo, bar: localBar } = await import(
  /* rspackExports: ["foo", "bar"] */
  "@pkg"
);
```
