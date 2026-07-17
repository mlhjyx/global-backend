import { createHash } from 'node:crypto';

import type {
  AssetVariantOutputFormat,
  AssetVariantRecipeV2,
  ImageVariantRole,
} from '@global/contracts';
import sharp from 'sharp';

import { buildAssetVariantRecipeHash } from './media-foundation';
import type { AssetKind } from './object-key';
import { mimeMatchesSniffed, sniffMime } from './object-key';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_INPUT_CHANNELS = 4;

export const RESPONSIVE_IMAGE_WIDTHS = [320, 640, 960, 1440, 1920] as const;
export const IMAGE_QUALITY_POLICY_VERSION = 'image-qa-m1c.1';
export const IMAGE_PIPELINE_VERSION =
  `sharp-${sharp.versions.sharp}-vips-${sharp.versions.vips}-m1c.1` as const;

export type ImagePipelineErrorCode =
  | 'IMAGE_BYTES_EXCEEDED'
  | 'IMAGE_DECODE_FAILED'
  | 'IMAGE_DIMENSIONS_INVALID'
  | 'IMAGE_MIME_MISMATCH'
  | 'IMAGE_MULTIPAGE_UNSUPPORTED'
  | 'IMAGE_OUTPUT_INVALID';

export class ImagePipelineInputError extends Error {
  constructor(
    readonly code: ImagePipelineErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ImagePipelineInputError';
  }
}

export interface ImageQualityReport {
  policyVersion: typeof IMAGE_QUALITY_POLICY_VERSION;
  metrics: {
    entropy: number;
    sharpness: number;
    exposure: number;
    noise: number;
  };
  warnings: Array<'blurry' | 'underexposed' | 'overexposed' | 'noisy'>;
}

export interface ImageInspection {
  decodedMime: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
  hasAlpha: boolean;
  hasExif: boolean;
  hasIcc: boolean;
  orientation: number | null;
  quality: ImageQualityReport;
}

export interface PlannedImageVariant {
  recipe: AssetVariantRecipeV2;
  recipeHash: string;
}

export interface RenderedImageVariant {
  data: Buffer;
  info: {
    contentHash: string;
    mime: 'image/avif' | 'image/webp' | 'image/jpeg' | 'image/png';
    width: number;
    height: number;
    sizeBytes: number;
  };
}

const ROLE_POLICY: Readonly<Record<AssetKind, readonly ImageVariantRole[]>> = {
  logo: ['logo'],
  product_image: ['card', 'thumb'],
  factory_image: ['hero', 'card'],
  cert: ['card'],
  doc: [],
  video: [],
};

const ROLE_ASPECT: Readonly<Record<ImageVariantRole, number | null>> = {
  hero: 16 / 9,
  card: 4 / 3,
  thumb: 1,
  logo: null,
};

const FORMAT_QUALITY: Readonly<Record<AssetVariantOutputFormat, number>> = {
  avif: 58,
  webp: 76,
  jpeg: 82,
  png: 100,
};

const MIME_BY_FORMAT: Readonly<Record<AssetVariantOutputFormat, RenderedImageVariant['info']['mime']>> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

function strictSharp(input: Buffer) {
  return sharp(input, {
    animated: false,
    failOn: 'warning',
    limitInputChannels: MAX_INPUT_CHANNELS,
    limitInputPixels: MAX_INPUT_PIXELS,
    pages: 1,
    sequentialRead: true,
    unlimited: false,
  });
}

function decodedMime(format: string | undefined): ImageInspection['decodedMime'] | null {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return null;
}

function encodedMime(metadata: sharp.Metadata): RenderedImageVariant['info']['mime'] | null {
  if (metadata.format === 'heif' && metadata.compression === 'av1') return 'image/avif';
  return decodedMime(metadata.format);
}

