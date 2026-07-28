import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { validateSiteSpecV1_1 } from "@global/contracts";
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
const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

function run(
  label: string,
  command: string,
  commandArgs: string[],
  cwd = repositoryRoot,
): void {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `M1_G_STEP_FAILED: ${label} (${result.status ?? "signal"})`,
    );
  }
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
      const value = JSON.parse(bytes.toString()) as {
        id?: string;
        schemaVersion?: string;
        materialCompleteness?: string;
      };
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

async function verifyScreenshots() {
  const root = path.join(rendererRoot, "visual-tests/__screenshots__/m1-e-b");
  const manifestBytes = await readFile(path.join(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString()) as {
    schemaVersion?: string;
    screenshotCount?: number;
    screenshots?: Array<{ path: string; sha256: string }>;
  };
  assert.equal(
    manifest.schemaVersion,
    "site-builder-m1-e-b-visual-evidence/v1",
    "M1_G_SCREENSHOT_MANIFEST_SCHEMA_FAILED",
  );
  assert.equal(manifest.screenshotCount, 36, "M1_G_SCREENSHOT_COUNT_FAILED");
  assert.equal(manifest.screenshots?.length, 36);
  for (const screenshot of manifest.screenshots ?? []) {
    const bytes = await readFile(path.join(root, screenshot.path));
    assert.equal(
      sha256(bytes),
      screenshot.sha256,
      `M1_G_SCREENSHOT_HASH_FAILED: ${screenshot.path}`,
    );
  }
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
const screenshots = await verifyScreenshots();

const report: Record<string, unknown> & { status: string } = {
  schemaVersion: "site-builder-m1-g-stage-closeout/v1",
  status: "STATIC_BASELINE_VERIFIED",
  networkCallsDuringStaticBaseline: 0,
  modelCallsDuringStaticBaseline: 0,
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
  compatibility: {
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
  run(
    "P1-P5 current-route true chain",
    "node",
    ["--import", "tsx", "scripts/verify-site-builder-m1eb.mts"],
    apiRoot,
  );
  report.status = "FULL_VERIFICATION_PASSED";
}

if (writeReport) {
  const outputPath = path.join(
    repositoryRoot,
    "docs/evidence/site-builder/m1-g-stage-closeout-baseline.json",
  );
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "w",
  });
  console.log(path.relative(repositoryRoot, outputPath));
}

console.log(JSON.stringify(report, null, 2));
