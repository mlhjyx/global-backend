# 商业试点就绪度 · 封版⑦ 差距报告（活文档）

> 2026-07-11。回应 `release-plan.md` §1.5 封版定义 ⑦「真实企业样本 E2E/UAT」——对全漏斗做端到端就绪度评估，出诚实差距报告 + 试点最短路径。
> **方法与口径（透明）**：本报告基于**三类真实证据**综合，**未**重跑一次全新昂贵全漏斗（成本考量 + 各阶段已有真实数据验证）：① 输出契约代码（`lead-qualified-snapshot.ts` 等，SaaS 真实消费的合同）；② 仓内 **~30 个 `verify-*.mts` 真库真源逐阶段验证**（每个阶段已在真实数据上证明）；③ `status/current.md` + `release-plan.md` 权威真值。下次真实 UAT 需 A/SaaS 侧 UI + design partner 到位（见 ⑦⑧）。

## 0. 一句话结论

**工程六项收口全完成、9 组能力逐阶段真实数据可用；「能获客」现已端到端跑通证明**（`verify-e2e-acquisition-funnel.mts` 真库真 SMTP 全绿：同一 Lead 补全决策人可达邮箱后，队列 `needs_review → recommended` 翻转，唯一变量=可达性）。**离「可直接商业试点」还差三类：⑧ 输出被下游真实消费（卡 A/SaaS，非本仓）+ ⑦ 真实用户 UAT（需 A + design partner）+ 输出合同三处硬缺（权利/时效/成本未落进快照）。** 后者是**本仓可独立收口**的最短路径。

> **更新（2026-07-12，封版⑦ 机测半已补）**：新增全漏斗闭环 E2E `apps/api/scripts/verify-e2e-acquisition-funnel.mts`——首次端到端证明「对的公司 + 对的人 + 联系得上 → 推荐队列」。BEFORE：reachability=0、total=0.7249、`needs_review`（纯被可达门挡，非分不够）；开 email_guess 双闸 → 真 SMTP 猜测 `max.mustermann@osna-pumpen.de` 落 RISKY（诚实不谎报 VALID）→ AFTER：reachability=0.5、total=0.7999、`recommended`。快照携带决策人 ref（personal_data）+ reachability。真人 UAT（⑦ 另一半）仍需 A 的 UI + design partner。

## 1. 封版 checklist ①-⑧ 逐条裁决

