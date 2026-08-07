# API runtime admission and readiness runbook

This contract keeps the Ubuntu API process loopback-only and makes build,
migration, and dependency provenance observable without consulting a dirty
runtime checkout. It is source-level deployment preparation only: this change
does not edit systemd, Compose, credentials, containers, or a live service.

## Deployment stage and network admission

`DEPLOYMENT_STAGE` is the explicit stage source and accepts only
`development`, `pilot`, or `production`.

- If it is absent, `NODE_ENV=production` derives `production`; every other
  `NODE_ENV` value derives `development`.
- `NODE_ENV=production` plus `DEPLOYMENT_STAGE=development` is rejected as a
  downgrade. An explicit controlled `pilot` is allowed to use a production
  Node runtime.
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

## Build receipt: the runtime identity source

Pilot and production do not trust four mutable environment variables as build
identity. They require `apps/api/dist/runtime-build-receipt.json`, generated
after the final API build and shipped inside that exact artifact tree.

The generator receives the source commit explicitly and never invokes Git:

```bash
pnpm --filter @global/api build
pnpm --filter @global/api build:receipt -- \
  --source-sha <full-40-or-64-hex-source-commit> \
  --build-time <canonical-UTC-timestamp-with-milliseconds> \
  --migration-revision <latest-applied-Prisma-migration-name>
```

`--artifact-root` and `--receipt-path` may override their defaults for a
packaging workspace. `--expected-artifact-digest` may carry an independently
calculated attestation, but it must equal the generator's digest.

The digest contract is `sha256-sorted-relative-path-and-bytes-v1`: every
regular file under the artifact root is framed by its UTF-8 relative path and
byte length, sorted by path, and hashed; the receipt itself is excluded.
Symlinks and non-regular entries are rejected. The generator atomically writes
the receipt with mode `0444`. Runtime admission then:

1. rejects a missing, writable, symlinked, oversized, malformed, or unknown
   receipt;
2. recomputes the artifact digest and compares it with the receipt;
3. validates `BUILD_SHA`, `BUILD_TIME`, `ARTIFACT_DIGEST`, and
   `MIGRATION_REVISION` in the receipt; and
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
| `GET /api/v1/health/build` | Receipt-backed build SHA/time, artifact digest, and migration revision. Development without a receipt reports `UNVERIFIED`. |
| `GET /api/v1/health/ready` | Bounded aggregate; HTTP 200 only when every required typed check is `PASS`, otherwise HTTP 503 with `NOT_READY`.            |

The readiness aggregate currently proves:

- admitted stage, host, port, and CORS configuration;
- receipt-backed build identity;
- database connectivity, absence of an unresolved Prisma migration, and exact
  equality between the latest applied `_prisma_migrations.migration_name` and
  the receipt's `MIGRATION_REVISION`; and
- bounded Temporal `getSystemInfo` connectivity.

The base repository has no trustworthy durable proof provider for worker
heartbeat, Outbox relay ownership/recency, or gateway admission. Their injected
probe seams therefore return `UNVERIFIED / PROOF_SOURCE_UNAVAILABLE`, and each
is a required gate. Probe errors and timeouts map to closed failure codes.

## Expected blocker state

This runtime-identity change alone is intentionally **not pilot-ready**:

- `/health/ready` is expected to return 503 until a separately reviewed ops
  change supplies durable worker-heartbeat, Outbox-relay, and gateway-admission
  proof providers.
- The repository now provides an executable, tested receipt generator, but the
  CI/release and systemd deployment paths are not modified here. They must build
  the final artifact, generate/preserve the receipt, inject the admitted stage,
  host, port, and CORS values, and gate rollout on the readiness endpoint.
- A Temporal server connection proves only the server edge. It does not prove a
  worker is polling the required task queues.

Do not relabel liveness, a successful `SELECT`, an existing receipt, or a
Temporal connection as end-to-end pilot readiness.
