# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[ADR registry](../adr/registry.md)、[发布路线](../roadmap/release-plan.md)、下列 exact Git/GitHub 与 development-runtime 只读观察
> 最后核验：2026-09-11T19:56:34+08:00（Asia/Shanghai）

## 当前结论

`SOURCE_INTEGRATED_ALPHA / CROSS_REPO_PRODUCT_ASSEMBLY / USER_JOURNEY_NOT_VALIDATED / COMMERCIAL_LOOP_NOT_CLOSED / PRODUCTION_READINESS_BLOCKED`

源码、局部测试、主线 CI、部署、运行证据和用户验收是不同的事实。Browser/ACK/schema 修复、平台 Temporal 基础设施和执行规则更新已合入，不代表用户已经能够完成 `LeadQualifiedPackage → Opportunity → Human QGO → Feedback`。当前仍没有可接纳的完整 MVP 用户闭环。

Program C 保持用户已批准的完整 C1–C5/QGO 范围；company-first 是未选择的可选缩范围，不构成原范围的执行阻塞。Billing/Credits 保持 `DEFERRED / NOT_IMPLEMENTED`；`cap_microusd` 是平台执行安全包络，不是客户余额或模型购买次数。

当前非运行时模型候选合同仍为 `site-builder-model-candidate-baseline/2026-08-07-v3`，不等于 active route、质量证明或真实 dispatch 授权。

2026-09-11 增量核验：远端 `origin/main=9e6b9e621805dfe0d0150162a14e23208cc9a6ca`，
#497、#502 与 #504 已合入；#498 已重放到该主线，当前候选 head 为
`c5ad3f58fd2f889a702a5c40739fb9f844aa4e7f`，托管检查正在运行。
其前序候选 `codex/temporal-native-disposable-closeout-20260911`
的 custom native Temporal disposable 运行矩阵已通过，详细绑定见
[Temporal native disposable closeout evidence](../evidence/temporal-platform-native-disposable-closeout-20260911.md)。
这只更新源码候选与状态事实，不改变 GrowthOS producer、跨仓 readback、RuntimeEvidence、
Release Bundle、UAT 或 Pilot/GA 的独立门；#479 与 #407 仍为 Draft/HOLD。

## 1. 源码与正在进行的工作

以下记录是时间绑定快照，不预测本文后续提交或其他任务未来结果。

