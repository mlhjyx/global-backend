import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  chmod,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeSbom } from "./temporal-native-publication-sbom.mjs";
import {
  NATIVE_IMAGE,
  sourceIdentity,
  artifactManifest,
  verifyNativeArtifact,
  verifyNativeCompose,
  verifyNativeProvenance,
} from "./temporal-native-publication.mjs";

const repo = resolve(import.meta.dirname, "..");
const sha = "a".repeat(40);
const imageId = "sha256:" + "b".repeat(64);
const imageReference = NATIVE_IMAGE + "@sha256:" + "c".repeat(64);
const digest = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const binary = Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from(
    "test-only ELF-shaped boundary input\0path\tglobal.local/temporal-platform-server/cmd/server\n",
  ),
]);
const configPaths = [
  "infra/temporal-platform/config/temporal.yaml",
  "infra/temporal-platform/config/dynamicconfig.yaml",
  "infra/temporal-platform/roles.json",
];

function expectedSource() {
  const files = configPaths.map((path) => ({
    path,
    bytes: 1,
    sha256: digest("x"),
  }));
  return {
    schemaVersion: "temporal-native-source/v1",
    sourceSha: sha,
    sourceDigest: digest(JSON.stringify(files)),
    upstreamImage,
    files,
  };
}
function verification() {
  const source = expectedSource();
  const buildInfo = Buffer.from(JSON.stringify(goInfo));
  const sbom = Buffer.from(
    JSON.stringify(nativeSbom(source, binary, goInfo, apk)),
  );
  return {
    expected: source,
    manifest: {
      schemaVersion: "temporal-native-artifact/v1",
      sourceSha: sha,
      sourceDigest: source.sourceDigest,
      upstreamImage,
      files: source.files,
      binarySha256: digest(binary),
      goBuildInfoSha256: digest(buildInfo),
      apkInventorySha256: digest(apk),
      sbomSha256: digest(sbom),
    },
    binary,
    buildInfo,
    apk,
    sbom,
    imageId,
    inspect: {
      Id: imageId,
      Config: {
        User: "1000:1000",
        Entrypoint: null,
        Cmd: ["/etc/temporal/entrypoint.sh"],
        Labels: {
          "org.opencontainers.image.revision": sha,
          "io.global.temporal.native.source-digest": source.sourceDigest,
          "io.global.temporal.native.role": "native-reader-authorization",
        },
      },
    },
    inventory: [
      "usr/local/bin/temporal-server",
      "etc/temporal/entrypoint.sh",
      "opt/temporal-platform-release/manifest.json",
      "opt/temporal-platform-release/config/temporal.yaml",
      "opt/temporal-platform-release/config/dynamicconfig.yaml",
      "opt/temporal-platform-release/roles.json",
      "opt/temporal-platform-release/sbom.cdx.json",
      "opt/temporal-platform-release/go-build-info.json",
      "lib/apk/db/installed",
      "bin/test",
    ].join("\n"),
    contracts: Object.fromEntries(
      configPaths.map((path) => [path, Buffer.from("x")]),
    ),
  };
}

test("native artifact binds actual binary bytes to exact source, image identity and public contracts", () => {
  const input = verification();
  assert.equal(verifyNativeArtifact(input).result, "PASS");
  assert.deepEqual(
    artifactManifest(
      input.expected,
      binary,
      input.buildInfo,
      input.apk,
      input.sbom,
    ),
    input.manifest,
  );
});

test("wrong source, digest, config, stock binary and synthetic final paths cannot be accepted", () => {
  for (const mutate of [
    (v) => {
      v.manifest.sourceSha = "d".repeat(40);
    },
    (v) => {
      v.manifest.sourceDigest = "sha256:" + "d".repeat(64);
    },
    (v) => {
      v.manifest.binarySha256 = "sha256:" + "d".repeat(64);
    },
    (v) => {
      v.manifest.extra = "unauthorized";
    },
    (v) => {
      v.binary = Buffer.from("stock temporal-server");
    },
    (v) => {
      v.inspect.Id = "sha256:" + "d".repeat(64);
    },
    (v) => {
      v.inspect.Config.User = "root";
    },
    (v) => {
      v.inspect.Config.Cmd = ["/run/native-server/native-entrypoint.sh"];
    },
    (v) => {
      v.inspect.Config.Entrypoint = ["/bin/sh"];
    },
    (v) => {
      v.inspect.Config.Labels["org.opencontainers.image.revision"] = "d".repeat(
        40,
      );
    },
    (v) => {
      v.inspect.Config.Labels["io.global.temporal.native.role"] = "stock";
    },
    (v) => {
      v.contracts[configPaths[0]] = Buffer.from("drift");
    },
    (v) => {
      v.inventory += "\nopt/test-support/reader-rpc-probe.mjs";
    },
    (v) => {
      v.inventory += "\nopt/fixtures/provider.json";
    },
    (v) => {
      v.inventory += "\nopt/module/policy_test.go";
    },
    (v) => {
      v.inventory += "\n../escape";
    },
    (v) => {
      v.inventory = "usr/local/bin/temporal-server";
    },
    (v) => {
      v.sbom = undefined;
    },
    (v) => {
      v.sbom = Buffer.from("{}");
    },
    (v) => {
      v.apk = Buffer.from("changed packages");
    },
    (v) => {
      v.buildInfo = Buffer.from("{}");
    },
  ]) {
    const value = verification();
    mutate(value);
    assert.throws(
      () => verifyNativeArtifact(value),
      /TEMPORAL_NATIVE_ARTIFACT_INVALID/,
    );
  }
});

function composeFixture() {
  return {
    networks: { "temporal-platform": { internal: true } },
    services: {
      "temporal-platform": {
        image: imageReference,
        user: "1000:1000",
        command: ["/etc/temporal/entrypoint.sh"],
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        networks: { "temporal-platform": null },
        environment: {
          TEMPORAL_PLATFORM_READER_SUBJECT: "growthos-reader",
          TEMPORAL_SERVER_CONFIG_FILE_PATH:
            "/etc/temporal-platform/temporal.yaml",
          TEMPORAL_ALLOW_NO_AUTH: "false",
        },
        labels: { "io.global.temporal.native.source-sha": sha },
        ports: [
          {
            host_ip: "127.0.0.1",
            published: "17233",
            target: 7233,
            protocol: "tcp",
          },
        ],
        volumes: [
          {
            type: "bind",
            source: join(repo, configPaths[0]),
            target: "/etc/temporal-platform/temporal.yaml",
            read_only: true,
            bind: { create_host_path: false },
          },
          {
            type: "bind",
            source: join(repo, configPaths[1]),
            target: "/etc/temporal-platform/dynamicconfig.yaml",
            read_only: true,
            bind: { create_host_path: false },
          },
          {
            type: "bind",
            source: "/run/secure/native-temporal",
            target: "/run/secrets/temporal-platform",
            read_only: true,
            bind: { create_host_path: false },
          },
        ],
      },
    },
  };
}
const composeExpected = {
  root: repo,
  sourceSha: sha,
  imageReference,
  readerSubject: "growthos-reader",
};

