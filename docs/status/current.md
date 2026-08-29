# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[发布路线](../roadmap/release-plan.md)、[ADR registry](../adr/registry.md)、本页所列 exact Git/worktree 与 development-runtime 只读观察
> 最后核验：2026-08-29T17:08:17+08:00（Asia/Shanghai）

## 当前结论

`SOURCE_INTEGRATED_ALPHA / CROSS_REPO_PRODUCT_ASSEMBLY / USER_JOURNEY_NOT_VALIDATED / COMMERCIAL_LOOP_NOT_CLOSED / PRODUCTION_READINESS_BLOCKED`

本页是 Phase 0 的一次性 live baseline，不以旧构建、旧模型执行或旧 PR 叙事替代当前事实。历史 provenance 继续见[追加式 changelog](../roadmap/changelog.md)和[evidence 索引](../evidence/README.md)。本页中的 Git 结论是 source/provenance evidence；systemd 与监听结论仅是 development-runtime observation，不是部署、可用性、UAT、RuntimeEvidence PASS 或 Release Bundle 证明。

当前非运行时模型候选合同仍为 `site-builder-model-candidate-baseline/2026-08-07-v3`；它不是 active route、质量、dispatch、RuntimeEvidence 或发布证明。

## 1. Exact source baseline

| Subject | Exact head / state | Evidence class and limitation |
| --- | --- | --- |
| `/global/backend` root `main` | `HEAD=23d111f7b400403deb7466abf34ab709685b8376`; local `origin/main=23d111f7b400403deb7466abf34ab709685b8376`; clean at capture | Live local Git readback. This proves only this checkout and locally available remote-tracking ref; no fetch or remote readback occurred. |
| Phase 0 controller | `codex/global-product-program-phase0@23d111f7b400403deb7466abf34ab709685b8376`, `0 ahead / 0 behind` local `origin/main`; pre-existing untracked plan `docs/superpowers/plans/2026-08-29-global-product-program-phase0.md` is preserved | Live local Git readback. The controller is the only Phase 0 tracked-doc writer. |
| Program A | `/global/backend/.codex/worktrees/production-parity-capability-cutover`; `codex/production-parity-capability-cutover@fc6d78b5ce6bb11fc25ca381350f067766f77970`; clean; `51 ahead / 35 behind` local `origin/main` | Live local Git readback. Not a current-main acceptance claim. |
| Program B | `/global/backend/.codex/worktrees/pr407-raw-source-governance`; `codex/pr407-raw-source-governance@96e22e82009992aa20523a4d3075943b695f00c2`; clean; `0 ahead / 1 behind` local `origin/main`; configured `origin/codex/pr407-raw-source-governance` is `GONE` | Live local Git readback. A gone local tracking ref is not a PR or merge verdict. |
| Closeout plan | `/global/backend/.codex/worktrees/root-worktree-remote-closeout-plan`; `codex/root-worktree-remote-closeout-plan@3c9156d05ba6509c58bd4b806349fb5f07aef9a6`; clean; `28 ahead / 45 behind` local `origin/main` | Live local Git readback; provenance only. |
| GrowthOS local source | `/global/frontend/growthos-source`; `codex/production-parity-jwks-budget-grants@251dd1ecf15b1ebe58896027dc9c8a0d9d5ac8aa`; dirty paths: `scripts/materialize-and-build.mjs`, `scripts/materialize-and-build.spec.mjs`, `scripts/authority-builder.mjs`; untracked `node_modules/` content was not read | Live local Git readback. Status is `LOCAL_SOURCE_AUTHORITY_FOUND / REMOTE_CI_RELEASE_UNVERIFIED`; local source neither proves a remote release nor user availability. |

### Program RAG and ownership boundary

| Program | RAG | Current owner boundary | Phase 0 condition |
| --- | --- | --- | --- |
| A — authority/runtime primitives | RED | Owns generic Execution Authority, GovernedSubject/Relation primitives, Site Quote/Grant, OCI/runtime and unified RuntimeEvidence/Release; does **not** own RawSourceRecord, IdentityLink, CanonicalCompany business schema, Provider or Opportunity | `HOLD_OWNERSHIP`: the plan snapshot `Program A=6c3ca8a0 / RED-only` has drifted. Audit observed successor `655d1b8986950807b76c0005f20cc10e92ce2df7` adding migration `20260827200000_discovery_governed_materialization`, then current head `fc6d78b5ce6bb11fc25ca381350f067766f77970` adding its writer. All post-RED implementation is `QUARANTINED / HOLD_OWNERSHIP`; it is retained provenance, not accepted, reverted, or adopted. |
| B — Buyer Intelligence discovery | AMBER | Owns query receipt, raw source, Identity/Canonical, Provider/transport, discovery workflow and immutable `LeadQualifiedPackage`; does **not** own generic Grant/primitive, SaaS Opportunity or runtime deploy | Exact PR-worktree source captured; its upstream is gone. Task 2 must make the A/B producer/consumer/transaction split explicit before implementation. |
| C — SaaS handoff/commercial loop | RED | Owns server-side handoff consumer, receipt, QualificationSnapshot, Opportunity, QGO/SAO/CLOSED, SalesAcceptance, CommercialOutcome and Conversation linkage; it must commit before ACK and must not copy Buyer Intelligence SoR | No selected C1 implementation card or verified consumer/runtime path. Owner/assignee remains `UNKNOWN`/`UNASSIGNED`, not inferred from a branch. |

