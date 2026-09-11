import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";

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

function valuesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function isPassivePlain(value, seen = new Set()) {
  if (types.isProxy(value) || seen.size > 64) return false;
  if (value === null) return true;
  if (typeof value === "string") return value.normalize("NFC") === value;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 4096 || Object.keys(value).length !== value.length) return false;
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
    value !== null && typeof value === "object" && !types.isProxy(value) && !Array.isArray(value) &&
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

const keys = text => text.split(" ");
const nullableBlob = value => value === null || validCommit(value);
function sortedUnique(values, predicate, nonempty = false) {
  return Array.isArray(values) && (!nonempty || values.length > 0) &&
    values.every((value, index) => predicate(value) && (index === 0 || values[index - 1] < value));
}
const CLASSIFICATIONS = keys("BUILD RAW_CAPABILITY PRISMA_SCHEMA MIGRATION GOVERNANCE RUNTIME_ARTIFACT IDENTITY_CALLER IDENTITY_AUTHORITY GENERATED_EVIDENCE OTHER");
const DISPOSITIONS = keys("ADMIT_IDENTITY_AUTHORITY_UNCHANGED ADMIT_IDENTITY_IRRELEVANT ADMIT_GENERATED_MAIN_BYTES ADMIT_GENERATED_REBUILT");
const GENERATORS = keys("COPY_FIXED_SOURCE_WRITE_ELIGIBILITY_V1 COPY_FIXED_SOURCE_SYNC_HUMAN_CITATIONS_V1");
function validOwner(owner) {
  return hasExactKeys(owner, keys("source codeownersBlobId matchedRule principals resolution")) &&
    owner.source === "CODEOWNERS" && validCommit(owner.codeownersBlobId) &&
    typeof owner.matchedRule === "string" && owner.matchedRule.length > 0 &&
    sortedUnique(owner.principals, p => typeof p === "string" && /^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/u.test(p), true) &&
    owner.resolution === "EXACT";
}

