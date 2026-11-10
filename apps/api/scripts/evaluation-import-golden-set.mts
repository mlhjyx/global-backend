/**
 * golden set 导入 CLI（获客 vNext W3）：
 *
 * 从 JSON 文件创建（或复用）一个 evaluation_set 并批量导入人工标注。语义与
 * POST /evaluation/sets 与 POST /evaluation/sets/:id/labels 完全一致：
 * 同集同候选键（canonical id / domain / name+country）覆盖，重导即重标注。
 *
 * 文件格式：
 *   {
 *     "name": "golden-de-pumps-2026-11",
 *     "version": 1,
 *     "icpId": "<uuid>" | null,
 *     "description": "德国泵类分销商，来源=展会名录+官网人工核验",
 *     "labels": [
 *       { "label": "POSITIVE", "canonicalCompanyId": "<uuid>", "note": "官网在售 5 个泵品牌" },
 *       { "label": "NEGATIVE", "domain": "example-distributor.de" },
 *       { "label": "POSITIVE", "name": "Acme Pumpen GmbH", "country": "DE" }
 *     ]
 *   }
 *
 * 运行（apps/api 下；owner 连接，需先 prisma migrate deploy）：
 *   node --import tsx scripts/evaluation-import-golden-set.mts \
 *     --workspace=<uuid> --file=docs/eval/golden-de-pumps.json [--dry-run]
 */
import "dotenv/config";
process.umask(0o077);
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { candidateKey } from "../src/evaluation/evaluation.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface GoldenLabelFile {
  name: string;
  version?: number;
  icpId?: string | null;
  description?: string | null;
  labels: Array<{
    label: "POSITIVE" | "NEGATIVE";
    canonicalCompanyId?: string;
    domain?: string;
    name?: string;
    country?: string;
    note?: string;
  }>;
}

function one(argv: string[], name: string): string | null {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseFile(text: string): GoldenLabelFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("标注文件不是合法 JSON");
  }
  const file = parsed as GoldenLabelFile;
  if (typeof file?.name !== "string" || file.name.trim() === "") fail("缺少 name");
  if (file.version !== undefined && (!Number.isInteger(file.version) || file.version < 1)) {
    fail("version 必须是 ≥1 的整数");
  }
  if (file.icpId != null && !UUID.test(file.icpId)) fail("icpId 必须是 uuid");
  if (!Array.isArray(file.labels) || file.labels.length === 0) fail("labels 必须是非空数组");
  for (const [index, label] of file.labels.entries()) {
    const where = `labels[${index}]`;
    if (label.label !== "POSITIVE" && label.label !== "NEGATIVE") {
      fail(`${where}.label 必须是 POSITIVE 或 NEGATIVE`);
    }
    if (label.canonicalCompanyId != null && !UUID.test(label.canonicalCompanyId)) {
      fail(`${where}.canonicalCompanyId 必须是 uuid`);
    }
    try {
      candidateKey(label);
    } catch {
      fail(`${where} 缺少候选引用（canonicalCompanyId/domain/name 至少一个）`);
    }
  }
  return file;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const workspace = one(argv, "workspace");
  const filePath = one(argv, "file");
  const dryRun = argv.includes("--dry-run");
  if (!workspace || !UUID.test(workspace)) fail("--workspace=<uuid> 必填");
  if (!filePath) fail("--file=<path> 必填");
  const file = parseFile(readFileSync(filePath, "utf8"));
  const version = file.version ?? 1;

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.evaluationSet.findUnique({
      where: { workspaceId_name_version: { workspaceId: workspace, name: file.name.trim(), version } },
    });
    if (dryRun) {
      const positives = file.labels.filter((label) => label.label === "POSITIVE").length;
      console.log(
        `[dry-run] set=${file.name}#${version} ${existing ? "已存在（复用）" : "将新建"}；` +
          `标注 ${file.labels.length} 条（POSITIVE ${positives} / NEGATIVE ${file.labels.length - positives}）`,
      );
      return;
    }
    const set =
      existing ??
      (await prisma.evaluationSet.create({
        data: {
          workspaceId: workspace,
          name: file.name.trim(),
          version,
          icpId: file.icpId ?? null,
          description: file.description ?? null,
          createdBy: "cli:evaluation-import-golden-set",
        },
      }));
    const now = new Date();
    for (const label of file.labels) {
      const key = candidateKey(label);
      const data = {
        canonicalCompanyId: label.canonicalCompanyId ?? null,
        domain: label.domain?.trim().toLowerCase() ?? null,
        name: label.name?.trim() ?? null,
        country: label.country?.trim().toUpperCase() ?? null,
        label: label.label,
        labeledBy: "cli:evaluation-import-golden-set",
        labeledAt: now,
        note: label.note ?? null,
      };
      await prisma.evaluationLabel.upsert({
        where: { setId_candidateKey: { setId: set.id, candidateKey: key } },
        create: { workspaceId: workspace, setId: set.id, candidateKey: key, ...data },
        update: data,
      });
    }
    console.log(
      `✓ set ${set.id}（${file.name}#${version}）导入 ${file.labels.length} 条标注` +
        `（POSITIVE ${file.labels.filter((label) => label.label === "POSITIVE").length}）`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error("✗ 导入失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
