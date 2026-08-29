# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[发布路线](../roadmap/release-plan.md)、[ADR registry](../adr/registry.md)、本页所列 exact Git/worktree 与 development-runtime 只读观察
> 最后核验：2026-08-29T20:33:05+08:00（Asia/Shanghai）

## 当前结论

`SOURCE_INTEGRATED_ALPHA / CROSS_REPO_PRODUCT_ASSEMBLY / USER_JOURNEY_NOT_VALIDATED / COMMERCIAL_LOOP_NOT_CLOSED / PRODUCTION_READINESS_BLOCKED`

本页是 Phase 0 的一次性 live baseline，不以旧构建、旧模型执行或旧 PR 叙事替代当前事实。历史 provenance 继续见[追加式 changelog](../roadmap/changelog.md)和[evidence 索引](../evidence/README.md)。本页中的 Git 结论是 source/provenance evidence；systemd 与监听结论仅是 development-runtime observation，不是部署、可用性、UAT、RuntimeEvidence PASS 或 Release Bundle 证明。

当前非运行时模型候选合同仍为 `site-builder-model-candidate-baseline/2026-08-07-v3`；它不是 active route、质量、dispatch、RuntimeEvidence 或发布证明。

## 1. Exact source baseline

Phase 0 文档分支的固定施工基线是 `23d111f7b400403deb7466abf34ab709685b8376`；该 SHA 是 construction-base provenance，不是当前 documentation candidate head。精确本地候选由 Git 当前 HEAD 与冻结的 review/handoff packet 绑定，不嵌入本 tracked 页，因为一个 commit 无法稳定包含自身最终 SHA。

| Subject | Exact head / state | Evidence class and limitation |
| --- | --- | --- |
| `/global/backend` root `main` | `HEAD=23d111f7b400403deb7466abf34ab709685b8376`; local `origin/main=23d111f7b400403deb7466abf34ab709685b8376`; clean at capture | Live local Git readback. This proves only this checkout and locally available remote-tracking ref; no fetch or remote readback occurred. |
| Program A | `/global/backend/.codex/worktrees/production-parity-capability-cutover`; `codex/production-parity-capability-cutover@91cae351795cceced59893bcf552c2b502a4ebaa`; clean; `MERGE_HEAD=NONE`; `59 ahead / 0 behind` local `origin/main@23d111f7b400403deb7466abf34ab709685b8376` | Live local Git readback. This is the closed 41-commit audit packet, not a current-main acceptance claim; any later head/index/working-tree/merge movement reopens the delta audit. |
| Program B | `/global/backend/.codex/worktrees/pr407-raw-source-governance`; `codex/pr407-raw-source-governance@96e22e82009992aa20523a4d3075943b695f00c2`; clean; `0 ahead / 1 behind` local `origin/main`; configured `origin/codex/pr407-raw-source-governance` is `GONE` | Live local Git readback. A gone local tracking ref is not a PR or merge verdict. |
| Closeout plan | `/global/backend/.codex/worktrees/root-worktree-remote-closeout-plan`; `codex/root-worktree-remote-closeout-plan@3c9156d05ba6509c58bd4b806349fb5f07aef9a6`; clean; `28 ahead / 45 behind` local `origin/main` | Live local Git readback; provenance only. |
| GrowthOS local source | `/global/frontend/growthos-source`; `codex/production-parity-jwks-budget-grants@251dd1ecf15b1ebe58896027dc9c8a0d9d5ac8aa`; dirty paths: `scripts/materialize-and-build.mjs`, `scripts/materialize-and-build.spec.mjs`, `scripts/authority-builder.mjs`; untracked `node_modules/` content was not read | Live local Git readback. Status is `LOCAL_SOURCE_AUTHORITY_FOUND / REMOTE_CI_RELEASE_UNVERIFIED`; local source neither proves a remote release nor user availability. |

### Program RAG and ownership boundary

