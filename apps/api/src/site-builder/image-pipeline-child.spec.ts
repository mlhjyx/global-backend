import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { inspectImageInput, planImageVariants } from './image-pipeline';
import { runImagePipelineChild } from './image-pipeline-child';

async function jpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 40, g: 80, b: 120 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function job(request: Record<string, unknown>, input = Buffer.from('input')) {
  const dir = await mkdtemp(path.join(tmpdir(), 'image-child-unit-'));
  const inputPath = path.join(dir, 'input');
  const requestPath = path.join(dir, 'request.json');
  const resultPath = path.join(dir, 'result.json');
  await writeFile(inputPath, input, { mode: 0o600 });
  await writeFile(requestPath, JSON.stringify({ ...request, inputPath, outputDir: dir }), { mode: 0o600 });
  return { dir, inputPath, requestPath, resultPath };
}

describe('runImagePipelineChild', () => {
  it('requires exact control paths and the libvips hardening flag', async () => {
    await expect(runImagePipelineChild(undefined, undefined, {})).rejects.toThrow('required');
    const h = await job({ action: 'inspect', declaredMime: 'image/jpeg' });
    try {
      await expect(runImagePipelineChild(h.requestPath, path.join(h.dir, 'other.json'), { VIPS_BLOCK_UNTRUSTED: '1' })).rejects.toThrow(
        'control paths',
      );
      await expect(runImagePipelineChild(h.requestPath, h.resultPath, {})).rejects.toThrow('VIPS_BLOCK_UNTRUSTED');
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['invalid JSON', '{', 'invalid child request JSON'],
    ['invalid envelope', JSON.stringify({ action: 'delete' }), 'invalid child request envelope'],
    [
      'escaped path',
      JSON.stringify({ action: 'inspect', inputPath: '/tmp/input', outputDir: '/tmp', declaredMime: 'image/jpeg' }),
      'path escaped',
    ],
  ])('rejects %s', async (_label, requestText, message) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'image-child-invalid-'));
    try {
      const requestPath = path.join(dir, 'request.json');
      await writeFile(requestPath, requestText, { mode: 0o600 });
      await expect(
        runImagePipelineChild(requestPath, path.join(dir, 'result.json'), { VIPS_BLOCK_UNTRUSTED: '1' }),
      ).rejects.toThrow(message);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported MIME, invalid plan counts, and duplicate or malformed hashes', async () => {
    const cases = [
      { action: 'inspect', declaredMime: 'image/gif' },
      { action: 'render', plans: [] },
      { action: 'render', plans: [{ recipeHash: 'bad' }] },
      { action: 'render', plans: [{ recipeHash: 'a'.repeat(64) }, { recipeHash: 'a'.repeat(64) }] },
    ];
    for (const request of cases) {
      const h = await job(request);
      try {
        await expect(runImagePipelineChild(h.requestPath, h.resultPath, { VIPS_BLOCK_UNTRUSTED: '1' })).rejects.toThrow(
          /invalid|duplicate/,
        );
      } finally {
        await rm(h.dir, { recursive: true, force: true });
      }
    }
  });

  it('rejects a symlinked or empty bounded input before codec work', async () => {
    const h = await job({ action: 'inspect', declaredMime: 'image/jpeg' }, Buffer.alloc(0));
    try {
      await expect(runImagePipelineChild(h.requestPath, h.resultPath, { VIPS_BLOCK_UNTRUSTED: '1' })).rejects.toThrow(
        'bounded regular file',
      );
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'image-child-link-'));
    try {
      const target = path.join(dir, 'target');
      await writeFile(target, Buffer.from('x'));
      await symlink(target, path.join(dir, 'input'));
      const requestPath = path.join(dir, 'request.json');
      await writeFile(
        requestPath,
        JSON.stringify({ action: 'inspect', inputPath: path.join(dir, 'input'), outputDir: dir, declaredMime: 'image/jpeg' }),
      );
      await expect(
        runImagePipelineChild(requestPath, path.join(dir, 'result.json'), { VIPS_BLOCK_UNTRUSTED: '1' }),
      ).rejects.toThrow('bounded regular file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes a bounded inspection receipt and one rendered output set', async () => {
    const input = await jpeg();
    const inspectJob = await job({ action: 'inspect', declaredMime: 'image/jpeg' }, input);
    try {
      await runImagePipelineChild(inspectJob.requestPath, inspectJob.resultPath, { VIPS_BLOCK_UNTRUSTED: '1' });
      const result = JSON.parse(await readFile(inspectJob.resultPath, 'utf8')) as Record<string, unknown>;
      expect(result).toMatchObject({ kind: 'inspect', inspection: { decodedMime: 'image/jpeg', width: 640, height: 360 } });
    } finally {
      await rm(inspectJob.dir, { recursive: true, force: true });
    }

    const inspection = await inspectImageInput(input, 'image/jpeg');
    const [plan] = planImageVariants({
      assetKind: 'product_image',
      assetContentHash: createHash('sha256').update(input).digest('hex'),
      inspection,
      focalPoint: { x: 0.5, y: 0.5 },
    }).filter((candidate) => candidate.recipe.output.format === 'webp');
    const renderJob = await job({ action: 'render', plans: [plan] }, input);
    try {
      await runImagePipelineChild(renderJob.requestPath, renderJob.resultPath, { VIPS_BLOCK_UNTRUSTED: '1' });
      const result = JSON.parse(await readFile(renderJob.resultPath, 'utf8')) as {
        kind: string;
        outputs: Array<{ recipeHash: string; path: string; info: { mime: string } }>;
      };
      expect(result.kind).toBe('render');
      expect(result.outputs).toEqual([
        expect.objectContaining({ recipeHash: plan.recipeHash, path: path.join(renderJob.dir, plan.recipeHash), info: expect.objectContaining({ mime: 'image/webp' }) }),
      ]);
      expect((await readFile(result.outputs[0].path)).length).toBeGreaterThan(0);
    } finally {
      await rm(renderJob.dir, { recursive: true, force: true });
    }
  });

  it('rejects non-canonical job directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'image-child-realpath-'));
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    try {
      await mkdir(real);
      await symlink(real, alias);
      await expect(
        runImagePipelineChild(path.join(alias, 'request.json'), path.join(alias, 'result.json'), { VIPS_BLOCK_UNTRUSTED: '1' }),
      ).rejects.toThrow('control paths');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
