# Dedicated platform-automation Temporal service

This directory defines the infrastructure boundary required by the independent
Temporal Schedule proof in `task-4-design.md`. It does not modify `temporal-dev.service`,
replace it, or derive authority from it. The existing development service
remains an integration probe and is not an independently authenticated managed
runtime.

## Namespace admission on every provision

`provision.sh` requires the repository's Node runtime on the operator host.
Both a newly created namespace and an existing namespace must pass bounded
DescribeNamespace JSON validation: registered state, exactly seven-day
retention, the fixed non-tenant description, local (not global) namespace,
and exactly two ownership data markers (`platform_non_tenant=true` and
`platform_contract=1`). Missing markers, deprecated state, changed retention,
or another ownership claim returns `PLATFORM_TEMPORAL_NAMESPACE_DRIFT`.
An existing namespace is never silently adopted or automatically repaired.
The markers are ownership declarations, not proof that historical workflow
payloads contain no tenant data; pre-cutover inventory and the dedicated
credential boundary remain required. Unknown historical state stays on hold.

The infrastructure contract suite is imported by the rooted governance test
entry, so required CI executes it. The disposable harness also changes
namespace settings deliberately and requires re-provisioning to reject drift.

## Fixed security boundary

The retained `compose.yml` is the stock-image baseline. Native adoption appends
`compose.native.yml` and admits the published native artifact as described below;
the baseline by itself does not install the custom reader authorizer. The
2026-09-11 [native disposable closeout](../../docs/evidence/temporal-platform-native-disposable-closeout-20260911.md)
binds the already-tested implementation, not a retained deployment.

- The only product namespace admitted by this slice is `platform-automation`.
  It contains no tenant or customer Workflows.
- GrowthOS receives only `platform-automation:read`.
- the Backend Schedule writer receives only `platform-automation:write`.
- the Backend Worker has a distinct subject/token and receives
  `platform-automation:worker` plus `platform-automation:write`.
- the provisioning operator receives only `temporal-system:admin` and is never
  installed in GrowthOS or a Worker.
- Native Temporal wraps the official signature-verifying JWT mapper and default
  authorizer with the dedicated reader policy, using one configured audience and
  HTTPS JWKS URI. There is no no-op authorizer or unsigned development verifier.
- External Frontend `7233` uses TLS with hostname verification and continues to
  authenticate product clients through JWT; it does not require a client
  certificate.
- Internode traffic, including `internal-frontend:7236`, uses a distinct
  internode identity CA with mutual TLS and hostname verification. Temporal
  presents the same dedicated internode identity certificate for its internal
  server and client roles, as required by the native 1.31.2 local-store TLS
  provider. Only the Temporal server secret mount contains that certificate and
  private key. GrowthOS Reader, JWKS, Schedule writer tools and Worker probes
  cannot establish an internal connection.
- The server image trusts the deployment-supplied JWKS CA bundle through
  `SSL_CERT_FILE`.
- The PostgreSQL volume and network are dedicated to this service. PostgreSQL
  has no host port.
- The internal network has the fixed deployment name `global-temporal-platform`.
  The GrowthOS HTTPS JWKS endpoint must explicitly join that network (or an
  reviewed deployment override named by `TEMPORAL_PLATFORM_NETWORK_NAME`);
  Temporal is not given general internet egress merely to fetch keys.

The native reader permits only `DescribeSchedule`, `DescribeWorkflowExecution`
and `GetWorkflowExecutionHistory`, checking the exact gRPC method, decoded request
type and `platform-automation` namespace. `GetSystemInfo` is not on that allowlist.
Other identities retain the default role policy described below. The GrowthOS
proof client must still enforce its four Schedule/workflow-type allowlist and
bounded input/history rules; server RPC authorization is not a particular run proof.

The current accepted native frontend configuration is TLS plus verified JWT.
If a client certificate is presented, the reader identity and verified chain
remain bound and revalidated; the reader certificate cannot enter internode.
An explicit frontend-mTLS configuration is supported but is a different deployment
configuration with additional client-CA/certificate inputs. Do not describe the
JWT-only disposable result as proof that reader mTLS was required.

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