| Program | RAG | Current owner boundary | Phase 0 condition |
| --- | --- | --- | --- |
| A — authority/runtime primitives | RED | Owns generic Execution Authority, GovernedSubject/Relation primitives, Site Quote/Grant, OCI/runtime and unified RuntimeEvidence/Release; does **not** own RawSourceRecord, IdentityLink, CanonicalCompany business schema, Provider or Opportunity | `HOLD_OWNERSHIP`: writer inactivity, the clean/no-`MERGE_HEAD` exact packet, the post-`ed615d1b` delta classification, and the binding-ledger/provenance correction are complete at `91cae351795cceced59893bcf552c2b502a4ebaa`. Its first 35 post-`ed615d1b` commits are accepted PR #423/main ancestry (`KEEP_AS_MAIN_INTEGRATION_PROVENANCE`); `b57af498` is two-parent main-integration provenance; `fb65f25a`, `7db10915`, `58e151ba`, `f68b67ed`, `91cae351` are B-owned Activity/provider/receipt deltas located on the A branch, not accepted A work. Original Task 5.2 migration/writer commits `655d1b89`, `fc6d78b5`, `166b7507`, `ed615d1b` remain `QUARANTINED / HOLD_OWNERSHIP`: retained provenance only, not accepted, reverted, or adopted. `DiscoveryGovernedMaterializationWriter` production callers=`NONE`, but its tracked Prisma migration is deploy-runner-reachable, so the mega-branch remains unsafe to deploy. |
| B — Buyer Intelligence discovery | AMBER | Owns query receipt, raw source, Identity/Canonical, Provider/transport, discovery workflow and immutable `LeadQualifiedPackage`; does **not** own generic Grant/primitive, SaaS Opportunity or runtime deploy | Exact PR-worktree source captured; its upstream is gone. ADR-025/`DEC-GPP-001` 已明确 producer/consumer/transaction split；下一个 ownership 需求是一张从 current main 开始、具有唯一 writer 的 Program B successor/card/handoff，而不是将 A 分支上的 B-owned delta 当作已接纳实现。 |
| C — SaaS handoff/commercial loop | RED | Owns server-side handoff consumer, receipt, QualificationSnapshot, Opportunity, QGO/SAO/CLOSED, SalesAcceptance, CommercialOutcome and Conversation linkage; it must commit before ACK and must not copy Buyer Intelligence SoR | No selected C1 implementation card or verified consumer/runtime path. Owner/assignee remains `UNKNOWN`/`UNASSIGNED`, not inferred from a branch. |

Fixed cross-program interface: `ExecutionAuthority → ToolOperationSubject → B-owned QueryReceipt → B-owned RawSourceRecord UUID → B-owned IdentityLink/CanonicalCompany UUID → A-owned append governed child/relation primitive → Domain ACK`.

## 2. Gate position

| Gate | Current verdict | Evidence and blocker |
| --- | --- | --- |
| G0 — Truth & Ownership | `HOLD_OWNERSHIP` | `DEC-GPP-001`/ADR-025 remain fixed; writer inactivity, the clean/no-`MERGE_HEAD` `91cae351` packet, delta classification and binding ledger/provenance correction are complete. Remaining closure sequence: (1) dispose the quarantined deploy-runner-reachable migration/writer; (2) assign one unique current-main Program B successor/card/handoff carrying accepted current-main ADR-025/`DEC-GPP-001` authority; (3) obtain independent G0 readback after steps 1–2. Program B implementation/TDD is G2 and DB/RLS/replay or G3 integration is not a G0 closure condition. |
| G1 — Product/UX/Contract | `AMBER / SPEC_ALIGNED / MACHINE_CONTRACT_AND_IMPLEMENTATION_PENDING` | Task 4/product docs are complete. Remaining gaps include the Program C machine contract/source, formal capability manifest and release adoption, and user validation. |
| G2 — Source/TDD/Security | `AMBER / SOURCE_REVIEWED_NOT_ACCEPTED` | ADR-025/`DEC-GPP-001` ownership and interface are accepted, but the Program A quarantined source and B-owned deltas are not accepted as Program A implementation; Program C C1 TDD/security has not started; GrowthOS remote CI/release remains unverified. |
| G3 — Integration/Data | `RED / NOT_INTEGRATED` | No accepted A/B seam implementation, Program C consumer, durable handoff transaction, current-data integration or end-to-end integration evidence exists. |
| G4 — Release Candidate | `RED / NO_RELEASE_CANDIDATE` | No current release-candidate package, current PASS RuntimeEvidence or Release Bundle is present; governance count is `release_bundles=0`. |
| G5 — Runtime Observed | `RED / DEGRADED_NO_CURRENT_EVIDENCE` | API and Worker are restart-looping; governance count is `runtime_current=0`, `runtime_historical=0`. Service observation cannot substitute for valid RuntimeEvidence. |
| G6 — UAT Accepted | `RED / NOT_VALIDATED` | No evidence of an end-to-end user journey, human QGO decision, user acceptance or UAT. |
| G7 — Pilot/GA Authorized | `RED / NOT_AUTHORIZED` | No pilot/GA authorization, independent external readback or commercial-loop closure exists; Billing/Credits remains `DEFERRED / NOT_IMPLEMENTED`. |

## 3. Runtime observation — development only

Captured at the timestamp above by `systemctl show` and `ss -ltnp`; no service was restarted and no deployment was inspected.

