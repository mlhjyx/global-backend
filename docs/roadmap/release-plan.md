# roadmap/release-plan —— 稳定产品主线与发布门（L2）

> 文档 ID：`DOC-ROADMAP-001`
> 生命周期：`CURRENT`
> 当前事实来源：[当前状态](../status/current.md) · [as-built 架构](../architecture/current.md)。
> 2026-07-10 v2（获客合流定稿）；2026-07-27 模型候选重基线更新；2026-09-04 产品顺序与 currentness 分离更新。历史实施日志见 [changelog.md](changelog.md)。
>
> **2026-10-14 覆盖说明（先读）**：下方「Ordered delivery」的 MVP-0 / MVP-1 / Pilot 3-A / Site 3-B / MVP-2 顺序，以及「Concurrency and authorization boundaries」里 Pilot 3-A 的范围与上限，已被产品负责人 2026-10-10 / 2026-10-11 的决定与 PRD 4.0（L2「能力路线图与 Release 门」，目前在私有目录，入库待 PRD4-D10）的 RL1–RL6 覆盖，只作历史产品序列保留，直到 PRD 4.0 入库后本页收缩。Pilot 3-A 写的「zero model / paid / send」与「named-person collection disabled」**不再是当前约束**：RL1 的发现与评分使用真实模型调用（产品请求由 SaaS 签发的 Budget Grant 授权）；2026-10-11 产品负责人决定保留个人数据路径（具名个人邮箱与姓名、决策人、SMTP 探测、展会来源），风险自担，改为如实计数（PRD4-D16）。仍然有效的是：RL1 不做任何发送；G0–G7 的定义与下方逐项授权的边界不变。当前 Release 与执行事实只看[当前状态](../status/current.md)。
>
> **PRD 4.0 Release 结构**（只列结构与退出指标名称；范围、门槛与时间以 PRD 4.0 为准，并行度不超过两条线）：
>
> - **RL1 线索试点**（当前 Release）：一个 ICP、一个国家、一个品类，Managed 周报交付。退出指标：真实产出、精度、可达、证据、成本、商机、合规、节奏。
> - **RL2 可达与合规**：每条线索有合法联系路径与「为什么现在」，加第二个 ICP / 国家。退出指标：两个 ICP 的周报、推荐精度、建议联系路径覆盖、LIA 签署。
> - **RL3 商机与反馈**：QGO 宿主落地（宿主待 PRD4-D4），客户在页面上判断，结果回流评分。退出指标：月度 QGO 数、7 天 Outcome 回写率、客户独立完成判断。
> - **RL4 受控触达**：用户授权的单一发送渠道。退出指标：投诉率、退信率、回复进入 Conversation。
> - **RL5 对话与 Inbox**：回复识别 → Conversation → 商机候选。退出指标：一个渠道闭环。
> - **RL6 内容与站点**：Site Builder 作为「被找到」的信任资产按条件复活。退出指标：客户主动要求（触发条件）。
> - **X 减负线**（与 RL1–RL2 并行）：冻结 Site / R4、门改 lint、文档归档、缩短 CI。退出指标：每 PR 固定开销。

## Stable product sequence

This document owns the stable product sequence and gate definitions; it does not own a live phase verdict, branch/PR head, runtime observation or authorization state. Live gate verdicts and time-bound execution facts are maintained only in [current status](../status/current.md).

The stable product spine is `Onboarding → ICP → LeadQualifiedPackage → Opportunity → Human QGO → Feedback`; the parallel Site spine `Quote → Grant → Build → Preview` does not replace QGO.

The first Job is evidence-backed overseas importer/procurement discovery for Chinese B2B manufacturing, trade-integrated and high-ticket exporters. Human QGO is the north star. Dealer recruitment, Campaign, social/publishing, analytics, Agent auto-send, Site Publish/Domain/Inquiry/Analytics and customer Billing/Credits are outside this critical path. Billing/Credits is `DEFERRED / NOT_IMPLEMENTED`; `cap_microusd` is an execution safety envelope, not customer billing.

### Program boundaries

- Program A owns generic Execution Authority, GovernedSubject/Relation primitives, Site Quote/Grant and runtime/release foundations; it does not own Raw/Identity/Provider or Opportunity.
- Program B owns query receipt, Raw/Identity/Canonical, Provider/transport, Discovery workflow and the immutable `LeadQualifiedPackage`; it does not own generic Grant primitives, SaaS Opportunity or runtime deployment.
- Program C owns the server-side package consumer, QualificationSnapshot, Opportunity/QGO/SAO/CLOSED, SalesAcceptance, CommercialOutcome, Conversation linkage and commit-before-ACK; it does not duplicate Buyer Intelligence source-of-record state.
- [ADR-025](../adr/registry.md) and [`DEC-GPP-001`](../governance/conflict-register.md) are authoritative for the detailed seam. Task disposition, exact commits, merge/readback facts and live blockers remain in [current status](../status/current.md) and append-only history.

### Stable G0-G7 definitions

The G0–G7 meanings below are stable. Their current verdicts are intentionally absent from this roadmap and must be read from [current status](../status/current.md).