// Deliberately supports the anchored literal, directory, * and **/ forms used
// in this repository. Unsupported syntax holds the whole resolution instead
// of silently falling back to an earlier, broader owner rule.
export function resolveAdmissionOwner(bytes, blobId, repoPath) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024 || !validCommit(blobId) || !validPath(repoPath)) return hold("CODEOWNERS_INPUT_INVALID");
  const source = bytes.toString("utf8");
  if (!Buffer.from(source).equals(bytes)) return hold("CODEOWNERS_ENCODING_INVALID");
  let selected = null;
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [pattern, ...owners] = trimmed.split(/[ \t]+/u);
    const principals = owners.slice(0, owners.findIndex(x => x.startsWith("#")) < 0 ? owners.length : owners.findIndex(x => x.startsWith("#")));
    if ((pattern !== "*" && !pattern.startsWith("/")) || /[!\[\]\\?\x00-\x1f]/u.test(pattern) ||
        principals.some(p => !/^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/u.test(p))) return hold("CODEOWNERS_SYNTAX_UNSUPPORTED");
    let expression = "^";
    const body = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    for (let index = 0; index < body.length; index++) {
      if (body.slice(index, index + 3) === "**/") { expression += "(?:[^/]+/)*"; index += 2; }
      else if (body.slice(index, index + 2) === "**") return hold("CODEOWNERS_SYNTAX_UNSUPPORTED");
      else if (body[index] === "*") expression += "[^/]*";
      else expression += body[index].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
    expression += body.endsWith("/") ? ".+$" : "(?:/.*)?$";
    if (pattern === "*" || new RegExp(expression, "u").test(repoPath)) {
      selected = { source: "CODEOWNERS", codeownersBlobId: blobId, matchedRule: pattern,
        principals: [...new Set(principals)].sort(), resolution: "EXACT" };
    }
  }
  return selected?.principals.length ? pass({ owner: selected }) : hold("CODEOWNERS_UNRESOLVED");
}
function validRebuild(record) {
  return hasExactKeys(record, keys("generatorSourceCommit commandId inputSha256 outputBlobId outputSha256 generatedJsonSchemaSha256 generatedJsonReadbackSha256 humanCitationReadbackSha256")) &&
    validCommit(record.generatorSourceCommit) && validCommit(record.outputBlobId) &&
    GENERATORS.includes(record.commandId) && Object.keys(record).filter(k => k.endsWith("Sha256")).every(k => validSha(record[k]));
}
function validAdmissionPath(record) {
  if (!hasExactKeys(record, keys("path changeKind baseBlobId branchBlobId mainBlobId resultBlobId classifications owner evidenceSha256 disposition generatedRebuild"))) return false;
  return validPath(record.path) && ["ADD", "MODIFY", "DELETE"].includes(record.changeKind) &&
    [record.baseBlobId, record.branchBlobId, record.mainBlobId, record.resultBlobId].every(nullableBlob) &&
    (record.baseBlobId === null) === (record.changeKind === "ADD") &&
    (record.mainBlobId === null) === (record.changeKind === "DELETE") &&
    sortedUnique(record.classifications, c => CLASSIFICATIONS.includes(c), true) &&
    validOwner(record.owner) && sortedUnique(record.evidenceSha256, validSha, true) &&
    DISPOSITIONS.includes(record.disposition) &&
    (record.disposition === "ADMIT_GENERATED_REBUILT" ? validRebuild(record.generatedRebuild) : record.generatedRebuild === null);
}
function validConflict(record) {
  return hasExactKeys(record, keys("path hunkCount baseBlobId branchBlobId mainBlobId resultBlobId resolutionSource")) &&
    validPath(record.path) && Number.isSafeInteger(record.hunkCount) && record.hunkCount > 0 &&
    [record.baseBlobId, record.branchBlobId, record.mainBlobId].every(nullableBlob) && validCommit(record.resultBlobId) &&
    ["LIVE_MAIN_GIT_BLOB", ...GENERATORS].includes(record.resolutionSource);
}
function validMigration(record) {
  return hasExactKeys(record, keys("name path resultBlobId migrationSqlSha256 lastChangeCommit mainOnly artifactARelationship disposition")) &&
    typeof record.name === "string" && /^[0-9]{14}_[A-Za-z0-9_]+$/u.test(record.name) &&
    record.path === `packages/db/prisma/migrations/${record.name}/migration.sql` &&
    validCommit(record.resultBlobId) && validSha(record.migrationSqlSha256) && validCommit(record.lastChangeCommit) &&
    typeof record.mainOnly === "boolean" &&
    ["EXACT_ARTIFACT_A_BLOB", "POST_ARTIFACT_A_MAIN_ONLY", "PREEXISTING_NON_IDENTITY"].includes(record.artifactARelationship) &&
    ["IDENTITY_AUTHORITY_UNCHANGED", "IDENTITY_IRRELEVANT"].includes(record.disposition);
}

