---
date: 2026-10-28
title: Let the self-hosted Scalar portal render again under the API's CSP
---

- 起因：`/api/portal`（自托管 Scalar 文档门户，`321d90e5`，2026-07-06 加入）自 `a648706a`
  （2026-08-24，CodeQL 高危修复，给所有响应加上 helmet 的 CSP）起在浏览器里白屏。页面把
  整个 UI 内联成一段 `<script type="module">`，而全局 `script-src 'self'` 拒绝执行内联脚本；
  Chromium 实测控制台报 `Executing inline script violates the following Content Security
  Policy directive 'script-src 'self''`，`#app` 挂载点保持为空。同一批接口的 Swagger UI
  （`/api/docs`）走的是同源外链脚本，不受影响，所以这个问题两个月没有被发现。
- 改动：`apps/api/src/main.ts` 在挂载 `/api/portal` 之前多挂一层路径级 helmet，只把这条
  文档路由的 `script-src` 放宽成 `'self' 'unsafe-inline'`，其余指令沿用 helmet 默认；
  `/api/docs` 和 `/api/v1/*` 的 CSP 一字未改。没有用 `unsafe-eval`：Scalar 的打包产物里
  没有 `eval(` 或 `new Function(`，不需要它。放宽范围仅限这一个静态文档页，不涉及任何
  数据接口。
- 测试：用打补丁的源码在本地起 API（`:3113`），逐路由抓响应头对比——`/api/portal` 变成
  `script-src 'self' 'unsafe-inline'`，`/api/docs` 与 `/api/v1/health` 仍是 `script-src
  'self'`。无新增自动化用例：`main.ts` 是引导脚本，import 即启动服务，仓库现有测试没有
  HTTP 层引导 app 的设施，硬加会引入一套新的测试骨架；这条改动的可验证面就是响应头，
  已在真进程上逐条核对。
- 未做：没有给 `/api/docs` 做同样的放宽（它是同源外链脚本，本来就能跑）；没有顺带把这两条
  文档路由移出全局 helmet，那会连 `X-Frame-Options` 等头一起丢掉；也没有加自动化响应头用例，
  原因见「测试」。
