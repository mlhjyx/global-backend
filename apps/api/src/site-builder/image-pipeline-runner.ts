import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PlannedImageVariant, RenderedImageVariant } from './image-pipeline';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

export interface ImagePipelineRunner {
  render(
    input: Buffer,
    plans: readonly PlannedImageVariant[],
    signal?: AbortSignal,
  ): Promise<Map<string, RenderedImageVariant>>;
}

interface ChildResult {
  outputs: Array<{
    recipeHash: string;
    path: string;
    info: RenderedImageVariant['info'];
  }>;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function childCommand(): Promise<{ command: string; prefix: string[] }> {
  const compiled = path.join(__dirname, 'image-pipeline-child.js');
  if (await exists(compiled)) return { command: process.execPath, prefix: [compiled] };
  const source = path.join(__dirname, 'image-pipeline-child.ts');
  if (await exists(source)) {
    return { command: process.execPath, prefix: ['--import', 'tsx', source] };
  }
  throw new Error('image pipeline child entrypoint is missing');
}

function runChild(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['--max-old-space-size=256', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: process.env.NODE_ENV ?? 'development',
        VIPS_BLOCK_UNTRUSTED_OPERATIONS: 'true',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_DIAGNOSTIC_BYTES) {
        stderr += chunk.toString('utf8').slice(0, MAX_DIAGNOSTIC_BYTES - stderr.length);
      }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('exit', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('image pipeline aborted'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `image pipeline child failed (${exitSignal ?? code ?? 'unknown'}): ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

/**
 * Sharp/libvips runs in a killable child process. Runtime scratch lives under a configurable
 * development/runtime directory, never in a source worktree under /tmp, and is removed in finally.
 */
export class IsolatedImagePipelineRunner implements ImagePipelineRunner {
  constructor(
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly scratchRoot =
      process.env.SITE_IMAGE_TMP_ROOT ?? path.join(process.cwd(), '.tmp', 'site-builder-image'),
  ) {}

  async render(
    input: Buffer,
    plans: readonly PlannedImageVariant[],
    signal?: AbortSignal,
  ): Promise<Map<string, RenderedImageVariant>> {
    if (plans.length === 0) return new Map();
    await mkdir(this.scratchRoot, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(path.join(this.scratchRoot, 'job-'));
    const inputPath = path.join(dir, 'input');
    const requestPath = path.join(dir, 'request.json');
    const resultPath = path.join(dir, 'result.json');
    try {
      await writeFile(inputPath, input, { mode: 0o600 });
      await writeFile(
        requestPath,
        JSON.stringify({ inputPath, outputDir: dir, plans }),
        { mode: 0o600 },
      );
      const child = await childCommand();
      await runChild(
        child.command,
        [...child.prefix, requestPath, resultPath],
        this.timeoutMs,
        signal,
      );
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as ChildResult;
      const byHash = new Map<string, RenderedImageVariant>();
      for (const item of result.outputs) {
        if (!plans.some((plan) => plan.recipeHash === item.recipeHash)) {
          throw new Error(`child returned an unrequested recipe ${item.recipeHash}`);
        }
        const data = await readFile(item.path);
        byHash.set(item.recipeHash, { data, info: item.info });
      }
      if (byHash.size !== plans.length) throw new Error('child returned an incomplete output set');
      return byHash;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
