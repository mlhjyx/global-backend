# Execution Authority Cutover and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomically make signed authority and durable result/ACK semantics mandatory for every product Model/Tool path, remove Backend-authored budget authorization, and prove the exact immutable runtime before merge and deployment.

**Architecture:** First convert the generic ledger end-to-end from cents to microusd while both old and new database functions remain additive. Then bind every workspace mutation and platform schedule to a verified authority, close bypasses, regenerate the public contracts, and make readiness/governance fail closed. The final product switch removes legacy cap/self-open APIs in one commit, followed by full-source, real-infrastructure, OCI, PR, migration and retained-runtime evidence gates.

**Tech Stack:** NestJS, TypeScript, Temporal, Prisma/PostgreSQL, JOSE, Redis, S3/MinIO, OpenAPI, JSON Schema, Docker/OCI, GitHub Actions.

**Spec:** `docs/architecture/execution-budget-authority-artifact-replay-design.md`

## Global Constraints

- No development/production old-new flag; the switch is one product behavior in all managed environments.
- All amount arithmetic and public/read-model fields use microusd. Public JSON uses canonical decimal strings; database arithmetic uses BIGINT.
- No `RUN_BUDGET_CENTS`, `SWEEP_BUDGET_CENTS`, caller cap argument or automatic account creation survives the cutover.
- Every registered physical Model/Tool has a declared strategy and every managed call has authority, stable operation identity, replay result and domain ACK.
- Platform schedules remain non-consuming/not-ready when the external signed command transport or fresh authority is absent.
- The retained migration and deployment happen only after merge and exact image publication; rollback is N-1 exact digest only when schema compatible, otherwise pause and forward-fix.
- The user's authorization covers push, PR update, merge, retained migration, image publication, deployment, service restart and a bounded real model validation, but technical gates in this plan remain mandatory and independent.

---

## Workspace Purpose and Subject Matrix

This matrix is a machine contract; controllers do not infer a purpose from arbitrary paths.