test("native compose accepts only exact digest and dedicated reader while retaining loopback isolation", () => {
  assert.equal(
    verifyNativeCompose(composeFixture(), composeExpected).result,
    "PASS",
  );
  for (const mutate of [
    (v) => {
      v.services["temporal-platform"].image =
        "docker.io/temporalio/server@sha256:" + "c".repeat(64);
    },
    (v) => {
      v.services["temporal-platform"].image = NATIVE_IMAGE + ":latest";
    },
    (v) => {
      delete v.services["temporal-platform"].environment
        .TEMPORAL_PLATFORM_READER_SUBJECT;
    },
    (v) => {
      v.services[
        "temporal-platform"
      ].environment.TEMPORAL_PLATFORM_READER_SUBJECT = "other";
    },
    (v) => {
      v.services["temporal-platform"].build = { context: "." };
    },
    (v) => {
      v.services["temporal-platform"].command = ["/bin/sh", "-c", "fallback"];
    },
    (v) => {
      v.services["temporal-platform"].entrypoint = ["/bin/sh"];
    },
    (v) => {
      v.services["temporal-platform"].ports[0].host_ip = "0.0.0.0";
    },
    (v) => {
      v.services["temporal-platform"].ports[0].published = "7233";
    },
    (v) => {
      v.services["temporal-platform"].environment.TEMPORAL_ALLOW_NO_AUTH =
        "true";
    },
    (v) => {
      v.services["temporal-platform"].volumes[0].source = "/tmp/other.yaml";
    },
    (v) => {
      v.services["temporal-platform"].volumes[0].read_only = false;
    },
    (v) => {
      v.services["temporal-platform"].volumes[0].bind.create_host_path = true;
    },
    (v) => {
      v.services["temporal-platform"].volumes.push({
        type: "bind",
        source: "/tmp/stock",
        target: "/usr/local/bin/temporal-server",
      });
    },
    (v) => {
      v.services["temporal-platform"].privileged = true;
    },
    (v) => {
      v.services["temporal-platform"].networks.default = null;
    },
    (v) => {
      v.networks["temporal-platform"].internal = false;
    },
  ]) {
    const value = composeFixture();
    mutate(value);
    assert.throws(
      () => verifyNativeCompose(value, composeExpected),
      /TEMPORAL_NATIVE_COMPOSE_INVALID/,
    );
  }
});

test("source identity is content-derived, deterministic and rejects invalid revision and symlinks", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "temporal-publication-source-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = join(directory, "infra/temporal-platform/server");
  await mkdir(join(server, "cmd/server"), { recursive: true });
  await mkdir(join(directory, "infra/temporal-platform/config"), {
    recursive: true,
  });
  for (const path of ["go.mod", "go.sum", "Dockerfile", "cmd/server/main.go"])
    await writeFile(join(server, path), "production input\n");
  for (const path of configPaths) await writeFile(join(directory, path), "x");
  for (const path of [
    "compose.yml",
    "compose.native.yml",
    "schema-provision.sh",
    "postgres/init.sql",
    "namespace-contract.mjs",
    "provision.sh",
    "provision-core.sh",
  ]) {
    await mkdir(resolve(directory, "infra/temporal-platform", path, ".."), {
      recursive: true,
    });
    await writeFile(
      join(directory, "infra/temporal-platform", path),
      "production config\n",
    );
  }
  await writeFile(
    join(server, "Dockerfile"),
    `FROM ${upstreamImage} AS runtime-base\nFROM runtime-base\n`,
  );
  await writeFile(
    join(directory, "infra/temporal-platform/images.lock.json"),
    JSON.stringify({
      images: {
        server: {
          source: "docker.io/temporalio/server",
          indexDigest: upstreamImage.split("@")[1],
        },
      },
    }),
  );
  const first = await sourceIdentity(directory, sha);
  assert.deepEqual(await sourceIdentity(directory, sha), first);
  await writeFile(
    join(server, "cmd/server/main_test.go"),
    "test-only never included",
  );
  assert.deepEqual(await sourceIdentity(directory, sha), first);
  await writeFile(join(server, "cmd/server/main.go"), "changed implementation");
  assert.notEqual(
    (await sourceIdentity(directory, sha)).sourceDigest,
    first.sourceDigest,
  );
  await assert.rejects(
    () => sourceIdentity(directory, "not-a-commit"),
    /TEMPORAL_NATIVE_SOURCE_INVALID/,
  );
  await symlink("/etc/passwd", join(server, "cmd/server/linked.go"));
  await assert.rejects(
    () => sourceIdentity(directory, sha),
    /TEMPORAL_NATIVE_SOURCE_INVALID/,
  );
});

test("CLI fails with bounded diagnostics rather than reflecting arbitrary input", () => {
  const result = spawnSync(
    process.execPath,
    [join(repo, "scripts/temporal-native-publication.mjs"), "bad-secret-input"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "TEMPORAL_NATIVE_PUBLICATION_INVALID\n");
});

test("CLI materializes and verifies actual bounded files, then rejects tampered contract bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "temporal-publication-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "config"));
  const input = verification();
  await writeFile(
    join(directory, "source.json"),
    JSON.stringify(input.expected),
  );
  await writeFile(join(directory, "temporal-server"), input.binary);
  await writeFile(join(directory, "go-build-info.json"), input.buildInfo);
  await writeFile(join(directory, "apk-installed"), input.apk);
  await writeFile(join(directory, "sbom.cdx.json"), input.sbom);
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [join(repo, "scripts/temporal-native-publication.mjs"), ...args],
      { encoding: "utf8" },
    );
  const generated = cli(
    "artifact",
    join(directory, "source.json"),
    join(directory, "temporal-server"),
    join(directory, "go-build-info.json"),
    join(directory, "apk-installed"),
    join(directory, "sbom.cdx.json"),
  );
  assert.equal(generated.status, 0, generated.stderr);
  assert.deepEqual(JSON.parse(generated.stdout), input.manifest);
  await writeFile(join(directory, "manifest.json"), generated.stdout);
  await writeFile(
    join(directory, "inspect.json"),
    JSON.stringify(input.inspect),
  );
  await writeFile(join(directory, "files.list"), input.inventory);
  for (const path of configPaths)
    await writeFile(
      join(directory, path.replace("infra/temporal-platform/", "")),
      input.contracts[path],
    );
  const checked = cli(
    "verify",
    join(directory, "source.json"),
    directory,
    imageId,
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).binarySha256, digest(binary));
  await writeFile(join(directory, "config/temporal.yaml"), "tampered");
  const failed = cli(
    "verify",
    join(directory, "source.json"),
    directory,
    imageId,
  );
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr, "TEMPORAL_NATIVE_PUBLICATION_INVALID\n");
  await writeFile(
    join(directory, "compose.json"),
    JSON.stringify(composeFixture()),
  );
  const admitted = cli(
    "compose",
    join(directory, "compose.json"),
    repo,
    sha,
    imageReference,
    "growthos-reader",
  );
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(JSON.parse(admitted.stdout).imageReference, imageReference);
});

