import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import {
  settlementOpenOxPrice,
  OPENOX_PRICING_AUTHORITY,
  type OpenOxPricingCatalog,
} from "../src/site-builder/site-builder-model-settlement";
import { writeRepositoryJsonCreateOnly } from "../src/site-builder/eval/create-only-json";
import { assertRemainingTextNativeFeeCardManifest } from "../src/site-builder/eval/remaining-text-native-fee-card";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MANIFEST_PATH = "docs/evidence/site-builder/m1-g-remaining-text-evaluation-manifest-v1.json";
const OUTPUT_PATH = "docs/evidence/site-builder/m1-g-quality-narrative-public-price-block-2026-08-04.json";
const MAX_CATALOG_BYTES = 1_048_576;
const TASK_IDS = ["site_builder.qa_summarize", "site_builder.seo_review"] as const;

function cleanHead(): string {
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  if (dirty) throw new Error("quality narrative public-price check requires a clean worktree");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("quality narrative public-price check head is invalid");
  return head;
}

async function readCatalog(): Promise<{ catalog: OpenOxPricingCatalog; responseSha256: string }> {
  const response = await fetch(`${OPENOX_PRICING_AUTHORITY.origin}${OPENOX_PRICING_AUTHORITY.catalogEndpoint}`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OpenOx pricing catalog request failed: HTTP ${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CATALOG_BYTES)) {
    throw new Error("OpenOx pricing catalog exceeds the byte limit");
  }
  if (!response.body) throw new Error("OpenOx pricing catalog body is unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new Error("OpenOx pricing catalog exceeds the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    catalog: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as OpenOxPricingCatalog,
    responseSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function publicPricingRule(alias: string): { groupName: "gpt-unified" | "special"; currency: "CNY" | "USD" } {
  if (alias === "claude-sonnet-5") return { groupName: "special", currency: "USD" };
  if (alias === "gpt-5.4-mini" || alias === "gpt-5.5" || alias === "gpt-5.6-luna" || alias === "gpt-5.6-terra") {
    return { groupName: "gpt-unified", currency: "CNY" };
  }
  throw new Error(`quality narrative candidate has no public pricing rule: ${alias}`);
}

async function main(): Promise<void> {
  const head = cleanHead();
  const source = execFileSync("git", ["show", `HEAD:${MANIFEST_PATH}`], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  const manifest = JSON.parse(source) as { tasks?: unknown[] };
  for (const taskId of TASK_IDS) {
    assertRemainingTextNativeFeeCardManifest(REPOSITORY_ROOT, manifest, taskId);
  }
  const tasks = manifest.tasks?.filter(
    (task): task is { taskId: string; candidates: { alias: string; protocol: string }[] } =>
      !!task && typeof task === "object" && "taskId" in task && TASK_IDS.includes((task as { taskId: typeof TASK_IDS[number] }).taskId),
  );
  if (!tasks || tasks.length !== TASK_IDS.length) throw new Error("quality narrative task manifest is invalid");
  const candidateKeys = tasks.map((task) => JSON.stringify(task.candidates));
  if (candidateKeys[0] !== candidateKeys[1]) throw new Error("quality narrative candidate matrices differ");
  const { catalog, responseSha256 } = await readCatalog();
  const candidates = tasks[0]!.candidates.map((candidate) => {
    const rule = publicPricingRule(candidate.alias);
    const price = settlementOpenOxPrice(catalog, candidate.alias, rule.groupName);
    return {
      alias: candidate.alias,
      protocol: candidate.protocol,
      groupName: rule.groupName,
      currency: rule.currency,
      publicPriceStatus: price && price.currency === rule.currency ? "PUBLISHED" as const : "MISSING" as const,
    };
  });
  const missingAliases = candidates.filter((candidate) => candidate.publicPriceStatus === "MISSING").map((candidate) => candidate.alias);
  if (missingAliases.length === 0) throw new Error("quality narrative public price block is no longer applicable");
  await writeRepositoryJsonCreateOnly(REPOSITORY_ROOT, OUTPUT_PATH, {
    schemaVersion: "site-builder-quality-narrative-public-price-block/v1",
    preparationCommitSha: head,
    fixedSourceCommitSha: "0891b374321961b8aad13c8b215985ca623a4c0c",
    manifestSha256: (manifest as { manifestSha256?: unknown }).manifestSha256,
    taskIds: TASK_IDS,
    pricing: {
      authority: "openox_model_marketplace",
      catalogEndpoint: "https://openox.tech/api/public/pricing-catalog",
      capturedAt: new Date().toISOString(),
      catalogResponseSha256: responseSha256,
    },
    candidates,
    missingAliases,
    status: "BLOCKED_MISSING_PUBLIC_PRICE",
    dispatchAuthorization: "NOT_AUTHORIZED",
    modelWireCalls: 0,
    actualModelCost: { CNY: "0", USD: "0" },
  });
  process.stdout.write(`created ${OUTPUT_PATH}; missing=${missingAliases.join(",")}; model_wire_calls=0; dispatch=NOT_AUTHORIZED\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
