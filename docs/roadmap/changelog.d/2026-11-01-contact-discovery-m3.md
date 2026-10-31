---
date: 2026-11-01
title: Give contact discovery its own budget account and enable run-time email completion (M3)
---

- 起因：产品负责人 2026-10-31 / 2026-11-01 拍板 D7 与 D3/D5——联系人是高成本步骤，必须有自己的额度、撞顶即停，不挤占 run 的查询/画像/评分预算；`email_guess`（SMTP 只握手、绝不投递）在 M3 启用，自动路径沿用全局 interim 合法性基础。
- 改动：
  - 新增 `execution-budget/contact-discovery-budget.ts`：按 run 派生 `contact.discovery:<runId>` 子账户；上限 = 每家公司 $0.0625（D5：≤6 页 × $0.01/页）× 本轮目标公司数（默认 8 家 ⇒ $0.50/run），用 run 账本剩余额的窗口差值计量，撞顶后不再启动任何 adapter 或下一家公司。
  - `discoverContactsCore` 接受可选子预算守卫：adapter 循环在子账户耗尽时停止并回报 `budgetTruncated`；HTTP `discover-contacts` 路径不传守卫，响应形状不变。
  - `discoverRunContacts` 派生子账户，`contacts.budgetTruncated`（沿用原口径，run 状态照旧降为 PARTIAL）之外新增 `contacts.contactBudget{accountKey,capMicrousd,spentMicrousd,exhausted}` 写入 run stats。
  - 新增 `discovery/contact-stage-email-guess.ts`：run 联系人阶段对缺邮箱的具名联系人做 SMTP 补全。双闸 = `data_provider.email_guess` ENABLED + `decision_maker` config 的部署级 lawful basis（全局 interim）；自动路径绝不传 `allowPersonalWithoutBasis`；每公司 ≤6 次探测（跨该公司全部联系人共享，新常量 `MAX_RUN_EMAIL_PROBES_PER_COMPANY`；单次调用仍受既有 `MAX_EMAIL_PROBE_CANDIDATES`=8 约束）；company/contact/email 三层禁联在每次探测前复核；结果只会落 RISKY 或（SMTP RCPT 接受且 catch-all 已证伪时）VALID，未证实绝不升 VALID；SMTP 回执按既有 domain-ack 纪律入账（原始键名避开 PII 提示词，否则 `validateDomainAckRawIdentity` 直接拒绝）。
  - run stats 新增 `contacts.emailGuess{attempted,probes,persisted,verified,risky,blocked}`。
- 测试：新增 3 个 spec（预算纯件 9、邮箱补全 9、run 联系人阶段 8），覆盖动态上限、撞顶即停、run 账户耗尽沿用口径、双闸、每公司 6 次探测、RISKY 不升 VALID、禁联与回执生产者/键名校验纪律；`gctl check` 全绿（docs·governance、prisma generate、contracts build、lint、build·typecheck、全量零容器单测）。
- 未做：真正的第二本账——workspace grant 的 authority 只允许开一本 `tool_budget_account`，且 `execution_budget_*` 是平台表；D7 目前是同一 run 账本内的派生记账键 + 硬性窗口计量。要账本级隔离，需要 gain-saas 以新 purpose（contact.discovery）签发 Grant，仓外另行推进。`email_guess` 的 `data_provider` 开关翻转、真实 SMTP 探测验证与部署不在本 PR。`contact_point` 没有 PROBABLE 状态，未证实猜测一律 RISKY。
