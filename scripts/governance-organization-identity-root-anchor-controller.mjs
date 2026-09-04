import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const pass = (extra = {}) => ({ status: "PASS", ...extra });
const integrity = (code) => ({ status: "INTEGRITY_ERROR", code });
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};
const canonicalJsonBytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isSha256 = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isGitObjectId = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
function isPassivePlainData(value, seen = new Set()) {
  if (value === null) return true;
  if (typeof value === "string") return value.normalize("NFC") === value;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length) return false;
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
      return false;
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (Array.isArray(value) && key === "length") continue;
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      if (
        !("value" in descriptor) ||
        descriptor.get ||
        descriptor.set ||
        !isPassivePlainData(descriptor.value, seen)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}
const hasExactKeys = (value, keys) =>
  isPassivePlainData(value) &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const valuesEqual = (left, right) =>
  canonicalJson(left) === canonicalJson(right);
function validateExternalExecutableClosure(entries, roles) {
  if (!Array.isArray(entries) || entries.length !== roles.length)
    return integrity("EXECUTABLE_CLOSURE_INVALID");
  for (let index = 0; index < roles.length; index += 1) {
    const entry = entries[index];
    if (
      !hasExactKeys(entry, [
        "role",
        "logicalIdentity",
        "executablePath",
        "realpathSha256",
        "sha256",
        "size",
      ]) ||
      entry.role !== roles[index] ||
      !path.posix.isAbsolute(entry.executablePath) ||
      !isSha256(entry.realpathSha256) ||
      !isSha256(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    )
      return integrity("EXECUTABLE_CLOSURE_INVALID");
  }
  return pass();
}
const validateExactEnvironmentNames = (actual, expected) =>
  valuesEqual(actual, expected)
    ? pass()
    : integrity("ENVIRONMENT_NAME_SET_INVALID");

const ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor";
const REQUEST_ROOT = `${ROOT}/requests`;
const OUTPUT_ROOT = `${ROOT}/outputs`;
const ANCHOR_DIRECTORY =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2";
const ANCHOR_PATH = `${ANCHOR_DIRECTORY}/protected-main-anchor.json`;
const WRITE_RECEIPT_PATH = `${OUTPUT_ROOT}/root-anchor-write-receipt.json`;
const REQUIRED_ROLES = Object.freeze(["ENV", "NODE"]);
const ALLOWED_ENVIRONMENT_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
]);

const CONTRACT_KEYS = [
  "schemaVersion",
  "rootDirectory",
  "requestRoot",
  "outputRoot",
  "anchorDirectory",
  "anchorPath",
  "controllerSource",
  "controllerTest",
  "executableClosure",
  "requiredRoles",
  "allowedEnvironmentNames",
  "environmentValueRuleSha256",
  "anchorSchemaSha256",
  "requestSchemaSha256",
  "writeReceiptSchemaSha256",
  "readbackReceiptSchemaSha256",
  "operationReviewSchemaSha256",
  "canonicalizationRuleSha256",
  "rootPolicy",
  "predecessorPolicy",
  "credentialIngressAllowed",
  "anchorSelfHashFieldAllowed",
];

function validSource(value, expectedPath) {
  return (
    hasExactKeys(value, ["path", "blobId", "sha256"]) &&
    value.path === expectedPath &&
    isGitObjectId(value.blobId) &&
    isSha256(value.sha256)
  );
}

function validRootPolicy(value) {
  return (
    hasExactKeys(value, [
      "ownerUid",
      "ownerGid",
      "directoryMode",
      "controllerMode",
      "recordMode",
      "anchorMode",
      "noFollow",
      "createExclusive",
      "overwriteAllowed",
      "fileFsyncRequired",
      "directoryFsyncRequired",
    ]) &&
    value.ownerUid === 0 &&
    value.ownerGid === 0 &&
    value.directoryMode === 0o700 &&
    value.controllerMode === 0o500 &&
    value.recordMode === 0o600 &&
    value.anchorMode === 0o600 &&
    value.noFollow === true &&
    value.createExclusive === true &&
    value.overwriteAllowed === false &&
    value.fileFsyncRequired === true &&
    value.directoryFsyncRequired === true
  );
}