test("actual Compose merge is native-only and rendering fails before any start when reader or image is missing", () => {
  const environment = {
    PATH: process.env.PATH,
    TEMPORAL_PLATFORM_POSTGRES_PASSWORD: "test-only-".padEnd(48, "x"),
    TEMPORAL_PLATFORM_JWKS_URI: "https://jwks.example.test/jwks.json",
    TEMPORAL_PLATFORM_JWT_AUDIENCE: "test-temporal",
    TEMPORAL_PLATFORM_SERVER_SECRET_DIRECTORY: "/run/never-read-test-server",
    TEMPORAL_PLATFORM_CLIENT_SECRET_DIRECTORY: "/run/never-read-test-client",
    TEMPORAL_PLATFORM_NATIVE_IMAGE: imageReference,
    TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA: sha,
    TEMPORAL_PLATFORM_READER_SUBJECT: "growthos-reader",
  };
  const render = (env) =>
    spawnSync(
      "docker",
      [
        "compose",
        "-p",
        "global",
        "--env-file",
        "/dev/null",
        "-f",
        join(repo, "infra/temporal-platform/compose.yml"),
        "-f",
        join(repo, "infra/temporal-platform/compose.native.yml"),
        "--profile",
        "platform-temporal",
        "config",
        "--format",
        "json",
      ],
      { env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
    );
  const result = render(environment);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    verifyNativeCompose(JSON.parse(result.stdout), composeExpected).result,
    "PASS",
  );
  for (const field of [
    "TEMPORAL_PLATFORM_NATIVE_IMAGE",
    "TEMPORAL_PLATFORM_READER_SUBJECT",
    "TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA",
  ]) {
    const env = { ...environment };
    delete env[field];
    assert.notEqual(render(env).status, 0);
  }
  const stock = render({
    ...environment,
    TEMPORAL_PLATFORM_NATIVE_IMAGE:
      "docker.io/temporalio/server@sha256:" + "c".repeat(64),
  });
  assert.equal(stock.status, 0);
  assert.throws(
    () => verifyNativeCompose(JSON.parse(stock.stdout), composeExpected),
    /TEMPORAL_NATIVE_COMPOSE_INVALID/,
  );
});

test("publish-once recovery requires a trusted exact config attestation when the registry attestation is missing", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "native-publication-recovery-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = Buffer.from(
    JSON.stringify({
      config: {
        Labels: {
          "org.opencontainers.image.revision": sha,
          "io.global.temporal.native.role": "native-reader-authorization",
        },
      },
    }),
  );
  const configPath = join(directory, "config.json");
  await writeFile(configPath, config);
  const options = {
    imageReference,
    sourceSha: sha,
    imageId: digest(config),
    configPath,
  };
  const trustedVerifier = (args) => {
    assert.equal(args[0], "attestation");
    assert.equal(args[1], "verify");
    assert(
      args.includes(
        "mlhjyx/global-backend/.github/workflows/publish-temporal-platform-image.yml",
      ),
    );
    assert.equal(args[args.indexOf("--source-digest") + 1], sha);
    assert.equal(args[args.indexOf("--signer-digest") + 1], sha);
    assert(args.includes("--deny-self-hosted-runners"));
    if (args[2].startsWith("oci://"))
      throw new Error("registry attestation missing after acknowledged push");
    assert.equal(args[2], configPath);
  };
  const recovered = await verifyNativeProvenance(options, trustedVerifier);
  assert.deepEqual(recovered, {
    result: "PASS",
    registryAttested: false,
    recovery: "TRUSTED_CONFIG_ATTESTATION",
  });
  assert.deepEqual(await verifyNativeProvenance(options, () => {}), {
    result: "PASS",
    registryAttested: true,
    recovery: "NOT_REQUIRED",
  });
  await assert.rejects(
    () =>
      verifyNativeProvenance(options, () => {
        throw new Error("forged or wrong workflow/source proof");
      }),
    /TEMPORAL_NATIVE_PROVENANCE_INVALID/,
  );
  await assert.rejects(
    () =>
      verifyNativeProvenance(
        { ...options, imageId: "sha256:" + "d".repeat(64) },
        trustedVerifier,
      ),
    /TEMPORAL_NATIVE_PROVENANCE_INVALID/,
  );
  await assert.rejects(
    () =>
      verifyNativeProvenance(
        { ...options, sourceSha: "e".repeat(40) },
        trustedVerifier,
      ),
    /TEMPORAL_NATIVE_PROVENANCE_INVALID/,
  );
  await assert.rejects(
    () =>
      verifyNativeProvenance(
        { ...options, imageReference: "stock:latest" },
        trustedVerifier,
      ),
    /TEMPORAL_NATIVE_PROVENANCE_INVALID/,
  );
});

const upstreamImage =
  "docker.io/temporalio/server@sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da";
