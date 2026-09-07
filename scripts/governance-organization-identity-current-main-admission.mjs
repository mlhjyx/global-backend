import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SAFE_SEGMENT = /^[^\\/\0]+$/u;
const COMMAND_IDS = Object.freeze([
  "COPY_WRITE_ELIGIBILITY_V1",
  "COPY_SYNC_CITATIONS_V1",
]);
const ALLOWED_STALE_PATHS = Object.freeze(["packages/db/prisma/schema.prisma"]);
const DECISION_CODES = Object.freeze([
  "APPROVAL_INDEPENDENCE_NOT_PROVEN",
  "CURRENT_MAIN_READBACK_NOT_PROVEN",
  "PROPOSAL_BYTES_MISMATCH",
  "REPOSITORY_IDENTITY_INVALID",
  "REQUIRED_FILE_SET_INVALID",
  "COPY_FIXED_SOURCE_STALE",
  "COPY_DISPATCH_NOT_AUTHORIZED",
  "EXTERNAL_PROVENANCE_UNVERIFIED",
  "SCHEMA_UNKNOWN_KEY",
  "DIGEST_MISMATCH",
]);
const SECRET_KEYS = /(?:token|bearer|authorization|api[_-]?key|password|secret|credential|raw[_-]?response|prompt|output)/iu;

export const ADMISSION_INPUT_KEYS = Object.freeze([
  "schema_version",
  "purpose",
  "repository",
  "base_commit",
  "candidate_commit",
  "current_main",
  "proposal",
  "required_files",
  "copy_impact",
  "external_provenance",
]);
export const ADMISSION_DECISION_KEYS = Object.freeze([
  "schema_version",
  "outcome",
  "blocking_code",
  "checks",
  "canonical_input_sha256",
  "observed_commit",
  "copy_impact_status",
  "required_followup",
]);

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

function isPassivePlain(value, seen = new Set()) {
  if (value === null) return true;
  if (typeof value === "string") return value.normalize("NFC") === value;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length !== 0) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return Object.entries(descriptors).every(([key, descriptor]) =>
        key === "length" ||
        (/^(0|[1-9][0-9]*)$/u.test(key) &&
          "value" in descriptor &&
          !descriptor.get &&
          !descriptor.set &&
          isPassivePlain(descriptor.value, seen)),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) =>
        "value" in descriptor &&
        !descriptor.get &&
        !descriptor.set &&
        isPassivePlain(descriptor.value, seen),
    );
  } finally {
    seen.delete(value);
  }
}

export function hasExactKeys(value, keys) {
  return (
    isPassivePlain(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function hold(code, extra = {}) {
  return { status: "HOLD", code, ...extra };
}

function pass(extra = {}) {
  return { status: "PASS", ...extra };
}

function validPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment))
  );
}

function validCommit(value) {
  return typeof value === "string" && COMMIT.test(value);
}

function validSha(value) {
  return typeof value === "string" && SHA256.test(value);
}

function validUtc(value) {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    value === new Date(value).toISOString();
}

function validateRepository(repository) {
  if (!hasExactKeys(repository, ["host", "owner", "name", "full_name"])) {
    return hold("REPOSITORY_IDENTITY_INVALID");
  }
  if (
    !/^[a-z0-9.-]+$/u.test(repository.host) ||
    !/^[A-Za-z0-9_.-]+$/u.test(repository.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(repository.name) ||
    repository.full_name !== `${repository.owner}/${repository.name}`
  ) {
    return hold("REPOSITORY_IDENTITY_INVALID");
  }
  return pass();
}

function validateRequiredFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return hold("REQUIRED_FILE_SET_INVALID");
  }
  const seen = new Set();
  let previous = "";
  for (const file of files) {
    if (!hasExactKeys(file, ["path", "byte_sha256", "role"])) {
      return hold("REQUIRED_FILE_SET_INVALID");
    }
    if (!validPath(file.path) || seen.has(file.path) || file.path <= previous) {
      return hold("REQUIRED_FILE_SET_INVALID");
    }
    if (!validSha(file.byte_sha256) || !["policy", "schema", "validator", "test", "codeowners"].includes(file.role)) {
      return hold("REQUIRED_FILE_SET_INVALID");
    }
    seen.add(file.path);
    previous = file.path;
  }
  return pass();
}

