import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { lstat, readdir, open, realpath, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { nativeSbom } from "./temporal-native-publication-sbom.mjs";

export const NATIVE_IMAGE = "ghcr.io/mlhjyx/global-temporal-platform";
export async function verifyNativeProvenance(
  options,
  run = (args) =>
    execFileSync("gh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600000,
      maxBuffer: 1024 * 1024,
    }),
) {
  try {
    const { imageReference, sourceSha, imageId, configPath } = options;
    if (
      typeof imageReference !== "string" ||
      !imageReference.startsWith(NATIVE_IMAGE + "@") ||
      !DIGEST.test(imageReference.slice(NATIVE_IMAGE.length + 1)) ||
      !SHA.test(sourceSha) ||
      !DIGEST.test(imageId) ||
      !isAbsolute(configPath)
    )
      fail("PROVENANCE");
    const bytes = await boundedFile(configPath);
    const config = JSON.parse(bytes);
    if (
      sha256(bytes) !== imageId ||
      config.config?.Labels?.["org.opencontainers.image.revision"] !==
        sourceSha ||
      config.config.Labels["io.global.temporal.native.role"] !==
        "native-reader-authorization"
    )
      fail("PROVENANCE");
    const common = [
      "--repo",
      "mlhjyx/global-backend",
      "--signer-workflow",
      "mlhjyx/global-backend/.github/workflows/publish-temporal-platform-image.yml",
      "--signer-digest",
      sourceSha,
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      sourceSha,
      "--deny-self-hosted-runners",
    ];
    try {
      run([
        "attestation",
        "verify",
        "oci://" + imageReference,
        "--bundle-from-oci",
        ...common,
      ]);
      return {
        result: "PASS",
        registryAttested: true,
        recovery: "NOT_REQUIRED",
      };
    } catch {
      // Only trusted pre-push config provenance can bridge the push/attest ACK gap.
      // An image label or a matching source-looking filename is never sufficient.
      run(["attestation", "verify", configPath, ...common]);
      return {
        result: "PASS",
        registryAttested: false,
        recovery: "TRUSTED_CONFIG_ATTESTATION",
      };
    }
  } catch {
    return fail("PROVENANCE");
  }
}
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CONTRACTS = [
  "infra/temporal-platform/config/temporal.yaml",
  "infra/temporal-platform/config/dynamicconfig.yaml",
  "infra/temporal-platform/roles.json",
];
const RELEASE = "opt/temporal-platform-release";
const sha256 = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const fail = (kind) => {
  throw new Error(`TEMPORAL_NATIVE_${kind}_INVALID`);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const closed = (value, fields) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  equal(Object.keys(value).sort(), [...fields].sort());

export function nativeIdentity(sourceSha, imageReference, readerSubject) {
  if (
    typeof sourceSha !== "string" ||
    !SHA.test(sourceSha) ||
    typeof imageReference !== "string" ||
    !imageReference.startsWith(NATIVE_IMAGE + "@") ||
    !DIGEST.test(imageReference.slice(NATIVE_IMAGE.length + 1)) ||
    typeof readerSubject !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(readerSubject)
  )
    fail("IDENTITY");
  return { result: "PASS", sourceSha, imageReference, readerSubject };
}

/** Local capture never pulls an image or starts its container. Docker owns the
 * export; tar reads only fixed paths, without extracting archive paths to disk. */
export async function captureNativeImage(
  root,
  sourceSha,
  imageReference,
  directory,
) {
  let container;
  const docker = (args) =>
    execFileSync("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
    });
  try {
    nativeIdentity(sourceSha, imageReference, "capture-only");
    if (
      !isAbsolute(directory) ||
      (await realpath(dirname(directory))) !== resolve(dirname(directory))
    )
      fail("ARTIFACT");
    await mkdir(directory, { mode: 0o700 });
    const expected = await sourceIdentity(root, sourceSha);
    const inspect = JSON.parse(
      docker(["image", "inspect", "--format", "{{json .}}", imageReference]),
    );
    if (!DIGEST.test(inspect.Id)) fail("ARTIFACT");
    container = docker([
      "create",
      "--network",
      "none",
      "--entrypoint",
      "/bin/false",
      imageReference,
    ])
      .toString("utf8")
      .trim();
    if (!/^[a-f0-9]{64}$/.test(container)) {
      container = undefined;
      fail("ARTIFACT");
    }
    const archive = join(directory, "filesystem.tar");
    docker(["export", "--output", archive, container]);
    const stat = await lstat(archive);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 * 1024) fail("ARTIFACT");
    const tar = (args, maxBuffer = 4 * 1024 * 1024) =>
      execFileSync("tar", args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600000,
        maxBuffer,
      });
    const inventory = tar(["-tf", archive], 32 * 1024 * 1024).toString("utf8");
    const entries = new Set(inventory.split("\n"));
    const extract = (path, max) => {
      const entry = entries.has(path)
        ? path
        : entries.has("./" + path)
          ? "./" + path
          : undefined;
      if (!entry) fail("ARTIFACT");
      return tar(["-xOf", archive, entry], max);
    };
    const contracts = {};
    for (const path of CONTRACTS)
      contracts[path] = extract(
        path.replace("infra/temporal-platform", RELEASE),
      );
    return verifyNativeArtifact({
      expected,
      inspect,
      imageId: inspect.Id,
      manifest: JSON.parse(extract(`${RELEASE}/manifest.json`)),
      binary: extract("usr/local/bin/temporal-server", 512 * 1024 * 1024),
      inventory,
      contracts,
      buildInfo: extract(`${RELEASE}/go-build-info.json`),
      sbom: extract(`${RELEASE}/sbom.cdx.json`),
      apk: extract("lib/apk/db/installed", 8 * 1024 * 1024),
    });
  } catch {
    return fail("ARTIFACT");
  } finally {
    if (container) {
      try {
        docker(["rm", container]);
      } catch {
        fail("ARTIFACT");
      }
    }
  }
}

