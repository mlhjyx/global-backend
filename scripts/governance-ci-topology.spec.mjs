import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

async function readRepositoryFile(path) {
  return readFile(new URL(path, repositoryRoot), "utf8");
}

function jobBlock(workflow, jobId) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  assert.notEqual(start, -1, `workflow job is missing: ${jobId}`);
  const next = lines.findIndex(
    (line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line),
  );
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

function namedStepBlock(job, stepName) {
  const lines = job.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `      - name: ${stepName}`);
  assert.notEqual(start, -1, `workflow step is missing: ${stepName}`);
  const next = lines.findIndex(
    (line, index) => index > start && /^      - (?:name:|uses:)/.test(line),
  );
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

test("renderer fast and scoped suites stay explicit and fail-closed", async () => {
  const [ciWorkflow, rendererPackageText] = await Promise.all([
    readRepositoryFile(".github/workflows/ci.yml"),
    readRepositoryFile("apps/site-renderer/package.json"),
  ]);
  const rendererPackage = JSON.parse(rendererPackageText);
  const buildJob = jobBlock(ciWorkflow, "build-test");

  assert.equal(
    rendererPackage.scripts["test:contracts"],
    "vitest run --exclude src/components/fixture-build.spec.ts",
  );
  assert.equal(
    rendererPackage.scripts["test:fixtures"],
    "vitest run src/components/fixture-build.spec.ts",
  );
  const contractStep = namedStepBlock(buildJob, "Renderer contract tests");
  assert.equal(
    contractStep.match(/^        if:/gm),
    null,
    "renderer contract tests must remain unconditional",
  );
  assert.match(
    contractStep,
    /^        run: pnpm --filter @global\/site-renderer test:contracts$/m,
  );
  for (const [stepName, command] of [
    [
      "Renderer fixture Astro build matrix",
      "pnpm --filter @global/site-renderer test:fixtures",
    ],
    [
      "Renderer qualified component visual regression（375 · 768 · 1440）",
      "pnpm --filter @global/site-renderer test:visual",
    ],
    [
      "Renderer multilingual smoke build",
      "pnpm --filter @global/site-renderer build",
    ],
  ]) {
    const step = namedStepBlock(buildJob, stepName);
    assert.deepEqual(
      step.match(/^        if:.*$/gm),
      ["        if: needs.renderer-visual-scope.outputs.run_visual == 'true'"],
      `${stepName} must have exactly one renderer scope condition`,
    );
    assert.ok(
      step.includes(`        run: ${command}`),
      `${stepName} must run ${command}`,
    );
  }
});