function validateCopyImpact(copy) {
  const keys = [
    "schema_version", "status", "active_binding_path", "active_binding_artifact_id",
    "active_binding_source_bundle_digest", "current_source_fingerprint", "dispatch_authorization",
    "pilot_eligibility", "drifted_paths", "required_followup", "stale_scope",
  ];
  if (!hasExactKeys(copy, keys) || copy.schema_version !== "site-builder-copy-runtime-eligibility/v1") {
    return hold("COPY_FIXED_SOURCE_SAFETY_BOUNDARY_INVALID");
  }
  if (
    !["CURRENT", "STALE_HOLD"].includes(copy.status) ||
    !validPath(copy.active_binding_path) ||
    typeof copy.active_binding_artifact_id !== "string" ||
    !validSha(copy.active_binding_source_bundle_digest) ||
    !validSha(copy.current_source_fingerprint) ||
    copy.dispatch_authorization !== "NOT_AUTHORIZED" ||
    copy.pilot_eligibility !== "BLOCKED" ||
    !Array.isArray(copy.drifted_paths) ||
    copy.drifted_paths.some((value) => !validPath(value)) ||
    typeof copy.required_followup !== "string" ||
    typeof copy.stale_scope !== "string"
  ) {
    return hold("COPY_FIXED_SOURCE_SAFETY_BOUNDARY_INVALID");
  }
  const sortedDrifted = [...copy.drifted_paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (copy.drifted_paths.some((value, index) => value !== sortedDrifted[index]) || new Set(copy.drifted_paths).size !== copy.drifted_paths.length) {
    return hold("COPY_FIXED_SOURCE_DRIFT_PATHS_MISMATCH");
  }
  if (copy.status === "CURRENT" && copy.drifted_paths.length !== 0) {
    return hold("COPY_FIXED_SOURCE_DRIFT_PATHS_MISMATCH");
  }
  if (copy.status === "STALE_HOLD" && (copy.drifted_paths.length === 0 || copy.drifted_paths.some((value) => !ALLOWED_STALE_PATHS.includes(value)) || copy.stale_scope !== "PRISMA_SCHEMA_EVOLUTION")) {
    return hold("COPY_FIXED_SOURCE_DRIFT_PATHS_MISMATCH");
  }
  if (copy.status === "CURRENT" && copy.stale_scope !== "NONE") return hold("COPY_FIXED_SOURCE_STALE_SCOPE_INVALID");
  return pass();
}

export function validateCurrentMainAdmissionInput(input) {
  if (!hasExactKeys(input, ADMISSION_INPUT_KEYS)) return hold("SCHEMA_UNKNOWN_KEY");
  if (input.schema_version !== "current-main-admission-input/v1" || input.purpose !== "trusted_approval_current_main") {
    return hold("SCHEMA_VERSION_INVALID");
  }
  const repository = validateRepository(input.repository);
  if (repository.status !== "PASS") return repository;
  if (!validCommit(input.base_commit) || !validCommit(input.candidate_commit)) {
    return hold("COMMIT_INVALID");
  }
  if (!hasExactKeys(input.current_main, ["ref", "commit", "observed_at"]) || input.current_main.ref !== "refs/heads/main" || !validCommit(input.current_main.commit) || !validUtc(input.current_main.observed_at)) {
    return hold("CURRENT_MAIN_READBACK_NOT_PROVEN");
  }
  if (!hasExactKeys(input.proposal, ["path", "byte_sha256", "semantic_sha256", "revision"]) || !validPath(input.proposal.path) || !validSha(input.proposal.byte_sha256) || !validSha(input.proposal.semantic_sha256) || typeof input.proposal.revision !== "string" || input.proposal.revision.length === 0) {
    return hold("PROPOSAL_BYTES_MISMATCH");
  }
  const files = validateRequiredFiles(input.required_files);
  if (files.status !== "PASS") return files;
  const copy = validateCopyImpact(input.copy_impact);
  if (copy.status !== "PASS") return copy;
  if (!hasExactKeys(input.external_provenance, ["status", "verifier_id", "readback_id", "source", "observed_at"]) || !["EXTERNAL_UNVERIFIED", "KNOWN_EXTERNAL_HOLD"].includes(input.external_provenance.status) || typeof input.external_provenance.verifier_id !== "string" || typeof input.external_provenance.readback_id !== "string" || !["github", "hosted_control_plane", "other"].includes(input.external_provenance.source) || !validUtc(input.external_provenance.observed_at)) {
    return hold("EXTERNAL_PROVENANCE_UNVERIFIED");
  }
  return pass();
}

export function validateCurrentMainAdmissionDecision(decision) {
  if (!hasExactKeys(decision, ADMISSION_DECISION_KEYS)) return hold("SCHEMA_UNKNOWN_KEY");
  if (decision.schema_version !== "current-main-admission-decision/v1" || !["HOLD", "READY_FOR_EXTERNAL_READBACK"].includes(decision.outcome) || !DECISION_CODES.includes(decision.blocking_code) || !hasExactKeys(decision.checks, ["repository", "required_files", "copy_impact", "external_provenance"]) || decision.checks.repository !== "PASS" || decision.checks.required_files !== "PASS" || !["CURRENT", "STALE_HOLD"].includes(decision.checks.copy_impact) || !["EXTERNAL_UNVERIFIED", "KNOWN_EXTERNAL_HOLD"].includes(decision.checks.external_provenance) || !validSha(decision.canonical_input_sha256) || !validCommit(decision.observed_commit) || !["CURRENT", "STALE_HOLD"].includes(decision.copy_impact_status) || !["OBTAIN_INDEPENDENT_CURRENT_MAIN_READBACK_AND_REVIEW", "REBASE_FIXED_SOURCE_BEFORE_DISPATCH"].includes(decision.required_followup)) return hold("DECISION_SCHEMA_INVALID");
  if (decision.outcome === "HOLD" && decision.blocking_code === "") return hold("DECISION_BLOCKER_REQUIRED");
  return pass();
}

function runGit(repoRoot, args) {
  const allowed = new Set(["rev-parse", "merge-base", "rev-list", "diff", "show-ref", "cat-file"]);
  if (!allowed.has(args[0])) throw new Error("GIT_COMMAND_NOT_ALLOWED");
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
}

function parseNameStatusNul(bytes) {
  const fields = bytes.toString("utf8").split("\0").filter(Boolean);
  const records = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (/^[RC]/u.test(status)) return hold("RENAME_COPY_STATUS_UNSUPPORTED");
    if (!/^[A-Z][0-9]*$/u.test(status) || !validPath(fields[index + 1])) return hold("CURRENT_MAIN_PATH_SET_MISMATCH");
    records.push({ status, path: fields[index + 1] });
    index += 1;
  }
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(records.map(({ path: filePath }) => filePath)).size !== records.length) return hold("CURRENT_MAIN_PATH_SET_MISMATCH");
  return pass({ records, pathSetSha256: sha256(Buffer.from(records.map(({ path: filePath }) => `${filePath}\0`).join(""), "utf8")) });
}