function validPredecessorPolicy(value) {
  return (
    hasExactKeys(value, [
      "mode",
      "requiredPredecessorSha256",
      "targetMustBeAbsent",
    ]) &&
    value.mode === "GENESIS_ONLY" &&
    value.requiredPredecessorSha256 === null &&
    value.targetMustBeAbsent === true
  );
}

export function validateRootAnchorContract(contract) {
  if (
    !hasExactKeys(contract, CONTRACT_KEYS) ||
    contract.schemaVersion !==
      "organization-identity-root-anchor-controller-contract/v1" ||
    contract.rootDirectory !== ROOT ||
    contract.requestRoot !== REQUEST_ROOT ||
    contract.outputRoot !== OUTPUT_ROOT ||
    contract.anchorDirectory !== ANCHOR_DIRECTORY ||
    contract.anchorPath !== ANCHOR_PATH ||
    !validSource(
      contract.controllerSource,
      "scripts/governance-organization-identity-root-anchor-controller.mjs",
    ) ||
    !validSource(
      contract.controllerTest,
      "scripts/governance-organization-identity-root-anchor-controller.spec.mjs",
    ) ||
    !valuesEqual(contract.requiredRoles, REQUIRED_ROLES) ||
    validateExternalExecutableClosure(
      contract.executableClosure,
      REQUIRED_ROLES,
    ).status !== "PASS" ||
    validateExactEnvironmentNames(
      contract.allowedEnvironmentNames,
      ALLOWED_ENVIRONMENT_NAMES,
    ).status !== "PASS" ||
    !validRootPolicy(contract.rootPolicy) ||
    !validPredecessorPolicy(contract.predecessorPolicy) ||
    contract.credentialIngressAllowed !== false ||
    contract.anchorSelfHashFieldAllowed !== false
  ) {
    return integrity("ROOT_ANCHOR_CONTRACT_INVALID");
  }
  for (const key of [
    "environmentValueRuleSha256",
    "anchorSchemaSha256",
    "requestSchemaSha256",
    "writeReceiptSchemaSha256",
    "readbackReceiptSchemaSha256",
    "operationReviewSchemaSha256",
    "canonicalizationRuleSha256",
  ]) {
    if (!isSha256(contract[key]))
      return integrity("ROOT_ANCHOR_CONTRACT_INVALID");
  }
  return pass();
}

const REQUEST_KEYS = [
  "schemaVersion",
  "requestId",
  "contractSha256",
  "materializationReceiptSha256",
  "controllerReviewReceiptSha256",
  "authorizationReceiptSha256",
  "targetPath",
  "targetMode",
  "predecessor",
  "localLauncherEvidenceSha256",
  "bootstrapContractSha256",
  "githubControllerEvidenceSha256",
  "protectedBaseEvidenceSha256",
  "admittedRefreshAcceptanceEvidenceSha256",
  "orderedMergeParents",
  "workflowRunEvidenceSha256",
  "controllerVariableWriteReceiptSha256",
  "canonicalAnchorPayloadSha256",
  "canonicalAnchorPayloadSize",
  "writeReceiptPath",
];

