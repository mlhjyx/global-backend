---
date: 2026-11-09
title: Emailable as the second verification vote
---

- 起因：双正规则（单验证器永不判 VALID）需要第二家独立验证器；P1-04 的验证瀑布里 Emailable 是官方指定的「二次确认」票。
- 改动：
  - `apps/api/src/enrichment/verification/emailable.provider.ts`：`EmailableProvider`（GET `/v1/verify`，env 凭据，8s 超时，429/5xx/超时/畸形体统一降级 UNKNOWN 且不抛，$0.0076/条按事件账计费）。
  - 映射：`deliverable→VALID`（只有 `accept_all=false` 才判 VALID，缺字段保守进 catch-all 层）、`undeliverable/disposable→INVALID`、`risky→CATCH_ALL_RISKY·true_catch_all`（accept_all=true）或 `UNKNOWN`（否则，risky 不是地址级证据）、`unknown→UNKNOWN`（有效裁决、error=null、按次计费）；供应商自带 score 留痕到 detail，基础分用 scoreEmailPoint 统一口径。
  - `data_provider.emailable` seed（默认 DISABLED）+ `source_policy.api.emailable.com` 登记 + 治理 registry 条目与生成文档。
- 测试：假 HTTP 契约测试（缺凭据/200 deliverable/unknown/429/5xx/超时/畸形体、accept_all 三态、risky 分流、env 非法回退），零真实出网。
- 未做：Truelist enhanced catch-all 解析与 ZeroBounce 仲裁（P1-05）；把两家验证器编排成验证瀑布并接入再验证/发现路径（P1-06，当前 sweep 仍只走 MillionVerifier）。
