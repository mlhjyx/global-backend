# M2 步 13 · S2 触达技能 + L2 审批落地设计（2026-11-08）

> 生命周期：`DRAFT`
> 生命周期依据：按 §0.6 任务启动门产出，待产品负责人过目批准后转 `APPROVED`；依据协调计划 §0.2 步 13（S2：`outreach.sequence_draft` / `engage.reply_classify`；审批门全绿、越权拒绝）、§17.8 S2 与 §17.6（ActionProposal→Policy→Approval→执行）、步 11 已批设计（受控邮件定稿）。主会话起草（2026-11-08）。
> 前置依赖：步 11 实施（发送通道/批次/退订/回复即停，m1-5 进行中）；S0/S1 技能运行时与 Golden Set 基建（已上线）；步 10 的 SAO/Outcome（p5 实施中）。

## 1. 背景与目标

- 步 11 交付「能安全地发信」的通道；步 13 交付「写好这封信 + 看懂回信」的两个 S2 技能，并把 L2 审批门从「批次级」补全为**逐动作的确定性策略 + 授权链**（未审批不发、越权拒绝为验收硬口径）。
- 两个技能都是 L1/L2 受控技能：起草=人类可改的草稿（humanGate），分类=只读建议；任何外部动作仍经审批与 ExecutionAuthorization。

### 目标（步 13 验收）

1. `outreach.sequence_draft`：基于 SAO/联系人/已批准卖家事实生成**有出处**的首触草稿（主题+正文），禁止无依据宣称；输出结构化 JSON（可回放）。
2. `engage.reply_classify`：对回复做意图分类（闭集枚举+置信度），驱动回复即停与步 10 Outcome 建议。
3. L2 审批门全绿：草稿→批→授权→发送链上每一外部动作有 ActionProposal 记录与确定性 Policy 检查；未审批/越权在负向测试中拒绝。

## 2. 承重假设（可证伪）

| # | 假设 | 若被证伪 |
| --- | --- | --- |
| A1 | 序列 v0=**单步首触**（与步 11 D-11-e 一致）；`sequence_draft` 的 schema 预留 `steps[]` 但 v0 恒 1 步 | 多步序列在回复分类稳定后扩（步 13.1） |
| A2 | 起草技能经 S0 注册（`model_task`，allowedTools=[]，模型策略可配）；输入接地=已批准 Claim/Offering + 检索片段（带出处），**不接地不产稿**（缺证据时输出「需要补充资料」并 humanGate） | 若产品要求允许弱接地，须在草稿上显式标注未证实声明并审批展示 |
| A3 | 回复分类=闭集 7 枚举：`POSITIVE / NEGATIVE / NEUTRAL / OUT_OF_OFFICE / UNSUBSCRIBE / BOUNCE / NEEDS_HUMAN`；`UNSUBSCRIBE` 自动触发退订流程，其余仅建议、人工确认落 Outcome | 枚举扩展走技能 schema 版本 |
| A4 | L2 的 ActionProposal 复用 `outreach_batch` 审批记录作为 Proposal 载体（不新建通用 proposal 表）；Policy 检查点=发送前确定性检查（consent/DNC/caps/window/scope）已在步 11 实现，步 13 补「越权拒绝」负向与审计对齐 | 若未来出现更多动作类型（发布/导出/CRM 写），再抽通用 ActionProposal 表（D-13-e） |

## 3. 技能一：`outreach.sequence_draft`（model task，humanGate）

- 输入（只读）：SAO 及其证据链摘要、联系人（姓名可得时）+ 其邮箱证据类型、卖家已批准 Claim/Offering（带 id）、campaign/计划意图（来自 M2.1）、jurisdiction（决定页脚必含元素：US→身份+地址+退订；DE→仅在 consent 场景使用且模板含撤回指引）。
- 输出 JSON：`{subject, body, language, groundedOn:[{claimId|offeringId|evidenceUrl}], jurisdictionFooter, editorNotes?}`。
- 硬校验（确定性）：必备元素齐全（署名/地址/退订按法域）、长度上限（subject≤90 字符、body≤2000 字符）、语言=收件人国别语言（DE→de 或 en 按联系人证据，US→en）、`groundedOn` 非空且引用 id 必须存在且为 APPROVED。
- 质量门：Golden Set 用例（步 13 自带 8–12 条：缺证据须拒稿、夸大口径禁出、页脚合规、语言正确）；发布层评测与 S1 同模式（eval_receipt）。
- 人工审批界面（最小）：草稿预览+编辑+批准（编辑即产生新版本，草稿版本不可变）——完整 Inbox 留步 14。

## 4. 技能二：`engage.reply_classify`（model task）