| HTTP operation                                    | purpose             | subject type    | subject ID rule                                                                                               |
| ------------------------------------------------- | ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /companies`                                 | `understanding.run` | `company`       | `request:<request_sha256>` because the company row does not exist before verification                         |
| `POST /companies/:companyId/icps`                 | `icp.design`        | `company`       | route `companyId` UUID                                                                                        |
| `POST /icps/:icpId/query-plans`                   | `icp.query_plan`    | `icp`           | route `icpId` UUID                                                                                            |
| `POST /query-plans/:planId/execute`               | `discovery.run`     | `discovery_run` | `request:<request_sha256>` because the run does not exist before verification; request hash includes `planId` |
| `POST /canonical-companies/:id/discover-contacts` | `discovery.run`     | `company`       | route canonical-company UUID                                                                                  |
| `POST /canonical-companies/:id/guess-emails`      | `discovery.run`     | `company`       | route canonical-company UUID                                                                                  |
| `POST /contact-points/:pointId/verify`            | `contact.verify`    | `contact_point` | route `pointId` UUID                                                                                          |

`request:<hash>` is a bounded subject identifier, not a second hash algorithm: it uses the exact endpoint request SHA-256 already verified in the grant. The Control Plane must generate the same literal value. Idempotency replay returns the original domain identity and does not consume a new grant.

## Platform Purpose Matrix

| Workflow/Schedule    | purpose                 | schedule identity                                                                                                                                 |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| acquisition refresh  | `platform.acquisition`  | registered acquisition schedule ID + Temporal workflow run ID                                                                                     |
| intent/web watch     | `platform.intent_watch` | registered watch schedule/source ID + Temporal workflow run ID                                                                                    |
| sanctions refresh    | `platform.sanctions`    | registered sanctions schedule ID + Temporal workflow run ID                                                                                       |
| patent cache refresh | `platform.acquisition`  | registered patent-cache schedule ID + Temporal workflow run ID; all BigQuery calls route through governed `google_patents.search` Tool operations |

## File Structure

**Create:**

- `packages/db/prisma/migrations/20260821120000_execution_budget_authority_cutover/migration.sql` — NOT NULL/FK/unit/status/function replacement and legacy privilege removal.
- `packages/db/test/execution-budget-authority-cutover.spec.mjs` — real PostgreSQL no-bypass/microusd/concurrency tests.
- `apps/api/src/execution-budget/execution-budget-grant.decorator.ts` — header extraction/redaction/OpenAPI declaration.
- `apps/api/src/execution-budget/execution-budget-request-scope.ts` — exact matrix and subject derivation.
- `apps/api/src/execution-budget/execution-budget-request-scope.spec.ts`.
- `scripts/execution-authority-policy.mjs` and `.spec.mjs` — repository bypass/strategy/amount/entrypoint scanner.

**Modify:**

- `apps/api/src/tools/tool-contract.ts`, `budget-store.ts`, `tool-broker.ts`, `tool-registry.ts` — microusd and authority-only API.
- `apps/api/src/model-gateway/router-model-gateway.ts` and types — microusd reserve/settle and mandatory schema/receipt.
- All account-opening product services/activities/workflows — accept `ExecutionBudgetBinding`, never compute cap.
- Company, ICP and Discovery controllers/services plus OpenAPI decorators — require/verify/consume grant before business rows or Workflow start.
- Acquisition, Intent, Sanctions and Patent Cache activities/workflows/schedule setup — require fresh platform authority and stable workflow-run binding.
- `apps/api/src/temporal/worker.ts`, runtime readiness, Compose/env/OCI scripts.
- `packages/contracts/openapi/openapi.json`, generated API types and event schemas.
- Governance policy, CODEOWNERS, CI workflow, status/architecture/changelog only at their specified gates.

### Task 1: Convert generic budget arithmetic from cents to microusd

**Files:**

- Modify: `apps/api/src/tools/tool-contract.ts`
- Modify: `apps/api/src/tools/budget-store.ts`
- Modify: `apps/api/src/tools/budget-store.spec.ts`
- Modify: `apps/api/src/tools/tool-broker.ts`
- Modify: `apps/api/src/model-gateway/router-model-gateway.ts`
- Modify: all focused specs and Tool cost declarations.
- Modify: `packages/db/prisma/schema.prisma` and create a forward migration if needed before the final cutover migration.

**Interfaces:**

- Consumes: authority caps and existing tool/model pricing.
- Produces: `estimatedMicrousd`, `reservedMicrousd`, `observedMicrousd`, `chargedMicrousd`, `remainingMicrousd` as bigint internally and canonical decimal strings externally.

- [ ] **Step 1: Write RED unit/precision/overflow tests**

Cover 1 microusd, 9,999 microusd, 10,000 microusd, maximum BIGINT, overflow, fractional USD conversion, exact provider cost below/above reservation and concurrent cap invariant. Assert no integer division by 10,000 loses authority.

- [ ] **Step 2: Run RED**

Run BudgetStore/ToolBroker/Router tests. Expected: FAIL while public/internal generic ledger uses cents.

- [ ] **Step 3: Rename and convert the complete interface**

Use bigint in the authoritative adapter and SQL. Tool registry cost becomes canonical `estimatedMicrousd: string`; validate at registration and convert to bigint at reserve. Keep deprecated cents fields only inside test-only `InMemoryBudgetStoreAdapter` until Task 8 deletes that compatibility surface; product composition cannot import it.

- [ ] **Step 4: Run GREEN and real DB invariant test**

Expected: `charged + reserved <= authorized cap` for all concurrent cases, with no conversion truncation.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tools apps/api/src/model-gateway packages/db/prisma
git commit -m "refactor(budget): use microusd end to end"
```

### Task 2: Bind all workspace HTTP mutations before side effects

