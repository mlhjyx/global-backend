---
date: 2026-11-08
title: Keep directory records when detail_url fails the stable-URL contract
---

- 起因：run `bdb70e30` 的 69 条探针样本全部倒在 `normalize` 阶段——11467.com 名录详情链接含长数字 ID（≥7 位连续数字），被共享的 `CONTACT_LIKE_PHONE` 判为电话样文本，`isStableSafeHttpsUrl` 失败导致**整条公司记录**被拒（该轮 51 条拒绝属此类）。
- 改动：`directory.provider` 新增 `sanitizeDetailUrl`——剥离查询串/锚点后按 `isStableSafeHttpsUrl` 复检，仍不合规则丢弃 `detail_url` 字段而保留记录（该字段为可选富化项）。
- 测试：新增「映射 → 完整载荷契约校验」回流测试（长数字路径/查询串/干净 URL 三例），provider 与 schema 套件 16 例全绿。
- 未做：未放宽共享 `CONTACT_LIKE_PHONE` 正则（保持其它字段的防 PII 严格性）；历史已拒记录不回填，下一轮 run 自然重采。
