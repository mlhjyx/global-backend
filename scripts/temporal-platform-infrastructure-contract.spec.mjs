import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

function namespaceFixture() {
  return {
    namespaceInfo: {
      name: "platform-automation",
      state: "Registered",
      description: "Dedicated non-tenant platform automation workflows",
      data: { platform_non_tenant: "true", platform_contract: "1" },
    },
    config: { workflowExecutionRetentionTtl: "604800s" },
    isGlobalNamespace: false,
  };
}

function customerNamespaceFixture() {
  return {
    namespaceInfo: { name: "default", state: "Registered" },
    config: { workflowExecutionRetentionTtl: "604800s" },
    isGlobalNamespace: false,
  };
}

// Text-level service slice of a two-space-indented Compose file; the contract
// suite intentionally has no YAML dependency.
function composeService(compose, name) {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert(start >= 0, `service ${name} is missing`);
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

test("required governance executes the platform infrastructure contract suite", async () => {
  const rootedSuite = await repositoryFile(
    "scripts/governance-contracts.spec.mjs",
  );
  assert.match(
    rootedSuite,
    /import "\.\/temporal-platform-infrastructure-contract\.spec\.mjs";/,
  );
});

test("namespace admission validates active isolated ownership and exact retention", async () => {
  const { validatePlatformNamespace } =
    await import("../infra/temporal-platform/namespace-contract.mjs");
  const current = namespaceFixture();
  assert.equal(validatePlatformNamespace(JSON.stringify(current)), true);
  for (const mutate of [
    (v) => {
      v.namespaceInfo.state = "Deprecated";
    },
    (v) => {
      v.namespaceInfo.name = "default";
    },
    (v) => {
      v.namespaceInfo.description = "tenant workflows";
    },
    (v) => {
      v.namespaceInfo.data = {};
    },
    (v) => {
      v.namespaceInfo.data.platform_non_tenant = "false";
    },
    (v) => {
      v.namespaceInfo.data.tenant_id = "tenant";
    },
    (v) => {
      v.config.workflowExecutionRetentionTtl = "86400s";
    },
    (v) => {
      v.isGlobalNamespace = true;
    },
  ]) {
    const changed = structuredClone(current);
    mutate(changed);
    assert.throws(
      () => validatePlatformNamespace(JSON.stringify(changed)),
      /PLATFORM_TEMPORAL_NAMESPACE_DRIFT/,
    );
  }
  assert.throws(
    () => validatePlatformNamespace("null"),
    /PLATFORM_TEMPORAL_NAMESPACE_DRIFT/,
  );
  assert.throws(
    () => validatePlatformNamespace("{"),
    /PLATFORM_TEMPORAL_NAMESPACE_DRIFT/,
  );
  assert.throws(
    () => validatePlatformNamespace(" ".repeat(65537)),
    /PLATFORM_TEMPORAL_NAMESPACE_DRIFT/,
  );
});

test("namespace CLI bounds input and emits only safe contract diagnostics", () => {
  const validator = join(
    repositoryRoot,
    "infra/temporal-platform/namespace-contract.mjs",
  );
  for (const [input, success] of [
    [JSON.stringify(namespaceFixture()), true],
    ["", false],
    ["untrusted-private-diagnostic", false],
    [Buffer.from([0xff]), false],
    ["x".repeat(65537), false],
  ]) {
    const result = spawnSync(process.execPath, [validator], {
      input,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
    });
    assert.equal(result.status, success ? 0 : 1);
    assert.equal(
      result.stderr,
      success ? "" : "PLATFORM_TEMPORAL_NAMESPACE_DRIFT\n",
    );
    assert.equal(
      result.stdout,
      success ? "platform-automation namespace contract verified\n" : "",
    );
  }
});

test("customer namespace admission is unmarked, local, registered and exactly seven-day", async () => {
  const { validateCustomerNamespace, validatePlatformNamespace } =
    await import("../infra/temporal-platform/namespace-contract.mjs");
  const current = customerNamespaceFixture();
  assert.equal(validateCustomerNamespace(JSON.stringify(current)), true);
  for (const accepted of [
    (v) => {
      v.namespaceInfo.state = "NAMESPACE_STATE_REGISTERED";
    },
    (v) => {
      v.namespaceInfo.description = "";
      v.namespaceInfo.data = {};
    },
  ]) {
    const changed = structuredClone(current);
    accepted(changed);
    assert.equal(validateCustomerNamespace(JSON.stringify(changed)), true);
  }
  for (const mutate of [
    (v) => {
      v.namespaceInfo.name = "platform-automation";
    },
    (v) => {
      v.namespaceInfo.state = "Deprecated";
    },
    // Tenant workflows live here: a platform ownership claim is drift.
    (v) => {
      v.namespaceInfo.data = { platform_non_tenant: "true" };
    },
    (v) => {
      v.namespaceInfo.data = { platform_contract: "1" };
    },
    (v) => {
      v.namespaceInfo.data = { tenant_id: "tenant" };
    },
    (v) => {
      v.namespaceInfo.description =
        "Dedicated non-tenant platform automation workflows";
    },
    (v) => {
      v.config.workflowExecutionRetentionTtl = "86400s";
    },
    (v) => {
      delete v.config;
    },
    (v) => {
      v.isGlobalNamespace = true;
    },
  ]) {
    const changed = structuredClone(current);
    mutate(changed);
    assert.throws(
      () => validateCustomerNamespace(JSON.stringify(changed)),
      /TEMPORAL_CUSTOMER_NAMESPACE_DRIFT/,
    );
  }
  for (const source of ["null", "{", "[]", " ".repeat(65537)])
    assert.throws(
      () => validateCustomerNamespace(source),
      /TEMPORAL_CUSTOMER_NAMESPACE_DRIFT/,
    );
  // Neither contract accepts the other namespace's shape.
  assert.throws(
    () => validatePlatformNamespace(JSON.stringify(current)),
    /PLATFORM_TEMPORAL_NAMESPACE_DRIFT/,
  );
  assert.throws(
    () => validateCustomerNamespace(JSON.stringify(namespaceFixture())),
    /TEMPORAL_CUSTOMER_NAMESPACE_DRIFT/,
  );
});

test("namespace CLI selects exactly one contract and never reflects input", () => {
  const validator = join(
    repositoryRoot,
    "infra/temporal-platform/namespace-contract.mjs",
  );
  const platform = JSON.stringify(namespaceFixture());
  const customer = JSON.stringify(customerNamespaceFixture());
  for (const [args, input, status, stdout, stderr] of [
    [
      ["platform-automation"],
      platform,
      0,
      "platform-automation namespace contract verified\n",
      "",
    ],
    [["default"], customer, 0, "default namespace contract verified\n", ""],
    [["default"], platform, 1, "", "TEMPORAL_CUSTOMER_NAMESPACE_DRIFT\n"],
    [
      ["platform-automation"],
      customer,
      1,
      "",
      "PLATFORM_TEMPORAL_NAMESPACE_DRIFT\n",
    ],
    [
      ["default"],
      "x".repeat(65537),
      1,
      "",
      "TEMPORAL_CUSTOMER_NAMESPACE_DRIFT\n",
    ],
    [["tenant-a"], customer, 1, "", "TEMPORAL_NAMESPACE_CONTRACT_UNKNOWN\n"],
    [
      ["default", "platform-automation"],
      customer,
      1,
      "",
      "TEMPORAL_NAMESPACE_CONTRACT_UNKNOWN\n",
    ],
  ]) {
    const result = spawnSync(process.execPath, [validator, ...args], {
      input,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
    });
    assert.equal(result.status, status, args.join(" "));
    assert.equal(result.stdout, stdout);
    assert.equal(result.stderr, stderr);
  }
});

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
      ingress: {
        source: "docker.io/library/haproxy",
        tag: "3.4.4-alpine",
        indexDigest:
          "sha256:52c5921e1619f39cbd5b25e1b4b5847667917f39745056cf004d9c263fbf11b9",
        linuxAmd64Digest:
          "sha256:560d1d5cc8edfff2536ac4c8d4ae6807371c07213b3cc7372bcba3cf61b506a4",
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
  const { INGRESS_IMAGE } = await import("./temporal-native-publication.mjs");
  assert.equal(
    INGRESS_IMAGE,
    `${lock.images.ingress.source}@${lock.images.ingress.indexDigest}`,
  );
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
    await repositoryFile("infra/temporal-platform/provision-core.sh"),
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

test("the Backend reaches native Temporal only through a loopback relay, never a Temporal host port", async () => {
  const [compose, relay] = await Promise.all([
    repositoryFile("infra/temporal-platform/compose.yml"),
    repositoryFile("infra/temporal-platform/ingress/haproxy.cfg"),
  ]);
  const server = composeService(compose, "temporal-platform");
  const ingress = composeService(compose, "temporal-platform-ingress");

  // Native Linux dockerd never maps a host port for a container whose only
  // network is internal; Temporal keeps that single network and no ports.
  assert.doesNotMatch(server, /^\s+ports:/m);
  assert.match(server, /^    networks: \[temporal-platform\]$/m);
  assert.equal(compose.match(/^\s+ports:/gm).length, 1);
  assert.match(
    ingress,
    /ports:\n      - "127\.0\.0\.1:\$\{TEMPORAL_PLATFORM_HOST_PORT:-17233\}:7233"/,
  );
  assert.match(
    ingress,
    /image: docker\.io\/library\/haproxy@sha256:52c5921e1619f39cbd5b25e1b4b5847667917f39745056cf004d9c263fbf11b9/,
  );
  assert.match(ingress, /profiles: \[platform-temporal\]/);
  assert.match(ingress, /user: "99:99"/);
  assert.match(
    ingress,
    /entrypoint: \["haproxy", "-db", "-f", "\/usr\/local\/etc\/haproxy\/haproxy\.cfg"\]/,
  );
  assert.match(ingress, /source: \.\/ingress\/haproxy\.cfg/);
  assert.match(
    ingress,
    /networks: \[temporal-platform, temporal-platform-ingress\]/,
  );
  assert.match(
    ingress,
    /temporal-platform:\n        condition: service_healthy/,
  );
  assert.match(ingress, /read_only: true/);
  assert.match(ingress, /cap_drop: \[ALL\]/);
  assert.match(ingress, /no-new-privileges:true/);
  assert.match(ingress, /pids_limit: \d+/);
  // HAProxy installs no SIGTERM/SIGUSR1 handler, and PID 1 ignores signals that
  // have none, so without an init process every stop waits the grace period and
  // ends in SIGKILL. stop_signal alone cannot fix that.
  // Stopping the relay needs both: an init process, because HAProxy installs
  // no SIGTERM/SIGUSR1 handler and PID 1 ignores signals that have none, and
  // SIGTERM, because the image's default SIGUSR1 is a soft stop that waits for
  // the Backend's long-lived gRPC connections. Either alone ends in SIGKILL.
  assert.match(ingress, /init: true/);
  assert.match(ingress, /stop_signal: SIGTERM/);
  assert.match(ingress, /mem_limit: \d+m/);
  assert.doesNotMatch(
    ingress,
    /environment:|secrets|cap_add|privileged|network_mode/,
  );
  // The relay's bridge must allow published ports but never NAT traffic out.
  assert.match(
    compose,
    /  temporal-platform-ingress:\n    name: global-temporal-platform-ingress\n    driver: bridge\n    enable_ipv6: false\n    driver_opts:\n      com\.docker\.network\.bridge\.enable_ip_masquerade: "false"\n      com\.docker\.network\.bridge\.enable_icc: "false"/,
  );

  // Plain TCP relay: TLS and JWT authorization terminate at Temporal itself.
  assert.match(relay, /^\s+mode tcp$/m);
  assert.doesNotMatch(
    relay,
    /mode http|ssl|crt |ca-file|stats|http-request|tcp-request/,
  );
  assert.match(relay, /^\s+bind :7233$/m);
  assert.match(relay, /^\s+maxconn \d+$/m);
  assert.match(relay, /^\s+nbthread \d+$/m);
  assert.match(
    relay,
    /^\s+server temporal-platform temporal-platform:7233 resolvers docker-embedded init-addr libc,none$/m,
  );
  assert.match(relay, /^\s+parse-resolv-conf$/m);
  assert.match(relay, /^\s+timeout connect 5s$/m);
  // Worker long polls and HTTP/2 keepalive must not be cut by idle timers.
  for (const timer of ["client", "server", "tunnel"])
    assert.match(relay, new RegExp(`^\\s+timeout ${timer} 1h$`, "m"));
  assert.equal((relay.match(/^\s+server /gm) ?? []).length, 1);
});

test("disposable server can run the exact native wrapper without changing the baseline image", async () => {
  const [compose, entrypoint, serverDockerfile, runner] = await Promise.all([
    repositoryFile(
      "infra/temporal-platform/test-support/compose.disposable.yml",
    ),
    repositoryFile("infra/temporal-platform/test-support/native-entrypoint.sh"),
    repositoryFile("infra/temporal-platform/server/Dockerfile"),
    repositoryFile("infra/temporal-platform/test-support/verify-disposable.sh"),
  ]);
  assert.match(compose, /task4c-native-entrypoint/);
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_NATIVE_SERVER_DIRECTORY/);
  assert.match(
    compose,
    /source: \$\{TEMPORAL_PLATFORM_TEST_CONFIG_PATH:-\.\.\/config\/temporal\.yaml\}/,
  );
  assert.match(
    runner,
    /native Temporal server binary must be an absolute path/,
  );
  assert.match(entrypoint, /\/run\/native-server\/temporal-server start/);
  assert.match(entrypoint, /\/etc\/temporal\/entrypoint\.sh/);
  assert.match(
    serverDockerfile,
    /temporalio\/server@sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da/,
  );
  assert.match(serverDockerfile, /go1\.26\.4/);
});

test("provisioning roles and verification remain separated and fail closed", async () => {
  const [rolesText, provision, verify] = await Promise.all([
    repositoryFile("infra/temporal-platform/roles.json"),
    repositoryFile("infra/temporal-platform/provision-core.sh"),
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
      backendCustomerWorker: ["default:worker"],
      backendCustomerClient: ["default:read", "default:write"],
      provisionAdmin: ["temporal-system:admin"],
    },
  });
  assert.match(provision, /TEMPORAL_PLATFORM_ADMIN_TOKEN_FILE/);
  assert.match(provision, /operator namespace create/);
  assert.match(
    provision,
    /"\$\{ADMIN_TOKEN_FILE\}" platform-automation \\\n\s+--retention 7d --data platform_non_tenant=true --data platform_contract=1 \\\n\s+--description "Dedicated non-tenant platform automation workflows"/,
  );
  assert.match(provision, /namespace-contract\.mjs" platform-automation/);
  // The customer namespace used by customer-worker/API is created without any
  // platform ownership marker and validated by its own contract.
  assert.match(provision, /"\$\{ADMIN_TOKEN_FILE\}" default --retention 7d \|/);
  assert.match(provision, /namespace-contract\.mjs" default/);
  assert.match(provision, /platform-automation\|default\)/);
  assert.match(verify, /TEMPORAL_PLATFORM_READER_TOKEN_FILE/);
  assert.match(verify, /reader-rpc-probe\.mjs/);
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
  const [
    compose,
    runner,
    fixtureGenerator,
    workerProbe,
    internalProbe,
    readerProbe,
    caddy,
  ] = await Promise.all([
    repositoryFile(
      "infra/temporal-platform/test-support/compose.disposable.yml",
    ),
    repositoryFile("infra/temporal-platform/test-support/verify-disposable.sh"),
    repositoryFile(
      "infra/temporal-platform/test-support/generate-fixtures.mjs",
    ),
    repositoryFile(
      "infra/temporal-platform/test-support/worker-poll-probe.mjs",
    ),
    repositoryFile(
      "infra/temporal-platform/test-support/internal-mtls-probe.mjs",
    ),
    repositoryFile("infra/temporal-platform/test-support/reader-rpc-probe.mjs"),
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
  assert.match(readerProbe, /Connection\.lazy/);
  assert.match(readerProbe, /describeSchedule/);
  assert.match(readerProbe, /describeWorkflowExecution/);
  assert.match(readerProbe, /getWorkflowExecutionHistory/);
  assert.match(runner, /internal-mtls-probe\.mjs/);
  assert.match(internalProbe, /INTERNAL_MTLS_REJECTED/);
  assert.match(runner, /worker-cross-namespace-denied/);
  assert.match(runner, /AUTHORITY_DIRECTORY=.*\/authority/);
  assert.match(runner, /SERVER_SECRET_DIRECTORY=.*\/server/);
  assert.match(runner, /JWKS_DIRECTORY=.*\/jwks/);
  assert.match(runner, /JWKS_TLS_DIRECTORY=.*\/jwks-tls/);
  assert.match(runner, /CLIENT_SECRET_DIRECTORY=.*\/client/);
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_SERVER_SECRET_DIRECTORY/);
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_JWKS_DIRECTORY/);
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_JWKS_TLS_DIRECTORY/);
  assert.match(compose, /TEMPORAL_BROADCAST_ADDRESS:\s*127\.0\.0\.1/);
  assert.match(
    compose,
    /TEMPORAL_PLATFORM_READER_SUBJECT:\s*\$\{TEMPORAL_PLATFORM_READER_SUBJECT:-task4c-growthos-reader\}/,
  );
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_CLIENT_SECRET_DIRECTORY/);
  assert.match(compose, /TEMPORAL_PLATFORM_TEST_NODE_OVERLAY_DIRECTORY/);
  assert.match(compose, /target: \/repo\/node_modules\/\.pnpm/);
  assert.match(runner, /prepare-worker-dependencies\.mjs/);
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
  assert.match(internalProbe, /certificate[ .]required|bad[ .]certificate/i);
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

test("disposable proof reaches Temporal from the host network through the product relay config", async () => {
  const [compose, runner, probe] = await Promise.all([
    repositoryFile(
      "infra/temporal-platform/test-support/compose.disposable.yml",
    ),
    repositoryFile("infra/temporal-platform/test-support/verify-disposable.sh"),
    repositoryFile(
      "infra/temporal-platform/test-support/host-ingress-probe.mjs",
    ),
  ]);
  const server = composeService(
    compose,
    "codex-task4c-platform-temporal-server",
  );
  const ingress = composeService(
    compose,
    "codex-task4c-platform-temporal-ingress",
  );
  const hostProbe = composeService(
    compose,
    "codex-task4c-platform-temporal-host-probe",
  );
  // The product relay config names temporal-platform:7233 verbatim.
  assert.match(server, /aliases: \[task4c-temporal, temporal-platform\]/);
  assert.doesNotMatch(server, /^\s+ports:/m);
  assert.match(
    ingress,
    /haproxy@sha256:52c5921e1619f39cbd5b25e1b4b5847667917f39745056cf004d9c263fbf11b9/,
  );
  assert.match(ingress, /source: \.\.\/ingress\/haproxy\.cfg/);
  assert.match(ingress, /- "127\.0\.0\.1::7233"/);
  assert.match(ingress, /init: true/);
  assert.match(ingress, /stop_signal: SIGTERM/);
  assert.match(
    ingress,
    /networks:\n      \[codex-task4c-platform-temporal, codex-task4c-platform-temporal-ingress\]/,
  );
  assert.match(hostProbe, /network_mode: host/);
  assert.doesNotMatch(hostProbe, /temporal-platform-reader|networks:/);
  assert.match(
    compose,
    /codex-task4c-platform-temporal-ingress:\n    name: codex-task4c-platform-temporal-\$\{TEMPORAL_PLATFORM_TEST_RUN_ID:\?set test run id\}-ingress-network\n    driver: bridge\n    enable_ipv6: false\n    driver_opts:\n      com\.docker\.network\.bridge\.enable_ip_masquerade: "false"\n      com\.docker\.network\.bridge\.enable_icc: "false"/,
  );
  assert.match(runner, /host-ingress-probe\.mjs/);
  assert.match(runner, /docker port "\$\{ingress_container\}" 7233\/tcp/);
  assert.match(runner, /\.HostConfig\.PortBindings/);
  assert.match(runner, /Temporal server must not publish a host port/);
  assert.match(runner, /codex-task4c-platform-temporal-ingress"/);
  assert.match(runner, /codex-task4c-platform-temporal-host-probe"/);
  assert.match(runner, /-ingress-network/);
  assert.match(runner, /TEMPORAL_CUSTOMER_NAMESPACE_DRIFT/);
  assert.match(probe, /Connection\.lazy/);
  assert.match(probe, /describeSchedule/);
  assert.match(probe, /ERR_TLS_CERT_ALTNAME_INVALID/);
});

test("disposable probes use provisioned namespaces and never create one themselves", async () => {
  // A probe that registers "default" on demand would mask a provisioning gap.
  for (const probe of [
    "machine-worker-probe.mjs",
    "worker-poll-probe.mjs",
    "reader-rpc-probe.mjs",
    "host-ingress-probe.mjs",
  ]) {
    const source = await repositoryFile(
      `infra/temporal-platform/test-support/${probe}`,
    );
    assert.doesNotMatch(source, /registerNamespace|namespace create/, probe);
  }
});

test("host ingress probe accepts only a loopback target and bounded identities", () => {
  const probe = join(
    repositoryRoot,
    "infra/temporal-platform/test-support/host-ingress-probe.mjs",
  );
  const valid = [
    "/repo",
    "/run/secrets/temporal-platform-client/writer.jwt",
    "/run/secrets/temporal-platform-client/ca.crt",
    "127.0.0.1:32768",
    "task4c-temporal",
    "task4c-proof-schedule",
  ];
  for (const [index, value] of [
    [0, "relative/repo"],
    [3, "10.0.0.5:32768"],
    [3, "temporal-platform:7233"],
    [3, "127.0.0.1:7"],
    [4, "bad name"],
    [5, "x"],
  ]) {
    const args = [...valid];
    args[index] = value;
    const result = spawnSync(process.execPath, [probe, ...args], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16384,
    });
    assert.equal(result.status, 1, `${index}=${value}`);
    assert.match(result.stderr, /host ingress probe input is invalid/);
    assert.equal(result.stdout, "");
  }
  const missing = spawnSync(process.execPath, [probe], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(missing.status, 1);
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
  const [codeowners, requiredContextsText] = await Promise.all([
    repositoryFile(".github/CODEOWNERS"),
    repositoryFile(".github/required-contexts.json"),
  ]);
  const requiredContexts = JSON.parse(requiredContextsText);
  const expectedPatterns = [
    "/infra/temporal-platform/",
    "/scripts/temporal-platform-infrastructure-contract.spec.mjs",
  ];

  assert.match(codeowners, /^\/infra\/temporal-platform\/ @mlhjyx$/m);
  assert.match(
    codeowners,
    /^\/scripts\/temporal-platform-infrastructure-contract\.spec\.mjs @mlhjyx$/m,
  );
  for (const pattern of expectedPatterns) {
    assert.ok(
      requiredContexts.codeowner_requirements.terminal_patterns.includes(
        pattern,
      ),
      `machine CODEOWNERS policy is missing ${pattern}`,
    );
  }
});

// Human runbook wording is reviewed as documentation. Native/stock admission,
// namespace ownership and retained preflight are exercised by behavioral tests;
// an obsolete "reader-wide" prose assertion must not authorize either runtime.