async function boundedFile(path, maximum = 4 * 1024 * 1024) {
  let handle;
  const sameFile = (left, right) =>
    ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"].every(
      (field) => left[field] === right[field],
    );
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 1) fail("FILE");
    // Open first; all content reads use this one descriptor. NONBLOCK prevents
    // a FIFO from hanging before fstat can reject its non-regular file type.
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    const namedBefore = await lstat(path, { bigint: true });
    const canonical = resolve(path);
    if (
      !before.isFile() ||
      !namedBefore.isFile() ||
      before.size < 1n ||
      before.size > BigInt(maximum) ||
      !sameFile(before, namedBefore) ||
      (await realpath(path)) !== canonical
    )
      fail("FILE");
    // One extra byte detects growth without readFile's unbounded EOF allocation.
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        size,
        bytes.length - size,
        size,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const namedAfter = await lstat(path, { bigint: true });
    if (
      BigInt(size) !== before.size ||
      !sameFile(before, after) ||
      !sameFile(after, namedAfter) ||
      (await realpath(path)) !== canonical
    )
      fail("FILE");
    return bytes.subarray(0, size);
  } finally {
    await handle?.close();
  }
}

export async function sourceIdentity(root, sourceSha) {
  try {
    if (!SHA.test(sourceSha)) fail("SOURCE");
    root = resolve(root);
    if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
      fail("SOURCE");
    const paths = [
      ...CONTRACTS,
      ...[
        "compose.yml",
        "compose.native.yml",
        "schema-provision.sh",
        "postgres/init.sql",
        "namespace-contract.mjs",
        "images.lock.json",
        "provision.sh",
        "provision-core.sh",
      ].map((p) => "infra/temporal-platform/" + p),
    ];
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) fail("SOURCE");
        if (entry.isDirectory()) await walk(path);
        else if (
          entry.name === "Dockerfile" ||
          entry.name === "go.mod" ||
          entry.name === "go.sum" ||
          (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go"))
        )
          paths.push(relative(root, path));
      }
    };
    await walk(join(root, "infra/temporal-platform/server"));
    const lock = JSON.parse(
      await boundedFile(join(root, "infra/temporal-platform/images.lock.json")),
    );
    const upstreamImage =
      lock.images?.server?.source + "@" + lock.images?.server?.indexDigest;
    if (
      !/^docker\.io\/temporalio\/server@sha256:[a-f0-9]{64}$/.test(
        upstreamImage,
      )
    )
      fail("SOURCE");
    const fromLines = (
      await boundedFile(join(root, "infra/temporal-platform/server/Dockerfile"))
    )
      .toString("utf8")
      .split("\n")
      .filter((line) => line.startsWith("FROM "));
    if (
      !fromLines.includes(`FROM ${upstreamImage} AS runtime-base`) ||
      fromLines.at(-1) !== "FROM runtime-base"
    )
      fail("SOURCE");
    if (paths.length > 128) fail("SOURCE");
    const files = [];
    for (const path of paths.sort()) {
      const bytes = await boundedFile(join(root, path));
      files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    }
    return Object.freeze({
      schemaVersion: "temporal-native-source/v1",
      sourceSha,
      sourceDigest: sha256(JSON.stringify(files)),
      upstreamImage,
      files,
    });
  } catch {
    return fail("SOURCE");
  }
}

