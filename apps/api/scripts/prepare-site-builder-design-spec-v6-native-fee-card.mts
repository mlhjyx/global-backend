import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OPENOX_PRICING_AUTHORITY } from "../src/site-builder/site-builder-model-settlement";
import { writeRepositoryJsonCreateOnly } from "../src/site-builder/eval/create-only-json";
import {
  assertDesignSpecV6NativeFeeCardManifest,
  buildDesignSpecV6NativeFeeCard,
} from "../src/site-builder/eval/design-spec-v6-native-fee-card";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const MANIFEST_PATH =
  "docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v6.json";
const MAX_CATALOG_BYTES = 1_048_576;
const EVIDENCE_PATH =
  /^docs\/evidence\/site-builder\/[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/;

const HELP = `Usage:
  pnpm --filter @global/api exec tsx scripts/prepare-site-builder-design-spec-v6-native-fee-card.mts \\
    --output=docs/evidence/site-builder/<new-v6-fee-card>.json

This command reads only the committed v6 design_spec manifest and the public
OpenOx pricing catalog. It never reads credentials, calls a model, changes a
model route, or authorizes dispatch. The output is create-only and remains
NOT_AUTHORIZED for dispatch.
`;

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const matches = process.argv
    .slice(2)
    .filter((value) => value.startsWith(prefix));
  return matches.length === 1 ? matches[0]!.slice(prefix.length) : null;
}
export function validateV6EvidenceOutputPath(value: string | null): string {
  const normalized = value?.trim();
  if (
    !normalized ||
    !EVIDENCE_PATH.test(normalized) ||
    normalized.includes("\\") ||
    normalized.includes("//") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(
      "--output must be a new repository-relative evidence JSON path",
    );
  }
  return normalized;
}

function requiredEvidencePath(): string {
  return validateV6EvidenceOutputPath(option("output"));
}

function currentCleanHead(): string {
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  ).trim();
  if (dirty)
    throw new Error("v6 fee-card preparation requires a clean worktree");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) {
    throw new Error("v6 fee-card preparation head is invalid");
  }
  return head;
}

export function assertV6FixedSourceReachability(manifest: unknown): void {
  const fixedCommitSha =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as { fixedCommitSha?: unknown }).fixedCommitSha
      : null;
  if (
    typeof fixedCommitSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(fixedCommitSha)
  ) {
    throw new Error("design_spec v6 manifest fixed source commit is invalid");
  }
  for (const revision of ["HEAD", "refs/remotes/origin/main"] as const) {
    try {
      execFileSync(
        "git",
        ["merge-base", "--is-ancestor", fixedCommitSha, revision],
        { cwd: REPOSITORY_ROOT, stdio: "ignore" },
      );
    } catch {
      throw new Error(
        `design_spec v6 fixed source commit must be reachable from ${revision}`,
      );
    }
  }
}

export function assertV6ManifestForPublicPriceRead(manifest: unknown): void {
  assertDesignSpecV6NativeFeeCardManifest(manifest);
  assertV6FixedSourceReachability(manifest);
}

export async function decodeBoundedCatalogResponse(
  response: Response,
): Promise<{ catalog: unknown; responseSha256: string }> {
  if (!response.ok) {
    throw new Error(
      `OpenOx pricing catalog request failed: HTTP ${response.status}`,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_CATALOG_BYTES
    ) {
      throw new Error("OpenOx pricing catalog exceeds the byte limit");
    }
  }
  if (!response.body) {
    throw new Error("OpenOx pricing catalog body is unavailable");
  }
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
    catalog: JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ),
    responseSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function readBoundedCatalog(): Promise<{
  catalog: unknown;
  responseSha256: string;
}> {
  const url = `${OPENOX_PRICING_AUTHORITY.origin}${OPENOX_PRICING_AUTHORITY.catalogEndpoint}`;
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  return decodeBoundedCatalogResponse(response);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const output = requiredEvidencePath();
  const head = currentCleanHead();
  const committedManifest = execFileSync(
    "git",
    ["show", `HEAD:${MANIFEST_PATH}`],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  const worktreeManifest = await readFile(
    resolve(REPOSITORY_ROOT, MANIFEST_PATH),
    "utf8",
  );
  if (worktreeManifest !== committedManifest) {
    throw new Error(
      "v6 design_spec manifest differs from the committed HEAD blob",
    );
  }
  const manifest = JSON.parse(committedManifest);
  assertV6ManifestForPublicPriceRead(manifest);
  const { catalog, responseSha256 } = await readBoundedCatalog();
  const card = buildDesignSpecV6NativeFeeCard({
    manifest,
    catalog,
    capturedAt: new Date().toISOString(),
    catalogResponseSha256: responseSha256,
  });
  await writeRepositoryJsonCreateOnly(REPOSITORY_ROOT, output, {
    schemaVersion: "site-builder-design-spec-v6-native-fee-card-evidence/v1",
    preparationCommitSha: head,
    card,
    modelWireCalls: 0,
    actualModelCost: { CNY: "0", USD: "0" },
    dispatchAuthorization: "NOT_AUTHORIZED",
  });
  process.stdout.write(
    `created ${output}; status=${card.status}; model_wire_calls=0; dispatch=NOT_AUTHORIZED\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
