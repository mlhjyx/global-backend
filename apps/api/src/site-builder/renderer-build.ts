import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { releaseSpecDigest } from "./release-artifact";

const execFileAsync = promisify(execFile);
const BUILD_TIMEOUT_MS = 180_000;
const MAX_BUILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RENDER_FILES = 4096;
const MAX_RENDER_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RENDER_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RENDER_DEPTH = 32;
const SHA256 = /^[a-f0-9]{64}$/;
export const RENDERER_OUTPUT_MANIFEST_FILE =
  ".site-builder-render-output.json" as const;
export const RENDERER_OUTPUT_MANIFEST_SCHEMA_VERSION =
  "site-builder-render-output/v1" as const;

export interface RendererOutputManifestV1 {
  schemaVersion: typeof RENDERER_OUTPUT_MANIFEST_SCHEMA_VERSION;
  candidateSpecDigest: string;
  basePath: string;
  siteOrigin: string;
  treeDigest: string;
  fileCount: number;
  totalBytes: number;
}

export interface RendererBuildInput {
  specPath: string;
  outDir: string;
  basePath: string;
  siteOrigin: string;
  publicAssetDir?: string;
  allowedOutboundDomains?: string[];
}

export type RendererBuildExecutor = (
  input: RendererBuildInput,
) => Promise<void>;

export function validateRendererSiteOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("RENDERER_SITE_ORIGIN_INVALID");
  }
  const loopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
  ) {
    throw new Error("RENDERER_SITE_ORIGIN_INVALID");
  }
  return parsed.origin;
}

interface RendererOutputTree {
  treeDigest: string;
  fileCount: number;
  totalBytes: number;
}

async function collectRendererOutputTree(
  root: string,
): Promise<RendererOutputTree> {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  let totalBytes = 0;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_RENDER_DEPTH) {
      throw new Error("RENDERER_OUTPUT_DEPTH_EXCEEDED");
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("RENDERER_OUTPUT_SYMLINK_FORBIDDEN");
      }
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error("RENDERER_OUTPUT_NON_REGULAR_FILE");
      const relative = path
        .relative(root, absolute)
        .split(path.sep)
        .join("/");
      if (
        relative === RENDERER_OUTPUT_MANIFEST_FILE ||
        relative === `${RENDERER_OUTPUT_MANIFEST_FILE}.tmp`
      ) {
        continue;
      }
      if (
        !relative ||
        relative.startsWith("../") ||
        relative.includes("/../") ||
        relative.includes("\\") ||
        relative.includes("\0")
      ) {
        throw new Error("RENDERER_OUTPUT_PATH_INVALID");
      }
      const handle = await open(absolute, "r");
      try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile()) {
          throw new Error("RENDERER_OUTPUT_NON_REGULAR_FILE");
        }
        if (fileStat.size > MAX_RENDER_FILE_BYTES) {
          throw new Error("RENDERER_OUTPUT_FILE_SIZE_EXCEEDED");
        }
        totalBytes += fileStat.size;
        if (totalBytes > MAX_RENDER_TOTAL_BYTES) {
          throw new Error("RENDERER_OUTPUT_TOTAL_SIZE_EXCEEDED");
        }
        const data = await handle.readFile();
        if (data.length !== fileStat.size) {
          throw new Error("RENDERER_OUTPUT_CHANGED_DURING_READ");
        }
        files.push({
          path: relative,
          size: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
        if (files.length > MAX_RENDER_FILES) {
          throw new Error("RENDERER_OUTPUT_FILE_COUNT_EXCEEDED");
        }
      } finally {
        await handle.close();
      }
    }
  };

  await visit(root, 0);
  if (files.length === 0) throw new Error("RENDERER_OUTPUT_EMPTY");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    treeDigest: createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex"),
    fileCount: files.length,
    totalBytes,
  };
}

function validateRendererOutputManifest(
  value: unknown,
): RendererOutputManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RENDERER_OUTPUT_MANIFEST_INVALID");
  }
  const manifest = value as Record<string, unknown>;
  if (
    Object.keys(manifest).sort().join(",") !==
      "basePath,candidateSpecDigest,fileCount,schemaVersion,siteOrigin,totalBytes,treeDigest" ||
    manifest.schemaVersion !== RENDERER_OUTPUT_MANIFEST_SCHEMA_VERSION ||
    typeof manifest.candidateSpecDigest !== "string" ||
    !SHA256.test(manifest.candidateSpecDigest) ||
    typeof manifest.basePath !== "string" ||
    typeof manifest.siteOrigin !== "string" ||
    typeof manifest.treeDigest !== "string" ||
    !SHA256.test(manifest.treeDigest) ||
    !Number.isSafeInteger(manifest.fileCount) ||
    (manifest.fileCount as number) < 1 ||
    (manifest.fileCount as number) > MAX_RENDER_FILES ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    (manifest.totalBytes as number) < 1 ||
    (manifest.totalBytes as number) > MAX_RENDER_TOTAL_BYTES
  ) {
    throw new Error("RENDERER_OUTPUT_MANIFEST_INVALID");
  }
  validateRendererSiteOrigin(manifest.siteOrigin);
  return manifest as unknown as RendererOutputManifestV1;
}

