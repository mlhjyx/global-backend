# Release Bundle — site-builder-production-parity-development-20260901

> Release ID：`site-builder-production-parity-development-20260901`
> 状态：`CANDIDATE`
> 环境：`development`
> Release Owner：`OWN-SITE-BE`
> 实现提交：`da2f7aebafe87de3a5286d13e9d77864464dff7e`
> 发布时间：`2026-09-01T18:34:00.000Z`

## Identity

- `CAP-SITE-INTAKE-001`
- `CAP-SITE-BUILD-001`
- `CAP-SITE-RUN-001`

### Traceability bindings

- `site-builder-development-intake-path` → `CAP-SITE-INTAKE-001` → `site-builder-deterministic-product-path-development-20260901`
- `site-builder-development-build-containment` → `CAP-SITE-BUILD-001` → `site-builder-unknown-settlement-containment-development-20260901`
- `site-builder-development-run-observation` → `CAP-SITE-RUN-001` → `site-builder-unknown-settlement-containment-development-20260901`

## Scope

```json
{
  "included": [
    "Deterministic Opaque Session to access token, technical quote, signed Budget Grant, intake and READY Release path",
    "Refurbish request authorization plus UNKNOWN settlement containment and request-bound cost observation"
  ],
  "excluded": [
    "Pilot or GA promotion",
    "customer Billing or Credits",
    "successful generative refurbish quality",
    "public site publication"
  ]
}
```

## Promise

```json
{
  "user_outcome": "A legitimate development tenant can enter the same product authorization and managed runtime path used by later environments without a customer balance or manual paid-call attestation.",
  "non_guarantees": [
    "The candidate does not promise a successful model output when provider accounting or response acknowledgement is unavailable.",
    "The candidate is not a Pilot, GA, or public publishing release."
  ]
}
```

## Source

```json
{
  "repository": "mlhjyx/global-backend",
  "base_commit": "4e8dfb43c896b94221e0fad01d8bcb5ec4a29b01",
  "source_head": "da2f7aebafe87de3a5286d13e9d77864464dff7e",
  "growthos_authority_commit": "541bcc63c3486296ab4e2461d4d005e6cd43710b"
}
```

## Evidence

- `site-builder-deterministic-product-path-development-20260901`
- `site-builder-unknown-settlement-containment-development-20260901`

## External provenance

```json
{
  "status": "EXTERNAL_UNVERIFIED",
  "verifier": "NONE",
  "verification_ref": "NONE"
}
```

## Operations

```json
{
  "runtime_identity_endpoint": "/api/v1/health/build",
  "readiness_endpoint": "/api/v1/health/ready",
  "temporal_task_queue": "understanding",
  "reconciliation": "request-bound accounting lookup only; never a second generation request"
}
```

## Data

```json
{
  "classification": "development synthetic tenant with no raw tokens, prompts, model response bodies, credentials, cookies, or private keys retained in this bundle",
  "retention": "RuntimeEvidence expires after its exclusive valid_until; the readback remains historical provenance."
}
```

## Rollback and exit

```json
{
  "trigger": "API, Worker, or Relay identity mismatch; migration incompatibility; readiness failure; or duplicate active Worker digest on one queue",
  "procedure": "Pause new BuildRuns and use the saved exact N-1 OCI digest only when schema-compatible; otherwise forward-fix without destructive database rollback."
}
```

## Guides

- docs/architecture/current.md
- docs/adr/registry.md
- docs/evidence/site-builder/production-parity-development-runtime-readback-20260901.json

## Approval

```json
{
  "machine": {
    "status": "NOT_VERIFIED",
    "provenance": "NONE",
    "evidence_ref": "CROSS_REPOSITORY_SCOPE_NOT_COVERED_BY_ONE_CHECK_RUN",
    "verified_at": "2026-09-01T18:17:42Z"
  },
  "reviewer": {
    "status": "NOT_REVIEWED",
    "provenance": "NONE",
    "evidence_ref": "NONE",
    "actor": "NONE",
    "reviewed_at": "2026-09-01T18:34:00Z"
  },
  "user_authorization": {
    "status": "NOT_AUTHORIZED",
    "provenance": "NONE",
    "evidence_ref": "NONE_FOR_PILOT_OR_GA",
    "actor": "product-owner",
    "authorized_at": "2026-09-01T18:34:00Z"
  }
}
```

### Merge evidence

```json
{
  "method": "squash",
  "pull_request": "https://github.com/mlhjyx/global-backend/pull/441",
  "result_commit": "da2f7aebafe87de3a5286d13e9d77864464dff7e",
  "parent_commit": "4e8dfb43c896b94221e0fad01d8bcb5ec4a29b01",
  "merged_at": "2026-09-01T18:17:42Z",
  "status": "DOCUMENTARY_EXTERNAL_UNVERIFIED"
}
```

## Learning

```json
{
  "owner": "OWN-SITE-BE",
  "review_at": "2026-09-02T17:33:25Z",
  "success_measure": "A future exact-digest run obtains a durable valid model output and resolves exact provider cost without changing the product authorization path."
}
```
