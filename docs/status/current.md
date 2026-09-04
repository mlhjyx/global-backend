# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[发布路线](../roadmap/release-plan.md)、[ADR registry](../adr/registry.md)、本页所列 exact Git/worktree、GitHub 与 development-runtime 只读观察
> 最后核验：2026-09-04T18:48:40+08:00（Asia/Shanghai）

## 当前结论

`SOURCE_INTEGRATED_ALPHA / CROSS_REPO_PRODUCT_ASSEMBLY / USER_JOURNEY_NOT_VALIDATED / COMMERCIAL_LOOP_NOT_CLOSED / PRODUCTION_READINESS_BLOCKED`

Backend 与 GrowthOS 已有大量源码、合同和局部测试；Site Builder 也有可观察的 development 单路径。但“源码存在”“局部测试通过”“服务健康”“RuntimeEvidence 有效”和“产品可发布”是不同事实层。当前仍不是 MVP：`LeadQualifiedPackage → Opportunity → Human QGO → Feedback` 尚不能由用户稳定完成，Program C 关键聚合与 durable handoff 不存在，获客运行证据为空，Release Bundle 也未通过机器、独立 reviewer、用户授权和外部 readback 门。

Billing/Credits remains `DEFERRED / NOT_IMPLEMENTED`; `cap_microusd` is a platform execution safety envelope, not a customer balance. 当前没有客户充值、套餐内模型次数或余额不足产品语义。

当前非运行时模型候选合同仍为 `site-builder-model-candidate-baseline/2026-08-07-v3`；它不是 active route、质量、dispatch、RuntimeEvidence 或发布证明。

## 1. Exact source and active-work baseline

Repository source identity is `0679a0bc510a980f65ebd33eb88b3215a97c20ba`. Development runtime identity is `674ff12d4d768ce5599fc07b565fe21da37dc5fe`, 4 commits behind repository source；运行中的旧制品不能被当前源码提交替代描述。