Fixed cross-program interface: `ExecutionAuthority → ToolOperationSubject → B-owned QueryReceipt → B-owned RawSourceRecord UUID → B-owned IdentityLink/CanonicalCompany UUID → A-owned append governed child/relation primitive → Domain ACK`.

## 2. Gate position

| Gate | Current verdict | Evidence and blocker |
| --- | --- | --- |
| G0 — ownership/interface | `HOLD_OWNERSHIP` | A/B three-way assertion audit, unique owner decision, quarantine review and active-writer/provenance correction are not complete. |
| G1 — product and document truth | `AMBER / DOC_TRUTH_SYNC_PENDING` | Phase 0 baseline exists; Task 4 still must align product, capability, object, scenario and frontend truth to the ownership decision. |
| G2 — source-integrated alpha | `AMBER / SOURCE_ONLY` | Exact local source heads are captured, but Program A/B interface acceptance and C consumer are not established. |
| G3 — user journey | `RED / NOT_VALIDATED` | No evidence of the required end-to-end user path, human QGO decision or user acceptance. |
| G4 — development runtime | `RED / DEGRADED` | API and Worker are restart-looping; no runtime recovery diagnosis or authorized mutation has occurred. |
| G5 — RuntimeEvidence | `RED / NO_CURRENT_PASS` | Governance verifier count at capture: `runtime_current=0`, `runtime_historical=0`; a service observation cannot substitute for valid RuntimeEvidence. |
| G6 — release/provenance | `RED / NO_RELEASE_BUNDLE` | Governance verifier count at capture: `release_bundles=0`; no independent external readback exists for promotion. |
| G7 — commercial loop | `RED / NOT_CLOSED` | Opportunity → human QGO → feedback/commercial outcome is not validated; Billing/Credits remains `DEFERRED / NOT_IMPLEMENTED`. |

## 3. Runtime observation — development only

Captured at the timestamp above by `systemctl show` and `ss -ltnp`; no service was restarted and no deployment was inspected.

| Surface | Observation | Meaning and limitation |
| --- | --- | --- |
| `global-api.service` | `ActiveState=activating`, `SubState=auto-restart`, `NRestarts=1850`, `ExecMainStatus=0` | Degraded development-runtime observation, not a healthy API proof. |
| `global-worker.service` | `ActiveState=activating`, `SubState=auto-restart`, `NRestarts=1850`, `ExecMainStatus=0` | Degraded development-runtime observation, not a consuming Worker proof. |
| `temporal-dev.service` | `ActiveState=active`, `SubState=running`, `NRestarts=0`, `ExecMainStatus=0` | Only the service-manager state is observed; this does not prove workflow execution. |
| `3000` | No listener observed | API reachability is not established. |
| `3001` | Docker proxy listens on `0.0.0.0:3001` and `[::]:3001` | Observed non-loopback exposure conflicts with the development-port policy; diagnose read-only before any mutation. |
| `3002` / `3003` | Docker proxy listens on `0.0.0.0:3002` / `0.0.0.0:3003` | Observed non-loopback exposure; not deployment proof. |
| `8080` | Java listens on `*:8080` | Observed wildcard listener; identity and external reachability are unverified. |

## 4. Product path and current priority

The first user result is not a raw-record count, build count or page count. The product path is:

`Onboarding → ICP → LeadQualifiedPackage → Opportunity → Human QGO → Feedback`

The parallel Site path is:

`Quote → Grant → Build → Preview`

It does not create Campaign, outreach, conversation execution, attribution, SaaS product UI or commercial acceptance state in this backend. Product Billing/Credits remains `DEFERRED / NOT_IMPLEMENTED`; `cap_microusd` is an execution safety envelope, not a customer billing feature.

**Next single highest-priority user result:** establish the Program C server-side handoff-consumer/service-principal and receipt contract so one immutable `LeadQualifiedPackage` can become a durable Opportunity candidate only after the G0 ownership boundary is selected. Until then, C1 is specification/TDD-only; no Discovery GREEN, actual pilot, runtime cutover, Provider wire or email sending is authorized.

## 5. Critical risks and external authorization queue

Critical risks are (1) Program A post-RED schema/writer provenance can collide with Program B Raw/Identity SoR if treated as accepted, (2) API/Worker restart loops and wildcard development listeners have no current diagnosis/remediation evidence, and (3) no validated user journey, current RuntimeEvidence or Release Bundle exists.

The following actions require separate explicit authorization and are not performed by this baseline: any service restart/configuration or listener remediation; retained migration or database mutation; provider/model/paid call; credential/JWKS/OAuth/email action; push, PR mutation, merge, deploy or external control-plane readback. Read-only runtime diagnosis is allowed; it cannot upgrade G3–G7.