const goInfo = {
  GoVersion: "go1.26.4",
  Path: "global.local/temporal-platform-server/cmd/server",
  Main: {
    Path: "global.local/temporal-platform-server",
    Version: "(devel)",
    Sum: "",
  },
  Deps: [
    {
      Path: "go.temporal.io/server",
      Version: "v1.31.2",
      Sum: "h1:binary-module-checksum",
    },
  ],
  Settings: [],
};
const apk = Buffer.from(
  "P:busybox\nV:1.37.0-r1\nA:x86_64\nC:Q1test-only-package-checksum\n\nP:ca-certificates-bundle\nV:20250911-r0\nA:noarch\nC:Q1second-test-checksum\n",
);
test("SBOM inventories actual build-info and APK package records rather than claiming a source hash is a complete scan", () => {
  const source = { ...expectedSource(), upstreamImage };
  const bom = nativeSbom(source, binary, goInfo, apk);
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(
    bom.metadata.component.hashes[0].content,
    digest(binary).slice(7),
  );
  assert(
    bom.components.some(
      (c) => c.name === "go.temporal.io/server" && c.version === "v1.31.2",
    ),
  );
  assert(
    bom.components.some(
      (c) => c.name === "busybox" && c.version === "1.37.0-r1",
    ),
  );
  assert(
    bom.components.some(
      (c) => c.type === "container" && c.name === upstreamImage,
    ),
  );
  assert(
    bom.properties.some(
      (p) => p.name === "vulnerability_scan" && p.value === "NOT_RUN",
    ),
  );
  for (const bad of [
    { ...goInfo, Path: "go.temporal.io/server/cmd/server" },
    { ...goInfo, Deps: [] },
    { ...goInfo, Deps: [{ Path: "x", Version: "", Sum: "" }] },
  ])
    assert.throws(
      () => nativeSbom(source, binary, bad, apk),
      /TEMPORAL_NATIVE_SBOM_INVALID/,
    );
  for (const bad of [
    Buffer.alloc(0),
    Buffer.from("P:x\nA:x86_64\n"),
    Buffer.from("P:x\nP:y\nV:1\nA:x86_64\nC:q\n"),
  ])
    assert.throws(
      () => nativeSbom(source, binary, goInfo, bad),
      /TEMPORAL_NATIVE_SBOM_INVALID/,
    );
  const replaced = nativeSbom(
    source,
    binary,
    {
      ...goInfo,
      Deps: [
        {
          Path: "original.example/mod",
          Replace: {
            Path: "replacement.example/mod",
            Version: "v1.2.3",
            Sum: "h1:test-replacement",
          },
        },
      ],
    },
    apk,
  );
  assert(
    replaced.components.some(
      (c) =>
        c.name === "replacement.example/mod" &&
        c.properties.some(
          (p) => p.name === "go:replaces" && p.value === "original.example/mod",
        ),
    ),
  );
  for (const badSource of [
    { ...source, sourceSha: "bad" },
    { ...source, sourceDigest: "bad" },
    { ...source, upstreamImage: "stock:latest" },
  ])
    assert.throws(
      () => nativeSbom(badSource, binary, goInfo, apk),
      /TEMPORAL_NATIVE_SBOM_INVALID/,
    );
  assert.throws(
    () => nativeSbom(source, Buffer.alloc(0), goInfo, apk),
    /TEMPORAL_NATIVE_SBOM_INVALID/,
  );
  assert.throws(
    () => nativeSbom(source, binary, { ...goInfo, GoVersion: "unknown" }, apk),
    /TEMPORAL_NATIVE_SBOM_INVALID/,
  );
  assert.throws(
    () =>
      nativeSbom(
        source,
        binary,
        { ...goInfo, Deps: [goInfo.Deps[0], goInfo.Deps[0]] },
        apk,
      ),
    /TEMPORAL_NATIVE_SBOM_INVALID/,
  );
  assert.throws(
    () =>
      nativeSbom(
        source,
        binary,
        goInfo,
        Buffer.concat([apk, Buffer.from("\n"), apk]),
      ),
    /TEMPORAL_NATIVE_SBOM_INVALID/,
  );
});

test("retained provision refuses missing identity and stock before any up, schema or namespace call", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-retained-refusal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "bin"));
  await mkdir(join(directory, "secrets"));
  await writeFile(
    join(directory, "secrets/admin.jwt"),
    "a".repeat(24) + "." + "b".repeat(24) + "." + "c".repeat(24),
    { mode: 0o600 },
  );
  const docker = join(directory, "bin/docker");
  await writeFile(
    docker,
    "#!/usr/bin/env node\n" +
      'const fs=require("fs");fs.appendFileSync(process.env.PROVISION_LOG,JSON.stringify(process.argv.slice(2))+"\\n");' +
      'if(process.argv.includes("run"))console.log(JSON.stringify({namespaceInfo:{name:"platform-automation",state:"Registered",description:"Dedicated non-tenant platform automation workflows",data:{platform_non_tenant:"true",platform_contract:"1"}},config:{workflowExecutionRetentionTtl:"604800s"},isGlobalNamespace:false}));\n',
  );
  await chmod(docker, 0o755);
  const log = join(directory, "calls.log");
  for (const variables of [
    {},
    {
      TEMPORAL_PLATFORM_NATIVE_IMAGE:
        "docker.io/temporalio/server@sha256:" + "c".repeat(64),
      TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA: sha,
      TEMPORAL_PLATFORM_READER_SUBJECT: "growthos-reader",
    },
  ]) {
    await writeFile(log, "");
    const result = spawnSync(
      "bash",
      [join(repo, "infra/temporal-platform/provision.sh")],
      {
        encoding: "utf8",
        env: {
          PATH: join(directory, "bin") + ":" + process.env.PATH,
          TEMPORAL_PLATFORM_CLIENT_SECRET_DIRECTORY: join(directory, "secrets"),
          PROVISION_LOG: log,
          ...variables,
        },
      },
    );
    assert.notEqual(result.status, 0);
    const calls = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
    assert(
      calls.every((args) => !args.includes("up") && !args.includes("run")),
    );
  }
});

