---
date: 2026-11-02
title: Add named decision makers to the weekly report CSV
---

- 起因：联系人挖掘 M4 的验收要求周报 CSV 含「联系人与状态」；BI-22 周报原先只导出公司级联系路径，从不读取 `canonical_contact`/`contact_point`。
- 改动：
  - `WEEKLY_REPORT_COLUMNS` 在「联系路径」后新增「决策人（联系人 / 联系方式 / 状态）」列；每人输出姓名（职务 · 部门）与邮箱/电话/LinkedIn 的原始验证状态（VALID/RISKY/INVALID/UNVERIFIED），每行最多 5 人、每人 3 个联系方式、整格 2000 字符封顶。
  - 周报读取公司具名决策人（`canonical_contact` + `contact_point`）与联系方式状态；导出前按 workspace 的 email/domain 禁联过滤，且只在 DataRights EXPORT 允许的行上写入。
  - 反馈 CSV 解析按表头取列，新列不影响回传。
- 测试：row spec（单元格格式与状态照实）、service spec（导出决策人、过滤禁联邮箱）；全量零容器单测。
- 未做：不在 CSV 中输出证据 URL/时间或 `allowedActions`；不改周报的 DataRights 规则与 withheld 口径；不读 `field_evidence` 的明文值（只读联系人/联系方式表）。
