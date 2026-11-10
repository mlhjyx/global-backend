// PRD4-D12 (2026-11-11): the PILOT/GA release gate accepts a product-owner
// SSH-signed authorization receipt instead of an unimplemented external
// readback verifier. The receipt binds the release bundle digest, the
// implementation commit, the evidence set, the machine check-run conclusions
// observed at signing time, and the independent-review artifact. Verification
// is offline: it recomputes every binding and checks the SSH signature against
// the pinned release-authority keys. Self-asserted strings still fail closed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const AUTHORIZATION_SCHEMA_VERSION = "release-authorization/v1";
export const RELEASE_AUTHORITY_KEYS_SCHEMA_VERSION = "release-authority-keys/v1";
export const RELEASE_AUTHORITY_KEYS_PATH =
  "docs/governance/release-authority-keys.json";
export const AUTHORIZATION_DIRECTORY = "docs/releases/authorizations";
export const AUTHORIZATION_SIGNATURE_NAMESPACE = "release-authorization";
export const REQUIRED_CONTEXTS_PATH = ".github/required-contexts.json";

const SHA_40 = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const AUTHORIZATION_FILE = /^docs\/releases\/authorizations\/[A-Za-z0-9._-]+\.authorization\.json$/;
const REVIEW_FILE = /^docs\/releases\/authorizations\/[A-Za-z0-9._-]+\.review\.md$/;
const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/;
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MACHINE_READBACK_WINDOW_MS = 60 * 60 * 1000;

