---
date: 2026-11-09
title: Contact weekly report script, snapshot table and paused Schedule (P1-17)
---

- 起因：P1-17（G10 观测）——§2.3.12 的周报 + 三条告警需要可复算的口径与每周落库的快照；「连续 2 周下降」只有留痕才能判定。
- 改动：
  - `enrichment/metrics/contact-metrics.ts`：周报计算层（只读 SQL，可注入 runner）——email_state_coverage、valid_email_company_coverage、enrichment_hit_rate（按 provider）、verification_valid_rate（按 provider）、verification_disagreement_rate、verification_error_rate、catch_all_share、cost_per_valid_email、reverify_flip_rate；发送侧三条（hard_bounce/complaint/send_gate_block_rate）分母在 gain-saas，如实输出绝对计数并标记 unavailable，绝不臆造发送量。分母为 0 一律 `null`（「没有样本」≠「0%」）。
  - 三条告警（`evaluateContactWeeklyAlerts`，纯函数）：VALID 公司覆盖率连续 2 周下降 >3pp（需 3 周序列，缺则 INSUFFICIENT_DATA）、验证错误率 >20%、每 VALID 成本 >$0.09（1.5×$0.06）；Markdown 周报渲染同文件。
  - 迁移 `20261109200000_contact_metrics_snapshot` + `ContactMetricsSnapshot` 模型：平台级运营表（RLS 按 workspace_id 兜底、app_user 零权限、权限清单登记空数组），每周一行窗口+指标+告警 JSON。
  - `scripts/contact-weekly-report.mts`：CLI（`--since/--until/--workspace/--out/--json/--no-persist`，有 FIRING 退出码 10），与 Schedule 共用计算层。
  - `CONTACT_WEEKLY_REPORT` Schedule 骨架：workflow/activity + ensure-schedules 注册（**paused**，默认 168h）+ worker/两个 workflow barrel/code-intelligence runtime-evidence 与契约图（schedules=14）。
- 测试：指标映射（BigInt→number、分母 0→null、租户参数进 SQL）、三条告警的 OK/FIRING/INSUFFICIENT_DATA、Markdown 渲染、CLI 参数与执行接线（默认窗口/--no-persist/非法窗口）、ensure-schedules（14 个 schedule、新条目 paused、168h 间隔）；temporal+enrichment 全套 1639 通过；code-intelligence 59 通过；漂移门全链重放零未登记差异；G5 RLS 目录门通过（172 表）。
- 未做：告警通知渠道接线（当前进周报正文与快照；看板/渠道由后续切片接）；发送侧三条指标的 SaaS 报告接口；真实数据上的周报需要运营连接跑一轮核对口径后再启用 Schedule（用户决定）。