test("renderer scope changes and periodic runs execute every heavy renderer gate", async () => {
  const ciWorkflow = await readRepositoryFile(".github/workflows/ci.yml");
  const scopeJob = jobBlock(ciWorkflow, "renderer-visual-scope");

  assert.match(scopeJob, /EVENT_NAME.*schedule.*workflow_dispatch/s);
  assert.match(scopeJob, /-z "\$BASE_SHA"/);
  assert.match(scopeJob, /! git cat-file -e "\$\{BASE_SHA\}\^\{commit\}"/);
  for (const scopedPath of [
    "apps/site-renderer/*",
    "packages/contracts/src/index.ts",
    "packages/contracts/src/site-builder/*",
    "tsconfig.base.json",
    "package.json | pnpm-lock.yaml | pnpm-workspace.yaml",
    ".github/workflows/ci.yml",
  ]) {
    assert.ok(
      scopeJob.includes(scopedPath),
      `renderer scope must include ${scopedPath}`,
    );
  }
  assert.equal(
    scopeJob.split('echo "run_visual=true"').length - 1,
    3,
    "periodic/base, diff-failure, and matching-path branches must all force full renderer gates",
  );
  assert.match(
    scopeJob,
    /scope_paths="\$RUNNER_TEMP\/renderer-visual-scope-paths\.txt"/,
  );
  assert.match(
    scopeJob,
    /if ! git diff --no-renames --name-only -z "\$\{BASE_SHA\}\.\.\.\$\{HEAD_SHA\}" > "\$scope_paths"; then/,
  );
  assert.doesNotMatch(scopeJob, /< <\(git diff/);
  assert.match(scopeJob, /while IFS= read -r -d '' path; do/);
});

test("the live required build fails when its scope dependency is not successful", async () => {
  const [ciWorkflow, policyText] = await Promise.all([
    readRepositoryFile(".github/workflows/ci.yml"),
    readRepositoryFile(".github/required-contexts.json"),
  ]);
  const buildJob = jobBlock(ciWorkflow, "build-test");
  const firstStep = buildJob
    .split(/\r?\n/)
    .find((line) => /^      - (?:name:|uses:)/.test(line));
  const scopeGuardStep = namedStepBlock(
    buildJob,
    "Fail closed when renderer scope evaluation did not succeed",
  );
  const policy = JSON.parse(policyText);
  const buildPolicy = policy.context_implementations.find(
    (item) => item.name === "build · typecheck · test",
  );

  assert.match(buildJob, /\n {4}if: always\(\)/);
  assert.match(buildJob, /\n {4}needs: renderer-visual-scope/);
  assert.equal(
    firstStep,
    "      - name: Fail closed when renderer scope evaluation did not succeed",
  );
  assert.match(
    scopeGuardStep,
    /SCOPE_RESULT: \$\{\{ needs\.renderer-visual-scope\.result \}\}/,
  );
  assert.match(
    scopeGuardStep,
    /if \[\[ "\$SCOPE_RESULT" != "success" \]\]; then/,
  );
  assert.match(scopeGuardStep, /^            exit 1$/m);
  assert.equal(buildPolicy.allowed_job_if, "always()");
});

test("the Copy recovery rebuild gate rederives both fixed-source artifacts", async () => {
  const ciWorkflow = await readRepositoryFile(".github/workflows/ci.yml");
  const buildJob = jobBlock(ciWorkflow, "build-test");
  const impactStep = namedStepBlock(
    buildJob,
    "Evaluate Copy fixed-source impact",
  );
  const rebuildStep = namedStepBlock(
    buildJob,
    "Copy Sonnet recovery fixed-source rebuild（顺序隔离）",
  );

  assert.match(
    buildJob,
    /- uses: actions\/checkout@[0-9a-f]{40} # v7\n        with:\n          fetch-depth: 0\n          persist-credentials: false/,
    "the fixed-source ancestry check requires a complete trusted checkout",
  );
  assert.match(
    impactStep,
    /^      - name: Evaluate Copy fixed-source impact$/m,
  );
  assert.match(impactStep, /^        id: copy-impact$/m);
  assert.match(
    impactStep,
    /^        run: node scripts\/copy-fixed-source-impact\.mjs --github-output "\$GITHUB_OUTPUT"$/m,
  );
  assert.match(
    rebuildStep,
    /^        if: steps\.copy-impact\.outputs\.status == 'CURRENT'$/m,
  );
  assert.match(
    rebuildStep,
    /^          COPY_SONNET_RECOVERY_MANIFEST_REBUILD_TEST=1$/m,
  );
  assert.match(rebuildStep, /^          COPY_SONNET_RECOVERY_REBUILD_TEST=1$/m);
  assert.match(
    rebuildStep,
    /^          src\/site-builder\/eval\/copy-sonnet-recovery-manifest-prep\.spec\.ts$/m,
  );
  assert.match(
    rebuildStep,
    /^          src\/site-builder\/eval\/copy-sonnet-recovery-runtime-binding-prep\.spec\.ts$/m,
  );
});

test("the topology cleanup does not rename or expand required contexts", async () => {
  const policy = JSON.parse(
    await readRepositoryFile(".github/required-contexts.json"),
  );
  assert.deepEqual(policy.required_contexts, [
    "renderer visual scope",
    "build · typecheck · test",
    "contracts · drift · lint · breaking",
    "gitleaks 密钥扫描",
    "governance · traceability · release",
    "nontechnical decision card freshness",
  ]);
});

test("the topology suite uses the established governance entry without changing the root command", async () => {
  const [packageText, governanceContractsTest] = await Promise.all([
    readRepositoryFile("package.json"),
    readRepositoryFile("scripts/governance-contracts.spec.mjs"),
  ]);
  const repositoryPackage = JSON.parse(packageText);

  assert.equal(
    repositoryPackage.scripts["governance:test"],
    "node --test scripts/governance-contracts.spec.mjs scripts/governance-path-contracts.spec.mjs",
    "the Copy fixed-source-bound root package command must remain unchanged",
  );
  assert.match(
    governanceContractsTest,
    /^import "\.\/governance-ci-topology\.spec\.mjs";$/m,
    "the existing governance test entry must load the topology suite",
  );
});

test("the Copy impact verifier and receipt remain code-owner controlled", async () => {
  const [codeowners, requiredContextsText] = await Promise.all([
    readRepositoryFile(".github/CODEOWNERS"),
    readRepositoryFile(".github/required-contexts.json"),
  ]);
  const requiredContexts = JSON.parse(requiredContextsText);
  const protectedPatterns = [
    "/scripts/copy-fixed-source-impact*.mjs",
    "/docs/evidence/site-builder/copy-runtime-eligibility.json",
    "/docs/implementation-records/copy-fixed-source-impact-governance.md",
  ];
  for (const pattern of protectedPatterns) {
    const rule = `${pattern} @mlhjyx`;
    assert.ok(codeowners.split(/\r?\n/u).includes(rule), `missing ${rule}`);
    assert.ok(
      requiredContexts.codeowner_requirements.terminal_patterns.includes(
        pattern,
      ),
      `machine CODEOWNERS policy is missing ${pattern}`,
    );
  }
});

test("the required build emits an exact-SHA runtime attestation after the final API rebuild", async () => {
  const ciWorkflow = await readRepositoryFile(".github/workflows/ci.yml");
  const buildJob = jobBlock(ciWorkflow, "build-test");
  const copyStep = namedStepBlock(
    buildJob,
    "Copy Sonnet recovery fixed-source rebuild（顺序隔离）",
  );
  const attestationStep = namedStepBlock(
    buildJob,
    "Generate and verify API build attestation",
  );

  assert.ok(
    buildJob.indexOf(attestationStep) > buildJob.indexOf(copyStep),
    "attestation must bind the final API dist bytes after the Copy rebuild",
  );
  assert.match(attestationStep, /BUILD_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(attestationStep, /BUILT_AT="\$\(date -u/);
  assert.match(
    attestationStep,
    /node scripts\/prepare-site-renderer-runtime\.mjs/,
  );
  assert.match(
    attestationStep,
    /pnpm --filter @global\/api --filter @global\/site-renderer list --prod --depth Infinity --json/,
  );
  assert.match(attestationStep, /node scripts\/generate-runtime-sbom\.mjs/);
  assert.match(
    attestationStep,
    /node scripts\/generate-runtime-artifact-manifest\.mjs/,
  );
  assert.match(
    attestationStep,
    /node scripts\/verify-runtime-artifact\.mjs apps\/api\/dist/,
  );
  assert.match(
    attestationStep,
    /pnpm exec tsx apps\/api\/scripts\/generate-build-attestation\.mts/,
  );
  assert.ok(
    attestationStep.indexOf("generate-runtime-sbom.mjs") <
      attestationStep.indexOf("generate-runtime-artifact-manifest.mjs") &&
      attestationStep.indexOf("generate-runtime-artifact-manifest.mjs") <
        attestationStep.indexOf("generate-build-attestation.mts"),
    "SBOM and artifact manifest must be fixed before the attestation is emitted",
  );
  assert.doesNotMatch(attestationStep, /git rev-parse|git describe|git status/);
});

test("the required build runs only the isolated zero-dispatch evaluation runner suite", async () => {
  const ciWorkflow = await readRepositoryFile(".github/workflows/ci.yml");
  const buildJob = jobBlock(ciWorkflow, "build-test");
  const evalStep = namedStepBlock(
    buildJob,
    "Site Builder isolated zero-dispatch evaluation boundary",
  );

  assert.match(
    evalStep,
    /run: pnpm --filter @global\/site-builder-eval-runner test\s*$/m,
  );
  assert.doesNotMatch(evalStep, /^\s+(?:env|with):/m);
});

test("the required build executes and inspects the exact-SHA immutable OCI contract", async () => {
  const ciWorkflow = await readRepositoryFile(".github/workflows/ci.yml");
  const buildJob = jobBlock(ciWorkflow, "build-test");
  const attestationStep = namedStepBlock(
    buildJob,
    "Generate and verify API build attestation",
  );
  const ociStep = namedStepBlock(
    buildJob,
    "Build and inspect immutable OCI runtime",
  );

  assert.ok(buildJob.indexOf(ociStep) > buildJob.indexOf(attestationStep));
  assert.match(ociStep, /BUILD_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(ociStep, /git diff --exit-code/);
  assert.match(ociStep, /git ls-files --others --exclude-standard/);
  assert.match(ociStep, /docker build/);
  assert.match(ociStep, /--build-arg "BUILD_SHA=\$\{BUILD_SHA\}"/);
  assert.match(ociStep, /--build-arg "BUILT_AT=\$\{BUILT_AT\}"/);
  assert.match(ociStep, /docker image inspect/);
  assert.match(ociStep, /docker cp/);
  assert.match(ociStep, /verify-runtime-artifact\.mjs/);
  assert.match(ociStep, /runtime-image-verifier\.mjs \/app/);
  assert.match(ociStep, /--entrypoint openssl/);
  assert.match(ociStep, /--entrypoint \/usr\/bin\/chromium/);
  assert.match(ociStep, /data:text\/html,<title>oci-browser-smoke<\/title>/);
  assert.doesNotMatch(ociStep, /docker push|buildx build.*--push/);
});

test("the required build verifies runtime lease roles against disposable PostgreSQL", async () => {
  const ciWorkflow = await readRepositoryFile(".github/workflows/ci.yml");
  const buildJob = jobBlock(ciWorkflow, "build-test");
  const permissionStep = namedStepBlock(
    buildJob,
    "Runtime lease principal PostgreSQL permissions",
  );

  assert.match(buildJob, /pgvector\/pgvector@sha256:[0-9a-f]{64}/);
  assert.match(permissionStep, /prisma migrate deploy/);
  assert.match(
    permissionStep,
    /provision-runtime-lease-principals\.sh/,
  );
  assert.match(
    permissionStep,
    /verify-runtime-lease-principal-permissions\.sh/,
  );
  assert.match(permissionStep, /verify-app-database-principal\.mts/);
  assert.match(permissionStep, /ALTER ROLE app_user BYPASSRLS/);
  assert.match(permissionStep, /ALTER ROLE app_user NOBYPASSRLS/);
  assert.doesNotMatch(permissionStep, /production|global_dev/);
});
