# Organization Identity Authority Hardening and Legacy Writer Cutover Design

**Status:** Proposed for user review. No implementation is authorized by this document alone.

**Date:** 2026-08-30

**Repository/worktree evidence:** `codex/pr407-organization-identity-v2@d4b091b4ae7947660f51d18a220a778d1e7eb451`, clean exact-head ContractGraph `1243 files / 11487 nodes / 26131 edges / 0 errors`.

**Decision source:** user selected the recommended expansion after Task 6B.2c independent reviews failed with code/spec `2C/7I`, security `3C/4I`, and database `0C/6I/2M`.

## 1. Objective

Close both Organization Identity write bypasses without breaking current Raw materialization or Temporal replay:

1. Replace the caller-authored JSON SECURITY DEFINER command with a database-owned resolver that accepts only authenticated workspace and immutable Raw IDs and derives every authority, blocker, candidate, root, plan, target, hash, suppression, replay, and conflict fact from locked database state.
2. Migrate the only two product IdentityLink writers—Temporal `canonicalizeRun` and `TenantProjectionService.projectSource`—to that resolver while preserving same-transaction CanonicalCompany and FieldEvidence behavior.
3. After every old writer is drained and the rollback floor is raised, revoke every table-level and column-level `app_user` INSERT privilege on `identity_link` so the resolver command becomes the only product identity write authority.

This design does not add Organization Identity HTTP APIs, human review decisions, Temporal replay workers, Provider Quality, SEC providers, deployment, retained migration application, or runtime evidence.

## 2. Current truth and threat model

### 2.1 Product writer inventory

There are exactly two product Prisma direct writers:

- `apps/api/src/temporal/discovery.activities.ts` — `createDiscoveryActivities().canonicalizeRun()`; product-wired through `discoveryWorkflow`.
- `apps/api/src/acquisition/tenant-projection.service.ts` — `TenantProjectionService.projectSource()`; currently test/script-used, not product composition-wired.

There are no product `IdentityLink.upsert`, `createMany`, `update`, or `delete` calls and no product contact IdentityLink writer. Other direct INSERTs are migrations or disposable tests.

### 2.2 Existing bypasses

- `app_user` may directly INSERT seven legacy columns on `identity_link`; defaults create `ACTIVE / identity-v1 / legacy` rows without authority, planner, identity lock, or full suppression validation.
- The rejected v2 command accepts caller-authored blocker, legacy candidate, target company, authority scheme, plan, and hashes. A valid workspace `app_user` can bypass the TypeScript source and corrupt same-workspace identity state.

### 2.3 Attacker

Assume an authenticated malicious `app_user` session with a valid `app.current_workspace_id`, SELECT access to its workspace, and permission to directly call every function granted to `app_user`. TypeScript Symbols, caller-computed JSON hashes, source-only validation, and undocumented calling conventions are not authorization.

## 3. Approaches considered

### 3.1 Approach A — database derives the complete plan and performs the mutation (recommended)

The public command accepts two bounded text parameters, locks Raw/live state, derives the exact plan, and performs CanonicalCompany/Identity graph mutation in one statement. Callers cannot supply blocker, candidate, scheme, target, plan, or hash.

Advantages:

- Smallest public authority surface.
- Direct `app_user` calls receive the same derivation as official source calls.
- No secret/ticket lifecycle or abandoned receipt state.
- Company create, identifier/conflict/link writes, and returned receipt are statement-atomic.

Cost:

- PostgreSQL must have reviewed private helpers whose outputs are mechanically parity-tested against the TypeScript Raw/authority/blocker/planner/suppression contracts.
- The command is deliberately substantial and requires independent database/security review.

### 3.2 Approach B — inspect then apply with an unforgeable transaction ticket

A safe implementation would require a private ticket table bound to a random token, `pg_current_xact_id()`, backend PID, workspace/Raw IDs, canonical plan digest, expiry, and consumed state. A JSON digest, GUC, or TypeScript receipt is forgeable and therefore insufficient.

Rejected because there is no independent human inspect/apply phase in this slice; tickets add cleanup, retention, abandoned-state, and second-phase race complexity without product value.

### 3.3 Approach C — deterministic public attestation/helper

A public deterministic helper or signature is caller-computable and cannot authorize a write. Private canonical helpers remain useful inside Approach A but are not a separate security design.

## 4. Target architecture

### 4.1 Only public v2 command

```sql
public.resolve_organization_identity_for_raw_v1(
  p_workspace_id text,
  p_raw_record_id text
)
RETURNS TABLE (
  outcome_kind text,
  raw_record_id uuid,
  company_id uuid,
  conflict_id uuid,
  match_rule text,
  input_hash text,
  conflict_fingerprint text,
  replayed boolean,
  company_created boolean,
  identifier_count integer,
  party_count integer
)
```

