---
date: 2026-11-26
pr: TBD
title: "feat(shared-facts): 落地 ADR-003 共享绿色企业事实层与 30 天跨租户撞单冷却"
---

- 起因：各租户在各自 RLS 空间内对同一批欧美公开大买家重复抓取、重复画像，造成 HTTP/Crawl4AI 耗时与算力浪费；同时缺少跨租户 30 天撞单提示机制，且必须严格守住 ADR-003 零自然人 PII、零租户私域外泄与 `imported_buyer` 绝不入共享层的合规红线。
- 改动：
  1. 新增 `apps/api/src/shared-facts/green-company-fact.ts`：定义 ADR-003 Layer 1 零 PII 绿色企业事实契约与净化器（结构性剥离人名/个人邮箱/领英 `/in/` 链接/`workspaceId`/整页原文，硬拦截 `imported_buyer` 与私域导入来源，仅留存规范化域名、法定名、国家、客观贸易角色、派生短摘要、严格职能前缀同域邮箱、总机、询盘表单、公司领英 `/company/`、产品品类与 14–30 天 TTL，并提供读写双边界洁净断言 `assertGreenCompanyFactClean`）；
  2. 新增 `apps/api/src/shared-facts/domain-cooldown.service.ts`：实现 30 天跨租户撞单冷却服务，使用独立秘密 pepper 的 `HMAC-SHA256` 键（`{global:p3:domain-cooldown:<hmac>}`，绝不使用无盐 SHA-256）与按域不可关联的租户触达 HMAC 成员，经 Redis ZSET 滑动窗口（带内存回退与 Redis 不可用安全降级）返回匿名聚合提示 `{ cooledDown, distinctWorkspaces30d, retryAfterDays, advisoryOnly }`，绝不泄露触达租户身份；
  3. 新增 `apps/api/src/shared-facts/shared-green-fact.store.ts`（Redis + 可插拔 `SharedFactRepository` 端口，预留后续迁入 `platform_shared` PG schema）及 `apps/api/src/discovery/streaming/shared-facts-hook.ts`（受 `ADR003_SHARED_GREEN_FACTS=on|readonly|off` 门控，默认安全关闭）；
  4. 将共享事实层与撞单冷却接入方案 B L0/L1 流式发现（`discovery.streaming.activities.ts` 与 `streaming-progress.ts`）：L1 命中未过期绿色事实时直接复用免重抓（0 HTTP/Crawl4AI 调用），未命中抓取后经净化器回写共享层（DB 与净化器双重拦截 `imported_buyer` 绝不回写），L0/L1 标注冷却提示并在 `l1ExtractFit` 投影向后兼容的可选计数 `sharedFactHits` / `cooldownFlagged`（G16 基线保持零新增边、零漂移）。
- 测试：完成 `green-company-fact`、`shared-green-fact.store`、`domain-cooldown.service`、`shared-facts-hook`、`streaming-progress`、`discovery.streaming.activities` 全部单测，以及 `@global/db generate`、`@global/contracts build`、`@global/api build`、G9、G16、环境变量一致策略、Copy 指纹、文档漂移、`docs:verify` 与 `gitleaks` 扫描。
- 未做：零 `schema.prisma` 迁移与零 `openapi.json` 变更；`platform_shared` 独立 PG schema 持久化与现网容器开启 `ADR003_SHARED_GREEN_FACTS=on` 实测留待后续上线窗口推进。