| Subject              | Exact observed state                                                                                                                                                                                                                   | 证据边界                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Backend source       | 根 `main=origin/main=9e6b9e621805dfe0d0150162a14e23208cc9a6ca`，受控 fast-forward 已完成；tracked clean，保留未跟踪 `.playwright-cli/`                                                                                                                         | repository source identity，不是 runtime identity                                                            |
| 已完成修复           | #448 安全基线、#449 结算源码已合入；#452 浏览器接线合入 `490bed749823248a4dad9508ef0b86dd36454cc7`；#453 ACK 回读合入 `e09ff17f1f2b417ee99c2d3b3ea34e34ed25277a`；#454 删除事件 schema 合入 `63b4af94b662d7e2b6a40823a1872daf0fc9b993` | 不再列为未开发或待合入；部署、运行采用另行核验                                                               |
| 主线 CI | #502 与 #504 的 PR 必需检查已通过；最新 main push `9e6b9e62…` 的 CI 仍在运行，Supply Chain Canary 已因 `CRITICAL_ADVISORY_HOLD` 失败（baseline 过期/锁文件不匹配、22 条当前 advisory，含新的 critical 与 overdue remediation） | 只证明对应提交的托管检查；main 当前不能宣称全绿，也不证明运行采用 |
| Browser readiness    | `checkBrowserReadiness` 默认调用已合入的生命周期 singleton；API contributor、Worker 启动和周期检查共享它；最新 API/Worker readback 的 `/api/v1/health/ready` 为 503，但 browser component=OK，migration/database/storage/Redis/Gateway/auth JWKS 均 OK | 完整五文件源审查 C0/H0/M0；本次运行回读不等于用户旅程成功 |
| Backend ACK readback | `EventsController_ackStatus_v1` 已进入 code-first OpenAPI；权限为 `acquisition:event:ack`，固定 saas sink、Workspace RLS、closed response、no-store                                                                                    | 只回读 ACK 状态；不是 SaaS consumer，也未授予浏览器后台权限                                                  |
| DeletionCompleted    | v1 schema 已兼容 producer 的可选非负整数 `patent_cache_erased`，历史缺字段仍合法                                                                                                                                                       | 没有增加删除执行或 Patents 调用；不是跨仓 DSR 完成证明                                                       |
| GrowthOS source      | `/global/frontend/growthos-source` clean `51d7420373e31ba5c2a696513d8d6b5e77ed3fe0`；archive-and-patch authority，不是直接运行 pnpm 的源码目录                                                                                         | 旧 `79e53f39…` 的 C0/H5/M3 仅对应历史审查，不能作为该新版本的通过或失败结论；当前版本接纳需要其 owner 的证据 |
| Program B source     | `pr407-organization-identity-caller-cutover-v2` clean `944ce580ae91f5bb2238e63f94726b5789dd63f5`                                                                                                                                       | 旧 `f3e5bc19… C6/H5` 不自动迁移到新版本；本次没有核得新版本全链路接纳/Pilot 完成证据                         |
| Program C spec       | 独占 `program-c-c1-contract-20260904` 本地提交 `4b116f10bc3d7efca6f15611f900923f2ea73d1f`；同一 C1 文档的分页/隐私/digest finding 已独立复审关闭 C0/H0/M0                                                                              | 文档未进入 main；GrowthOS 文件所有权交接与源码实施仍未完成，不再把“合同尚未复审”作为阻塞                     |
| 平台基础设施 | #455、#457、#459、#460、#461、#462、#463、#464、#465、#468、#469、#472、#474、#475、#476、#477、#493、#494、#495、#497、#502 已合入；当前远端主线为 `9e6b9e621805dfe0d0150162a14e23208cc9a6ca`。#497 收口 native Temporal disposable reader proof，#502 统一 Worker 启动与心跳 admission | 源码接纳与平台权限、精确制品、GrowthOS/Builder/New API 的后续运行采用分开；不把 disposable 结果当成生产运行证明 |
| 运行时采用 | API/Worker 当前均使用 `ghcr.io/mlhjyx/global-backend@sha256:4f4a10ac0d07f56c4710b808980032a3d6a380e430fdc5c03eaaef587a2ac36d`，build SHA `b3cf80411f89b24825b01f942286d68a50f3b2ea`，artifact `sha256:3809bf594ba86243855becc9e8440beee7d8809b6a74a68e6d1cb3cc604c8ab8`，migration `20260908130000_platform_egress_budget_policy_v2`；该运行身份早于 #502/#504，尚未证明新主线源码已在运行时采用 | 这是当前运行身份 readback，不代表 readiness 或用户旅程成功 |
| Wikidata country successor | #498 已从旧 `52ab68b6…` 重放到 `c5ad3f58fd2f889a702a5c40739fb9f844aa4e7f`；原 55/55 focused tests 与完整 hosted 矩阵对应旧 head，重放后的新 hosted 矩阵仍在运行，独立 review/merge 未完成 | 只处理当前 query 变量绑定；不关闭 #407 综合候选或 Program B 接纳 |
| 文档候选 | #504 已合入并保留 #503/#499 provenance；本页再次记录 #502 合入、#498 重放和 main Supply Chain Canary 失败，不代替 RuntimeEvidence、Release Bundle 或产品验收 | 只记录当前事实，不改变运行或发布授权 |

### Program 所有权与产品缺口

| Program                          | 状态                                           | 所有权与当前缺口                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — authority/runtime primitives | PARTIAL                                        | 通用 Authority、GovernedSubject/Relation、Site Quote/Grant、runtime/release；不拥有 Raw/Identity/Provider 或 Opportunity。历史 mega branch 仍为 NON_DEPLOYABLE / PROVENANCE_ONLY；当前平台候选及运行采用分别接纳 |
| B — Buyer Intelligence discovery | CURRENT_CANDIDATE_ACCEPTANCE_NOT_VERIFIED      | QueryReceipt、Raw/Identity/Canonical、Provider/transport、Discovery、LeadQualifiedPackage；不拥有 SaaS Opportunity 或 runtime deploy。已接纳 main slices 与当前候选分开，完成当前版本验收后再进入受控 Pilot      |
| C — SaaS handoff/commercial loop | SPEC_REVIEWED / IMPLEMENTATION_HANDOFF_PENDING | 服务端 consumer、receipt、QualificationSnapshot、Opportunity、QGO/SAO/CLOSED、SalesAcceptance、CommercialOutcome、Conversation linkage；完整原范围保持有效                                                       |

A/B ownership seam 已关闭，固定边界为 `ExecutionAuthority → ToolOperationSubject → B-owned QueryReceipt → B-owned RawSourceRecord UUID → B-owned IdentityLink/CanonicalCompany UUID → A-owned append governed child/relation primitive → Domain ACK`。历史来源见 ADR-025、冲突注册表与原计划；这不自动关闭所有 Program 的来源、迁移、运行和验收门。

