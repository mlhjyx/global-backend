import { createHash } from "node:crypto";
import {
  APPROVED_PLAN,
  APPROVED_SPEC,
  canonicalJsonBytes,
  computeLauncherContractDigests,
  verifyLauncherContract,
} from "./governance-organization-identity-launcher.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_ID = /^[0-9a-f]{40}$/;
const ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2";
const LAUNCHER_ROOT = `${ROOT}/launcher`;
const TOOL_ROOT = `${ROOT}/tool-root`;
const RUNTIME_ROOT = `${ROOT}/runtime`;
const REQUEST_ROOT = `${ROOT}/requests`;
const OUTPUT_ROOT = `${ROOT}/outputs`;
const PLAN_PATH =
  "docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md";
const SPEC_PATH =
  "docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md";
const LAUNCHER_PATH = "scripts/governance-organization-identity-launcher.mjs";
const BOOTSTRAP_PATH = "scripts/governance-organization-identity-bootstrap.mjs";
const BOOTSTRAP_CONTRACT_PATH =
  "docs/governance/organization-identity-bootstrap-contract.json";
const GENERATOR_PATH =
  "scripts/governance-organization-identity-root-materialization-packet.mjs";
const GENERATOR_SPEC_PATH =
  "scripts/governance-organization-identity-root-materialization-packet.spec.mjs";
const ROLES = Object.freeze([
  ["ENV", "bin/env", 0o500],
  ["NODE", "bin/node", 0o500],
  ["GIT", "bin/git", 0o500],
  ["COREPACK_SHIM", "lib/corepack/dist/corepack.js", 0o400],
  ["COREPACK_LIB_COREPACK_CJS", "lib/corepack/dist/lib/corepack.cjs", 0o400],
  ["PNPM_SHIM", "lib/pnpm/9.15.9/bin/pnpm.cjs", 0o400],
  ["PNPM_ENTRYPOINT", "lib/pnpm/9.15.9/dist/pnpm.cjs", 0o400],
]);
const CHRONOLOGY = Object.freeze([
  "VERIFY_SOURCE_TOOL_CLOSURE",
  "COPY_AND_FSYNC_LAUNCHER_FILES",
  "COPY_AND_FSYNC_MATERIALIZED_EXECUTABLE_CLOSURE",
  "CREATE_AND_FSYNC_RUNTIME_ROOTS",
  "CREATE_AND_FSYNC_REQUEST_OUTPUT_ROOTS",
  "INDEPENDENT_READBACK",
  "MATERIALIZATION_RECEIPT",
  "MATERIALIZATION_REVIEW",
]);
const PACKET_KEYS = Object.freeze([
  "schemaVersion",
  "subjectCommit",
  "launcherContract",
  "launcherContractSha256",
  "approvedArtifacts",
  "launcherFileCount",
  "toolRootFileCount",
  "runtimeRootCount",
  "requestRootCount",
  "outputRootCount",
  "launcherRoot",
  "toolRoot",
  "runtimeRoot",
  "requestRoot",
  "outputRoot",
  "sourceToolClosure",
  "materializedExecutableClosure",
  "launcherFilePlan",
  "bootstrapFilePlan",
  "contractFilePlan",
  "runtimeRootPlan",
  "runtimeEnvironment",
  "rootPreflight",
  "reviewIdentities",
  "chronology",
  "symlinkPolicy",
  "rollbackPolicy",
  "compatibilityStatus",
  "result",
]);

function pass(extra = {}) {
  return { status: "PASS", ...extra };
}