test("retained entry admits the same native overlay only after image preflight and cleans private rendered JSON", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-retained-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["bin", "secrets", "rootfs", "tmp"])
    await mkdir(join(directory, name));
  await writeFile(
    join(directory, "secrets/admin.jwt"),
    "a".repeat(24) + "." + "b".repeat(24) + "." + "c".repeat(24),
    { mode: 0o600 },
  );
  const source = await sourceIdentity(repo, sha);
  const info = Buffer.from(JSON.stringify(goInfo));
  const bom = Buffer.from(
    JSON.stringify(nativeSbom(source, binary, goInfo, apk)),
  );
  const manifest = artifactManifest(source, binary, info, apk, bom);
  const files = {
    "usr/local/bin/temporal-server": binary,
    "etc/temporal/entrypoint.sh": Buffer.from("#!/bin/sh\n"),
    "opt/temporal-platform-release/manifest.json": Buffer.from(
      JSON.stringify(manifest),
    ),
    "opt/temporal-platform-release/go-build-info.json": info,
    "opt/temporal-platform-release/sbom.cdx.json": bom,
    "lib/apk/db/installed": apk,
  };
  for (const path of configPaths)
    files[
      path.replace("infra/temporal-platform", "opt/temporal-platform-release")
    ] = await readFile(join(repo, path));
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(resolve(directory, "rootfs", path, ".."), { recursive: true });
    await writeFile(join(directory, "rootfs", path), bytes);
  }
  const archive = join(directory, "image.tar");
  const packed = spawnSync("tar", [
    "-cf",
    archive,
    "-C",
    join(directory, "rootfs"),
    ".",
  ]);
  assert.equal(packed.status, 0);
  const inspect = verification().inspect;
  inspect.Config.Labels["io.global.temporal.native.source-digest"] =
    source.sourceDigest;
  await writeFile(join(directory, "inspect.json"), JSON.stringify(inspect));
  const compose = composeFixture();
  compose.services["temporal-platform"].environment.TEST_ONLY_SECRET =
    "must-not-appear-in-output";
  await writeFile(join(directory, "compose.json"), JSON.stringify(compose));
  const docker = join(directory, "bin/docker");
  await writeFile(
    docker,
    "#!/usr/bin/env node\n" +
      'const fs=require("fs");const a=process.argv.slice(2);fs.appendFileSync(process.env.PROVISION_LOG,JSON.stringify(a)+"\\n");' +
      'if(a[0]==="image")process.stdout.write(fs.readFileSync(process.env.TEST_INSPECT));' +
      'else if(a[0]==="create")console.log("d".repeat(64));' +
      'else if(a[0]==="export")fs.copyFileSync(process.env.TEST_ARCHIVE,a[a.indexOf("--output")+1]);' +
      'else if(a.includes("config")){const p=fs.readdirSync(process.env.TMPDIR).find(n=>n.startsWith("temporal-native-preflight."));' +
      'const dir=process.env.TMPDIR+"/"+p;if((fs.statSync(dir).mode&511)!==448||(fs.statSync(dir+"/compose.json").mode&511)!==384)process.exit(9);' +
      'if(process.env.TEST_RENDER_FAIL){process.stderr.write("must-not-appear-in-output");process.exit(7);}' +
      "process.stdout.write(fs.readFileSync(process.env.TEST_COMPOSE));}" +
      'else if(a.includes("run"))console.log(JSON.stringify({namespaceInfo:{name:"platform-automation",state:"Registered",description:"Dedicated non-tenant platform automation workflows",data:{platform_non_tenant:"true",platform_contract:"1"}},config:{workflowExecutionRetentionTtl:"604800s"},isGlobalNamespace:false}));\n',
  );
  await chmod(docker, 0o755);
  const log = join(directory, "calls.log");
  await writeFile(log, "");
  const runProvision = (extra = {}) =>
    spawnSync("bash", [join(repo, "infra/temporal-platform/provision.sh")], {
      encoding: "utf8",
      env: {
        PATH: join(directory, "bin") + ":" + process.env.PATH,
        TMPDIR: join(directory, "tmp"),
        TEMPORAL_PLATFORM_NATIVE_IMAGE: imageReference,
        TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA: sha,
        TEMPORAL_PLATFORM_READER_SUBJECT: "growthos-reader",
        TEMPORAL_PLATFORM_CLIENT_SECRET_DIRECTORY: join(directory, "secrets"),
        PROVISION_LOG: log,
        TEST_INSPECT: join(directory, "inspect.json"),
        TEST_ARCHIVE: archive,
        TEST_COMPOSE: join(directory, "compose.json"),
        ...extra,
      },
    });
  const result = runProvision();
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stdout.includes("must-not-appear-in-output"));
  assert(!result.stderr.includes("must-not-appear-in-output"));
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  const up = calls.findIndex((a) => a.includes("up"));
  assert(up > calls.findIndex((a) => a[0] === "export"));
  assert(
    calls[up].includes(
      join(repo, "infra/temporal-platform/compose.native.yml"),
    ),
  );
  assert.deepEqual(await readdir(join(directory, "tmp")), []);
  for (const failure of ["wrong-image-source", "render-error"]) {
    await writeFile(log, "");
    inspect.Config.Labels["org.opencontainers.image.revision"] =
      failure === "wrong-image-source" ? "e".repeat(40) : sha;
    await writeFile(join(directory, "inspect.json"), JSON.stringify(inspect));
    const rejected = runProvision(
      failure === "render-error" ? { TEST_RENDER_FAIL: "1" } : {},
    );
    assert.equal(rejected.status, 1);
    assert(!rejected.stdout.includes("must-not-appear-in-output"));
    assert(!rejected.stderr.includes("must-not-appear-in-output"));
    const rejectedCalls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      rejectedCalls.every(
        (args) => !args.includes("up") && !args.includes("run"),
      ),
    );
    assert.deepEqual(await readdir(join(directory, "tmp")), []);
  }
});

test("disposable wrapper retains shared namespace admission and drift refusal without entering the retained path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-disposable-core-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "bin"));
  await mkdir(join(directory, "secrets"));
  await writeFile(
    join(directory, "secrets/admin.jwt"),
    "a".repeat(24) + "." + "b".repeat(24) + "." + "c".repeat(24),
    { mode: 0o600 },
  );
  const docker = join(directory, "bin/docker");
  await writeFile(
    docker,
    '#!/usr/bin/env node\nconst fs=require("fs");const a=process.argv.slice(2);fs.appendFileSync(process.env.PROVISION_LOG,JSON.stringify(a)+"\\n");if(a.includes("run"))process.stdout.write(fs.readFileSync(process.env.NAMESPACE_JSON));\n',
  );
  await chmod(docker, 0o755);
  const log = join(directory, "calls.log");
  const data = join(directory, "namespace.json");
  for (const [retention, accepted] of [
    ["604800s", true],
    ["86400s", false],
  ]) {
    await writeFile(log, "");
    await writeFile(
      data,
      JSON.stringify({
        namespaceInfo: {
          name: "platform-automation",
          state: "Registered",
          description: "Dedicated non-tenant platform automation workflows",
          data: { platform_non_tenant: "true", platform_contract: "1" },
        },
        config: { workflowExecutionRetentionTtl: retention },
        isGlobalNamespace: false,
      }),
    );
    const result = spawnSync(
      "bash",
      [
        join(
          repo,
          "infra/temporal-platform/test-support/provision-disposable.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          PATH: join(directory, "bin") + ":" + process.env.PATH,
          TEMPORAL_PLATFORM_CLIENT_SECRET_DIRECTORY: join(directory, "secrets"),
          TEMPORAL_PLATFORM_TEST_RUN_ID: "contract-test",
          TEMPORAL_PLATFORM_COMPOSE_FILE: join(
            repo,
            "infra/temporal-platform/test-support/compose.disposable.yml",
          ),
          TEMPORAL_PLATFORM_ADMIN_SERVICE:
            "codex-task4c-platform-temporal-admin",
          TEMPORAL_PLATFORM_SERVER_SERVICE:
            "codex-task4c-platform-temporal-server",
          PROVISION_LOG: log,
          NAMESPACE_JSON: data,
        },
      },
    );
    assert.equal(result.status, accepted ? 0 : 1, result.stderr);
    if (!accepted)
      assert(result.stderr.includes("PLATFORM_TEMPORAL_NAMESPACE_DRIFT"));
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert(
      calls[0].includes("up") &&
        calls[0].includes("codex-task4c-platform-temporal-server"),
    );
    assert(
      calls[1].includes("run") &&
        calls[1].includes("codex-task4c-platform-temporal-admin"),
    );
    assert(
      calls.every(
        (args) =>
          args.includes(
            join(
              repo,
              "infra/temporal-platform/test-support/compose.disposable.yml",
            ),
          ) &&
          !args.includes(
            join(repo, "infra/temporal-platform/compose.native.yml"),
          ),
      ),
    );
  }
});

