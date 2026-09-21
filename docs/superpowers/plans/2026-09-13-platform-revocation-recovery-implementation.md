# Platform revocation recovery implementation

> 生命周期：`APPROVED`
> 生命周期依据：上述规格的实施计划，进行中

## Goal and authority

Recover an already-authorized schedule disable across missing target, command expiry and lost ACK without issuing replacement Grants, advancing a second fence, changing original authorization or inventing completion.

Binding authority: [user-approved recovery specification](2026-09-13-platform-revocation-recovery-approved-spec.md). The original proposal's pending-approval wording is historical; user approval is recorded in the linked header. U1-U5 still require factual verification. The worktree starts at `c0dff60a59b9f0153cca9c7e094cfd0f7c8df08c`; later unrelated main changes are integrated deliberately. Existing receiver work remains in its own worktree and is not overwritten.

One product implementation across environments. No customer Billing/Credits, extra model calls, target-free fence, old-row deletion, auto issuer backfill or deployment claims. Unknown legacy authorization remains `RECOVERY_BINDING_UNPROVEN` and pending.

## R1 — Closed lookup and service identity contracts

Ownership: Backend `packages/contracts/src/platform-authority/` lookup contract and focused contract tests. Reuse existing revocation issuer/UUID/schedule validators through shared pure schemas without widening accepted revoke/ACK values. Do not change revoke/ACK wire schemas.

Deliver: closed lookup tuple/nonce and successful observation schemas; fixed reader JWT type/audience/scope and closed claims. Payload parsing is not signature evidence. Enforce the approved byte/time/identity limits at their owning boundary; schemas must not imply that a `found` response is fence success.

RED/GREEN: extra fields, wrong family, bad UUID/nonce, numeric overflow and invalid TTL fail; legal tuple/claims pass; all existing revoke/ACK negative tests remain unchanged and passing. Signature/freshness/tenant checks belong to R2 and cross-language R4, not a fake verifier in R1.

## R2 — Read-only Backend lookup boundary

Ownership: Backend `apps/api/src/platform-authority/` dedicated reader verifier/controller/repository; additive migration in `packages/db/prisma/migrations/`; focused PostgreSQL tests in `packages/db/test/`; code-first OpenAPI regenerated from the controller.

Dependencies: R1. Inspect the existing platform-writer module/principal boundary before injecting it. No owner/app-user fallback or new principal privilege inferred from a generic API connection.

Deliver: parameterized exact lookup for committed platform Grant authority, including expired/revoked locators; fixed SECURITY DEFINER search path and exact EXECUTE grant only to the existing authorized platform writer. Dedicated JWT verifier must bind server configuration, issuer mapping, fixed subject/type/audience/scope and strict time. Do not extend ordinary roles or quote-token permissions. Atomic identity rate limiting, bounded request/response/error, no-store and zero provider/Workflow/authority mutations.

Use one request deadline across key acquisition, verification, rate limiting and DB lookup, not a fresh two-second allowance per layer. Verify strict token expiry again after asynchronous signature/key work, before DB access. Allocate the remaining deadline to transaction acquisition/statement timeout and discard late results; do not copy the existing ACK repository's 5.5-second transaction window. A cold/unavailable JWKS or exhausted deadline must fail before querying the target.

Keep the readonly recovery operation independent of aggregate business-Worker readiness so it cannot deadlock behind the very pending revocation it must recover. That does not waive runtime release admission, dedicated identity verification, its own DB principal or atomic limiter readiness. Register only the exact readonly operation and cover its controller/authz/admission classification with tests; no general POST or ordinary identity bypass.

RED/GREEN: unauthenticated/wrong-family requests fail before DB; exact found versus not-found versus unavailable remain distinct; wrong issuer/schedule/run and tenant authorities are not visible. Disposable PostgreSQL verifies grants/search-path and before/after zero business writes. Legacy revoke receipt/fence semantics remain unchanged.

## R3 — Durable request/attempt recovery model

Ownership: existing GrowthOS single writer `/root/.codex/worktrees/growthos-platform-authority-20260908`, replayable patch stack only. No direct authority archive modification. First materialize exact archive/patches, inspect 0099 and original disable authorization, then add forward-only changes.

Deliver: immutable request binding, append-only attempt predecessor/ordinal, observation, fair durable cursors, one effective pending attempt and exact historical ACK binding. Preserve old outbox bytes/ciphertext; only map legacy data whose original authorization and signature bindings are proven. Unproven legacy requests stay quarantined/pending and are counted in backlog. New requests persist issuer, schedule-wide reason and creation policy provenance.

RED/GREEN: two recovery instances, ACK-versus-successor races, attempt expiry, immutable history, wrong issuer/request/sequence and unknown legacy bindings. Real disposable MySQL validates uniqueness/append-only/transaction rollback and old NO_TARGET snapshot compatibility. No HTTP while holding policy locks.

## R4 — Fixed service identity, TLS client and consumer

Ownership: GrowthOS signing composition, fixed HTTPS lookup transport, independent recovery consumer and capability fact producer. Backend transport endpoints stay owned by R2. Freeze cross-language vectors and verify with the real Java signer and Backend verifier.

Dependencies: R1-R3 and verified deployment prerequisite inventory. Use existing identity root only through a server-owned fixed-purpose provider; ordinary user/quote/Grant tokens are not substitutes. Retained HTTPS origin, CA/hostname, proxy behavior and key verification/decryption retention must be explicitly verified. Do not silently downgrade to loopback HTTP/Unix.

Deliver: bounded no-redirect lookup, request nonce/tuple/freshness binding; original-byte historical ACK replay before new signing; exp+60s successor only with fresh monitored clock-health facts, no still-valid attempt and unchanged original request. Clock health unknown disables successor but permits original-byte ACK readback. Fair recovery limits and original-request backlog age follow the approved spec, not a new retry policy.

RED/GREEN: TLS wrong CA/hostname/redirect/oversize/timeout; service identity substitution; W1/W2/W3 and cross-database commit/ACK loss windows; valid old-attempt ACK; actual receipt/generation increments exactly once; unavailable key/clock/transport remains pending. Host `NTPSynchronized=yes` alone is not product clock-health evidence.

## R5 — Integration, publication and runtime acceptance

Dependencies: relevant hosted CI and independent review for R1-R4, native Temporal publication/admission completion, unambiguous platform/customer Worker and lease composition. Do not assume the current mixed Worker can move namespace by configuration alone.

Before cutover: inspect actual legacy request inventory without exporting raw data, backups, additive migrations, credential-use boundaries, key retention and monitored clock evidence. Stop old consumer before new attempt semantics are enabled; verify new exact identity before resuming. No destructive rollback or fence re-enable.

Run the original three deterministic product journeys including controlled restart, Grant/auth negative cases and settlement no-resend cases. Generate RuntimeEvidence/Release Bundle only after exact source/image/artifact/migration/lease/queue and cross-repo facts pass. Evidence and docs keep technical/source/deployment/UAT/Pilot states distinct.

## Required verification and remaining prerequisites

For changed scopes: >=80% line/branch coverage, unit and true disposable PostgreSQL/MySQL integration, API/contracts build and OpenAPI diff, governance/docs/ContractGraph, secret and supply-chain checks, independent diff/security review. Reuse unchanged exact evidence; never skip a required gate.

U1-U5 are investigation tasks, not permission to invent facts. In particular, current code has signing primitives but no complete dedicated reader-token composition; clock and key-retention product gates need implementation/readback; legacy rows without durable original authorization cannot be reconstructed from current config. If verification requires a different trust root, target-free effect or broader privilege, pause only that delta for a concrete security decision.