| Subject                       | Exact observed state                                                                                                                                                                                                                                                                      | Evidence class and limitation                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/global/backend` root `main` | observed `2026-09-04T18:48:40+08:00`：`HEAD=origin/main=0679a0bc510a980f65ebd33eb88b3215a97c20ba`；仅保留既有未跟踪 `.playwright-cli/`                                                                                                                                                    | Git source observation；不是 runtime identity。                                                                                                                        |
| Backend development runtime   | source `674ff12d4d768ce5599fc07b565fe21da37dc5fe`；OCI `sha256:b70175a0904c6a6a2089efbf914467cb1dcd7465ca1eb9a1066649cb6190f2c9`；artifact `sha256:f34128f5bc1c48cbfc7147b74d344a9b81b40d6812473a50f7d69d43bd52dec0`；migration `20260902020000_unknown_spend_reconciliation`             | Development runtime observation；4 commits behind current main。                                                                                                       |
| GrowthOS source               | GrowthOS authority source is clean at `290c6f9f6a41c7c39dfe071683252982536937d8`, with 54 patches and no remote；2026-09-01 historical provenance is not current source                                                                                                                   | Source-only。`candidate_deny` 与 Temporal 为 `UNKNOWN`；9/9 focused local contract tests 不是 Task 2、release 或 runtime acceptance。                                  |
| New API                       | clean `ccf69871398014bebcd6cee07eee07714fe9635a`；ahead 69 / behind 163                                                                                                                                                                                                                   | Source-only；无当前 Go 工具测试 receipt 或可见 final independent review，不算 accepted。                                                                               |
| Platform Authority            | clean `b5424ef081cb49684f4c3ef3278782337ce768f7`，基于 current main ahead 45                                                                                                                                                                                                              | Active “修复独立站前端构建失败” task 的进行中源码；较早测试不能外推到该 exact head，不能宣称完成。                                                                     |
| Program A mega branch         | clean `91cae351795cceced59893bcf552c2b502a4ebaa`；ahead 59 / behind 188                                                                                                                                                                                                                   | `NON_DEPLOYABLE / PROVENANCE_ONLY`。已进入 main 的 PR #427/#431/#432 slices 必须与 mega branch 分开判断。                                                              |
| Program B active writer       | Program B exact base/head is `9d52a27e611b99329b8eb5fc80b27cc6f5a3ae63`; accepted main slices #427/#431/#432 are separate from active Task0L; its implementation verdict is `NEEDS_FIXES`, authoritative predecessor review is `C3 / H3`, and line coverage is 76.77% / normalized 78.92% | Worktree is dirty under the existing active writer。80/80 focused tests 与 plan-only review 不等于 implementation acceptance；当前修复尚无 clean exact-head rereview。 |

### Program RAG and ownership boundary

| Program                          | RAG   | Current owner boundary                                                                                                                                                              | Current condition                                                                                                                                         |
| -------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — authority/runtime primitives | AMBER | Owns generic Execution Authority, GovernedSubject/Relation primitives, Site Quote/Grant, OCI/runtime and RuntimeEvidence/Release；does not own Raw/Identity/Provider/Opportunity    | Accepted main slices 与 historical mega branch 分离；platform R2 owner/manifest 和 current exact-head review 尚未闭合。                                   |
| B — Buyer Intelligence discovery | RED   | Owns QueryReceipt、RawSourceRecord、Identity/Canonical、Provider/transport、Discovery workflow 和 immutable `LeadQualifiedPackage`；does not own SaaS Opportunity or runtime deploy | #427/#431/#432 accepted source slices 与 active Task0L 分开；Task0L implementation review 仍为 `NEEDS_FIXES`，coverage 未到 80%，active writer 正在修复。 |
| C — SaaS handoff/commercial loop | RED   | Owns server-side consumer、receipt、QualificationSnapshot、Opportunity、QGO/SAO/CLOSED、SalesAcceptance、CommercialOutcome 和 Conversation linkage                                  | 产品范围 A/B 选择、source/migration owner 与 manifest 尚未授权；A（C1-COMPANY first）为推荐方案。                                                         |

The A/B ownership seam is closed; global G0 remains partial because the Program B root/launcher authority/materialization gate remains open under active Task0L, platform R2 owner/manifest is incomplete, and Program C product/owner gates are still open. The fixed interface is `ExecutionAuthority → ToolOperationSubject → B-owned QueryReceipt → B-owned RawSourceRecord UUID → B-owned IdentityLink/CanonicalCompany UUID → A-owned append governed child/relation primitive → Domain ACK`.

Program C currently has no durable server consumer, handoff receipt, QualificationSnapshot, Opportunity aggregate, commit-before-ACK transaction, ACK_PENDING reconciliation, or QGO/SAO/Outcome path. The browser ACK and existing Conversation shell cannot stand in for the Opportunity product. 同一 event 重放、commit 后 ACK、隐私删除与跨 workspace 负例也尚无端到端证明。

## 2. Global gate position

| Gate                              | Current verdict                                                     | Evidence and blocker                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0 — Truth & Ownership            | `AMBER / PARTIAL / HOLD`                                            | A/B ownership seam 已关闭；Program B root/launcher authority/materialization gate、platform R2 writer/migration manifest 与 Program C 产品选择/owner/manifest 仍未闭合。                                                                                                                           |
| G1 — Product/UX/Contract          | `AMBER / PARTIAL`                                                   | 产品主线、Program 边界和推荐 C1-COMPANY 方案已明确；Program C 最终 schema/API/event/UAT spec 与服务 principal 权限合同待选择后冻结。                                                                                                                                                               |
| G2 — Source/TDD/Security          | `AMBER / PARTIAL / CURRENT_MAIN_CI_RED / HIGH_REMEDIATION_REQUIRED` | Current-main push run `33855198691` has 18 advisories versus baseline 10；PR #445/#446 exact-head checks are separate and are not reported as failed。Program B 仍 `NEEDS_FIXES`/coverage <80%；GrowthOS/New API/Platform Authority 缺 current exact-head final acceptance；Program C 未开始 TDD。 |
| G3 — Integration/Data             | `RED / NOT_INTEGRATED`                                              | An accepted A/B source seam exists, but there is no current-data runtime E2E and no Program C consumer/replay/restart/RLS/DSR proof.                                                                                                                                                               |
| G4 — Release Candidate            | `AMBER / DEVELOPMENT_CANDIDATE_ONLY`                                | 3 个 Bundle 均为 development `CANDIDATE`，没有可信外部 readback、完整 machine check、独立 reviewer 或用户发布授权。                                                                                                                                                                                |
| G5-Site — Runtime Observed        | `AMBER / TIME_LIMITED`                                              | 两条当前 PASS RuntimeEvidence 仅覆盖 Site Builder，绑定旧 runtime `674ff12d…`，并将在 `2026-09-05T03:49:25.000Z` 到期；健康不等于当前 main 已部署。                                                                                                                                                |
| G5-Acquisition — Runtime Observed | `RED / NOT_READY`                                                   | `PLATFORM_BUDGET_AUTHORITY_PLATFORM_ACQUISITION_MISSING`；11 条 traceability chain 中 Acquisition evidence set 为 0。                                                                                                                                                                              |
| G6 — UAT Accepted                 | `RED / NOT_RUN`                                                     | 没有关键用户旅程三次连续通过、受控重启恢复或产品 Owner 验收。                                                                                                                                                                                                                                      |
| G7 — Pilot/GA Authorized          | `RED / NOT_AUTHORIZED`                                              | 无 Pilot/GA 决策、有效跨仓 Release Bundle、外部 readback 或商业闭环。                                                                                                                                                                                                                              |

## 3. Development runtime observation

Observed `2026-09-04T18:32+08:00`：`/api/v1/health`、`/api/v1/health/build` 与 `/api/v1/health/ready` 均为 HTTP 200；`global-api`、`global-worker`、`temporal-dev`、`global-backend-growthos-relay` 均为 systemd `active/running` 且 `NRestarts=0`。Docker API restart count 为 0；Worker 为 1，原因仍 `UNKNOWN`。

完整脱敏字段见 [2026-09-04 platform-writer successor runtime readback](../evidence/site-builder/production-parity-platform-writer-runtime-readback-20260904.json)；[20260901 platform-writer receipt](../evidence/site-builder/production-parity-platform-writer-runtime-readback-20260901.json) 保留为 historical provenance。

| Surface                | Observation                                                                                                      | Meaning and limitation                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Runtime identity       | API/Worker 同一 exact OCI/source/artifact/migration；服务和 readiness 当前可响应                                 | 只证明 development 旧制品当前健康，不证明 current main、Pilot 或 production。                                      |
| Site capability        | `workspace_budget_authority=ok`；确定性 Intake/Release 历史 smoke 为零模型                                       | Site G5 有时限且仅限 evidence 所列能力。                                                                           |
| Acquisition capability | `platform_budget_authority=failed`，code=`PLATFORM_BUDGET_AUTHORITY_PLATFORM_ACQUISITION_MISSING`                | 获客运行 admission 未闭合；不能用 Site readiness 代替。                                                            |
| Listener exposure      | loopback: `127.0.0.1:3000`、`:3002`、`:3003`；wildcard: `0.0.0.0:3001`、`[::]:3001` 与 legacy Java `*:8080`      | 3001/8080 风险仍存在；本轮仅记录，不声称已关闭。                                                                   |
| Historical model Spend | `UNKNOWN/unknown`，reservation/conservative charge 均为 `800000`；attempts 1–5 `UNRESOLVED`，attempt 6 `EXPIRED` | `EXPIRED` 不产生 durable output、ACK 或精确费用；no second physical call or redispatch，且不得用重发掩盖 UNKNOWN。 |

## 4. Evidence and release inventory

RuntimeEvidence inventory is `6 total / 2 current / 4 historical`. 两条 current 记录均为 Site Builder-only PASS，绑定 commit `674ff12d4d768ce5599fc07b565fe21da37dc5fe`，共同到期 `2026-09-05T03:49:25.000Z`（Asia/Shanghai 11:49:25）；Acquisition evidence IDs 为 0。到期后自动成为 historical，不能继续支撑 G5。

There are 3 Release Bundles, all development `CANDIDATE`; each remains `EXTERNAL_UNVERIFIED`, machine `NOT_VERIFIED`, reviewer `NOT_REVIEWED`, and user `NOT_AUTHORIZED`. 这些字段是 documentary declaration，不是发布事实。

## 5. Main CI and security/readiness risks

| Surface                     | Current disposition                                                                                                                                                       | Evidence and limitation                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current-main push CI        | run `33855198691` is `FAIL`: production advisory baseline freshness found 18 advisories versus baseline 10, with 8 new exposures (`qs` 2, `fast-uri` 4, `browserslist` 2) | 不得写“main CI 全绿”；需要单独修复或受控 baseline 决策。                                                                                                                            |
| PR #446 post-merge security | additive remediation design exists；merged source 的独立 review 记录 H2                                                                                                   | retained principal install/runtime 未执行；same-process disposable controller、cluster marker/CAS、membership tuple、cluster identity 与 semantic `search_path` 仍待 source owner。 |
| Program B implementation    | active writer 正在修正 launcher/bootstrap trust findings                                                                                                                  | plan-only PASS、80/80 focused 或 dirty worktree 都不能升级实现结论。                                                                                                                |
| GrowthOS authority          | clean local source，54-patch authority，无 remote                                                                                                                         | 正式 remote/main/CI/CODEOWNERS、immutable release 与 runtime adoption 仍缺失。                                                                                                      |
| Runtime networking          | 3001 与 legacy 8080 wildcard                                                                                                                                              | 违反目标 loopback-only posture，需独立变更与运行 readback。                                                                                                                         |

## 6. Product path, next order and authorization queue

商业北极星主路径仍是：

`Onboarding → ICP → LeadQualifiedPackage → Opportunity → Human QGO → Feedback`

并行信任资产路径是：

`Quote → Grant → Build → Preview`

下一顺序是：（1）完成当前 Platform Authority/New API 与 Program B 修复并取得 clean exact-head 独立复核；（2）由产品负责人选择 Program C A/B，A（C1-COMPANY first）推荐；（3）冻结 Program C spec/owner/manifest 后按 RED→GREEN 实现；（4）获得 accepted seam、fresh Acquisition RuntimeEvidence、UAT 后才评估德国工业泵受控 Pilot。

仍需独立用户授权的动作包括：Program C A/B 产品选择；stable docs exact commit 的 push/PR；PR #446 additive remediation 的设计确认和 owner 分配；任何 push、PR、merge、retained migration、部署、listener 调整、真实 provider/模型/费用、OAuth/邮件或 Pilot。此前授权不自动延续。
