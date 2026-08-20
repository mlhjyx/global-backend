# Generic Operation Artifact Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream large managed Tool results into immutable content-addressed object storage and restore them safely across retries, workers and restarts.

**Architecture:** Artifact-producing Tools return a bounded stream descriptor instead of a body string. A generic artifact service writes staging bytes while hashing, promotes to a digest-derived immutable key, performs HEAD/readback verification, appends a PostgreSQL manifest, and settles only a small artifact reference. First-run consumers materialize through the same verified read path used by retries.

**Tech Stack:** TypeScript streams, AWS SDK S3 client, MinIO/S3, Prisma, PostgreSQL FORCE RLS, SHA-256, NestJS, Vitest, Docker Compose integration tests.

**Spec:** `docs/architecture/execution-budget-authority-artifact-replay-design.md`

## Global Constraints

- Large bodies never enter `tool_budget_operation.result_json`, Temporal payload/history, logs, traces or Outbox.
- Object key is exactly `generic-operation-results/v1/sha256/<first-two-hex>/<64-lowercase-hex>`.
- Runtime replicas validate and use storage; only deployment/IaC provisions bucket, encryption, versioning and lifecycle.
- Upload is streaming and byte-bounded; over-limit results are not truncated and cannot be retried physically.
- Object ACK uncertainty changes the operation to `RESULT_UNKNOWN`; recovery only probes the expected digest/key.
- Read validates closed reference schema, scope, authority, operation, schema, expiry, size, digest and metadata before materialization.
- `PERSONAL_DATA` uses a separate short TTL and least-privileged read role.
- First artifact Tools are `sanctions.download`, `http.get`, and Crawl4AI fetch/render.

---

## File Structure

**Create:**

- `apps/api/src/durable-results/artifact/artifact.types.ts` — privacy class, stream source, manifest and reference types.
- `apps/api/src/durable-results/artifact/artifact-reference.schema.ts` — closed AJV schema/parser for the small projection.
- `apps/api/src/durable-results/artifact/artifact-key.ts` — digest-derived object/staging keys.
- `apps/api/src/durable-results/artifact/generic-operation-artifact.repository.ts` — append/read metadata repository.
- `apps/api/src/durable-results/artifact/generic-operation-artifact.store.ts` — storage port and S3 implementation.
- `apps/api/src/durable-results/artifact/generic-operation-artifact.service.ts` — write/promote/recover/materialize orchestration.
- `apps/api/src/durable-results/artifact/artifact-materializer.registry.ts` — schema-specific bounded materializers.
- `apps/api/src/durable-results/artifact/materializers/sanctions-download.materializer.ts`
- `apps/api/src/durable-results/artifact/materializers/http-get.materializer.ts`
- `apps/api/src/durable-results/artifact/materializers/crawl4ai.materializer.ts`
- Focused unit specs plus `apps/api/src/durable-results/artifact/generic-operation-artifact.minio.spec.ts`.
- `packages/db/prisma/migrations/20260821100000_generic_operation_artifact/migration.sql` — additive manifest/RLS/functions.
- `packages/db/test/generic-operation-artifact.rls.spec.mjs`.
- `infra/minio/generic-operation-artifact-lifecycle.json` — deployment-owned lifecycle contract.

**Modify:**

- `packages/db/prisma/schema.prisma` — `GenericOperationArtifact` model and operation relation.
- `apps/api/src/tools/tool-contract.ts` — artifact-producing Tool execution surface.
- `apps/api/src/tools/tool-broker.ts` — persist/materialize artifact strategy.
- `apps/api/src/tools/builtin-tools.ts` and `apps/api/src/tools/source-tools.ts` — stream producers for HTTP/Crawl4AI/Sanctions.
- `apps/api/src/runtime/managed-dependency-readiness.ts`, `apps/api/src/health/runtime-readiness.service.ts` — artifact storage readiness.
- `infra/minio/bootstrap.sh`, `infra/backend-runtime.compose.yml`, `scripts/runtime-deployment-contract.spec.mjs` — provision/validate exact bucket contract.
- `apps/api/.env.example` — artifact bucket/config references; no fake store.

## Locked Interfaces

