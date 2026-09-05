# Dedicated platform-automation Temporal service

This directory defines the infrastructure boundary required by the independent
Temporal Schedule proof in `task-4-design.md`. It does not modify `temporal-dev.service`,
replace it, or derive authority from it. The existing development service
remains an integration probe and is not an independently authenticated managed
runtime.

## Fixed security boundary

- The only product namespace admitted by this slice is `platform-automation`.
  It contains no tenant or customer Workflows.
- GrowthOS receives only `platform-automation:read`.
- the Backend Schedule writer receives only `platform-automation:write`.
- the Backend Worker has a distinct subject/token and receives
  `platform-automation:worker` plus `platform-automation:write`.
- the provisioning operator receives only `temporal-system:admin` and is never
  installed in GrowthOS or a Worker.
- Temporal uses its default JWT claim mapper and default authorizer with one
  configured audience and an HTTPS JWKS URI. There is no no-op authorizer and no
  unsigned development verifier.
- Frontend and internode traffic use TLS with hostname verification. The server
  image trusts the deployment-supplied JWKS CA bundle through `SSL_CERT_FILE`.
- The PostgreSQL volume and network are dedicated to this service. PostgreSQL
  has no host port.
- The internal network has the fixed deployment name `global-temporal-platform`.
  The GrowthOS HTTPS JWKS endpoint must explicitly join that network (or an
  reviewed deployment override named by `TEMPORAL_PLATFORM_NETWORK_NAME`);
  Temporal is not given general internet egress merely to fetch keys.

Temporal's default authorizer grants namespace-wide read-only access rather
than per-Schedule or per-Workflow-type access. The accepted residual read scope
is therefore all non-admin read APIs in `platform-automation`. This is acceptable
only while the namespace contains no customer data and only the four approved
platform automation Workflow types. The future GrowthOS proof client must still
enforce its four Schedule/workflow-type allowlist and bounded input/history rules.

Temporal 1.31.2 also classifies Worker poll/respond RPCs as `AccessWrite`; its
default authorizer does not select `RoleWorker` as a required role. A
`platform-automation:worker` claim alone therefore cannot run a Worker. The
accepted residual write scope is that the separately issued Backend Worker
token also carries `platform-automation:write`. The Worker and Schedule writer
remain different identities, but the default authorizer cannot prevent either
write identity from invoking other namespace write RPCs. True operation-level
Worker/write separation requires a reviewed custom authorizer or enforcement
proxy and is explicitly outside this infrastructure slice. It must not be
claimed as complete merely because the token subjects differ.

## Exact images

`images.lock.json` records the official tag, multi-architecture index digest,
and Linux/amd64 manifest digest read back from the registry. Compose refers only
to the index digests. Updating any image requires a new tag-to-digest readback,
review, disposable authorization proof, and release evidence; a moving tag is
never a deployment input.

## Secret layout

The server secret directory is deployment-owned and mounted read-only at
`/run/secrets/temporal-platform`:

```text
ca.crt                 # CA used by Temporal clients
server.crt             # SAN covers the configured Temporal server name
server.key             # mode 0600, readable only by Temporal UID 1000
jwks-ca-bundle.crt     # trust bundle for the configured HTTPS JWKS origin
```

The separate client directory is mounted only into the operator tool container:

```text
ca.crt
admin.jwt
reader.jwt
writer.jwt
worker.jwt
```

Tokens are externally issued, short-lived, audience-bound and stored mode 0600.
Product configuration never generates signing keys, TLS keys or temporary
tokens. Neither script logs a raw token. GrowthOS receives `reader.jwt` through
its own secret delivery path; it never receives the other three identities.

## Provisioning

Export deployment-specific values without committing them:

```bash
export TEMPORAL_PLATFORM_POSTGRES_PASSWORD='<secret>'
export TEMPORAL_PLATFORM_JWKS_URI='https://growthos-temporal-jwks:8443/.well-known/temporal-jwks.json'
export TEMPORAL_PLATFORM_JWT_AUDIENCE='global-backend:platform-temporal'
export TEMPORAL_PLATFORM_TLS_SERVER_NAME='temporal-platform'
export TEMPORAL_PLATFORM_SERVER_SECRET_DIRECTORY='/run/secure/temporal-platform-server'
export TEMPORAL_PLATFORM_CLIENT_SECRET_DIRECTORY='/run/secure/temporal-platform-client'
```

Validate the fully materialized topology, then run the bounded provisioner:

```bash
docker compose -p global \
  -f infra/temporal-platform/compose.yml \
  --profile platform-temporal config --quiet
infra/temporal-platform/provision.sh
```

The schema service uses the exact-version Temporal SQL tool against the two
dedicated databases. The provisioner waits for PostgreSQL, schema completion and
the TLS frontend, then creates `platform-automation` through the externally
issued admin identity. A TCP health check is diagnostic only; it does not prove
JWKS retrieval or authorization readiness.

## Read-only authorization verification

Use a paused, no-worker proof Schedule whose manual trigger cannot reach an
external service even if a negative authorization assertion unexpectedly fails.
Supply its exact Schedule, Workflow and run identities:

```bash
export TEMPORAL_PLATFORM_READER_TOKEN_FILE='/run/secrets/temporal-platform-client/reader.jwt'
export TEMPORAL_PLATFORM_PROOF_SCHEDULE_ID='<schedule-id>'
export TEMPORAL_PLATFORM_PROOF_WORKFLOW_ID='<workflow-id>'
export TEMPORAL_PLATFORM_PROOF_RUN_ID='<run-id>'
infra/temporal-platform/verify.sh
```

Acceptance requires all of the following in the same run:

1. Schedule describe without a token is denied.
2. The GrowthOS reader can describe the exact Schedule.
3. It can describe the exact Workflow run.
4. It can read the exact Workflow history.
5. It cannot trigger the Schedule.
6. It cannot read a different namespace.

The disposable harness additionally proves writer success, authorized
`PollWorkflowTaskQueue` and `RespondWorkflowTaskFailed` calls, Worker
cross-namespace denial, admin-only namespace creation, distinct
Worker/Schedule-writer/admin identities and wrong-audience denial. These checks establish
infrastructure authorization only; they do not implement the GrowthOS client,
validate the four production Schedule payloads, or prove the later 4D send fence.

## RuntimeProcessLease limitation

The current `RuntimeProcessLease` does not contain a Temporal namespace field.
It records role, task queue and release identity only. A later multi-namespace
Worker integration must not match a Worker by task queue alone: namespace must
be added to the durable identity/admission contract, or the platform Worker must
use a separately unambiguous queue/lease contract. This infrastructure slice
does not alter the lease schema, API, Worker or readiness logic and therefore
cannot claim that integration is complete.

## Disposable proof and cleanup

The test harness uses production `temporal.yaml` with test-only certificates,
JWKS and tokens under a temporary directory. The public JWKS document and the
JWKS server's TLS key use separate mounts, so the file server cannot expose its
private key. It uses `docker compose -p global`
as required, but every service, container, volume and internal network has the
`codex-task4c-platform-temporal` prefix. Cleanup targets only those exact names;
it never invokes `down`, changes the host Docker daemon, or touches a `global-*`
retained container. The non-root Worker probe receives read-only copies of the
three Temporal SDK packages from the repository's exact frozen 1.20.3 install;
the harness does not install or download dependencies.

```bash
infra/temporal-platform/test-support/verify-disposable.sh
```

Passing the disposable proof is not deployment authorization. Retained
provisioning, credential installation, namespace migration, Schedule cutover and
service restart remain separate external actions owned by the parent task.
