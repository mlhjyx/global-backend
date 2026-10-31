---
date: 2026-10-31
title: Discover named contacts inside a discovery run
---

- 起因：获客主链能判站、画像、评分，但发现 run 的五个阶段从不调用联系人发现——`canonical_contact` 与 `contact_point` 一直是 0 行，客户只能看到公司级询盘表单，拿不到具体的人和联系方式（2026-10-31 设计稿 §一）。
- 改动：
  - `discovery.service.ts` 把「加载公司 → 多适配器 fan-out → 落库与证据」抽成共享核心 `discovery/contact-discovery-core.ts`；HTTP 端点（消费 Grant + 调用方 lawful basis）与新的 run 活动复用同一核心，落库语义与去重（`resolvePersonIdentity`）完全一致。
  - 新活动 `discoverRunContacts`：信号阶段之后，对本 run `fit=match` 的公司按分数取 Top 8（上限 25），依次跑已启用的联系人适配器（官网 `decision_maker`、Companies House、INPI RNE 等）；**无部署级 lawful basis 时 fail-closed 返回 skipped**（读 `decision_maker` provider 的 `config.lawfulBasis`，沿用既有 interim 口径）；单家失败不阻断其余，预算耗尽即停。
  - `discovery.workflow.ts` 新 patch `discovery-run-contacts-v1` 守卫该阶段（旧历史重放走原命令序列）；stats 新增 `contacts:{companies,people,emails,phones,skipped,reason?,failed?,budgetTruncated}`，预算截断计入 `budgetTruncated` → run 至少 PARTIAL。
- 测试：`discovery.activities.spec.ts` 新增无 lawful basis 时 fail-closed；`workspace-authority.workflow.spec.ts` 新增「信号后调用并记录 stats」「无 patch 的旧历史不调用且不写 stats」「预算耗尽 → PARTIAL」三例；相关三套 387+ 例全绿。
- 未做：前端入口（gain-saas 的发现/验证按钮）、社媒适配器（设计稿 M2）、邮箱猜测开关（M3，默认仍 DISABLED）；`decision_maker` 的 lawful basis 需在部署配置里写入后才生效。