**Files:**

- Create: `apps/api/src/execution-budget/execution-budget-grant.decorator.ts`
- Create: `apps/api/src/execution-budget/execution-budget-request-scope.ts`
- Test: `apps/api/src/execution-budget/execution-budget-request-scope.spec.ts`
- Modify: `apps/api/src/company/company.controller.ts`, `company.service.ts` and specs.
- Modify: `apps/api/src/icp/icp.controller.ts`, `icp.service.ts` and specs.
- Modify: `apps/api/src/discovery/discovery.controller.ts`, `discovery.service.ts` and specs.

**Interfaces:**

- Consumes: workspace authority service and purpose matrix.
- Produces: verified `ExecutionBudgetBinding` passed into every model/tool execution path.

- [ ] **Step 1: Write RED controller/service tests**

For every matrix row assert missing/invalid/expired/scope mismatch responses, zero business rows, zero IdempotencyKey mutation, zero Outbox, zero Workflow and zero Provider. Assert valid grant binds the exact route/request subject. Assert same Idempotency-Key + new grant returns original result without consuming the new grant; same consumed exact token may replay after expiry; unconsumed expired grant returns 402 with zero writes.

- [ ] **Step 2: Run RED**

Run Company/ICP/Discovery controller/service focused specs. Expected: FAIL because the header is not required.

- [ ] **Step 3: Implement header extraction, scope derivation and atomic consume**

The controller reads the compact token once through a parameter decorator that never logs it. Service verifies before opening its workspace transaction. Authority consumption, idempotency identity, preallocated domain ID, business row/Outbox and Workflow identity creation occur in the existing endpoint transaction boundary or a repository function that guarantees the same atomicity. Workflow start ACK loss recovers by stable workflow ID and does not consume authority twice.

- [ ] **Step 4: Run GREEN and OpenAPI source tests**

Expected: all seven endpoints expose `X-Execution-Budget-Grant`, stable error codes and one product path.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execution-budget apps/api/src/company apps/api/src/icp apps/api/src/discovery
git commit -m "feat(api): require workspace execution authority"
```

### Task 3: Bind all platform schedules, including Patent Cache

**Files:**

- Modify: `apps/api/src/temporal/acquisition.activities.ts`, workflow and specs.
- Modify: `apps/api/src/temporal/intent.activities.ts`, workflow and specs.
- Modify: `apps/api/src/temporal/sanctions-refresh.activities.ts`, workflow and specs.
- Modify: `apps/api/src/temporal/patents-cache.activities.ts`, workflow and specs.
- Modify: `apps/api/src/adapters/patent-inventor-cache.ts` and specs.
- Modify: `apps/api/src/temporal/worker.ts` and schedule setup.

**Interfaces:**

- Consumes: fresh platform authority repository and ToolBroker.
- Produces: per-workflow-run account binding; no direct BigQuery/HTTP call.

- [ ] **Step 1: Write RED platform matrix and bypass tests**

Assert missing/expired/revoked/exhausted authority means zero account/operation/external adapter call. Two schedule runs for the same source consume distinct run slots and do not replay stale results. Patent Cache must fail a source scan test while it imports/calls `bigqueryPatents` directly.

- [ ] **Step 2: Run RED**

Run acquisition/intent/sanctions/patents activity and workflow specs. Expected: FAIL on direct/no-authority paths.

- [ ] **Step 3: Implement authority binding and Patent Cache ToolBroker route**

Look up authority by exact purpose/schedule before account open. Pass Temporal workflow run ID into account/operation keys. Replace Patent Cache direct BigQuery batch execution with bounded per-anchor `google_patents.search` Broker calls, typed projection receipts and transactional cache/domain ACKs. A wrapped Budget/Replay/Authority ActivityFailure terminates the workflow; it is never converted to an empty successful refresh.

- [ ] **Step 4: Run GREEN and schedule drift tests**

Expected: all platform wires are registered ToolBroker calls with platform authority and durable receipts.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/temporal apps/api/src/adapters/patent-inventor-cache.ts apps/api/src/adapters/patent-inventor-cache.spec.ts
git commit -m "feat(runtime): authorize every platform schedule"
```

