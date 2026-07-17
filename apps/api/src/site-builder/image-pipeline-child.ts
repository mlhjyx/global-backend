import { constants } from 'node:fs';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import {
  inspectImageInput,
  renderImageVariant,
  type PlannedImageVariant,
  type RenderedImageVariant,
} from './image-pipeline';
import {
  MAX_IMAGE_OUTPUT_BYTES,
  MAX_IMAGE_OUTPUT_TOTAL_BYTES,
} from './image-pipeline-runner';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_PLANS = 60;

interface InspectRequest {
  action: 'inspect';
  inputPath: string;
  outputDir: string;
  declaredMime: string;
}

interface RenderRequest {
  action: 'render';
  inputPath: string;
  outputDir: string;
  plans: PlannedImageVariant[];
}

type ChildRequest = InspectRequest | RenderRequest;

interface ChildResult {
  kind: 'render';
  outputs: Array<{
    recipeHash: string;
    path: string;
    info: RenderedImageVariant['info'];
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readRegularBounded(file: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maxBytes) {
    throw new Error('child input is not a bounded regular file');
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
      throw new Error('child input size is invalid');
    }
    const data = await handle.readFile();
    if (data.length !== stat.size || data.length > maxBytes) throw new Error('child input changed while reading');
    return data;
  } finally {
    await handle.close();
  }
}

function parseRequest(raw: Buffer, jobDir: string): ChildRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('invalid child request JSON');
  }
  if (!isRecord(value) || (value.action !== 'inspect' && value.action !== 'render')) {
    throw new Error('invalid child request envelope');
  }
  const expectedInput = path.join(jobDir, 'input');
  if (value.inputPath !== expectedInput || value.outputDir !== jobDir) {
    throw new Error('child request path escaped its job directory');
  }
  if (value.action === 'inspect') {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(value.declaredMime))) {
      throw new Error('invalid declared MIME');
    }
    return value as unknown as InspectRequest;
  }
  if (!Array.isArray(value.plans) || value.plans.length === 0 || value.plans.length > MAX_PLANS) {
    throw new Error('invalid render plan count');
  }
  const hashes = new Set<string>();
  for (const plan of value.plans) {
    if (!isRecord(plan) || typeof plan.recipeHash !== 'string' || !/^[a-f0-9]{64}$/.test(plan.recipeHash) || hashes.has(plan.recipeHash)) {
      throw new Error('invalid or duplicate render recipe hash');
    }
    hashes.add(plan.recipeHash);
  }
  return value as unknown as RenderRequest;
}

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  const resultPath = process.argv[3];
  if (!requestPath || !resultPath) throw new Error('request and result paths are required');
  const jobDir = path.dirname(requestPath);
  if (
    path.basename(requestPath) !== 'request.json' ||
    resultPath !== path.join(jobDir, 'result.json') ||
    (await realpath(jobDir)) !== jobDir
  ) {
    throw new Error('child control paths are invalid');
  }
  if (process.env.VIPS_BLOCK_UNTRUSTED !== '1') {
    throw new Error('VIPS_BLOCK_UNTRUSTED must be enabled');
  }
  sharp.cache(false);
  sharp.concurrency(1);
  const request = parseRequest(await readRegularBounded(requestPath, MAX_REQUEST_BYTES), jobDir);
  const input = await readRegularBounded(request.inputPath, MAX_INPUT_BYTES);

  if (request.action === 'inspect') {
    const inspection = await inspectImageInput(input, request.declaredMime);
    await writeFile(
      resultPath,
      JSON.stringify({ kind: 'inspect', inspection }),
      { mode: 0o600, flag: 'wx' },
    );
    return;
  }

  const outputs: ChildResult['outputs'] = [];
  let totalBytes = 0;
  for (const plan of request.plans) {
    const rendered = await renderImageVariant(input, plan);
    if (rendered.data.length <= 0 || rendered.data.length > MAX_IMAGE_OUTPUT_BYTES) {
      throw new Error(`rendered output exceeds the per-file byte limit for ${plan.recipeHash}`);
    }
    totalBytes += rendered.data.length;
    if (totalBytes > MAX_IMAGE_OUTPUT_TOTAL_BYTES) {
      throw new Error('rendered output set exceeds the total byte limit');
    }
    const outputPath = path.join(jobDir, plan.recipeHash);
    await writeFile(outputPath, rendered.data, { mode: 0o600, flag: 'wx' });
    outputs.push({ recipeHash: plan.recipeHash, path: outputPath, info: rendered.info });
  }
  await writeFile(
    resultPath,
    JSON.stringify({ kind: 'render', outputs } satisfies ChildResult),
    { mode: 0o600, flag: 'wx' },
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