function orientedDimensions(input: {
  width: number;
  height: number;
  orientation?: number;
}): { width: number; height: number } {
  return input.orientation !== undefined && input.orientation >= 5 && input.orientation <= 8
    ? { width: input.height, height: input.width }
    : { width: input.width, height: input.height };
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

export function rolesForAssetKind(kind: AssetKind): readonly ImageVariantRole[] {
  return ROLE_POLICY[kind];
}

export async function inspectImageInput(
  input: Buffer,
  declaredMime: string,
): Promise<ImageInspection> {
  if (input.length === 0 || input.length > MAX_IMAGE_BYTES) {
    throw new ImagePipelineInputError(
      'IMAGE_BYTES_EXCEEDED',
      `image bytes must be between 1 and ${MAX_IMAGE_BYTES}`,
    );
  }
  if (!mimeMatchesSniffed(declaredMime, sniffMime(input.subarray(0, 16)))) {
    throw new ImagePipelineInputError(
      'IMAGE_MIME_MISMATCH',
      `declared MIME ${declaredMime} disagrees with the object signature`,
    );
  }

  try {
    const pipeline = strictSharp(input);
    const metadata = await pipeline.metadata();
    const mime = decodedMime(metadata.format);
    if (mime === null || mime !== declaredMime) {
      throw new ImagePipelineInputError(
        'IMAGE_MIME_MISMATCH',
        `decoded MIME ${mime ?? 'unsupported'} disagrees with ${declaredMime}`,
      );
    }
    if ((metadata.pages ?? 1) !== 1) {
      throw new ImagePipelineInputError(
        'IMAGE_MULTIPAGE_UNSUPPORTED',
        'animated or multipage images are not accepted',
      );
    }
    if (!metadata.width || !metadata.height) {
      throw new ImagePipelineInputError(
        'IMAGE_DIMENSIONS_INVALID',
        'decoded image has no positive dimensions',
      );
    }
    const dimensions = orientedDimensions({
      width: metadata.width,
      height: metadata.height,
      orientation: metadata.orientation,
    });
    const stats = await strictSharp(input).rotate().toColourspace('srgb').stats();
    const visibleChannels = stats.channels.slice(0, 3);
    const exposure =
      visibleChannels.reduce((sum, channel) => sum + channel.mean / 255, 0) /
      Math.max(1, visibleChannels.length);
    const noise =
      visibleChannels.reduce((sum, channel) => sum + channel.stdev / 255, 0) /
      Math.max(1, visibleChannels.length);
    const warnings: ImageQualityReport['warnings'] = [];
    if (stats.sharpness < 1) warnings.push('blurry');
    if (exposure < 0.08) warnings.push('underexposed');
    if (exposure > 0.92) warnings.push('overexposed');
    if (noise > 0.34) warnings.push('noisy');

    return {
      decodedMime: mime,
      ...dimensions,
      hasAlpha: metadata.hasAlpha === true,
      hasExif: metadata.exif !== undefined,
      hasIcc: metadata.icc !== undefined,
      orientation: metadata.orientation ?? null,
      quality: {
        policyVersion: IMAGE_QUALITY_POLICY_VERSION,
        metrics: {
          entropy: roundMetric(stats.entropy),
          sharpness: roundMetric(stats.sharpness),
          exposure: roundMetric(exposure),
          noise: roundMetric(noise),
        },
        warnings,
      },
    };
  } catch (error) {
    if (error instanceof ImagePipelineInputError) throw error;
    throw new ImagePipelineInputError(
      'IMAGE_DECODE_FAILED',
      'image decoder rejected the input',
      { cause: error },
    );
  }
}

function encoderPolicy(
  format: AssetVariantOutputFormat,
  losslessAsset: boolean,
): AssetVariantRecipeV2['operations']['encoder'] {
  if (format === 'png') {
    return { effort: 9, lossless: true, chromaSubsampling: null };
  }
  if (format === 'webp') {
    return { effort: 4, lossless: losslessAsset, chromaSubsampling: null };
  }
  return { effort: 4, lossless: losslessAsset, chromaSubsampling: '4:4:4' };
}

function plannedWidths(maxWithoutUpscale: number): number[] {
  const available = Math.max(1, Math.floor(maxWithoutUpscale));
  const widths = RESPONSIVE_IMAGE_WIDTHS.filter((width) => width <= available);
  return widths.length > 0 ? [...widths] : [available];
}

export function planImageVariants(input: {
  assetKind: AssetKind;
  assetContentHash: string;
  inspection: ImageInspection;
  focalPoint?: { x: number; y: number } | null;
}): PlannedImageVariant[] {
  const roles = rolesForAssetKind(input.assetKind);
  if (roles.length === 0) return [];
  const losslessAsset = input.assetKind === 'logo' || input.assetKind === 'cert';
  const formats: AssetVariantOutputFormat[] = [
    'avif',
    'webp',
    losslessAsset || input.inspection.hasAlpha ? 'png' : 'jpeg',
  ];
  const sourceAspect = input.inspection.width / input.inspection.height;
  const focalPoint = input.focalPoint ?? null;
  const outputs: PlannedImageVariant[] = [];

  for (const role of roles) {
    const targetAspect = ROLE_ASPECT[role];
    const cover = targetAspect !== null && focalPoint !== null && role !== 'logo';
    const maxWithoutUpscale =
      cover && targetAspect !== null && sourceAspect > targetAspect
        ? input.inspection.height * targetAspect
        : input.inspection.width;
    for (const width of plannedWidths(maxWithoutUpscale)) {
      const height = Math.max(
        1,
        Math.round(width / (cover && targetAspect !== null ? targetAspect : sourceAspect)),
      );
      for (const format of formats) {
        const recipe: AssetVariantRecipeV2 = {
          schemaVersion: '2.0',
          pipelineVersion: IMAGE_PIPELINE_VERSION,
          source: { assetContentHash: input.assetContentHash, variant: null },
          operations: {
            autoOrient: true,
            colourspace: 'srgb',
            stripMetadata: true,
            withoutEnlargement: true,
            kernel: 'lanczos3',
            alpha: 'preserve',
            background: null,
            encoder: encoderPolicy(format, losslessAsset),
          },
          output: {
            role,
            format,
            width,
            height,
            fit: cover ? 'cover' : 'contain',
            position: 'centre',
            focalPoint: cover ? focalPoint : null,
            quality: losslessAsset ? 100 : FORMAT_QUALITY[format],
          },
        };
        outputs.push({ recipe, recipeHash: buildAssetVariantRecipeHash(recipe) });
      }
    }
  }
  return outputs;
}

function cropForFocalPoint(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  focalPoint: { x: number; y: number },
): { left: number; top: number; width: number; height: number } {
  const targetAspect = targetWidth / targetHeight;
  const sourceAspect = sourceWidth / sourceHeight;
  const cropWidth = sourceAspect > targetAspect ? Math.round(sourceHeight * targetAspect) : sourceWidth;
  const cropHeight = sourceAspect > targetAspect ? sourceHeight : Math.round(sourceWidth / targetAspect);
  const focusX = focalPoint.x * sourceWidth;
  const focusY = focalPoint.y * sourceHeight;
  return {
    left: Math.max(0, Math.min(sourceWidth - cropWidth, Math.round(focusX - cropWidth / 2))),
    top: Math.max(0, Math.min(sourceHeight - cropHeight, Math.round(focusY - cropHeight / 2))),
    width: cropWidth,
    height: cropHeight,
  };
}

function encode(
  pipeline: sharp.Sharp,
  recipe: AssetVariantRecipeV2,
): sharp.Sharp {
  const { format, quality } = recipe.output;
  const { effort, lossless, chromaSubsampling } = recipe.operations.encoder;
  if (format === 'avif') {
    return pipeline.avif({
      quality,
      effort,
      lossless,
      chromaSubsampling: chromaSubsampling ?? '4:4:4',
    });
  }
  if (format === 'webp') {
    return pipeline.webp({ quality, alphaQuality: quality, effort, lossless });
  }
  if (format === 'jpeg') {
    return pipeline.jpeg({
      quality,
      chromaSubsampling: chromaSubsampling ?? '4:4:4',
      mozjpeg: false,
      progressive: true,
    });
  }
  return pipeline.png({ compressionLevel: effort, palette: false, progressive: false });
}

export async function renderImageVariant(
  input: Buffer,
  planned: PlannedImageVariant,
): Promise<RenderedImageVariant> {
  if (!planned) {
    throw new ImagePipelineInputError('IMAGE_OUTPUT_INVALID', 'planned variant is required');
  }
  const sourceMetadata = await strictSharp(input).metadata();
  if (!sourceMetadata.width || !sourceMetadata.height) {
    throw new ImagePipelineInputError('IMAGE_DIMENSIONS_INVALID', 'source dimensions are missing');
  }
  const dimensions = orientedDimensions({
    width: sourceMetadata.width,
    height: sourceMetadata.height,
    orientation: sourceMetadata.orientation,
  });
  const { recipe } = planned;
  let pipeline = strictSharp(input).rotate().toColourspace('srgb');
  if (recipe.output.fit === 'cover' && recipe.output.focalPoint) {
    pipeline = pipeline
      .extract(
        cropForFocalPoint(
          dimensions.width,
          dimensions.height,
          recipe.output.width,
          recipe.output.height,
          recipe.output.focalPoint,
        ),
      )
      .resize(recipe.output.width, recipe.output.height, {
        fit: 'fill',
        kernel: 'lanczos3',
        withoutEnlargement: true,
      });
  } else {
    pipeline = pipeline.resize(recipe.output.width, recipe.output.height, {
      fit: 'fill',
      kernel: 'lanczos3',
      withoutEnlargement: true,
    });
  }
  const data = await encode(pipeline, recipe).toBuffer();
  const output = await strictSharp(data).metadata();
  const actualMime = encodedMime(output);
  const expectedMime = MIME_BY_FORMAT[recipe.output.format];
  if (
    actualMime !== expectedMime ||
    output.width !== recipe.output.width ||
    output.height !== recipe.output.height ||
    output.space !== 'srgb' ||
    output.exif !== undefined ||
    output.xmp !== undefined
  ) {
    throw new ImagePipelineInputError(
      'IMAGE_OUTPUT_INVALID',
      `encoded output failed validation for ${planned.recipeHash}: ` +
        JSON.stringify({
          actualMime,
          expectedMime,
          width: output.width,
          expectedWidth: recipe.output.width,
          height: output.height,
          expectedHeight: recipe.output.height,
          space: output.space,
          hasExif: output.exif !== undefined,
          hasXmp: output.xmp !== undefined,
        }),
    );
  }
  return {
    data,
    info: {
      contentHash: createHash('sha256').update(data).digest('hex'),
      mime: expectedMime,
      width: output.width,
      height: output.height,
      sizeBytes: data.length,
    },
  };
}
