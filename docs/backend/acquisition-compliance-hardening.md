# Acquisition compliance runtime contract

Status: source-level contract only. No migration, backfill, database role probe,
service restart, provider call, or pilot data operation is evidence of this
document by itself.

## Application database admission

`APP_DATABASE_URL` is the only application connection accepted in `pilot` and
`production`. `DATABASE_URL` remains a development compatibility fallback and
an explicit owner/maintenance input; it is never a pilot/production fallback
for `PrismaService`.

After connecting, the API and Temporal worker query PostgreSQL catalog facts
and fail closed unless the application role is all of the following:

- not a superuser;
- not `BYPASSRLS`;
- not a member of the database owner role;
- not an owner/member of any application relation owner role.

The role probe returns only role capability booleans. It does not return or log
the connection URL. Pilot/production startup also validates that
`PII_ENCRYPTION_KEY` is present and decodes to 32 bytes.

Platform seed and cross-workspace maintenance remain explicit worker or
maintenance responsibilities. The platform worker requires an explicit
`OWNER_DATABASE_URL`, rejects an `app_user` identity or a URL that aliases
`APP_DATABASE_URL`, and never falls back to `DATABASE_URL`. Before starting
telemetry, storage, model or Temporal clients it connects both DB roles,
verifies that the owner connection is actually a database/application relation
owner, and completes the required provider, jurisdiction and sanctions-policy
seeds; any failure aborts startup. The Outbox slice
uses `OUTBOX_RELAY_DATABASE_URL` with the same explicit owner URL as its only
fallback. `DataRightsService` in the ordinary API no
longer creates an owner client or seeds policy rows. An empty policy registry
keeps red data fail-closed and must appear as an operations/readiness blocker.

## Suppression facts

`suppression_record` is append-only for `app_user`. The legacy DELETE operation
is retained only as a deprecated compatibility response and always returns
`SUPPRESSION_DELETE_DEPRECATED`; it cannot delete a row.

`POST /api/v1/suppressions/{id}/release-requests` writes an append-only review
fact. It never makes the original suppression ineffective:

- a preference request is admitted only for classified preference/manual
  records;
- unsubscribe, complaint, Art.17, Art.21 and legal records cannot be released
  by a preference request;
- an identity-correction request requires a bounded, non-PII evidence
  reference and remains pending legal review when the source record is legal;
- workspace and actor come from the verified request context, never from the
  body.

Authentication alone is not authorization for suppression governance. In this
source slice, all four HTTP surfaces (`POST /suppressions`,
`GET /suppressions`, deprecated `DELETE /suppressions/{id}`, and
`POST /suppressions/{id}/release-requests`) therefore fail closed with the
fixed `SUPPRESSION_GOVERNANCE_AUTHZ_PENDING` 503 response before their handlers
run. This prevents an arbitrary authenticated caller from reading decrypted
suppression values or writing governance facts while the authorization branch
is still separate. Their future success schemas remain documented, but each
operation carries the machine-readable
`x-runtime-availability: AUTHORIZATION_INTEGRATION_PENDING` marker and states
that only the fixed 503 is currently reachable.

During integration, that temporary admission must be replaced—not removed—by
the server-owned roles-to-scopes guard, and every one of those operations must
require `compliance:manage`. The same integration change must remove the
pending OpenAPI marker and update the availability description; deleting the
guard without synchronizing the contract is not an accepted transition. A
future approval or correction executor needs a separate decision, DB contract
and audit trail; it is intentionally absent from this slice.

## Rights decision audit

Allowed handoff decisions are logged in the same transaction as the
`LeadQualified` event. A denied storage-rights decision rolls back the handoff
transaction first, then writes the exact denial in a new tenant transaction.
If denial audit persistence fails, the request fails closed rather than
returning an unaudited business decision.

## PII writer and logs

The Prisma extension is the single write boundary for:

- `canonical_contact.full_name`;
- personal `contact_point.value` values;
- `suppression_record.value` when the suppression type is email;
- every amber/red `field_evidence.value` as a versioned
  `field-evidence-pii/v1` encrypted envelope.

Green company provenance remains queryable. Legacy plaintext is read-compatible
only to permit a controlled backfill; that compatibility is not evidence that
backfill has occurred.