The parameters are `text`, not `uuid`, so malformed hostile values enter the function and can be rejected with a fixed `IDENTITY_RESOLUTION_INPUT_INVALID` token without PostgreSQL echoing the original value before function entry.

The function is `SECURITY DEFINER`, fixes `search_path=pg_catalog,public`, verifies `session_user='app_user'`, rejects owner/PUBLIC/SET ROLE/wrong or unset workspace, and applies explicit workspace predicates to every read and write. The calling transaction must pre-arm `lock_timeout` to a non-zero value no greater than five seconds and `statement_timeout` to a non-zero value no greater than sixty seconds **before** issuing the resolver statement. The function must read back and enforce both bounds before its first database read or advisory lock; an unarmed, zero, malformed, or over-limit caller is denied with a fixed no-echo command-admission error. Function `proconfig` must not override those caller-prearmed values, because PostgreSQL 16 cannot asynchronously arm a new timer for the already-running statement from inside the function.

No public function accepts JSON plan facts. The rejected `apply_organization_identity_resolution_v1(jsonb)` signature must be absent in fresh and upgrade catalogs.

### 4.2 Private database helpers

The resolver may use these exact private-by-ACL helpers:

```sql
organization_identity_authority_from_raw_v1(text, jsonb) RETURNS jsonb
organization_identity_blocker_from_raw_v1(jsonb) RETURNS jsonb
organization_identity_canonical_suppression_value_v1(text, text) RETURNS text
organization_identity_plan_from_snapshot_v1(jsonb) RETURNS jsonb
organization_identity_acquire_advisory_until_v1(bigint, timestamptz) RETURNS void
```

All helpers use fixed search paths and revoke all privileges from `PUBLIC` and `app_user`. They are implementation units for executable parity tests, not authorization receipts.

### 4.3 Database-owned derivation sequence

For every call, in one database statement:

1. Parse canonical lowercase workspace/Raw UUID text without echoing invalid input.
2. Acquire workspace suppression advisory lock, then workspace identity advisory lock, each under the command's runtime timeout.
3. Lock the exact workspace Raw row `FOR KEY SHARE`; require `ACCEPTED`, `raw-source/v2`, unexpired receipt, exact current payload hash, and no `RESTRICT_PROCESSING` disposition.
4. Reconstruct the exact current authority tuple from stored Raw, including provider/scheme allowlist, registry-id vs LEI binding, TED suffix/country precedence, FDA/domain rules, validator/normalizer versions, UTF-8 bounds, and canonical key ordering.
5. Derive the v2 blocker from Raw `name/domain/country`: `domain_exact` when a governed domain exists, otherwise `name_country`. Provider identifier never becomes the fallback blocker because it is represented by strong authority identifiers.
6. Read the exact blocker candidate, active authority bindings, and one-hop mappings. Reject self mappings, multiple active mappings, alias chains, A→B→C, missing targets, and cross-workspace facts.
7. Lock every involved CanonicalCompany row in UUID order. All future mapping/decision writers must acquire the same identity advisory lock before changing roots.
8. Recheck suppression against Raw and every candidate/root company using the exact executable canonical relation. New v2 Raw domains are ASCII canonical; a legacy company domain that cannot be proven canonical fails closed rather than being treated as unsuppressed.
9. Build the single canonical sorted snapshot and derive the same four planner variants and hashes as Task 6B.2b.
10. Validate any existing IdentityLink state as a complete receipt only after current suppression/binding/root/plan reconstruction.
11. Mutate or return a typed result as described below.

### 4.4 Outcomes

`bound`:

- One strong root, or a legacy blocker root with no disagreeing strong root.
- Insert/refresh exact ACTIVE identifiers and one ACTIVE v2 company IdentityLink.
- Return exact matchRule and counts.

`created`:

- No strong root and no blocker candidate.
- The command creates the minimal CanonicalCompany from admitted Raw `name/domain/country`, then inserts identifiers/link in the same statement.
- Callers cannot supply a target company ID.

`conflict`:

- Multiple strong roots or one strong root disagreeing with the blocker root.
- Conflict fingerprint excludes Raw occurrence but binds canonical stable facts.
- Reuse requires exact `OPEN/revision=1/facts/party set`; resolved or drifted winners fail closed.
- Insert one PENDING_CONFLICT link per exact party; do not create identifiers or CanonicalCompany.

`legacy_bound`:

- Read-only compatibility for exactly one complete `ACTIVE / identity-v1 / legacy / canonical_type=company / conflict_id=null` link.
- The target must equal the old deterministic blocker target for that Raw, including the historical identifier fallback when no domain existed.
- Current suppression is checked first. No legacy row is upgraded, rewritten, or used as v2 evidence.

`suppressed`:

- Expected zero-write outcome so per-Raw batch materialization can continue without aborting the entire transaction.
- Receipt contains only machine-shaped IDs/status, never the suppression value.

Any foreign resolver version, multiple ACTIVE legacy/v2 links, ACTIVE+PENDING mixture, partial conflict link/party set, target drift, root drift, scheme relabel, or hash mismatch is a fixed typed HOLD/error, never an arbitrary replay.

## 5. TypeScript source contract

`resolveOrganizationIdentityForRaw(tx, {workspaceId, rawRecordId})` becomes a thin caller of the two-ID command and strict receipt parser. It does not independently send authority/blocker/binding/root/plan facts to the database.

It must:

- before the resolver `SELECT` begins, set transaction-local `lock_timeout` to a non-zero value no greater than five seconds and `statement_timeout` to a non-zero value no greater than sixty seconds; preserve that ordering before the first source-level advisory lock and let the database command verify the armed values;
- use one `SuppressionThenIdentityLockReceipt` when a surrounding caller needs to keep suppression/identity linearized across subsequent Canonical/Evidence writes;
- validate exact DB row shape, UUID/hash/null matrix, counts, and outcome union;
- map direct and Prisma-nested SQLSTATEs to fixed no-echo errors;
- never construct another PrismaClient, use an owner URL, call a provider, or expose Raw/company/suppression values in errors.

The TypeScript authority/planner remain a parity oracle and unit-testable domain contract, not the database authorization input.

## 6. Legacy writer cutover

### 6.1 Temporal canonicalizeRun

For each governed consumable Raw, inside the existing workspace transaction:

1. Hold the bounded composite suppression→identity receipt.
2. Call the two-ID resolver.
3. On `suppressed`, increment `suppressed` and continue.
4. On `legacy_bound`, preserve existing response-loss semantics and perform zero legacy-link mutation.
5. On `bound/created`, load the returned company, merge only governed owned Canonical namespaces, and write FieldEvidence with the same Raw provenance in the same transaction.
6. On `conflict`, write no Canonical contribution or FieldEvidence and increment an additive `conflicts` count.

The Activity name and existing `companies/suppressed` fields remain stable; `conflicts` is additive. Recorded old Activity results replay unchanged. New Activity attempts use the new code. No workflow patch changes a historical activity signature.

### 6.2 TenantProjectionService.projectSource

Use the same per-Raw outcome handling inside each existing bounded chunk transaction. This family is not product-composed today, but its source/test/script path must be cut over before final ACL revoke.

### 6.3 No generic legacy write command

The inventory found no product contact IdentityLink writer and only two governed Raw v2 company writers. A generic write-capable legacy compatibility function would preserve the bypass under a different name and is forbidden. If later live inventory finds an external direct SQL/contact writer, stop and create a separately reviewed command instead of restoring ambient INSERT.

## 7. Migration and deployment artifacts

Safe rollout requires three independently reviewable and deployable artifacts. They must not be collapsed into one migration deploy unit.

### Artifact A — command expansion

- Final pre-release form of `20260830090000_organization_identity_v2_resolver_command`, only if retained inventory proves that no old checksum/name was applied.
- Replaces the rejected JSON command with the two-ID command and private helpers.
- Old seven-column IdentityLink INSERT remains temporarily for old code compatibility.
- State after deployment: `TRANSITION_HOLD`; no unique-authority claim.

If any retained ledger contains the migration name or rejected checksum, do not rewrite it. Use a strictly later forward repair migration and preserve the existing ledger.

The rejected local checksums `7e101a1d...`, `8c5d07dc...`, `0c716f1d...`, and `fb6b377f...` are forbidden in any future official inventory. Never edit `_prisma_migrations` or use `prisma migrate resolve` to disguise a mismatch.

### Artifact B — application caller cutover

- Migrate both writer families and their tests to the two-ID resolver.
- Compatible with Artifact A and the still-present legacy INSERT grant.
- Supports mixed API/worker fleet and read-only legacy replay.
- State after full fleet deployment and old worker drain: `CUTOVER_READY_FOR_CONTRACT`, still not final DB authority.

### Artifact C — contract/revoke

- Separate later migration named exactly `20260830110000_organization_identity_link_writer_contract`.
- Applies only after Artifact B exact build/image is deployed everywhere, old discovery workers and Activity attempts are drained, and the rollback floor is raised to Artifact B.
- Revokes table-level and every column-level INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER privilege on `identity_link` from `app_user` and PUBLIC.
- Keeps SELECT plus exact resolver EXECUTE only.
- Direct company and contact INSERT must fail.
- Rollback never restores ambient INSERT; rollback is a forward fix on Artifact B-or-newer code.

### Deployment invariants

