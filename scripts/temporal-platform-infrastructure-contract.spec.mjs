import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("platform Temporal images are official exact-digest releases", async () => {
  const lock = JSON.parse(
    await repositoryFile("infra/temporal-platform/images.lock.json"),
  );

  assert.deepEqual(lock, {
    schemaVersion: "platform-temporal-images/v1",
    images: {
      server: {
        source: "docker.io/temporalio/server",
        tag: "1.31.2",
        indexDigest:
          "sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da",
        linuxAmd64Digest:
          "sha256:6b02e5176631c8d28f010735a3a73c69423a9adbcfad7e5dfe23836c904b7e26",
      },
      adminTools: {
        source: "docker.io/temporalio/admin-tools",
        tag: "1.31.2",
        indexDigest:
          "sha256:dbc5fcd6ee8f0f4d808bf765af9a87dea9d8a283abfdcfbd2fc148496ba66107",
        linuxAmd64Digest:
          "sha256:7e5820112475b3490f011b28d86ca9fd8348f1640b8dd04c62adb906e6b28cb2",
      },
      postgres: {
        source: "docker.io/library/postgres",
        tag: "16-alpine",
        indexDigest:
          "sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685",
        linuxAmd64Digest:
          "sha256:075f7ba66bc9b3ce7d6b8b635208ff61cd7cf1a67d71ec530eec5d7ae0cbe571",
      },
      testJwks: {
        source: "docker.io/library/caddy",
        tag: "2.10.2-alpine",
        indexDigest:
          "sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",
        linuxAmd64Digest:
          "sha256:d8c17a862962def15cde69863a3a463f25a2664942eafd7bdbf050e9c3116b83",
      },
      testNodeClient: {
        source: "docker.io/library/node",
        tag: "22.23.1-trixie-slim",
        indexDigest:
          "sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba",
        linuxAmd64Digest:
          "sha256:4653dc205e772d0200f195ff333fe45157c5aa19385eab098f2af0517f982498",
      },
    },
  });
});