// This checks the approved record shape only; mechanical Git/owner/migration
// observations are still required before the record can establish admission.
export function validateCurrentMainAdmissionStructure(document) {
  const required = keys("schemaVersion status artifactACommit branchPreRefreshCommit liveMainCommit mergeBaseCommit refreshMergeCommit refreshParents mainOnlyRange mainOnlyPathCount mainOnlyPathSetSha256 paths conflicts migrations rawDeltaSha256 buildDeltaSha256 schemaDeltaSha256 callerDeltaSha256 review");
  if (!hasExactKeys(document, required)) return hold("ADMISSION_SCHEMA_INVALID");
  if (document.schemaVersion !== "organization-identity-current-main-admission/v1" || document.status !== "ADMITTED" ||
      document.artifactACommit !== "2400bac28796bae44294114edc99eaccb1bd65b3" ||
      !keys("branchPreRefreshCommit liveMainCommit mergeBaseCommit refreshMergeCommit").every(k => validCommit(document[k])) ||
      !valuesEqual(document.refreshParents, [document.branchPreRefreshCommit, document.liveMainCommit]) ||
      document.mainOnlyRange !== `${document.mergeBaseCommit}..${document.liveMainCommit}`) return hold("ADMISSION_IDENTITY_INVALID");
  for (const [field, validate] of [["paths", validAdmissionPath], ["conflicts", validConflict], ["migrations", validMigration]]) {
    const records = document[field];
    if (!Array.isArray(records) || !records.every(validate) ||
        !sortedUnique(records.map(r => r.path), validPath) ||
        new Set(records.map(r => r.path.toLowerCase())).size !== records.length) return hold("ADMISSION_RECORD_INVALID");
  }
  const pathDigest = sha256(Buffer.from(document.paths.map(r => `${r.path}\0`).join("")));
  if (document.mainOnlyPathCount !== document.paths.length || document.mainOnlyPathSetSha256 !== pathDigest) return hold("CURRENT_MAIN_PATH_SET_MISMATCH");
  if (!keys("rawDeltaSha256 buildDeltaSha256 schemaDeltaSha256 callerDeltaSha256").every(k => validSha(document[k])) ||
      !hasExactKeys(document.review, keys("auditPacketSha256 auditReviewReceiptSha256 reportSha256 verdict")) ||
      document.review.verdict !== "PASS" || !keys("auditPacketSha256 auditReviewReceiptSha256 reportSha256").every(k => validSha(document.review[k]))) return hold("ADMISSION_REVIEW_INVALID");
  return pass({ evidenceClass: "STRUCTURE_ONLY" });
}

const AUDIT_REVIEW_KEYS = Object.freeze([
  "schemaVersion", "disposition", "auditPacketSha256", "githubControllerContractSha256",
  "githubControllerReviewReceiptSha256", "protectedMainReadbackReceiptSha256",
  "localBootstrapRunReceiptSetSha256", "branchPreRefreshCommit", "advertisedLiveMainCommit",
  "mergeBaseCommit", "mainOnlyPathSetSha256", "conflictSetSha256", "migrationSetSha256",
  "dispositionSetSha256", "authorizationRequestSha256", "fetchReceiptSha256", "reportSha256",
  "counterexampleSetSha256", "reviewerClass", "critical", "important", "verdict",
]);

// Structural and equality checking only. The caller must obtain expected facts
// from independently verified artifacts; matching JSON does not establish trust.
export function validateAuditReviewReceipt(receipt, expected) {
  if (!hasExactKeys(receipt, AUDIT_REVIEW_KEYS)) return hold("AUDIT_REVIEW_SCHEMA_INVALID");
  if (receipt.schemaVersion !== "organization-identity-current-main-audit-review/v1" ||
      !["PASS", "FETCH_AUTH_REQUIRED"].includes(receipt.disposition) ||
      receipt.reviewerClass !== "INDEPENDENT_ADMISSION_AUDIT_REVIEW" ||
      receipt.critical !== 0 || receipt.important !== 0 || receipt.verdict !== "PASS" ||
      !validCommit(receipt.branchPreRefreshCommit) || !validCommit(receipt.advertisedLiveMainCommit)) {
    return hold("AUDIT_REVIEW_SCHEMA_INVALID");
  }
  const deferred = new Set(["mainOnlyPathSetSha256", "conflictSetSha256", "migrationSetSha256", "dispositionSetSha256"]);
  for (const key of AUDIT_REVIEW_KEYS.filter(key => key.endsWith("Sha256"))) {
    if (receipt[key] === null && (key === "fetchReceiptSha256" ||
        (receipt.disposition === "FETCH_AUTH_REQUIRED" && deferred.has(key)))) continue;
    if (!validSha(receipt[key])) return hold("AUDIT_REVIEW_SCHEMA_INVALID");
  }
  if (!validCommit(receipt.mergeBaseCommit) &&
      !(receipt.disposition === "FETCH_AUTH_REQUIRED" && receipt.mergeBaseCommit === null)) {
    return hold("AUDIT_REVIEW_SCHEMA_INVALID");
  }
  if (!hasExactKeys(expected, AUDIT_REVIEW_KEYS)) return hold("AUDIT_REVIEW_EXPECTED_FACTS_REQUIRED");
  if (!valuesEqual(receipt, expected)) return hold("AUDIT_REVIEW_BINDING_MISMATCH");
  return pass({ evidenceClass: "STRUCTURE_AND_BINDING_ONLY" });
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
  const allowed = new Set(["rev-parse", "merge-base", "rev-list", "diff", "show-ref", "cat-file", "config"]);
  if (!allowed.has(args[0])) throw new Error("GIT_COMMAND_NOT_ALLOWED");
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
}

