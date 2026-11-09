---
date: 2026-11-09
title: Contact eligibility endpoint for the SaaS sending gate (engine side)
---

- 起因：P1-16——gain-saas 发送门只查同意/法域/DNC，不知道引擎侧 `contact_point` 是 VALID 还是 RISKY；人工把 RISKY 邮箱填进草稿即可绕过。发送开关关闭期间风险为零，开启前必须修掉。SaaS 侧接线（DNC 之前插入检查、引擎不可达 fail closed）由 gain-saas 实现，本 PR 只交付引擎侧事实源。
- 改动：
  - `POST /api/v1/outreach/contact-eligibility`（服务令牌，x-service-token，复用 DNC 的令牌机制与恒定时间比较；错误码换成 eligibility 语境）：`{workspaceId, emails≤50}` → `{results:[{emailHash, found, state, score, allowedActions, catchAllPolicy}]}`。
  - 匹配口径与写入器一致：规范化 → 确定性 `encryptPii` → 密文等值（原始 SELECT，PII 扩展的 `where.value` 加密只覆盖字符串标量、不覆盖 `in` 数组；RLS 强制租户隔离）；同一邮箱多条点取最强状态（VALID > CATCH_ALL_RISKY > UNKNOWN > INVALID）；未找到 `found=false, state=UNKNOWN`（调用方 fail closed）。
  - `catchAllPolicy`：灰度策略表（P1-13）未落地 → 恒 `mode=OFF, allowed=false`（策略不存在 = 一律拒发），随附 score 档位。
  - 令牌守卫重构：`OutreachDncServiceTokenGuard` 的四个错误码/文案字段改为可覆盖，新增 `ContactEligibilityServiceTokenGuard` 子类；OpenAPI 契约重导出（新增 operation，summary/description 齐备）并加契约钉测试。
- 测试：服务口径 7 条（VALID/最强状态/CATCH_ALL_RISKY 策略/未找到/规范化去重/400 词表）；守卫 3 条（503/403/放行）；OpenAPI 契约钉 3 条；DNC 既有守卫用例保持全绿。
- 未做：SaaS 侧 `eligibility()` 接线与 G8 六条负向/正向集成测试（gain-saas lane）；`catch_all_send_policy` 表与 SHADOW/LIMITED 模式（P1-13）；发送批次记录 `contactStateAtSend`（SaaS 侧）。
