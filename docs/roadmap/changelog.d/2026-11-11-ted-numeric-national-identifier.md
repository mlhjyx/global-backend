---
date: 2026-11-11
title: DB 侧 Raw writer 闸门对齐 TED 纯数字国家税号——修复 run 4121e533 的 RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID
---

- 起因：#1000 在应用层对 TED 的 `identifier` / `attributes.ted.winner_identifier` 放行了纯数字国家税号（意大利 partita IVA 等，公司登记事实），但 Raw writer 的 **DB 侧**独立复核函数 `raw_source_ted_national_identifier_contact_valid_v1` 仍用「防电话 PII」守卫拒绝纯数字串。真实数据提交触发 `RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID`，executeQuery 事务失败、整轮 run FAILED（run 4121e533）。
- 改动：迁移 `20261110140000_ted_numeric_national_identifier` — `CREATE OR REPLACE` 该函数，放行 6–20 位纯数字（scheme 已带国别 `ted-natid:<iso2>`，不会跨法人串号）；其余文本仍必须通过 `raw_source_text_contact_safe_v2`（电话/邮箱/人名守卫对联系人字段不变）。函数 ACL 随 `CREATE OR REPLACE` 保留。
- 测试：真库事务内（BEGIN→替换→验证→ROLLBACK）——5 条真实 TED 记录（含纯数字税号）经应用层归一后全部通过 `raw_source_provider_payload_valid_v2('ted', …)`；电话形态（`+49 30 …`、含字母/非 ASCII 数字的伪标识）仍被拒；disposable 治理套件的既有负向用例不受影响。
- 未做：不动应用层规则（#1000 已合入）；不改其他 provider 的标识闸门。
