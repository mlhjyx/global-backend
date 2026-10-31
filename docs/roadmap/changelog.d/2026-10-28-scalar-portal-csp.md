---
date: 2026-10-28
title: Restore the self-hosted Scalar portal and turn it into documentation a person can actually read
---

- 起因：`/api/portal`（自托管 Scalar 文档门户，`321d90e5`，2026-07-06 加入）自 `a648706a`
  （2026-08-24，CodeQL 高危修复，给所有响应加上 helmet 的 CSP）起在浏览器里白屏。页面把
  整个 UI 内联成一段 `<script type="module">`，而全局 `script-src 'self'` 拒绝执行内联脚本；
  Chromium 实测控制台报 `Executing inline script violates the following Content Security
  Policy directive 'script-src 'self''`，`#app` 挂载点保持为空。同一批接口的 Swagger UI
  （`/api/docs`）走的是同源外链脚本，不受影响，所以这个问题两个月没有被发现。
- 改动：
  - **CSP**：`apps/api/src/main.ts` 在挂载 `/api/portal` 之前多挂一层路径级 helmet，只把这条
    文档路由的 `script-src` 放宽成 `'self' 'unsafe-inline' https://cdn.jsdelivr.net`，其余指令
    沿用 helmet 默认；`/api/docs` 和 `/api/v1/*` 的 CSP 一字未改。没有用 `unsafe-eval`：Scalar
    的打包产物里没有 `eval(` 或 `new Function(`。
  - **页面由两段脚本组成**（实测发现，原注释只说了「自托管」）：一段是页面内联的配置（整份
    OpenAPI 都嵌在里面，数据不出本机），另一段是浏览器从 `cdn.jsdelivr.net` 加载的 Scalar
    运行时库。只放行 `'unsafe-inline'` 时页面依旧白屏，控制台报的是 jsdelivr 那条被拦；两处
    都放行后才渲染出来（容器内无头 Chromium：0 条 CSP 违规、DOM 1.16 MB、左侧分组与首页
    说明齐全）。
  - **给人看的说明**：门户首页改为一段完整的接入说明（`apps/api/src/docs/portal-intro.ts`）——
    认证与 token 取法、scope↔角色映射、统一信封与游标分页、错误模型、幂等与乐观锁、哪些动作
    是异步、获客主链路的调用顺序、按域速览。文字只写代码里成立的事实，不写业务承诺。
  - **端点正文**：`apps/api/src/docs/operation-descriptions.ts` 集中维护 74 个端点的正文
    （其余 8 个原本就在控制器上有 `description`，保持不变），在 `buildOpenApi` 里只补空缺、
    不覆盖控制器上的值。
  - **分组**：12 个 tag 全部补上说明，并用 `x-tagGroups` 按接入顺序分组（获客主链路 / 运营与
    合规 / 建站 / 平台间通道 / 系统），不再按字母序排。
  - **契约落盘**：`packages/contracts/openapi/openapi.json` 用 `--export-openapi` 重新生成。
- 测试：
  - 新增 `apps/api/src/docs/operation-descriptions.spec.ts`（4 例）作为完整性闸门：每个操作必须
    有 summary 与正文、每个声明过的 tag 必须有说明、说明不能是占位符（<12 字）、描述表不能指向
    已不存在的操作。以后新增端点漏写说明会在 CI 里直接红，而不是等有人打开门户才发现。
  - CSP 用打补丁的源码在本地起 API（`:3113`）逐路由抓响应头核对：`/api/portal` 为
    `script-src 'self' 'unsafe-inline'`，`/api/docs` 与 `/api/v1/health` 仍是 `script-src 'self'`。
  - 全量单测在本机跑有 11 例失败，全部落在 `platform-revocation-*` 与 `temporal/*replay*` 两组，
    本机 `umask 0002`（CLAUDE.md 记录的该组 503 已知环境问题），与本改动无关；CI 为准。
- 未做：没有给 `/api/docs` 做同样的放宽（它是同源外链脚本，本来就能跑）；没有把这两条文档路由
  移出全局 helmet，那会连 `X-Frame-Options` 等头一起丢掉；没有给请求/响应 DTO 逐字段补
  `description`（那是下一层，字段说明目前只有部分 DTO 有）。
- 已知限制：门户的运行时库仍从公共 CDN 取，浏览器不能出网（纯内网/离线）时页面打不开；
  接口定义与数据本身始终在本地。彻底自托管要把 `@scalar/api-reference` 的 bundle 内置进镜像
  并改掉页面里的 import 地址，是另一件独立的事。