function integrity(code) {
  return { status: "INTEGRITY_ERROR", code };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha(value) {
  return typeof value === "string" && SHA256.test(value);
}

function isCommit(value) {
  return typeof value === "string" && GIT_ID.test(value);
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function pathSha(value) {
  return sha256(Buffer.from(value, "utf8"));
}

function hex(index) {
  return "123456789abcdef"[index].repeat(64);
}

function plannedFile(basename, mode, sha = hex(0), size = 1) {
  return {
    basename,
    relativePath: basename,
    mode,
    realpathPathSha256: pathSha(`${LAUNCHER_ROOT}/${basename}`),
    sha256: sha,
    size,
  };
}

function runtimeRootPlan() {
  return [
    "runtime",
    "home",
    "xdg-config",
    "xdg-cache",
    "corepack-home",
    "pnpm-home",
    "tmp",
  ].map((basename) => ({
    basename,
    absolutePath:
      basename === "runtime" ? RUNTIME_ROOT : `${RUNTIME_ROOT}/${basename}`,
    mode: 0o700,
    realpathPathSha256: pathSha(
      basename === "runtime" ? RUNTIME_ROOT : `${RUNTIME_ROOT}/${basename}`,
    ),
  }));
}

function runtimeEnvironment() {
  return {
    PATH: `${TOOL_ROOT}/bin`,
    HOME: `${RUNTIME_ROOT}/home`,
    XDG_CONFIG_HOME: `${RUNTIME_ROOT}/xdg-config`,
    XDG_CACHE_HOME: `${RUNTIME_ROOT}/xdg-cache`,
    COREPACK_HOME: `${RUNTIME_ROOT}/corepack-home`,
    PNPM_HOME: `${RUNTIME_ROOT}/pnpm-home`,
    TMPDIR: `${RUNTIME_ROOT}/tmp`,
    NPM_CONFIG_USERCONFIG: "/dev/null",
    CI: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

function sourceToolClosure(overrides = {}) {
  return ROLES.map(([role], index) => ({
    role,
    logicalIdentity: `${role.toLowerCase()}@resolved`,
    sourceExecutablePath: `/resolved-tools/${role.toLowerCase()}`,
    sourceExecutablePathSha256: pathSha(
      `/resolved-tools/${role.toLowerCase()}`,
    ),
    sourceRealpathSha256: pathSha(`/resolved-tools/${role.toLowerCase()}`),
    sourceSha256: hex(index),
    sourceSize: 100 + index,
    sourceMode: index < 3 ? 0o755 : 0o644,
    sourcePathPolicy: "RESOLVED_REGULAR_FILE_ONLY",
    ...overrides[role],
  }));
}

function materializedExecutableClosure(sourceClosure = sourceToolClosure()) {
  return ROLES.map(([role, relativePath, mode], index) => {
    const source = sourceClosure[index];
    const destination = `${TOOL_ROOT}/${relativePath}`;
    return {
      role,
      logicalIdentity: source.logicalIdentity,
      destinationExecutablePath: destination,
      destinationExecutablePathSha256: pathSha(destination),
      mode,
      sha256: source.sourceSha256,
      size: source.sourceSize,
      destinationRoot: "TOOL_ROOT",
      destinationPathKind: "REGULAR_FILE",
    };
  });
}

function approvedArtifacts(subjectCommit) {
  return {
    planCommit: APPROVED_PLAN.commit,
    planBlobId: APPROVED_PLAN.blobId,
    planSha256: APPROVED_PLAN.sha256,
    planSize: 1,
    specCommit: APPROVED_SPEC.commit,
    specBlobId: APPROVED_SPEC.blobId,
    specSha256: APPROVED_SPEC.sha256,
    specSize: 1,
    launcherCommit: subjectCommit,
    launcherBlobId: "4".repeat(40),
    launcherSha256: hex(9),
    launcherSize: 1,
    bootstrapCommit: subjectCommit,
    bootstrapBlobId: "5".repeat(40),
    bootstrapSha256: hex(10),
    bootstrapSize: 1,
    bootstrapContractCommit: subjectCommit,
    bootstrapContractBlobId: "6".repeat(40),
    bootstrapContractSha256: hex(11),
    bootstrapContractSize: 1,
    generatorCommit: subjectCommit,
    generatorBlobId: "7".repeat(40),
    generatorSha256: hex(12),
    generatorSize: 1,
    generatorSpecCommit: subjectCommit,
    generatorSpecBlobId: "8".repeat(40),
    generatorSpecSha256: hex(13),
    generatorSpecSize: 1,
  };
}

function launcherContract(subjectCommit, sourceClosure) {
  return {
    schemaVersion: "organization-identity-launcher-contract/v3",
    rootDirectory: LAUNCHER_ROOT,
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    toolRoot: TOOL_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    rootPolicy: {
      ownerUid: 0,
      ownerGid: 0,
      launcherDirectoryMode: 0o700,
      requestRootMode: 0o700,
      outputRootMode: 0o700,
      runtimeRootMode: 0o700,
      requestRecordMode: 0o600,
      outputRecordMode: 0o600,
      createExclusive: true,
      rejectSymlink: true,
    },
    toolRootPolicy: {
      ownerUid: 0,
      ownerGid: 0,
      directoryMode: 0o700,
      binaryMode: 0o500,
      javascriptMode: 0o400,
      createExclusive: true,
      rejectSymlink: true,
      rejectHardlink: true,
      copyResolvedRegularFilesOnly: true,
    },
    runtimeRootPolicy: {
      ownerUid: 0,
      ownerGid: 0,
      directoryMode: 0o700,
      createExclusive: true,
      rejectSymlink: true,
      rejectHardlink: true,
    },
    approvedPlan: { ...APPROVED_PLAN },
    approvedSpec: { ...APPROVED_SPEC },
    approvedLauncher: {
      path: LAUNCHER_PATH,
      commit: subjectCommit,
      blobId: "4".repeat(40),
      sha256: hex(9),
    },
    launcherFilePlan: [
      plannedFile("identity-writer-launch", 0o500, hex(8)),
      plannedFile("identity-writer-launch.mjs", 0o500, hex(9)),
    ],
    contractFilePlan: {
      basename: "launcher-contract.json",
      relativePath: "launcher-contract.json",
      mode: 0o600,
      realpathPathSha256: pathSha(`${LAUNCHER_ROOT}/launcher-contract.json`),
      selfDigestExcluded: true,
    },
    materializedExecutableClosure: materializedExecutableClosure(sourceClosure),
    runtimeEnvironment: runtimeEnvironment(),
    runtimeRootPlan: runtimeRootPlan(),
    commandIds: [
      "BOOTSTRAP_AUTHORITY_RUN_V1",
      "SCOPED_REVIEW_VERIFY_V1",
      "CURRENT_MAIN_AUDIT_LOCAL_V1",
      "CURRENT_MAIN_VALIDATE_V1",
      "CURRENT_MAIN_GENERATE_V1",
      "COPY_WRITE_ELIGIBILITY_V1",
      "COPY_SYNC_CITATIONS_V1",
      "GIT_REFRESH_START_V1",
      "GIT_REFRESH_COMMIT_V1",
      "GIT_ADMISSION_COMMIT_V1",
      "GIT_ACCEPTANCE_COMMIT_V1",
      "REFRESH_VERIFY_V1",
      "MIGRATION_STATIC_VERIFY_V1",
      "PRISMA_GENERATE_V1",
      "SCANNER_TEST_V1",
      "SCANNER_BASELINE_V1",
      "SCANNER_STAGE_V1",
      "SCANNER_ZERO_V1",
      "SCANNER_ACCEPTANCE_V1",
      "GOVERNANCE_VERIFY_V1",
      "DOCS_VERIFY_V1",
      "API_VERIFY_V1",
      "RUNTIME_ARTIFACT_VERIFY_V1",
      "CONTRACT_GRAPH_VERIFY_V1",
      "V3_WORKTREE_CREATE_V1",
    ],
    ...computeLauncherContractDigests(),
  };
}

export function buildLauncherMaterializationPacket(options = {}) {
  const subjectCommit = options.subjectCommit ?? "1".repeat(40);
  const sources = options.sourceToolClosure ?? sourceToolClosure();
  const contract =
    options.launcherContract ?? launcherContract(subjectCommit, sources);
  const contractBytes = canonicalJsonBytes(contract);
  const contractSha = sha256(contractBytes);
  const packet = {
    schemaVersion: "organization-identity-launcher-materialization-packet/v4",
    subjectCommit,
    launcherContract: contract,
    launcherContractSha256: contractSha,
    approvedArtifacts: approvedArtifacts(subjectCommit),
    launcherFileCount: 4,
    toolRootFileCount: 7,
    runtimeRootCount: 7,
    requestRootCount: 1,
    outputRootCount: 1,
    launcherRoot: LAUNCHER_ROOT,
    toolRoot: TOOL_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    sourceToolClosure: sources,
    materializedExecutableClosure: contract.materializedExecutableClosure,
    launcherFilePlan: contract.launcherFilePlan,
    bootstrapFilePlan: plannedFile(
      "identity-writer-bootstrap.mjs",
      0o500,
      hex(10),
    ),
    contractFilePlan: {
      ...contract.contractFilePlan,
      sha256: contractSha,
      size: contractBytes.length,
    },
    runtimeRootPlan: contract.runtimeRootPlan,
    runtimeEnvironment: contract.runtimeEnvironment,
    rootPreflight: {
      launcherRootState: "ABSENT",
      toolRootState: "ABSENT",
      runtimeRootState: "ABSENT",
      requestRootState: "ABSENT",
      outputRootState: "ABSENT",
      ownerUid: 0,
      ownerGid: 0,
    },
    reviewIdentities: {
      authorityModelPlanReviewSha256: hex(1),
      task0LFinalCodeReviewSha256: hex(2),
      task0PFinalReviewSha256: hex(3),
    },
    chronology: CHRONOLOGY,
    symlinkPolicy: "NO_LIVE_SYMLINK_RUNTIME_DEPENDENCE",
    rollbackPolicy: "CREATE_ONLY_PRESERVE_EVIDENCE_AND_REAUTHORIZE",
    compatibilityStatus:
      "HISTORICAL_V2_V3_PACKET_MODELS_HOLD_NOT_AUTHORITY_COMPATIBLE",
    result: "AUTH_REQUIRED",
    ...options.overrides,
  };
  return packet;
}

function validateApprovedArtifacts(artifacts) {
  const keys = [
    "planCommit",
    "planBlobId",
    "planSha256",
    "planSize",
    "specCommit",
    "specBlobId",
    "specSha256",
    "specSize",
    "launcherCommit",
    "launcherBlobId",
    "launcherSha256",
    "launcherSize",
    "bootstrapCommit",
    "bootstrapBlobId",
    "bootstrapSha256",
    "bootstrapSize",
    "bootstrapContractCommit",
    "bootstrapContractBlobId",
    "bootstrapContractSha256",
    "bootstrapContractSize",
    "generatorCommit",
    "generatorBlobId",
    "generatorSha256",
    "generatorSize",
    "generatorSpecCommit",
    "generatorSpecBlobId",
    "generatorSpecSha256",
    "generatorSpecSize",
  ];
  if (!exactKeys(artifacts, keys)) return false;
  for (const key of keys.filter((key) => key.endsWith("Commit"))) {
    if (!isCommit(artifacts[key])) return false;
  }
  for (const key of keys.filter((key) => key.endsWith("BlobId"))) {
    if (!GIT_ID.test(artifacts[key])) return false;
  }
  for (const key of keys.filter((key) => key.endsWith("Sha256"))) {
    if (!isSha(artifacts[key])) return false;
  }
  return (
    artifacts.planCommit === APPROVED_PLAN.commit &&
    artifacts.planBlobId === APPROVED_PLAN.blobId &&
    artifacts.planSha256 === APPROVED_PLAN.sha256 &&
    artifacts.specCommit === APPROVED_SPEC.commit &&
    artifacts.specBlobId === APPROVED_SPEC.blobId &&
    artifacts.specSha256 === APPROVED_SPEC.sha256 &&
    keys
      .filter((key) => key.endsWith("Size"))
      .every(
        (key) => Number.isSafeInteger(artifacts[key]) && artifacts[key] > 0,
      )
  );
}

function validateSourceClosure(sourceClosure, destinationClosure) {
  if (!Array.isArray(sourceClosure) || sourceClosure.length !== ROLES.length)
    return false;
  return sourceClosure.every((source, index) => {
    const [role] = ROLES[index];
    const destination = destinationClosure?.[index];
    return (
      exactKeys(source, [
        "role",
        "logicalIdentity",
        "sourceExecutablePath",
        "sourceExecutablePathSha256",
        "sourceRealpathSha256",
        "sourceSha256",
        "sourceSize",
        "sourceMode",
        "sourcePathPolicy",
      ]) &&
      source.role === role &&
      source.role === destination?.role &&
      source.logicalIdentity === destination.logicalIdentity &&
      source.sourceSha256 === destination.sha256 &&
      source.sourceSize === destination.size &&
      isSha(source.sourceExecutablePathSha256) &&
      isSha(source.sourceRealpathSha256) &&
      isSha(source.sourceSha256) &&
      Number.isSafeInteger(source.sourceSize) &&
      Number.isSafeInteger(source.sourceMode) &&
      source.sourcePathPolicy === "RESOLVED_REGULAR_FILE_ONLY" &&
      !source.sourceExecutablePath.startsWith(TOOL_ROOT)
    );
  });
}

export function validateLauncherMaterializationPacket(packet) {
  if (!exactKeys(packet, PACKET_KEYS)) return integrity("PACKET_KEYS_INVALID");
  const contractSha = sha256(canonicalJsonBytes(packet.launcherContract));
  if (
    packet.schemaVersion !==
      "organization-identity-launcher-materialization-packet/v4" ||
    !isCommit(packet.subjectCommit) ||
    packet.launcherContractSha256 !== contractSha ||
    packet.contractFilePlan?.sha256 !== contractSha ||
    packet.contractFilePlan?.size !==
      canonicalJsonBytes(packet.launcherContract).length ||
    !validateApprovedArtifacts(packet.approvedArtifacts) ||
    packet.launcherFileCount !== 4 ||
    packet.toolRootFileCount !== 7 ||
    packet.runtimeRootCount !== 7 ||
    packet.requestRootCount !== 1 ||
    packet.outputRootCount !== 1 ||
    packet.launcherRoot !== LAUNCHER_ROOT ||
    packet.toolRoot !== TOOL_ROOT ||
    packet.runtimeRoot !== RUNTIME_ROOT ||
    packet.requestRoot !== REQUEST_ROOT ||
    packet.outputRoot !== OUTPUT_ROOT ||
    !validateSourceClosure(
      packet.sourceToolClosure,
      packet.materializedExecutableClosure,
    ) ||
    packet.launcherFilePlan !== packet.launcherContract.launcherFilePlan ||
    packet.runtimeRootPlan !== packet.launcherContract.runtimeRootPlan ||
    packet.runtimeEnvironment !== packet.launcherContract.runtimeEnvironment ||
    packet.symlinkPolicy !== "NO_LIVE_SYMLINK_RUNTIME_DEPENDENCE" ||
    packet.rollbackPolicy !== "CREATE_ONLY_PRESERVE_EVIDENCE_AND_REAUTHORIZE" ||
    packet.compatibilityStatus !==
      "HISTORICAL_V2_V3_PACKET_MODELS_HOLD_NOT_AUTHORITY_COMPATIBLE" ||
    packet.result !== "AUTH_REQUIRED" ||
    JSON.stringify(packet.chronology) !== JSON.stringify(CHRONOLOGY)
  ) {
    return integrity("PACKET_INVALID");
  }
  const observed = {
    rootDirectory: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    requestRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    outputRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    toolRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    runtimeRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    approvedPlan: packet.launcherContract.approvedPlan,
    approvedSpec: packet.launcherContract.approvedSpec,
    materializedExecutableClosure: packet.materializedExecutableClosure,
  };
  if (
    verifyLauncherContract(packet.launcherContract, observed).status !== "PASS"
  ) {
    return integrity("PACKET_CONTRACT_INVALID");
  }
  return pass({
    launcherMaterializationPacketSha256: sha256(canonicalJsonBytes(packet)),
  });
}

export function buildLauncherMaterializationPacketReviewReceipt(fields) {
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

export function validateLauncherMaterializationPacketReviewReceipt(receipt) {
  const keys = [
    "schemaVersion",
    "launcherMaterializationPacketSha256",
    "generatorCommit",
    "generatorBlobId",
    "generatorSha256",
    "generatorSpecCommit",
    "generatorSpecBlobId",
    "generatorSpecSha256",
    "reportSha256",
    "counterexampleSetSha256",
    "reviewerClass",
    "critical",
    "important",
    "verdict",
  ];
  if (!exactKeys(receipt, keys)) return integrity("PACKET_REVIEW_INVALID");
  if (
    receipt.schemaVersion !==
      "organization-identity-launcher-materialization-packet-review/v1" ||
    receipt.reviewerClass !==
      "INDEPENDENT_ROOT_MATERIALIZATION_PACKET_REVIEW" ||
    receipt.critical !== 0 ||
    receipt.important !== 0 ||
    receipt.verdict !== "PASS"
  )
    return integrity("PACKET_REVIEW_INVALID");
  for (const key of keys.filter((key) => key.endsWith("Sha256"))) {
    if (!isSha(receipt[key])) return integrity("PACKET_REVIEW_INVALID");
  }
  for (const key of keys.filter((key) => key.endsWith("Commit"))) {
    if (!isCommit(receipt[key])) return integrity("PACKET_REVIEW_INVALID");
  }
  if (
    !GIT_ID.test(receipt.generatorBlobId) ||
    !GIT_ID.test(receipt.generatorSpecBlobId)
  ) {
    return integrity("PACKET_REVIEW_INVALID");
  }
  return pass();
}

function rootScope(request) {
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

function requestIdFor(request) {
  const { requestId, ...withoutRequestId } = request;
  return sha256(canonicalJsonBytes(withoutRequestId));
}

export function buildLauncherRootMaterializationRequest(fields) {
  const request = {
    schemaVersion: "organization-identity-root-materialization-request/v1",
    requestId: "",
    authorizationClass: "LOCAL_ROOT_MATERIALIZATION",
    subjectCommit: fields.subjectCommit,
    launcherMaterializationPacketPath: fields.launcherMaterializationPacketPath,
    launcherMaterializationPacketSha256:
      fields.launcherMaterializationPacketSha256,
    launcherMaterializationPacketReviewReceiptPath:
      fields.launcherMaterializationPacketReviewReceiptPath,
    launcherMaterializationPacketReviewReceiptSha256:
      fields.launcherMaterializationPacketReviewReceiptSha256,
    launcherContractSha256: fields.launcherContractSha256,
    sourceToolClosureSha256: fields.sourceToolClosureSha256,
    materializedExecutableClosureSha256:
      fields.materializedExecutableClosureSha256,
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
    chronology: CHRONOLOGY,
    targetMustBeAbsent: true,
    containsCredentialValue: false,
    scopeSha256: "",
  };
  request.scopeSha256 = sha256(canonicalJsonBytes(rootScope(request)));
  request.requestId = requestIdFor(request);
  return request;
}

export function validateLauncherRootMaterializationRequest(request) {
  const keys = [
    "schemaVersion",
    "requestId",
    "authorizationClass",
    "subjectCommit",
    "launcherMaterializationPacketPath",
    "launcherMaterializationPacketSha256",
    "launcherMaterializationPacketReviewReceiptPath",
    "launcherMaterializationPacketReviewReceiptSha256",
    "launcherContractSha256",
    "sourceToolClosureSha256",
    "materializedExecutableClosureSha256",
    "launcherFileCount",
    "toolRootFileCount",
    "runtimeRootCount",
    "requestRootCount",
    "outputRootCount",
    "launcherRoot",
    "toolRoot",
    "runtimeRoot",
    "requestRoot",
    "outputRoot",
    "chronology",
    "targetMustBeAbsent",
    "containsCredentialValue",
    "scopeSha256",
  ];
  if (!exactKeys(request, keys)) return integrity("ROOT_REQUEST_INVALID");
  const expectedScope = sha256(canonicalJsonBytes(rootScope(request)));
  if (
    request.schemaVersion !==
      "organization-identity-root-materialization-request/v1" ||
    request.authorizationClass !== "LOCAL_ROOT_MATERIALIZATION" ||
    !isCommit(request.subjectCommit) ||
    request.scopeSha256 !== expectedScope ||
    request.requestId !== requestIdFor(request) ||
    request.launcherFileCount !== 4 ||
    request.toolRootFileCount !== 7 ||
    request.runtimeRootCount !== 7 ||
    request.requestRootCount !== 1 ||
    request.outputRootCount !== 1 ||
    request.launcherRoot !== LAUNCHER_ROOT ||
    request.toolRoot !== TOOL_ROOT ||
    request.runtimeRoot !== RUNTIME_ROOT ||
    request.requestRoot !== REQUEST_ROOT ||
    request.outputRoot !== OUTPUT_ROOT ||
    JSON.stringify(request.chronology) !== JSON.stringify(CHRONOLOGY) ||
    request.targetMustBeAbsent !== true ||
    request.containsCredentialValue !== false
  )
    return integrity("ROOT_REQUEST_INVALID");
  for (const key of keys.filter((key) => key.endsWith("Sha256"))) {
    if (!isSha(request[key])) return integrity("ROOT_REQUEST_INVALID");
  }
  return pass({
    authorizedRequestSha256: sha256(canonicalJsonBytes(request)),
    scopeSha256: expectedScope,
  });
}

export const ROOT_MATERIALIZATION_PACKET_PATHS = Object.freeze({
  plan: PLAN_PATH,
  spec: SPEC_PATH,
  launcher: LAUNCHER_PATH,
  bootstrap: BOOTSTRAP_PATH,
  bootstrapContract: BOOTSTRAP_CONTRACT_PATH,
  generator: GENERATOR_PATH,
  generatorSpec: GENERATOR_SPEC_PATH,
});
