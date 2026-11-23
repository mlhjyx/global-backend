---
date: 2026-11-22
pr:
title: Contact enrichment safety first slice as a private candidate
---

- 起因：联系人补强缺少金额、准入、持久 step 索引与原结果恢复的安全纵切，且正式 SQL/RLS/CI 需留待原 E 正式窗口闭合。
- 改动：新增 canonical microusd 金额、冻结潜在调用计划、原子 Grant 准入、持久 step 索引、原结果冷读与显式恢复、同事务领域提交与 DSR 清理；新增 `GET /canonical-companies/:id/contact-enrichment-results` 系列只读/恢复路由（code-first），固定 page10 keyset 与 PREREQUISITE_ONLY 输出；新增 Hunter finder artifact schema 与三个验证 typed schema（millionverifier/emailable/zerobounce），复用原供应商解析器与 ToolBroker/BudgetStore；原 SMTP producer/consumer、旧四 artifact、旧 cents 与 paidCost 路径保持不变。
- 测试：私有纯/假端口层有真实 RED/GREEN 回执；私有 code-first 快照已由真实 AppModule preview 元数据导出生成（161 paths）并逐字复制到已批准合同路径；SQL/PG 仍 NOT_RUN。
- 未做：真实 SQL/迁移/RLS/CI 由原 E 正式窗口闭合；本私有候选不含数据库实证；原 158 paths/components 未改。
