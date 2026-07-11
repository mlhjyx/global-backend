# ADR/PDR 注册表（唯一决策真值）

> 2026-07-10 v2（合流定稿）。PRD v3.0 内两套同号 ADR（§11.6 的 001-018 与 §11.20 的 001-012 含义冲突）**整体作废**；交付包附录 D 清单已并入（其 ADR-002→本 ADR-011、ADR-012→本 ADR-012、ADR-005 水位公平性→并入本 ADR-008、ADR-011 AiToEarn/Chatwoot ACL→SaaS 侧随 product-scope 附录 A，其余主题一一对应）。ADR 增多后再拆单文件。
> 状态词表（与需求状态分开，避免词汇污染）：PROPOSED / ACCEPTED / SUPERSEDED。以下均 ACCEPTED（2026-07-10 会话拍板/收敛），标注 ⚠ 者待 A/B 会签。

## PDR（产品决策）

| ID | 决策 | 状态 |
|---|---|---|
| PDR-001 | 对象词典统一：Candidate（机器候选）→ Lead（Company×ICP 资格对象）→ Opportunity 单一聚合（CANDIDATE/QGO/SAO/CLOSED 为状态）→ CommercialOutcome | ACCEPTED ⚠待 A/B 会签 |
| PDR-002 | 业务层级 Goal → GrowthInitiative → Campaign → Run/Batch/Job；Campaign 不承担战略/研究/长期商机（=交付包 TA-003） | ACCEPTED ⚠待 A/B 会签 |
| PDR-003 | 能力顺序：买家智能封版 → Campaign 控制面 → 受控邮件 → Inbox/QGO → Outcome/归因 → 内容/视频/多平台（纵向闭环，不做全域 Alpha；=交付包 TA-010/011） | ACCEPTED |

## ADR（架构决策）

1. **ADR-001 SCOPE 本仓边界**：本后端止于 `QualifiedLeadHandoff`；SaaS 拥有身份、Campaign、发送、Inbox、Opportunity(QGO/SAO)、归因。成交结果只回流为训练/评估标签。存储侧合规（Data Rights/PII/保留/Suppression/DSR）留本仓。**边界变更唯一途径=修订本 ADR+三方书面确认。**
2. **ADR-002 MODULAR-MONOLITH**：单体单库继续；bounded context+依赖方向隔离；进程按资源类拆，不做业务微服务化。
3. **ADR-003 DATA-PLANES**：四平面——Control Plane（SaaS）/平台共享绿色事实层（无 RLS、零个人数据）/租户 RLS Growth Plane/PII-rights zone（列级加密或 Tokenization、保留期、删除链）；DB 角色最小权限拆分；逻辑 Schema 写入 Owner 分区为演进方向。
4. **ADR-004 CANDIDATE**：Fit、DemandProof、Score、stage 水位**必须属于 ICP×Organization（CandidateAssessment）**，禁止挂 CanonicalCompany；canonical_company 现有 fitVerdict/水位列迁移后删除。
5. **ADR-005 EXECUTION-GATE**：任何网络/模型/provider 调用必须携带 `ExecutionContext(workspaceId, icpId?, runId?, budgetId, purpose, correlationId)` 并经 Broker；`requiresSourcePolicy` 工具在 source_policy 未登记时 **fail-closed**；预算走原子账户 reserve-settle；allowedTools 填实并覆盖主要路径。（未来出向触达系统建 OutboundBroker 与之对称——SaaS 侧责任。）
6. **ADR-006 EVIDENCE-SIGNAL**：Observation/Evidence/**Signal 是事实源**；`attributes.*` 只是投影/读模型。Signal 一等字段：subject org、type、occurred/observed_at、source+evidence ref、strength、taxonomy scope、jurisdiction/license/retention、idempotency key、状态机。平台级 `source_signal` 零个人数据；租户注册源（web_watch）归租户层。
7. **ADR-007 IDENTITY**：目标模型=Organization + OrganizationIdentifier（domain/LEI/税号/FDA firm id…）+ SourceRecordLink + MergeDecision/SplitDecision（可审计可回放）；单一 dedupeKey 仅作 blocking。渐进演进不做大迁移；**最小版 R2 落地，是 R3 接多标识符源（SAM/专利/提单）的前置**。
8. **ADR-008 WORKFLOW**：Temporal 只拥有编排，业务状态在 Postgres；**前向管线与 backlog sweep 共用同一套幂等 Candidate Stage Activities**，schedule 只做补偿对账（含跨-sweep 水位与公平性——无饿死）；按资源类拆 task queue（量大后）。
9. **ADR-009 CONTRACTS-EVENTS**：code-first OpenAPI **JSON** 唯一 REST 真值（旧 YAML 删除或降为生成产物）；统一返回信封；每个外部事件有 payload schema + Consumer Test；内部 command 与 integration event 分离；Outbox 按 sink 投递/重试/ACK/DLQ，禁止无 handler 标记 published。
10. **ADR-010 COMPLIANCE-SCORING**：本仓负责 storage gate、DSR/删除编排、最小化与审计；发送 gate 由执行平台负责但消费本仓政策结论；`DataRightsService.evaluate(ctx)` 确定性纯函数 + jurisdiction_policy 数据行（含 PIPL 法域对）+ policy_decision_log + LIA 记录与 Art.14 通知义务判定；评分确定性、版本化、存 feature snapshot；乘法门须经历史 backtest（人工确认 QGO 标签 ≥50 条）后启用；**删除编排硬前置于任何对外发送**；（待拍板）制裁名单筛查作 qualify 第五门。**✅ 落地（收口⑥ 完成）**：PR-A #60（`DataRightsService` 7 动作确定性引擎 + jurisdiction_policy 含 PIPL + policy_decision_log/lia_record/article14_notice + PII 列级加密 + DB 角色拆分）+ PR-B（`deletionWorkflow` GDPR Art.17 冻结→擦除→重评分→回执 + `deletion_request`/`deletion_receipt`(append-only+FK RESTRICT) + `POST/GET /deletion-requests` + DeletionCompleted 事件）。删除编排建成=时序门前置就位（R1 发送上线联合校验）。consent_record(Art.21)/retention sweep/RolesGuard 随 R1。
    **存储侧不可回退红线（永久生效）**：🔴 具名个人数据默认隔离，无 LIA 记录不解锁 OUTREACH；证据先行——无 evidence 的字段不得参与评分或导出；🔴 内容最小化——新闻等原文只存指纹/计数，个人数据不写 Trace/日志/Prompt；embedding 永远只对公司事实；技术能抓 ≠ 合规能用。
11. **ADR-011 IDENTITY-SEAM 身份接缝（用户 2026-07-10 拍板）**：身份 SoR 维持在 A（独立库）——不采纳交付包 OD-01「同一业务后端」原案。硬规矩：① A 的库**永远不存业务对象**，Company/ICP/Lead/Campaign/Opportunity 唯一主数据在增长库；② 权限执行点在服务端（B 层 claims→scopes + Guard），任何接口不信任前端提交的 role；③ JWKS 契约（iss/aud/exp/sub/workspace_id/roles[]、kid 轮换、JIT provision）双方 contract test 入 CI。
12. **ADR-012 READ-MODEL 读模型隔离**：统计/Dashboard/Search 一律走事件投影读模型；读模型不反向覆盖业务事实；跨域页面聚合走 BFF/读模型，禁止跨领域实时 Join 替代明确接口。