function validateRootUpstreamEvidence(request, contract, records) {
  if (!records || typeof records !== "object")
    return integrity("ROOT_ANCHOR_UPSTREAM_EVIDENCE_INVALID");
  const bindings = {
    materializationReceiptSha256: "materializationReceipt",
    controllerReviewReceiptSha256: "controllerReviewReceipt",
    authorizationReceiptSha256: "authorizationReceipt",
    localLauncherEvidenceSha256: "localLauncherEvidence",
    bootstrapContractSha256: "bootstrapContract",
    githubControllerEvidenceSha256: "githubControllerEvidence",
    protectedBaseEvidenceSha256: "protectedBaseEvidence",
    admittedRefreshAcceptanceEvidenceSha256:
      "admittedRefreshAcceptanceEvidence",
    workflowRunEvidenceSha256: "workflowRunEvidence",
    controllerVariableWriteReceiptSha256: "controllerVariableWriteReceipt",
  };
  if (!hasExactKeys(records, Object.values(bindings))) {
    return integrity("ROOT_ANCHOR_UPSTREAM_EVIDENCE_INVALID");
  }
  for (const [field, recordKey] of Object.entries(bindings)) {
    if (request[field] !== sha256(canonicalJsonBytes(records[recordKey]))) {
      return integrity("ROOT_ANCHOR_UPSTREAM_EVIDENCE_INVALID");
    }
  }
  const materialization = records.materializationReceipt;
  const review = records.controllerReviewReceipt;
  if (
    !hasExactKeys(materialization, [
      "schemaVersion",
      "controllerClass",
      "contractSha256",
      "controllerSourceSha256",
      "rootDirectorySha256",
      "requestRootSha256",
      "outputRootSha256",
      "ownerUid",
      "ownerGid",
      "directoryMode",
      "controllerMode",
      "recordMode",
      "executableClosureSetSha256",
      "environmentSchemaSha256",
      "prePostToctouSha256",
      "result",
    ]) ||
    !hasExactKeys(review, [
      "schemaVersion",
      "controllerClass",
      "contractSha256",
      "materializationReceiptSha256",
      "requestSchemaSha256",
      "reportSha256",
      "counterexampleSetSha256",
      "reviewerClass",
      "critical",
      "important",
      "verdict",
    ]) ||
    !hasExactKeys(records.authorizationReceipt, [
      "controllerClass",
      "requestId",
      "scope",
      "operation",
    ]) ||
    materialization.schemaVersion !==
      "organization-identity-external-controller-materialization/v1" ||
    materialization.controllerClass !== "ROOT_ANCHOR" ||
    materialization.contractSha256 !== sha256(canonicalJsonBytes(contract)) ||
    materialization.controllerSourceSha256 !==
      contract.controllerSource.sha256 ||
    materialization.executableClosureSetSha256 !==
      sha256(canonicalJsonBytes(contract.executableClosure)) ||
    materialization.ownerUid !== 0 ||
    materialization.ownerGid !== 0 ||
    materialization.directoryMode !== 0o700 ||
    materialization.controllerMode !== 0o500 ||
    materialization.recordMode !== 0o600 ||
    materialization.result !== "PASS" ||
    review.schemaVersion !== "organization-identity-controller-review/v1" ||
    review.controllerClass !== "ROOT_ANCHOR" ||
    review.contractSha256 !== request.contractSha256 ||
    review.materializationReceiptSha256 !==
      request.materializationReceiptSha256 ||
    review.reviewerClass !== "INDEPENDENT_CONTROLLER_SECURITY_REVIEW" ||
    review.critical !== 0 ||
    review.important !== 0 ||
    review.verdict !== "PASS" ||
    records.authorizationReceipt.controllerClass !== "ROOT_ANCHOR" ||
    records.authorizationReceipt.requestId !== request.requestId ||
    records.authorizationReceipt.scope !== "EXACT_REQUEST_ONLY" ||
    records.localLauncherEvidence.schemaVersion !==
      "organization-identity-launcher-materialization-review/v1" ||
    records.bootstrapContract.schemaVersion !==
      "organization-identity-bootstrap-contract/v2" ||
    records.githubControllerEvidence.schemaVersion !==
      "organization-identity-github-controller-receipt/v1" ||
    records.protectedBaseEvidence.schemaVersion !==
      "organization-identity-protected-base-launcher-receipt/v1" ||
    records.controllerVariableWriteReceipt.operation !==
      "CONTROLLER_VARIABLES_WRITE"
  ) {
    return integrity("ROOT_ANCHOR_UPSTREAM_EVIDENCE_INVALID");
  }
  return pass();
}

