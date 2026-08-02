import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDesignSpecEvidencePreflight,
  OPENOX_PRICING_CATALOG_URL,
  renderDesignSpecEvidenceDecisionCard,
  sha256CanonicalJson,
  MAX_OPENOX_CATALOG_BYTES,
} from "../src/site-builder/eval/design-spec-evidence-preflight";
import {
  writeRepositoryJsonCreateOnly,
  writeRepositoryMarkdownCreateOnly,
} from "../src/site-builder/eval/create-only-json";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const MANIFEST_DEFAULT =
  "docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v1.json";
const SOURCE_FILES = [
  "docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v1.json",
  "apps/api/src/site-builder/eval/create-only-json.ts",
  "apps/api/src/site-builder/eval/design-spec-evidence-preflight.ts",
  "apps/api/scripts/prepare-site-builder-design-spec-evidence-preflight.mts",
  "apps/api/src/site-builder/eval/design-spec-evaluation-manifest-prep.ts",
  "apps/api/src/site-builder/eval/model-evaluation-harness.ts",
  "apps/api/src/site-builder/eval/model-evaluation-executor.ts",
  "apps/api/src/site-builder/eval/model-evaluation-cost-safety.ts",
  "apps/api/src/site-builder/agents/task-route-bindings.ts",
  "apps/api/src/site-builder/site-builder-model-settlement.ts",
] as const;

const HELP = `Usage:
  pnpm --filter @global/api exec tsx scripts/prepare-site-builder-design-spec-evidence-preflight.mts \\
    --manifest=${MANIFEST_DEFAULT} \\
    --output=docs/evidence/site-builder/m1-g-design-spec-evidence-preflight-v1.json \\
    --decision-card=docs/evidence/site-builder/m1-g-design-spec-evidence-preflight-decision-card.md

This command performs only read-only gateway control-plane and public OpenOx
catalog requests. It never calls a generative endpoint, reads or writes a
runtime attestation, changes new-api, or dispatches a model. MODEL_GATEWAY_URL
and MODEL_GATEWAY_KEY must be supplied by the caller when credential scope is
to be observed; their values are never written to evidence. A sanitized
MODEL_GATEWAY_CHANNEL_BINDING_JSON snapshot is mandatory and contains only the
dedicated group, group ratio, retry flag, aliases, protocols, channel ids and
reviewed channel names; it must never contain keys or token identifiers.
`;

function channelBindingFromEnvironment(): unknown | null {
  const source = process.env.MODEL_GATEWAY_CHANNEL_BINDING_JSON?.trim();
  if (!source) return null;
  const value = JSON.parse(source) as unknown;
  const serialized = JSON.stringify(value);
  if (/\b(?:key|token|secret|authorization|password)\b/i.test(serialized))
    throw new Error("channel binding snapshot contains credential-like fields");
  return value;
}

function option(name: string, fallback?: string): string | null {
  const prefix = `--${name}=`;
  const values = process.argv
    .slice(2)
    .filter((value) => value.startsWith(prefix));
  return values.length === 1
    ? values[0]!.slice(prefix.length)
    : (fallback ?? null);
}

function repositoryEvidencePath(
  value: string,
  extension: ".json" | ".md",
): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    !value.startsWith("docs/evidence/site-builder/") ||
    !value.endsWith(extension) ||
    /(^|\/)\.env(?:\.|$)/i.test(value)
  )
    throw new Error(
      `path must be a repository-relative ${extension} evidence path`,
    );
  return value;
}

function git(
  args: string[],
  encoding: "utf8" | null = "utf8",
): string | Buffer {
  return execFileSync("git", args, { cwd: REPOSITORY_ROOT, encoding });
}

function assertCleanAndReachable(
  fixedCommitSha: string,
  manifestPath: string,
): string {
  const dirty = String(
    git(["status", "--porcelain=v1", "--untracked-files=all"]),
  ).trim();
  if (dirty !== "")
    throw new Error(
      "preflight requires a clean worktree before create-only output",
    );
  const head = String(git(["rev-parse", "HEAD"])).trim();
  if (!/^[a-f0-9]{40}$/.test(fixedCommitSha))
    throw new Error("manifest fixed source commit is invalid");
  execFileSync("git", ["cat-file", "-e", `${fixedCommitSha}^{commit}`], {
    cwd: REPOSITORY_ROOT,
    stdio: "ignore",
  });
  execFileSync("git", ["merge-base", "--is-ancestor", fixedCommitSha, "HEAD"], {
    cwd: REPOSITORY_ROOT,
    stdio: "ignore",
  });
  const committed = Buffer.from(git(["show", `HEAD:${manifestPath}`], null));
  if (committed.byteLength === 0) throw new Error("manifest is empty");
  JSON.parse(committed.toString("utf8"));
  return head;
}