export function collectCurrentMainAuditFacts({ repositoryRoot, branch = "HEAD", liveMain }) {
  try {
    const branchCommit = runGit(repositoryRoot, ["rev-parse", branch]).toString().trim();
    const advertisedMain = runGit(repositoryRoot, ["rev-parse", "refs/remotes/origin/main"]).toString().trim();
    if (liveMain !== undefined && liveMain !== advertisedMain) return hold("CURRENT_MAIN_READBACK_NOT_PROVEN");
    const mainCommit = advertisedMain;
    if (!validCommit(branchCommit) || !validCommit(mainCommit)) return hold("CURRENT_MAIN_READBACK_NOT_PROVEN");
    const mergeBase = runGit(repositoryRoot, ["merge-base", branchCommit, mainCommit]).toString().trim();
    if (!validCommit(mergeBase)) return hold("CURRENT_MAIN_READBACK_NOT_PROVEN");
    const pathFacts = parseNameStatusNul(runGit(repositoryRoot, ["diff", "--name-status", "-z", "--find-renames=100%", "--find-copies=100%", "--find-copies-harder", mergeBase, mainCommit]));
    if (pathFacts.status !== "PASS") return pathFacts;
    const afterMain = runGit(repositoryRoot, ["rev-parse", "refs/remotes/origin/main"]).toString().trim();
    if (afterMain !== advertisedMain) return hold("CURRENT_MAIN_READBACK_NOT_PROVEN");
    if (!validCommit(branch) && runGit(repositoryRoot, ["rev-parse", branch]).toString().trim() !== branchCommit) return hold("CURRENT_MAIN_READBACK_NOT_PROVEN");
    return pass({ branchCommit, liveMainCommit: mainCommit, mergeBaseCommit: mergeBase, mainOnlyPaths: pathFacts.records, mainOnlyPathSetSha256: pathFacts.pathSetSha256 });
  } catch {
    return hold("CURRENT_MAIN_READBACK_NOT_PROVEN");
  }
}

