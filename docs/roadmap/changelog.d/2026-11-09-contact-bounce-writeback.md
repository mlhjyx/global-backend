---
date: 2026-11-09
title: SMTP transport bounce and complaint writeback (engine side of the catch-all loop)
---

- 起因：P1-13 的数据回路——发送侧的硬退/软退/投诉必须回写引擎四态与抑制，否则灰度与发送门拿不到真实投递结果；策略表与发送门在 gain-saas lane 协调，本 PR 只交付引擎侧回写端点。
- 改动：
  - `POST /api/v1/contact-points/:pointId/bounce-events`（x-service-token，服务令牌守卫沿用 DNC 机制、错误码 bounce 语境）：`{workspaceId, event: hard_bounce|soft_bounce|complaint, messageId, smtpCode?, receivedAt?}`。
  - 语义（§2.3.6.6）：`hard_bounce` → INVALID（清 catch-all）+ suppression(email, bounce, PREFERENCE)；`soft_bounce` 同一地址累计第 3 次 → UNKNOWN + `next_reverify_at=+24h`（按计划显式降级，覆盖状态机的 VALID 保留语义，confidence −10）；`complaint` → 状态不变、confidence 归 0、证据 allowedActions 去 outreach、suppression(email, complaint, LEGAL)。
  - 每次回写落一行验证事件账（provider=smtp_transport、method=import、verdict invalid/unknown/blocked）与 `email.delivery` 证据（只有事件/响应码/messageId/时间，无 PII、dataClass=green）；`messageId` 幂等（唯一键命中返回 duplicate 且无副作用）。
  - 写入全部经唯一写入器（新增 `setEmailPointConfidence` 受控出口）；非 email 点 409；点不存在/跨租户 404（RLS）。
- 测试：服务口径 6 条（hard 的 INVALID+抑制+无 PII 证据、soft 未达阈值只记账、soft×3 降级+24h、complaint 的 confidence/LEGAL/动作收敛、duplicate 无副作用、404/409/400 词表）；守卫 3 条；OpenAPI 重导出（135 paths）；controller 拓扑已登记。
- 未做：SaaS SMTP transport 的调用接线与 S0–S4 灰度统计（gain-saas lane）；`suppression` 的派生投影对账（reconcileCanonicalSuppression）未在本事务触发，如需行/公司级联动由后续卡补。