| Point | Database | Code | Legacy INSERT | Validity |
|---|---|---|---|---|
| D0 | predecessor | old | available | current path |
| D1 | Artifact A | old | available | DB expanded; old code safe |
| D2 | Artifact A | mixed old/new | available | transition only; no final authority claim |
| D3 | Artifact A | all Artifact B, old workers drained | temporarily available | ready for contract |
| D4 | Artifact C | Artifact B or newer | revoked | final authority boundary |

Artifact C may not be merged/applied in the same deployment unit that first introduces Artifact B. There is no valid point where old code runs after revoke or new code runs before command readiness.

## 8. Required RED/GREEN proof

### 8.1 Command authority attacks

RED must reproduce and GREEN must reject:

- forged blocker/rule/candidate/target and JSON `null` discriminator bypass;
- registry-id↔LEI relabel, provider/validator/jurisdiction drift, missing/extra authority, TED suffix-only/no-country parity;
- reversed/duplicate bindings and roots, identifier split, blocker disagreement, self/chain/multiple mappings;
- normalized domain/name suppression, candidate/root suppression, post-link suppression replay;
- exact same-Raw replay, self-consistent different hash drift, foreign resolver, multiple ACTIVE, ACTIVE+PENDING, partial/resolved conflict;
- equivalent different-Raw conflict reuse with exact facts/party/link readback;
- malformed nested UUID/no-echo markers, oversized JSON/arrays, owner/PUBLIC/SET ROLE/unset/wrong workspace/cross-tenant;
- hard runtime lock/statement timeout with transaction-local bounds pre-armed before the resolver statement; unarmed/zero/over-limit direct calls must fail closed, and real slow pre-write reads, cumulative row-lock waits, replay returns, and write triggers must be bounded without relying only on cooperative post-phase checks;
- unexpected function owner/ACL/catalog residue before `CREATE FUNCTION`.

### 8.2 Caller cutover

- Temporal old-history replay and response-loss replay.
- Tenant projection response-loss and chunk suppression refresh.
- `bound/created/legacy_bound/suppressed/conflict` behavior for both families.
- No FieldEvidence on conflict/suppressed/legacy replay; exact evidence on new bound/created outcomes.
- Qualification, enrichment, signals, watch, and patent readers continue to consume the same Canonical state.
- Suppression race A/B and deletion/company/contact races use the fixed lock order and produce no `40P01`.

### 8.3 Revoke contract

- Before Artifact C, old caller compatibility is demonstrated.
- After Artifact C, direct table and every column-level company/contact INSERT are denied for app_user/PUBLIC while resolver command succeeds.
- Full API, Temporal replay, static migration, fresh/upgrade/second deploy, schema diff, RLS/ACL, two-connection concurrency, rollback injection, governance/docs, Gitleaks, ContractGraph, and cleanup receipts all pass.

Artifact A and Artifact B each require independent code, database, and security reviews with zero new or artifact-owned Critical/Important. The single pre-existing ambient IdentityLink INSERT bypass remains explicitly carried as `TRANSITION_HOLD` and prevents any final authority/readiness claim until Artifact C. Artifact C final reviews must report cumulative zero Critical and zero Important, including closure of that carried bypass.

## 9. Rollback and recovery

- Before retained migration: local commits and verified bundles are recoverable; disposable databases are destroyed and recreated from pinned stages.
- After Artifact A: forward repair the command; old callers still work. Do not rewrite an applied migration.
- During Artifact B rollout: roll back application only to an Artifact-A-compatible old build while legacy INSERT remains.
- After Artifact C: rollback floor is Artifact B. Never restore direct INSERT to run an older binary; use a forward application/database fix.
- Any ambiguous retained checksum, external writer, active old worker, unresolved Activity attempt, owner/ACL drift, or inability to prove exact suppression/authority parity is a hard stop.

## 10. Ownership, evidence, and no-go

- Program B owns Raw/Identity/Canonical semantics; CODEOWNERS for the final source/migration/test surfaces must be verified before PR.
- Product source, tests, migration stages, review reports, and deployment/readback evidence remain separate artifacts.
- Local GREEN does not authorize retained migration, push, PR, merge, deploy, restart, runtime capture, Provider dispatch, or paid calls.
- Production Parity worktree/branch, `/global/frontend/growthos-source`, PR #407 source branch, and unrelated root state remain outside write scope.

## 11. Acceptance decision

The design is accepted only if the user approves all four load-bearing decisions:

1. The public resolver accepts only workspace/Raw text IDs and the database derives the entire plan and company create.
2. Only the two inventoried governed Raw v2 company writers are cut over; no generic legacy write command is added.
3. Rollout is split into Artifact A expansion, Artifact B caller cutover, and separately deployed Artifact C revoke.
4. After Artifact C, ambient IdentityLink INSERT is never restored as rollback.