function assertNativePublicationContract(workflow) {
  // Closed workflow format, not a permissive general YAML parser. Unsupported
  // aliases/merges, duplicate keys and added jobs/privilege surfaces fail closed.
  const lines = workflow.split("\n");
  const keys = lines
    .filter((l) => /^[A-Za-z][A-Za-z0-9_-]*:/.test(l))
    .map((l) => l.split(":")[0]);
  assert.deepEqual(keys.sort(), [
    "concurrency",
    "env",
    "jobs",
    "name",
    "on",
    "permissions",
  ]);
  assert.doesNotMatch(workflow, /^\s*(?:<<:|[A-Za-z0-9_-]+:\s*[&*])/m);
  assert.doesNotMatch(workflow, /^\s*continue-on-error:/m);
  for (const expression of workflow.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    if (/\bsecrets\b/.test(expression[1]))
      assert.equal(expression[1].trim(), "secrets.GITHUB_TOKEN");
  }
  const section = (name) => {
    const start = lines.indexOf(name + ":");
    assert(start >= 0);
    let end = start + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end])))
      end++;
    return lines.slice(start + 1, end);
  };
  const mapping = (input, indent) => {
    const result = {};
    const pattern = new RegExp(
      "^ {" + indent + "}([A-Za-z0-9_-]+):(?: (.*))?$",
    );
    for (const line of input) {
      const match = line.match(pattern);
      if (!match) continue;
      assert(
        !Object.hasOwn(result, match[1]),
        "duplicate workflow mapping key",
      );
      result[match[1]] = match[2] ?? "";
    }
    return result;
  };
  assert.deepEqual(
    section("on").filter((l) => l.trim()),
    ["  workflow_dispatch:"],
  );
  assert.deepEqual(mapping(section("permissions"), 2), {
    contents: "read",
    packages: "write",
    "id-token": "write",
    attestations: "write",
  });
  assert.deepEqual(mapping(section("concurrency"), 2), {
    group: "publish-temporal-platform-image-${{ github.sha }}",
    "cancel-in-progress": "false",
  });
  assert.deepEqual(mapping(section("env"), 2), {
    IMAGE_NAME: NATIVE_IMAGE,
    SUBJECT_SHA: "${{ github.sha }}",
  });
  const jobLines = section("jobs");
  assert.deepEqual(Object.keys(mapping(jobLines, 2)), ["publish"]);
  const job = mapping(jobLines, 4);
  assert.deepEqual(Object.keys(job).sort(), [
    "environment",
    "if",
    "outputs",
    "runs-on",
    "steps",
    "timeout-minutes",
  ]);
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(job.environment, "runtime-image-publication");
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], "60");
  const blocks = [];
  for (const line of jobLines) {
    if (line.startsWith("      - "))
      blocks.push([line.replace("      - ", "        ")]);
    else if (blocks.length) blocks.at(-1).push(line);
  }
  const steps = blocks.map((block) => ({ block, ...mapping(block, 8) }));
  const ids = [
    "checkout",
    "source",
    "login",
    "existing",
    "prepare",
    "config_attestation",
    "publication",
    "registry_attestation",
    "readback",
    "logout",
  ];
  assert.deepEqual(
    steps.map((s) => s.id),
    ids,
  );
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  const run = (step) => {
    if (step.run !== "|") return step.run ?? "";
    const index = step.block.indexOf("        run: |");
    assert(index >= 0);
    return step.block
      .slice(index + 1)
      .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
      .join("\n");
  };
  const commands = (step) => {
    const result = [];
    let current = "";
    for (let line of run(step).split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      current += (current ? " " : "") + line.replace(/\\$/, "").trim();
      if (!line.endsWith("\\")) {
        result.push(current);
        current = "";
      }
    }
    assert.equal(current, "");
    return result;
  };
  for (const step of steps) {
    assert(
      Object.keys(mapping(step.block, 8)).every((k) =>
        ["id", "name", "uses", "with", "run", "shell", "env", "if"].includes(k),
      ),
    );
    if (step.run) {
      assert.equal(step.shell, "bash");
      assert.equal(
        spawnSync("bash", ["-n"], { input: run(step), encoding: "utf8" })
          .status,
        0,
      );
      if (step.id !== "logout")
        assert.equal(commands(step)[0], "set -euo pipefail");
      assert.doesNotMatch(run(step), /^\s*(?:SUBJECT_SHA|IMAGE_NAME)=/m);
      assert.doesNotMatch(run(step), /set \+e/);
    }
    assert(!Object.hasOwn(mapping(step.block, 10), "SUBJECT_SHA"));
    assert(!Object.hasOwn(mapping(step.block, 10), "IMAGE_NAME"));
  }
  const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
  const attest = "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6";
  assert.deepEqual(
    steps.filter((s) => s.uses).map((s) => s.uses.split(" #")[0]),
    [checkout, attest, attest],
  );
  assert.deepEqual(mapping(byId.checkout.block, 10), {
    "fetch-depth": "0",
    "persist-credentials": "false",
  });
  const exactMain = 'test "$(git rev-parse origin/main)" = "${SUBJECT_SHA}"';
  const exactHead = 'test "$(git rev-parse HEAD)" = "${SUBJECT_SHA}"';
  const source = commands(byId.source);
  for (const needed of [
    "git fetch --no-tags origin main",
    exactMain,
    exactHead,
    "git diff --exit-code",
    'test -z "$(git ls-files --others --exclude-standard)"',
  ])
    assert(source.includes(needed));
  assert(
    source.findIndex((c) =>
      c.startsWith("node scripts/temporal-native-publication.mjs source"),
    ) > source.indexOf(exactMain),
  );
  assert(
    commands(byId.login).some(
      (c) =>
        c.includes("docker login ghcr.io") && c.endsWith("--password-stdin"),
    ),
  );
  const resolveCommand =
    'node scripts/ghcr-runtime-publication.mjs resolve --image mlhjyx/global-temporal-platform --tag "${SUBJECT_SHA}" --github-output "${GITHUB_OUTPUT}"';
  assert(commands(byId.existing).includes(resolveCommand));
  const prepare = commands(byId.prepare);
  assert(
    prepare.some(
      (c) =>
        c ===
        'docker build --file infra/temporal-platform/server/Dockerfile --build-arg "BUILD_SHA=${SUBJECT_SHA}" --build-arg "SOURCE_DIGEST=${source_digest}" --tag "$image_tag" .',
    ),
  );
  assert(steps.indexOf(byId.source) < steps.indexOf(byId.prepare));
  assert(
    prepare.some(
      (c) =>
        c ===
        'test "sha256:$(sha256sum "$snapshot/image-config.json" | cut -d \' \' -f 1)" = "$image_id"',
    ),
  );
  const recovery =
    'node scripts/temporal-native-publication.mjs provenance "$EXISTING_REFERENCE" "$SUBJECT_SHA" "$image_id" "$snapshot/image-config.json" > "$snapshot/provenance.json"';
  const recoveryIndex = prepare.indexOf(recovery);
  assert(recoveryIndex > 0);
  assert.equal(
    prepare[recoveryIndex - 1],
    'if [[ "${EXISTING}" == true ]]; then',
  );
  assert(
    prepare.some((c) =>
      c.startsWith("node scripts/temporal-native-publication.mjs verify "),
    ),
  );
  const configAttestation = byId.config_attestation;
  assert.equal(configAttestation.if, "steps.existing.outputs.exists != 'true'");
  assert.deepEqual(mapping(configAttestation.block, 10), {
    "subject-path": "${{ steps.prepare.outputs.config_path }}",
    "create-storage-record": "false",
  });
  const publication = commands(byId.publication);
  const push = publication.indexOf('timeout 15m docker push "$image_tag"');
  assert(push >= 0);
  const fetchBeforePush = publication.indexOf(
    "git fetch --no-tags origin main",
  );
  const mainBeforePush = publication.indexOf(exactMain);
  const headBeforePush = publication.indexOf(exactHead);
  assert(
    fetchBeforePush >= 0 &&
      fetchBeforePush < mainBeforePush &&
      mainBeforePush < headBeforePush &&
      headBeforePush < push,
  );
  const tagResolve = publication.findIndex(
    (c) =>
      c.startsWith("node scripts/ghcr-runtime-publication.mjs resolve") &&
      c.includes('"$prepush_output"'),
  );
  const tagAbsent = publication.indexOf(
    'test "$(sed -n \'s/^exists=//p\' "$prepush_output")" = false',
  );
  assert(
    tagResolve > headBeforePush && tagAbsent > tagResolve && tagAbsent < push,
  );
  const readDigest = publication.findIndex(
    (c) =>
      c.includes("ghcr-runtime-publication.mjs resolve") &&
      c.endsWith("--wait-ms 30000"),
  );
  assert(readDigest > push);
  assert(
    publication.indexOf('timeout 10m docker pull "$reference"') > readDigest,
  );
  assert(
    publication.indexOf(
      'test "$(docker image inspect --format \'{{.Id}}\' "$reference")" = "$LOCAL_IMAGE_ID"',
    ) > readDigest,
  );
  assert.equal(
    steps.flatMap((s) => commands(s)).filter((c) => /\bdocker push\b/.test(c))
      .length,
    1,
  );
  assert.equal(
    byId.registry_attestation.if,
    "steps.prepare.outputs.registry_attested != 'true'",
  );
  assert.deepEqual(mapping(byId.registry_attestation.block, 10), {
    "subject-name": "${{ env.IMAGE_NAME }}",
    "subject-digest": "${{ steps.publication.outputs.image_digest }}",
    "push-to-registry": "true",
    "create-storage-record": "false",
  });
  const finalVerify =
    'gh attestation verify "oci://${IMAGE_REFERENCE}" --repo "${GITHUB_REPOSITORY}" --bundle-from-oci --signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/publish-temporal-platform-image.yml" --signer-digest "${SUBJECT_SHA}" --source-ref refs/heads/main --source-digest "${SUBJECT_SHA}" --deny-self-hosted-runners >/dev/null';
  assert(commands(byId.readback).includes(finalVerify));
  assert.equal(byId.logout.if, "always()");
  assert.equal(byId.logout.run, "docker logout ghcr.io");
}