| # | 封版项 | 裁决 | 证据 / 缺口 |
|---|---|---|---|
| ① | 输入 Company/Offering/ICP → 受控 Run 产出 Candidate Batch | ✅ 基本 | 三工作流（understanding/discovery/qualify）+ `run-backlog-sweep` 产出评分 leads，逐阶段真测（9 组）。**缺**：无「一个 Run → Candidate Batch」作为一等对象的端到端验收（现跨阶段+sweep 拼装）。 |
| ② | 每公司/联系人带 Canonical ID/来源/Evidence/**权利**/**时效**/验证/**成本**/未知项 | ◑ **部分（2 硬缺，权利已收）** | Canonical ID ✅、验证态 `has_verified_contact_point` ✅、来源/Evidence 走 `evidence_refs` 指针（受控 API 取详情，合规设计）◑。✅ **权利**（PR #72）：`storage_rights_decision` 已接 `DataRightsService` STORE 判定（具名决策人→red/国别→主体法域），且 `decide` **`!allowed` 一律不交棒**（挡禁联/Art.17 冻结竞态/跨境人审/无基础）——从「引擎建好线未接」到「接线且强制」。🔴 **时效** `valid_until` **恒 null**（v1 无鲜度模型，需 `field_evidence.fetchedAt`+TTL）；🔴 **成本** 快照**完全缺**（`usage_ledger` 无 per-lead/run 归集，需 schema 设计）。 |
| ③ | 候选带分解评分 + Reason Code | ✅ 基本 | `scores` 六维 + demand_proof + total ✅；`fitReasons`/`scoreDetail` 存在，走 `evidence_refs` 布尔 + 受控 API 取详情。◑ Reason Code 非内嵌（可接受，SaaS 拉取）。 |
| ④ | 可接受/拒绝/纠正 + 反馈进评测 + 不跨租户 | ◑ | `lead.decide`（accept/reject）+ RLS 不跨租户 ✅；**纠正 + 反馈进评测闭环**待核（Golden Set 在 R2）。 |
| ⑤ | 取消/重试/Partial/预算停止/降级/**公平扫描（无饿死）** | ◑ | 预算停止 ✅（收口② BudgetLedger reserve-settle 真拦截、截断→run PARTIAL）；降级 ✅（provider fail-safe 返空）；重试 ✅（Temporal）；Partial ✅。🟠 **公平扫描**=缺口#8 游标饿死**未根治**（`subjectsTruncated` 可观测但未根修，R2）。 |
| ⑥ | OpenAPI/事件/进度/RLS/删除/审计/测试/**SLO** | ◑ | OpenAPI ✅（收口④ 单一真值+CI 三门）· 事件 ✅（收口③ outbox 交付账本）· RLS ✅ · 删除 ✅（收口⑥ DSR 31 断言真库演练）· 审计 ✅（policy_decision_log/field_evidence）· 测试 ✅（547+ 单测）。🟠 **SLO 未定义/未监控** + **Run 进度可观测性**待补。 |
| ⑦ | 一组真实企业样本 E2E/UAT | ◑ **机测半已补** | 逐阶段真库真源 verify ✅（~30 脚本）；**全漏斗端到端机测 ✅ 新增**（`verify-e2e-acquisition-funnel.mts`：一条真 Lead 走「评分→补全→重评→快照」全链，证明可达性闭环把 `needs_review` 提升为 `recommended`）。**真实用户 UAT 仍未做**（需 A 的 UI + design partner，见 R2「2-3 家 Design Partner」）。 |
| ⑧ | 输出合同被下一能力**真实消费** | ✗ **阻塞（A）** | LeadQualified 经 outbox 真实**可交付**（收口③）✅，但**无消费方**——SaaS Campaign 未建（A/SaaS 侧）。**这是试点的真正门，非本仓能推。** |

## 2. 本次会话浮现的业务级真缺口（超出 checklist）

- 🔴 **「找到对的人」≠「联系得上」——身份源 GTM 价值目前受限**：本轮 3 个身份源（CH 董事 / EPO 发明人 / FR dirigeants）+ Impressum 找到**具名决策人，但无邮箱**（数据最小化 + 注册处不公示）→ Reachability=0 → **达不到 recommended 队列门（总分≥0.55 且 Reachability>0）**。即：我们能答「谁是决策人」，但这些人**暂不进推荐**、对客户暂无直接可达价值。**闭环**=把这些具名人喂 `email-guesser`（待办 1，已建）补可用邮箱——但自动路径需 per-tenant LIA（收口⑥ territory，未建），现仅按需端点路径可用。

## 3. 试点最短路径（按优先级 + 归属）

| 优先 | 动作 | 归属 | 量级 |
|---|---|---|---|
| ~~P0~~ ✅ | ~~把 `storage_rights_decision` 接进快照~~ **已交付（PR #72）**：接 `DataRightsService` STORE 判定 + `decide` `!allowed` 强制不交棒 + `DATA_PROCESSOR_JURISDICTION` 配置。对抗复审 2 HIGH 全修。 | C+Claude | ✅ 完成 |
| P0 | 快照补 **`valid_until`（鲜度=evidence freshness `field_evidence.fetchedAt`+TTL）+ 成本（usage_ledger 需先加 per-lead/run 归集）** → 封版② 余 2 硬缺 | C+Claude | 中（valid_until 小，cost 需 schema 设计） |
| P1 | 闭「对的人→联系得上」环：具名决策人→按需 `guessEmailsForCompany`→补可用邮箱→进 Reachability（让身份源真出价值）；自动路径待 per-tenant LIA | C+Claude | 中 |
| ~~P1~~ ✅ | ~~一个真·全漏斗 E2E 验收脚本~~ **已交付** `verify-e2e-acquisition-funnel.mts`（评分→补全→重评→快照全链，断言可达性闭环把 `needs_review`→`recommended`）——补 ⑦ 机测半 | C+Claude | ✅ 完成 |
| P2 | 缺口#8 游标公平根治（R2）+ SLO 定义/监控（⑥）| C+Claude | R2 |
| **门（非本仓）** | **⑧ SaaS Campaign 消费 LeadQualified + ⑦ design partner UAT**——试点真正的门 | A / SaaS | R0/R1 依赖主干 |

## 4. 诚实裁决

- **可直接商业试点？** 否。**但差距高度集中且已知**：真正的门是 **A/SaaS 侧**（消费方 + UAT UI），非本仓工程缺陷。
- **本仓自身**：六收口完成、逐阶段真实可用；**输出合同的「权利/时效/成本」三处硬缺是本仓唯一实质工程债**，且都可在数天内独立收口（其中 storage_rights 是「引擎已建、线未接」，性价比最高）。
- **不夸大**：身份源找到的具名决策人当前**多不可达、不进推荐**——这是设计诚实边界，闭环需邮箱发现 + per-tenant LIA。
