import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(config, /certFile: "\/run\/secrets\/temporal-platform\/server\.crt"/);
  assert.match(config, /keyFile: "\/run\/secrets\/temporal-platform\/server\.key"/);
  assert.match(config, /rootCaFiles:[\s\S]*\/run\/secrets\/temporal-platform\/ca\.crt/);
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
  const compose = await repositoryFile(
    "infra/temporal-platform/compose.yml",
  );
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
  assert.match(compose, /TEMPORAL_ALLOW_NO_AUTH:\s*"false"/);
  assert.match(compose, /frontend,internal-frontend,history,matching,worker/);
  assert.match(compose, /\/run\/secrets\/temporal-platform[\s\S]*read_only: true/);
  assert.doesNotMatch(productFiles, /start-dev/);
  assert.doesNotMatch(productFiles, /noopAuthorizer|allow-no-auth|ALLOW_NO_AUTH:\s*"true"/i);
  assert.doesNotMatch(productFiles, /generateKeyPair|openssl\s+(?:gen|req)|BEGIN PRIVATE KEY/);
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
      backendWorker: ["platform-automation:worker"],
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
  assert.match(verify, /platform-automation-denied/);
  assert.doesNotMatch(`${provision}\n${verify}`, /cat .*TOKEN.*(?:echo|printf)/i);
});

test("disposable proof is isolated and product config never owns test keys", async () => {
  const [compose, runner, fixtureGenerator] = await Promise.all([
    repositoryFile(
      "infra/temporal-platform/test-support/compose.disposable.yml",
    ),
    repositoryFile(
      "infra/temporal-platform/test-support/verify-disposable.sh",
    ),
    repositoryFile(
      "infra/temporal-platform/test-support/generate-fixtures.mjs",
    ),
  ]);

  assert.match(compose, /codex-task4c-platform-temporal/);
  assert.match(compose, /internal:\s*true/);
  assert.match(compose, /\.\.\/config\/temporal\.yaml/);
  assert.match(
    compose,
    /caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d/,
  );
  assert.match(runner, /docker compose -p global/);
  assert.match(runner, /generate-fixtures\.mjs/);
  assert.match(runner, /no-token/);
  assert.match(runner, /reader-write-denied/);
  assert.match(runner, /reader-cross-namespace-denied/);
  assert.match(fixtureGenerator, /generateKeyPairSync\("rsa"/);
  assert.match(fixtureGenerator, /platform-automation:read/);
  assert.match(fixtureGenerator, /platform-automation:write/);
  assert.match(fixtureGenerator, /platform-automation:worker/);
  assert.match(fixtureGenerator, /temporal-system:admin/);
  assert.doesNotMatch(compose, /global-(?:postgres|api|worker|redis|temporal)(?:\s|$)/m);
});

test("runbook records the namespace isolation and current lease limitation", async () => {
  const runbook = await repositoryFile(
    "infra/temporal-platform/runbook.md",
  );

  assert.match(runbook, /platform-automation/);
  assert.match(runbook, /accepted residual read scope/i);
  assert.match(runbook, /RuntimeProcessLease/);
  assert.match(runbook, /does not contain.*namespace/i);
  assert.match(runbook, /must not.*match.*task queue alone/i);
  assert.match(runbook, /does not modify.*temporal-dev\.service/i);
  assert.match(runbook, /-p global/);
});