### Task 4: Complete every Model/Tool strategy and domain ACK path

**Files:**

- Modify: `docs/governance/durable-result-strategies.json`
- Modify: every Tool declaration and Model task call-site found by the machine scan.
- Modify: relevant domain consumers and specs.

**Interfaces:**

- Consumes: typed/artifact registries and ACK service.
- Produces: zero unclassified physical paths.

- [ ] **Step 1: Run the strategy/account/ACK scanner as RED**

The scanner must enumerate all 18 currently registered Tools plus any new Tools and every `ModelGateway.generate*` product call. It fails if a physical path lacks authority binding, strategy, stable operation identity, receipt propagation or ACK consumer. It also detects direct external adapters from managed activities, including BigQuery.

- [ ] **Step 2: Record exact RED inventory**

Run: `node scripts/execution-authority-policy.mjs verify`

Expected: FAIL listing each remaining path, not a generic count.

- [ ] **Step 3: Add closed projections for all remaining small Tools**

Implement schemas/projectors for `searxng.search`, `wikidata.sparql`, `osm.overpass`, `wikidata.entity`, `gleif.fetch`, `companies_house.search`, `inpi_rne.search`, `google_patents.search`, `tradefair.algolia` and `mapyourshow.fetch`. Every nested field has explicit bounds; contact/personal fields are minimized and covered by privacy tests. Connect each domain consumer to `applyWithAck`.

- [ ] **Step 4: Run scanner and focused tests GREEN**

Expected: every physical call has exactly one declared strategy and one authority/receipt/ACK path.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src docs/governance/durable-result-strategies.json scripts/execution-authority-policy.mjs scripts/execution-authority-policy.spec.mjs
git commit -m "feat(governance): close execution durability inventory"
```

### Task 5: Personal-data artifact subject index and rights handling

**Files:**

- Modify: `packages/db/prisma/schema.prisma` and add a forward migration.
- Create: `apps/api/src/durable-results/artifact/generic-operation-artifact-subject.repository.ts`
- Test: repository/RLS specs.
- Modify: `apps/api/src/temporal/deletion.activities.ts` and specs.
- Modify: Data Rights query/deletion tests.

**Interfaces:**

- Consumes: PERSONAL_DATA artifact manifest and verified subject binding.
- Produces: append-only `GenericOperationArtifactSubject` lookup and deletion/tombstone chain.

- [ ] **Step 1: Write RED DSR tests**

Create PERSONAL_DATA artifacts for two workspaces/subjects. Assert a deletion request finds only the exact subject/workspace, deletes or cryptographically erases the object through the governed cleanup workflow, appends a tombstone/audit fact, and prevents rematerialization. Non-personal artifacts are not selected. Cross-workspace query is denied.

- [ ] **Step 2: Run RED**

Expected: FAIL because artifacts cannot be located by subject.

- [ ] **Step 3: Implement subject index and deletion chain**

Store only bounded subject type/ID references needed by the existing rights flow; never duplicate result bodies. Require a subject reference for PERSONAL_DATA artifact persistence. ACK-after-expiry remains valid domain state, but raw artifact access is denied after deletion/tombstone.

- [ ] **Step 4: Run GREEN and real RLS test**

Expected: exact subject deletion converges and no artifact is restored after tombstone.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma apps/api/src/durable-results/artifact apps/api/src/temporal/deletion.activities.ts apps/api/src/temporal/deletion.activities.spec.ts apps/api/src/compliance
git commit -m "feat(compliance): govern personal result artifacts"
```

### Task 6: Atomic database/product cutover and legacy removal

**Files:**