test("actual native workflow preserves manual least-privilege source-bound publication and recoverable ordering", async () => {
  assertNativePublicationContract(
    await readFile(
      join(repo, ".github/workflows/publish-temporal-platform-image.yml"),
      "utf8",
    ),
  );
});

test("native workflow machine contract rejects dangerous trigger, permission, identity and execution-order mutations", async () => {
  const workflow = await readFile(
    join(repo, ".github/workflows/publish-temporal-platform-image.yml"),
    "utf8",
  );
  const changes = [
    [
      "jobs:\n",
      "jobs:\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
    ],
    ["  workflow_dispatch:", "  workflow_dispatch:\n  push:"],
    ["  packages: write", "  packages: write\n  actions: write"],
    ["  publish:\n", "  publish:\n    permissions: write-all\n"],
    ["    runs-on: ubuntu-latest", "    runs-on: self-hosted"],
    [
      "        shell: bash",
      "        continue-on-error: true\n        shell: bash",
    ],
    [
      "IMAGE_NAME: ghcr.io/mlhjyx/global-temporal-platform",
      "IMAGE_NAME: ghcr.io/mlhjyx/global-backend",
    ],
    ["if: github.ref == 'refs/heads/main'", "if: always()"],
    ["environment: runtime-image-publication", "environment: unprotected"],
    ["cancel-in-progress: false", "cancel-in-progress: true"],
    ["timeout-minutes: 60", "timeout-minutes: 0"],
    [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@main",
    ],
    ["persist-credentials: false", "persist-credentials: true"],
    ["secrets.GITHUB_TOKEN", "secrets.DEPLOY_KEY"],
    [
      "node scripts/temporal-native-publication.mjs provenance",
      "true # removed trusted recovery",
    ],
    [
      "subject-path: ${{ steps.prepare.outputs.config_path }}",
      "subject-path: /tmp/unrelated-config",
    ],
    ["--deny-self-hosted-runners >/dev/null", ">/dev/null"],
    ['--source-digest "${SUBJECT_SHA}"', '--source-digest "wrong"'],
    ['timeout 10m docker pull "$reference"', "true # removed immutable pull"],
    [
      '"$reference")" = "$LOCAL_IMAGE_ID"',
      '"$reference")" = "different-image"',
    ],
  ];
  for (const [before, after] of changes) {
    const mutated = workflow.replace(before, after);
    assert.notEqual(mutated, workflow, before);
    assert.throws(
      () => assertNativePublicationContract(mutated),
      undefined,
      before,
    );
  }
  const check = 'test "$(git rev-parse origin/main)" = "${SUBJECT_SHA}"';
  for (const index of [workflow.indexOf(check), workflow.lastIndexOf(check)])
    assert.throws(() =>
      assertNativePublicationContract(
        workflow.slice(0, index) +
          "true # removed main gate" +
          workflow.slice(index + check.length),
      ),
    );
  const fetch = "git fetch --no-tags origin main";
  const lastFetch = workflow.lastIndexOf(fetch);
  assert.throws(() =>
    assertNativePublicationContract(
      workflow.slice(0, lastFetch) +
        "true # stale remote main" +
        workflow.slice(lastFetch + fetch.length),
    ),
  );
  assert.throws(() =>
    assertNativePublicationContract(
      workflow.replace(
        'test "$(sed -n \'s/^exists=//p\' "$prepush_output")" = false',
        "true # overwrite risk",
      ),
    ),
  );
  const configStart = workflow.indexOf("      - id: config_attestation");
  const publicationStart = workflow.indexOf("      - id: publication");
  const registryStart = workflow.indexOf("      - id: registry_attestation");
  const moved =
    workflow.slice(0, configStart) +
    workflow.slice(publicationStart, registryStart) +
    workflow.slice(configStart, publicationStart) +
    workflow.slice(registryStart);
  assert.throws(() => assertNativePublicationContract(moved));
  assert.throws(() =>
    assertNativePublicationContract(
      workflow.slice(0, configStart) + workflow.slice(publicationStart),
    ),
  );
});

