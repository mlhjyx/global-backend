import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUILD_TIMEOUT_MS = 180_000;
const MAX_BUILD_OUTPUT_BYTES = 16 * 1024 * 1024;

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
): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "global-site-renderer-"));
  const specPath = path.join(tempDir, "site-spec.json");

  try {
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
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