export function validateRootAnchorWriteRequest(
  request,
  contract,
  expected,
  upstreamEvidence,
) {
  if (
    !hasExactKeys(expected, [
      "orderedMergeParents",
      "canonicalAnchorPayloadSha256",
      "canonicalAnchorPayloadSize",
    ])
  ) {
    return integrity("ROOT_ANCHOR_EXPECTED_INPUT_REQUIRED");
  }
  if (
    validateRootUpstreamEvidence(request, contract, upstreamEvidence).status !==
    "PASS"
  ) {
    return integrity("ROOT_ANCHOR_UPSTREAM_EVIDENCE_INVALID");
  }
  if (
    validateRootAnchorContract(contract).status !== "PASS" ||
    !hasExactKeys(request, REQUEST_KEYS) ||
    request.schemaVersion !==
      "organization-identity-root-anchor-write-request/v1" ||
    !isSha256(request.requestId) ||
    request.contractSha256 !== sha256(canonicalJsonBytes(contract)) ||
    !isSha256(request.materializationReceiptSha256) ||
    !isSha256(request.controllerReviewReceiptSha256) ||
    !isSha256(request.authorizationReceiptSha256) ||
    request.targetPath !== ANCHOR_PATH ||
    request.targetMode !== 0o600 ||
    !hasExactKeys(request.predecessor, [
      "mode",
      "sha256",
      "targetMustBeAbsent",
    ]) ||
    request.predecessor.mode !== "GENESIS_ONLY" ||
    request.predecessor.sha256 !== null ||
    request.predecessor.targetMustBeAbsent !== true ||
    !Array.isArray(request.orderedMergeParents) ||
    request.orderedMergeParents.length !== 2 ||
    !request.orderedMergeParents.every(isGitObjectId) ||
    request.orderedMergeParents[0] === request.orderedMergeParents[1] ||
    !Number.isSafeInteger(request.canonicalAnchorPayloadSize) ||
    request.canonicalAnchorPayloadSize <= 0 ||
    request.writeReceiptPath !== WRITE_RECEIPT_PATH
  ) {
    return integrity("ROOT_ANCHOR_REQUEST_INVALID");
  }
  for (const key of [
    "localLauncherEvidenceSha256",
    "bootstrapContractSha256",
    "githubControllerEvidenceSha256",
    "protectedBaseEvidenceSha256",
    "admittedRefreshAcceptanceEvidenceSha256",
    "workflowRunEvidenceSha256",
    "controllerVariableWriteReceiptSha256",
    "canonicalAnchorPayloadSha256",
  ]) {
    if (!isSha256(request[key]))
      return integrity("ROOT_ANCHOR_REQUEST_INVALID");
  }
  if (!valuesEqual(request.orderedMergeParents, expected.orderedMergeParents)) {
    return integrity("ROOT_ANCHOR_PARENT_ORDER_INVALID");
  }
  if (
    request.canonicalAnchorPayloadSha256 !==
    expected.canonicalAnchorPayloadSha256
  ) {
    return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
  }
  if (
    request.canonicalAnchorPayloadSize !== expected.canonicalAnchorPayloadSize
  ) {
    return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
  }
  return pass();
}

export function planRootAnchorWrite(
  request,
  contract,
  observation,
  expected,
  upstreamEvidence,
) {
  if (
    validateRootAnchorWriteRequest(
      request,
      contract,
      expected,
      upstreamEvidence,
    ).status !== "PASS" ||
    !hasExactKeys(observation, [
      "targetExists",
      "targetKind",
      "hardlinkCount",
      "inodeStable",
      "ownerUid",
      "ownerGid",
      "directoryMode",
    ]) ||
    observation.targetExists !== false ||
    observation.targetKind !== "absent" ||
    observation.hardlinkCount !== 0 ||
    observation.inodeStable !== true ||
    observation.ownerUid !== 0 ||
    observation.ownerGid !== 0 ||
    observation.directoryMode !== 0o700
  ) {
    return {
      status: "ROOT_ANCHOR_WRITE_HOLD",
      code: "ROOT_ANCHOR_TARGET_INVALID",
    };
  }
  return {
    status: "PASS",
    writeMode: "CREATE_EXCLUSIVE_NOFOLLOW",
    targetPath: ANCHOR_PATH,
    fileMode: 0o600,
    fileFsyncRequired: true,
    directoryFsyncRequired: true,
  };
}

function modeOf(stat) {
  return Number(stat.mode & 0o777n);
}

async function verifiedFixtureDirectory(directoryPath, fixture) {
  const [stat, resolved] = await Promise.all([
    lstat(directoryPath, { bigint: true }),
    realpath(directoryPath),
  ]);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    resolved === directoryPath &&
    modeOf(stat) === 0o700 &&
    Number(stat.uid) === fixture.expectedUid &&
    Number(stat.gid) === fixture.expectedGid
  );
}

