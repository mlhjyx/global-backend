import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { validateSiteSpecV1_1 } from "@global/contracts";
import type { BrandProfileOutput } from "../src/site-builder/agents/brand-profile";
import {
  evaluateBrandProfileOutput,
  prepareBrandProfileEvalFixture,
  type BrandProfileEvalFixture,
} from "../src/site-builder/eval/brand-profile-eval";
import {
  verifyM1GoldenSuite,
  type M1GoldenFixture,
} from "../src/site-builder/eval/m1-stage-closeout";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const apiRoot = path.join(repositoryRoot, "apps/api");
const rendererRoot = path.join(repositoryRoot, "apps/site-renderer");
const args = new Set(process.argv.slice(2));
const live = args.has("--live") || args.has("--full");
const includeCurrentRouteModels = args.has("--full");
const writeReport = args.has("--write");
const reportRelativePath =
  "docs/evidence/site-builder/m1-g-stage-closeout-baseline.json";
const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

function run(
  label: string,
  command: string,
  commandArgs: string[],
  cwd = repositoryRoot,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `M1_G_STEP_FAILED: ${label} (${result.status ?? "signal"})`,
    );
  }
}

function gitOutput(args: string[]): Buffer {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: null,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`M1_G_GIT_IDENTITY_FAILED: git ${args.join(" ")}`);
  }
  return result.stdout;
}