function validSource(source) {
  if (
    !closed(source, [
      "schemaVersion",
      "sourceSha",
      "sourceDigest",
      "upstreamImage",
      "files",
    ]) ||
    source.schemaVersion !== "temporal-native-source/v1" ||
    !SHA.test(source.sourceSha) ||
    !DIGEST.test(source.sourceDigest) ||
    !/^docker\.io\/temporalio\/server@sha256:[a-f0-9]{64}$/.test(
      source.upstreamImage,
    ) ||
    !Array.isArray(source.files) ||
    source.files.length < 3 ||
    source.files.length > 128 ||
    new Set(source.files.map((f) => f.path)).size !== source.files.length ||
    source.files.some(
      (f) =>
        !closed(f, ["path", "bytes", "sha256"]) ||
        typeof f.path !== "string" ||
        !f.path.startsWith("infra/temporal-platform/") ||
        f.path.split("/").some((s) => !s || s === ".." || s === ".") ||
        !DIGEST.test(f.sha256) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 1 ||
        f.bytes > 4 * 1024 * 1024,
    ) ||
    source.sourceDigest !== sha256(JSON.stringify(source.files)) ||
    CONTRACTS.some((p) => !source.files.some((f) => f.path === p))
  )
    fail("ARTIFACT");
}

function nativeBinary(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 8 ||
    bytes.length > 512 * 1024 * 1024 ||
    !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
    !bytes.includes(
      Buffer.from("path\tglobal.local/temporal-platform-server/cmd/server\n"),
    )
  )
    fail("ARTIFACT");
}

export function artifactManifest(source, binary, buildInfo, apk, sbom) {
  try {
    validSource(source);
    nativeBinary(binary);
    if (
      !Buffer.isBuffer(buildInfo) ||
      !Buffer.isBuffer(apk) ||
      !Buffer.isBuffer(sbom) ||
      !Buffer.from(
        JSON.stringify(nativeSbom(source, binary, JSON.parse(buildInfo), apk)),
      ).equals(sbom)
    )
      fail("ARTIFACT");
    return {
      schemaVersion: "temporal-native-artifact/v1",
      sourceSha: source.sourceSha,
      sourceDigest: source.sourceDigest,
      upstreamImage: source.upstreamImage,
      files: source.files,
      binarySha256: sha256(binary),
      goBuildInfoSha256: sha256(buildInfo),
      apkInventorySha256: sha256(apk),
      sbomSha256: sha256(sbom),
    };
  } catch {
    return fail("ARTIFACT");
  }
}

