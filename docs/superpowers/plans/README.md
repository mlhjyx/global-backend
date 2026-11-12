# Superpowers 计划索引

> 生命周期：`GUIDE`
> 最后核验：2026-11-12（按文件头生命周期自动汇总）

本目录保存跨会话的实施计划。`APPROVED`/`DRAFT` 表示计划仍可能被引用；`CLOSED` 表示已交付或已收口，按 `docs/documentation-rules.md` 的规则只保留有引用的条目；`SUPERSEDED` 只作历史 provenance。

状态统计：APPROVED 25, CLOSED 13, DRAFT 7, SUPERSEDED 4, REFERENCE_ONLY 1, GUIDE 1

## 待裁决（2026-11-12 审计）

以下 6 份计划零入站、零代码引用，但可能仍有设计/验收价值；删除前需产品负责人逐份确认：

- `2026-10-26-global-review-remediation.md`（DRAFT，全局梳理整改方案，建议保留）
- `2026-11-04-acquisition-system-master-plan.md`（DRAFT，获客总规划，建议保留）
- `2026-11-06-channel-crawl-fetch-artifact-scope.md`（APPROVED，渠道抓取落地设计）
- `2026-11-06-cost-dimension-settlement.md`（APPROVED，成本维度结算）
- `2026-11-06-platform-worker-drain-gate.md`（APPROVED，worker 排空门）
- `2026-11-08-skill-runtime-s0-e2e.md`（S0 端到端演示脚本）

裁决标准：已被后续实现/文档取代且零引用的按 `documentation-rules.md` §5 删除；仍描述现行机制或验收证据的保留，并在正文加 successor/状态说明。

