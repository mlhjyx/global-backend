import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type {
  ImageInspection,
  PlannedImageVariant,
  RenderedImageVariant,
} from './image-pipeline';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_PLANS = 60;
const HARD_MAX_CONCURRENCY = 4;
const LINUX_COMPILED_ADDRESS_SPACE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_IMAGE_OUTPUT_BYTES = 24 * 1024 * 1024;
export const MAX_IMAGE_OUTPUT_TOTAL_BYTES = 192 * 1024 * 1024;

export interface ImagePipelineRunner {
  inspect(input: Buffer, declaredMime: string, signal?: AbortSignal): Promise<ImageInspection>;
  render(
    input: Buffer,
    plans: readonly PlannedImageVariant[],
    signal?: AbortSignal,
  ): Promise<Map<string, RenderedImageVariant>>;
}

interface ChildOutput {
  recipeHash: string;
  path: string;
  info: RenderedImageVariant['info'];
}

interface ChildInspectResult {
  kind: 'inspect';
  inspection: ImageInspection;
}

interface ChildRenderResult {
  kind: 'render';
  outputs: ChildOutput[];
}

type ChildResult = ChildInspectResult | ChildRenderResult;

function configuredConcurrency(): number {
  const raw = process.env.SITE_IMAGE_MAX_CONCURRENCY;
  if (raw === undefined || raw === '') return 1;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= HARD_MAX_CONCURRENCY ? value : 1;
}

class AsyncGate {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortReason(signal!));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      if (signal?.aborted) {
        waiter.onAbort();
        return;
      }
      this.waiters.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.waiters.length > 0) {
        const next = this.waiters.shift()!;
        next.signal?.removeEventListener('abort', next.onAbort!);
        if (next.signal?.aborted) {
          next.reject(abortReason(next.signal));
          continue;
        }
        next.resolve(this.releaseOnce());
        return;
      }
      this.active -= 1;
    };
  }
}

// Module-scoped on purpose: every inspect/render call in this worker process shares one low cap.
const imageProcessGate = new AsyncGate(configuredConcurrency());

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('image pipeline aborted');
}

async function withImagePermit<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  const release = await imageProcessGate.acquire(signal);
  try {
    if (signal?.aborted) throw abortReason(signal);
    return await task();
  } finally {
    release();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateInspection(value: unknown): ImageInspection {
  if (!isRecord(value)) throw new Error('child returned an invalid inspection');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(value.decodedMime))) {
    throw new Error('child returned an invalid decoded MIME');
  }
  if (!Number.isSafeInteger(value.width) || Number(value.width) <= 0) {
    throw new Error('child returned an invalid inspection width');
  }
  if (!Number.isSafeInteger(value.height) || Number(value.height) <= 0) {
    throw new Error('child returned an invalid inspection height');
  }
  if (
    typeof value.hasAlpha !== 'boolean' ||
    typeof value.hasExif !== 'boolean' ||
    typeof value.hasIcc !== 'boolean' ||
    !(value.orientation === null || (Number.isSafeInteger(value.orientation) && Number(value.orientation) >= 1 && Number(value.orientation) <= 8))
  ) {
    throw new Error('child returned invalid inspection metadata');
  }
  if (!isRecord(value.quality) || value.quality.policyVersion !== 'image-qa-m1c.1') {
    throw new Error('child returned an invalid quality report');
  }
  const metrics = value.quality.metrics;
  if (
    !isRecord(metrics) ||
    !isFiniteNumber(metrics.entropy) ||
    !isFiniteNumber(metrics.sharpness) ||
    !isFiniteNumber(metrics.exposure) ||
    !isFiniteNumber(metrics.noise)
  ) {
    throw new Error('child returned invalid quality metrics');
  }
  const allowedWarnings = new Set(['blurry', 'underexposed', 'overexposed', 'noisy']);
  if (!Array.isArray(value.quality.warnings) || !value.quality.warnings.every((item) => typeof item === 'string' && allowedWarnings.has(item))) {
    throw new Error('child returned invalid quality warnings');
  }
  return value as unknown as ImageInspection;
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
  const adjacentCompiled = path.join(__dirname, 'image-pipeline-child.js');
  const buildCompiled = path.join(process.cwd(), 'dist', 'site-builder', 'image-pipeline-child.js');
  const compiled = await exists(adjacentCompiled)
    ? adjacentCompiled
    : await exists(buildCompiled)
      ? buildCompiled
      : null;
  if (!compiled) throw new Error('compiled image pipeline child is missing; build @global/api first');
  const nodePrefix = ['--max-old-space-size=256', compiled];
  // Ubuntu development gets an actual native/libvips address-space ceiling. This complements,
  // but does not replace, the dedicated container/cgroup required by the production runbook.
  if (process.platform === 'linux' && await exists('/usr/bin/prlimit')) {
    return {
      command: '/usr/bin/prlimit',
      prefix: [`--as=${LINUX_COMPILED_ADDRESS_SPACE_BYTES}`, '--nofile=64', '--', process.execPath, ...nodePrefix],
    };
  }
  return { command: process.execPath, prefix: nodePrefix };
}