- Create: `packages/db/prisma/migrations/20260821120000_execution_budget_authority_cutover/migration.sql`
- Create: `packages/db/test/execution-budget-authority-cutover.spec.mjs`
- Modify: `packages/db/prisma/schema.prisma`
- Modify: `apps/api/src/tools/budget-store.ts`, `budget.ts`, all product open callers and tests.
- Modify: `apps/api/.env.example`.

**Interfaces:**

- Consumes: completed authority, microusd, strategy, artifact, receipt, ACK and reconciliation paths.
- Produces: authority-only NOT NULL schema/functions and no legacy runtime path.

- [ ] **Step 1: Write RED cutover migration and repository scans**

Assert all nonterminal/new accounts require `authority_id` and `authorized_cap_microusd`; app role cannot call old `open_tool_budget`; no product source references `capCents`, `RUN_BUDGET_CENTS`, `SWEEP_BUDGET_CENTS`, `runBudgetCents`, `sweepBudgetCents` or automatic open without authority. Historical terminal rows remain readable and cannot reserve.

- [ ] **Step 2: Run RED on a fresh and an upgraded disposable database**

Expected: FAIL before cutover migration/removal.

- [ ] **Step 3: Implement explicit-transaction cutover migration and delete legacy code**

Pause new work for retained rollout, but CI tests fresh and upgrade paths. Migration validates no active unauthorized accounts, makes new authority fields mandatory, replaces reserve/status/settle functions with microusd authority-aware versions, revokes old function execution and preserves historical terminal rows read-only. Switch every product caller from the legacy cap-bearing `open` to `openAuthorized`, delete the legacy method/function, and rename `openAuthorized` to the sole `open` interface in the same commit. Delete amount environment functions and product InMemory/default compatibility composition; retain test-only adapters under `packages/test-support` only.

- [ ] **Step 4: Run GREEN fresh/upgrade/rollback-compatibility tests**

Expected: fresh and upgrade succeed; N-1 compatibility result is explicitly recorded. If N-1 cannot operate safely, rollback contract is pause + forward-fix.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma apps/api/src/tools apps/api/src apps/api/.env.example packages/test-support
git commit -m "feat(budget): require signed authority for execution"
```

### Task 7: OpenAPI, errors and external command conformance

**Files:**

- Modify: `packages/contracts/openapi/openapi.json`
- Modify: `packages/contracts/src/generated/api.ts`
- Modify: event payload schemas/types and contract tests.
- Modify: controller Swagger decorators and stable error specs.

**Interfaces:**

- Consumes: seven workspace endpoints and all stable errors.
- Produces: canonical machine API/event contract.

- [ ] **Step 1: Write RED OpenAPI/contract assertions**

Assert all matrix endpoints require/display `X-Execution-Budget-Grant`, header maximum/documentation, 402/403/409/503 stable codes, no token in examples, and exact platform command schema. Ensure Site Builder's existing `X-Site-Build-Budget-Grant` remains unchanged.

- [ ] **Step 2: Run RED drift check**

Run the repository OpenAPI export/drift command. Expected: drift until canonical JSON is regenerated.

- [ ] **Step 3: Regenerate canonical contract from code**

Use the repository's code-first export command, inspect the diff, build/lint Contracts, regenerate client types and run oasdiff with the approved breaking-change label policy. Do not hand-edit endpoint paths/counts.

- [ ] **Step 4: Run GREEN**

Expected: OpenAPI drift, Spectral, generated types and event consumer tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src packages/contracts
git commit -m "feat(contracts): publish execution authority API"
```

### Task 8: Readiness, governance, OCI and CI enforcement

**Files:**

