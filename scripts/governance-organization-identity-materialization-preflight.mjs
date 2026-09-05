import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonBytes,
  renderRootWrapper,
} from "./governance-organization-identity-launcher.mjs";

const LIMIT = 128 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hold = (code) => ({ status: "HOLD", code });
const facts = (extra = {}) => ({ status: "LOCAL_FACTS_VERIFIED", ...extra });
const normalized = (p) =>
  typeof p === "string" && path.isAbsolute(p) && path.normalize(p) === p;
const inside = (root, p) =>
  normalized(root) && root !== "/" && p.startsWith(`${root}/`);
const same = (a, b) =>
  [
    "dev",
    "ino",
    "uid",
    "gid",
    "mode",
    "nlink",
    "size",
    "mtimeNs",
    "ctimeNs",
  ].every((key) => a[key] === b[key]);

// This is a bounded observation, not a lease over subsequent filesystem use.
export function observeMaterializationBytes(filePath, roots, role = null) {
  if (
    !normalized(filePath) ||
    !Array.isArray(roots) ||
    !roots.some((root) => inside(root, filePath))
  )
    throw Error("SOURCE_ROOT_INVALID");
  if (realpathSync(filePath) !== filePath) throw Error("SOURCE_SYMLINK");
  let fd;
  try {
    fd = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(fd, { bigint: true });
    const systemEnv =
      role === "ENV" &&
      filePath === "/usr/lib/cargo/bin/coreutils/env" &&
      roots.includes("/usr/lib/cargo/bin/coreutils") &&
      before.uid === 0n &&
      before.gid === 0n &&
      (before.mode & 0o022n) === 0n;
    if (systemEnv) {
      for (
        let parent = path.dirname(filePath);
        parent !== "/";
        parent = path.dirname(parent)
      ) {
        const stat = lstatSync(parent);
        if (
          !stat.isDirectory() ||
          stat.uid !== 0 ||
          stat.gid !== 0 ||
          stat.mode & 0o022
        )
          throw Error("SOURCE_PARENT_UNSAFE");
      }
    }
    if (
      !before.isFile() ||
      (before.nlink !== 1n && !systemEnv) ||
      before.size <= 0n ||
      before.size > BigInt(LIMIT)
    )
      throw Error("SOURCE_NOT_BOUNDED_REGULAR_FILE");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error("SOURCE_DRIFT");
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (
      readSync(fd, extra, 0, 1, offset) !== 0 ||
      !same(before, fstatSync(fd, { bigint: true })) ||
      !same(before, lstatSync(filePath, { bigint: true })) ||
      realpathSync(filePath) !== filePath
    )
      throw Error("SOURCE_DRIFT");
    return {
      bytes,
      sha256: hash(bytes),
      size: bytes.length,
      mode: Number(before.mode & 0o7777n),
      observation: Object.fromEntries(
        [
          "dev",
          "ino",
          "uid",
          "gid",
          "nlink",
          "size",
          "mode",
          "mtimeNs",
          "ctimeNs",
        ].map((key) => [key, String(before[key])]),
      ),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const observe = observeMaterializationBytes;

export function verifyMaterializationFile(filePath, expected, roots) {
  try {
    if (
      !expected ||
      !HASH.test(expected.sha256) ||
      !Number.isSafeInteger(expected.size) ||
      !Number.isInteger(expected.mode)
    )
      return hold("SOURCE_IDENTITY_INVALID");
    const observed = observe(filePath, roots);
    if (
      ["sha256", "size", "mode"].some((key) => observed[key] !== expected[key])
    )
      return hold("SOURCE_FACTS_MISMATCH");
    return facts({
      sha256: observed.sha256,
      size: observed.size,
      mode: observed.mode,
    });
  } catch {
    return hold("SOURCE_UNAVAILABLE_OR_UNSAFE");
  }
}

export function materializationGit(repo, args) {
  return execFileSync(
    "git",
    ["--no-pager", "--no-replace-objects", "-C", repo, ...args],
    {
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
      timeout: 10000,
      maxBuffer: LIMIT,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
}

const git = materializationGit;

export function verifyMaterializationGitIdentity(repo, relativePath, identity) {
  try {
    if (
      !normalized(repo) ||
      realpathSync(repo) !== repo ||
      typeof relativePath !== "string" ||
      path.isAbsolute(relativePath) ||
      path.normalize(relativePath) !== relativePath ||
      relativePath.startsWith("..") ||
      !COMMIT.test(identity?.commit) ||
      !COMMIT.test(identity?.blobId) ||
      !HASH.test(identity?.sha256)
    )
      return hold("GENERATOR_IDENTITY_INVALID");
    const object = `${identity.commit}:${relativePath}`;
    const blobId = git(repo, ["rev-parse", "--verify", object])
      .toString()
      .trim();
    const bytes = git(repo, ["cat-file", "blob", object]);
    if (
      blobId !== identity.blobId ||
      hash(bytes) !== identity.sha256 ||
      bytes.length !== identity.size
    )
      return hold("EXECUTING_GENERATOR_MISMATCH");
    const observed = observe(path.join(repo, relativePath), [repo]);
    if (observed.sha256 !== identity.sha256 || observed.size !== identity.size)
      return hold("EXECUTING_GENERATOR_MISMATCH");
    const tree = git(repo, [
      "ls-tree",
      identity.commit,
      "--",
      relativePath,
    ]).toString();
    if (
      !(tree.startsWith("100644 ") || tree.startsWith("100755 ")) ||
      Boolean(observed.mode & 0o111) !== tree.startsWith("100755 ")
    )
      return hold("GENERATOR_MODE_MISMATCH");
    if (
      git(repo, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        relativePath,
      ]).length
    )
      return hold("GENERATOR_WORKTREE_DIRTY");
    return facts({ blobId, sha256: observed.sha256, size: observed.size });
  } catch {
    return hold("GENERATOR_IDENTITY_UNAVAILABLE");
  }
}

export function verifyMaterializationDestinations(destinations) {
  try {
    if (
      !Array.isArray(destinations) ||
      !destinations.length ||
      new Set(destinations).size !== destinations.length
    )
      return hold("ROOT_DESTINATIONS_INVALID");
    for (const destination of destinations) {
      if (!normalized(destination) || destination === "/")
        return hold("ROOT_DESTINATIONS_INVALID");
      try {
        lstatSync(destination);
        return hold("ROOT_DESTINATION_EXISTS");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      let parent = path.dirname(destination);
      while (parent !== "/") {
        try {
          if (
            !lstatSync(parent).isDirectory() ||
            realpathSync(parent) !== parent
          )
            return hold("ROOT_PARENT_UNSAFE");
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        parent = path.dirname(parent);
      }
    }
    return facts();
  } catch {
    return hold("ROOT_DESTINATIONS_UNAVAILABLE");
  }
}

export function verifyMaterializationOutput(repo, outputPath) {
  try {
    if (
      !normalized(outputPath) ||
      !inside(repo, outputPath) ||
      outputPath.startsWith("/global/backups/")
    )
      return hold("PACKET_OUTPUT_PATH_INVALID");
    const absent = verifyMaterializationDestinations([outputPath]);
    if (absent.status !== "LOCAL_FACTS_VERIFIED") return absent;
    if (realpathSync(path.dirname(outputPath)) !== path.dirname(outputPath))
      return hold("PACKET_OUTPUT_PARENT_UNSAFE");
    git(repo, ["check-ignore", "--quiet", "--", outputPath]);
    return facts();
  } catch {
    return hold("PACKET_OUTPUT_NOT_IGNORED_OR_UNAVAILABLE");
  }
}

const REVIEW_SCOPE = [
  "SOURCE_BYTES",
  "GENERATOR_CLOSURE",
  "PLANNED_BYTES",
  "ROOT_DESTINATIONS",
  "WHOLE_PACKET",
];
export function verifyMaterializationReview(descriptor, subjects, roots) {
  try {
    const checked = verifyMaterializationFile(
      descriptor?.path,
      descriptor,
      roots,
    );
    if (checked.status !== "LOCAL_FACTS_VERIFIED")
      return hold("REVIEW_BYTES_UNAVAILABLE_OR_MISMATCH");
    const observed = observe(descriptor.path, roots);
    if (observed.sha256 !== descriptor.sha256)
      return hold("REVIEW_BYTES_DRIFT");
    const report = JSON.parse(observed.bytes);
    if (
      report.schemaVersion !== "materialization-local-review-declaration/v1" ||
      report.verdict !== "PASS" ||
      report.critical !== 0 ||
      report.important !== 0
    )
      return hold("REVIEW_DECLARATION_INVALID");
    if (
      !Array.isArray(report.scope) ||
      report.scope.length !== REVIEW_SCOPE.length ||
      REVIEW_SCOPE.some((scope) => !report.scope.includes(scope))
    )
      return hold("REVIEW_SCOPE_INCOMPLETE");
    if (
      !subjects ||
      Object.keys(subjects).length === 0 ||
      Object.keys(subjects).length !==
        Object.keys(report.subjects ?? {}).length ||
      Object.entries(subjects).some(
        ([key, value]) => !HASH.test(value) || report.subjects[key] !== value,
      )
    )
      return hold("REVIEW_SUBJECT_MISMATCH");
    return facts({
      authority: "LOCAL_REVIEW_DECLARATION_ONLY",
      reportSha256: observed.sha256,
    });
  } catch {
    return hold("REVIEW_DECLARATION_UNAVAILABLE");
  }
}

const RUNNING_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GENERATOR =
  "scripts/governance-organization-identity-root-materialization-packet.mjs";
const PREFLIGHT =
  "scripts/governance-organization-identity-materialization-preflight.mjs";
const LAUNCHER = "scripts/governance-organization-identity-launcher.mjs";

export function verifyMaterializationPlannedFile(planned, bytes, mode) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > LIMIT ||
    planned?.sha256 !== hash(bytes) ||
    planned?.size !== bytes.length ||
    planned?.mode !== mode
  )
    return hold("PLANNED_BYTES_MISMATCH");
  return facts({ sha256: hash(bytes), size: bytes.length, mode });
}

function checkPlannedBytes(packet) {
  try {
    const artifacts = packet.approvedArtifacts;
    const approvedBytes = (prefix, relative) => {
      if (!COMMIT.test(artifacts?.[`${prefix}Commit`]))
        throw Error("INVALID_COMMIT");
      const object = `${artifacts[`${prefix}Commit`]}:${relative}`;
      const bytes = git(RUNNING_ROOT, ["cat-file", "blob", object]);
      if (
        hash(bytes) !== artifacts[`${prefix}Sha256`] ||
        bytes.length !== artifacts[`${prefix}Size`] ||
        git(RUNNING_ROOT, ["rev-parse", object]).toString().trim() !==
          artifacts[`${prefix}BlobId`]
      )
        throw Error("APPROVED_BYTES_MISMATCH");
      return bytes;
    };
    const wrapper = Buffer.from(
      renderRootWrapper({
        envPath: `${packet.toolRoot}/bin/env`,
        environment: packet.runtimeEnvironment,
        nodePath: `${packet.toolRoot}/bin/node`,
        launcherPath: `${packet.launcherRoot}/identity-writer-launch.mjs`,
      }),
    );
    const plans = [
      [packet.launcherFilePlan?.[0], wrapper, 0o500],
      [
        packet.launcherFilePlan?.[1],
        approvedBytes("launcher", LAUNCHER),
        0o500,
      ],
      [
        packet.bootstrapFilePlan,
        approvedBytes(
          "bootstrap",
          "scripts/governance-organization-identity-bootstrap.mjs",
        ),
        0o500,
      ],
      [
        packet.contractFilePlan,
        canonicalJsonBytes(packet.launcherContract),
        0o600,
      ],
    ];
    for (const args of plans) {
      const checked = verifyMaterializationPlannedFile(...args);
      if (checked.status !== "LOCAL_FACTS_VERIFIED") return checked;
    }
    return facts();
  } catch {
    return hold("PLANNED_BYTES_UNAVAILABLE");
  }
}

// Fixed dependency list: stdlib plus launcher and this helper. Newly introduced
// executable dependencies must be added here and reviewed in the next Phase A.
export function inspectMaterializationPacketFacts(packet) {
  if (
    !Array.isArray(packet?.sourceToolClosure) ||
    packet.sourceToolClosure.length !== 7
  )
    return hold("SOURCE_CLOSURE_INVALID");
  for (const source of packet.sourceToolClosure) {
    const file = source.sourceExecutablePath;
    if (!normalized(file)) return hold("SOURCE_ROOT_INVALID");
    const checked = verifyMaterializationFile(
      file,
      {
        sha256: source.sourceSha256,
        size: source.sourceSize,
        mode: source.sourceMode,
      },
      [path.dirname(file)],
    );
    if (checked.status !== "LOCAL_FACTS_VERIFIED") return checked;
    if (
      hash(file) !== source.sourceExecutablePathSha256 ||
      hash(realpathSync(file)) !== source.sourceRealpathSha256
    )
      return hold("SOURCE_PATH_PROVENANCE_MISMATCH");
  }
  const planned = checkPlannedBytes(packet);
  if (planned.status !== "LOCAL_FACTS_VERIFIED") return planned;
  const artifacts = packet.approvedArtifacts;
  const identity = (prefix) =>
    Object.fromEntries(
      ["commit", "blobId", "sha256", "size"].map((key) => [
        key,
        artifacts?.[`${prefix}${key[0].toUpperCase()}${key.slice(1)}`],
      ]),
    );
  const generator = verifyMaterializationGitIdentity(
    RUNNING_ROOT,
    GENERATOR,
    identity("generator"),
  );
  if (generator.status !== "LOCAL_FACTS_VERIFIED") return generator;
  // Helper identity derives from the declared generator commit, avoiding a self
  // hash or a future commit constant in executable code.
  for (const relative of [
    PREFLIGHT,
    LAUNCHER,
    "scripts/governance-organization-identity-materialization-preflight.spec.mjs",
    "scripts/governance-organization-identity-root-materialization-packet.spec.mjs",
  ]) {
    try {
      const object = `${artifacts.generatorCommit}:${relative}`;
      const bytes = git(RUNNING_ROOT, ["cat-file", "blob", object]);
      const checked = verifyMaterializationGitIdentity(RUNNING_ROOT, relative, {
        commit: artifacts.generatorCommit,
        blobId: git(RUNNING_ROOT, ["rev-parse", object]).toString().trim(),
        sha256: hash(bytes),
        size: bytes.length,
      });
      if (checked.status !== "LOCAL_FACTS_VERIFIED") return checked;
    } catch {
      return hold("GENERATOR_DEPENDENCY_IDENTITY_UNAVAILABLE");
    }
  }
  const roots = verifyMaterializationDestinations([
    packet.launcherRoot,
    packet.toolRoot,
    packet.runtimeRoot,
    packet.requestRoot,
    packet.outputRoot,
  ]);
  if (roots.status !== "LOCAL_FACTS_VERIFIED") return roots;
  // v4 carries digest-only review identities and no complete reviewed-byte
  // subjects. It cannot express the evidence necessary for admission. Do not
  // fill those identities from a candidate or adapt a narrow reviewer PASS.
  return hold("FULL_REVIEW_BYTE_REFERENCES_REQUIRED");
}

export const MATERIALIZATION_RUNNING_ROOT = RUNNING_ROOT;

// Linux directory-fd anchored creation prevents a replaced path parent from
// redirecting the write. Drift after creation retains the failed evidence.
export function writeExclusiveMaterializationOutput(
  repo,
  outputPath,
  value,
  revalidate,
) {
  const requireFact = (ok, code) => {
    if (!ok) throw Error(code);
  };
  requireFact(
    verifyMaterializationOutput(repo, outputPath).status ===
      "LOCAL_FACTS_VERIFIED",
    "OUTPUT_NOT_ABSENT_IGNORED",
  );
  const parentPath = path.dirname(outputPath);
  const fd = openSync(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let output;
  try {
    const before = fstatSync(fd, { bigint: true });
    const parentStable = () => {
      const after = lstatSync(parentPath, { bigint: true });
      requireFact(
        realpathSync(parentPath) === parentPath &&
          ["dev", "ino", "mode", "uid", "gid"].every(
            (key) => before[key] === after[key],
          ),
        "OUTPUT_PARENT_DRIFT",
      );
    };
    revalidate();
    parentStable();
    output = openSync(
      `/proc/self/fd/${fd}/${path.basename(outputPath)}`,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    parentStable();
    const bytes = canonicalJsonBytes(value);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(output, bytes, offset, bytes.length - offset);
      requireFact(written > 0, "OUTPUT_WRITE_FAILED");
      offset += written;
    }
    fsyncSync(output);
    const st = fstatSync(output);
    requireFact(
      st.isFile() &&
        st.nlink === 1 &&
        st.uid === process.getuid() &&
        st.gid === process.getgid() &&
        (st.mode & 0o7777) === 0o600,
      "OUTPUT_METADATA_INVALID",
    );
    fsyncSync(fd);
    parentStable();
    const readback = observeMaterializationBytes(outputPath, [repo]);
    requireFact(
      readback.sha256 === hash(bytes) &&
        readback.observation.ino === String(st.ino) &&
        readback.observation.dev === String(st.dev),
      "OUTPUT_READBACK_MISMATCH",
    );
    revalidate();
    parentStable();
    return { outputPath, sha256: hash(bytes), size: bytes.length, mode: 0o600 };
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(fd);
  }
}

export function buildDiagnosticLauncherMaterializationPacketReviewReceipt(
  fields,
) {
  return {
    schemaVersion:
      "organization-identity-launcher-materialization-packet-review/v1",
    launcherMaterializationPacketSha256:
      fields.launcherMaterializationPacketSha256,
    generatorCommit: fields.generatorCommit,
    generatorBlobId: fields.generatorBlobId,
    generatorSha256: fields.generatorSha256,
    generatorSpecCommit: fields.generatorSpecCommit,
    generatorSpecBlobId: fields.generatorSpecBlobId,
    generatorSpecSha256: fields.generatorSpecSha256,
    reportSha256: fields.reportSha256,
    counterexampleSetSha256: fields.counterexampleSetSha256,
    reviewerClass: "INDEPENDENT_ROOT_MATERIALIZATION_PACKET_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
}

export function rootScope(request) {
  return {
    authorizationClass: request.authorizationClass,
    subjectCommit: request.subjectCommit,
    launcherMaterializationPacketSha256:
      request.launcherMaterializationPacketSha256,
    launcherMaterializationPacketReviewReceiptSha256:
      request.launcherMaterializationPacketReviewReceiptSha256,
    launcherContractSha256: request.launcherContractSha256,
    sourceToolClosureSha256: request.sourceToolClosureSha256,
    materializedExecutableClosureSha256:
      request.materializedExecutableClosureSha256,
    launcherFileCount: request.launcherFileCount,
    toolRootFileCount: request.toolRootFileCount,
    runtimeRootCount: request.runtimeRootCount,
    requestRootCount: request.requestRootCount,
    outputRootCount: request.outputRootCount,
    launcherRoot: request.launcherRoot,
    toolRoot: request.toolRoot,
    runtimeRoot: request.runtimeRoot,
    requestRoot: request.requestRoot,
    outputRoot: request.outputRoot,
    chronology: request.chronology,
    targetMustBeAbsent: request.targetMustBeAbsent,
    containsCredentialValue: request.containsCredentialValue,
  };
}

export function requestIdFor(request) {
  const { requestId, ...withoutRequestId } = request;
  return hash(canonicalJsonBytes(withoutRequestId));
}

export function buildDiagnosticRootRequest(
  fields,
  packetValidation,
  chronology,
) {
  const packet = fields.launcherMaterializationPacket;
  const validPacket = packetValidation.status === "PASS" ? packet : null;
  const request = {
    schemaVersion: "organization-identity-root-materialization-request/v1",
    requestId: "",
    authorizationClass: "LOCAL_ROOT_MATERIALIZATION",
    subjectCommit: validPacket?.subjectCommit,
    launcherMaterializationPacketPath: fields.launcherMaterializationPacketPath,
    launcherMaterializationPacketSha256:
      packetValidation.launcherMaterializationPacketSha256,
    launcherMaterializationPacketReviewReceiptPath:
      fields.launcherMaterializationPacketReviewReceiptPath,
    launcherMaterializationPacketReviewReceiptSha256:
      fields.launcherMaterializationPacketReviewReceiptSha256,
    launcherContractSha256: validPacket?.launcherContractSha256,
    sourceToolClosureSha256: validPacket?.sourceToolClosureSha256,
    materializedExecutableClosureSha256:
      validPacket?.materializedExecutableClosureSha256,
    launcherFileCount: 4,
    toolRootFileCount: 7,
    runtimeRootCount: 7,
    requestRootCount: 1,
    outputRootCount: 1,
    launcherRoot: fields.launcherRoot,
    toolRoot: fields.toolRoot,
    runtimeRoot: fields.runtimeRoot,
    requestRoot: fields.requestRoot,
    outputRoot: fields.outputRoot,
    chronology,
    targetMustBeAbsent: true,
    containsCredentialValue: false,
    scopeSha256: "",
  };
  request.scopeSha256 = hash(canonicalJsonBytes(rootScope(request)));
  request.requestId = requestIdFor(request);
  return request;
}