function issue(code, message) {
  return Object.freeze({ code, message });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isIsoInstant(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable JSON serialization (sorted keys) used for every digest below. */
export function canonicalJson(value) {
  return canonicalize(JSON.parse(JSON.stringify(value)));
}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Digest of the release bundle as authorized. external_provenance is excluded:
 * it contains this authorization's own status/reference and therefore cannot
 * be part of the message the authorization signs.
 */
export function releaseBundleDigest(bundle) {
  const clone = structuredClone(bundle);
  delete clone.external_provenance;
  return sha256Hex(canonicalJson(clone));
}

export function evidenceSetDigest(evidenceIds) {
  const sorted = [...new Set(evidenceIds)].sort();
  return sha256Hex(sorted.join("\n"));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveRepoFile(repoRoot, relativePath, pattern) {
  if (!pattern.test(relativePath)) return null;
  const absolute = resolve(repoRoot, relativePath);
  const root = resolve(repoRoot);
  const inside = relative(root, absolute);
  if (inside.startsWith("..") || isAbsolute(inside)) return null;
  if (!absolute.startsWith(root + sep)) return null;
  return absolute;
}

function requiredContexts(repoRoot) {
  const path = join(repoRoot, REQUIRED_CONTEXTS_PATH);
  if (!existsSync(path)) return null;
  const policy = readJson(path);
  return Array.isArray(policy?.required_contexts) ? policy.required_contexts : null;
}

/**
 * Build the authorization payload. Used by the signing CLI and the tests.
 * The caller is responsible for having fetched machine check-run conclusions
 * from GitHub; this function only shapes and digests them.
 */
export function buildReleaseAuthorization({
  bundle,
  repository,
  machineContexts,
  fetchedAt,
  reviewArtifactRef,
  reviewArtifactSha256,
  authorizedBy,
  keyId,
  authorizedAt,
  validUntil,
  notes = "",
}) {
  return {
    schema_version: AUTHORIZATION_SCHEMA_VERSION,
    authorization_id: `${bundle.release_id}:${authorizedAt}`,
    decision: "AUTHORIZED",
    release_id: bundle.release_id,
    release_status: bundle.release_status,
    environment: bundle.environment,
    repository,
    implementation_commit: bundle.implementation_commit,
    release_bundle_sha256: releaseBundleDigest(bundle),
    evidence_ids: [...new Set(bundle.evidence_ids)].sort(),
    evidence_set_sha256: evidenceSetDigest(bundle.evidence_ids),
    machine_check: {
      provider: "github-actions",
      head_sha: bundle.implementation_commit,
      contexts: machineContexts,
      fetched_at: fetchedAt,
    },
    reviewer_record: {
      actor: "claude-code",
      artifact_ref: reviewArtifactRef,
      artifact_sha256: reviewArtifactSha256,
    },
    authorized_by: authorizedBy,
    authorized_at: authorizedAt,
    valid_until: validUntil,
    key_id: keyId,
    notes,
  };
}

export function loadReleaseAuthorityKeys(repoRoot) {
  const path = join(repoRoot, RELEASE_AUTHORITY_KEYS_PATH);
  if (!existsSync(path)) return null;
  return readJson(path);
}

/**
 * Verify an SSH signature over the exact authorization file bytes against the
 * pinned public key for the key id. Uses ssh-keygen so no additional crypto
 * dependency is introduced.
 */
export function verifyAuthorizationSignature({
  authorizationPath,
  signaturePath,
  principal,
  publicKey,
}) {
  const directory = mkdtempSync(join(tmpdir(), "release-authorization-"));
  const allowedSigners = join(directory, "allowed_signers");
  try {
    writeFileSync(allowedSigners, `${principal} ${publicKey}\n`);
    execFileSync(
      "ssh-keygen",
      [
        "-Y",
        "verify",
        "-f",
        allowedSigners,
        "-I",
        principal,
        "-n",
        AUTHORIZATION_SIGNATURE_NAMESPACE,
        "-s",
        signaturePath,
      ],
      { input: readFileSync(authorizationPath), stdio: ["pipe", "pipe", "pipe"] },
    );
    return { ok: true };
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString("utf8").trim()
      : String(error.stderr ?? error.message ?? "").trim();
    return { ok: false, detail: stderr || "ssh-keygen verification failed" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function signAuthorizationFile({ authorizationPath, keyPath }) {
  execFileSync("ssh-keygen", [
    "-Y",
    "sign",
    "-f",
    keyPath,
    "-n",
    AUTHORIZATION_SIGNATURE_NAMESPACE,
    authorizationPath,
  ]);
  return `${authorizationPath}.sig`;
}

/**
 * Validate a bundle whose external_provenance claims OWNER_SIGNED.
 * Returns { issues, authorization, digest } for callers that need the receipt.
 */
export function validateReleaseAuthorization(bundle, options = {}) {
  const issues = [];
  const repoRoot = options.repoRoot ?? process.cwd();
  const now = options.now instanceof Date ? options.now : new Date();
  const provenance = bundle?.external_provenance;

  const reference = provenance?.verification_ref;
  if (!isNonEmptyString(reference)) {
    issues.push(
      issue(
        "RELEASE_AUTHORIZATION_MISSING",
        "OWNER_SIGNED bundles need external_provenance.verification_ref pointing at an authorization receipt",
      ),
    );
    return { issues, authorization: null, digest: null };
  }
  const authorizationPath = resolveRepoFile(repoRoot, reference, AUTHORIZATION_FILE);
  if (!authorizationPath || !existsSync(authorizationPath)) {
    issues.push(
      issue(
        "RELEASE_AUTHORIZATION_PATH_INVALID",
        `authorization receipt is missing or outside ${AUTHORIZATION_DIRECTORY}: ${reference}`,
      ),
    );
    return { issues, authorization: null, digest: null };
  }
  let authorization;
  try {
    authorization = readJson(authorizationPath);
  } catch (error) {
    issues.push(
      issue(
        "RELEASE_AUTHORIZATION_INVALID",
        `${reference}: authorization is not valid JSON (${error.message})`,
      ),
    );
    return { issues, authorization: null, digest: null };
  }

  const shapeInvalid = [];
  if (authorization?.schema_version !== AUTHORIZATION_SCHEMA_VERSION) {
    shapeInvalid.push("schema_version");
  }
  for (const field of [
    "authorization_id",
    "release_id",
    "repository",
    "authorized_by",
    "key_id",
  ]) {
    if (!isNonEmptyString(authorization?.[field])) shapeInvalid.push(field);
  }
  if (authorization?.decision !== "AUTHORIZED") shapeInvalid.push("decision");
  if (!isIsoInstant(authorization?.authorized_at)) shapeInvalid.push("authorized_at");
  if (!isIsoInstant(authorization?.valid_until)) shapeInvalid.push("valid_until");
  if (!SHA_40.test(authorization?.implementation_commit ?? "")) {
    shapeInvalid.push("implementation_commit");
  }
  if (!SHA256_HEX.test(authorization?.release_bundle_sha256 ?? "")) {
    shapeInvalid.push("release_bundle_sha256");
  }
  if (!Array.isArray(authorization?.evidence_ids)) shapeInvalid.push("evidence_ids");
  if (!SHA256_HEX.test(authorization?.evidence_set_sha256 ?? "")) {
    shapeInvalid.push("evidence_set_sha256");
  }
  if (shapeInvalid.length > 0) {
    issues.push(
      issue(
        "RELEASE_AUTHORIZATION_INVALID",
        `${reference}: invalid fields ${[...new Set(shapeInvalid)].join(", ")}`,
      ),
    );
  }

  // Bindings: the receipt must describe exactly this bundle.
  const bindings = [
    ["release_id", authorization?.release_id, bundle?.release_id],
    ["release_status", authorization?.release_status, bundle?.release_status],
    ["environment", authorization?.environment, bundle?.environment],
    ["repository", authorization?.repository, bundle?.source?.repository],
    [
      "implementation_commit",
      authorization?.implementation_commit,
      bundle?.implementation_commit,
    ],
    [
      "release_bundle_sha256",
      authorization?.release_bundle_sha256,
      releaseBundleDigest(bundle ?? {}),
    ],
    [
      "evidence_set_sha256",
      authorization?.evidence_set_sha256,
      evidenceSetDigest(Array.isArray(bundle?.evidence_ids) ? bundle.evidence_ids : []),
    ],
  ];
  for (const [field, actual, expected] of bindings) {
    if (actual !== expected) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_BUNDLE_MISMATCH",
          `${reference}: ${field} does not match the release bundle`,
        ),
      );
    }
  }
  const bundleEvidence = [...new Set(Array.isArray(bundle?.evidence_ids) ? bundle.evidence_ids : [])].sort();
  const authorizedEvidence = [...new Set(Array.isArray(authorization?.evidence_ids) ? authorization.evidence_ids : [])].sort();
  if (JSON.stringify(bundleEvidence) !== JSON.stringify(authorizedEvidence)) {
    issues.push(
      issue(
        "RELEASE_AUTHORIZATION_BUNDLE_MISMATCH",
        `${reference}: evidence_ids do not match the release bundle`,
      ),
    );
  }

  // Machine readback recorded at signing time: every required context must be
  // present and successful on the implementation commit.
  const machine = authorization?.machine_check;
  const contexts = requiredContexts(repoRoot);
  if (!isObject(machine) || machine.provider !== "github-actions") {
    issues.push(
      issue(
        "RELEASE_AUTHORIZATION_MACHINE_INVALID",
        `${reference}: machine_check must record a github-actions readback`,
      ),
    );
  } else {
    if (machine.head_sha !== bundle?.implementation_commit) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_MACHINE_MISMATCH",
          `${reference}: machine_check.head_sha is not the implementation commit`,
        ),
      );
    }
    if (!isIsoInstant(machine.fetched_at)) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_MACHINE_INVALID",
          `${reference}: machine_check.fetched_at is not an ISO instant`,
        ),
      );
    } else {
      const fetched = Date.parse(machine.fetched_at);
      const authorized = Date.parse(authorization?.authorized_at ?? "");
      if (
        Number.isFinite(authorized) &&
        Math.abs(authorized - fetched) > MACHINE_READBACK_WINDOW_MS
      ) {
        issues.push(
          issue(
            "RELEASE_AUTHORIZATION_MACHINE_STALE",
            `${reference}: machine_check must be fetched within one hour of authorization`,
          ),
        );
      }
    }
    const recorded = new Map(
      (Array.isArray(machine.contexts) ? machine.contexts : [])
        .filter((entry) => isObject(entry) && isNonEmptyString(entry.name))
        .map((entry) => [entry.name, entry]),
    );
    if (contexts === null) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_CONTEXTS_UNKNOWN",
          `${reference}: ${REQUIRED_CONTEXTS_PATH} is missing; cannot check required contexts`,
        ),
      );
    } else {
      for (const name of contexts) {
        const entry = recorded.get(name);
        if (!entry || entry.conclusion !== "success") {
          issues.push(
            issue(
              "RELEASE_AUTHORIZATION_CONTEXT_MISSING",
              `${reference}: required context ${JSON.stringify(name)} is missing or not successful`,
            ),
          );
        }
      }
    }
  }

  // Independent-review artifact bound into the same signature.
  const review = authorization?.reviewer_record;
  if (!isObject(review) || !isNonEmptyString(review.actor)) {
    issues.push(
      issue(
        "RELEASE_AUTHORIZATION_REVIEW_INVALID",
        `${reference}: reviewer_record.actor is required`,
      ),
    );
  } else {
    const reviewPath = isNonEmptyString(review.artifact_ref)
      ? resolveRepoFile(repoRoot, review.artifact_ref, REVIEW_FILE)
      : null;
    if (!reviewPath || !existsSync(reviewPath)) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_REVIEW_MISSING",
          `${reference}: review artifact is missing or outside ${AUTHORIZATION_DIRECTORY}`,
        ),
      );
    } else if (sha256Hex(readFileSync(reviewPath)) !== review.artifact_sha256) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_REVIEW_MISMATCH",
          `${reference}: review artifact does not match the signed hash`,
        ),
      );
    }
  }

  // Validity window.
  const authorizedAt = Date.parse(authorization?.authorized_at ?? "");
  const validUntil = Date.parse(authorization?.valid_until ?? "");
  if (Number.isFinite(authorizedAt) && Number.isFinite(validUntil)) {
    if (validUntil <= authorizedAt) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_WINDOW_INVALID",
          `${reference}: valid_until must be after authorized_at`,
        ),
      );
    } else if (validUntil - authorizedAt > MAX_VALIDITY_MS) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_WINDOW_TOO_LONG",
          `${reference}: authorization validity must not exceed 30 days`,
        ),
      );
    }
    if (now.getTime() < authorizedAt - CLOCK_SKEW_MS) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_NOT_YET_VALID",
          `${reference}: authorization is issued in the future`,
        ),
      );
    } else if (now.getTime() > validUntil) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_EXPIRED",
          `${reference}: authorization has expired`,
        ),
      );
    }
  }

  // Signature over the exact receipt bytes, against the pinned key.
  const keys = loadReleaseAuthorityKeys(repoRoot);
  if (!keys) {
    issues.push(
      issue(
        "RELEASE_AUTHORIZATION_KEYS_MISSING",
        `${RELEASE_AUTHORITY_KEYS_PATH} is missing; no release authority key is pinned`,
      ),
    );
  } else {
    if (keys.schema_version !== RELEASE_AUTHORITY_KEYS_SCHEMA_VERSION) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_KEYS_INVALID",
          `${RELEASE_AUTHORITY_KEYS_PATH} has an unsupported schema_version`,
        ),
      );
    }
    const key = (Array.isArray(keys.keys) ? keys.keys : []).find(
      (entry) => entry?.key_id === authorization?.key_id,
    );
    if (!key) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_KEY_UNKNOWN",
          `${reference}: key_id ${JSON.stringify(authorization?.key_id)} is not pinned`,
        ),
      );
    } else if (key.revoked_at !== null && key.revoked_at !== undefined) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_KEY_REVOKED",
          `${reference}: key ${JSON.stringify(key.key_id)} is revoked`,
        ),
      );
    } else if (
      !isNonEmptyString(key.principal) ||
      !PUBLIC_KEY.test(key.public_key ?? "")
    ) {
      issues.push(
        issue(
          "RELEASE_AUTHORIZATION_KEYS_INVALID",
          `${reference}: pinned key ${JSON.stringify(key.key_id)} is malformed`,
        ),
      );
    } else {
      const signaturePath = `${authorizationPath}.sig`;
      if (!existsSync(signaturePath)) {
        issues.push(
          issue(
            "RELEASE_AUTHORIZATION_SIGNATURE_MISSING",
            `${reference}: detached signature ${reference}.sig is missing`,
          ),
        );
      } else {
        const verification = verifyAuthorizationSignature({
          authorizationPath,
          signaturePath,
          principal: key.principal,
          publicKey: key.public_key,
        });
        if (!verification.ok) {
          issues.push(
            issue(
              "RELEASE_AUTHORIZATION_SIGNATURE_INVALID",
              `${reference}: ${verification.detail}`,
            ),
          );
        }
      }
    }
  }

  return {
    issues,
    authorization,
    digest: authorization?.release_bundle_sha256 ?? null,
  };
}
