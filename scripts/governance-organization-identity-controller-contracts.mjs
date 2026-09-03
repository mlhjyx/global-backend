import { createHash } from "node:crypto";
import path from "node:path";

export const EXTERNAL_EXECUTABLE_ROLES = Object.freeze([
  "ENV",
  "NODE",
  "GIT",
  "GH",
  "GITLEAKS",
  "DOCKER",
  "PSQL",
  "COREPACK_SHIM",
  "COREPACK_LIB_COREPACK_CJS",
  "PNPM_SHIM",
  "PNPM_ENTRYPOINT",
  "PRISMA_CLI",
]);

export const CONTROLLER_CLASSES = Object.freeze([
  "GITHUB",
  "DISPOSABLE_POSTGRES",
  "GITLEAKS",
  "ROOT_ANCHOR",
  "PROTECTED_BASE_LAUNCHER",
]);

export function pass(extra = {}) {
  return { status: "PASS", ...extra };
}

export function integrity(code) {
  return { status: "INTEGRITY_ERROR", code };
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isGitObjectId(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

export function isAbsoluteNormalizedPath(value) {
  return (
    typeof value === "string" &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.includes("\0")
  );
}

export function hasExactKeys(value, keys) {
  if (!isPassivePlainData(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function isPassivePlainData(value, seen = new Set()) {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string") return value.normalize("NFC") === value;
  if (type === "number") return Number.isFinite(value);
  if (type === "boolean") return true;
  if (type !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length") continue;
        if (!("value" in descriptor) || descriptor.get || descriptor.set)
          return false;
        if (!isPassivePlainData(descriptor.value, seen)) return false;
      }
      return Object.keys(value).every((key, index) => key === String(index));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || descriptor.get || descriptor.set)
        return false;
      if (!isPassivePlainData(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

export function valuesEqual(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected);
}

export function validateExternalExecutableClosure(entries, expectedRoles) {
  if (!Array.isArray(entries) || !Array.isArray(expectedRoles)) {
    return integrity("EXECUTABLE_CLOSURE_INVALID");
  }
  if (
    !valuesEqual(expectedRoles, [...new Set(expectedRoles)]) ||
    expectedRoles.some((role) => !EXTERNAL_EXECUTABLE_ROLES.includes(role)) ||
    entries.length !== expectedRoles.length
  ) {
    return integrity("EXECUTABLE_CLOSURE_INVALID");
  }
  const keys = [
    "role",
    "logicalIdentity",
    "executablePath",
    "realpathSha256",
    "sha256",
    "size",
  ];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (
      !hasExactKeys(entry, keys) ||
      entry.role !== expectedRoles[index] ||
      typeof entry.logicalIdentity !== "string" ||
      entry.logicalIdentity.length === 0 ||
      !isAbsoluteNormalizedPath(entry.executablePath) ||
      !isSha256(entry.realpathSha256) ||
      !isSha256(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      return integrity("EXECUTABLE_CLOSURE_INVALID");
    }
  }
  return pass({
    executableClosureSetSha256: sha256(canonicalJsonBytes(entries)),
  });
}

export function validateCredentialHandleBinding(binding) {
  if (
    !hasExactKeys(binding, [
      "provider",
      "handleSha256",
      "scopeSha256",
      "injectedByFileDescriptor",
      "valuePersisted",
      "valueEmitted",
    ]) ||
    !["ROOT_SECRET_STORE", "GITHUB_ACTIONS_SECRET"].includes(
      binding.provider,
    ) ||
    !isSha256(binding.handleSha256) ||
    !isSha256(binding.scopeSha256) ||
    binding.injectedByFileDescriptor !== true ||
    binding.valuePersisted !== false ||
    binding.valueEmitted !== false
  ) {
    return integrity("CREDENTIAL_HANDLE_INVALID");
  }
  return pass();
}

export function validateExternalControllerMaterializationReceipt(
  receipt,
  expectedClass,
) {
  if (
    !hasExactKeys(receipt, [
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
    receipt.schemaVersion !==
      "organization-identity-external-controller-materialization/v1" ||
    !CONTROLLER_CLASSES.slice(0, 4).includes(expectedClass) ||
    receipt.controllerClass !== expectedClass ||
    receipt.ownerUid !== 0 ||
    receipt.ownerGid !== 0 ||
    receipt.directoryMode !== 0o700 ||
    receipt.controllerMode !== 0o500 ||
    receipt.recordMode !== 0o600 ||
    receipt.result !== "PASS"
  ) {
    return integrity("CONTROLLER_MATERIALIZATION_INVALID");
  }
  for (const key of [
    "contractSha256",
    "controllerSourceSha256",
    "rootDirectorySha256",
    "requestRootSha256",
    "outputRootSha256",
    "executableClosureSetSha256",
    "environmentSchemaSha256",
    "prePostToctouSha256",
  ]) {
    if (!isSha256(receipt[key])) {
      return integrity("CONTROLLER_MATERIALIZATION_INVALID");
    }
  }
  return pass();
}

export function validateControllerReviewReceipt(receipt, expectedClass) {
  if (
    !hasExactKeys(receipt, [
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
    receipt.schemaVersion !== "organization-identity-controller-review/v1" ||
    receipt.controllerClass !== expectedClass ||
    receipt.reviewerClass !== "INDEPENDENT_CONTROLLER_SECURITY_REVIEW" ||
    receipt.critical !== 0 ||
    receipt.important !== 0 ||
    receipt.verdict !== "PASS" ||
    !isSha256(receipt.contractSha256) ||
    !isSha256(receipt.requestSchemaSha256) ||
    !isSha256(receipt.reportSha256) ||
    !isSha256(receipt.counterexampleSetSha256)
  ) {
    return integrity("CONTROLLER_REVIEW_INVALID");
  }
  const materializationAllowed =
    expectedClass === "PROTECTED_BASE_LAUNCHER"
      ? receipt.materializationReceiptSha256 === null
      : isSha256(receipt.materializationReceiptSha256);
  if (!materializationAllowed) return integrity("CONTROLLER_REVIEW_INVALID");
  return pass();
}

export function validateExactEnvironmentNames(actual, expected) {
  if (!valuesEqual(actual, expected)) {
    return integrity("ENVIRONMENT_NAME_SET_INVALID");
  }
  return pass();
}

export function validateOutputPath(outputRecordPath, outputRoot) {
  if (
    !isAbsoluteNormalizedPath(outputRecordPath) ||
    !isAbsoluteNormalizedPath(outputRoot) ||
    path.posix.dirname(outputRecordPath) !== outputRoot ||
    !outputRecordPath.endsWith(".json")
  ) {
    return integrity("OUTPUT_PATH_INVALID");
  }
  return pass();
}
