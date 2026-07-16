/** MF-0 媒体地基共享合同；处理算法和异步 Job 不属于本合同。 */

export const IMAGE_VARIANT_ROLES = [
  "hero",
  "card",
  "thumb",
  "logo",
] as const;
export type ImageVariantRole = (typeof IMAGE_VARIANT_ROLES)[number];

export const IMAGE_VARIANT_FORMATS = ["avif", "webp", "fallback"] as const;
export type ImageVariantFormat = (typeof IMAGE_VARIANT_FORMATS)[number];

export interface AssetVariantRecipe {
  pipelineVersion: string;
  source: {
    /** 原始 Asset 或派生源的内容 SHA-256。 */
    contentHash: string;
    /** 直接从原件派生时为 null。 */
    variantId: string | null;
    /** 与 variantId 同空同存，防止可变 ID 掩盖内容变化。 */
    variantContentHash: string | null;
  };
  output: {
    role: ImageVariantRole;
    format: ImageVariantFormat;
    width: number;
    height: number;
    fit: "cover" | "contain" | "fill" | "inside" | "outside";
    position: string;
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
  avif?: DerivedImageVariant;
  webp?: DerivedImageVariant;
  fallback?: DerivedImageVariant;
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
  contentHash: string;
  recipeHash: string;
  pipelineVersion: string;
  status: string;
}
