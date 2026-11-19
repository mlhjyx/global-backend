// Run only from a protected, exact, clean trusted checkout. Candidate source
// is data in a separate checkout; no candidate script is executed here.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readCandidateInput } from "./development-candidate-input.mjs";
import { canonicalJson } from "./release-authorization.mjs";
import { CandidateBudgetLedger } from "./development-candidate-budget.mjs";
import {
  CANDIDATE_IMAGE_REPOSITORY,
  candidateMarker,
  candidateAdmissionReceipt,
  candidateAttestationArguments,
  validateCandidateAuthorization,
  validateCandidateInstance,
  validateCandidateStatement,
  verifyCandidateOwnerSignature,
} from "./development-candidate-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = /^[0-9a-f]{40}$/u,
  DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PROTECTED = [
  ".github",
  ".gitattributes",
  ".gitmodules",
  ".npmrc",
  ".pnpmfile.cjs",
  ".dockerignore",
  ".candidate-build",
  "Dockerfile",
  "runtime-entrypoint.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "scripts",
  "patches",
  "infra",
  "packages",
  "apps/api/package.json",
  "apps/api/nest-cli.json",
  "apps/api/tsconfig.json",
  "apps/api/tsconfig.build.json",
  "apps/api/src/main.ts",
  "apps/api/src/app.module.ts",
  "apps/api/src/auth",
  "apps/api/src/runtime",
  "apps/api/src/platform-authority",
  "apps/api/src/execution-budget",
  "apps/api/src/health",
  "apps/api/src/tools",
  "apps/api/src/model-gateway",
  "apps/api/src/model-runtime",
  "apps/api/src/prisma",
  "apps/api/src/compliance/pii-crypto.extension.ts",
  "apps/api/src/relay",
  "apps/api/src/temporal/worker.ts",
  "apps/api/src/temporal/deterministic-ledger-failure.interceptor.ts",
  "apps/api/src/temporal/temporal.client.ts",
  "apps/api/src/temporal/understanding.constants.ts",
  "apps/api/scripts",
  "apps/site-renderer",
  "docs/governance",
  "docs/releases",
];
function fail(code) {
  throw new Error(code);
}
function git(root, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      root,
      ...args,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
      maxBuffer: 2_000_000,
    },
  ).trim();
}
export function readCandidateJson(path) {
  return JSON.parse(
    readCandidateInput(path, 65_536, "CANDIDATE_INPUT_FILE_INVALID").toString(
      "utf8",
    ),
  );
}
export function assertTrustedCandidateCheckout(trustedCommit) {
  if (
    !SHA.test(trustedCommit) ||
    git(ROOT, "rev-parse", "HEAD") !== trustedCommit ||
    git(ROOT, "status", "--porcelain", "--untracked-files=all") !== ""
  )
    fail("CANDIDATE_TRUSTED_CHECKOUT_INVALID");
  git(ROOT, "merge-base", "--is-ancestor", trustedCommit, "origin/main");
  const origin = git(ROOT, "remote", "get-url", "origin");
  if (
    !/^(?:https:\/\/github\.com\/mlhjyx\/global-backend(?:\.git)?|git@github\.com:mlhjyx\/global-backend\.git)$/u.test(
      origin,
    )
  )
    fail("CANDIDATE_TRUSTED_REPOSITORY_INVALID");
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    (process.env.GITHUB_SHA !== trustedCommit ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_REPOSITORY !== "mlhjyx/global-backend")
  )
    fail("CANDIDATE_TRUSTED_WORKFLOW_INVALID");
}
export function readApprovedCandidate({
  authorizationPath,
  signaturePath,
  instancePath,
  trustedCommit,
  now,
}) {
  assertTrustedCandidateCheckout(trustedCommit);
  const policy = {
    repository: "mlhjyx/global-backend",
    trustedWorkflowCommit: trustedCommit,
  };
  const authorizationBytes = readCandidateInput(
    authorizationPath,
    65_536,
    "CANDIDATE_INPUT_FILE_INVALID",
  );
  const authorization = validateCandidateAuthorization(
    JSON.parse(authorizationBytes.toString("utf8")),
    policy,
    now,
  );
  const keys = readCandidateJson(
    join(ROOT, "docs/governance/release-authority-keys.json"),
  );
  verifyCandidateOwnerSignature(
    authorizationBytes,
    signaturePath,
    keys,
    authorization.keyId,
  );
  const instance = validateCandidateInstance(readCandidateJson(instancePath));
  const instanceHash = createHash("sha256")
    .update(canonicalJson(instance))
    .digest("hex");
  if (
    instanceHash !== authorization.instanceManifestSha256 ||
    instance.instanceId !== authorization.instanceId ||
    JSON.stringify(instance.workspaceIds) !==
      JSON.stringify(authorization.workspaceIds)
  )
    fail("CANDIDATE_INSTANCE_APPROVAL_MISMATCH");
  return {
    authorization,
    instance,
    policy,
    authorizationSha256: createHash("sha256")
      .update(authorizationBytes)
      .digest("hex"),
  };
}
export function assertCandidateSource(candidateRoot, approval) {
  const { authorization } = approval;
  if (
    resolve(candidateRoot) === ROOT ||
    git(candidateRoot, "rev-parse", "HEAD") !== authorization.candidateCommit ||
    git(candidateRoot, "show", "-s", "--format=%T", "HEAD") !==
      authorization.gitTree ||
    git(candidateRoot, "status", "--porcelain", "--untracked-files=all") !== ""
  )
    fail("CANDIDATE_SOURCE_CHECKOUT_INVALID");
  // The source must contain exactly the already approved bootstrap baseline.
  // Do not overlay different verifier/entrypoint files into a claimed commit.
  git(
    candidateRoot,
    "merge-base",
    "--is-ancestor",
    authorization.trustedWorkflowCommit,
    authorization.candidateCommit,
  );
  if (
    git(
      candidateRoot,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      authorization.trustedWorkflowCommit,
      authorization.candidateCommit,
      "--",
      ...PROTECTED,
    )
  )
    fail("CANDIDATE_PROTECTED_SOURCE_CHANGED");
}
function writeNewJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
export function prepareCandidateBuild(
  candidateRoot,
  outputDirectory,
  approval,
) {
  assertCandidateSource(candidateRoot, approval);
  mkdirSync(outputDirectory, { mode: 0o700 });
  const archive = join(resolve(outputDirectory), "source.tar");
  git(
    candidateRoot,
    "archive",
    "--format=tar",
    `--output=${archive}`,
    approval.authorization.candidateCommit,
  );
  const context = join(resolve(outputDirectory), "context");
  mkdirSync(context, { mode: 0o700 });
  execFileSync(
    "tar",
    [
      "--extract",
      "--file",
      archive,
      "--directory",
      context,
      "--no-same-owner",
      "--no-same-permissions",
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 65_536 },
  );
  // Only this declared build metadata is added to the exact committed export.
  // Ignored/local checkout bytes are never used as Docker's build context.
  const metadata = join(context, ".candidate-build");
  mkdirSync(metadata, { mode: 0o700 });
  const marker = candidateMarker(
    approval.authorization,
    approval.authorizationSha256,
  );
  writeNewJson(join(outputDirectory, "runtime-candidate.json"), marker);
  writeNewJson(join(metadata, "runtime-candidate.json"), marker);
  return {
    candidateCommit: approval.authorization.candidateCommit,
    gitTree: approval.authorization.gitTree,
    authorizationSha256: approval.authorizationSha256,
    imageRepository: CANDIDATE_IMAGE_REPOSITORY,
  };
}
export function makeCandidatePredicate(build, approval, marker) {
  if (
    canonicalJson(marker) !==
    canonicalJson(
      candidateMarker(approval.authorization, approval.authorizationSha256),
    )
  )
    fail("CANDIDATE_BUILD_MARKER_MISMATCH");
  if (
    build?.build_sha !== approval.authorization.candidateCommit ||
    !DIGEST.test(build.artifact_digest) ||
    !DIGEST.test(build.source_tree_digest)
  )
    fail("CANDIDATE_BUILD_RECEIPT_MISMATCH");
  const { authorization, authorizationSha256 } = approval;
  return {
    schemaVersion: "development-candidate-build/v1",
    authorizationSha256,
    trustedWorkflowCommit: authorization.trustedWorkflowCommit,
    candidateCommit: authorization.candidateCommit,
    gitTree: authorization.gitTree,
    sourceTreeDigest: build.source_tree_digest,
    artifactDigest: build.artifact_digest,
    instanceId: authorization.instanceId,
    workspaceIds: authorization.workspaceIds,
    validUntil: authorization.validUntil,
    instanceManifestSha256: authorization.instanceManifestSha256,
  };
}
export function verifyCandidateImage(
  imageReference,
  approval,
  { now = new Date().toISOString() } = {},
) {
  const bytes = execFileSync(
    "gh",
    candidateAttestationArguments(imageReference, approval.policy),
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 2_000_000,
    },
  );
  const predicate = validateCandidateStatement(JSON.parse(bytes), {
    imageReference,
    ...approval,
    now,
  });
  return candidateAdmissionReceipt(
    imageReference,
    approval.authorization,
    approval.authorizationSha256,
    predicate,
    approval.instance,
  );
}
function argumentsOf(argv) {
  const [command, ...tokens] = argv;
  const allowed = new Set([
    "authorization",
    "signature",
    "instance",
    "trusted-commit",
    "candidate-root",
    "output",
    "build-receipt",
    "marker",
    "image",
    "ledger",
    "configuration",
  ]);
  const values = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const name = tokens[i]?.replace(/^--/u, "");
    if (
      !tokens[i]?.startsWith("--") ||
      !allowed.has(name) ||
      values[name] !== undefined ||
      !tokens[i + 1]
    )
      fail("CANDIDATE_ARGUMENT_INVALID");
    values[name] = tokens[i + 1];
  }
  return { command, values };
}
export function candidateMain(argv = process.argv.slice(2)) {
  const { command, values } = argumentsOf(argv);
  if (
    ![
      "validate-inputs",
      "prepare-build",
      "make-predicate",
      "verify-image",
      "export-budget",
    ].includes(command)
  )
    fail("CANDIDATE_COMMAND_INVALID");
  for (const key of [
    "authorization",
    "signature",
    "instance",
    "trusted-commit",
    "output",
  ])
    if (!values[key]) fail("CANDIDATE_ARGUMENT_MISSING");
  const approval = readApprovedCandidate({
    authorizationPath: values.authorization,
    signaturePath: values.signature,
    instancePath: values.instance,
    trustedCommit: values["trusted-commit"],
  });
  if (command === "validate-inputs") {
    writeNewJson(values.output, {
      candidateCommit: approval.authorization.candidateCommit,
      gitTree: approval.authorization.gitTree,
      instanceId: approval.authorization.instanceId,
      authorizationSha256: approval.authorizationSha256,
    });
    return;
  }
  if (command === "export-budget") {
    if (approval.authorization.budgetPolicy === "product_grants")
      fail("CANDIDATE_EXPERIMENT_ALLOCATION_NOT_APPLICABLE");
    if (
      !values.ledger ||
      !values.configuration ||
      !lstatSync(values.ledger).isFile()
    )
      fail("CANDIDATE_ARGUMENT_MISSING");
    const configuration = readCandidateJson(values.configuration);
    if (
      configuration.campaignId !== approval.authorization.instanceId ||
      configuration.arms?.A?.workspaceId !==
        approval.authorization.workspaceIds[0] ||
      configuration.arms?.B?.workspaceId !==
        approval.authorization.workspaceIds[1] ||
      Date.parse(configuration.expiresAt) >
        Date.parse(approval.authorization.validUntil)
    )
      fail("CANDIDATE_BUDGET_SCOPE_MISMATCH");
    const ledger = new CandidateBudgetLedger(values.ledger, configuration);
    try {
      writeNewJson(
        values.output,
        ledger.exportAllocations(approval.authorizationSha256),
      );
    } finally {
      ledger.close();
    }
    return;
  }
  if (command === "prepare-build") {
    if (!values["candidate-root"]) fail("CANDIDATE_ARGUMENT_MISSING");
    const summary = prepareCandidateBuild(
      values["candidate-root"],
      values.output,
      approval,
    );
    process.stdout.write(JSON.stringify(summary) + "\n");
    return;
  }
  if (command === "make-predicate") {
    if (!values["build-receipt"] || !values.marker)
      fail("CANDIDATE_ARGUMENT_MISSING");
    writeNewJson(
      values.output,
      makeCandidatePredicate(
        readCandidateJson(values["build-receipt"]),
        approval,
        readCandidateJson(values.marker),
      ),
    );
  } else {
    if (!values.image) fail("CANDIDATE_ARGUMENT_MISSING");
    writeNewJson(values.output, verifyCandidateImage(values.image, approval));
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    candidateMain();
  } catch (error) {
    const code = error instanceof Error &&
      error.message === "CANDIDATE_EXPERIMENT_ALLOCATION_NOT_APPLICABLE"
      ? "CANDIDATE_EXPERIMENT_ALLOCATION_NOT_APPLICABLE"
      : "DEVELOPMENT_CANDIDATE_ADMISSION_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
