#!/usr/bin/env node
// PRD4-D12 owner signing tool. Run this on the release machine (never in CI):
// it reads the required check-run conclusions from GitHub, hashes the release
// bundle and the independent-review artifact, writes the authorization receipt
// and signs it with the owner's SSH key. The committed receipt plus the pinned
// public key let CI verify the release offline.
//
//   node scripts/sign-release-authorization.mjs \
//     --bundle docs/releases/<release>.release.json \
//     --key ~/.ssh/gain-release-authorization \
//     --review-artifact docs/releases/authorizations/<release>.review.md \
//     --valid-until 2026-12-01T00:00:00.000Z \
//     --authorized-by mlhjyx \
//     [--repo mlhjyx/global-backend] [--out-dir docs/releases/authorizations] \
//     [--key-id owner-release-2026-11] [--dry-run]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  AUTHORIZATION_DIRECTORY,
  RELEASE_AUTHORITY_KEYS_SCHEMA_VERSION,
  RELEASE_AUTHORITY_KEYS_PATH,
  buildReleaseAuthorization,
  loadReleaseAuthorityKeys,
  sha256Hex,
  signAuthorizationFile,
  validateReleaseAuthorization,
} from "./release-authorization.mjs";

const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    "usage: node scripts/sign-release-authorization.mjs --bundle <release.json> --key <ssh-key> --review-artifact <review.md> --valid-until <ISO> --authorized-by <name> [--repo owner/name] [--out-dir dir] [--key-id id] [--dry-run]",
  );
  process.exit(1);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    outDir: AUTHORIZATION_DIRECTORY,
    dryRun: false,
    keyId: null,
    repo: null,
  };
  const valued = new Map([
    ["--bundle", "bundle"],
    ["--key", "key"],
    ["--review-artifact", "reviewArtifact"],
    ["--valid-until", "validUntil"],
    ["--authorized-by", "authorizedBy"],
    ["--repo", "repo"],
    ["--out-dir", "outDir"],
    ["--key-id", "keyId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const field = valued.get(flag);
    if (!field) usage(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (!value) usage(`${flag} needs a value`);
    options[field] = value;
    index += 1;
  }
  for (const [flag, field] of [
    ["--bundle", "bundle"],
    ["--key", "key"],
    ["--review-artifact", "reviewArtifact"],
    ["--valid-until", "validUntil"],
    ["--authorized-by", "authorizedBy"],
  ]) {
    if (!options[field]) usage(`${flag} is required`);
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function publicKeyOf(privateKeyPath) {
  return execFileSync("ssh-keygen", ["-y", "-f", privateKeyPath], {
    encoding: "utf8",
  }).trim();
}

function sameKey(left, right) {
  const split = (value) => value.trim().split(/\s+/).slice(0, 2).join(" ");
  return split(left) === split(right);
}

function fetchMachineContexts(repo, commit) {
  let raw;
  try {
    raw = execFileSync(
      "gh",
      [
        "api",
        `repos/${repo}/commits/${commit}/check-runs?per_page=100&filter=latest`,
      ],
      { encoding: "utf8" },
    );
  } catch (error) {
    fail(
      `cannot read check runs for ${repo}@${commit} via gh (authenticate with gh auth login first): ${String(
        error.stderr ?? error.message,
      ).trim()}`,
    );
  }
  const payload = JSON.parse(raw);
  const byName = new Map();
  for (const run of Array.isArray(payload.check_runs) ? payload.check_runs : []) {
    const existing = byName.get(run.name);
    if (!existing || (run.started_at ?? "") >= (existing.started_at ?? "")) {
      byName.set(run.name, run);
    }
  }
  const policy = readJson(
    join(process.cwd(), ".github/required-contexts.json"),
  );
  const required = Array.isArray(policy.required_contexts)
    ? policy.required_contexts
    : [];
  if (required.length === 0) {
    fail(".github/required-contexts.json lists no required contexts");
  }
  const contexts = [];
  const missing = [];
  for (const name of required) {
    const run = byName.get(name);
    if (!run) {
      missing.push(`${name} (no check run)`);
    } else if (run.conclusion !== "success") {
      missing.push(`${name} (${run.conclusion ?? run.status})`);
    } else {
      contexts.push({
        name,
        conclusion: run.conclusion,
        run_id: run.id,
        url: run.html_url ?? null,
      });
    }
  }
  if (missing.length > 0) {
    fail(
      `required contexts are not successful on ${commit}: ${missing.join(", ")}`,
    );
  }
  return contexts;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const bundlePath = resolve(options.bundle);
  const bundle = readJson(bundlePath);
  if (!["PILOT", "GA"].includes(bundle.release_status)) {
    fail(
      `bundle release_status must be PILOT or GA, got ${bundle.release_status}`,
    );
  }
  if (!["pilot", "production"].includes(bundle.environment)) {
    fail(
      `bundle environment must be pilot or production, got ${bundle.environment}`,
    );
  }
  const repository = bundle?.source?.repository;
  if (!repository) fail("bundle.source.repository is required");
  if (options.repo && options.repo !== repository) {
    fail(`--repo ${options.repo} does not match bundle repository ${repository}`);
  }

  const authorizedAt = new Date().toISOString();
  const validUntil = Date.parse(options.validUntil);
  if (!Number.isFinite(validUntil)) fail("--valid-until must be an ISO instant");
  const now = Date.parse(authorizedAt);
  if (validUntil <= now) fail("--valid-until must be in the future");
  if (validUntil - now > MAX_VALIDITY_MS) {
    fail("--valid-until must be within 30 days");
  }

  const reviewArtifactRef = options.reviewArtifact
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  if (!reviewArtifactRef.startsWith(`${AUTHORIZATION_DIRECTORY}/`)) {
    fail(`--review-artifact must live under ${AUTHORIZATION_DIRECTORY}/`);
  }
  const reviewPath = resolve(options.reviewArtifact);
  if (!existsSync(reviewPath)) fail(`review artifact not found: ${reviewPath}`);
  const reviewSha256 = sha256Hex(readFileSync(reviewPath));

  const machineContexts = fetchMachineContexts(
    repository,
    bundle.implementation_commit,
  );

  const keys = loadReleaseAuthorityKeys(process.cwd());
  if (!keys || keys.schema_version !== RELEASE_AUTHORITY_KEYS_SCHEMA_VERSION) {
    fail(`${RELEASE_AUTHORITY_KEYS_PATH} is missing or invalid`);
  }
  const publicKey = publicKeyOf(options.key);
  let keyId = options.keyId;
  if (!keyId) {
    const match = (keys.keys ?? []).find((entry) =>
      sameKey(entry.public_key ?? "", publicKey),
    );
    if (!match) {
      fail(
        "the signing key is not pinned in docs/governance/release-authority-keys.json; add its public key there first (same PR) or pass --key-id",
      );
    }
    keyId = match.key_id;
  }

  const authorization = buildReleaseAuthorization({
    bundle,
    repository,
    machineContexts,
    fetchedAt: authorizedAt,
    reviewArtifactRef,
    reviewArtifactSha256: reviewSha256,
    authorizedBy: options.authorizedBy,
    keyId,
    authorizedAt,
    validUntil: new Date(validUntil).toISOString(),
  });

  console.log("release authorization to sign:");
  console.log(
    `  release_id        ${authorization.release_id} (${authorization.release_status})`,
  );
  console.log(`  repository        ${authorization.repository}`);
  console.log(`  commit            ${authorization.implementation_commit}`);
  console.log(`  bundle digest     ${authorization.release_bundle_sha256}`);
  console.log(
    `  evidence set      ${authorization.evidence_set_sha256} (${authorization.evidence_ids.join(", ")})`,
  );
  console.log(
    `  machine contexts  ${machineContexts
      .map((entry) => `${entry.name}=${entry.conclusion}`)
      .join("; ")}`,
  );
  console.log(`  review artifact   ${reviewArtifactRef} (${reviewSha256})`);
  console.log(
    `  authorized by     ${authorization.authorized_by} via key ${keyId}`,
  );
  console.log(
    `  validity          ${authorization.authorized_at} -> ${authorization.valid_until}`,
  );

  if (options.dryRun) {
    console.log("dry run: nothing written");
    return;
  }

  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const authorizationPath = join(
    outDir,
    `${bundle.release_id}.authorization.json`,
  );
  writeFileSync(
    authorizationPath,
    `${JSON.stringify(authorization, null, 2)}\n`,
  );
  const signaturePath = signAuthorizationFile({
    authorizationPath,
    keyPath: options.key,
  });
  console.log(`wrote ${authorizationPath}`);
  console.log(`wrote ${signaturePath}`);

  const bundleForVerification = {
    ...bundle,
    external_provenance: {
      status: "OWNER_SIGNED",
      verifier: "PRODUCT_OWNER_SSH_SIGNATURE",
      verification_ref: `${AUTHORIZATION_DIRECTORY}/${bundle.release_id}.authorization.json`,
    },
  };
  const validation = validateReleaseAuthorization(bundleForVerification, {
    repoRoot: process.cwd(),
    now: new Date(),
  });
  if (validation.issues.length > 0) {
    for (const entry of validation.issues) {
      console.error(`verification: ${entry.code} ${entry.message}`);
    }
    fail("the signed authorization does not verify; fix the reported issues");
  }
  console.log("self-verification passed");
  console.log(
    `next: set external_provenance = {status: OWNER_SIGNED, verifier: PRODUCT_OWNER_SSH_SIGNATURE, verification_ref: "${AUTHORIZATION_DIRECTORY}/${bundle.release_id}.authorization.json"} in ${bundlePath}, run 'node scripts/governance-verify.mjs render-release --input ${bundlePath}', and commit the bundle, companion markdown, authorization and .sig in one PR.`,
  );
}

main();
