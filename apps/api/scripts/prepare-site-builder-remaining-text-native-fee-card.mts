import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OPENOX_PRICING_AUTHORITY } from "../src/site-builder/site-builder-model-settlement";
import { writeRepositoryJsonCreateOnly } from "../src/site-builder/eval/create-only-json";
import {
  assertRemainingTextNativeFeeCardManifest,
  buildRemainingTextNativeFeeCard,
  REMAINING_TEXT_NATIVE_FEE_CARD_TASK_IDS,
  type RemainingTextNativeFeeCardTaskId,
} from "../src/site-builder/eval/remaining-text-native-fee-card";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MANIFEST_PATH = "docs/evidence/site-builder/m1-g-remaining-text-evaluation-manifest-v2.json";
const MAX_CATALOG_BYTES = 1_048_576;
const EVIDENCE_PATH = /^docs\/evidence\/site-builder\/[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/;

const HELP = `Usage:
  pnpm --filter @global/api exec tsx scripts/prepare-site-builder-remaining-text-native-fee-card.mts \\
    --task=site_builder.copy \\
    --output=docs/evidence/site-builder/<new-fee-card>.json

This command reads only the committed remaining-text manifest and OpenOx's
public pricing catalog. It never reads credentials, calls a model, changes a
route, or authorizes dispatch. Output is create-only and NOT_AUTHORIZED.
`;

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const matches = process.argv.slice(2).filter((value) => value.startsWith(prefix));
  return matches.length === 1 ? matches[0]!.slice(prefix.length) : null;
}

function requiredTask(): RemainingTextNativeFeeCardTaskId {
  const task = option("task");
  if (!task || !REMAINING_TEXT_NATIVE_FEE_CARD_TASK_IDS.includes(task as RemainingTextNativeFeeCardTaskId)) {
    throw new Error("--task must be one remaining text evaluation task");
  }
  return task as RemainingTextNativeFeeCardTaskId;
}

function requiredEvidencePath(): string {
  const output = option("output")?.trim();
  if (!output || !EVIDENCE_PATH.test(output) || output.includes("\\") || output.includes("//") || output.split("/").includes("..")) {
    throw new Error("--output must be a new repository-relative evidence JSON path");
  }
  return output;
}

function currentCleanHead(): string {
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  if (dirty) throw new Error("remaining text fee-card preparation requires a clean worktree");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("remaining text fee-card preparation head is invalid");
  return head;
}

async function decodeBoundedCatalogResponse(response: Response): Promise<{ catalog: unknown; responseSha256: string }> {
  if (!response.ok) throw new Error(`OpenOx pricing catalog request failed: HTTP ${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_CATALOG_BYTES) {
      throw new Error("OpenOx pricing catalog exceeds the byte limit");
    }
  }
  if (!response.body) throw new Error("OpenOx pricing catalog body is unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new Error("OpenOx pricing catalog exceeds the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    catalog: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    responseSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const taskId = requiredTask();
  const output = requiredEvidencePath();
  const head = currentCleanHead();
  const committedManifest = execFileSync("git", ["show", `HEAD:${MANIFEST_PATH}`], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  const worktreeManifest = await readFile(resolve(REPOSITORY_ROOT, MANIFEST_PATH), "utf8");
  if (committedManifest !== worktreeManifest) throw new Error("remaining text manifest differs from the committed HEAD blob");
  const manifest = JSON.parse(committedManifest);
  assertRemainingTextNativeFeeCardManifest(REPOSITORY_ROOT, manifest, taskId);
  const response = await fetch(`${OPENOX_PRICING_AUTHORITY.origin}${OPENOX_PRICING_AUTHORITY.catalogEndpoint}`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const { catalog, responseSha256 } = await decodeBoundedCatalogResponse(response);
  const card = buildRemainingTextNativeFeeCard({
    repositoryRoot: REPOSITORY_ROOT,
    manifest,
    taskId,
    catalog,
    capturedAt: new Date().toISOString(),
    catalogResponseSha256: responseSha256,
  });
  await writeRepositoryJsonCreateOnly(REPOSITORY_ROOT, output, {
    schemaVersion: "site-builder-remaining-text-native-fee-card-evidence/v1",
    preparationCommitSha: head,
    card,
    modelWireCalls: 0,
    actualModelCost: { CNY: "0", USD: "0" },
    dispatchAuthorization: "NOT_AUTHORIZED",
  });
  process.stdout.write(`created ${output}; task=${taskId}; model_wire_calls=0; dispatch=NOT_AUTHORIZED\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
