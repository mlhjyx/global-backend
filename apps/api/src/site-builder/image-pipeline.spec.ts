import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { IsolatedImagePipelineRunner } from './image-pipeline-runner';
import {
  IMAGE_PIPELINE_VERSION,
  RESPONSIVE_IMAGE_WIDTHS,
  ImagePipelineInputError,
  inspectImageInput,
  planImageVariants,
  renderImageVariant,
  rolesForAssetKind,
} from './image-pipeline';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function opaqueJpeg(width = 3200, height = 2400): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 80, g: 120, b: 160 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function transparentPng(width = 3200, height = 2400): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
}

describe('M1-c deterministic image policy', () => {
  it('locks the versioned kind→role policy and responsive widths', () => {
    expect(IMAGE_PIPELINE_VERSION).toMatch(
      /^sharp-0\.35\.0-vips-[0-9.]+-m1c\.\d+$/,
    );
    expect(RESPONSIVE_IMAGE_WIDTHS).toEqual([320, 640, 960, 1440, 1920]);
    expect(rolesForAssetKind('logo')).toEqual(['logo']);
    expect(rolesForAssetKind('product_image')).toEqual(['card', 'thumb']);
    expect(rolesForAssetKind('factory_image')).toEqual(['hero', 'card']);
    expect(rolesForAssetKind('cert')).toEqual(['card']);
  });

  it('rejects a declared MIME that disagrees with the decoded image', async () => {
    const input = await transparentPng();
    await expect(inspectImageInput(input, 'image/jpeg')).rejects.toMatchObject<
      Partial<ImagePipelineInputError>
    >({ code: 'IMAGE_MIME_MISMATCH' });
  });

  it('plans one recipe per concrete output and chooses a real fallback codec', async () => {
    const opaque = await opaqueJpeg();
    const opaqueInspection = await inspectImageInput(opaque, 'image/jpeg');
    const opaquePlan = planImageVariants({
      assetKind: 'product_image',
      assetContentHash: sha256(opaque),
      inspection: opaqueInspection,
      focalPoint: { x: 0.5, y: 0.5 },
    });

    expect(opaquePlan).toHaveLength(2 * 5 * 3);
    expect(new Set(opaquePlan.map((item) => item.recipe.output.format))).toEqual(
      new Set(['avif', 'webp', 'jpeg']),
    );
    expect(new Set(opaquePlan.map((item) => item.recipe.output.width))).toEqual(
      new Set(RESPONSIVE_IMAGE_WIDTHS),
    );
    expect(new Set(opaquePlan.map((item) => item.recipeHash)).size).toBe(opaquePlan.length);

    const alpha = await transparentPng();
    const alphaInspection = await inspectImageInput(alpha, 'image/png');
    const alphaPlan = planImageVariants({
      assetKind: 'logo',
      assetContentHash: sha256(alpha),
      inspection: alphaInspection,
    });
    expect(new Set(alphaPlan.map((item) => item.recipe.output.format))).toEqual(
      new Set(['avif', 'webp', 'png']),
    );
    expect(alphaPlan.every((item) => item.recipe.operations.encoder.lossless)).toBe(true);

    const certPlan = planImageVariants({
      assetKind: 'cert',
      assetContentHash: sha256(opaque),
      inspection: opaqueInspection,
    });
    expect(new Set(certPlan.map((item) => item.recipe.output.format))).toEqual(
      new Set(['avif', 'webp', 'png']),
    );
    expect(certPlan.every((item) => item.recipe.operations.encoder.lossless)).toBe(true);
  });

  it('auto-orients, converts to sRGB and strips EXIF/GPS from every output', async () => {
    const input = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: '#876543' },
    })
      .withExif({
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '31/1 14/1 0/1',
          GPSLongitudeRef: 'E',
          GPSLongitude: '121/1 28/1 0/1',
        },
      })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 90 })
      .toBuffer();
    const inspection = await inspectImageInput(input, 'image/jpeg');
    expect(inspection).toMatchObject({ width: 1200, height: 2400, hasExif: true });

    const [planned] = planImageVariants({
      assetKind: 'factory_image',
      assetContentHash: sha256(input),
      inspection,
      focalPoint: { x: 0.5, y: 0.5 },
    }).filter(
      (item) => item.recipe.output.role === 'hero' && item.recipe.output.format === 'webp',
    );
    const rendered = await renderImageVariant(input, planned);
    const metadata = await sharp(rendered.data).metadata();

    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(180);
    expect(metadata.space).toBe('srgb');
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(rendered.info.contentHash).toBe(sha256(rendered.data));
  });

  it('uses the requested focal point for cover crops and preserves alpha in PNG fallback', async () => {
    const left = await sharp({
      create: {
        width: 320,
        height: 320,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const right = await sharp({
      create: {
        width: 320,
        height: 320,
        channels: 4,
        background: { r: 0, g: 0, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const subject = await sharp({
      create: {
        width: 640,
        height: 320,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite([
        { input: left, left: 0, top: 0 },
        { input: right, left: 320, top: 0 },
      ])
      .png()
      .toBuffer();
    const inspection = await inspectImageInput(subject, 'image/png');
    const [rightFocused] = planImageVariants({
      assetKind: 'product_image',
      assetContentHash: sha256(subject),
      inspection,
      focalPoint: { x: 1, y: 0.5 },
    }).filter(
      (item) =>
        item.recipe.output.role === 'thumb' &&
        item.recipe.output.width === 320 &&
        item.recipe.output.format === 'png',
    );
    const rendered = await renderImageVariant(subject, rightFocused);
    const { dominant } = await sharp(rendered.data).stats();

    expect(dominant.b).toBeGreaterThan(200);
    expect(dominant.r).toBeLessThan(30);
    expect((await sharp(rendered.data).metadata()).hasAlpha).toBe(true);
  });

  it('never plans an upscale beyond the oriented source width', async () => {
    const input = await opaqueJpeg(640, 360);
    const inspection = await inspectImageInput(input, 'image/jpeg');
    const plan = planImageVariants({
      assetKind: 'product_image',
      assetContentHash: sha256(input),
      inspection,
      focalPoint: { x: 0.5, y: 0.5 },
    });

    // A 640×360 source has only a 480px-wide 4:3 crop and a 360px square crop.
    expect(new Set(plan.map((item) => item.recipe.output.width))).toEqual(new Set([320]));
    expect(plan.every((item) => item.recipe.operations.withoutEnlargement)).toBe(true);
  });

  it('reports deterministic quality warnings without rejecting a decodable image', async () => {
    const dark = await sharp({
      create: { width: 640, height: 360, channels: 3, background: { r: 2, g: 2, b: 2 } },
    })
      .png()
      .toBuffer();
    const inspection = await inspectImageInput(dark, 'image/png');

    expect(inspection.quality.policyVersion).toBe('image-qa-m1c.1');
    expect(inspection.quality.warnings).toContain('underexposed');
    expect(inspection.quality.metrics).toEqual(
      expect.objectContaining({ entropy: expect.any(Number), sharpness: expect.any(Number) }),
    );
  });

  it('renders the native codec work in a killable isolated child process', async () => {
    const input = await opaqueJpeg(640, 360);
    const runner = new IsolatedImagePipelineRunner(30_000);
    const inspection = await runner.inspect(input, 'image/jpeg');
    const [plan] = planImageVariants({
      assetKind: 'product_image',
      assetContentHash: sha256(input),
      inspection,
      focalPoint: { x: 0.5, y: 0.5 },
    }).filter(
      (item) =>
        item.recipe.output.role === 'thumb' &&
        item.recipe.output.width === 320 &&
        item.recipe.output.format === 'webp',
    );

    const result = await runner.render(input, [plan]);
    const rendered = result.get(plan.recipeHash);
    expect(rendered?.info).toMatchObject({ mime: 'image/webp', width: 320, height: 320 });
    expect(rendered?.info.contentHash).toBe(sha256(rendered!.data));
  });

  it('rejects an already-cancelled child job without starting codec work', async () => {
    const input = await opaqueJpeg(640, 360);
    const controller = new AbortController();
    const reason = new Error('activity cancelled');
    controller.abort(reason);

    await expect(
      new IsolatedImagePipelineRunner(30_000).inspect(input, 'image/jpeg', controller.signal),
    ).rejects.toBe(reason);
  });

  it('kills an in-flight child when the activity is cancelled and cleans scratch', async () => {
    const input = await opaqueJpeg(640, 360);
    const scratch = await mkdtemp(path.join(tmpdir(), 'm1c-cancel-'));
    const controller = new AbortController();
    const reason = new Error('activity cancelled in flight');
    try {
      const pending = new IsolatedImagePipelineRunner(30_000, scratch).inspect(
        input,
        'image/jpeg',
        controller.signal,
      );
      setTimeout(() => controller.abort(reason), 1);
      await expect(pending).rejects.toBe(reason);
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('kills a timed-out child and removes its private scratch directory', async () => {
    const input = await opaqueJpeg(640, 360);
    const scratch = await mkdtemp(path.join(tmpdir(), 'm1c-timeout-'));
    try {
      await expect(
        new IsolatedImagePipelineRunner(1, scratch).inspect(input, 'image/jpeg'),
      ).rejects.toThrow('image pipeline timed out after 1ms');
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
