---
date: 2026-11-09
title: Third-party email verification adapter, vote policy and catch-all send tiers
---

- 起因：自建 SMTP 探查在反枚举（M365/GWS）、catch-all 与 25 端口限流下结构性拿不到 VALID，市场成熟的第三方验证 API 一个都没接入；catch-all 地址也没有分数分层与发送国家白名单。
- 改动：
  - `apps/api/src/enrichment/verification/`：`EmailVerificationProvider` 接口 + `MillionVerifierProvider`（fetch、env 凭据、8s 超时、429/5xx/超时/畸形体统一降级 UNKNOWN 且不抛）；结果映射四态与 0–100 基础分，`accept_all=true` 一律降为 CATCH_ALL_RISKY。
  - 验证投票策略 `resolveVerificationVotes`（双正规则：单验证器 positive 永不判 VALID；正负冲突判 UNKNOWN；accept_all 优先）与评分 `scoreEmailPoint`（基础分/一致性/pattern/供应商信心/90 天衰减/软退信/投诉）。
  - catch-all 发送分层 `catch-all-policy`：≥70 正常、40–69 灰度、<40 抑制；灰度白名单仅 US/FR（DE 永不进入），配置可从 env 覆盖。
  - `data_provider.millionverifier` seed（默认 DISABLED）+ `source_policy.api.millionverifier.com` 登记（未登记即 fail-closed）。
- 测试：假 HTTP fixture 契约测试（200/429/5xx/超时/畸形体/缺凭据）、投票矩阵 12 组组合、评分分量与分层边界值；治理 provider registry 条目同步。
- 未做：Emailable/Truelist/ZeroBounce 适配器与真实验证瀑布编排（P1-04/05/06 后续）；真实 key 到位后的 scorecard 验收。