export async function writeRendererOutputManifest(input: {
  root: string;
  candidateSpecDigest: string;
  basePath: string;
  siteOrigin: string;
}): Promise<RendererOutputManifestV1> {
  if (!SHA256.test(input.candidateSpecDigest)) {
    throw new Error("RENDERER_OUTPUT_MANIFEST_INVALID");
  }
  const tree = await collectRendererOutputTree(input.root);
  const manifest: RendererOutputManifestV1 = {
    schemaVersion: RENDERER_OUTPUT_MANIFEST_SCHEMA_VERSION,
    candidateSpecDigest: input.candidateSpecDigest,
    basePath: input.basePath,
    siteOrigin: validateRendererSiteOrigin(input.siteOrigin),
    ...tree,
  };
  const manifestPath = path.join(input.root, RENDERER_OUTPUT_MANIFEST_FILE);
  const temporaryPath = `${manifestPath}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(manifest), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, manifestPath);
    return manifest;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function assertRendererOutputMatches(input: {
  root: string;
  candidateSpecDigest: string;
  basePath: string;
  siteOrigin: string;
  treeDigest: string;
}): Promise<RendererOutputManifestV1> {
  const manifestPath = path.join(input.root, RENDERER_OUTPUT_MANIFEST_FILE);
  const bytes = await readFile(manifestPath);
  if (bytes.length > 4096) throw new Error("RENDERER_OUTPUT_MANIFEST_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("RENDERER_OUTPUT_MANIFEST_INVALID");
  }
  const manifest = validateRendererOutputManifest(parsed);
  if (
    manifest.candidateSpecDigest !== input.candidateSpecDigest ||
    manifest.basePath !== input.basePath ||
    manifest.siteOrigin !== input.siteOrigin ||
    manifest.treeDigest !== input.treeDigest
  ) {
    throw new Error("RENDERER_OUTPUT_CANDIDATE_MISMATCH");
  }
  const current = await collectRendererOutputTree(input.root);
  if (
    current.treeDigest !== manifest.treeDigest ||
    current.fileCount !== manifest.fileCount ||
    current.totalBytes !== manifest.totalBytes
  ) {
    throw new Error("RENDERER_OUTPUT_TREE_MISMATCH");
  }
  return manifest;
}

/**
 * Renderer 是处理租户内容的低信任子进程，不能继承 API/worker 的数据库、对象存储、
 * 模型网关、代理或 Node 注入变量。这里不读取 process.env，新增变量必须逐项评审。
 */
export function buildRendererEnv(input: RendererBuildInput): NodeJS.ProcessEnv {
  const siteOrigin = validateRendererSiteOrigin(input.siteOrigin);
  return {
    NODE_ENV: "production",
    LANG: "C.UTF-8",
    TZ: "UTC",
    SITESPEC_PATH: input.specPath,
    OUT_DIR: input.outDir,
    BASE_PATH: input.basePath,
    SITE_ORIGIN: siteOrigin,
    ...(input.publicAssetDir ? { PUBLIC_ASSET_DIR: input.publicAssetDir } : {}),
    ASTRO_TELEMETRY_DISABLED: "1",
  };
}

export function resolveRendererEntrypoint(cwd = process.cwd()): {
  rendererRoot: string;
  astroCli: string;
} {
  const candidates = [
    path.join(cwd, "apps", "site-renderer"),
    path.join(cwd, "..", "site-renderer"),
  ];
  const requireFromCwd = createRequire(path.join(cwd, "package.json"));

  for (const rendererRoot of candidates) {
    if (!existsSync(rendererRoot)) continue;
    try {
      const astroPackage = requireFromCwd.resolve("astro/package.json", {
        paths: [rendererRoot],
      });
      return {
        rendererRoot,
        astroCli: path.join(path.dirname(astroPackage), "astro.js"),
      };
    } catch {
      // Try the next supported monorepo working directory shape.
    }
  }

  throw new Error(`site renderer dependencies not found from ${cwd}`);
}

function resolveNodeExecutable(): string {
  const candidates =
    process.platform === "linux"
      ? ["/proc/self/exe", process.execPath, process.argv0]
      : [process.execPath, process.argv0];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && existsSync(candidate)) return candidate;
  }
  throw new Error("RENDERER_NODE_EXECUTABLE_UNAVAILABLE");
}

/** 用已解析的 Node 可执行文件直启 Astro；不经 shell/pnpm/PATH，参数也不做字符串拼接。 */
export async function runAstroBuild(input: RendererBuildInput): Promise<void> {
  const { rendererRoot, astroCli } = resolveRendererEntrypoint();
  await execFileAsync(resolveNodeExecutable(), [astroCli, "build"], {
    cwd: rendererRoot,
    env: buildRendererEnv(input),
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: MAX_BUILD_OUTPUT_BYTES,
  });
  await assertRenderedOutboundDomains(
    input.outDir,
    input.allowedOutboundDomains ?? [],
    input.siteOrigin,
  );
}

const SCANNED_RENDER_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".xml",
  ".svg",
  ".txt",
]);
// A bare `//` is common inside base64-encoded font data. Protocol-relative URLs
// must therefore begin at a non-base64 boundary and contain a DNS-shaped host.
const OUTBOUND_URL =
  /(?<![A-Za-z0-9+/=])(?:https?:\/\/[^\s"'<>)}\\]+|\/\/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?[^\s"'<>)}\\]*)/giu;
const MAX_SCANNED_OUTPUT_BYTES = 32 * 1024 * 1024;

function navigableOutputText(value: string): string {
  return value
    .replace(
      /<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>[\s\S]*?<\/script>/gi,
      "",
    )
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/\bxmlns(?::[A-Za-z][\w.-]*)?\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
}

/** Post-build gate covers HTML, CSS and bundled JS rather than trusting component props alone. */
export async function assertRenderedOutboundDomains(
  root: string,
  allowedDomains: readonly string[],
  siteOrigin?: string,
): Promise<void> {
  const approved = new Set(
    allowedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean),
  );
  const ownOrigin = siteOrigin ? validateRendererSiteOrigin(siteOrigin) : null;
  let scannedBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("RENDERER_OUTPUT_SYMLINK_FORBIDDEN");
      }
      if (entry.isDirectory()) {
        await visit(filePath);
        continue;
      }
      if (
        !entry.isFile() ||
        !SCANNED_RENDER_EXTENSIONS.has(path.extname(entry.name))
      ) {
        continue;
      }
      const value = await readFile(filePath, "utf8");
      scannedBytes += Buffer.byteLength(value);
      if (scannedBytes > MAX_SCANNED_OUTPUT_BYTES) {
        throw new Error("RENDERER_OUTPUT_SCAN_LIMIT_EXCEEDED");
      }
      for (const raw of navigableOutputText(value).match(OUTBOUND_URL) ?? []) {
        let parsed: URL;
        try {
          parsed = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
        } catch {
          throw new Error(`RENDERER_OUTBOUND_URL_INVALID: ${raw}`);
        }
        const ownUrl = ownOrigin !== null && parsed.origin === ownOrigin;
        if (
          !ownUrl &&
          (parsed.protocol !== "https:" ||
            !approved.has(parsed.hostname.toLowerCase()))
        ) {
          throw new Error(
            `RENDERER_OUTBOUND_DOMAIN_FORBIDDEN: ${parsed.hostname}`,
          );
        }
      }
    }
  };
  await visit(root);
}