// Exact commit-only reads: no mutable refs, shell, hooks, external diff or lazy
// object fetch. These observations describe local objects, not remote freshness.
function readObjectGit(repoRoot, args) {
  const env = {
    PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "",
  };
  return execFileSync("/usr/bin/git", ["-C", repoRoot, ...args], {
    env, timeout: 15000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}
function readTreeFacts(repoRoot, commit) {
  const bytes = readObjectGit(repoRoot, ["ls-tree", "-rz", "--full-tree", commit]);
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded).equals(bytes) || (bytes.length && !decoded.endsWith("\0"))) throw Error("TREE_ENCODING_INVALID");
  const rows = decoded.split("\0").slice(0, -1).map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row);
    if (!match || !validPath(match[3]) || match[3].normalize("NFC") !== match[3]) throw Error("TREE_ENTRY_UNSUPPORTED");
    return { path: match[3], blobId: match[2], mode: match[1] };
  });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (rows.length > 20000 || new Set(rows.map(r => r.path.toLowerCase())).size !== rows.length) throw Error("TREE_SET_INVALID");
  return rows;
}

const collectedObjectFacts = new WeakSet();
export function collectThreeWayConflictFacts(options) {
  if (!hasExactKeys(options, keys("repoRoot mergeBaseCommit branchPreRefreshCommit liveMainCommit")) ||
      typeof options.repoRoot !== "string" || !path.isAbsolute(options.repoRoot) ||
      !keys("mergeBaseCommit branchPreRefreshCommit liveMainCommit").every(k => validCommit(options[k]))) return hold("CONFLICT_INPUT_INVALID");
  try {
    const { repoRoot, mergeBaseCommit: base, branchPreRefreshCommit: branch, liveMainCommit: main } = options;
    const trees = [base, branch, main].map(commit => readTreeFacts(repoRoot, commit));
    // Attribute-controlled merge drivers and source marker collisions need a
    // separate reviewed parser path. Never execute or guess their semantics.
    if (trees.some(rows => rows.some(r => r.path.split("/").at(-1) === ".gitattributes"))) return hold("MERGE_ATTRIBUTES_UNSUPPORTED");
    const maps = trees.map(rows => new Map(rows.map(r => [r.path, r.blobId])));
    const overlapping = [...new Set(trees.flatMap(rows => rows.map(r => r.path)))].filter(p => maps[0].get(p) !== maps[1].get(p) && maps[0].get(p) !== maps[2].get(p));
    let scanned = 0;
    for (const p of overlapping) for (const map of maps) {
      const blob = map.get(p); if (!blob) continue;
      const bytes = readObjectGit(repoRoot, ["cat-file", "blob", blob]);
      scanned += bytes.length;
      if (scanned > 64 * 1024 * 1024 || bytes.includes(0) || /^(?:<<<<<<<|=======|>>>>>>>)/mu.test(bytes.toString("utf8"))) return hold("CONFLICT_SOURCE_UNSUPPORTED");
    }
    const raw = readObjectGit(repoRoot, ["-c", "core.attributesFile=/dev/null", "merge-tree", base, branch, main]);
    const text = raw.toString("utf8");
    if (!Buffer.from(text).equals(raw)) return hold("CONFLICT_ENCODING_INVALID");
    const conflicts = [];
    let block = null;
    const finish = () => {
      if (!block) return;
      if (block.starts !== block.ends || block.starts !== block.separators) throw Error("CONFLICT_MARKERS_UNBALANCED");
      if (!block.starts) return;
      if (block.paths.size !== 1) throw Error("CONFLICT_PATH_AMBIGUOUS");
      const p = [...block.paths][0];
      conflicts.push({ path: p, hunkCount: block.starts, baseBlobId: maps[0].get(p) ?? null,
        branchBlobId: maps[1].get(p) ?? null, mainBlobId: maps[2].get(p) ?? null });
    };
    for (const line of text.split("\n")) {
      if (/^(changed in both|added in both|merged|removed in both|removed in local|removed in remote|added in remote|added in local)$/u.test(line)) {
        finish(); block = { paths: new Set(), starts: 0, separators: 0, ends: 0 }; continue;
      }
      const stage = /^  (?:base|our|their)  (?:100644|100755) [a-f0-9]{40} ([\s\S]+)$/u.exec(line);
      if (stage && block) { if (!validPath(stage[1]) || !maps.some(m => m.has(stage[1]))) throw Error("CONFLICT_PATH_INVALID"); block.paths.add(stage[1]); }
      else if (line.startsWith("+<<<<<<<") && block) block.starts++;
      else if (line === "+======= " || line === "+=======") { if (!block) throw Error("CONFLICT_BLOCK_INVALID"); block.separators++; }
      else if (line.startsWith("+>>>>>>>") && block) block.ends++;
      else if (line && !/^[ +\-@\\]/u.test(line)) throw Error("MERGE_TREE_FORMAT_UNSUPPORTED");
    }
    finish();
    conflicts.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (new Set(conflicts.map(r => r.path)).size !== conflicts.length) return hold("CONFLICT_PATH_AMBIGUOUS");
    return pass({ evidenceClass: "LOCAL_CONFLICT_FACTS_ONLY", conflicts,
      conflictSetSha256: sha256(canonicalJsonBytes(conflicts)), mergeTreeOutputSha256: sha256(raw) });
  } catch { return hold("CONFLICT_FACTS_UNAVAILABLE_OR_UNSAFE"); }
}
function freezeFacts(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeFacts);
    Object.freeze(value);
  }
  return value;
}
export function collectAdmissionObjectFacts(options) {
  if (!hasExactKeys(options, keys("repoRoot branchPreRefreshCommit liveMainCommit refreshMergeCommit")) ||
      typeof options.repoRoot !== "string" || !path.isAbsolute(options.repoRoot) ||
      !keys("branchPreRefreshCommit liveMainCommit refreshMergeCommit").every(k => validCommit(options[k]))) return hold("OBJECT_FACT_INPUT_INVALID");
  try {
    const { repoRoot, branchPreRefreshCommit: branch, liveMainCommit: main, refreshMergeCommit: merged } = options;
    if (realpathSync(repoRoot) !== repoRoot) return hold("OBJECT_FACT_ROOT_INVALID");
    const git = args => readObjectGit(repoRoot, args);
    const mergeBase = git(["merge-base", branch, main]).toString().trim();
    if (!validCommit(mergeBase)) return hold("MERGE_BASE_INVALID");
    const parentRecord = git(["rev-list", "--parents", "-n", "1", merged]).toString().trim().split(" ");
    if (!valuesEqual(parentRecord, [merged, branch, main])) return hold("REFRESH_PARENTS_MISMATCH");
    const diffFlags = ["--no-ext-diff", "--no-textconv", "--find-renames=100%", "--find-copies=100%", "--find-copies-harder"];
    const diff = parseNameStatusNul(git(["diff", "--name-status", "-z", ...diffFlags, mergeBase, main, "--"]));
    if (diff.status !== "PASS") return diff;
    const names = git(["diff", "--name-only", "-z", ...diffFlags, mergeBase, main, "--"]).toString("utf8").split("\0").filter(Boolean).sort();
    if (!valuesEqual(names, diff.records.map(r => r.path))) return hold("CURRENT_MAIN_PATH_SET_MISMATCH");
    const trees = Object.fromEntries([["base", mergeBase], ["branch", branch], ["main", main], ["result", merged]].map(([name, commit]) => [name, readTreeFacts(repoRoot, commit)]));
    const treeMaps = Object.fromEntries(Object.entries(trees).map(([name, rows]) => [name, new Map(rows.map(r => [r.path, r.blobId]))]));
    const mainOnlyPaths = diff.records.map(row => ({ path: row.path, changeKind: ({ A: "ADD", M: "MODIFY", D: "DELETE" })[row.status],
      ...Object.fromEntries(Object.entries(treeMaps).map(([name, map]) => [`${name}BlobId`, map.get(row.path) ?? null])) }));
    if (mainOnlyPaths.some(r => !r.changeKind)) return hold("CHANGE_KIND_UNSUPPORTED");
    const ownerBlobId = treeMaps.result.get(".github/CODEOWNERS");
    const ownerBytes = ownerBlobId ? git(["cat-file", "blob", ownerBlobId]) : null;
    const owners = mainOnlyPaths.map(row => ({ path: row.path,
      ...(ownerBytes ? resolveAdmissionOwner(ownerBytes, ownerBlobId, row.path) : hold("CODEOWNERS_UNAVAILABLE")) }));
    const migrationRows = trees.result.filter(r => /^packages\/db\/prisma\/migrations\/[^/]+\/migration\.sql$/u.test(r.path));
    if (migrationRows.length > 2048) return hold("MIGRATION_LIMIT_EXCEEDED");
    let totalBytes = 0;
    const migrations = migrationRows.map(row => {
      const bytes = git(["cat-file", "blob", row.blobId]);
      totalBytes += bytes.length;
      if (totalBytes > 64 * 1024 * 1024) throw Error("MIGRATION_LIMIT_EXCEEDED");
      const lastChangeCommit = git(["rev-list", "-1", merged, "--", row.path]).toString().trim();
      if (!validCommit(lastChangeCommit)) throw Error("MIGRATION_HISTORY_INVALID");
      return { name: row.path.split("/").at(-2), path: row.path, resultBlobId: row.blobId,
        migrationSqlSha256: sha256(bytes), lastChangeCommit };
    });
    const facts = freezeFacts(pass({ evidenceClass: "LOCAL_GIT_OBJECT_FACTS_ONLY", branchPreRefreshCommit: branch,
      liveMainCommit: main, mergeBaseCommit: mergeBase, refreshMergeCommit: merged,
      refreshParents: parentRecord.slice(1), mainOnlyPaths, mainOnlyPathSetSha256: diff.pathSetSha256,
      trees, migrations, owners, authorityClassification: "NOT_EVALUATED" }));
    collectedObjectFacts.add(facts);
    return facts;
  } catch {
    return hold("OBJECT_FACTS_UNAVAILABLE_OR_UNSAFE");
  }
}

