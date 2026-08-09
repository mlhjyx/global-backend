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
  const codeowners = await readRepositoryFile(".github/CODEOWNERS");
  for (const rule of [
    "/scripts/copy-fixed-source-impact*.mjs @mlhjyx",
    "/docs/evidence/site-builder/copy-runtime-eligibility.json @mlhjyx",
    "/docs/implementation-records/copy-fixed-source-impact-governance.md @mlhjyx",
  ]) {
    assert.ok(codeowners.split(/\r?\n/u).includes(rule), `missing ${rule}`);
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
    /pnpm exec tsx apps\/api\/scripts\/generate-build-attestation\.mts/,
  );
  assert.doesNotMatch(attestationStep, /git rev-parse|git describe|git status/);
});
