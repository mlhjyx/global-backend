---
date: 2026-11-09
title: ZeroBounce arbiter and Truelist catch-all resolver adapters
---

- 起因：P1-05——验证瀑布的仲裁席（ZeroBounce）与 catch-all 解析席（Truelist）是计划 §2.3.5.1 的既定组成；#932 的瀑布第三个位置已留好但无适配器。
- 改动：
  - `zerobounce.provider.ts`：`/v2/validate` 客户端（env 凭据、8s abort、429/5xx/超时/畸形体统一 UNKNOWN 不抛、$0.0099/条按事件账计费）；`valid→VALID`、`invalid/spamtrap/abuse/do_not_mail→INVALID`、`catch-all→CATCH_ALL_RISKY·true_catch_all`、`unknown→UNKNOWN`（有效裁决 error=null 计费）、响应内 `error` 字段→UNKNOWN 不计费。入 provider 池作为**仲裁席**（第三次调用，仅在前两票未收敛时发生）。
  - `truelist.provider.ts`：`/api/v1/verify_inline` 客户端（Bearer 鉴权、$0.0014/条、enhanced 3 credits 以账单为准）；`ok→VALID`（enhanced 解析成功的地址级证据）、`email_invalid/disposable→INVALID`、`accept_all→CATCH_ALL_RISKY·true_catch_all`、`unknown→UNKNOWN`。**暂不入池**——瀑布的「主验 unknown/catch_all → 解析器 → 地址级 valid 需第二票」分支属于后续编排改造，按位置取席会把它误当仲裁席。
  - `data_provider.zerobounce` / `data_provider.truelist` seed（DISABLED）+ `source_policy.api.zerobounce.net` / `api.truelist.io` 登记 + 治理 registry 条目与生成文档（providers=26）。
- 测试：两套假 HTTP 契约测试（缺凭据/各映射态/未知态计费/429/5xx/超时/畸形体/Bearer 与 query 断言），零真实出网；池顺序断言含 ZeroBounce 仲裁席与 Truelist 不入池。
- 未做：Truelist 解析分支的瀑布编排接线（主验 unknown/catch_all → 解析器 → 第二票）；真实 key 到位后按供应商实际响应校准映射并跑 scorecard。
