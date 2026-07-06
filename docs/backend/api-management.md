# 统一接口管理：结论与方案

## 一句话结论

**「一个接口地址后面跟参数」那种物理单端点是伪需求，不做。** 你的真实痛点是「接口分散、难管理、给前端一个稳定入口」——这是**门户**诉求，不是端点合并。

## 为什么不做单端点

我们是 code-first REST（`@nestjs/swagger` 装饰器生成 OpenAPI），已投入统一错误模型、游标分页、`Idempotency-Key`、`If-Match` 乐观锁、URI 版本——**这些全是 HTTP/REST 原生能力**。

- **GraphQL（单 `/graphql`）**：要在 schema 里把上面这些重造一遍，改造成本高、收益低。它的价值（前端自选字段、聚合多资源）在「38 端点 + 单前端 + 后端优先」阶段收益不明显，还引入 N+1、鉴权粒度、复杂度预算等新问题。
- **单 dispatcher（`/api?action=`）**：反模式——丢掉 HTTP 方法语义、网关/CDN 缓存、按路径限流鉴权，还要自己发明路由和文档，比 REST **更难**管理，与「想更好管理」背道而驰。

**取舍**：REST 保持多端点 + 加一个统一门户。除非未来出现多端异构前端且字段诉求差异极大，才评估叠加 `/graphql` 网关（而非推倒 REST）。

## Apifox：能用，但不首选

技术上完全够（导入 openapi.json、自动同步、Mock、协作、统一调试门户）。但：

- **数据合规软肋**：Apifox 是中国公司、SaaS 云数据存中国境内。我们做**出海 B2B**，门户里会含海外客户线索/联系人 PII——放中国境内公有云 = 数据出境/合规/客户信任风险（另有 2026-03 桌面端 CDN 供应链投毒前科）。

## 推荐方案（两条路，按合规偏好选）

- **路线 A · 自托管开源（默认、零合规顾虑）**：把 code-first 导出的 `openapi.json` 喂给 **Scalar**（可浏览 + try-it 调试）+ **Redoc**（阅读版，`contracts:docs` 已在用），数据全留自己手里。
- **路线 B · 商业协作平台（要 Mock/协作/权限/版本管理更省事）**：用 **Apidog**（Apifox 国际版，数据在 AWS 美东 / 支持完整私有化），**不是 Apifox**。定时从 URL 拉 `openapi.json` 同步，发布文档站给前端。

## 已落地

- ✅ **OpenAPI 单一事实源**：`node dist/main.js --export-openapi` 从装饰器生成 `packages/contracts/openapi/openapi.json`（38 端点）。code-first 装饰器为准，手写 `openapi.yaml` 降级为生成物。**消除了「双事实源」漂移隐患**。
- ✅ **前端护栏**：helmet + CORS 白名单（`CORS_ORIGINS`）+ trust proxy + 按 workspace 限流（`WsThrottlerGuard`，300/min）。

## 待做

- **P1**：出统一门户（路线 A：Scalar 挂 `/api/portal` 或独立静态站；给前端一个稳定 URL）。
- **P1**：CI 里 `openapi-typescript` 从 openapi.json 生成前端 TS 类型 + `oasdiff` 破坏性变更检查——串成「代码改 → 契约变 → 前端类型/入口自动更新」。
- **P2**：API 版本演进/废弃策略成文（加性走 v1 兼容、破坏性升 v2 双版本并行 + Deprecation/Sunset 头）。
