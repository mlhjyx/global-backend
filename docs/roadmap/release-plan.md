# roadmap/release-plan —— 稳定产品主线与发布门（L2）

> 文档 ID：`DOC-ROADMAP-001`
> 生命周期：`CURRENT`
> 当前事实来源：[当前状态](../status/current.md) · [as-built 架构](../architecture/current.md)。
> 2026-07-10 v2（获客合流定稿）；2026-07-27 模型候选重基线更新；2026-09-04 产品顺序与 currentness 分离更新。历史实施日志见 [changelog.md](changelog.md)。

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
4. **Pilot 3-A:** after the required gates pass, run one separately authorized internal Germany industrial-pump importer/procurement pilot using TED, GLEIF and exact official sites only; keep the bounded zero-model, zero-paid and zero-send envelope.
5. **Site 3-B:** complete the parallel SaaS `Session → Quote → Grant → Build → Preview` vertical; Publish, Domain, Inquiry, Analytics and Design Editor remain later scope.
6. **MVP-2:** add Campaign minimum state and one approved email provider only after MVP-0/MVP-1 and separate OAuth/send authorization.
7. **Later:** Site Publish, Buyer R2, Agent Operation Contract, a second mail provider, social/WhatsApp, attribution and multi-industry/agency.

### Concurrency and authorization boundaries

- No more than two implementation programs may run in parallel. Program C contract/spec may proceed after its prerequisites are accepted; cross-repository integration waits for accepted producer-consumer interfaces, while the Site vertical may parallel Program B.
- Discovery implementation, runtime mutation, Pilot and release promotion remain gated by their corresponding G0–G7 evidence.
- Push, PR mutation, merge, deployment/restart, retained migration, provider/model/paid call, OAuth/email send and credential changes each require separate exact authorization.
- Model-candidate visibility is governed by the generated [candidate baseline](../site-builder/model-candidate-baseline.md), machine ID `site-builder-model-candidate-baseline/2026-08-07-v3`; it does not authorize route adoption, dispatch or deployment.
- A passing local or hosted test is not runtime evidence; RuntimeEvidence is not a Release Bundle; neither implies UAT, Pilot or GA authorization.

## Historical supersession index

- **HISTORICAL / SUPERSEDED — 2026-07 R0-R3 Campaign/email-first sequence:** the dated proposal ordered Buyer Intelligence closeout → Campaign control plane → controlled email → Inbox/QGO → Outcome/attribution. [PDR-004](../adr/registry.md) supersedes that scheduling order: MVP-1 establishes durable Opportunity and human QGO first; MVP-2 introduces one approved email provider only after MVP-0/MVP-1 and separate OAuth/send authorization.
- Dated Site Builder/model/provider execution records, exact commits, manifests, wire/cost observations and former owner/next-step statements are not duplicated in this CURRENT roadmap. Their provenance remains recoverable through Git history, [changelog](changelog.md) and the [evidence index](../evidence/README.md); their live interpretation always comes from [current status](../status/current.md).
