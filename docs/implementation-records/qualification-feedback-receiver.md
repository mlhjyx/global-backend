# Qualification feedback receiver — local candidate

Base: `04e1acc489838ff99b8300ee6cc93e794fd57564`.
Branch: `codex/qualification-feedback-receiver-20260919`.
This record describes isolated source and disposable tests, not main adoption,
retained migration, runtime readiness, release, UAT or Pilot.

## Product boundary

Buyer receives an immutable reference to a human SaaS qualification decision.
It does not repeat that decision or change Lead status, score, ICP labels,
Opportunity, QGO or SAO. REJECTED/CORRECTED is a recorded source fact, not an
automatically interpreted learning label. Free text and actor data stay at the
SaaS decision reference.

The predecessor producer is Program C handoff commit
`de2fe9afad0cb8cd86cdd65509e1150ddfd67813`, with qualification producer patch
SHA-256 `74468d2ef3783f3286fd6c41ba594978dad3c15302bf218d3927c3bdf1eadb5e`.
Its private outbox is not itself a network sender. This candidate defines the
receiver wire; sender mapping, durable dispatch and reconciliation remain open.

## Source and API

- [Controller](../../apps/api/src/qualification-feedback/qualification-feedback.controller.ts)
  defines `QualificationFeedbackController_receive_v1` and
  `QualificationFeedbackController_receipt_v1`. Use generated OpenAPI as the
  route/schema authority; do not hand-copy endpoint inventories.
- [Contract](../../apps/api/src/qualification-feedback/qualification-feedback.contract.ts)
  validates all eleven fields, rejects extra fields, preserves decimal int64
  revision and UTC timestamp precision, and hashes a fixed-order canonical event.
- [Service](../../apps/api/src/qualification-feedback/qualification-feedback.service.ts)
  enforces verified subject `growthos-qualification-feedback` and existing
  `acquisition:label:write` scope. Token Workspace must match the body.
  No credentials, signing keys or role-to-scope mapping are provisioned here.
- [Migration](../../packages/db/prisma/migrations/20260919160000_qualification_feedback_receipt/migration.sql)
  creates workspace-scoped uniqueness for event, decision and
  Opportunity/revision; a composite Lead FK; FORCE RLS; and immutable receipts.

New receipts lock Company before Lead and revalidate the Lead/company reference.
This serializes admission with company freezing, including the interval before
asynchronous Lead suppression. Existing exact replays return the original
receipt without creating new data. Identity/digest conflicts fail closed.

The service awaits transaction commit before returning RECORDED. Commit failure
returns bounded unavailability, never a positive acknowledgment. Readback is
read-only. NOT_RECEIVED means absent at that observation; deletion can remove a
previous receipt, so absence is not proof of never having received the event and
does not authorize a new event identity or blind retransmission.

Receipt deletion follows the existing Lead cascade. Full retention, legal hold,
backup/restore deletion replay and real-data activation are separate integration
gates; this receipt does not certify the complete privacy lifecycle.

## Verification and review

- Contract RED then GREEN: 85 tests, 100% statement/branch/function/line coverage.
- Company-freeze regression: unit/HTTP RED with five failing cases, then
  29 passing tests; service line/function/statement coverage 100%, branches 97.95%.
- Real PostgreSQL regression: original service passed seven cases and failed the
  two new company-freeze cases. Corrected service passed all ten cases, including
  both real lock interleavings, ten concurrent duplicate receives, FORCE RLS,
  conflicting identities, deletion cascade and a deferred commit-time failure.
- The UUID trailing-newline review concern was rejected by direct Node and HTTP
  evidence: the original validator returned 400. Regression tests remain.
- Code-first OpenAPI and ignored generated TypeScript client were regenerated.
  Contract lint has zero errors; existing tag warnings and this module's two
  missing-global-tag warnings remain nonblocking documentation warnings.
- Copy eligibility was mechanically regenerated after the Prisma change and
  its current fingerprint references synchronized. It remains STALE_HOLD,
  NOT_AUTHORIZED and BLOCKED; no fixed-source runtime binding was promoted.
- Full API run: 491 files passed, nine skipped, two failed; 8,033 tests passed.
  The failures were the unchanged Build golden-fixture beforeAll timeout (10s)
  and unchanged 1,000-child browser soak timeout (120s). The same two files then
  passed all 61 tests with `--maxWorkers=1`, without source/timeout changes.
  This is successful targeted recovery, not a second all-green full-suite run.
- API build, contracts build, docs/governance, focused TypeScript ESLint,
  harness syntax and diff whitespace checks passed. Docs retain one pre-existing
  Site Builder table warning. OpenAPI regeneration was byte-identical at
  `a4d826a00d099586db6f6c0b836d8a2d1ca0710d1b0f2950cf015addc8c8679c`.
- ContractGraph scan/check and impact query passed with zero errors. Its static
  receiver→module→AppModule and Prisma impact paths are not runtime observations.
- Independent source and final staged-artifact review closed the company-freeze
  finding and found no remaining blocker in this candidate. Reviewed service
  SHA-256: `7d976fab7d47389dd1273a0746ce11aedd532e37518beb92fb5cc15fb7c5a06f`.

Reproduce the database cases with
`node scripts/verify-qualification-feedback-receiver.mjs`. It uses the cached
PostgreSQL 16 image digest, explicit local Docker context, no network/TCP port,
a private Unix socket, tmpfs database and bounded owner-specific cleanup. Tests
use the actual PrismaService and receiver migration with explicitly minimal
Company/Lead parent tables. This is not full migration-history parity.

## Remaining integration gates

1. SaaS sender: lossless private-outbox-to-wire mapping, durable dispatch identity,
   response-loss readback, no lease-expiry resend and exact receipt verification.
2. Service identity issuance and runtime role mapping under a separately owned
   deployment configuration; no human/browser permission expansion.
3. Cross-repository fixture journey, complete migration history, data-rights and
   retention/restore verification, reviewed main adoption and immutable release.
4. Current runtime evidence, repeated user journey UAT, and separately recorded
   Pilot authorization. Receipt storage alone does not close the learning loop.

Rollback before adoption is to not apply this isolated candidate. After adoption,
disable the sender/ingress through controlled deployment configuration and retain
receipts for reconciliation; do not drop the table to simulate rollback.