function runChild(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: process.env.NODE_ENV ?? 'development',
        VIPS_BLOCK_UNTRUSTED: '1',
      },
    });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_DIAGNOSTIC_BYTES) {
        stderr += chunk.toString('utf8').slice(0, MAX_DIAGNOSTIC_BYTES - stderr.length);
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
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
        reject(abortReason(signal));
      } else if (timedOut) {
        reject(new Error(`image pipeline timed out after ${timeoutMs}ms`));
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

async function readRegularFileBounded(
  file: string,
  dir: string,
  expectedName: string,
  maxBytes: number,
): Promise<Buffer> {
  const expected = path.join(dir, expectedName);
  if (file !== expected || path.dirname(file) !== dir || path.basename(file) !== expectedName) {
    throw new Error(`child returned an out-of-bounds path for ${expectedName}`);
  }
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`child output is not a regular file: ${expectedName}`);
  }
  if ((await realpath(file)) !== expected) {
    throw new Error(`child output escaped the job directory: ${expectedName}`);
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
      throw new Error(`child output size is invalid for ${expectedName}`);
    }
    const data = await handle.readFile();
    if (data.length !== stat.size || data.length > maxBytes) {
      throw new Error(`child output changed while reading ${expectedName}`);
    }
    return data;
  } finally {
    await handle.close();
  }
}

function expectedMime(plan: PlannedImageVariant): RenderedImageVariant['info']['mime'] {
  if (plan.recipe.output.format === 'avif') return 'image/avif';
  if (plan.recipe.output.format === 'jpeg') return 'image/jpeg';
  return `image/${plan.recipe.output.format}` as RenderedImageVariant['info']['mime'];
}

function sniffOutputMime(data: Buffer): RenderedImageVariant['info']['mime'] | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.length >= 12 && data.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brands = [data.subarray(8, 12).toString('latin1')];
    for (let offset = 16; offset + 4 <= Math.min(data.length, 64); offset += 4) {
      brands.push(data.subarray(offset, offset + 4).toString('latin1'));
    }
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
  }
  return null;
}

function parseChildResult(data: Buffer): ChildResult {
  let value: unknown;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch {
    throw new Error('child returned malformed JSON');
  }
  if (!isRecord(value) || (value.kind !== 'inspect' && value.kind !== 'render')) {
    throw new Error('child returned an invalid result envelope');
  }
  return value as unknown as ChildResult;
}

/**
 * Sharp/libvips runs in a killable, low-concurrency child process. This is crash/timeout
 * containment for the development worker, not an OS security sandbox; production still requires
 * a dedicated low-privilege container/cgroup with a read-only root and no network.
 */
export class IsolatedImagePipelineRunner implements ImagePipelineRunner {
  private readonly timeoutMs: number;
  private readonly scratchRoot: string;

  constructor(
    timeoutMs = DEFAULT_TIMEOUT_MS,
    scratchRoot =
      process.env.SITE_IMAGE_TMP_ROOT ?? path.join(process.cwd(), '.tmp', 'site-builder-image'),
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
    this.timeoutMs = timeoutMs;
    this.scratchRoot = path.resolve(scratchRoot);
  }

  inspect(input: Buffer, declaredMime: string, signal?: AbortSignal): Promise<ImageInspection> {
    return withImagePermit(signal, () =>
      this.execute(input, { action: 'inspect', declaredMime }, signal, async (result) => {
        if (signal?.aborted) throw abortReason(signal);
        if (result.kind !== 'inspect') throw new Error('child returned the wrong result kind');
        return validateInspection(result.inspection);
      }),
    );
  }