| Gate                     | Stable proof                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G0 — Truth & Ownership   | Binding plans, current authority, single-writer ownership, schema/migration boundaries and accepted seams are explicit.                                      |
| G1 — Product/UX/Contract | Persona, journey, source of record, state, permission, error, API/event contract and UAT criteria are reviewable.                                            |
| G2 — Source/TDD/Security | RED/GREEN evidence, relevant coverage, negative/mutation checks and independent correctness/security review are bound to the exact source.                   |
| G3 — Integration/Data    | Disposable-database/RLS proof, migration parity, Temporal replay, golden vectors and idempotent producer-consumer integration are verified.                  |
| G4 — Release Candidate   | Clean exact commits, hosted CI, reproducible artifacts/images, SBOM and a tested rollback input form one candidate.                                          |
| G5 — Runtime Observed    | Exact runtime identity, migrations, leases/readiness and fresh RuntimeEvidence prove the candidate running in the named environment.                         |
| G6 — UAT Accepted        | Critical user journeys execute successfully in three consecutive runs, including controlled restart/recovery, and the product owner accepts the user result. |
| G7 — Pilot/GA Authorized | A current Release Bundle, trusted external readback, explicit user authorization, monitoring and rollback are all present.                                   |

### Ordered delivery

1. **Phase 0 — Truth and ownership:** establish current authority, Program A/B/C ownership and accepted interfaces before any product implementation; live completion and merge/readback facts remain in [current status](../status/current.md).
2. **MVP-0:** accept Program A current-main slices, establish formal GrowthOS source/Builder/remote/CI, recover Backend runtime and expose authentic capability availability/onboarding.
3. **MVP-1 — Program C:** establish the service principal, durable package handoff with commit-before-ACK, Opportunity aggregate, Human QGO, SalesAcceptance/Outcome feedback and Conversation linkage.
4. **Pilot 3-A:** after the required gates pass, run one separately authorized internal Germany industrial-pump importer/procurement pilot using TED, GLEIF and exact official sites only; caps are 50 raw / 30 canonical / 10 enrich / 5 review / 3 packages, zero model / paid / send, and 0–3 honest results.
5. **Site 3-B:** complete the parallel SaaS `Session → Quote → Grant → Build → Preview` vertical; Publish, Domain, Inquiry, Analytics and Design Editor remain later scope.
6. **MVP-2:** add Campaign minimum state and one approved email provider only after MVP-0/MVP-1 and separate OAuth/send authorization.
7. **Later:** Site Publish, Buyer R2, Agent Operation Contract, a second mail provider, social/WhatsApp, attribution and multi-industry/agency.

### Concurrency and authorization boundaries

- Pilot 3-A remains one internal Workspace. Restricted providers, Patents, SAM, email guessing and named-person collection are disabled. Each accepted package reaches a unique Opportunity; at least one candidate receives a human QGO judgment (confirmation or structured rejection), with no unauthorized action, duplicate physical call or lost evidence. An honest zero-result run does not itself satisfy the human-review exit.
- MVP-1 requires a local controlled fixture to complete `Package → Opportunity → human QGO decision → feedback`, replay/concurrency ten times without duplicates, and no ACK before confirmed local commit. Real Provider or email dispatch is not a dependency for this local exit.
- Site 3-B must preserve the old Preview after a failed new Build, and correctly expose unknown result, cancellation and recovery. Current-release identity and RuntimeEvidence remain required; unsigned-dev cannot substitute for the product path.
- UAT requires three consecutive critical-journey passes including a controlled restart, no remaining S1/S2, an owner/deadline for each S3, and product-owner acceptance of the user result.

- No more than two implementation programs may run in parallel. Program C contract/spec may proceed after its prerequisites are accepted; cross-repository integration waits for accepted producer-consumer interfaces, while the Site vertical may parallel Program B.
- Discovery implementation, runtime mutation, Pilot and release promotion remain gated by their corresponding G0–G7 evidence.
- Push, PR mutation, merge, deployment/restart, retained migration, provider/model/paid call, OAuth/email send and credential changes each require separate exact authorization.
- Model-candidate visibility is governed by the generated [candidate baseline](../site-builder/model-candidate-baseline.md), machine ID `site-builder-model-candidate-baseline/2026-08-07-v3`; it does not authorize route adoption, dispatch or deployment.
- A passing local or hosted test is not runtime evidence; RuntimeEvidence is not a Release Bundle; neither implies UAT, Pilot or GA authorization.

### Final service acceptance

The original Buyer Intelligence final-service “封版” acceptance remains a capability target, not a current PASS: (1) Company/Offering/ICP produces a controlled Candidate Batch; (2) company/contact facts carry Canonical IDs, source, Evidence, rights, freshness, verification, cost and unknowns; (3) candidates expose decomposed scores and reason codes; (4) accept/reject/correct feedback reaches evaluation without cross-tenant leakage; (5) cancellation/retry/Partial/budget stop/provider degradation/fair scanning are supported; (6) OpenAPI/events/progress, RLS, deletion, audit, tests and SLO are verified; (7) real-company examples pass E2E/UAT; (8) the output contract is genuinely consumed downstream, not merely persisted. Docling/Langfuse are not mandatory gates. Phasing follows the current roadmap: Buyer R2 fair-cursor/Golden Set expansion stays later and is not made a new prerequisite for the bounded Pilot. The former schedule and dated completion annotations remain recoverable from Git commit `8eefba1cff15f2bbe4154451cac958a072803ab5`.

## Historical supersession index

- **HISTORICAL / SUPERSEDED — 2026-07 R0-R3 Campaign/email-first sequence:** the dated proposal ordered Buyer Intelligence closeout → Campaign control plane → controlled email → Inbox/QGO → Outcome/attribution. [PDR-004](../adr/registry.md) supersedes that scheduling order: MVP-1 establishes durable Opportunity and human QGO first; MVP-2 introduces one approved email provider only after MVP-0/MVP-1 and separate OAuth/send authorization.
- Dated Site Builder/model/provider execution records, exact commits, manifests, wire/cost observations and former owner/next-step statements are not duplicated in this CURRENT roadmap. Their provenance remains recoverable through Git history, [changelog](changelog.md) and the [evidence index](../evidence/README.md); their live interpretation always comes from [current status](../status/current.md).
