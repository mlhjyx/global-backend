/** MF-0 媒体地基共享合同；处理算法和异步 Job 不属于本合同。 */

export const IMAGE_VARIANT_ROLES = [
  "hero",
  "card",
  "thumb",
  "logo",
] as const;
export type ImageVariantRole = (typeof IMAGE_VARIANT_ROLES)[number];

export const IMAGE_VARIANT_FORMATS = [
  "avif",
  "webp",
  "jpeg",
  "png",
] as const;
export type ImageVariantFormat = (typeof IMAGE_VARIANT_FORMATS)[number];

/** 物化 recipe 与兼容 manifest 都保留具体编码身份。 */
export const ASSET_VARIANT_OUTPUT_FORMATS = [
  "avif",
  "webp",
  "jpeg",
  "png",
] as const;
export type AssetVariantOutputFormat =
  (typeof ASSET_VARIANT_OUTPUT_FORMATS)[number];

export const ASSET_VARIANT_FITS = [
  "cover",
  "contain",
  "fill",
  "inside",
  "outside",
] as const;
export type AssetVariantFit = (typeof ASSET_VARIANT_FITS)[number];

/** Sharp position 的单一规范拼写；不接受 center 等别名进入 recipe。 */
export const ASSET_VARIANT_POSITIONS = [
  "centre",
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
  "entropy",
  "attention",
] as const;
export type AssetVariantPosition =
  (typeof ASSET_VARIANT_POSITIONS)[number];

export interface AssetVariantRecipe {
  pipelineVersion: string;
  source: {
    /** 逻辑 Asset 原件的内容 SHA-256，始终参与身份。 */
    assetContentHash: string;
    /** 直接从原件派生时为 null；二次派生时同时固定 Variant ID 与内容。 */
    variant: { id: string; contentHash: string } | null;
  };
  output: {
    role: ImageVariantRole;
    format: AssetVariantOutputFormat;
    width: number;
    height: number;
    fit: AssetVariantFit;
    position: AssetVariantPosition;
    focalPoint: { x: number; y: number } | null;
    quality: number;
  };
}

export interface DerivedImageVariant {
  key: string;
  width: number;
  height: number;
  bytes: number;
}

export interface ImageVariantSet {
  avif?: DerivedImageVariant[];
  webp?: DerivedImageVariant[];
  jpeg?: DerivedImageVariant[];
  png?: DerivedImageVariant[];
}

export interface DerivedImageManifest {
  schemaVersion: "1.0";
  pipelineVersion: string;
  sourceHash: string;
  variants: Partial<Record<ImageVariantRole, ImageVariantSet>>;
}

/** AssetVariant 的投影所需最小只读形状，避免 projector 依赖 Prisma。 */
export interface AssetVariantProjectionRow {
  id: string;
  variantType: string;
  mime: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  objectKey: string;
  contentHash: string | null;
  recipeHash: string;
  pipelineVersion: string;
  status: string;
}