export function validateAdmissionObjectBindings(document, facts) {
  const structure = validateCurrentMainAdmissionStructure(document);
  if (structure.status !== "PASS") return structure;
  if (!collectedObjectFacts.has(facts)) return hold("COLLECTED_OBJECT_FACTS_REQUIRED");
  for (const key of keys("branchPreRefreshCommit liveMainCommit mergeBaseCommit refreshMergeCommit refreshParents mainOnlyPathSetSha256")) {
    if (!valuesEqual(document[key], facts[key])) return hold("ADMISSION_OBJECT_IDENTITY_MISMATCH");
  }
  if (!valuesEqual(document.paths.map(r => r.path), facts.mainOnlyPaths.map(r => r.path))) return hold("CURRENT_MAIN_PATH_SET_MISMATCH");
  for (let i = 0; i < document.paths.length; i++) {
    for (const key of keys("changeKind baseBlobId branchBlobId mainBlobId resultBlobId")) {
      if (document.paths[i][key] !== facts.mainOnlyPaths[i][key]) return hold("ADMISSION_BLOB_MISMATCH");
    }
    if (facts.owners[i].status !== "PASS") return hold("CODEOWNERS_UNRESOLVED");
    if (!valuesEqual(document.paths[i].owner, facts.owners[i].owner)) return hold("ADMISSION_OWNER_MISMATCH");
  }
  if (!valuesEqual(document.migrations.map(r => r.path), facts.migrations.map(r => r.path))) return hold("MIGRATION_SET_MISMATCH");
  for (let i = 0; i < document.migrations.length; i++) {
    for (const key of keys("name path resultBlobId migrationSqlSha256 lastChangeCommit")) {
      if (document.migrations[i][key] !== facts.migrations[i][key]) return hold("MIGRATION_BLOB_MISMATCH");
    }
  }
  return pass({ evidenceClass: "LOCAL_OBJECT_BINDINGS_ONLY", admissionGranted: false });
}