export function verifyNativeArtifact(input) {
  try {
    const {
      expected,
      manifest,
      binary,
      inspect,
      imageId,
      inventory,
      contracts,
      buildInfo,
      apk,
      sbom,
    } = input;
    if (
      !equal(
        manifest,
        artifactManifest(expected, binary, buildInfo, apk, sbom),
      ) ||
      !DIGEST.test(imageId) ||
      inspect?.Id !== imageId
    )
      fail("ARTIFACT");
    const config = inspect.Config;
    if (
      config?.User !== "1000:1000" ||
      config.Entrypoint !== null ||
      !equal(config.Cmd, ["/etc/temporal/entrypoint.sh"]) ||
      config.Labels?.["org.opencontainers.image.revision"] !==
        expected.sourceSha ||
      config.Labels?.["io.global.temporal.native.source-digest"] !==
        expected.sourceDigest ||
      config.Labels?.["io.global.temporal.native.role"] !==
        "native-reader-authorization"
    )
      fail("ARTIFACT");
    if (typeof inventory !== "string" || inventory.length > 32 * 1024 * 1024)
      fail("ARTIFACT");
    const paths = inventory
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(/^\.\//, "").replace(/\/$/, ""))
      .filter((p) => p !== "" && p !== ".");
    if (
      paths.length > 200000 ||
      paths.some(
        (p) =>
          p.startsWith("/") ||
          p.includes("\\") ||
          p.includes("\0") ||
          p.split("/").some((s) => s === ".." || s === "." || !s) ||
          /(?:^|\/)(?:test-support|fixtures|__fixtures__|__tests__|tests|testing)(?:\/|$)/i.test(
            p,
          ) ||
          /(?:^|\/)test\//i.test(p) ||
          /(?:_test\.go|\.(?:spec|test)\.[cm]?[jt]s|native-entrypoint\.sh)$/i.test(
            p,
          ) ||
          p.startsWith("usr/local/go/"),
      )
    )
      fail("ARTIFACT");
    for (const required of [
      "usr/local/bin/temporal-server",
      "etc/temporal/entrypoint.sh",
      `${RELEASE}/manifest.json`,
      `${RELEASE}/config/temporal.yaml`,
      `${RELEASE}/config/dynamicconfig.yaml`,
      `${RELEASE}/roles.json`,
      `${RELEASE}/sbom.cdx.json`,
      `${RELEASE}/go-build-info.json`,
      "lib/apk/db/installed",
    ]) {
      if (!paths.includes(required)) fail("ARTIFACT");
    }
    for (const path of CONTRACTS) {
      const file = expected.files.find((f) => f.path === path);
      if (
        !Buffer.isBuffer(contracts?.[path]) ||
        contracts[path].length !== file.bytes ||
        sha256(contracts[path]) !== file.sha256
      )
        fail("ARTIFACT");
    }
    return Object.freeze({
      result: "PASS",
      sourceSha: expected.sourceSha,
      sourceDigest: expected.sourceDigest,
      binarySha256: manifest.binarySha256,
      sbomSha256: manifest.sbomSha256,
      imageId,
      artifactDigest: sha256(JSON.stringify(manifest)),
    });
  } catch {
    return fail("ARTIFACT");
  }
}

export function verifyNativeCompose(value, expected) {
  try {
    const reference = expected.imageReference;
    if (
      typeof reference !== "string" ||
      !reference.startsWith(NATIVE_IMAGE + "@") ||
      !DIGEST.test(reference.slice(NATIVE_IMAGE.length + 1)) ||
      !SHA.test(expected.sourceSha) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(expected.readerSubject)
    )
      fail("COMPOSE");
    const service = value?.services?.["temporal-platform"];
    if (
      !service ||
      service.image !== reference ||
      service.build ||
      service.entrypoint?.length ||
      service.privileged ||
      service.network_mode ||
      service.volumes_from ||
      service.cap_add?.length ||
      !equal(Object.keys(service.networks ?? {}), ["temporal-platform"]) ||
      value.networks?.["temporal-platform"]?.internal !== true ||
      service.user !== "1000:1000" ||
      !equal(service.command, ["/etc/temporal/entrypoint.sh"]) ||
      service.read_only !== true ||
      !equal(service.cap_drop, ["ALL"]) ||
      !service.security_opt?.includes("no-new-privileges:true") ||
      service.environment?.TEMPORAL_PLATFORM_READER_SUBJECT !==
        expected.readerSubject ||
      service.environment.TEMPORAL_ALLOW_NO_AUTH !== "false" ||
      service.environment.TEMPORAL_SERVER_CONFIG_FILE_PATH !==
        "/etc/temporal-platform/temporal.yaml" ||
      service.labels?.["io.global.temporal.native.source-sha"] !==
        expected.sourceSha
    )
      fail("COMPOSE");
    const ports = service.ports;
    if (
      !Array.isArray(ports) ||
      ports.length !== 1 ||
      ports[0].host_ip !== "127.0.0.1" ||
      ports[0].target !== 7233 ||
      ports[0].protocol !== "tcp" ||
      !/^[0-9]{2,5}$/.test(String(ports[0].published)) ||
      Number(ports[0].published) < 1024 ||
      Number(ports[0].published) > 65535 ||
      Number(ports[0].published) === 7233
    )
      fail("COMPOSE");
    const volumes = service.volumes;
    if (!Array.isArray(volumes) || volumes.length !== 3) fail("COMPOSE");
    const targets = [
      "/etc/temporal-platform/temporal.yaml",
      "/etc/temporal-platform/dynamicconfig.yaml",
      "/run/secrets/temporal-platform",
    ];
    if (!equal(volumes.map((v) => v.target).sort(), [...targets].sort()))
      fail("COMPOSE");
    for (const volume of volumes) {
      // Compose's canonical JSON omits an explicitly false create_host_path.
      // A short-syntax auto-creating bind renders true and remains forbidden.
      if (
        volume.type !== "bind" ||
        volume.read_only !== true ||
        !volume.bind ||
        ![undefined, false].includes(volume.bind.create_host_path) ||
        !isAbsolute(volume.source) ||
        volume.source === "/"
      )
        fail("COMPOSE");
      const index = targets.indexOf(volume.target);
      if (
        index < 2 &&
        volume.source !== resolve(expected.root, CONTRACTS[index])
      )
        fail("COMPOSE");
    }
    return Object.freeze({
      result: "PASS",
      imageReference: reference,
      sourceSha: expected.sourceSha,
      readerSubject: expected.readerSubject,
    });
  } catch {
    return fail("COMPOSE");
  }
}

async function jsonFile(path) {
  return JSON.parse((await boundedFile(path)).toString("utf8"));
}
export async function main(argv) {
  const [command, ...values] = argv;
  let result;
  if (command === "source" && values.length === 2)
    result = await sourceIdentity(values[0], values[1]);
  else if (command === "artifact" && values.length === 5)
    result = artifactManifest(
      await jsonFile(values[0]),
      await boundedFile(values[1], 512 * 1024 * 1024),
      await boundedFile(values[2]),
      await boundedFile(values[3], 8 * 1024 * 1024),
      await boundedFile(values[4]),
    );
  else if (command === "sbom" && values.length === 4) {
    result = nativeSbom(
      await jsonFile(values[0]),
      await boundedFile(values[1], 512 * 1024 * 1024),
      await jsonFile(values[2]),
      await boundedFile(values[3], 8 * 1024 * 1024),
    );
  } else if (command === "identity" && values.length === 3)
    result = nativeIdentity(...values);
  else if (command === "capture" && values.length === 4)
    result = await captureNativeImage(...values);
  else if (command === "verify" && values.length === 3) {
    const [expectedPath, directory, imageId] = values;
    const contracts = {};
    for (const path of CONTRACTS)
      contracts[path] = await boundedFile(
        join(directory, path.replace("infra/temporal-platform/", "")),
      );
    result = verifyNativeArtifact({
      expected: await jsonFile(expectedPath),
      manifest: await jsonFile(join(directory, "manifest.json")),
      binary: await boundedFile(
        join(directory, "temporal-server"),
        512 * 1024 * 1024,
      ),
      inspect: await jsonFile(join(directory, "inspect.json")),
      inventory: (
        await boundedFile(join(directory, "files.list"), 32 * 1024 * 1024)
      ).toString("utf8"),
      contracts,
      imageId,
      buildInfo: await boundedFile(join(directory, "go-build-info.json")),
      apk: await boundedFile(join(directory, "apk-installed"), 8 * 1024 * 1024),
      sbom: await boundedFile(join(directory, "sbom.cdx.json")),
    });
  } else if (command === "compose" && values.length === 5) {
    const [file, root, sourceSha, imageReference, readerSubject] = values;
    result = verifyNativeCompose(await jsonFile(file), {
      root,
      sourceSha,
      imageReference,
      readerSubject,
    });
  } else if (command === "provenance" && values.length === 4) {
    const [imageReference, sourceSha, imageId, configPath] = values;
    result = await verifyNativeProvenance({
      imageReference,
      sourceSha,
      imageId,
      configPath,
    });
  } else fail("ARGUMENT");
  process.stdout.write(
    JSON.stringify(result) +
      (["sbom", "artifact"].includes(command) ? "" : "\n"),
  );
  return result;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch(() => {
    console.error("TEMPORAL_NATIVE_PUBLICATION_INVALID");
    process.exitCode = 1;
  });
}