- Create: `scripts/execution-authority-policy.mjs`, `.spec.mjs` if not already committed.
- Modify: `scripts/governance-verify.mjs`, governance specs and CODEOWNERS.
- Modify: `apps/api/src/health/runtime-readiness.service.ts` and specs.
- Modify: `apps/api/src/runtime/managed-dependency-readiness.ts` and specs.
- Modify: `apps/api/src/temporal/worker.ts` and startup specs.
- Modify: `Dockerfile`, `.dockerignore`, runtime artifact/image verifiers and specs as required by the actual file manifest.
- Modify: `.github/workflows/ci.yml`.

**Interfaces:**

- Consumes: all product capabilities.
- Produces: fail-closed runtime and required CI gates.

- [ ] **Step 1: Write RED governance/readiness/OCI mutations**

Mutations remove a grant header, authority binding, strategy, ACK, artifact lifecycle, microusd field, Worker gate or fake-authority exclusion. Each must fail governance or runtime artifact verification. Readiness tests cover JWKS, workspace verifier, platform authority freshness, artifact store, strategy/materializer registry, migration and matching Worker/Relay/API lease.

- [ ] **Step 2: Run RED machine policies**

Expected: exact findings until wiring is complete.

- [ ] **Step 3: Implement required gates**

Add CI jobs/steps for real PostgreSQL/RLS, real MinIO, Temporal replay, changed-scope coverage >=80 statements/branches, OpenAPI/event diff, clean OCI actual build/inspect/whole-image scan, non-root, API/Worker same image, Worker fail-closed smoke and no fake signer/store/fixture bytes.

Split readiness into two levels. Global Worker readiness requires verifier configuration, database/migration, result registries, ToolBroker dependencies and artifact storage needed by enabled physical capabilities. Each Schedule has a purpose-specific authority readiness check; a disabled Schedule/source does not close unrelated workspace processing, while an enabled Schedule without its fresh authority remains non-consuming and is not registered/started. Governance locks the enabled-purpose matrix so an environment name cannot silently change the authorization semantics.

- [ ] **Step 4: Run GREEN locally where reproducible**

Expected: governance/docs/build/tests/contract scans pass. Hosted-only jobs remain unclaimed until the pushed exact head completes.

- [ ] **Step 5: Commit**

```bash
git add scripts docs/governance CODEOWNERS apps/api/src/health apps/api/src/runtime apps/api/src/temporal/worker.ts Dockerfile .dockerignore .github/workflows/ci.yml
git commit -m "ci: enforce execution authority runtime"
```

### Task 9: Full local verification and independent review

**Files:**

- Modify after proof: `docs/status/current.md`, `docs/architecture/current.md`, `docs/roadmap/changelog.md`.
- Create: `docs/implementation-records/execution-budget-artifact-replay-as-built.md`.

**Interfaces:**

- Consumes: Tasks 1-8 and all preceding subplans.
- Produces: exact clean-source candidate and honest as-built/local evidence.

- [ ] **Step 1: Run all source and infrastructure gates**

```bash
pnpm --filter @global/db exec prisma validate
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/contracts lint
pnpm --filter @global/api build
pnpm --filter @global/api test
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
git diff --check
```

Also run real PostgreSQL/FORCE RLS, Redis, MinIO, Temporal replay and changed-scope coverage. Expected: all pass; statements/branches >=80.

- [ ] **Step 2: Build and inspect one clean OCI image**

Build from the exact clean commit using the single Dockerfile. Run whole-image forbidden scan, SBOM/component digest verification, non-root config inspection, API no-dependency 503 smoke, Worker non-polling smoke, browser/prlimit smoke and artifact store/JWKS/authority fail-closed smoke.

- [ ] **Step 3: Request independent correctness and security reviews**

Reviewers inspect current source and migrations for authority bypass, JWS confusion, RLS/oracle, amount overflow, object corruption/SSRF, secret/body leakage, duplicate physical calls, ACK race, reconciliation starvation and rollback. All P0/P1 findings are fixed with RED→GREEN tests before continuing.

- [ ] **Step 4: Update as-built/current documentation**