async function verifyFixtureRoot(fixture, receiptField) {
  const fixtureKeys = [
    "rootDirectory",
    "outputRoot",
    "targetPath",
    receiptField,
    "expectedUid",
    "expectedGid",
  ];
  if (
    !hasExactKeys(fixture, fixtureKeys) ||
    !path.isAbsolute(fixture.rootDirectory) ||
    !path.isAbsolute(fixture.outputRoot) ||
    !path.isAbsolute(fixture.targetPath) ||
    !path.isAbsolute(fixture[receiptField]) ||
    path.dirname(fixture.targetPath) !== fixture.rootDirectory ||
    !fixture.targetPath.startsWith(`${fixture.rootDirectory}/`) ||
    path.dirname(fixture.outputRoot) !== fixture.rootDirectory ||
    path.dirname(fixture[receiptField]) !== fixture.outputRoot ||
    !fixture[receiptField].startsWith(`${fixture.outputRoot}/`) ||
    fixture.rootDirectory === ANCHOR_DIRECTORY
  ) {
    return integrity("ROOT_ANCHOR_FIXTURE_INVALID");
  }
  try {
    const [rootValid, outputValid] = await Promise.all([
      verifiedFixtureDirectory(fixture.rootDirectory, fixture),
      verifiedFixtureDirectory(fixture.outputRoot, fixture),
    ]);
    if (!rootValid || !outputValid) {
      return integrity("ROOT_ANCHOR_FIXTURE_ROOT_INVALID");
    }
    return pass();
  } catch {
    return integrity("ROOT_ANCHOR_FIXTURE_ROOT_INVALID");
  }
}

