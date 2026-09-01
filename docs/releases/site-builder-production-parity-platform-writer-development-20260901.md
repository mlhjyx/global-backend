# Release Bundle — site-builder-production-parity-platform-writer-development-20260901

> Release ID：`site-builder-production-parity-platform-writer-development-20260901`
> 状态：`CANDIDATE`
> 环境：`development`
> Release Owner：`OWN-SITE-BE`
> 实现提交：`674ff12d4d768ce5599fc07b565fe21da37dc5fe`
> 发布时间：`2026-09-01T20:08:30.000Z`

## Identity

- `CAP-SITE-INTAKE-001`
- `CAP-SITE-BUILD-001`
- `CAP-SITE-RUN-001`

### Traceability bindings

- `site-builder-development-intake-path-platform-writer` → `CAP-SITE-INTAKE-001` → `site-builder-deterministic-product-path-platform-writer-development-20260901`
- `site-builder-development-build-containment-platform-writer` → `CAP-SITE-BUILD-001` → `site-builder-unknown-containment-platform-writer-development-20260901`
- `site-builder-development-run-observation-platform-writer` → `CAP-SITE-RUN-001` → `site-builder-unknown-containment-platform-writer-development-20260901`

## Scope

```json
{
  "included": [
    "Exact-digest API, Worker, Relay, migration and readiness identity",
    "Zero-model GrowthOS Session, Access Token, Technical Quote, signed Budget Grant, Intake and READY Release",
    "Readback of the historical UNKNOWN operation after three request-bound reconciliation attempts without redispatch"
  ],
  "excluded": [
    "Pilot or GA promotion",
    "successful generative refurbish output",
    "platform acquisition, intent-watch, or sanctions authority ingestion",
    "customer Billing or Credits",
    "public site publication"
  ]
}
```

## Promise

```json
{
  "user_outcome": "A legitimate development tenant can complete the same deterministic product authorization and Build path on the new exact Backend runtime without a customer balance or manual paid-call attestation.",
  "non_guarantees": [
    "The candidate does not claim successful generative output or exact settlement for the historical UNKNOWN operation.",
    "The candidate is not a Pilot, GA, or public publishing release."
  ]
}
```

## Source

```json
{
  "repository": "mlhjyx/global-backend",
  "base_commit": "87a77520c16e00d47e201924e2c23e38bb1333a6",
  "source_head": "674ff12d4d768ce5599fc07b565fe21da37dc5fe",
  "growthos_authority_commit": "541bcc63c3486296ab4e2461d4d005e6cd43710b"
}
```

## Evidence

- `site-builder-deterministic-product-path-platform-writer-development-20260901`
- `site-builder-unknown-containment-platform-writer-development-20260901`

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
  "platform_authority_state": "writer admitted; platform.acquisition missing",
  "reconciliation": "request-bound accounting lookup only; never a second generation request"
}
```

## Data

```json
{
  "classification": "development synthetic tenant; no raw tokens, prompts, model response bodies, credentials, cookies, or private keys retained",
  "retention": "RuntimeEvidence expires after its exclusive valid_until; receipts remain historical provenance."
}
```

## Rollback and exit

```json
{
  "trigger": "API, Worker, or Relay identity mismatch; readiness failure; or duplicate active Worker digest on one queue",
  "procedure": "Pause new BuildRuns and use the saved exact N-1 OCI digest only when schema-compatible; otherwise forward-fix without destructive database rollback."
}
```

## Guides

- docs/architecture/current.md
- docs/adr/registry.md
- docs/evidence/site-builder/production-parity-platform-writer-runtime-readback-20260901.json

## Approval

```json
{
  "machine": {
    "status": "NOT_VERIFIED",
    "provenance": "NONE",
    "evidence_ref": "CROSS_REPOSITORY_SCOPE_NOT_COVERED_BY_ONE_CHECK_RUN",
    "verified_at": "2026-09-01T20:08:30.000Z"
  },
  "reviewer": {
    "status": "NOT_REVIEWED",
    "provenance": "NONE",
    "evidence_ref": "NONE",
    "actor": "NONE",
    "reviewed_at": "2026-09-01T20:08:30.000Z"
  },
  "user_authorization": {
    "status": "NOT_AUTHORIZED",
    "provenance": "NONE",
    "evidence_ref": "NONE_FOR_PILOT_OR_GA",
    "actor": "product-owner",
    "authorized_at": "2026-09-01T20:08:30.000Z"
  }
}
```

### Merge evidence

```json
{
  "method": "squash",
  "pull_request": "https://github.com/mlhjyx/global-backend/pull/443",
  "result_commit": "674ff12d4d768ce5599fc07b565fe21da37dc5fe",
  "parent_commit": "87a77520c16e00d47e201924e2c23e38bb1333a6",
  "merged_at": "2026-09-01T19:24:27.000Z",
  "status": "DOCUMENTARY_EXTERNAL_UNVERIFIED"
}
```

## Learning

```json
{
  "owner": "OWN-SITE-BE",
  "review_at": "2026-09-02T19:08:12.000Z",
  "success_measure": "The external Control Plane ingests the three signed platform authorities without changing the Site Builder product path; any future generative smoke requires a new explicit dispatch decision."
}
```
