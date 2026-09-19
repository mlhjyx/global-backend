# Qualification feedback receiver

Base:04e1acc489838ff99b8300ee6cc93e794fd57564.
Branch:codex/qualification-feedback-receiver-20260919. Root owns new receiver,
Prisma/migration and composition; contract worker owns only decoder/schema/tests.
The read-only worktree audit found no dirty overlap for these paths. Existing
unknown worktrees and root .playwright-cli remain untouched.

Receive the approved Program C reference-only qualification event, persist an
immutable workspace-scoped receipt/feedback fact, and provide a readback endpoint.
No Lead state, score, ICP label, QGO or Opportunity lifecycle is changed.

Authorization uses existing AuthGuard/JWKS and acquisition:label:write scope,
plus fixed verified subject growthos-qualification-feedback. It grants no new
role mapping or credentials. Browser human subjects cannot use this endpoint.
Workspace is derived from the signed token and must match the event.

Strict event: schemaVersion qualification-feedback-reference/v1, eventType
QUALIFICATION_DECISION_RECORDED, producer growthos-saas, event/workspace/
opportunity/lead/decision UUIDs, positive decimal-string int64 revision,
REJECTED|CORRECTED, UTC occurredAt. No free-text reasons or actor claims.
Canonical digest includes every field; retries with the same event and digest
return the original receipt. Event/decision/revision identity conflicts fail.

Prisma transaction runs under existing withWorkspace(app_user+FORCE RLS).
Lock and validate Company before Lead, revalidate their binding, refuse
suppressed/deleted references, insert receipt
with unique identity constraints, and return only after commit. Unknown commit
is unavailable, not success; status readback reports the stored receipt or
NOT_RECEIVED without causing a write. No automatic resubmission is introduced.

Acceptance: RED/GREEN decoder/auth/service/HTTP tests; disposable PostgreSQL16
RLS, concurrency, conflict, commit/error and deletion cascade tests; generated
OpenAPI, relevant lint/build, docs/governance and independent review. No retained
migration, scope provisioning, outbound delivery, deployment or Pilot in this card.

Implementation and review evidence, reproducible commands and the remaining
integration boundary are recorded in
[the local candidate handoff](../../implementation-records/qualification-feedback-receiver.md).
