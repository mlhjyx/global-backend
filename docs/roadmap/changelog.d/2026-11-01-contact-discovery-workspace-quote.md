---
date: 2026-11-01
title: Quote on-demand contact discovery from per-company adapter ceilings
---

- 起因：M4（gain-saas 决策人卡片）需要工作空间管理员按需对单家公司触发联系人发现；G2（#570）起 workspace 技术报价对该操作 fail-closed（`EXECUTION_BUDGET_QUOTE_UNAVAILABLE`），SaaS 无法铸造一次性 Grant，发现入口不可用。产品负责人 2026-11-01 决定补 workspace 报价。
- 改动：
  - 为 `POST /api/v1/canonical-companies/{id}/discover-contacts` 新增 per-company 报价包络：按 6 个联系人适配器（decision_maker / public_web / companies_house / inpi_rne / social_presence / bigquery_patents）各自的物理上界枚举模型与工具配额；reservation cap = 260 cents（8 次抽人模型 × 2 wire × 15 cents + 8 页 `crawl4ai.fetch` + 12 次 `social.fetch`）。
  - 抽出共享上界常量（public_web 链接页 2、社媒 dork 4、每个候选社媒页抓取 3、Companies House 2 次调用），适配器与包络共用；非法边界仍 fail-closed。
  - 更新包络与报价 controller 的断言；重导出 OpenAPI 契约（无 drift）。
- 测试：包络 spec（精确模型/工具配额与 cap）、报价 controller spec（subject=company、purpose=discovery.run、cap `2600000`）；全量零容器单测。
- 未做：不改变 D5 的实际花费口径与 run 内 `contact.discovery` 子账户；不新增账本行/迁移；联系人仍不进公司级 reachability；discover 的 lawfulBasis、禁联与预算 Grant 一次性消费等既有 Gate 不变。
