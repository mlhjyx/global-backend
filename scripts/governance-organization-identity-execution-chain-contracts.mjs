import { createHash } from "node:crypto";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : canonicalJsonBytes(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export const EXECUTION_CHAIN_CONTRACT_V3 = Object.freeze({
  schemaVersion: "organization-identity-execution-chain-contract/v3",
  requestSchemaVersion: "organization-identity-closed-command-request/v3",
  externalLaunchReceiptSchemaVersion: "organization-identity-external-launch-receipt/v2",
  externalLaunchReceiptFields: Object.freeze([
    "schemaVersion",
    "requestId",
    "commandId",
    "mode",
    "subjectCommit",
    "launcherContractSha256",
    "requestCoreSha256",
    "invocationDescriptorSha256",
    "executableClosureSha256",
    "acceptedAt",
    "result",
  ]),
  outcomeSchemaVersion: "organization-identity-bootstrap-outcome/v1",
  receiptSchemaVersion: "organization-identity-bootstrap-run/v3",
  pathRules: Object.freeze({
    requestRoot: "fixed-materialization-request-root",
    outputRoot: "fixed-materialization-output-root",
    evidenceRoot: "fixed-task0a-sdd-evidence-root",
    directChildOnly: true,
  }),
  outputRules: Object.freeze({
    outcomeMode: 0o600,
    receiptMode: 0o600,
    externalReceiptMode: 0o600,
    ownerUid: 0,
    ownerGid: 0,
    nlink: 1,
    exclusive: true,
    fsyncFileAndParent: true,
  }),
  requestIdRule: "sha256(canonical(core fields only; external receipt SHA is excluded))",
  externalReceiptRule: "external receipt binds requestId/core/subject/contract; full request binds its SHA",
  noShell: true,
  noAutoRetry: true,
});

export const EXECUTION_CHAIN_CONTRACT_V3_SHA256 = sha256(EXECUTION_CHAIN_CONTRACT_V3);
export const REVIEWED_EXECUTION_CHAIN_CONTRACT_V3_SHA256 =
  "86f15888b3c63154b57ac5c768cbf7765cd75b21865853bf3a1646c91624de41";

export function validateExecutionChainContractV3(contract) {
  if (
    canonical(contract) !== canonical(EXECUTION_CHAIN_CONTRACT_V3) ||
    EXECUTION_CHAIN_CONTRACT_V3_SHA256 !== REVIEWED_EXECUTION_CHAIN_CONTRACT_V3_SHA256
  ) {
    return { status: "INTEGRITY_ERROR", code: "EXECUTION_CHAIN_CONTRACT_V3_INVALID" };
  }
  return { status: "PASS", contractSha256: sha256(contract) };
}
