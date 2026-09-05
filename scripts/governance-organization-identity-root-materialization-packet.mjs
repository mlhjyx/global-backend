import { createHash } from "node:crypto";
import path from "node:path";
import {
  MATERIALIZATION_RUNNING_ROOT,
  materializationGit,
  rootScope,
  requestIdFor,
  buildDiagnosticRootRequest,
} from "./governance-organization-identity-materialization-preflight.mjs";
import {
  APPROVED_PLAN,
  APPROVED_SPEC,
  canonicalJsonBytes,
  computeLauncherContractDigests,
  LOCAL_COMMAND_IDS,
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
const REVIEW_IDENTITIES = Object.freeze({
  authorityModelPlanReviewSha256:
    "f9af1e54d25128b50e7e408dd356e0da28c17eb258e10c745938906f35a91440",
  task0LFinalCodeReviewSha256:
    "02592427cf4936abbfa9bbb724c4f8cdcc4df9c64d9510513786d04fa27e8672",
  task0PFinalReviewSha256:
    "11fa00bad480b888c3a09970a4c52474c1db4754ca8558502403f8990f59dd47",
});
const words = (value) => Object.freeze(value.split(" "));
const ROLES = Object.freeze([
  ["ENV", "bin/env", 0o500],
  ["NODE", "bin/node", 0o500],
  ["GIT", "bin/git", 0o500],
  ["COREPACK_SHIM", "lib/corepack/dist/corepack.js", 0o400],
  ["COREPACK_LIB_COREPACK_CJS", "lib/corepack/dist/lib/corepack.cjs", 0o400],
  ["PNPM_SHIM", "lib/pnpm/9.15.9/bin/pnpm.cjs", 0o400],
  ["PNPM_ENTRYPOINT", "lib/pnpm/9.15.9/dist/pnpm.cjs", 0o400],
]);
const CHRONOLOGY = words(
  "VERIFY_SOURCE_TOOL_CLOSURE COPY_AND_FSYNC_LAUNCHER_FILES COPY_AND_FSYNC_MATERIALIZED_EXECUTABLE_CLOSURE CREATE_AND_FSYNC_RUNTIME_ROOTS CREATE_AND_FSYNC_REQUEST_OUTPUT_ROOTS INDEPENDENT_READBACK MATERIALIZATION_RECEIPT MATERIALIZATION_REVIEW",
);
const PACKET_KEYS = words(
  "schemaVersion subjectCommit phaseASubjectCommit phaseBSubjectCommit launcherContract launcherContractSha256 approvedArtifacts launcherFileCount toolRootFileCount runtimeRootCount requestRootCount outputRootCount launcherRoot toolRoot runtimeRoot requestRoot outputRoot sourceToolClosure sourceToolClosureSha256 materializedExecutableClosure materializedExecutableClosureSha256 launcherFilePlan bootstrapFilePlan contractFilePlan runtimeRootPlan runtimeEnvironment rootPreflight reviewIdentities chronology symlinkPolicy rollbackPolicy compatibilityStatus result",
);

function pass(extra = {}) {
  return {
    status: "PASS",
    evidenceClass: "STRUCTURE_ONLY_NOT_AUTHORITY",
    ...extra,
  };
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

function canonicalEqual(left, right) {
  return canonicalDigest(left) === canonicalDigest(right);
}

function canonicalDigest(value) {
  return sha256(canonicalJsonBytes(value));
}

function isAbsoluteNormalizedPath(value) {
  return (
    typeof value === "string" &&
    path.isAbsolute(value) &&
    path.normalize(value) === value
  );
}

function hex(index) {
  return "123456789abcdef"[index].repeat(64);
}

function gitFileIdentity(commit, filePath) {
  if (!isCommit(commit)) return null;
  const objectName = `${commit}:${filePath}`;
  try {
    const blobId = materializationGit(MATERIALIZATION_RUNNING_ROOT, [
      "rev-parse",
      objectName,
    ])
      .toString()
      .trim();
    const bytes = materializationGit(MATERIALIZATION_RUNNING_ROOT, [
      "cat-file",
      "blob",
      objectName,
    ]);
    return GIT_ID.test(blobId)
      ? { commit, blobId, sha256: sha256(bytes), size: bytes.length }
      : null;
  } catch {
    return null;
  }
}

function artifactFields(prefix, identity) {
  if (!identity) return null;
  return {
    [`${prefix}Commit`]: identity.commit,
    [`${prefix}BlobId`]: identity.blobId,
    [`${prefix}Sha256`]: identity.sha256,
    [`${prefix}Size`]: identity.size,
  };
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
    sourcePathKind: "REGULAR_FILE",
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

function artifactRecord(record, commit, filePath) {
  const actual = gitFileIdentity(commit, filePath);
  if (!actual) return null;
  if (!record) return actual;
  const keys = words("path commit blobId sha256 size");
  return Object.isFrozen(record) &&
    exactKeys(record, keys) &&
    record.path === filePath &&
    record.commit === commit &&
    canonicalEqual(record, { path: filePath, ...actual })
    ? actual
    : null;
}

function approvedArtifacts({
  phaseASubjectCommit,
  phaseBSubjectCommit,
  artifactHandoff = null,
}) {
  if (
    !isCommit(phaseASubjectCommit) ||
    !isCommit(phaseBSubjectCommit) ||
    (artifactHandoff &&
      (!Object.isFrozen(artifactHandoff) ||
        Object.values(artifactHandoff).some(
          (record) => !Object.isFrozen(record),
        )))
  )
    return null;
  const identities = [
    ["plan", APPROVED_PLAN.commit, PLAN_PATH],
    ["spec", APPROVED_SPEC.commit, SPEC_PATH],
    ["launcher", phaseASubjectCommit, LAUNCHER_PATH],
    ["bootstrap", phaseBSubjectCommit, BOOTSTRAP_PATH],
    ["bootstrapContract", phaseBSubjectCommit, BOOTSTRAP_CONTRACT_PATH],
    ["generator", phaseASubjectCommit, GENERATOR_PATH],
    ["generatorSpec", phaseASubjectCommit, GENERATOR_SPEC_PATH],
  ].map(([prefix, commit, filePath]) =>
    artifactFields(
      prefix,
      artifactRecord(artifactHandoff?.[prefix], commit, filePath),
    ),
  );
  return identities.every(Boolean) ? Object.assign({}, ...identities) : null;
}

function launcherContract(sourceClosure, artifacts) {
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
      commit: artifacts?.launcherCommit,
      blobId: artifacts?.launcherBlobId,
      sha256: artifacts?.launcherSha256,
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
    commandIds: [...LOCAL_COMMAND_IDS],
    ...computeLauncherContractDigests(),
  };
}

// Historical fixture construction is deliberately named as non-authority.
export function buildDiagnosticLauncherMaterializationPacket(options = {}) {
  const phaseASubjectCommit =
    options.phaseASubjectCommit ?? options.subjectCommit ?? "1".repeat(40);
  const phaseBSubjectCommit = options.phaseBSubjectCommit ?? "1".repeat(40);
  const subjectCommit = options.subjectCommit ?? phaseASubjectCommit;
  const sources = options.sourceToolClosure ?? sourceToolClosure();
  const artifacts = approvedArtifacts({
    phaseASubjectCommit,
    phaseBSubjectCommit,
    artifactHandoff: options.artifactHandoff,
  });
  const contract =
    options.launcherContract ?? launcherContract(sources, artifacts);
  const contractBytes = canonicalJsonBytes(contract);
  const contractSha = sha256(contractBytes);
  const materialized = contract.materializedExecutableClosure;
  const packet = {
    schemaVersion: "organization-identity-launcher-materialization-packet/v4",
    subjectCommit,
    phaseASubjectCommit,
    phaseBSubjectCommit,
    launcherContract: contract,
    launcherContractSha256: contractSha,
    approvedArtifacts: artifacts,
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
    sourceToolClosureSha256: canonicalDigest(sources),
    materializedExecutableClosure: materialized,
    materializedExecutableClosureSha256: canonicalDigest(materialized),
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
      ...REVIEW_IDENTITIES,
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

function validateApprovedArtifacts(artifacts, packet) {
  const keys = words(
    "planCommit planBlobId planSha256 planSize specCommit specBlobId specSha256 specSize launcherCommit launcherBlobId launcherSha256 launcherSize bootstrapCommit bootstrapBlobId bootstrapSha256 bootstrapSize bootstrapContractCommit bootstrapContractBlobId bootstrapContractSha256 bootstrapContractSize generatorCommit generatorBlobId generatorSha256 generatorSize generatorSpecCommit generatorSpecBlobId generatorSpecSha256 generatorSpecSize",
  );
  if (!exactKeys(artifacts, keys)) return false;
  const expected = approvedArtifacts({
    phaseASubjectCommit: packet.phaseASubjectCommit,
    phaseBSubjectCommit: packet.phaseBSubjectCommit,
  });
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
    canonicalEqual(artifacts, expected) &&
    artifacts.planCommit === APPROVED_PLAN.commit &&
    artifacts.planBlobId === APPROVED_PLAN.blobId &&
    artifacts.planSha256 === APPROVED_PLAN.sha256 &&
    artifacts.specCommit === APPROVED_SPEC.commit &&
    artifacts.specBlobId === APPROVED_SPEC.blobId &&
    artifacts.specSha256 === APPROVED_SPEC.sha256 &&
    packet.subjectCommit === packet.phaseASubjectCommit &&
    artifacts.launcherCommit === packet.phaseASubjectCommit &&
    artifacts.generatorCommit === packet.phaseASubjectCommit &&
    artifacts.generatorSpecCommit === packet.phaseASubjectCommit &&
    artifacts.bootstrapCommit === packet.phaseBSubjectCommit &&
    artifacts.bootstrapContractCommit === packet.phaseBSubjectCommit &&
    artifacts.launcherCommit ===
      packet.launcherContract?.approvedLauncher?.commit &&
    artifacts.launcherBlobId ===
      packet.launcherContract?.approvedLauncher?.blobId &&
    artifacts.launcherSha256 ===
      packet.launcherContract?.approvedLauncher?.sha256 &&
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
      exactKeys(
        source,
        words(
          "role logicalIdentity sourceExecutablePath sourceExecutablePathSha256 sourceRealpathSha256 sourceSha256 sourceSize sourceMode sourcePathPolicy sourcePathKind",
        ),
      ) &&
      source.role === role &&
      source.role === destination?.role &&
      source.logicalIdentity === destination.logicalIdentity &&
      source.sourceSha256 === destination.sha256 &&
      source.sourceSize === destination.size &&
      isAbsoluteNormalizedPath(source.sourceExecutablePath) &&
      source.sourceExecutablePathSha256 ===
        pathSha(source.sourceExecutablePath) &&
      isSha(source.sourceRealpathSha256) &&
      isSha(source.sourceSha256) &&
      Number.isSafeInteger(source.sourceSize) &&
      Number.isSafeInteger(source.sourceMode) &&
      source.sourcePathPolicy === "RESOLVED_REGULAR_FILE_ONLY" &&
      source.sourcePathKind === "REGULAR_FILE" &&
      !source.sourceExecutablePath.startsWith(TOOL_ROOT)
    );
  });
}

export function validateLauncherMaterializationPacketStructure(packet) {
  if (!exactKeys(packet, PACKET_KEYS)) return integrity("PACKET_KEYS_INVALID");
  if (
    !exactKeys(packet.reviewIdentities, Object.keys(REVIEW_IDENTITIES)) ||
    !Object.values(packet.reviewIdentities).every(isSha)
  )
    return integrity("PACKET_REVIEW_IDENTITIES_INVALID");
  const contractSha = sha256(canonicalJsonBytes(packet.launcherContract));
  const sourceClosureSha = canonicalDigest(packet.sourceToolClosure);
  const materializedClosureSha = canonicalDigest(
    packet.materializedExecutableClosure,
  );
  if (
    packet.schemaVersion !==
      "organization-identity-launcher-materialization-packet/v4" ||
    !isCommit(packet.subjectCommit) ||
    packet.phaseASubjectCommit !== packet.subjectCommit ||
    packet.phaseBSubjectCommit === packet.phaseASubjectCommit ||
    packet.launcherContractSha256 !== contractSha ||
    packet.contractFilePlan?.sha256 !== contractSha ||
    packet.contractFilePlan?.size !==
      canonicalJsonBytes(packet.launcherContract).length ||
    packet.sourceToolClosureSha256 !== sourceClosureSha ||
    packet.materializedExecutableClosureSha256 !== materializedClosureSha ||
    !validateApprovedArtifacts(packet.approvedArtifacts, packet) ||
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
    !canonicalEqual(
      packet.launcherFilePlan,
      packet.launcherContract.launcherFilePlan,
    ) ||
    !canonicalEqual(
      packet.runtimeRootPlan,
      packet.launcherContract.runtimeRootPlan,
    ) ||
    !canonicalEqual(
      packet.runtimeEnvironment,
      packet.launcherContract.runtimeEnvironment,
    ) ||
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

export {
  prepareLauncherMaterialization,
  observeMaterializationSource,
  buildLauncherMaterializationPacket,
  validateLauncherMaterializationPacket,
  writeLauncherMaterializationPacketFile,
  buildLauncherRootMaterializationRequest,
  validateLauncherRootMaterializationRequest,
  writeLauncherRootMaterializationRequestFile,
} from "./governance-organization-identity-materialization-handoff.mjs";

export { buildDiagnosticLauncherMaterializationPacketReviewReceipt } from "./governance-organization-identity-materialization-preflight.mjs";

export function validateLauncherMaterializationPacketReviewReceiptStructure(
  receipt,
  packet = null,
) {
  const keys = words(
    "schemaVersion launcherMaterializationPacketSha256 generatorCommit generatorBlobId generatorSha256 generatorSpecCommit generatorSpecBlobId generatorSpecSha256 reportSha256 counterexampleSetSha256 reviewerClass critical important verdict",
  );
  if (!exactKeys(receipt, keys)) return integrity("PACKET_REVIEW_INVALID");
  if (
    receipt.schemaVersion !==
      "organization-identity-launcher-materialization-packet-review/v1" ||
    receipt.reviewerClass !==
      "INDEPENDENT_ROOT_MATERIALIZATION_PACKET_REVIEW" ||
    receipt.critical !== 0 ||
    receipt.important !== 0 ||
    receipt.verdict !== "PASS" ||
    receipt.reportSha256 === receipt.counterexampleSetSha256
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
  if (packet) {
    const packetValidation =
      validateLauncherMaterializationPacketStructure(packet);
    if (
      packetValidation.status !== "PASS" ||
      receipt.launcherMaterializationPacketSha256 !==
        packetValidation.launcherMaterializationPacketSha256 ||
      receipt.generatorCommit !== packet.approvedArtifacts.generatorCommit ||
      receipt.generatorBlobId !== packet.approvedArtifacts.generatorBlobId ||
      receipt.generatorSha256 !== packet.approvedArtifacts.generatorSha256 ||
      receipt.generatorSpecCommit !==
        packet.approvedArtifacts.generatorSpecCommit ||
      receipt.generatorSpecBlobId !==
        packet.approvedArtifacts.generatorSpecBlobId ||
      receipt.generatorSpecSha256 !==
        packet.approvedArtifacts.generatorSpecSha256
    ) {
      return integrity("PACKET_REVIEW_INVALID");
    }
  }
  return pass();
}

export function buildLauncherMaterializationPacketReviewReceipt() {
  return {
    status: "HOLD",
    code: "INDEPENDENT_REVIEW_RECEIPT_CANNOT_BE_SYNTHESIZED",
  };
}

export function validateLauncherMaterializationPacketReviewReceipt(
  receipt,
  packet = null,
) {
  const structure = validateLauncherMaterializationPacketReviewReceiptStructure(
    receipt,
    packet,
  );
  if (structure.status !== "PASS") return structure;
  return { status: "HOLD", code: "FULL_REVIEW_BYTE_REFERENCES_REQUIRED" };
}

export function buildDiagnosticLauncherRootMaterializationRequest(fields) {
  return buildDiagnosticRootRequest(
    fields,
    validateLauncherMaterializationPacketStructure(
      fields.launcherMaterializationPacket,
    ),
    CHRONOLOGY,
  );
}

export function validateLauncherRootMaterializationRequestStructure(
  request,
  packet = null,
) {
  const keys = words(
    "schemaVersion requestId authorizationClass subjectCommit launcherMaterializationPacketPath launcherMaterializationPacketSha256 launcherMaterializationPacketReviewReceiptPath launcherMaterializationPacketReviewReceiptSha256 launcherContractSha256 sourceToolClosureSha256 materializedExecutableClosureSha256 launcherFileCount toolRootFileCount runtimeRootCount requestRootCount outputRootCount launcherRoot toolRoot runtimeRoot requestRoot outputRoot chronology targetMustBeAbsent containsCredentialValue scopeSha256",
  );
  if (!exactKeys(request, keys)) return integrity("ROOT_REQUEST_INVALID");
  const packetValidation =
    validateLauncherMaterializationPacketStructure(packet);
  if (packetValidation.status !== "PASS") {
    return integrity("ROOT_REQUEST_PACKET_INVALID");
  }
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
    request.subjectCommit !== packet.subjectCommit ||
    request.launcherMaterializationPacketSha256 !==
      packetValidation.launcherMaterializationPacketSha256 ||
    request.launcherContractSha256 !== packet.launcherContractSha256 ||
    request.sourceToolClosureSha256 !== packet.sourceToolClosureSha256 ||
    request.materializedExecutableClosureSha256 !==
      packet.materializedExecutableClosureSha256 ||
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
    diagnosticRequestSha256: sha256(canonicalJsonBytes(request)),
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