### Native publication and retained overlay

`.github/workflows/publish-temporal-platform-image.yml` is a manual, protected
exact-main publisher for `ghcr.io/mlhjyx/global-temporal-platform`. It is separate
from the Node runtime publisher and does not deploy or start Temporal. Creating
the workflow does not authorize dispatching it. Its Dockerfile build context is
the **repository root**, with `infra/temporal-platform/server/Dockerfile` selected.
Existing required CI owns the Go business/race matrix; publication compiles the
same code with verified modules and networking disabled at compile time.

The image contains the native binary plus a source/binary/SBOM manifest and the public
Temporal config/role templates under `/opt/temporal-platform-release`. The
source digest binds production Go inputs, Dockerfile, schema/config contracts
and both Compose files; the exact Git commit additionally binds the publisher.
The publisher exports a never-started container, checks the actual native ELF
module marker and SHA256, exact image/source labels, config bytes and the full
merged path inventory for test/fixture contamination. It then publishes once,
pulls the exact registry reference, checks its image ID and verifies the exact
workflow/source attestation. Before pushing, it attests the actual Docker image
config bytes (whose SHA256 is the image ID). If push succeeds but registry
attestation fails or its ACK is lost, a retry can recover only after verifying
those exact config bytes against the same trusted workflow/source attestation.
A pre-existing tag without either trusted proof remains HOLD; labels alone are
never enough, and the SHA tag is not overwritten. ELF/module inspection is a
structural check, not an independent proof of RPC enforcement: source/build
provenance and the separately bound native disposable proof remain required.
The deterministic CycloneDX SBOM inventories the compiled binary's actual Go
build-info, Go toolchain, pinned upstream container and its actual APK-installed
package records. Module checksums and APK recorded checksums retain their own
semantics; they are not mislabeled as binary file SHA256. The manifest binds Go
build-info, APK inventory and SBOM bytes, and both publisher and retained
preflight read back those files from the final image. Unmanaged upstream tools
remain represented by the opaque pinned base component; inventory generation is
**not** a vulnerability scan or a complete Release Bundle.
Publication alone is not a
retained readiness, namespace migration, RuntimeEvidence or Release Bundle.

Before a separately authorized retained adoption, supply these **non-secret**
bindings along with the existing deployment-owned secret references:

```text
TEMPORAL_PLATFORM_NATIVE_IMAGE=ghcr.io/mlhjyx/global-temporal-platform@sha256:<verified-digest>
TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA=<verified-exact-source-commit>
TEMPORAL_PLATFORM_READER_SUBJECT=<fixed-GrowthOS-reader-subject>
```

Render and validate without starting services (the JSON contains rendered
deployment secrets; keep it in an operator-owned 0600 temporary file, never print,
commit or attach it):

```bash
umask 077
native_compose_json=$(mktemp /var/tmp/temporal-native-compose.XXXXXX)
docker compose -p global \
  -f infra/temporal-platform/compose.yml \
  -f infra/temporal-platform/compose.native.yml \
  --profile platform-temporal config --format json > "$native_compose_json"
node scripts/temporal-native-publication.mjs compose "$native_compose_json" \
  "$PWD" "$TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA" \
  "$TEMPORAL_PLATFORM_NATIVE_IMAGE" "$TEMPORAL_PLATFORM_READER_SUBJECT"
```

The admission rejects stock/moving images, missing/mismatched reader identity,
alternate entrypoints, binary-overriding mounts, writable contract mounts, public
ports and reuse of legacy port 7233. It does not install secrets or establish
their validity. Check the native image manifest against this exact source before
using its public templates as bind mounts; a different source tree is not an
equivalent deployment input. The printed admission summary contains no secrets.

