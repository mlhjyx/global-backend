/**
 * ops：模型技能的 Golden Set 发布层评测（S1 设计 §8.2；M2 步 13-1 首次实跑）。
 *
 * 经部署的模型网关（MODEL_GATEWAY_URL/KEY）逐条实跑技能的 `tier=model` 用例，
 * 输出先过技能自己的确定性守卫再断言；`--write-receipt` 把结果写成不可变
 * `eval_receipt`（tier=model），`--seed` 顺带把当前构建的技能目录经 S0 管线
 * 注册进库（owner 连接，与 worker 启动期同语义）。
 *
 * 用法：
 *   pnpm exec tsx scripts/run-skill-model-evals.mts \
 *     --skills outreach.sequence_draft,engage.reply_classify \
 *     [--write-receipt] [--seed] [--workspace <uuid>] [--max-cases 20]
 *
 * 前置：`pnpm --filter @global/db generate`（Prisma client）；apps/api/.env 可读。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "../packages/db/src/index";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
try {
  process.loadEnvFile(join(repoRoot, "apps/api/.env"));
} catch {
  // 允许纯环境变量运行（CI/容器）；缺网关变量时下面会显式报错。
}

const { getTask } = await import("../apps/api/src/ai-tasks/task-registry");
const { loadPlatformSkills } = await import("../apps/api/src/skills/load-builtin-skills");
const { canonicalDigest } = await import("../apps/api/src/model-runtime/context-engine");
const { buildGatewayProvider } = await import("../apps/api/src/model-gateway/model-providers.config");
const { runSkillModelEvals } = await import("../apps/api/src/skills/evals/skill-model-evals");
const { seedSkillCatalog } = await import("../apps/api/src/skills/skill-catalog.seed");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const skillsArg = argValue("skills");
if (!skillsArg) {
  fail("usage: run-skill-model-evals.mts --skills <key[,key]> [--write-receipt] [--seed] [--workspace <uuid>] [--max-cases N]");
}
const skillKeys = skillsArg.split(",").map((key) => key.trim()).filter(Boolean);
const maxCases = Number(argValue("max-cases") ?? 20);
if (!Number.isInteger(maxCases) || maxCases <= 0) fail("--max-cases must be a positive integer");

const builtinRoot = join(repoRoot, "apps/api/src/skills/builtin");
const importedRoot = join(repoRoot, "apps/api/src/skills/imported");
const { records, issues } = loadPlatformSkills({ builtinRoot, importedRoot, resolveContract: getTask });
const errors = issues.filter((issue) => issue.severity === "error");
if (errors.length > 0) {
  fail(`skills catalog has errors:\n${errors.map((issue) => `${issue.code} ${issue.file}: ${issue.message}`).join("\n")}`);
}

const provider = buildGatewayProvider(process.env);
if (!provider) fail("MODEL_GATEWAY_URL / MODEL_GATEWAY_KEY / MODEL_TIMEOUT_MS 缺失，无法实跑模型层评测");

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL ?? ownerUrl;
const owner = flag("seed") && ownerUrl ? new PrismaClient({ datasourceUrl: ownerUrl }) : null;
const receiptDb = flag("write-receipt") && appUrl ? new PrismaClient({ datasourceUrl: appUrl }) : null;

if (flag("seed") && !owner) fail("--seed 需要 DATABASE_URL（owner 连接）");
if (flag("write-receipt") && !receiptDb) fail("--write-receipt 需要 APP_DATABASE_URL 或 DATABASE_URL");

let workspaceId = argValue("workspace");
if (!workspaceId) {
  const probe = new PrismaClient({ datasourceUrl: ownerUrl ?? appUrl });
  try {
    const rows = await probe.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id"::text AS "id" FROM "workspace" ORDER BY "created_at" LIMIT 1
    `);
    workspaceId = rows[0]?.id;
  } finally {
    await probe.$disconnect();
  }
  if (!workspaceId) fail("no workspace row found; pass --workspace <uuid>");
}

if (flag("seed") && owner) {
  const seeded = await seedSkillCatalog(owner);
  process.stdout.write(
    `seed: ${seeded.packages} package(s), ${seeded.versionsInserted} version(s) inserted, ${seeded.versionsUnchanged} unchanged\n`,
  );
}

const runBy = process.env.SKILL_EVAL_RUN_BY ?? "ops:run-skill-model-evals";
let failedSkills = 0;

for (const skillKey of skillKeys) {
  const record = records.find((candidate) => candidate.skillKey === skillKey);
  if (!record) fail(`skill ${skillKey} is not in the platform catalog`);
  if (record.sourceId) fail(`skill ${skillKey} is imported; this runner covers builtin skills only`);
  const contract = getTask(record.manifest.platform.taskContractId ?? "");
  if (!contract) fail(`skill ${skillKey} has no live task contract`);

  const evalPath = join(builtinRoot, record.packTypeDirectory, record.directory, "evals/evals.json");
  const evals = JSON.parse(readFileSync(evalPath, "utf8")) as import("../apps/api/src/skills/evals/eval-manifest").EvalManifest;

  process.stdout.write(`\n=== ${skillKey}@${record.manifest.platform.version} (${evalPath}) ===\n`);
  const result = await runSkillModelEvals(
    { manifest: record.manifest, evals, contract },
    provider,
    {
      workspaceId,
      maxCases,
      onCase: (entry) => {
        const status = entry.ok ? "PASS" : "FAIL";
        process.stdout.write(
          `  ${status}  ${String(entry.id)}${entry.model ? `  [${entry.model}]` : ""}\n`,
        );
        for (const failure of entry.failures) process.stdout.write(`        - ${failure}\n`);
      },
    },
  );
  process.stdout.write(
    `  -> ${result.casesPassed}/${result.casesTotal} passed; model=${result.models.join(",") || "n/a"}; costMicros=${result.costMicros ?? "n/a"}\n`,
  );
  if (!result.passed) failedSkills += 1;

  if (receiptDb) {
    const manifestDigest = canonicalDigest(record.manifest);
    const evalManifestDigest = canonicalDigest(evals);
    const rows = await receiptDb.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO "eval_receipt"
        ("subject_kind", "subject_key", "subject_version", "subject_digest",
         "eval_manifest_digest", "tier", "model", "passed", "cases_total", "cases_passed",
         "cost_micros", "run_by")
      VALUES
        ('skill', ${skillKey}, ${record.manifest.platform.version}, ${manifestDigest},
         ${evalManifestDigest}, 'model', ${result.models.join(",") || null}, ${result.passed},
         ${result.casesTotal}, ${result.casesPassed}, ${result.costMicros}, ${runBy})
      RETURNING "id"::text AS "id"
    `);
    process.stdout.write(`  receipt: ${rows[0]?.id} (tier=model, passed=${result.passed})\n`);
  }
}

await owner?.$disconnect();
await receiptDb?.$disconnect();

if (failedSkills > 0) {
  process.stderr.write(`\nmodel-tier eval failures: ${failedSkills} skill(s)\n`);
  process.exit(1);
}
process.stdout.write("\nmodel-tier eval: all skills passed\n");
