# Security and recovery governance

This document describes repository source on the
`codex/acquisition-security-recovery-governance` branch. It is not proof that
GitHub rulesets changed, a workflow ran, an image was pulled, a backup exists,
or a restore succeeded. No `.env` file or service was read while preparing it.

## API coverage: ratchet first, 80% remains the target

The fixed-base measurement included every non-test TypeScript file below
`apps/api/src`, including the API and worker process entrypoints; only test
files and the test-only Temporal mock directory are excluded. After building
the API, all 271 test files and all 4,291 tests passed. The measured coverage
was:

| Scope               | Statements | Branches | Functions |  Lines | 80% status |
| ------------------- | ---------: | -------: | --------: | -----: | ---------- |
| API global          |     70.75% |   66.89% |    74.30% | 72.93% | debt       |
| auth branches       |          — |    2.50% |         — |      — | debt       |
| compliance branches |          — |   70.49% |         — |      — | debt       |
| events branches     |          — |   95.65% |         — |      — | met        |
| budget branches     |          — |  100.00% |         — |      — | met        |
| identity branches   |          — |   91.67% |         — |      — | met        |
| outbox branches     |          — |   74.19% |         — |      — | debt       |

[`config/api-coverage-policy.json`](../../config/api-coverage-policy.json)
stores exact covered/total counts. `pnpm coverage:api` produces real V8 output
and requires its file inventory to equal every non-test TypeScript source below
`apps/api/src`; missing or out-of-scope files fail the gate. It compares ratios
by integer cross-multiplication, so a decline cannot hide behind two-decimal
rounding. A green ratchet means only that coverage did not decline. While the
policy status is `RATCHET_ACTIVE_TARGET_UNMET`, it must not be described as
satisfying the 80% target. Auth, compliance, and outbox need a separate
test-coverage wave.

## Security required-context source and inherited debt

The Security workflow exposes four diagnostic lanes and one aggregate gate:

- `gitleaks 密钥扫描`
- `dependency audit`
- `repository SAST`
- `container and Compose IaC`
- `security · required gate`

All external Actions in every repository workflow are pinned to full commit
SHAs. Security workflow permissions are `contents: read` and
`pull-requests: read`; it cannot comment, auto-fix, publish, deploy, or change a
third-party resource. The aggregate gate succeeds only when all four diagnostic
lanes succeed; keeping one aggregate context avoids a ruleset that accidentally
requires only the secret scanner while SAST or Compose fails.

Dependency audit reads the exact PR base and proposed merge result during the
same CI run from the same explicit npm advisory endpoint. A new high/critical advisory, a
new vulnerable dependency path, a severity escalation, a malformed response,
or an unavailable audit endpoint fails closed. High/critical findings already
present on the base remain visible as inherited debt but are not falsely
attributed to an unrelated PR. Removing inherited exposure is reported as a
resolution. This regression gate does not waive the existing debt: dependency
upgrades remain a separately reviewed remediation stream, and the full debt
counts are printed on every comparison.

The SAST lane is a transparent repository-local pattern gate for dynamic evaluation,
unsafe Prisma raw SQL, shell execution, and disabled TLS verification. It is
not a claim of complete semantic vulnerability analysis. The Compose/IaC lane
checks the image/source lock, recovery admission artifact, and integration
matrix without connecting to Docker or a service.

GitHub required-check/ruleset configuration is external state and was not read
or changed. The workflow files define candidate contexts; repository
administrators still have to configure the ruleset explicitly.

Every job has a finite timeout. Scheduled and push workflows use different
concurrency groups so a scheduled diagnostic cannot cancel a required main
push check. Build/typecheck/coverage, governance/docs, API contracts, and
security remain separate stable contexts; one context cannot turn another
green by duplication.

## Image provenance and startup admission

[`config/container-image-lock.json`](../../config/container-image-lock.json)
separates three claims:

1. Six remote digests came from a read-only `RepoDigests` inventory on
   `global-dev`. This does not prove production provenance.
2. new-api retains its pre-existing repository digest pin; no new runtime
   attestation is claimed.
3. The two local builds have source-closure SHA-256 digests and source-bound
   tags. Their `buildReceiptStatus` remains `NOT_RUN`; no registry digest was
   invented.

`pnpm security:compose` recomputes the local source digests, verifies every
remote image reference, and requires every default Compose service to have a
locked image before `pnpm infra:up` can invoke Compose. For local builds this is
source/tag admission only, not an image-build or runtime attestation; their
build receipts remain `NOT_RUN`. A build-only service without a source-bound
image is rejected. The optional AI-observability profile remains `UNVERIFIED`:
its variable/fixed tags have no complete digest evidence. Its `config` and `up`
scripts fail before reading the profile env file or invoking Compose. Stopping
an already-running profile is not blocked by this source admission gate.

## PostgreSQL and Temporal integration contexts

[`config/integration-context-matrix.json`](../../config/integration-context-matrix.json)
declares the stable names `PostgreSQL integration` and `Temporal integration`.
Both are currently `BLOCKED`, and therefore are not satisfied required
contexts.

- PostgreSQL may be enabled only with a CI-created disposable database and
  non-superuser/non-`BYPASSRLS` role, job-constructed URLs, migrations, and an
  explicit verifier allowlist. A shared or user-supplied URL is forbidden.
- Temporal may be enabled only with the official test environment or pure
  immutable-history replay. The existing replay script connects to a live
  Temporal address and loads dotenv, so it is not admissible in this context.

The manual workflow template deliberately fails its two jobs while the matrix
is blocked. PostgreSQL now has a fail-closed isolated compliance verifier, but
there is still no reviewed CI job that creates its disposable database and
owner/application roles, applies migrations, injects only job-constructed URLs,
and executes that verifier. Editing the JSON to `ENABLED` with a shell command
is therefore still rejected. Temporal has neither an admissible test runtime nor
an allowlisted replay runner. The template must not be added to a required-check
ruleset until the corresponding hermetic jobs execute the real isolated checks.

## Recovery state

The operational procedure is in
[`backup-and-recovery.md`](backup-and-recovery.md). The only machine rehearsal
artifact is
[`recovery-rehearsal-manifest.json`](../operations/recovery-rehearsal-manifest.json),
whose status is `NOT_RUN`. `pnpm recovery:verify` accepts that safe create-only
state and rejects every executed-state claim. Repository JSON cannot prove
authorization or a restore; accepting authenticated execution receipts requires
a separate evidence verifier that does not yet exist.
