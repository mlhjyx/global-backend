# Acquisition operations durability

This slice adds a durable acquisition budget ledger and a PostgreSQL
single-writer gate for the Outbox relay. It does not change Site Builder's
`SiteBuildCostLedger`, authorize paid model work, or claim that every legacy
acquisition caller has migrated.

## Durable budget contract

An `AcquisitionBudgetAccount` is an explicit, finite authorization bound to:

- `workspaceId`, `runId`, and `purpose`;
- exact `targetKind` (`SOURCE`, `MODEL`, or `TOOL`) and `targetId`;
- currency and integer billing unit;
- request, call, record, model-call, and cost-minor limits; and
- a finite expiry and canonical authorization digest.

`reserve()` never creates an account. A reservation atomically locks its
account row and binds the full account identity plus `executionId`, positive
`attempt`, request fingerprint, and maximum amounts. Replaying the same tuple
and payload is idempotent; changing any payload field is a conflict. Concurrent
reservations serialize on the account row, so their reserved plus settled
amounts cannot exceed any limit.

`settle()` releases unused maxima only when actual integer usage is known and
within the reservation. Unknown usage or an overrun consumes the full maximum,
marks the reservation `UNKNOWN`, and freezes the account. A failed reserve that
cannot fit marks the account exhausted conservatively. Reservation identity and
maxima are immutable after insertion; only the stored settlement function can
perform the one-way state transition.

The application role cannot write either ledger table directly. The three
fixed transition functions have a pinned `search_path` and run as the dedicated
`acquisition_budget_executor` role. That role is `NOLOGIN`, `NOINHERIT`, and has
no superuser, role-management, replication, or RLS-bypass capability; it has
only schema usage and `SELECT`/`INSERT`/`UPDATE` on the two ledger tables. Both
tables use forced workspace RLS. `app_user` receives table `SELECT` and function
execution only.

## Runtime migration boundary

The first production seam is `openfda.search` in the Temporal discovery worker.
Each query opens a deterministic query-scoped account with one request, one
Broker call, at most 250 records, zero model calls, and zero cents. The required
Broker validates account, run, purpose, exact tool target, execution ID,
Temporal attempt, and every cap before rate limiting or provider execution.

The one-call account deliberately gives at-most-one provider start per query:

- a limiter or other pre-execution failure settles `RELEASED`, leaving capacity
  available to a separately scheduled Temporal attempt with a higher attempt
  number;
- a crash after durable reservation leaves the maximum reserved, so a later
  attempt cannot start a duplicate call;
- an execution error settles `UNKNOWN`, charges the maximum, and freezes; and
- a successful measured result settles actual records/cost and exhausts the
  one-call authorization.

An openFDA call carrying the durable binding never converts a Broker/ledger
failure into a clean empty-source success. The provider rethrows it to the
fan-out, which preserves fulfilled providers but returns `budgetTruncated=true`;
the workflow therefore closes `PARTIAL`, not `DONE`. The current fan-out does
not automatically retry that individual provider inside the same activity.

The general discovery/enrichment tools, platform acquisition adapters,
external-intent paths, and model gateway still use their existing accounting
paths. They are follow-up migrations. The API-side registry intentionally gives
openFDA no legacy fallback; without the dedicated acquisition broker and
binding it returns no records and performs no raw egress.

## Outbox single writer

The relay no longer opens its cross-tenant client from ordinary
`DATABASE_URL`/`APP_DATABASE_URL`. It requires
`OUTBOX_RELAY_DATABASE_URL`, with `OWNER_DATABASE_URL` accepted only as an
explicit platform-owner fallback. The URL must be PostgreSQL, name a database
and a non-`app_user` role, and must not alias `APP_DATABASE_URL`; missing or
invalid configuration fails startup in every environment with a constant error
that does not contain the URL or credentials. Prefer a dedicated relay role in
deployments. Tests may inject an in-memory client without reading process
environment.

Every relay `tick()` now enters `pg_try_advisory_xact_lock` with one stable
global key before it scans claims, routes events, starts workflows, creates pull
deliveries, or sends webhooks. A non-holder performs none of those operations.
The lock is transaction-scoped, so normal completion, callback failure,
connection loss, or process death releases it without relying on pooled-session
cleanup. The in-process `running` guard remains only as a local optimization.

The lock transaction holds one connection while relay work uses the existing
database client and external clients. A cooperative 240-second tick deadline is
below the repository's 300-second transaction timeout and is checked between
events, claims, and webhook deliveries. An already-started external operation
can exceed the cooperative deadline; a database-session loss also releases the
lock but cannot revoke an external side effect already in flight. Workflow IDs,
delivery uniqueness, and compare-and-set updates remain the downstream
idempotency defenses. If the deployment requires partition-tolerant strict
ordering, add a durable fencing generation consumed by every delivery write and
external dispatcher before enabling that topology.

## Isolated PostgreSQL verification

Unit tests use the in-memory adapter and parameterized-query contract tests.
Database concurrency, restart persistence, RLS, grants, append-only permissions,
and two-connection advisory-lock behavior require a disposable PostgreSQL
database. The verifier refuses ordinary CI or a development database: both URLs
must address a database named `codex_acquisition_ledger_test_*`, use distinct
owner/application roles, and carry the explicit authorization phrase.

After applying migrations to that disposable database, run:

```bash
ACQUISITION_LEDGER_TEST_DB_AUTHORIZATION=I_ACKNOWLEDGE_THIS_IS_AN_ISOLATED_DISPOSABLE_DATABASE \
ACQUISITION_LEDGER_TEST_OWNER_DATABASE_URL='postgresql://owner:.../codex_acquisition_ledger_test_example' \
ACQUISITION_LEDGER_TEST_APP_DATABASE_URL='postgresql://app_user:.../codex_acquisition_ledger_test_example' \
pnpm --filter @global/api verify:acquisition-ops:postgres
```

Without all three values it exits non-zero with
`NOT_RUN_REQUIRES_ISOLATED_TEST_DB_AUTHORIZATION`; that is an unrun integration
gate, not a passing result.

## Forward recovery

The migration is transactional and forward-only. If it fails before `COMMIT`,
PostgreSQL rolls back its tables, functions, grants, and role creation. If the
migration commits but the new worker must be rolled back, deploy the previous
application binary and leave the unused ledger schema in place; do not drop
tables or rewrite reservations. Correct defects with a new forward migration.

An orphaned `RESERVED` row is intentionally capacity-consuming. Recovery must
identify the exact workspace/run/account/purpose/target/execution/attempt and
settle it through the ledger as `UNKNOWN`; direct table updates are denied and
would destroy the audit invariant.
