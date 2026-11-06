---
date: 2026-11-06
title: Give directory records ASCII-safe external ids for Chinese company names
---

- 起因：中文检索（#826）+ www 绑定（#827）发车后真实 run（bbe2d4f3）directory 抓到 1878 条记录仍全部 `PROVIDER_PAYLOAD_SCHEMA_INVALID`。定位：无 website 的记录 externalId 为 `directory:<源站>:<slug(公司名)>`，`slug` 保留汉字（`\p{L}`），而外部 ID 契约 `EXTERNAL_ID` 是纯 ASCII —— 中文名单条都无法通过载荷校验。
- 改动：`slug` 生成 ASCII 安全且确定的 id——ASCII 前缀 + 名称 sha256 前 16 位（同前缀中文名不碰撞、同一公司跨 run/跨页稳定）；纯拉丁名保持旧 slug 行为（≤60 字符截断）。映射时公司名做 NFKC+trim 归一——载荷契约要求 NFKC 恒等，中文名常用全角括号/全角字母（「ABB（中国）有限公司」），不归一会整条被拒。
- 测试：`directory.provider.spec` 中文名 externalId（ASCII/稳定/不碰撞/拉丁名不变）用例；`provider-raw-boundary.integration.spec` 中文名无 website 记录经 prepare 后 ACCEPTED。
- 未做：不放宽 `EXTERNAL_ID` 共享契约（其它 provider 与去重键不受影响）；存量被拒记录不回溯（验证 run 产物）。
