# API / Worker immutable OCI runtime

`global-api.service` and `global-worker.service` start the same immutable backend
OCI image through different commands. A source checkout, a mutable `dist/` folder,
or a watch process is never an accepted managed runtime.

This document is an operator contract. It does not authorize an image push,
deployment, restart, migration, provider call, or production promotion.

## Build and promotion contract

Build once from an exact clean commit. The build emits the API/Worker `dist`, a
pruned renderer runtime, an artifact manifest, CycloneDX SBOM, and
`build-attestation.json`. The attestation binds the source tree, renderer,
manifest, SBOM, schema, and migration revision.

```bash
cd /global/backend
test -z "$(git status --porcelain)"
export BUILD_SHA="$(git rev-parse HEAD)"
export BUILT_AT="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
docker build \
  --build-arg "BUILD_SHA=${BUILD_SHA}" \
  --build-arg "BUILT_AT=${BUILT_AT}" \
  --tag global-backend-build:${BUILD_SHA} \
  .
```

The registry publication workflow must return one exact reference such as
`registry.example/global-backend@sha256:<64-lowercase-hex>`. Development,
pre-production, and production promote that same reference; they do not rebuild
it. `GLOBAL_BACKEND_IMAGE` is the single configuration source for both the
container image and runtime identity admission. Do not configure a second digest
variable.

The image requires only two entrypoints:

```text
<exact-image-reference> api
<exact-image-reference> worker
```

## Managed development configuration

Store the exact reference and runtime secrets outside Git in
`/global/backend/.secrets/backend-runtime.env`:

```text
GLOBAL_BACKEND_IMAGE=registry.example/global-backend@sha256:<digest>
```

The same file supplies the runtime's required endpoints and secret references.
All managed modes use `NODE_ENV=production`; `APP_ENVIRONMENT` may identify
development, pilot, or production but never selects an alternative business,
auth, validation, provider, persistence, fallback, cost, or readiness path.

Before starting a candidate image, deploy its additive migrations with the
explicit migration-owner connection. This is an external database action and
must follow its own approval and backup policy.

Then provision the three exclusive PostgreSQL login principals used by runtime
lease writers. Supply the owner URL, three distinct bounded login names, and
three generated passwords through the environment or secret manager; the script
does not contain credentials and safely rotates existing passwords:

```bash
bash infra/postgres/provision-runtime-lease-principals.sh
bash infra/postgres/verify-runtime-lease-principal-permissions.sh
```

The API-only secret file `.secrets/backend-api-runtime.env` contains
`RUNTIME_API_LEASE_DATABASE_URL` and
`RUNTIME_OUTBOX_RELAY_LEASE_DATABASE_URL`. The Worker-only file
`.secrets/backend-worker-runtime.env` contains
`RUNTIME_WORKER_LEASE_DATABASE_URL`. The common secret file must not duplicate
these URLs. Each login inherits exactly one of `runtime_api`, `runtime_worker`,
or `runtime_outbox_relay`; `app_user` remains read-only for the lease table.

```bash
cd /global/backend
docker compose -p global \
  -f docker-compose.yml \
  -f infra/backend-runtime.compose.yml \
  --profile managed-runtime config --quiet
```

## Drain-and-swap

Use the platform's ingress/control-plane drain to pause new BuildRuns, then:

1. mark the old worker draining and wait for a safe workflow-task boundary;
2. stop the old worker so one task queue cannot contain two active digests;
3. start the new worker and wait for its matching READY lease;
4. start or switch the API only after worker, relay, migration, storage, Redis,
   Model Gateway, renderer identity, and Budget Grant verification are ready;
5. resume BuildRun admission only after exact readback succeeds.

The systemd units delegate to the managed Compose profile:

```bash
sudo ln -sf /global/backend/infra/systemd/global-api.service /etc/systemd/system/global-api.service
sudo ln -sf /global/backend/infra/systemd/global-worker.service /etc/systemd/system/global-worker.service
sudo systemctl daemon-reload
```

Starting, enabling, stopping, or restarting these services is a deployment
action and is deliberately not part of repository verification.

## Exact readback

Read back the running container configuration and both health contracts. Do not
infer identity from the source checkout or the local tag.

```bash
docker inspect global-api global-worker \
  --format '{{.Name}} image={{.Config.Image}} id={{.Image}} user={{.Config.User}}'
curl --fail --silent http://127.0.0.1:3000/health/build
curl --fail --silent http://127.0.0.1:3000/health/ready
```

Acceptance requires:

- both container `.Config.Image` values equal the approved
  `GLOBAL_BACKEND_IMAGE` byte-for-byte;
- both image IDs match and both containers run as UID/GID `10001`;
- `/health/build` reports the expected commit, image, artifact, manifest, SBOM,
  renderer, schema, and migration digests;
- `/health/ready` reports every component ready and the API/Worker/Relay leases
  carry one matching release identity;
- no second active digest exists on the same Temporal task queue.

## Rollback boundary

Rollback selects the saved N-1 exact image reference; it never rebuilds N-1.
If the current database revision is incompatible with N-1, keep BuildRun
admission paused and forward-fix. Do not perform a destructive database rollback.

Source watch remains an editor-feedback process only. It cannot receive user
BuildRuns, real credentials/data, paid calls, or RuntimeEvidence, and it must not
share the managed Temporal task queue.