async function targetAbsent(targetPath) {
  try {
    await lstat(targetPath, { bigint: true });
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function fsyncDirectory(directoryPath) {
  const handle = await open(directoryPath, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function openVerifiedDirectory(directoryPath, fixture) {
  const handle = await open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat({ bigint: true });
    const resolved = await realpath(directoryPath);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      modeOf(stat) !== 0o700 ||
      Number(stat.uid) !== fixture.expectedUid ||
      Number(stat.gid) !== fixture.expectedGid ||
      resolved !== directoryPath
    ) {
      throw new Error("ROOT_ANCHOR_DIRECTORY_INVALID");
    }
    return {
      handle,
      stablePath: `/proc/self/fd/${handle.fd}`,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function writeExclusiveCanonical(filePath, bytes, fixture) {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.chown(fixture.expectedUid, fixture.expectedGid);
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      modeOf(stat) !== 0o600 ||
      Number(stat.uid) !== fixture.expectedUid ||
      Number(stat.gid) !== fixture.expectedGid ||
      Number(stat.size) !== bytes.length
    ) {
      return integrity("ROOT_ANCHOR_WRITE_METADATA_INVALID");
    }
    return pass({ stat });
  } catch {
    return integrity("ROOT_ANCHOR_CREATE_EXCLUSIVE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readbackFile(filePath, expected, fixture) {
  let handle;
  try {
    const before = await lstat(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      return integrity("ROOT_ANCHOR_READBACK_INVALID");
    }
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    if (
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.dev !== afterPath.dev ||
      opened.ino !== afterPath.ino ||
      modeOf(opened) !== 0o600 ||
      Number(opened.uid) !== fixture.expectedUid ||
      Number(opened.gid) !== fixture.expectedGid ||
      bytes.length !== expected.size ||
      sha256(bytes) !== expected.sha256
    ) {
      return integrity("ROOT_ANCHOR_READBACK_INVALID");
    }
    return pass({ bytes, stat: opened });
  } catch {
    return integrity("ROOT_ANCHOR_READBACK_INVALID");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function materializeRootAnchor({
  request,
  contract,
  expected,
  upstreamEvidence,
  payloadBytes,
  fixture,
}) {
  if (!fixture) {
    return {
      status: "ROOT_ANCHOR_WRITE_HOLD",
      code: "PRODUCTION_ROOT_AUTHORIZATION_REQUIRED",
    };
  }
  if (
    validateRootAnchorWriteRequest(
      request,
      contract,
      expected,
      upstreamEvidence,
    ).status !== "PASS" ||
    !Buffer.isBuffer(payloadBytes) ||
    payloadBytes.length !== request.canonicalAnchorPayloadSize ||
    sha256(payloadBytes) !== request.canonicalAnchorPayloadSha256
  ) {
    return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
  }
  try {
    const parsed = JSON.parse(payloadBytes.toString("utf8"));
    if (
      !isPassivePlainData(parsed) ||
      !payloadBytes.equals(canonicalJsonBytes(parsed)) ||
      Object.hasOwn(parsed, "anchorSha256") ||
      Object.hasOwn(parsed, "selfSha256")
    ) {
      return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
    }
  } catch {
    return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
  }
  const root = await verifyFixtureRoot(fixture, "writeReceiptPath");
  if (root.status !== "PASS" || !(await targetAbsent(fixture.targetPath))) {
    return {
      status: "ROOT_ANCHOR_WRITE_HOLD",
      code: "ROOT_ANCHOR_TARGET_INVALID",
    };
  }
  let rootDirectory;
  let outputDirectory;
  try {
    rootDirectory = await openVerifiedDirectory(fixture.rootDirectory, fixture);
    outputDirectory = await openVerifiedDirectory(fixture.outputRoot, fixture);
    const stableTargetPath = path.join(
      rootDirectory.stablePath,
      path.basename(fixture.targetPath),
    );
    const stableWriteReceiptPath = path.join(
      outputDirectory.stablePath,
      path.basename(fixture.writeReceiptPath),
    );
    if (!(await targetAbsent(stableTargetPath))) {
      return {
        status: "ROOT_ANCHOR_WRITE_HOLD",
        code: "ROOT_ANCHOR_TARGET_INVALID",
      };
    }
    const written = await writeExclusiveCanonical(
      stableTargetPath,
      payloadBytes,
      fixture,
    );
    if (written.status !== "PASS") {
      return { status: "ROOT_ANCHOR_WRITE_HOLD", code: written.code };
    }
    await rootDirectory.handle.sync();
    const readback = await readbackFile(
      stableTargetPath,
      {
        sha256: request.canonicalAnchorPayloadSha256,
        size: payloadBytes.length,
      },
      fixture,
    );
    if (readback.status !== "PASS") {
      return { status: "ROOT_ANCHOR_WRITE_HOLD", code: readback.code };
    }
    const writeReceipt = {
      schemaVersion: "organization-identity-root-anchor-write-receipt/v1",
      contractSha256: request.contractSha256,
      materializationReceiptSha256: request.materializationReceiptSha256,
      controllerReviewReceiptSha256: request.controllerReviewReceiptSha256,
      requestSha256: sha256(canonicalJsonBytes(request)),
      authorizationReceiptSha256: request.authorizationReceiptSha256,
      targetPath: ANCHOR_PATH,
      anchorSha256: request.canonicalAnchorPayloadSha256,
      anchorSize: payloadBytes.length,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      device: String(readback.stat.dev),
      inode: String(readback.stat.ino),
      predecessorSha256: null,
      fileFsyncSha256: sha256(
        canonicalJsonBytes({ inode: String(readback.stat.ino), synced: true }),
      ),
      directoryFsyncSha256: sha256(
        canonicalJsonBytes({ directory: fixture.rootDirectory, synced: true }),
      ),
      prePostToctouSha256: sha256(
        canonicalJsonBytes({
          device: String(readback.stat.dev),
          inode: String(readback.stat.ino),
        }),
      ),
      anchorContainsSelfHash: false,
      result: "PASS",
    };
    const receiptWrite = await writeExclusiveCanonical(
      stableWriteReceiptPath,
      canonicalJsonBytes(writeReceipt),
      fixture,
    );
    if (receiptWrite.status !== "PASS") {
      return { status: "ROOT_ANCHOR_WRITE_HOLD", code: receiptWrite.code };
    }
    await outputDirectory.handle.sync();
    return pass({ writeReceipt });
  } finally {
    await outputDirectory?.handle.close().catch(() => undefined);
    await rootDirectory?.handle.close().catch(() => undefined);
  }
}

export async function readbackRootAnchor({
  request,
  contract,
  writeReceipt,
  fixture,
}) {
  if (
    !fixture ||
    validateRootAnchorWriteReceipt(writeReceipt, request).status !== "PASS"
  ) {
    return integrity("ROOT_ANCHOR_WRITE_RECEIPT_INVALID");
  }
  const root = await verifyFixtureRoot(fixture, "readbackReceiptPath");
  if (root.status !== "PASS") return root;
  let rootDirectory;
  let outputDirectory;
  try {
    rootDirectory = await openVerifiedDirectory(fixture.rootDirectory, fixture);
    outputDirectory = await openVerifiedDirectory(fixture.outputRoot, fixture);
    const stableTargetPath = path.join(
      rootDirectory.stablePath,
      path.basename(fixture.targetPath),
    );
    const stableReadbackReceiptPath = path.join(
      outputDirectory.stablePath,
      path.basename(fixture.readbackReceiptPath),
    );
    const observed = await readbackFile(
      stableTargetPath,
      { sha256: writeReceipt.anchorSha256, size: writeReceipt.anchorSize },
      fixture,
    );
    if (observed.status !== "PASS") return observed;
    const readbackReceipt = {
      schemaVersion: "organization-identity-root-anchor-readback/v1",
      contractSha256: writeReceipt.contractSha256,
      requestSha256: writeReceipt.requestSha256,
      writeReceiptSha256: sha256(canonicalJsonBytes(writeReceipt)),
      targetPath: ANCHOR_PATH,
      noFollowVerified: true,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      device: String(observed.stat.dev),
      inode: String(observed.stat.ino),
      anchorSha256: observed.status === "PASS" ? sha256(observed.bytes) : "",
      anchorSize: observed.bytes.length,
      canonicalSchemaSha256: contract.anchorSchemaSha256,
      inputEvidenceSetSha256: sha256(
        canonicalJsonBytes({
          requestSha256: writeReceipt.requestSha256,
          writeReceiptSha256: sha256(canonicalJsonBytes(writeReceipt)),
        }),
      ),
      predecessorSha256: null,
      anchorContainsSelfHash: false,
      prePostToctouSha256: writeReceipt.prePostToctouSha256,
      reviewerClass: "INDEPENDENT_ROOT_ANCHOR_READBACK",
      result: "PASS",
    };
    const receiptWrite = await writeExclusiveCanonical(
      stableReadbackReceiptPath,
      canonicalJsonBytes(readbackReceipt),
      fixture,
    );
    if (receiptWrite.status !== "PASS") return receiptWrite;
    await outputDirectory.handle.sync();
    return pass({ readbackReceipt });
  } finally {
    await outputDirectory?.handle.close().catch(() => undefined);
    await rootDirectory?.handle.close().catch(() => undefined);
  }
}

const WRITE_RECEIPT_KEYS = [
  "schemaVersion",
  "contractSha256",
  "materializationReceiptSha256",
  "controllerReviewReceiptSha256",
  "requestSha256",
  "authorizationReceiptSha256",
  "targetPath",
  "anchorSha256",
  "anchorSize",
  "ownerUid",
  "ownerGid",
  "mode",
  "device",
  "inode",
  "predecessorSha256",
  "fileFsyncSha256",
  "directoryFsyncSha256",
  "prePostToctouSha256",
  "anchorContainsSelfHash",
  "result",
];

export function validateRootAnchorWriteReceipt(receipt, request) {
  if (
    !hasExactKeys(receipt, WRITE_RECEIPT_KEYS) ||
    receipt.schemaVersion !==
      "organization-identity-root-anchor-write-receipt/v1" ||
    receipt.contractSha256 !== request.contractSha256 ||
    receipt.materializationReceiptSha256 !==
      request.materializationReceiptSha256 ||
    receipt.controllerReviewReceiptSha256 !==
      request.controllerReviewReceiptSha256 ||
    receipt.authorizationReceiptSha256 !== request.authorizationReceiptSha256 ||
    receipt.requestSha256 !== sha256(canonicalJsonBytes(request)) ||
    receipt.targetPath !== ANCHOR_PATH ||
    !isSha256(receipt.requestSha256) ||
    !isSha256(receipt.anchorSha256) ||
    receipt.anchorSha256 !== request.canonicalAnchorPayloadSha256 ||
    !Number.isSafeInteger(receipt.anchorSize) ||
    receipt.anchorSize <= 0 ||
    receipt.anchorSize !== request.canonicalAnchorPayloadSize ||
    receipt.ownerUid !== 0 ||
    receipt.ownerGid !== 0 ||
    receipt.mode !== 0o600 ||
    typeof receipt.device !== "string" ||
    receipt.device.length === 0 ||
    typeof receipt.inode !== "string" ||
    receipt.inode.length === 0 ||
    receipt.predecessorSha256 !== null ||
    !isSha256(receipt.fileFsyncSha256) ||
    !isSha256(receipt.directoryFsyncSha256) ||
    !isSha256(receipt.prePostToctouSha256) ||
    receipt.anchorContainsSelfHash !== false ||
    receipt.result !== "PASS"
  ) {
    return integrity("ROOT_ANCHOR_WRITE_RECEIPT_INVALID");
  }
  return pass();
}

const READBACK_KEYS = [
  "schemaVersion",
  "contractSha256",
  "requestSha256",
  "writeReceiptSha256",
  "targetPath",
  "noFollowVerified",
  "ownerUid",
  "ownerGid",
  "mode",
  "device",
  "inode",
  "anchorSha256",
  "anchorSize",
  "canonicalSchemaSha256",
  "inputEvidenceSetSha256",
  "predecessorSha256",
  "anchorContainsSelfHash",
  "prePostToctouSha256",
  "reviewerClass",
  "result",
];

export function validateRootAnchorReadbackReceipt(receipt, writeReceipt) {
  if (
    !hasExactKeys(receipt, READBACK_KEYS) ||
    receipt.schemaVersion !== "organization-identity-root-anchor-readback/v1" ||
    receipt.contractSha256 !== writeReceipt.contractSha256 ||
    receipt.requestSha256 !== writeReceipt.requestSha256 ||
    receipt.writeReceiptSha256 !== sha256(canonicalJsonBytes(writeReceipt)) ||
    receipt.targetPath !== writeReceipt.targetPath ||
    receipt.noFollowVerified !== true ||
    receipt.ownerUid !== writeReceipt.ownerUid ||
    receipt.ownerGid !== writeReceipt.ownerGid ||
    receipt.mode !== writeReceipt.mode ||
    receipt.device !== writeReceipt.device ||
    receipt.inode !== writeReceipt.inode ||
    receipt.anchorSha256 !== writeReceipt.anchorSha256 ||
    receipt.anchorSize !== writeReceipt.anchorSize ||
    !isSha256(receipt.canonicalSchemaSha256) ||
    !isSha256(receipt.inputEvidenceSetSha256) ||
    receipt.predecessorSha256 !== null ||
    receipt.anchorContainsSelfHash !== false ||
    !isSha256(receipt.prePostToctouSha256) ||
    receipt.reviewerClass !== "INDEPENDENT_ROOT_ANCHOR_READBACK" ||
    receipt.result !== "PASS"
  ) {
    return integrity("ROOT_ANCHOR_READBACK_INVALID");
  }
  return pass();
}

const REVIEW_KEYS = [
  "schemaVersion",
  "controllerContractSha256",
  "controllerMaterializationReceiptSha256",
  "controllerReviewReceiptSha256",
  "writeRequestSha256",
  "writeReceiptSha256",
  "readbackReceiptSha256",
  "anchorSha256",
  "reportSha256",
  "counterexampleSetSha256",
  "reviewerClass",
  "critical",
  "important",
  "verdict",
];

export function validateRootAnchorOperationReviewReceipt(receipt, records) {
  if (
    !records ||
    !hasExactKeys(records, [
      "writeRequest",
      "writeReceipt",
      "readbackReceipt",
    ]) ||
    validateRootAnchorWriteReceipt(records.writeReceipt, records.writeRequest)
      .status !== "PASS" ||
    validateRootAnchorReadbackReceipt(
      records.readbackReceipt,
      records.writeReceipt,
    ).status !== "PASS" ||
    !hasExactKeys(receipt, REVIEW_KEYS) ||
    receipt.schemaVersion !==
      "organization-identity-root-anchor-operation-review/v1" ||
    Object.keys(receipt)
      .filter((key) => key.endsWith("Sha256"))
      .some((key) => !isSha256(receipt[key])) ||
    receipt.writeReceiptSha256 === receipt.readbackReceiptSha256 ||
    receipt.writeReceiptSha256 === receipt.anchorSha256 ||
    receipt.readbackReceiptSha256 === receipt.anchorSha256 ||
    receipt.writeRequestSha256 !==
      sha256(canonicalJsonBytes(records.writeRequest)) ||
    receipt.writeReceiptSha256 !==
      sha256(canonicalJsonBytes(records.writeReceipt)) ||
    receipt.readbackReceiptSha256 !==
      sha256(canonicalJsonBytes(records.readbackReceipt)) ||
    receipt.anchorSha256 !== records.writeReceipt.anchorSha256 ||
    receipt.reviewerClass !== "INDEPENDENT_ROOT_ANCHOR_OPERATION_REVIEW" ||
    receipt.critical !== 0 ||
    receipt.important !== 0 ||
    receipt.verdict !== "PASS"
  ) {
    return integrity("ROOT_ANCHOR_OPERATION_REVIEW_INVALID");
  }
  return pass();
}
