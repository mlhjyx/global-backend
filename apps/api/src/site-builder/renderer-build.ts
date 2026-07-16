import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const BUILD_TIMEOUT_MS = 180_000;
const MAX_BUILD_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface RendererBuildInput {
  specPath: string;
  outDir: string;
  basePath: string;
}

export type RendererBuildExecutor = (input: RendererBuildInput) => Promise<void>;

/**
 * Renderer 是处理租户内容的低信任子进程，不能继承 API/worker 的数据库、对象存储、
 * 模型网关、代理或 Node 注入变量。这里不读取 process.env，新增变量必须逐项评审。
 */
export function buildRendererEnv(input: RendererBuildInput): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    SITESPEC_PATH: input.specPath,
    OUT_DIR: input.outDir,
    BASE_PATH: input.basePath,
    ASTRO_TELEMETRY_DISABLED: '1',
  };
}

function resolveRendererEntrypoint(cwd = process.cwd()): {
  rendererRoot: string;
  astroCli: string;
} {
  const candidates = [path.join(cwd, 'apps', 'site-renderer'), path.join(cwd, '..', 'site-renderer')];
  const requireFromCwd = createRequire(path.join(cwd, 'package.json'));

  for (const rendererRoot of candidates) {
    try {
      const astroPackage = requireFromCwd.resolve('astro/package.json', {
        paths: [rendererRoot],
      });
      return {
        rendererRoot,
        astroCli: path.join(path.dirname(astroPackage), 'astro.js'),
      };
    } catch {
      // Try the next supported monorepo working directory shape.
    }
  }

  throw new Error(`site renderer dependencies not found from ${cwd}`);
}

/** 用固定 Node 可执行文件直启 Astro；不经 shell/pnpm/PATH，参数也不做字符串拼接。 */
export async function runAstroBuild(input: RendererBuildInput): Promise<void> {
  const { rendererRoot, astroCli } = resolveRendererEntrypoint();
  await execFileAsync(process.execPath, [astroCli, 'build'], {
    cwd: rendererRoot,
    env: buildRendererEnv(input),
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: MAX_BUILD_OUTPUT_BYTES,
  });
}

/**
 * SiteSpec 只在权限 0700 的随机目录内以 0600 物化，并在成功、异常、子进程超时路径统一清理。
 * 构建产物目录不是这里的 staging；当前可见预览原子化由后续 R1-min 独立交付。
 */
export async function buildSiteSpecWithTemporaryFile(
  spec: unknown,
  output: { outDir: string; basePath: string },
  execute: RendererBuildExecutor = runAstroBuild,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'global-site-renderer-'));
  const specPath = path.join(tempDir, 'site-spec.json');

  try {
    await writeFile(specPath, JSON.stringify(spec), { encoding: 'utf8', mode: 0o600 });
    await execute({ specPath, outDir: output.outDir, basePath: output.basePath });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