Only after exact source gates pass, record commit/image/migration and local evidence. Mark external Control Plane transport and retained runtime as `EXTERNAL_OWNED`/`UNVERIFIED` until live readback. Do not claim Pilot/GA.

- [ ] **Step 5: Commit**

```bash
git add docs/status/current.md docs/architecture/current.md docs/roadmap/changelog.md docs/implementation-records/execution-budget-artifact-replay-as-built.md
git commit -m "docs: record execution durability as built"
```

### Task 10: Push, PR #413 current-head CI and merge

**Files:**

- Modify if required by the repository decision-card workflow: the exact PR decision card/evidence file.

**Interfaces:**

- Consumes: exact clean reviewed commit.
- Produces: updated PR #413, current-head CI/review evidence and merge commit.

- [ ] **Step 1: Re-read remote state and push the branch**

Fetch read-only, verify PR #413 still targets the intended base, verify no remote divergence, then push `codex/production-parity`. Record the exact pushed SHA.

- [ ] **Step 2: Update PR summary and unresolved threads**

Describe authority, microusd migration, typed/artifact results, ACK, reconciliation, readiness and rollout. Reply to each open review thread with exact source/test evidence; resolve only when the current pushed code proves it.

- [ ] **Step 3: Wait for current-head required CI**

Require build/typecheck/test, security, supply chain, governance, CodeQL, OpenAPI, real PostgreSQL, real object store, Temporal replay, changed-scope coverage and actual OCI jobs on the exact pushed head/merge candidate.

- [ ] **Step 4: Re-run independent current-head readback and merge**

Confirm approvals and required checks bind the exact current head. Merge using the repository-approved method; record merge commit. Do not infer merge from green CI alone.

- [ ] **Step 5: Synchronize the root main safely**

Use `node scripts/governance-main-worktree-sync.mjs status`, inspect the protected dirty root inventory, then use the approved `apply` path only if its preflight proves no tracked/untracked/ignored collision. Verify root status is byte-for-byte preserved.

### Task 11: Retained migration, deployment, restart and runtime evidence

**Files:**

- External/runtime state only; repository changes require a new reviewed forward-fix commit.

**Interfaces:**

- Consumes: merge commit, published exact OCI digest, Control Plane issuer/JWKS/platform command transport and deployment secrets.
- Produces: retained migration/deployment readback and RuntimeEvidence.

- [ ] **Step 1: Pre-deploy readback and pause new work**

Verify exact image digest, SBOM/artifact digest, migration revision, Control Plane issuer/JWKS, fresh platform authorities, task queue, N-1 compatibility and backup/restore readiness. Pause new work and drain old Worker at safe activity boundaries.

- [ ] **Step 2: Apply retained migration and deploy exact digest**

Run migration as the migration principal, read back all migration rows/functions/roles, start Worker and API from the same exact image digest, and keep API mutation/Worker polling closed until matching leases and all readiness components pass.

- [ ] **Step 3: Restart/readback and zero-cost smoke**

Read back API/Worker/Relay commit/image/artifact/migration/task queue/authority issuer/storage capability. Run deterministic zero-cost smoke first. Confirm no mixed digest Worker shares the queue.

- [ ] **Step 4: Run one bounded real Grant validation**

Use the already authorized small test amount, a dedicated development workspace and the normal Control Plane signer. Execute one real same-path request, verify one authority/account/operation/receipt/domain ACK, exact or upper-bound settlement, Outbox/reconciliation behavior and zero duplicate wire. Do not use an operator-generated local signer.

- [ ] **Step 5: Generate RuntimeEvidence and resume work**

Bind RuntimeEvidence to merge commit, exact registry image digest, artifact/SBOM digest, migration revision, issuer, task queue, verified time/expiry and result. Resume new work only after the evidence and readiness pass. Promotion to pilot/production remains a separate Release Bundle/product decision even though the same digest is eligible for promotion.