test("production config requires TLS and the default JWT authorization stack", async () => {
  const config = await repositoryFile(
    "infra/temporal-platform/config/temporal.yaml",
  );

  assert.match(config, /^# enable-template$/m);
  assert.match(config, /defaultStore: postgres-default/);
  assert.match(config, /visibilityStore: postgres-visibility/);
  assert.match(config, /pluginName: "postgres12_pgx"/);
  assert.match(config, /databaseName: "temporal_platform"/);
  assert.match(config, /databaseName: "temporal_platform_visibility"/);
  assert.match(config, /tls:[\s\S]*internode:[\s\S]*frontend:/);
  assert.match(config, /internode:[\s\S]*?requireClientAuth: true/);
  assert.match(
    config,
    /internode:[\s\S]*?clientCaFiles:[\s\S]*?\/run\/secrets\/temporal-platform\/internode-ca\.crt/,
  );
  assert.match(
    config,
    /internode:[\s\S]*?certFile: "\/run\/secrets\/temporal-platform\/internode\.crt"/,
  );
  assert.match(
    config,
    /frontend:[\s\S]*?requireClientAuth: false[\s\S]*?certFile: "\/run\/secrets\/temporal-platform\/frontend\.crt"/,
  );
  assert.match(
    config,
    /internode:[\s\S]*?rootCaFiles:[\s\S]*?\/run\/secrets\/temporal-platform\/internode-ca\.crt/,
  );
  assert.doesNotMatch(config, /temporal-platform\/server\.(?:crt|key)/);
  assert.match(config, /authorization:[\s\S]*authorizer: "default"/);
  assert.match(config, /authorization:[\s\S]*claimMapper: "default"/);
  assert.match(config, /permissionsClaimName: "permissions"/);
  assert.match(config, /TEMPORAL_PLATFORM_JWKS_URI/);
  assert.match(config, /TEMPORAL_PLATFORM_JWT_AUDIENCE/);
  assert.match(config, /regexMatch `\^https:\/\//);
  assert.doesNotMatch(config, /disableHostVerification:\s*true/);
  assert.doesNotMatch(config, /authorizer:\s*"?"?\s*$/m);
  assert.doesNotMatch(config, /claimMapper:\s*"?"?\s*$/m);
});

test("managed compose uses independent persistence and no development server path", async () => {
  const compose = await repositoryFile("infra/temporal-platform/compose.yml");
  const productFiles = [
    compose,
    await repositoryFile("infra/temporal-platform/provision.sh"),
    await repositoryFile("infra/temporal-platform/verify.sh"),
  ].join("\n");

  assert.match(
    compose,
    /temporalio\/server@sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da/,
  );
  assert.match(
    compose,
    /temporalio\/admin-tools@sha256:dbc5fcd6ee8f0f4d808bf765af9a87dea9d8a283abfdcfbd2fc148496ba66107/,
  );
  assert.match(
    compose,
    /postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685/,
  );
  assert.match(compose, /temporal-platform-postgres-data:/);
  assert.match(compose, /internal:\s*true/);
  assert.match(
    compose,
    /name: \$\{TEMPORAL_PLATFORM_NETWORK_NAME:-global-temporal-platform\}/,
  );
  assert.match(compose, /TEMPORAL_ALLOW_NO_AUTH:\s*"false"/);
  assert.match(compose, /frontend,internal-frontend,history,matching,worker/);
  assert.match(
    compose,
    /\/run\/secrets\/temporal-platform[\s\S]*read_only: true/,
  );
  assert.doesNotMatch(productFiles, /start-dev/);
  assert.doesNotMatch(
    productFiles,
    /noopAuthorizer|allow-no-auth|ALLOW_NO_AUTH:\s*"true"/i,
  );
  assert.doesNotMatch(
    productFiles,
    /generateKeyPair|openssl\s+(?:gen|req)|BEGIN PRIVATE KEY/,
  );
  assert.doesNotMatch(productFiles, /temporal-dev\.service/);
});

test("provisioning roles and verification remain separated and fail closed", async () => {
  const [rolesText, provision, verify] = await Promise.all([
    repositoryFile("infra/temporal-platform/roles.json"),
    repositoryFile("infra/temporal-platform/provision.sh"),
    repositoryFile("infra/temporal-platform/verify.sh"),
  ]);
  const roles = JSON.parse(rolesText);

  assert.deepEqual(roles, {
    schemaVersion: "platform-temporal-role-contract/v1",
    namespace: "platform-automation",
    audienceEnvironment: "TEMPORAL_PLATFORM_JWT_AUDIENCE",
    roles: {
      growthosReader: ["platform-automation:read"],
      backendScheduleWriter: ["platform-automation:write"],
      backendWorker: [
        "platform-automation:worker",
        "platform-automation:write",
      ],
      provisionAdmin: ["temporal-system:admin"],
    },
  });
  assert.match(provision, /TEMPORAL_PLATFORM_ADMIN_TOKEN_FILE/);
  assert.match(provision, /operator namespace create/);
  assert.match(provision, /--namespace "platform-automation"/);
  assert.match(verify, /TEMPORAL_PLATFORM_READER_TOKEN_FILE/);
  assert.match(verify, /schedule describe/);
  assert.match(verify, /workflow describe/);
  assert.match(verify, /workflow show/);
  assert.match(verify, /PERMISSION_DENIED/);
  assert.match(verify, /no-token/);
  assert.match(verify, /reader-write-denied/);
  assert.match(verify, /reader-cross-namespace-denied/);
  assert.match(verify, /platform-automation-denied/);
  assert.doesNotMatch(
    `${provision}\n${verify}`,
    /cat .*TOKEN.*(?:echo|printf)/i,
  );
});

test("disposable proof is isolated and product config never owns test keys", async () => {
  const [compose, runner, fixtureGenerator, workerProbe, internalProbe, caddy] =
    await Promise.all([
      repositoryFile(
        "infra/temporal-platform/test-support/compose.disposable.yml",
      ),
      repositoryFile(
        "infra/temporal-platform/test-support/verify-disposable.sh",
      ),
      repositoryFile(
        "infra/temporal-platform/test-support/generate-fixtures.mjs",
      ),
      repositoryFile(
        "infra/temporal-platform/test-support/worker-poll-probe.mjs",
      ),
      repositoryFile(
        "infra/temporal-platform/test-support/internal-mtls-probe.mjs",
      ),
      repositoryFile("infra/temporal-platform/test-support/Caddyfile"),
    ]);

  assert.match(compose, /codex-task4c-platform-temporal/);
  assert.match(compose, /internal:\s*true/);
  assert.match(compose, /\.\.\/config\/temporal\.yaml/);
  assert.match(
    compose,
    /caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d/,
  );
  assert.match(
    compose,
    /node@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba/,
  );
  assert.match(runner, /docker compose -p global/);
  assert.doesNotMatch(runner, /--remove-orphans/);
  assert.match(runner, /generate-fixtures\.mjs/);
  assert.match(runner, /verify\.sh/);
  assert.match(runner, /worker-poll-probe\.mjs/);
  assert.match(runner, /internal-mtls-probe\.mjs/);
  assert.match(runner, /INTERNAL_MTLS_REJECTED/);
  assert.match(runner, /worker-cross-namespace-denied/);
  assert.match(runner, /AUTHORITY_DIRECTORY=.*\/authority/);
  assert.match(runner, /SERVER_SECRET_DIRECTORY=.*\/server/);
  assert.match(runner, /JWKS_DIRECTORY=.*\/jwks/);
  assert.match(runner, /JWKS_TLS_DIRECTORY=.*\/jwks-tls/);
  assert.match(runner, /CLIENT_SECRET_DIRECTORY=.*\/client/);
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_SERVER_SECRET_DIRECTORY/);
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_JWKS_DIRECTORY/);
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_JWKS_TLS_DIRECTORY/);
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_CLIENT_SECRET_DIRECTORY/);
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_NODE_OVERLAY_DIRECTORY/);
  assert.match(compose, /@temporalio\+client@1\.20\.3/);
  assert.match(compose, /@temporalio\+common@1\.20\.3/);
  assert.match(compose, /@temporalio\+proto@1\.20\.3/);
  assert.doesNotMatch(compose, /TEMPORAL_PLATFORM_TEST_FIXTURES/);
  assert.doesNotMatch(runner, /(?:pnpm|npm|yarn|bun)\s+(?:add|install)/);
  assert.match(fixtureGenerator, /generateKeyPairSync\("rsa"/);
  assert.match(fixtureGenerator, /platform-automation:read/);
  assert.match(fixtureGenerator, /platform-automation:write/);
  assert.match(fixtureGenerator, /platform-automation:worker/);
  assert.match(fixtureGenerator, /platform-automation:write/);
  assert.match(fixtureGenerator, /temporal-system:admin/);
  assert.match(fixtureGenerator, /task4c-growthos-reader/);
  assert.match(fixtureGenerator, /task4c-backend-schedule-writer/);
  assert.match(fixtureGenerator, /task4c-backend-worker/);
  assert.match(fixtureGenerator, /task4c-provision-admin/);
  assert.doesNotMatch(fixtureGenerator, /privateKey\.export/);
  assert.match(workerProbe, /pollWorkflowTaskQueue/);
  assert.match(workerProbe, /respondWorkflowTaskFailed/);
  assert.match(internalProbe, /certificate required|bad certificate/i);
  assert.match(compose, /io\.growthos\.task4c\.run-id/);
  assert.match(runner, /flock -n/);
  assert.match(runner, /io\.growthos\.task4c\.run-id/);
  assert.doesNotMatch(runner, /\$\{compose\[@\]\}.*rm -sf/);
  assert.match(caddy, /root \* \/srv\/jwks/);
  assert.match(
    caddy,
    /tls \/run\/secrets\/task4c-jwks\/server\.crt \/run\/secrets\/task4c-jwks\/server\.key/,
  );
  assert.doesNotMatch(caddy, /root \* \/fixtures/);
  assert.doesNotMatch(
    compose,
    /global-(?:postgres|api|worker|redis|temporal)(?:\s|$)/m,
  );
});

test("a concurrent disposable lifecycle exits before invoking Docker", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "codex-task4c-platform-temporal-lock-test."),
  );
  const lockPath = join(directory, "lifecycle.lock");
  const dockerSentinel = join(directory, "docker-called");
  const fakeBin = join(directory, "bin");
  await mkdir(fakeBin, { mode: 0o700 });
  const fakeDocker = join(fakeBin, "docker");
  await writeFile(
    fakeDocker,
    '#!/bin/sh\n: > "${TASK4C_DOCKER_SENTINEL:?}"\nexit 97\n',
    { mode: 0o700 },
  );
  await chmod(fakeDocker, 0o700);

  const holder = spawn(
    "flock",
    ["-n", lockPath, "sh", "-c", 'printf "ready\\n"; read -r line'],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(async () => {
    holder.stdin.end("release\n");
    if (holder.exitCode === null) {
      await once(holder, "close");
    }
    await rm(directory, { recursive: true, force: true });
  });
  const [ready] = await once(holder.stdout, "data");
  assert.equal(String(ready), "ready\n");

  const runner = spawn(
    "bash",
    [
      join(
        repositoryRoot,
        "infra/temporal-platform/test-support/verify-disposable.sh",
      ),
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        TASK4C_DOCKER_SENTINEL: dockerSentinel,
        TEMPORAL_PLATFORM_TEST_LOCK_FILE: lockPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  runner.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [exitCode] = await once(runner, "close");

  assert.equal(exitCode, 73);
  assert.equal(stderr, "platform Temporal disposable lifecycle is busy\n");
  await assert.rejects(access(dockerSentinel));
});

test("high-risk platform Temporal paths remain code-owner controlled", async () => {
  const codeowners = await repositoryFile(".github/CODEOWNERS");

  assert.match(codeowners, /^\/infra\/temporal-platform\/ @mlhjyx$/m);
  assert.match(
    codeowners,
    /^\/scripts\/temporal-platform-infrastructure-contract\.spec\.mjs @mlhjyx$/m,
  );
});

test("runbook records the namespace isolation and current lease limitation", async () => {
  const runbook = await repositoryFile("infra/temporal-platform/runbook.md");

  assert.match(runbook, /platform-automation/);
  assert.match(runbook, /accepted residual read scope/i);
  assert.match(runbook, /RuntimeProcessLease/);
  assert.match(runbook, /does not contain.*namespace/i);
  assert.match(runbook, /must not.*match.*task queue alone/i);
  assert.match(runbook, /does not modify.*temporal-dev\.service/i);
  assert.match(runbook, /-p global/);
});