async function readBoundedJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; responseSha256: string } | null> {
  const response = await fetch(url, init);
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number(declaredLength) > MAX_OPENOX_CATALOG_BYTES
  )
    throw new Error("read-only response exceeds byte limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_OPENOX_CATALOG_BYTES)
    throw new Error("read-only response exceeds byte limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return {
    status: response.status,
    body: JSON.parse(text),
    responseSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function safeReadOnlyJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; responseSha256: string } | null> {
  try {
    return await readBoundedJson(url, init);
  } catch {
    return null;
  }
}

function sourceBundle(commitSha: string): {
  commitSha: string;
  contractId: string;
  sha256: string;
  files: { path: string; sha256: string }[];
} {
  const files = SOURCE_FILES.map((path) => {
    const bytes = Buffer.from(git(["show", `${commitSha}:${path}`], null));
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  return {
    commitSha,
    contractId: "design-spec-evidence-preflight-source-bundle/v1",
    sha256: sha256CanonicalJson(files),
    files,
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const manifestPath = repositoryEvidencePath(
    option("manifest", MANIFEST_DEFAULT)!,
    ".json",
  );
  const outputPath = repositoryEvidencePath(option("output") ?? "", ".json");
  const decisionCardPath = repositoryEvidencePath(
    option("decision-card") ?? "",
    ".md",
  );
  const manifestBytes = await readFile(resolve(REPOSITORY_ROOT, manifestPath));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    fixedCommitSha?: unknown;
  };
  if (typeof manifest.fixedCommitSha !== "string")
    throw new Error("manifest fixedCommitSha is missing");
  const head = assertCleanAndReachable(manifest.fixedCommitSha, manifestPath);
  const capturedAt = new Date().toISOString();
  const gatewayUrl = process.env.MODEL_GATEWAY_URL?.trim() || null;
  const gatewayKey = process.env.MODEL_GATEWAY_KEY?.trim() || null;
  let gatewayOrigin: string | null = null;
  let gatewayModels: unknown | null = null;
  let gatewayUsage: unknown | null = null;
  let readOnlyCalls = 1;
  if (gatewayUrl && gatewayKey) {
    const parsed = new URL(gatewayUrl);
    gatewayOrigin = parsed.origin;
    const base = gatewayUrl.replace(/\/$/, "");
    const usageUrl = `${parsed.origin}/api/usage/token/`;
    const auth = { headers: { Authorization: `Bearer ${gatewayKey}` } };
    const modelsResponse = await safeReadOnlyJson(`${base}/models`, auth);
    const usageResponse = await safeReadOnlyJson(usageUrl, auth);
    gatewayModels = modelsResponse?.body ?? null;
    gatewayUsage = usageResponse?.body ?? null;
    readOnlyCalls += 2;
  }
  const openOxResponse = await safeReadOnlyJson(OPENOX_PRICING_CATALOG_URL);
  const report = buildDesignSpecEvidencePreflight({
    manifest,
    capturedAt,
    gatewayOrigin,
    credentialMaterial: "not_persisted",
    gatewayModels,
    gatewayUsage,
    gatewayChannelBinding: channelBindingFromEnvironment(),
    openOxCatalog: openOxResponse?.body ?? null,
    openOxHttpStatus: openOxResponse?.status ?? 0,
    openOxResponseSha256: openOxResponse?.responseSha256 ?? null,
    readOnlyNetworkCalls: readOnlyCalls,
    sourceBundle: sourceBundle(head!),
  });
  await writeRepositoryJsonCreateOnly(REPOSITORY_ROOT, outputPath, report);
  await writeRepositoryMarkdownCreateOnly(
    REPOSITORY_ROOT,
    decisionCardPath,
    renderDesignSpecEvidenceDecisionCard(report),
  );
  process.stdout.write(
    `created ${outputPath} and ${decisionCardPath}; status=${report.status}; read_only_calls=${readOnlyCalls}; model_wire_calls=0; model_cost_cents=0; dispatch=NOT_AUTHORIZED\n`,
  );
}

await main();