function canonicalRemoteIdentity(remote) {
  if (typeof remote !== "string" || remote.includes("\0") || remote.includes("@") && !remote.startsWith("git@")) return null;
  const value = remote.trim().replace(/\.git$/u, "");
  const match = value.match(/^(?:https?:\/\/|ssh:\/\/git@)github\.com[/:]([^/]+)\/([^/]+)$/u) || value.match(/^git@github\.com:([^/]+)\/([^/]+)$/u);
  if (!match || !/^[A-Za-z0-9_.-]+$/u.test(match[1]) || !/^[A-Za-z0-9_.-]+$/u.test(match[2])) return null;
  return { host: "github.com", owner: match[1], name: match[2], full_name: `${match[1]}/${match[2]}` };
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

export function collectCurrentMainAuditFacts({ repositoryRoot, branch = "HEAD", liveMain, expectedRepository }) {
  try {
    if (!hasExactKeys(expectedRepository, ["host", "owner", "name", "full_name"])) return hold("REPOSITORY_IDENTITY_REQUIRED");
    const remote = runGit(repositoryRoot, ["config", "--get", "remote.origin.url"]).toString().trim();
    const repositoryIdentity = canonicalRemoteIdentity(remote);
    if (!repositoryIdentity || !valuesEqual(repositoryIdentity, expectedRepository)) return hold("REPOSITORY_IDENTITY_INVALID");
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
    return pass({ repositoryIdentity, branchCommit, liveMainCommit: mainCommit, mergeBaseCommit: mergeBase, mainOnlyPaths: pathFacts.records, mainOnlyPathSetSha256: pathFacts.pathSetSha256 });
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
  if (!COMMAND_IDS.includes(commandId) || parameters === null || typeof parameters !== "object" || !isPassivePlain(parameters) || Object.keys(parameters).some((key) => SECRET_KEYS.test(key))) return hold("COMMAND_DESCRIPTOR_INVALID");
  const allowed = commandId === "COPY_WRITE_ELIGIBILITY_V1"
    ? ["auditPacketSha256", "eligibilityPath"]
    : ["auditPacketSha256", "eligibilityPath", "eligibilityInputSha256", "citationPath"];
  if (!hasExactKeys(parameters, allowed) || Object.values(parameters).some((value) => typeof value !== "string" || value.length > 512)) return hold("COMMAND_DESCRIPTOR_INVALID");
  if (!validSha(parameters.auditPacketSha256) || parameters.eligibilityPath !== "docs/evidence/site-builder/copy-runtime-eligibility.json") return hold("COMMAND_DESCRIPTOR_INVALID");
  if (commandId === "COPY_SYNC_CITATIONS_V1" && (!validSha(parameters.eligibilityInputSha256) || parameters.citationPath !== "docs/implementation-records/copy-fixed-source-impact-governance.md")) return hold("COMMAND_DESCRIPTOR_INVALID");
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