function allowedOutboundDomains(spec: unknown): string[] {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return [];
  const site = (spec as Record<string, unknown>).site;
  if (!site || typeof site !== "object" || Array.isArray(site)) return [];
  const domains = (site as Record<string, unknown>).outboundDomains;
  return Array.isArray(domains) &&
    domains.every((value) => typeof value === "string")
    ? domains
    : [];
}

/**
 * SiteSpec 只在权限 0700 的随机目录内以 0600 物化，并在成功、异常、子进程超时路径统一清理。
 * 本函数不拥有发布语义；R3-B2 refurbish 调用方会传 run-scoped staging 并在 active pointer
 * CAS 后提升到本地开发预览。生产不可变 Release、崩溃恢复与其余可见预览安全门仍归 R1-min。
 */
export async function buildSiteSpecWithTemporaryFile(
  spec: unknown,
  output: {
    outDir: string;
    basePath: string;
    siteOrigin: string;
    publicAssetDir?: string;
  },
  execute: RendererBuildExecutor = runAstroBuild,
): Promise<RendererOutputManifestV1> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "global-site-renderer-"));
  const specPath = path.join(tempDir, "site-spec.json");
  const manifestPath = path.join(
    output.outDir,
    RENDERER_OUTPUT_MANIFEST_FILE,
  );

  try {
    await rm(manifestPath, { force: true });
    await rm(`${manifestPath}.tmp`, { force: true });
    await writeFile(specPath, JSON.stringify(spec), {
      encoding: "utf8",
      mode: 0o600,
    });
    await execute({
      specPath,
      outDir: output.outDir,
      basePath: output.basePath,
      siteOrigin: output.siteOrigin,
      publicAssetDir: output.publicAssetDir,
      allowedOutboundDomains: allowedOutboundDomains(spec),
    });
    return await writeRendererOutputManifest({
      root: output.outDir,
      candidateSpecDigest: releaseSpecDigest(spec),
      basePath: output.basePath,
      siteOrigin: output.siteOrigin,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