export function generateCurrentMainAdmission(input) {
  const valid = validateCurrentMainAdmissionInput(input);
  if (valid.status !== "PASS") return valid;
  const blocker = input.external_provenance.status === "KNOWN_EXTERNAL_HOLD"
    ? "APPROVAL_INDEPENDENCE_NOT_PROVEN"
    : "EXTERNAL_PROVENANCE_UNVERIFIED";
  const decision = {
    schema_version: "current-main-admission-decision/v1",
    outcome: "HOLD",
    blocking_code: blocker,
    checks: { repository: "PASS", required_files: "PASS", copy_impact: input.copy_impact.status, external_provenance: input.external_provenance.status },
    canonical_input_sha256: sha256(canonicalJsonBytes(input)),
    observed_commit: input.current_main.commit,
    copy_impact_status: input.copy_impact.status,
    required_followup: "OBTAIN_INDEPENDENT_CURRENT_MAIN_READBACK_AND_REVIEW",
  };
  return pass({ decision, validation: validateCurrentMainAdmissionDecision(decision) });
}

export function buildCopyCommandDescriptor(commandId, parameters) {
  if (!COMMAND_IDS.includes(commandId) || !isPassivePlain(parameters) || Object.keys(parameters).some((key) => SECRET_KEYS.test(key))) return hold("COMMAND_DESCRIPTOR_INVALID");
  const allowed = commandId === "COPY_WRITE_ELIGIBILITY_V1"
    ? ["auditPacketSha256", "eligibilityPath"]
    : ["auditPacketSha256", "eligibilityPath", "eligibilityInputSha256", "citationPath"];
  if (!hasExactKeys(parameters, allowed) || Object.values(parameters).some((value) => typeof value !== "string" || value.length > 512)) return hold("COMMAND_DESCRIPTOR_INVALID");
  return pass({ commandId, mode: commandId === "COPY_WRITE_ELIGIBILITY_V1" ? "WRITE_ELIGIBILITY" : "SYNC_CITATIONS", parameters: JSON.parse(JSON.stringify(parameters)), dispatchAuthorization: "NOT_AUTHORIZED" });
}

if (process.argv[1] && process.argv[1].endsWith("current-main-admission.mjs")) {
  const [action, repositoryRoot, liveMain] = process.argv.slice(2);
  if (action === "audit" && repositoryRoot) {
    process.stdout.write(`${JSON.stringify(collectCurrentMainAuditFacts({ repositoryRoot, liveMain }))}\n`);
  } else {
    process.stderr.write(`${JSON.stringify(hold("CLI_USAGE"))}\n`);
    process.exitCode = 64;
  }
}