test("file admission rejects restored pathname and content races and bounds concurrent growth", async (t) => {
  // Interpose only at the actual I/O boundary; mutations are real filesystem
  // operations against disposable files, not fabricated stat/read responses.
  for (const scenario of [
    "parent-swap",
    "leaf-swap",
    "same-inode-rewrite",
    "growth",
  ]) {
    await t.test(scenario, async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-file-race-"));
      const parent = join(directory, "named");
      const outside = join(directory, "outside");
      await mkdir(parent);
      await mkdir(outside);
      const path = join(parent, "config.json");
      const attacker = join(outside, "config.json");
      const bytes = (padding) =>
        Buffer.from(
          JSON.stringify({
            config: {
              Labels: {
                "org.opencontainers.image.revision": sha,
                "io.global.temporal.native.role": "native-reader-authorization",
              },
            },
            padding,
          }),
        );
      const original = bytes("Original");
      const replacement = bytes("Attacked");
      assert.equal(original.length, replacement.length);
      await writeFile(path, original);
      await writeFile(attacker, replacement);
      // Exact whole-second mtime lets the test restore it faithfully. ctime
      // still changes on a same-inode rewrite and cannot be restored by utimes.
      await fsPromises.utimes(path, 1_000_000, 1_000_000);
      const real = { open: fsPromises.open, readFile: fsPromises.readFile };
      let mutations = 0;
      let opened = 0;
      let closed = 0;
      let consumed = 0;
      const mutate = async (operation) => {
        if (mutations) return operation();
        mutations++;
        if (scenario === "parent-swap") {
          const saved = join(directory, "saved-parent");
          await fsPromises.rename(parent, saved);
          await symlink(outside, parent);
          try {
            return await operation();
          } finally {
            await fsPromises.unlink(parent);
            await fsPromises.rename(saved, parent);
          }
        }
        if (scenario === "leaf-swap") {
          const saved = join(directory, "saved-file");
          await fsPromises.rename(path, saved);
          await symlink(attacker, path);
          try {
            return await operation();
          } finally {
            await fsPromises.unlink(path);
            await fsPromises.rename(saved, path);
          }
        }
        await writeFile(
          path,
          scenario === "growth"
            ? Buffer.alloc(4 * 1024 * 1024 + 1, 0x78)
            : replacement,
        );
        await fsPromises.utimes(path, 1_000_000, 1_000_000);
        try {
          return await operation();
        } finally {
          await writeFile(path, original);
          await fsPromises.utimes(path, 1_000_000, 1_000_000);
        }
      };
      // Old pathname read is included so this regression demonstrates RED on
      // the vulnerable implementation; the replacement reader uses real FDs.
      fsPromises.readFile = async (file, ...args) => {
        if (file !== path) return real.readFile(file, ...args);
        return mutate(async () => {
          const value = await real.readFile(file, ...args);
          consumed += value.length;
          return value;
        });
      };
      fsPromises.open = async (file, ...args) => {
        const create = () => real.open(file, ...args);
        const handle =
          file === path && scenario === "parent-swap"
            ? await mutate(create)
            : await create();
        if (file === path) {
          opened++;
          const read = handle.read.bind(handle);
          const close = handle.close.bind(handle);
          handle.read = async (...readArgs) => {
            const operation = async () => {
              const value = await read(...readArgs);
              consumed += value.bytesRead;
              return value;
            };
            return scenario === "parent-swap" ? operation() : mutate(operation);
          };
          handle.close = async () => {
            closed++;
            return close();
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
      try {
        let rejected = false;
        try {
          await verifyNativeProvenance(
            {
              imageReference,
              sourceSha: sha,
              imageId: digest(replacement),
              configPath: path,
            },
            () => {},
          );
        } catch (error) {
          assert.match(error.message, /TEMPORAL_NATIVE_PROVENANCE_INVALID/);
          rejected = true;
        }
        assert.equal(
          mutations,
          1,
          "the real filesystem race must be exercised",
        );
        assert.equal(rejected, true, "raced bytes must never be admitted");
        if (scenario === "parent-swap" && opened)
          assert.equal(
            consumed,
            0,
            "a different opened inode must be rejected before reading",
          );
        if (scenario === "growth")
          assert(
            consumed <= original.length + 1,
            "concurrent growth must not cause an unbounded read",
          );
        assert.equal(
          closed,
          opened,
          "all successfully opened descriptors must close",
        );
      } finally {
        fsPromises.readFile = real.readFile;
        fsPromises.open = real.open;
        syncBuiltinESMExports();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("workflow guard retains anchored assignment and anywhere errexit disabling semantics", async () => {
  const workflow = await readFile(
    join(repo, ".github/workflows/publish-temporal-platform-image.yml"),
    "utf8",
  );
  const location = "          git diff --exit-code";
  for (const addition of [
    "SUBJECT_SHA=changed",
    "IMAGE_NAME=changed",
    "set +e",
    "echo safe; set +e",
    "if true; then set +e; fi",
  ]) {
    assert.throws(
      () =>
        assertNativePublicationContract(
          workflow.replace(location, location + "\n          " + addition),
        ),
      undefined,
      addition,
    );
  }
  assert.doesNotThrow(() =>
    assertNativePublicationContract(
      workflow.replace(
        location,
        location + '\n          echo "SUBJECT_SHA=display-only"',
      ),
    ),
  );
});