```ts
export type ArtifactPrivacyClass =
  "PUBLIC_ORGANIZATION" | "CONFIDENTIAL_TENANT" | "PERSONAL_DATA";

export interface ArtifactSource {
  body: AsyncIterable<Uint8Array>;
  mediaType: string;
  sourceDigest?: string;
}

export interface GenericOperationArtifactReference {
  schemaVersion: "generic-operation-artifact-ref/v1";
  artifactId: string;
  operationId: string;
  resultSchema: string;
  sha256: string;
  sizeBytes: string;
  mediaType: string;
  expiresAt: string;
}

export interface ArtifactMaterializer<T> {
  readonly resultSchema: string;
  materialize(
    input: AsyncIterable<Uint8Array>,
    manifest: GenericOperationArtifactManifest,
  ): Promise<T>;
}
```

### Task 1: Artifact types, reference schema and key derivation

**Files:**

- Create: `apps/api/src/durable-results/artifact/artifact.types.ts`
- Create: `apps/api/src/durable-results/artifact/artifact-reference.schema.ts`
- Create: `apps/api/src/durable-results/artifact/artifact-key.ts`
- Test: `apps/api/src/durable-results/artifact/artifact-reference.schema.spec.ts`
- Test: `apps/api/src/durable-results/artifact/artifact-key.spec.ts`

**Interfaces:**

- Consumes: artifact reference fields from the approved spec.
- Produces: types above, `parseArtifactReference`, `contentAddressedObjectKey`, `stagingObjectKey`.

- [ ] **Step 1: Write RED schema/key tests**

```ts
expect(contentAddressedObjectKey("ab".padEnd(64, "0"))).toBe(
  `generic-operation-results/v1/sha256/ab/${"ab".padEnd(64, "0")}`,
);
expect(() =>
  parseArtifactReference({ ...valid, objectKey: "caller-controlled" }),
).toThrow("GENERIC_OPERATION_ARTIFACT_INVALID");
```

Reject extra fields, non-UUID IDs, non-canonical size strings, invalid media type, invalid RFC3339 time and digest/key mismatch. Keep `objectKey` out of the public small reference; derive it from digest during repository/store reads.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/durable-results/artifact/artifact-reference.schema.spec.ts src/durable-results/artifact/artifact-key.spec.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement closed parsing and mechanical key derivation**

Use AJV strict schema with `additionalProperties:false`. `stagingObjectKey` accepts a generated artifact UUID and returns `generic-operation-results/v1/staging/<uuid>`; no user input enters object keys.

- [ ] **Step 4: Run GREEN**