Program C 的 durable server consumer、handoff receipt、QualificationSnapshot、Opportunity aggregate、commit-before-ACK、ACK_PENDING 与 QGO/SAO/Outcome 尚未完成产品接纳；browser ACK 和 Conversation shell 不能替代 Opportunity。C1-A 的本地 parser/client 不依赖真实 Provider 或邮件，但必须先取得现有 GrowthOS writer 的明确文件交接；C1-B 的持久化、KMS/DSR/suppression 与迁移有独立依赖。

## 2. 全局阶段门

| Gate                              | 当前裁决                        | 仍需证明                                                                                                                                 |
| --------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| G0 — Truth & Ownership            | PARTIAL                         | 已关闭 A/B 重叠不代表全部 owner 已交接；Program C writer/migration/patch manifest 交接未完成；其他 Program 的新候选按当前 owner 证据接纳 |
| G1 — Product/UX/Contract          | PARTIAL                         | 完整 C1 合同已复审；跨仓可执行隐私、不可变 Evidence、UI 和 UAT 合同仍有缺口                                                              |
| G2 — Source/TDD/Security          | PARTIAL / MERGED_FIXES_VERIFIED | #452/#453/#454 源码及其必需 PR CI 已通过；不能把这一批成功推广到所有产品模块                                                             |
| G3 — Integration/Data             | PARTIAL / PRODUCT_E2E_NOT_RUN   | 本地组合测试和一次性数据库测试通过；当前用户旅程、跨仓消费、重启、DSR/隐私闭环未验收                                                     |
| G4 — Release Candidate            | DEVELOPMENT_CANDIDATE_ONLY      | 当前源码尚需匹配的跨仓 images/SBOM/migrations/rollback 与可信外部 readback                                                               |
| G5-Site — Runtime Observed        | HISTORICAL_ONLY                 | 当前有效 RuntimeEvidence=0；旧 Site 记录已经到期；新修复未由当前运行版本证明                                                             |
| G5-Acquisition — Runtime Observed | NOT_VERIFIED                    | 当前有效获客 RuntimeEvidence=0；平台权限、Discovery 到 Opportunity 的当前运行链未证明                                                    |
| G6 — UAT Accepted                 | NOT_RUN                         | 关键用户旅程连续三次、其中一次受控重启，以及产品 Owner 验收                                                                              |
| G7 — Pilot/GA Authorized          | NOT_AUTHORIZED                  | 有效跨仓 Release Bundle、运行证据、独立 readback 和精确 Pilot/GA 授权                                                                    |

## 3. Development runtime 观察

本次受控切换已将 API 和 Worker 都切到同一 exact OCI：`ghcr.io/mlhjyx/global-backend@sha256:4f4a10ac0d07f56c4710b808980032a3d6a380e430fdc5c03eaaef587a2ac36d`，绑定 build SHA `b3cf80411f89b24825b01f942286d68a50f3b2ea`；两者容器 image ID、artifact identity 与 migration revision 均一致。此前缺失的迁移已应用，数据库 readback 为 135 条完成、0 条未完成且未回滚（两条历史记录为明确 rolled-back）。该运行身份早于当前 main 的 #502/#504，尚未证明这些主线提交已在运行时采用；当前未执行真实模型调用。

| 观察              | 当前可确认的事实                                                                                                         | 不得外推                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 运行版本          | `/health/build` 返回 attested=true、build SHA `b3cf80411f89b24825b01f942286d68a50f3b2ea`、image `sha256:4f4a10ac…`、artifact `sha256:3809bf59…`、SBOM `sha256:b1cbf681…`、schema `sha256:ed90b028…`、renderer `sha256:a7c2812a…`、migration `20260908130000_platform_egress_budget_policy_v2` | running 不证明 readiness、队列消费、模型或用户旅程成功                                   |
| Browser 历史事故  | 历史 `2026-09-05` tmpfs/目录耗尽事故保留为历史；当前直接 Chromium readiness probe 与最新 health 均为 browser=OK | 历史事故与当前恢复状态分别记录；不外推到其他环境 |
| Listener exposure | 本次 `ss` 仍见 `0.0.0.0:3001`、`[::]:3001` 和 legacy Java `*:8080`                                                       | 未执行端口收敛或旧服务退役                                                               |
| Readiness           | `/api/v1/health/build`=200 且 identity 已切换；`/api/v1/health/ready`=503，platform technical quote、settlement readback、API runtime、Outbox Relay、workspace budget authority、browser、storage、Redis、Gateway、renderer、auth JWKS 与 admission 均 ok；platform authority=`PLATFORM_AUTOMATION_ACQ_SWEEP_TEMPORAL_PROOF_UNAVAILABLE`，intent/sanctions 同类失败，Worker=`MATCHING_WORKER_NOT_READY` | 这是 fail-closed 运行事实；不得把 exact image 误报为可接单或可付费调用 |
| Historical Spend  | 旧 UNKNOWN/unknown 及 unresolved/expired 记录按原证据保留                                                                | 不通过重发制造结果，也不由源修改自动改写历史费用                                         |