  render(
    input: Buffer,
    plans: readonly PlannedImageVariant[],
    signal?: AbortSignal,
  ): Promise<Map<string, RenderedImageVariant>> {
    if (plans.length === 0) return Promise.resolve(new Map());
    if (plans.length > MAX_PLANS) return Promise.reject(new Error('image variant plan count exceeds the hard limit'));
    const planHashes = new Set(plans.map((plan) => plan.recipeHash));
    if (planHashes.size !== plans.length || [...planHashes].some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
      return Promise.reject(new Error('image variant plans have invalid or duplicate hashes'));
    }
    return withImagePermit(signal, async () => {
      return this.execute(input, { action: 'render', plans }, signal, async (result, dir) => {
        if (result.kind !== 'render' || !Array.isArray(result.outputs) || result.outputs.length !== plans.length) {
          throw new Error('child returned an incomplete output set');
        }
        const byPlan = new Map(plans.map((plan) => [plan.recipeHash, plan]));
        const byHash = new Map<string, RenderedImageVariant>();
        let totalBytes = 0;
        for (const item of result.outputs) {
          if (signal?.aborted) throw abortReason(signal);
          if (!isRecord(item) || typeof item.recipeHash !== 'string' || typeof item.path !== 'string' || !isRecord(item.info)) {
            throw new Error('child returned an invalid output record');
          }
          const plan = byPlan.get(item.recipeHash);
          if (!plan || byHash.has(item.recipeHash)) throw new Error(`child returned an unrequested or duplicate recipe ${item.recipeHash}`);
          const info = item.info as unknown as RenderedImageVariant['info'];
          if (
            !/^[a-f0-9]{64}$/.test(String(info.contentHash)) ||
            info.mime !== expectedMime(plan) ||
            info.width !== plan.recipe.output.width ||
            info.height !== plan.recipe.output.height ||
            !Number.isSafeInteger(info.sizeBytes) ||
            info.sizeBytes <= 0 ||
            info.sizeBytes > MAX_IMAGE_OUTPUT_BYTES
          ) {
            throw new Error(`child returned invalid output metadata for ${item.recipeHash}`);
          }
          const data = await readRegularFileBounded(item.path, dir, item.recipeHash, MAX_IMAGE_OUTPUT_BYTES);
          if (signal?.aborted) throw abortReason(signal);
          totalBytes += data.length;
          if (totalBytes > MAX_IMAGE_OUTPUT_TOTAL_BYTES) throw new Error('child output set exceeds the total byte limit');
          const hash = createHash('sha256').update(data).digest('hex');
          if (hash !== info.contentHash || data.length !== info.sizeBytes || sniffOutputMime(data) !== info.mime) {
            throw new Error(`child output bytes failed independent validation for ${item.recipeHash}`);
          }
          byHash.set(item.recipeHash, { data, info });
        }
        return byHash;
      });
    });
  }

  private async execute<T>(
    input: Buffer,
    request: { action: 'inspect'; declaredMime: string } | { action: 'render'; plans: readonly PlannedImageVariant[] },
    signal: AbortSignal | undefined,
    consume: (result: ChildResult, dir: string) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw abortReason(signal);
    await mkdir(this.scratchRoot, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(path.join(this.scratchRoot, 'job-'));
    const inputPath = path.join(dir, 'input');
    const requestPath = path.join(dir, 'request.json');
    const resultPath = path.join(dir, 'result.json');
    try {
      await writeFile(inputPath, input, { mode: 0o600, flag: 'wx' });
      await writeFile(
        requestPath,
        JSON.stringify({ ...request, inputPath, outputDir: dir }),
        { mode: 0o600, flag: 'wx' },
      );
      const child = await childCommand();
      await runChild(child.command, [...child.prefix, requestPath, resultPath], this.timeoutMs, signal);
      if (signal?.aborted) throw abortReason(signal);
      const raw = await readRegularFileBounded(resultPath, dir, 'result.json', MAX_RESULT_BYTES);
      if (signal?.aborted) throw abortReason(signal);
      const result = parseChildResult(raw);
      return await consume(result, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
