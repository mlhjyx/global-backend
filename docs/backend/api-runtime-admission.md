# API runtime admission and readiness runbook

This contract keeps the Ubuntu API process loopback-only and makes build,
migration, and dependency provenance observable without consulting a dirty
runtime checkout. It prepares source and the checked-in systemd contract only;
it does not edit credentials, containers, a live unit, or a live service.

## Deployment stage and network admission

`DEPLOYMENT_STAGE` is the explicit stage source and accepts only
`development`, `pilot`, or `production`.

- It is mandatory. The process never derives a deployment stage from
  `NODE_ENV`.
- `NODE_ENV`, when present, accepts only `development`, `test`, or
  `production`. Pilot and production additionally require it to be exactly
  `production`; a missing or misspelled value is rejected. Development cannot
  downgrade a `NODE_ENV=production` process.
- Development defaults `API_BIND_HOST` to `127.0.0.1`. Pilot and production
  require it explicitly. The current Ubuntu contract accepts only
  `127.0.0.1`; `0.0.0.0`, `localhost`, IPv6 wildcards, URLs, whitespace, and
  other aliases fail before Nest creates the application.
- `PORT` defaults to `3000` and otherwise must be a canonical base-10 integer
  from 1 through 65535.
- Development may omit `CORS_ORIGINS`. Pilot and production require a
  comma-separated, non-empty list of canonical HTTP(S) origins. Wildcards,
  credentials, paths, queries, fragments, and blank entries are rejected.
  Bootstrap uses the admitted list; it does not re-interpret `NODE_ENV`.
- Development without `AUTH_JWKS_URI` and `AUTH_ISSUER` must explicitly set
  `AUTH_ALLOW_DEV_TOKENS=true` before the base64 development verifier is
  admitted. Missing or `false` fails closed. Pilot and production forbid this
  switch and always require JWKS.

The process environment is copied and frozen once before `NestFactory.create`.
That single snapshot derives auth mode, model-stub permission, object-storage
availability and lifecycle policy, processor jurisdiction, renderer build
identity, and Temporal connection options. Auth, model, storage, compliance,
Site Release, health, CORS, and listen receive the same DI object; none may
re-read `NODE_ENV` or recalculate admission. In pilot and production, missing
JWKS, model gateway, S3 credentials, processor jurisdiction, or renderer build
identity—and any dev-token/model-stub override—fails before Nest is created.

`--export-openapi` is the only non-runtime entrypoint. It branches before
runtime admission and uses Nest preview metadata mode, where providers and
controllers are not instantiated. It therefore does not construct database or
Temporal clients and does not weaken the fail-closed admission used by a real
API process.

## Build receipt: the runtime identity source

Pilot and production do not trust four mutable environment variables as build
identity. They require `apps/api/dist/runtime-build-receipt.json`, generated
after the final API build and shipped inside that exact artifact tree.

The generator receives the source commit explicitly and never invokes Git:

```bash
pnpm --filter @global/api build
pnpm --filter @global/api build:receipt -- \
  --source-sha <full-40-or-64-hex-source-commit> \
  --build-time <canonical-UTC-timestamp-with-milliseconds>
```

`--artifact-root`, `--receipt-path`, and `--migration-root` may override their
defaults for a packaging workspace; the migration default is the repository's
`packages/db/prisma/migrations` tree. `--expected-artifact-digest` and
`--expected-migration-manifest-digest` may carry independent attestations, but
neither can replace the values derived from source bytes.

The v2 digest contract is
`sha256-global-sorted-relative-path-size-and-file-sha256-v2`: the scanner opens
the canonical root and every file with `O_NOFOLLOW`, reads bytes from the same
descriptor whose device/inode/size/timestamps it verifies before and after,
globally sorts the complete UTF-8 relative-path set, then hashes framed path,
size, and per-file SHA-256. The receipt itself is excluded. Root, directory,
file, or receipt symlinks, replacements, mutation races, special files, and
resource-limit violations are rejected. The generator atomically writes the
receipt with mode `0444`. Runtime admission then:

1. rejects a missing, writable, symlinked, oversized, malformed, or unknown
   receipt;
2. recomputes the artifact digest and compares it with the receipt;
3. derives an ordered `{name, checksum}` manifest directly from every source
   `migration.sql`, where each checksum is SHA-256 of the exact raw bytes, and
   validates `BUILD_SHA`, `BUILD_TIME`, `ARTIFACT_DIGEST`, and
   `MIGRATION_MANIFEST_DIGEST` in the receipt; and
4. if any of those environment variables are present at runtime, requires all
   four and exact equality with the receipt. Environment values never replace
   a missing receipt.

Generate the receipt only after the last operation that changes `dist/`.
Rebuilding, instrumenting, or patching artifact bytes after receipt generation
invalidates admission. The release pipeline must preserve the receipt and its
read-only mode in the packaged artifact. The receipt is not digitally signed:
its trust boundary is reviewed CI input plus immutable package delivery. Until
those controls are wired and accepted, receipt self-verification is not an
independent source-authenticity proof and must not be used to open the pilot.

## Health endpoints

All probes remain outside the business response envelope and expose closed
status/code values only—never DSNs, credentials, migration SQL, exception
messages, Temporal server details, or response bodies.

| Endpoint                   | Meaning                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health`       | Existing process-liveness response; preserved for compatibility.                                                            |
| `GET /api/v1/health/db`    | Existing simple DB connectivity response; preserved for compatibility.                                                      |
| `GET /api/v1/health/live`  | Process liveness only; performs no dependency calls.                                                                        |
| `GET /api/v1/health/build` | Receipt-backed build SHA/time, artifact digest, migration-manifest digest/count, and derived latest revision. Development without a receipt reports `UNVERIFIED`. |
| `GET /api/v1/health/ready` | Bounded aggregate; HTTP 200 only when every required typed check is `PASS`, otherwise HTTP 503 with `NOT_READY`.            |

The readiness aggregate currently proves:

- admitted stage, host, port, and CORS configuration;
- receipt-backed build identity;
- database connectivity, absence of an unresolved Prisma migration, and exact
  equality of the complete active `_prisma_migrations` name/checksum sequence
  with the receipt manifest. The probe first installs a transaction-local
  PostgreSQL `statement_timeout`, so its outer Promise bound does not leave an
  unbounded query running; and
- bounded Temporal `getSystemInfo` connectivity.

The base repository has no trustworthy durable proof provider for worker
heartbeat, Outbox relay ownership/recency, or gateway admission. Their injected
probe seams therefore return `UNVERIFIED / PROOF_SOURCE_UNAVAILABLE`, and each
is a required gate. Probe errors and timeouts map to closed failure codes.

## Temporal cold-start and post-start semantics

Temporal is a **hard startup dependency** with a finite connection timeout.
If Temporal is unavailable during Nest lifecycle initialization, startup
rejects and the API does not bind a listener; systemd's `Restart=on-failure`
handles retry. There is no reachable liveness endpoint for a process that did
not finish starting.

After startup, a later Temporal outage is different: the process remains live,
the bounded `temporal` readiness probe fails, and `/health/ready` returns 503.
`TEMPORAL_REACHABLE` proves only the Temporal server edge, never that a worker
is polling; the required `worker_heartbeat` placeholder remains closed until a
durable proof provider is separately reviewed.

## Expected blocker state

This runtime-identity change alone is intentionally **not pilot-ready**:

- `/health/ready` is expected to return 503 until a separately reviewed ops
  change supplies durable worker-heartbeat, Outbox-relay, and gateway-admission
  proof providers.
- The repository now provides an executable, tested receipt generator and a
  checked-in systemd hard dependency, but no live unit is changed here. CI and
  release wiring must still build the final artifact, generate/preserve the
  receipt, inject all admitted values, and gate rollout on readiness.
- A Temporal server connection proves only the server edge. It does not prove a
  worker is polling the required task queues.

Do not relabel liveness, a successful `SELECT`, an existing receipt, or a
Temporal connection as end-to-end pilot readiness.