HTTP and Temporal bootstraps install the same recursive sensitive-data logger.
It covers Nest logs and direct `console` calls, strips credentials and sensitive
URL parameters, redacts email/phone/bearer/JWT values, bounds output, and does
not mutate caller objects. Unknown `Error` instances are logged only as a small
allowlisted error class plus message/code digests; message text and stack are
never emitted. Persisted AI trace errors always use a SHA-256 diagnostic token,
even when an arbitrary provider string merely resembles a machine code, so
names, prompts or lawful-basis notes cannot become a second data store.
Acquisition/source failures, signal ledgers, deletion failure state and tool
traces apply the same token before persistence or API return. Every discovery
provider exception log also reduces arbitrary exception text to this closed
token before it reaches either an injected logger or `console`; pilot
discovery, taxonomy and worker log sites do not pre-stringify exceptions.
Truncation alone is not a privacy control.

## Controlled legacy backfill

The maintenance script does nothing unless exactly one of `--verify-only` or
`--apply` is present. It never reads `.env` and never falls back to
`DATABASE_URL`. Both modes require environment-injected:

- `PII_BACKFILL_DATABASE_URL`;
- `PII_BACKFILL_AUTHORIZATION_ID`;
- `PII_BACKFILL_EXPECTED_DATABASE`;
- `PII_BACKFILL_EXPECTED_BUILD_SHA`;
- a finite `PII_BACKFILL_MAX_ROWS`.

Before constructing a database client, both modes require the script to run
from a clean Git checkout whose exact HEAD equals
`PII_BACKFILL_EXPECTED_BUILD_SHA`; checkout drift, an unexpected repository
root, or any tracked/untracked change fails closed. Apply mode then compares
`current_database()` with the approved database name and counts the complete
affected surface against the cap.

Apply runs under one PostgreSQL serializable interactive transaction with a
transaction-scoped advisory lock, finite lock/statement/transaction timeouts,
and a final residue scan before commit. A late collision or verification
failure therefore rolls back every preceding phase. It encrypts/blinds legacy
contact values, preserves the existing collision/merge and verification-state
rules, encrypts suppression email values without changing their legal reason,
writes all amber/red FieldEvidence through the versioned envelope, then
performs a storage-level plaintext residue scan.
Suppression ciphertext collisions fail closed for explicit review; they are
never auto-merged because that could discard a stronger legal suppression or
its review history.

The only stdout artifact is a PII-free receipt containing authorization id,
mode, expected database/build identity, the independently observed exact Git
HEAD, counts, verification time and SHA-256 digest. A non-zero residue count
fails the run. The script has not been run by this change. Running either mode
against a real environment, and especially `--apply`, requires a fresh
exact-target operational authorization, backup and rollback decision.

The destructive fixture verifier is a separate tool. It also does not load
`.env`, generates its own test-workspace UUID, and refuses to start unless the
same apply authorization is present **and**
`PII_BACKFILL_ISOLATED_VERIFY=true` is injected exactly. That second gate is an
operator attestation that the database is isolated and disposable; it must
never be set for pilot or production. The verifier has not been executed by
this change.

## Isolated PostgreSQL compliance verifier

`pnpm --filter @global/api verify:acquisition-compliance:postgres` defaults to
`NOT_RUN_REQUIRES_ISOLATED_TEST_DB_AUTHORIZATION` and exits non-zero before
constructing a Prisma client. It runs only when all three dedicated variables
are injected explicitly:

- `ACQUISITION_COMPLIANCE_TEST_DB_AUTHORIZATION` is exactly
  `I_ACKNOWLEDGE_THIS_IS_AN_ISOLATED_DISPOSABLE_DATABASE`;
- `ACQUISITION_COMPLIANCE_TEST_OWNER_DATABASE_URL`;
- `ACQUISITION_COMPLIANCE_TEST_APP_DATABASE_URL`.

The two URLs must name the same database and endpoint, use distinct roles, and
the database name must match
`codex_acquisition_compliance_test_[a-z0-9_]+`. Ordinary application/owner URL
variables are never consulted. After connecting, the verifier independently
checks migration provenance, real owner/app role capabilities, RLS plus FORCE
RLS, cross-workspace negative cases, and denied UPDATE/DELETE privileges on
`suppression_record`, `suppression_release_decision`, and
`policy_decision_log`. It creates only random synthetic `.invalid` facts and
will attempt cleanup only after the disposable database and both role facts
have been proved. The executable verifier has not been run by this change;
doing so requires a separately approved disposable database target.

## Pilot boundary still closed

This slice does not complete LIA, Art.14 notice delivery, general retention,
sanctions-list activation or named-person approval. Until those separate gates
are closed, the Germany industrial-pump pilot remains limited to company facts
and public role mailboxes; named people and email guessing remain disabled.