Preserve `temporal-dev.service`, its SQLite data, legacy namespaces and existing
Workflow executions. The dedicated PostgreSQL/schema/namespace resources remain
separate. Do not switch the global Backend `TEMPORAL_ADDRESS`/`TEMPORAL_NAMESPACE`
or mixed Worker to this service: dedicated client credentials and namespace-aware
Worker/lease admission are later contracts. `provision.sh` and `verify.sh` below
remain **mutating operator tools** (the latter includes a write-denial probe), not
safe commands for an unapproved retained readback. They are not invoked by the
publisher. The standard retained `provision.sh` requires the native image, source
and reader identities, renders the same two-file Compose input in a private 0700
directory/0600 files, performs local-only image capture/admission (no pull, no
container start), then invokes shared `provision-core.sh`. Temporary rendered
secrets and image exports are cleaned on success and failure; raw Compose errors
are never printed. Arbitrary topology overrides are rejected at this retained
entry. The disposable harness has its own test-support wrapper calling the
**same** core with exact disposable Compose/services; no product environment
switch restores the stock fallback.

## Secret layout

The server secret directory is deployment-owned and mounted read-only at
`/run/secrets/temporal-platform`:

```text
frontend-ca.crt        # CA that signs the external Frontend certificate
frontend.crt           # external Frontend SAN covers the configured server name
frontend.key           # mode 0600, external Frontend private key
internode-ca.crt       # dedicated CA trusted only for internode identities
internode.crt          # serverAuth+clientAuth identity for Temporal internode RPC
internode.key          # mode 0600, readable only by Temporal UID 1000
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
its own secret delivery path; it never receives the other three identities or
the internode certificate/key. This source change does not migrate an existing
secret directory because no retained service has been deployed from this
infrastructure contract.

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
  -f infra/temporal-platform/compose.native.yml \
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

The reader checks call the three allowlisted WorkflowService methods directly
through the SDK connection. Temporal CLI commands are used only for the
negative write and cross-namespace probes because the CLI performs an extra
`GetSystemInfo` preflight that is outside the reader allowlist.

The disposable harness additionally proves writer success, authorized
`PollWorkflowTaskQueue` and `RespondWorkflowTaskFailed` calls, Worker
cross-namespace denial, admin-only namespace creation, distinct
Worker/Schedule-writer/admin identities and wrong-audience denial. These checks establish
infrastructure authorization only; they do not implement the GrowthOS client,
validate the four production Schedule payloads, or prove the later 4D send fence.
It also connects to `internal-frontend:7236` from the ordinary non-root probe
container with the correct public internode CA but no client certificate; the
connection must fail with a certificate-required TLS alert. Possession of that
public CA is not an internal client credential, and no internode private key or
leaf certificate enters the client fixture directory.

## RuntimeProcessLease limitation

The current `RuntimeProcessLease` does not contain a Temporal namespace field.
It records role, task queue and release identity only. A later multi-namespace
Worker integration must not match a Worker by task queue alone: namespace must
be added to the durable identity/admission contract, or the platform Worker must
use a separately unambiguous queue/lease contract. This infrastructure slice
does not alter the lease schema, API, Worker or readiness logic and therefore
cannot claim that integration is complete.

## Disposable proof and cleanup

The test harness holds a non-blocking host `flock` from before its first Docker
inventory through the final cleanup. The default lock lives in the repository's
common Git directory so invocations from different worktrees still serialize.
A concurrent invocation exits with status `73` and the stable `lifecycle is
busy` diagnostic before calling Docker. Stale task resources cause status `74`
and require manual review; a new run never recreates them implicitly.

The test harness uses production `temporal.yaml` with test-only certificates,
JWKS and tokens under a temporary directory. The public JWKS document and the
JWKS server's TLS key use separate mounts, so the file server cannot expose its
private key. It uses `docker compose -p global`
as required, but every service, container, volume and internal network has the
`codex-task4c-platform-temporal` prefix. Cleanup targets only those exact names;
it never invokes `down`, changes the host Docker daemon, or touches a `global-*`
retained container. The non-root Worker probe receives read-only copies of the
three Temporal SDK packages from the repository's exact frozen 1.20.3 install;
the harness does not install or download dependencies. Every disposable
container, volume and network carries an exact run-id and scope label. Cleanup
enumerates only that run-id, verifies project/service labels before removal and
refuses any mismatched resource.

```bash
infra/temporal-platform/test-support/verify-disposable.sh
```

Passing the disposable proof is not deployment authorization. Retained
provisioning, credential installation, namespace migration, Schedule cutover and
service restart remain separate external actions owned by the parent task.