async function sourceIdentity() {
  const status = gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])
    .toString("utf8")
    .trim();
  if (writeReport) {
    assert.equal(status, "", "M1_G_WRITE_REQUIRES_CLEAN_SOURCE");
  }
  const sourceCommit = gitOutput(["rev-parse", "HEAD"])
    .toString("utf8")
    .trim();
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const trackedPaths = gitOutput(["ls-files", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(
      (entry) =>
        entry.length > 0 &&
        entry !== reportRelativePath &&
        !entry.startsWith(".code-intelligence/"),
    )
    .sort();
  const bundleHash = createHash("sha256");
  for (const relativePath of trackedPaths) {
    const bytes = await readFile(path.join(repositoryRoot, relativePath));
    bundleHash.update(`${relativePath.length}:${relativePath}:`);
    bundleHash.update(`${bytes.length}:`);
    bundleHash.update(bytes);
  }
  const verifierBytes = await readFile(fileURLToPath(import.meta.url));
  return {
    sourceCommit,
    sourceClean: status === "",
    verifierSha256: sha256(verifierBytes),
    sourceBundleSha256: bundleHash.digest("hex"),
    trackedFileCount: trackedPaths.length,
    excludedPaths: [reportRelativePath],
  };
}

async function verifyBootstrapFixtures() {
  const root = path.join(
    apiRoot,
    "test/fixtures/golden-companies/brand-profile",
  );
  const filenames = (await readdir(root))
    .filter((filename) => filename.endsWith(".json"))
    .sort();
  assert.equal(filenames.length, 6, "M1_G_BOOTSTRAP_FIXTURE_COUNT_FAILED");
  const fixtures = await Promise.all(
    filenames.map(async (filename) => {
      const bytes = await readFile(path.join(root, filename));
      const value = JSON.parse(bytes.toString()) as BrandProfileEvalFixture;
      assert.equal(
        value.schemaVersion,
        "brand-profile-eval-fixture/v1",
        `M1_G_BOOTSTRAP_SCHEMA_FAILED: ${filename}`,
      );
      assert(
        value.materialCompleteness === "sparse" ||
          value.materialCompleteness === "rich",
        `M1_G_BOOTSTRAP_MODE_FAILED: ${filename}`,
      );
      assert(
        typeof value.id === "string" && value.id.length > 0,
        `M1_G_BOOTSTRAP_ID_FAILED: ${filename}`,
      );
      assert(
        typeof value.companyName === "string" && value.companyName.length > 0,
        `M1_G_BOOTSTRAP_COMPANY_FAILED: ${filename}`,
      );
      for (const [field, items] of [
        ["products", value.products],
        ["targetMarkets", value.targetMarkets],
        ["sources", value.sources],
      ] as const) {
        assert(
          Array.isArray(items) && items.length > 0,
          `M1_G_BOOTSTRAP_${field.toUpperCase()}_FAILED: ${filename}`,
        );
      }
      assert(
        Number.isInteger(value.assertions?.minimumAcceptedFacts) &&
          value.assertions.minimumAcceptedFacts > 0 &&
          Array.isArray(value.assertions.requiredAcceptedTerms) &&
          value.assertions.requiredAcceptedTerms.length >=
            value.assertions.minimumAcceptedFacts &&
          value.assertions.requiredAcceptedTerms.every(
            (term) => typeof term === "string" && term.length > 0,
          ) &&
          Array.isArray(value.assertions.forbiddenOutputTerms) &&
          value.assertions.forbiddenOutputTerms.every(
            (term) => typeof term === "string" && term.length > 0,
          ),
        `M1_G_BOOTSTRAP_ASSERTIONS_FAILED: ${filename}`,
      );
      assert.equal(
        new Set(value.sources.map(({ id }) => id)).size,
        value.sources.length,
        `M1_G_BOOTSTRAP_SOURCE_ID_FAILED: ${filename}`,
      );
      const prepared = prepareBrandProfileEvalFixture(value);
      const factKeys = ["products", "dimensions", "materials"] as const;
      const factSheet = value.assertions.requiredAcceptedTerms.map((term, index) => {
        const source = value.sources.find(({ content }) =>
          content.toLocaleLowerCase("en-US").includes(
            term.toLocaleLowerCase("en-US"),
          ),
        );
        assert(
          source,
          `M1_G_BOOTSTRAP_REQUIRED_TERM_UNGROUNDED: ${filename}/${term}`,
        );
        const frozen = prepared.frozenSources.get(source.id);
        assert(
          frozen,
          `M1_G_BOOTSTRAP_FROZEN_SOURCE_MISSING: ${filename}/${source.id}`,
        );
        return {
          key: factKeys[index % factKeys.length],
          value: term,
          evidence: {
            sourceType: frozen.sourceType,
            sourceId: source.id,
            contentHash: frozen.contentHash,
            quote: source.content,
          },
        };
      });
      const contractProbe: BrandProfileOutput = {
        valueProps: ["Grounded company information."],
        keywords: [],
        glossary: [],
        differentiators: [],
        competitors: [],
        gaps: [],
        factSheet,
      };
      assert.equal(
        evaluateBrandProfileOutput(prepared, contractProbe).acceptedArtifact,
        true,
        `M1_G_BOOTSTRAP_ACCEPTANCE_FAILED: ${filename}`,
      );
      return {
        id: value.id,
        mode: value.materialCompleteness,
        path: `apps/api/test/fixtures/golden-companies/brand-profile/${filename}`,
        sha256: sha256(bytes),
      };
    }),
  );
  assert.equal(
    fixtures.filter(({ mode }) => mode === "sparse").length,
    3,
    "M1_G_BOOTSTRAP_SPARSE_COUNT_FAILED",
  );
  assert.equal(
    fixtures.filter(({ mode }) => mode === "rich").length,
    3,
    "M1_G_BOOTSTRAP_RICH_COUNT_FAILED",
  );
  return fixtures;
}

async function verifyVisualFixtures(): Promise<{
  suite: ReturnType<typeof verifyM1GoldenSuite>;
  fixtures: Array<{
    id: string;
    familyId: string;
    mode: string;
    path: string;
    sha256: string;
  }>;
}> {
  const root = path.join(rendererRoot, "fixtures/m1-e-b-golden");
  const manifestBytes = await readFile(path.join(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString()) as {
    schemaVersion?: string;
    fixtures?: Array<{
      id: string;
      familyId: string;
      mode: "sparse" | "rich";
      specSha256: string;
    }>;
  };
  assert.equal(
    manifest.schemaVersion,
    "site-builder-m1-e-b-golden-manifest/v1",
    "M1_G_VISUAL_MANIFEST_SCHEMA_FAILED",
  );
  assert.equal(
    manifest.fixtures?.length,
    12,
    "M1_G_VISUAL_MANIFEST_COUNT_FAILED",
  );
  const fixtures: M1GoldenFixture[] = [];
  const evidence = [];
  for (const entry of manifest.fixtures ?? []) {
    const relativePath = `apps/site-renderer/fixtures/m1-e-b-golden/${entry.id}-spec.json`;
    const bytes = await readFile(path.join(repositoryRoot, relativePath));
    assert.equal(
      sha256(bytes),
      entry.specSha256,
      `M1_G_VISUAL_SPEC_HASH_FAILED: ${entry.id}`,
    );
    const spec = validateSiteSpecV1_1(JSON.parse(bytes.toString()));
    assert.equal(
      spec.site.familyId,
      entry.familyId,
      `M1_G_VISUAL_FAMILY_BINDING_FAILED: ${entry.id}`,
    );
    fixtures.push({ ...entry, spec });
    evidence.push({
      id: entry.id,
      familyId: entry.familyId,
      mode: entry.mode,
      path: relativePath,
      sha256: entry.specSha256,
    });
  }
  return { suite: verifyM1GoldenSuite(fixtures), fixtures: evidence };
}

async function verifyScreenshots(fixtureIds: readonly string[]) {
  const root = path.join(rendererRoot, "visual-tests/__screenshots__/m1-e-b");
  const manifestBytes = await readFile(path.join(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString()) as {
    schemaVersion?: string;
    screenshotCount?: number;
    screenshots?: Array<{
      fixtureId: string;
      viewport: string;
      path: string;
      sha256: string;
    }>;
  };
  assert.equal(
    manifest.schemaVersion,
    "site-builder-m1-e-b-visual-evidence/v1",
    "M1_G_SCREENSHOT_MANIFEST_SCHEMA_FAILED",
  );
  assert.equal(manifest.screenshotCount, 36, "M1_G_SCREENSHOT_COUNT_FAILED");
  assert.equal(manifest.screenshots?.length, 36);
  const viewports = ["desktop-1440", "mobile-375", "tablet-768"] as const;
  const expected = new Set(
    fixtureIds.flatMap((fixtureId) =>
      viewports.map((viewport) => `${fixtureId}\0${viewport}`),
    ),
  );
  const actual = new Set<string>();
  for (const screenshot of manifest.screenshots ?? []) {
    const binding = `${screenshot.fixtureId}\0${screenshot.viewport}`;
    assert(
      expected.has(binding),
      `M1_G_SCREENSHOT_BINDING_UNEXPECTED: ${screenshot.fixtureId}/${screenshot.viewport}`,
    );
    assert(
      !actual.has(binding),
      `M1_G_SCREENSHOT_BINDING_DUPLICATE: ${screenshot.fixtureId}/${screenshot.viewport}`,
    );
    actual.add(binding);
    assert.equal(
      screenshot.path,
      `${screenshot.viewport}/${screenshot.fixtureId}.png`,
      `M1_G_SCREENSHOT_PATH_FAILED: ${binding}`,
    );
    assert.match(
      screenshot.sha256,
      /^[a-f0-9]{64}$/,
      `M1_G_SCREENSHOT_HASH_FORMAT_FAILED: ${binding}`,
    );
    const bytes = await readFile(path.join(root, screenshot.path));
    assert.equal(
      sha256(bytes),
      screenshot.sha256,
      `M1_G_SCREENSHOT_HASH_FAILED: ${screenshot.path}`,
    );
  }
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    "M1_G_SCREENSHOT_MATRIX_FAILED",
  );
  return {
    count: manifest.screenshotCount,
    manifestPath:
      "apps/site-renderer/visual-tests/__screenshots__/m1-e-b/manifest.json",
    manifestSha256: sha256(manifestBytes),
  };
}

async function verifyLiveInfrastructurePreflight(): Promise<void> {
  for (const name of [
    "DATABASE_URL",
    "APP_DATABASE_URL",
    "MODEL_GATEWAY_URL",
    "MODEL_GATEWAY_KEY",
  ]) {
    assert(process.env[name], `M1_G_LIVE_ENV_MISSING: ${name}`);
  }
  const temporalAddress =
    process.env.TEMPORAL_ADDRESS?.trim() || "127.0.0.1:7233";
  const temporalTarget = new URL(`tcp://${temporalAddress}`);
  assert(
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      temporalTarget.hostname.toLowerCase(),
    ) && temporalTarget.port === "7233",
    "M1_G_NON_DEVELOPMENT_TARGET: TEMPORAL_ADDRESS",
  );
  const temporalNamespace =
    process.env.TEMPORAL_NAMESPACE?.trim() || "default";
  assert(
    temporalNamespace === "default" ||
      /^dev-[a-z0-9-]+$/.test(temporalNamespace) ||
      /^m1-g-[a-z0-9-]+$/.test(temporalNamespace),
    "M1_G_NON_DEVELOPMENT_TARGET: TEMPORAL_NAMESPACE",
  );
  for (const name of [
    "DATABASE_URL",
    "APP_DATABASE_URL",
    "MODEL_GATEWAY_URL",
  ]) {
    const target = new URL(process.env[name]!);
    assert(
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname),
      `M1_G_NON_DEVELOPMENT_TARGET: ${name}`,
    );
  }
  const app = new PrismaClient({
    datasourceUrl: process.env.APP_DATABASE_URL,
  });
  try {
    const rows = await app.$queryRaw<Array<{ is_superuser: boolean }>>`
      SELECT current_setting('is_superuser')::boolean AS is_superuser
    `;
    assert.equal(rows[0]?.is_superuser, false, "M1_G_RLS_ROLE_IS_SUPERUSER");
  } finally {
    await app.$disconnect();
  }
  const gatewayUrl = process.env.MODEL_GATEWAY_URL!.replace(/\/$/, "");
  const response = await fetch(`${gatewayUrl}/models`, {
    headers: {
      authorization: `Bearer ${process.env.MODEL_GATEWAY_KEY}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(
    response.ok,
    true,
    `M1_G_NEW_API_MODELS_FAILED: ${response.status}`,
  );
}

const bootstrap = await verifyBootstrapFixtures();
const visual = await verifyVisualFixtures();
const screenshots = await verifyScreenshots(
  visual.fixtures.map(({ id }) => id),
);
const frozenSourceIdentity = await sourceIdentity();

const report: Record<string, unknown> & { status: string } = {
  schemaVersion: "site-builder-m1-g-stage-closeout/v1",
  status: "STATIC_BASELINE_VERIFIED",
  networkCallsDuringStaticBaseline: 0,
  modelCallsDuringStaticBaseline: 0,
  sourceIdentity: frozenSourceIdentity,
  bootstrap: {
    count: bootstrap.length,
    sparse: bootstrap.filter(({ mode }) => mode === "sparse").length,
    rich: bootstrap.filter(({ mode }) => mode === "rich").length,
    fixtures: bootstrap,
  },
  visual: {
    ...visual.suite,
    fixtures: visual.fixtures,
    screenshots,
  },
  compatibilityInventory: {
    verifiedByCurrentEntrypoint: false,
    note:
      "Declared compatibility inventory only; dedicated contract suites own these claims.",
    siteSpec: ["1.0.0", "1.1.0"],
    releaseManifest: ["v1", "v2", "v3"],
    locales: ["en", "de-DE", "ar"],
  },
  explicitlyIncomplete: {
    matureSystemGolden: "0/30+",
    model2TaskPromotions: "incomplete",
    aestheticGold: "not established by deterministic screenshots",
    productionDeployment: false,
  },
};

if (live) {
  assert.equal(process.env.ALLOW_DEV_DB_VERIFIER, "true");
  assert.notEqual(process.env.NODE_ENV, "production");
  await verifyLiveInfrastructurePreflight();
  run(
    "M1-c image pipeline",
    "node",
    ["--import", "tsx", "scripts/verify-site-builder-m1c.mts"],
    apiRoot,
  );
  run(
    "M1-d locale and renderer",
    "node",
    ["--import", "tsx", "scripts/verify-site-builder-m1d.mts"],
    apiRoot,
  );
  run(
    "M1-f Temporal replay/cancel/rollback matrix",
    "node",
    ["--import", "tsx", "scripts/verify-site-builder-m1f-temporal.mts"],
    apiRoot,
  );
  run(
    "12 visual fixtures at three breakpoints",
    "node",
    ["scripts/verify-m1eb-golden-visuals.mjs"],
    rendererRoot,
  );
  report.status = "LIVE_NO_MODEL_VERIFICATION_PASSED";
  report.liveNoModel = {
    developmentOnly: true,
    currentRouteModelCalls: 0,
    verified: [
      "PostgreSQL/FORCE RLS non-superuser",
      "new-api /models",
      "MinIO image variants and cleanup",
      "en/de-DE neutral copy and Release v1",
      "Temporal replay/cancel/rollback matrix",
      "Astro 12 fixtures x 3 breakpoints",
    ],
  };
}

if (includeCurrentRouteModels) {
  assert.equal(
    process.env.ALLOW_M1_G_CURRENT_ROUTE_MODEL_CALLS,
    "true",
    "M1_G_CURRENT_ROUTE_MODEL_CALLS_NOT_AUTHORIZED",
  );
  const resultDirectory = await mkdtemp(
    path.join(tmpdir(), "m1-g-full-result-"),
  );
  try {
    const resultPath = path.join(resultDirectory, "full-result.json");
    run(
      "P1-P5 current-route true chain",
      "node",
      ["--import", "tsx", "scripts/verify-site-builder-m1eb.mts"],
      apiRoot,
      { ...process.env, M1_G_FULL_RESULT_PATH: resultPath },
    );
    const fullResult = JSON.parse(
      await readFile(resultPath, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(
      fullResult.schemaVersion,
      "site-builder-m1-g-full-result/v1",
      "M1_G_FULL_RESULT_SCHEMA_FAILED",
    );
    assert.equal(
      fullResult.status,
      "passed",
      "M1_G_FULL_CURRENT_ROUTE_TASKS_FAILED",
    );
    assert.equal(
      fullResult.releaseManifestSchemaVersion,
      "site-builder-release-manifest/v3",
      "M1_G_FULL_RELEASE_MANIFEST_FAILED",
    );
    assert.equal(
      fullResult.unknownOperations,
      0,
      "M1_G_FULL_SETTLEMENT_UNKNOWN",
    );
    report.fullCurrentRoute = fullResult;
    report.status = "FULL_VERIFICATION_PASSED";
  } finally {
    await rm(resultDirectory, { recursive: true, force: true });
  }
}

if (writeReport) {
  const outputPath = path.join(
    repositoryRoot,
    reportRelativePath,
  );
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "w",
  });
  console.log(path.relative(repositoryRoot, outputPath));
}

console.log(JSON.stringify(report, null, 2));