| 日期 | 状态 | 计划 | 文件 |
| --- | --- | --- | --- |
| 2026-08-29 | CLOSED | Discovery Query Lineage Successor Admission Plan | `2026-08-29-discovery-query-lineage-foundation.md` |
| 2026-08-30 | CLOSED | Discovery Company Materialization C-TX Implementation Plan | `2026-08-30-discovery-company-materialization-ctx.md` |
| 2026-08-30 | CLOSED | Discovery Lineage G0 Closeout Implementation Plan | `2026-08-30-discovery-lineage-g0-closeout.md` |
| 2026-08-30 | SUPERSEDED | Program C ADR-027 / ADR-026 Trusted Acceptance Implementation Plan | `2026-08-30-program-c-adr-trusted-acceptance.md` |
| 2026-08-30 | REFERENCE_ONLY | Trusted Approval Readback Hosted Bootstrap Implementation Plan | `2026-08-30-trusted-approval-readback-hosted-bootstrap.md` |
| 2026-09-13 | SUPERSEDED | 平台撤销恢复：已批准差额规格 | `2026-09-13-platform-revocation-recovery-approved-spec.md` |
| 2026-09-13 | SUPERSEDED | Platform revocation recovery implementation | `2026-09-13-platform-revocation-recovery-implementation.md` |
| 2026-09-19 | SUPERSEDED | R4 最小 machine/runtime 安全差额提案 | `2026-09-19-platform-machine-runtime-approved-spec.md` |
| 2026-10-09 | CLOSED | app_user 对无 RLS 平台表的写权限收口设计 | `2026-10-09-app-user-platform-table-privileges.md` |
| 2026-10-09 | CLOSED | 发现 run 准入租约：落地设计 | `2026-10-09-discovery-run-admission-lease.md` |
| 2026-10-09 | CLOSED | public_web 公司自有官网通用 source_policy 落地设计 | `2026-10-09-public-web-company-site-source-policy.md` |
| 2026-10-10 | APPROVED | 线索交付闭环：交付包 v1.1、周报、反馈、建议联系路径与开发信草稿 | `2026-10-10-lead-delivery-loop-design.md` |
| 2026-10-10 | CLOSED | 平台 schedule 准入与平台写入者授权：设计 | `2026-10-10-platform-schedule-admission-and-writer-grants.md` |
| 2026-10-14 | APPROVED | 开发快速通道（dev fast lane）落地设计 | `2026-10-14-dev-fast-lane.md` |
| 2026-10-26 | DRAFT | Global 项目全局梳理与整改方案（2026-10-26 续写版） | `2026-10-26-global-review-remediation.md` |
| 2026-10-31 | APPROVED | 联系人挖掘（决策人 · 联系方式 · 职位）设计稿 | `2026-10-31-contact-discovery.md` |
| 2026-10-31 | APPROVED | G5 决策方案：租户侧线索/公司详情与禁联名单口径 | `2026-10-31-g5-tenant-detail-contract.md` |
| 2026-10-31 | CLOSED | 平台运行准入改走 v2：权威方 gain-saas 持久签发 | `2026-10-31-platform-run-admission-gainsaas.md` |
| 2026-11-01 | CLOSED | 平台出网围栏的受审计重开路径 | `2026-11-01-egress-fence-reopen.md` |
| 2026-11-01 | CLOSED | 政策停用 → 平台撤销的自动触发（设计稿） | `2026-11-01-platform-revocation-autotrigger.md` |
| 2026-11-03 | DRAFT | google_patents 启用前置：许可核实与 LIA 草稿 | `2026-11-03-google-patents-enablement-lia.md` |
| 2026-11-03 | CLOSED | D6：per-tenant LIA 采集（多租户前的合法依据声明） | `2026-11-03-per-tenant-lia.md` |
| 2026-11-04 | DRAFT | 获客挖掘体系完整设计 v1（落地版） | `2026-11-04-acquisition-system-complete-design.md` |
| 2026-11-04 | DRAFT | 获客挖掘体系总体规划（v1）：渠道数据源平台 + Run 2.0 + 反馈闭环 + 管理后台 | `2026-11-04-acquisition-system-master-plan.md` |
| 2026-11-04 | APPROVED | 寻源提速：快扫 / 深挖两档设计 | `2026-11-04-discovery-quick-deep-tiers.md` |
| 2026-11-04 | DRAFT | 寻源 Run 2.0：闭环挖掘体系设计（run 与本地挖掘） | `2026-11-04-discovery-run-closed-loop-redesign.md` |
| 2026-11-04 | APPROVED | PR-B 落地设计：ETag/304 条件请求 + 内容哈希键控 LLM 抽取缓存（v2 · 2026-11-08 补齐启动门） | `2026-11-04-http-cache-pr-b.md` |
| 2026-11-04 | APPROVED | HTTP-first 抓取管线（PR-A）落地设计：分级抓取、参数修复与并发 env 化 | `2026-11-04-http-first-fetch-pipeline.md` |
| 2026-11-05 | APPROVED | Q33② cheap-first 数据源路由 · 落地设计文档（2026-11-05） | `2026-11-05-cheap-first-provider-routing.md` |
| 2026-11-05 | APPROVED | Q33② discovery run 总池硬闸门（DISCOVERY_RUN_POOL_CAP）· 落地设计文档（2026-11-05） | `2026-11-05-run-pool-cap.md` |
| 2026-11-06 | APPROVED | 渠道抓取取数与 run 幂等修复 · 落地设计文档（2026-11-06） | `2026-11-06-channel-crawl-fetch-artifact-scope.md` |
| 2026-11-06 | APPROVED | 1b 花费维度补口 · run 成本结算设计文档（2026-11-06） | `2026-11-06-cost-dimension-settlement.md` |
| 2026-11-06 | APPROVED | platform-worker 依赖排空策略修正 · 落地设计文档（2026-11-06） | `2026-11-06-platform-worker-drain-gate.md` |
| 2026-11-08 | APPROVED | M2 步 9 · M2.1 受限 Campaign Planner 与审批 UI 落地设计（2026-11-08） | `2026-11-08-campaign-planner-m2-1.md` |
| 2026-11-08 | APPROVED | M2 步 9 · M2.2 有界重规划与指标闭环落地设计（2026-11-08） | `2026-11-08-campaign-replan-m2-2.md` |
| 2026-11-08 | APPROVED | M2 步 11 · 能力 3 受控邮件触达（email first）落地设计（2026-11-08） | `2026-11-08-controlled-email-outreach-m2-step11.md` |
| 2026-11-08 | APPROVED | Crawl4AI 0.9.1 → 0.9.5 安全升级 · 落地设计文档（2026-11-08） | `2026-11-08-crawl4ai-095-upgrade.md` |
| 2026-11-08 | APPROVED | D-MA-7 · 记忆与学习层 v0 落地设计文档（2026-11-08） | `2026-11-08-memory-layer-v0.md` |
| 2026-11-08 | APPROVED | M2 步 9b · 多 agent 编排 v0 落地设计文档（2026-11-08） | `2026-11-08-multi-agent-orchestration-v0.md` |
| 2026-11-08 | APPROVED | M2 步 13 · S2 触达技能 + L2 审批落地设计（2026-11-08） | `2026-11-08-outreach-skills-l2-m2-step13.md` |
| 2026-11-08 | APPROVED | M0 步 4 · P5 用户闭环落地设计文档（alerts 站内通知 / 引导 Claim 草稿 / 错误文案表） | `2026-11-08-p5-user-loop.md` |
| 2026-11-08 | CLOSED | M1 步 8 · S1 Pack v1 落地设计文档（2026-11-08） | `2026-11-08-s1-pack-v1.md` |
| 2026-11-08 | GUIDE | S0 Skill Runtime v0 · 发车后端到端演示脚本（2026-11-08） | `2026-11-08-skill-runtime-s0-e2e.md` |
| 2026-11-08 | CLOSED | M1 步 7 · S0 Skill Runtime v0 落地设计文档（2026-11-08） | `2026-11-08-skill-runtime-s0.md` |
| 2026-11-08 | APPROVED | 结构化数据源受治理血缘合同（lineage v3）· 落地设计（APPROVED） | `2026-11-08-structured-source-lineage-contract.md` |
| 2026-11-08 | APPROVED | 工作流可调常量输入化 · 剩余清单（L01 后续） | `2026-11-08-workflow-constant-input-ization.md` |
| 2026-11-09 | APPROVED | 联系人四态与验证事件账（P1 首波） | `2026-11-09-contact-point-four-state.md` |
| 2026-11-09 | DRAFT | 决策简报：registry_frame 的 local_query 血缘变体（A 方案） | `2026-11-09-registry-frame-local-lineage-decision-brief.md` |
| 2026-11-09 | APPROVED | registry_frame 的 local_query 血缘变体（ch03 T3-09 执行面设计） | `2026-11-09-registry-frame-local-lineage.md` |
| 2026-11-09 | DRAFT | T3-19 每源记分卡 vs ch01 PR-06 源记分卡：重叠评估与建议 | `2026-11-09-t3-19-scorecard-overlap-assessment.md` |
| 2026-11-10 | APPROVED | 获客挖掘 vNext：去平台预算帽、实体级深度与可复验的覆盖率 | `2026-11-10-deep-acquisition-vnext.md` |