- 输入：回复原文（截断 4k）+ 上下文元（批次/联系人/法域）；输出：`{intent(7枚举), confidence 0-1, rationale≤200字, matchedSignals[]}`。
- 消费：`UNSUBSCRIBE`→直接触发步 11 退订流程（无需人工）；`BOUNCE`→信箱健康指标；`NEEDS_HUMAN`/低置信（<0.6）→ 入人工队列；其余→在 UI 建议 outcome（人工一键确认，写步 10 Outcome）。
- 负向：分类器不得自动产生 REPLIED 之外的 Outcome；不得把 AUTO_REPLY 当 POSITIVE（Golden Set 专项用例）。

## 5. L2 审批门（验收核心）

- 逐外部动作（=每封发送）前置条件集合（全部确定性、可审计）：①批次 APPROVED 且 revision hash 未变（M2.0 复用）；②ExecutionAuthorization 有效且 scope 含该收件人；③consent/DNC/caps/window 检查通过；④草稿版本=被批准版本（hash 比对）。
- 任一不满足 → 拒绝并落轨迹 `decision_type='outreach.send.gate'`，reason_code 闭集；**越权红线**：调用方试图发送 scope 外收件人/未批草稿 → 拒绝（负向测试固化）。
- 审计包：批次→批准→授权→每封发送的回执链可导出（ops）。

## 6. 数据与事件（增量）

- gain-saas：`outreach_draft`（batch/contact/版本/hash/groundedOn/编辑者）挂 step 11 的 batch；无新表若步 11 已含草稿集（按其实施对齐，冲突由主会话裁决）。
- 事件：`OutreachDraftApproved` / `OutreachReplyClassified`（消费方=步 12 归因与 ops 指标）；schema 版本化。
- 技能注册：两技能经 S0（skill_package/version + enablement；tenant-default：draft=enabled（内部无外发）、classify=enabled）。

## 7. 负向测试（必含）

1. 未接地（无 approved claims）起草 → 技能拒稿（`GROUNDING_REQUIRED`）；2. 草稿缺法域页脚 → 校验拒绝；3. 发送未批草稿/scope 外收件人 → 拒绝；4. 分类器把 `OUT_OF_OFFICE` 判 POSITIVE 的对抗样本 → Golden Set 红；5. 低置信 → 必须 NEEDS_HUMAN 不得静默；6. `UNSUBSCRIBE` 分类 → 退订生效再发被拒（与步 11 联合）；7. 跨租户草稿/分类查询 404。

## 8. 施工拆分（批准后）

1. **13-1（backend 技能包）**：两技能 SKILL.md+schema+validator+任务注册（S0 管线）+ Golden Set 用例与评测回执；
2. **13-2（gain-saas 草稿流）**：draft 存储/版本/hash + 最小审批界面（预览/编辑/批准）；
3. **13-3（L2 门与审计）**：逐封发送前四条件门 + 轨迹/审计包导出 + 越权负向；
4. **13-4（联调）**：E2E-M2.13：SAO→起草（接地）→批→发（受控）→模拟回复→分类→UNSUBSCRIBE 路径→退订生效；Golden Set 基线出数。

## 9. 决策点（请逐项确认）

| # | 决策 | 推荐 |
| --- | --- | --- |
| D-13-a | 序列 v0 单步首触（schema 预留 steps[]）；多步留 13.1 | 接受 |
| D-13-b | 起草不接地不产稿（缺证据即拒稿并提示补资料） | 接受 |
| D-13-c | 回复分类 7 枚举；UNSUBSCRIBE 自动、其余人工确认 | 接受 |
| D-13-d | 分类低置信（<0.6）一律 NEEDS_HUMAN，不得静默归类 | 接受 |
| D-13-e | L2 Proposal 载体复用 outreach_batch 审批记录（不建通用 ActionProposal 表）；未来多动作类型再抽通用层 | 接受 |
| D-13-f | 两技能 tenant-default=enabled（内部动作，无外发）；起草 humanGate 恒 true | 接受 |

## 10. 给产品负责人的说明

- **得到什么**：开发信不再靠人肉逐字写——技能从「你已批准的卖家事实」里接地起草（没证据就不写），你只需审；回信自动分类意图，「退订」自动生效，其它建议你一键确认成商机进展。
- **没改什么**：不放松任何发送前置条件（越权与未批一律拒）；单步序列；不接新外部系统。
- **风险与回退**：起草质量靠接地校验+人审+Golden Set 三层；技能可平台级停用（fail-closed）。
- **建议**：批准 D-13-a~f 按推荐值。实施以步 10/11 首版落地为前置（13-1 可先行）。