Run the two focused specs. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/durable-results/artifact/artifact.types.ts apps/api/src/durable-results/artifact/artifact-reference.schema.ts apps/api/src/durable-results/artifact/artifact-key.ts apps/api/src/durable-results/artifact/*.spec.ts
git commit -m "feat(artifacts): define operation artifact contract"
```

### Task 2: Additive manifest schema, RLS and repository

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260821100000_generic_operation_artifact/migration.sql`
- Create: `packages/db/test/generic-operation-artifact.rls.spec.mjs`
- Create: `apps/api/src/durable-results/artifact/generic-operation-artifact.repository.ts`
- Test: `apps/api/src/durable-results/artifact/generic-operation-artifact.repository.spec.ts`

**Interfaces:**

- Consumes: Task 1 manifest/reference types.
- Produces: `appendManifest`, `findExact`, `findByOperation`, unique scope/digest/schema guarantees.

- [ ] **Step 1: Write RED real-DB and repository tests**

Assert append/read only, cross-workspace invisibility, exact idempotency, conflicting size/media/source digest rejection, operation/authority binding and app-role UPDATE/DELETE denial. Platform scope must use the fixed platform DB role and cannot be read through an arbitrary workspace session.

- [ ] **Step 2: Run RED**

Run Prisma validate and the new disposable PostgreSQL test. Expected: FAIL because table/functions are absent.

- [ ] **Step 3: Implement schema and explicit-transaction migration**

Use canonical decimal strings only at API boundaries; store `size_bytes` as BIGINT. Add:

```prisma
model GenericOperationArtifact {
  id           String   @id @default(uuid()) @db.Uuid
  scopeKey     String   @map("scope_key") @db.VarChar(200)
  workspaceId  String?  @map("workspace_id") @db.Uuid
  authorityId  String   @map("authority_id") @db.Uuid
  operationId  String   @map("operation_id") @db.Uuid
  resultSchema String   @map("result_schema") @db.VarChar(100)
  objectKey    String   @map("object_key") @db.VarChar(200)
  sha256       String   @db.Char(64)
  sizeBytes    BigInt   @map("size_bytes")
  mediaType    String   @map("media_type") @db.VarChar(160)
  privacyClass String   @map("privacy_class") @db.VarChar(40)
  sourceDigest String?  @map("source_digest") @db.Char(64)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  expiresAt    DateTime @map("expires_at") @db.Timestamptz(3)
}
```

Migration constraints derive/check the object key from digest and bind the operation/authority/scope. Repository calls only narrow SECURITY DEFINER functions with fixed search path and parameterized SQL.

- [ ] **Step 4: Run GREEN**

Run Prisma validate/generate, repository specs and real RLS tests. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260821*_generic_operation_artifact/migration.sql packages/db/test/generic-operation-artifact.rls.spec.mjs apps/api/src/durable-results/artifact/generic-operation-artifact.repository.ts apps/api/src/durable-results/artifact/generic-operation-artifact.repository.spec.ts
git commit -m "feat(db): persist immutable operation artifacts"
```

### Task 3: S3 storage port and bounded streaming protocol

**Files:**

- Create: `apps/api/src/durable-results/artifact/generic-operation-artifact.store.ts`
- Test: `apps/api/src/durable-results/artifact/generic-operation-artifact.store.spec.ts`

**Interfaces:**

- Consumes: Task 1 keys/source types.
- Produces: `GenericOperationArtifactStore`, `S3GenericOperationArtifactStore`.

- [ ] **Step 1: Write RED transport tests**

Cover 0 bytes, exact maximum bytes, maximum + 1, source stream failure, staging PUT failure, promote ACK unknown, immutable target already present, HEAD mismatch, digest metadata mismatch, abort signal and fixed redacted errors. Assert no Buffer accumulation for a multi-chunk maximum fixture by using an async iterable that fails if read ahead exceeds one chunk.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/durable-results/artifact/generic-operation-artifact.store.spec.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement streaming store**

Define:

```ts
interface GenericOperationArtifactStore {
  stage(input: {
    artifactId: string;
    source: ArtifactSource;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<StagedArtifact>;
  promote(input: StagedArtifact): Promise<StoredArtifact>;
  inspect(sha256: string, signal?: AbortSignal): Promise<StoredArtifact | null>;
  read(
    sha256: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  deleteStaging(artifactId: string): Promise<void>;
  checkReadiness(): Promise<ArtifactStorageReadiness>;
}
```

Hash while streaming. Include digest, size, schema and privacy metadata in the immutable object. On promote uncertainty, inspect only the digest-derived final key. Errors expose stable codes, not endpoint, bucket, access key or SDK message.

- [ ] **Step 4: Run GREEN**

Run focused store specs and API build. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/durable-results/artifact/generic-operation-artifact.store.ts apps/api/src/durable-results/artifact/generic-operation-artifact.store.spec.ts
git commit -m "feat(artifacts): stream immutable object results"
```

### Task 4: Artifact orchestration and RESULT_UNKNOWN recovery

**Files:**

- Create: `apps/api/src/durable-results/artifact/generic-operation-artifact.service.ts`
- Test: `apps/api/src/durable-results/artifact/generic-operation-artifact.service.spec.ts`
- Modify: `apps/api/src/tools/budget-store.ts`
- Modify: `apps/api/src/tools/budget-store.spec.ts`
- Modify: authority/artifact migration with a new forward migration if Task 2 is already committed.

**Interfaces:**

- Consumes: repository/store and BudgetReservation.
- Produces: `persist`, `recoverUnknown`, `readVerified`; `BudgetStore.markResultUnknown` and `BudgetStore.settleArtifactReference`.

- [ ] **Step 1: Write RED state-transition tests**

Assert:

- stage/promote/readback/manifest/settle success returns a closed reference;
- promote ACK unknown calls `markResultUnknown`, retains the full reservation and never calls Provider/producer again;
- expected immutable object found during recovery appends manifest and settles;
- object absent/mismatched during recovery returns `GENERIC_OPERATION_ARTIFACT_INVALID` without producer call;
- staging cleanup failure is logged as a bounded code and left to lifecycle.

- [ ] **Step 2: Run RED**

Run service and BudgetStore specs. Expected: FAIL because status/recovery methods are absent.

- [ ] **Step 3: Implement ordered protocol**

The service sequence must be exactly: stage -> promote -> inspect/readback -> DB manifest append -> small artifact-reference projection settle -> best-effort staging delete. `markResultUnknown` is used only after execution has started and a result/object ACK cannot be established. It is never used for pre-wire policy/limiter denials.

- [ ] **Step 4: Run GREEN**

Run focused tests and real PostgreSQL operation-state test. Expected: reservation remains unchanged in RESULT_UNKNOWN and recovery cannot open a new generation.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/durable-results/artifact/generic-operation-artifact.service.ts apps/api/src/durable-results/artifact/generic-operation-artifact.service.spec.ts apps/api/src/tools/budget-store.ts apps/api/src/tools/budget-store.spec.ts packages/db/prisma/migrations
git commit -m "feat(artifacts): recover unknown result writes"
```

### Task 5: Materializer registry and first three materializers

**Files:**

- Create: `apps/api/src/durable-results/artifact/artifact-materializer.registry.ts`
- Create: three materializer files listed above.
- Test: corresponding materializer specs.

**Interfaces:**

- Consumes: verified stream and manifest.
- Produces: bounded `SanctionsDownloadOutput`, `HttpGetOutput`, and Crawl4AI output.

- [ ] **Step 1: Write RED parser/materializer tests**

Use streamed fixtures and mutations for invalid UTF-8, media mismatch, XML entity expansion/DOCTYPE, JSON depth, HTML size, missing required fields and trailing data. Sanctions XML must disable external entities and apply existing business parser limits. HTTP/Crawl4AI must return only the existing bounded product result shape.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/durable-results/artifact/materializers`

Expected: FAIL because the registry/materializers do not exist.

- [ ] **Step 3: Implement strict schema-specific materializers**

Register exact schema IDs:

```text
sanctions-download/v1
http-get/v1
crawl4ai-fetch/v1
crawl4ai-render/v1
```

Registry startup rejects duplicate/missing definitions. Materializers receive no credentials and cannot select arbitrary object keys.

- [ ] **Step 4: Run GREEN and coverage**

Run focused specs with coverage. Expected: changed statements/branches >=80%.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/durable-results/artifact/artifact-materializer.registry.ts apps/api/src/durable-results/artifact/materializers
git commit -m "feat(artifacts): add bounded result materializers"
```

### Task 6: Integrate Sanctions, HTTP and Crawl4AI through ToolBroker

**Files:**

- Modify: `apps/api/src/tools/tool-contract.ts`
- Modify: `apps/api/src/tools/tool-broker.ts`
- Modify: `apps/api/src/tools/tool-broker.spec.ts`
- Modify: `apps/api/src/tools/source-tools.ts`
- Modify: `apps/api/src/tools/builtin-tools.ts`
- Modify: source/builtin Tool specs.
- Modify: `apps/api/src/temporal/sanctions-refresh.activities.ts` and specs.

**Interfaces:**

- Consumes: artifact service/materializers and strategy declarations.
- Produces: artifact-producing Tool execution surface and broker first-run/replay parity.

- [ ] **Step 1: Write RED first-run/retry/multi-worker tests**

Worker A executes and writes artifact; Worker B has a fresh service instance and only the same database/object store. Retry through Worker B must materialize the same result with producer execute count one. Repeat for Sanctions, HTTP and Crawl4AI. Assert no body string appears in reservation projection or simulated Temporal result.

- [ ] **Step 2: Run RED**

Run ToolBroker, source-tools, builtin-tools and sanctions activity specs. Expected: FAIL because tools still return inline bodies.

- [ ] **Step 3: Implement artifact-producing Tool union and broker path**

Add `executeArtifact(input,ctx): Promise<ArtifactSource>` only to `artifact_reference` Tools. ToolBroker rejects a strategy/method mismatch at startup. On first execution, Broker persists then calls `readVerified` and the schema materializer; on replay it uses the stored reference and identical read/materialize path.

- [ ] **Step 4: Run GREEN**

Run the focused tests and API/Worker build. Expected: execute count one across retry.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tools apps/api/src/temporal/sanctions-refresh.activities.ts apps/api/src/temporal/sanctions-refresh.activities.spec.ts
git commit -m "feat(tools): replay large results from artifacts"
```

### Task 7: Real MinIO, readiness and deployment contract

**Files:**

- Create: `apps/api/src/durable-results/artifact/generic-operation-artifact.minio.spec.ts`
- Modify: `apps/api/src/runtime/managed-dependency-readiness.ts`
- Modify: `apps/api/src/health/runtime-readiness.service.ts`
- Modify: readiness specs.
- Create: `infra/minio/generic-operation-artifact-lifecycle.json`
- Modify: `infra/minio/bootstrap.sh`
- Modify: `infra/backend-runtime.compose.yml`
- Modify: `scripts/runtime-deployment-contract.spec.mjs`
- Modify: `apps/api/.env.example`

**Interfaces:**

- Consumes: S3 store readiness.
- Produces: `generic_artifact_storage` runtime readiness and deployment-owned bucket policy.

- [ ] **Step 1: Write RED real-store and topology tests**

Use two S3 clients/service instances. Cover maximum object, existing immutable object, corrupt replacement attempt, metadata drift, lifecycle classes, versioning/encryption readback and PERSONAL_DATA read-role denial. Readiness must perform a bounded write/read/delete canary under a reserved prefix and never provision the bucket.

- [ ] **Step 2: Run RED**

Run deployment contract and MinIO specs against the repository Compose project. Expected: FAIL because the artifact bucket/lifecycle/readiness are absent.

- [ ] **Step 3: Implement deployment provisioning and runtime validation**

Provision through `infra/minio/bootstrap.sh` only. Configure PUBLIC_ORGANIZATION and CONFIDENTIAL_TENANT TTLs from fixed lifecycle tags, and PERSONAL_DATA with the approved shorter TTL. Inject endpoint/bucket/secret references into both API and Worker exact-image services; no development-only store is registered.

- [ ] **Step 4: Run GREEN and restart-safe test**

Restart the disposable Worker/service process between write and materialize. Expected: materialization succeeds; missing/wrong lifecycle keeps readiness not ready and Worker non-polling.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/durable-results/artifact/generic-operation-artifact.minio.spec.ts apps/api/src/runtime/managed-dependency-readiness.ts apps/api/src/health infra/minio infra/backend-runtime.compose.yml scripts/runtime-deployment-contract.spec.mjs apps/api/.env.example
git commit -m "feat(runtime): validate operation artifact storage"
```

### Task 8: Artifact subproject verification

**Files:**

- Modify: `docs/roadmap/changelog.md`
- Create: `docs/implementation-records/generic-operation-artifact-replay.md`

**Interfaces:**

- Consumes: Tasks 1-7.
- Produces: exact additive artifact evidence without product-cutover claim.

- [ ] **Step 1: Run focused coverage and real infrastructure suites**

Expected: artifact changed statements/branches >=80%; real PostgreSQL/FORCE RLS and real MinIO suites pass.

- [ ] **Step 2: Run full builds/tests/governance**

```bash
pnpm --filter @global/db exec prisma validate
pnpm --filter @global/api build
pnpm --filter @global/api test
pnpm governance:verify
pnpm docs:verify
git diff --check
```

- [ ] **Step 3: Rebuild ContractGraph and inspect impact**

Run scan/status and impact for Tool contract, ToolBroker, artifact service, schema and runtime readiness. Expected: exact current tree.

- [ ] **Step 4: Write the implementation record**

Record object limits, TTL/privacy classes, migration, MinIO test topology, corruption/restart results, coverage and remaining ACK/cutover dependencies. Do not include object bodies or secrets.

- [ ] **Step 5: Commit**

```bash
git add docs/implementation-records/generic-operation-artifact-replay.md docs/roadmap/changelog.md
git commit -m "docs: record artifact replay verification"
```