历史费用记录保持 UNKNOWN/unknown：attempts 1–5 为 UNRESOLVED，attempt 6 为 EXPIRED，reservation/conservative charge 均为 `800000`；EXPIRED 不产生有效输出或精确费用，继续不重发。完整脱敏字段见 [2026-09-04 platform-writer successor runtime readback](../evidence/site-builder/production-parity-platform-writer-runtime-readback-20260904.json)；20260901 predecessor 保持 historical provenance。GrowthOS 2026-09-01 historical provenance 也不能代替当前 authority source。

旧权限缺失码与健康响应仅对其原观察时间有效；当前 runtime acceptance 仍须 fresh readback，不能由本页或静态 CI 代签。

## 4. 验证、证据与发布

- 已合入组合源码 `63b4af94…` 的 tree 为 `8e7ecd528d4190bfbfb17d93cce054d1923438cc`，与隔离组合逐字节一致。11 个测试文件 134/134、一次性 PostgreSQL16/RLS 4/4、API/contracts build、OpenAPI 零漂移、governance 147/147 通过。测试容器只清理自己的临时数据。
- 浏览器本地范围的行/分支覆盖率为 94.06%/86.36%；独立五文件审查 C0/H0/M0。额外全目录测试源码 tsc 未通过，未修改测试中的类型/声明问题没有被此局部成功掩盖。
- 本次治理只读验证报告 RuntimeEvidence `6 total / 0 current / 6 historical`，Release Bundles=3。前两条 Site 证据到期点为 `2026-09-05T03:49:25.000Z`；到期不删除历史，但不能用于 G5/G7 晋级。
- 3 个 Release Bundles 仍是 development `CANDIDATE` / `EXTERNAL_UNVERIFIED`，不是可信发布结果。具体字段以机器文件及 verifier 为准；路径存在或结构通过不是 runtime proof。
- PR #461 的 privilege-hardening successor 已应用并 read back：`fence_platform_schedule_v1(text,text)` 对 `PUBLIC`、`app_user`、`runtime_api`、`runtime_worker`、`runtime_outbox_relay` 为无 EXECUTE，仅 dedicated `execution_budget_platform_writer` 可执行；这不等于平台 Temporal proof 或跨系统撤销链已就绪。
- #448 修复了新增的依赖告警，不代表零风险。最新 main push 的 Supply Chain Canary 于 `2026-09-11T11:32:55Z` 输出 `CRITICAL_ADVISORY_HOLD`，记录 22 条当前 advisory，并包含 baseline 过期、锁文件摘要不匹配、新 critical advisory 与多项 overdue remediation；该门仍未闭环。

## 5. 下一顺序与授权边界

商业主路径是 `Onboarding → ICP → LeadQualifiedPackage → Opportunity → Human QGO → Feedback`；并行信任资产路径是 `Quote → Grant → Build → Preview`。

1. 运行主线：已合入的平台基础设施进入精确制品/迁移核验、获授权的运行采用和 fresh RuntimeEvidence；不重复已合入的 Browser wiring/ACK/schema 修复。
2. 产品主线：GrowthOS 单 writer 文件交接 → C1-A → C1-B/C1-C → C2 Opportunity → C3 Human QGO → C4 Outcome/C5 Conversation；不另起 R7 文档循环。
3. 文档：本页维护当前事实，roadmap 保持稳定顺序；历史入 changelog/evidence。#451 按已批准的 GitHub 队列完成最终修订、验证、独立审查与远端收口。
4. 验收：当前跨仓 Release Bundle、关键 UAT 三次与重启恢复通过后，才评估德国工业泵零模型/零付费/零发送 Pilot 的精确授权卡。

既有明确授权在相同动作、目标、范围和成本/数据边界内继续有效，普通本地开发/验证不重复请示。#452/#453/#454 更新与合入授权已执行完成，不自动授权部署、保留数据库迁移、缓存删除、端口变更、真实 Provider/模型调用、OAuth/邮件或 Pilot。当前工作保留单 writer、费用、权限、RLS 与发布门；未知结果不被静态检查升级。