| Surface | Observation | Meaning and limitation |
| --- | --- | --- |
| `global-api.service` | `ActiveState=activating`, `SubState=auto-restart`, `NRestarts=4195`, `ExecMainStatus=0` | Degraded development-runtime observation, not a healthy API proof. |
| `global-worker.service` | `ActiveState=activating`, `SubState=auto-restart`, `NRestarts=4195`, `ExecMainStatus=0` | Degraded development-runtime observation, not a consuming Worker proof. |
| `temporal-dev.service` | `ActiveState=active`, `SubState=running`, `NRestarts=0`, `ExecMainStatus=0` | Only the service-manager state is observed; this does not prove workflow execution. |
| `3000` | No listener observed | API reachability is not established. |
| `3001` | Docker proxy listens on `0.0.0.0:3001` and `[::]:3001` | Observed non-loopback exposure conflicts with the development-port policy; diagnose read-only before any mutation. |
| `3002` / `3003` | Docker proxy listens on `0.0.0.0:3002` / `0.0.0.0:3003` | Observed non-loopback exposure; not deployment proof. |
| `8080` | Java listens on `*:8080` | Observed wildcard listener; identity and external reachability are unverified. |

## 4. Other readiness and security gates

| Gate | Current disposition | Unique authority/history pointer and limitation |
| --- | --- | --- |
| Production dependency/advisory audit baseline | `UNKNOWN / REVALIDATION_REQUIRED` | The [2026-08-24 changelog entry](../roadmap/changelog.md#2026-08-24-production-parity-personal_data-cleanup-runtime-readback) is historical provenance only; no prior count is restored as current and the present lock/advisory set must be recaptured. |
| Live required ruleset / branch protection / Dependency Review / CodeQL configuration | `EXTERNAL_STATE_UNVERIFIED` | [Repository ruleset authority](../backend/ci-merge-automation.md#仓内-required-contexts-与外部-ruleset) states that repository files cannot prove live external enforcement; no external readback was performed in this Phase 0 fix. |
| Container / Compose / IaC supply-chain gate | `PARTIAL / REVALIDATION_REQUIRED` | The [dependency and security aggregate-gate sequence](../backend/ci-merge-automation.md#依赖与安全聚合门的启用顺序) is the authority pointer; source-side pieces do not prove a current complete required gate. |
| Application DB principal admission (`app_user`, non-owner/non-superuser/non-`BYPASSRLS`) | `UNVERIFIED / REVALIDATION_REQUIRED` | Source/history exists, but [the current architecture gap register](../architecture/current.md#8-as-built-缺口登记已核验8-项) does not provide target-runtime admission evidence. |
| Target PostgreSQL/Temporal, real SaaS JWKS/token and cross-workspace negatives | `RUNTIME_UNVERIFIED / REVALIDATION_REQUIRED` | The [risk-trigger verification matrix](../backend/ci-merge-automation.md#风险分级决定验证深度不授予自动合并) requires target DB/RLS and JWKS/workspace negative evidence; none was produced here. |

These dispositions do not resolve or supersede the current API/Worker restart-loop and wildcard-listener observations above.

## 5. Product path and current priority

The first user result is not a raw-record count, build count or page count. The product path is:

`Onboarding → ICP → LeadQualifiedPackage → Opportunity → Human QGO → Feedback`

The parallel Site path is:

`Quote → Grant → Build → Preview`

It does not create Campaign, outreach, conversation execution, attribution, SaaS product UI or commercial acceptance state in this backend. Product Billing/Credits remains `DEFERRED / NOT_IMPLEMENTED`; `cap_microusd` is an execution safety envelope, not a customer billing feature.

**Next single highest-priority user result:** establish the Program C server-side handoff-consumer/service-principal and receipt contract so one immutable `LeadQualifiedPackage` can become a durable Opportunity candidate only after the G0 ownership/provenance hold closes. C1 begins as G2 Source/TDD/Security work and must satisfy G3 Integration/Data before it can support the user journey; no Discovery GREEN, actual pilot, runtime cutover, Provider wire or email sending is authorized.

## 6. Critical risks and external authorization queue

Critical risks are (1) Program A post-RED schema/writer provenance can collide with Program B Raw/Identity SoR if treated as accepted, (2) API/Worker restart loops and wildcard development listeners have no current diagnosis/remediation evidence, and (3) no validated user journey, current RuntimeEvidence or Release Bundle exists.

The following actions require separate explicit authorization and are not performed by this baseline: any service restart/configuration or listener remediation; retained migration or database mutation; provider/model/paid call; credential/JWKS/OAuth/email action; push, PR mutation, merge, deploy or external control-plane readback. Read-only runtime diagnosis is allowed; it cannot upgrade G5–G7 or substitute for G3 integration, G4 release-candidate, or G6 UAT evidence.
