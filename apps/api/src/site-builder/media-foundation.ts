import { createHash } from "node:crypto";

import {
  ASSET_VARIANT_FITS,
  ASSET_VARIANT_OUTPUT_FORMATS,
  ASSET_VARIANT_POSITIONS,
  IMAGE_VARIANT_ROLES,
  type AssetVariantProjectionRow,
  type AssetVariantRecipe,
  type DerivedImageManifest,
  type DerivedImageVariant,
  type ImageVariantFormat,
  type ImageVariantRole,
} from "@global/contracts";

export type {
  AssetVariantProjectionRow,
  AssetVariantRecipe,
  DerivedImageManifest,
} from "@global/contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * JSON 的确定性规范形。对象键排序，数组顺序保留；拒绝会被 JSON 静默改写的值。
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("recipe contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => {
        if (record[key] === undefined) {
          throw new Error(`recipe contains undefined at ${key}`);
        }
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error(`recipe contains unsupported ${typeof value}`);
}

function assertRecipe(recipe: AssetVariantRecipe): void {
  if (recipe.schemaVersion !== "1.0") throw new Error("recipe schemaVersion is unsupported");
  if (!recipe.pipelineVersion.trim()) throw new Error("pipelineVersion is required");
  if (!SHA256.test(recipe.source.assetContentHash)) {
    throw new Error("source assetContentHash must be a lowercase SHA-256");
  }
  if (recipe.source.variant !== null) {
    if (!UUID.test(recipe.source.variant.id)) {
      throw new Error("source variant id must be a UUID");
    }
    if (!SHA256.test(recipe.source.variant.contentHash)) {
      throw new Error("source variant contentHash must be a lowercase SHA-256");
    }
  }
  if (
    recipe.operations.autoOrient !== true ||
    recipe.operations.colourspace !== "srgb" ||
    recipe.operations.stripMetadata !== true ||
    recipe.operations.withoutEnlargement !== true ||
    recipe.operations.kernel !== "lanczos3" ||
    recipe.operations.alpha !== "preserve"
  ) {
    throw new Error("recipe operations are not canonical");
  }
  const background = recipe.operations.background;
  if (
    background !== null &&
    (![background.r, background.g, background.b].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    ) ||
      !Number.isFinite(background.alpha) ||
      background.alpha < 0 ||
      background.alpha > 1)
  ) {
    throw new Error("recipe background is invalid");
  }
  const encoder = recipe.operations.encoder;
  if (
    !Number.isInteger(encoder.effort) ||
    encoder.effort < 0 ||
    encoder.effort > 9 ||
    typeof encoder.lossless !== "boolean" ||
    !(["4:4:4", "4:2:0", null] as const).includes(encoder.chromaSubsampling)
  ) {
    throw new Error("recipe encoder policy is invalid");
  }
  if (!(IMAGE_VARIANT_ROLES as readonly string[]).includes(recipe.output.role)) {
    throw new Error("output role is not canonical");
  }
  if (!(ASSET_VARIANT_OUTPUT_FORMATS as readonly string[]).includes(recipe.output.format)) {
    throw new Error("output format must name a concrete encoder");
  }
  if (!(ASSET_VARIANT_FITS as readonly string[]).includes(recipe.output.fit)) {
    throw new Error("output fit is not canonical");
  }
  if (!(ASSET_VARIANT_POSITIONS as readonly string[]).includes(recipe.output.position)) {
    throw new Error("output position is not canonical");
  }
  if (!Number.isInteger(recipe.output.width) || recipe.output.width <= 0) {
    throw new Error("output width must be a positive integer");
  }
  if (!Number.isInteger(recipe.output.height) || recipe.output.height <= 0) {
    throw new Error("output height must be a positive integer");
  }
  if (
    !Number.isInteger(recipe.output.quality) ||
    recipe.output.quality < 1 ||
    recipe.output.quality > 100
  ) {
    throw new Error("output quality must be an integer from 1 to 100");
  }
  if (recipe.output.focalPoint) {
    const { x, y } = recipe.output.focalPoint;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      throw new Error("focalPoint coordinates must be between 0 and 1");
    }
  }
}

/** 每个物化输出一个 recipeHash；格式、尺寸和质量都参与身份。 */
export function buildAssetVariantRecipeHash(recipe: AssetVariantRecipe): string {
  assertRecipe(recipe);
  return createHash("sha256").update(canonicalJson(recipe)).digest("hex");
}

function projectionFormat(mime: string): ImageVariantFormat | null {
  if (mime === "image/avif") return "avif";
  if (mime === "image/webp") return "webp";
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/png") return "png";
  return null;
}

function isRole(value: string): value is ImageVariantRole {
  return (IMAGE_VARIANT_ROLES as readonly string[]).includes(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSameWidthCandidate(
  left: AssetVariantProjectionRow,
  right: AssetVariantProjectionRow,
): number {
  if (left.height !== right.height) return (right.height ?? 0) - (left.height ?? 0);
  const byRecipe = compareText(left.recipeHash, right.recipeHash);
  return byRecipe || compareText(left.objectKey, right.objectKey) || compareText(left.id, right.id);
}

function manifestEntry(row: AssetVariantProjectionRow): DerivedImageVariant {
  if (
    row.width === null ||
    row.height === null ||
    row.sizeBytes === null ||
    row.contentHash === null ||
    !Number.isInteger(row.width) ||
    !Number.isInteger(row.height) ||
    !Number.isInteger(row.sizeBytes) ||
    row.width <= 0 ||
    row.height <= 0 ||
    row.sizeBytes <= 0 ||
    !SHA256.test(row.contentHash) ||
    !SHA256.test(row.recipeHash) ||
    row.objectKey.length === 0
  ) {
    throw new Error(`ready image variant ${row.id} has invalid dimensions or bytes`);
  }
  return {
    key: row.objectKey,
    width: row.width,
    height: row.height,
    bytes: row.sizeBytes,
  };
}

/**
 * AssetVariant 是权威；此函数只生成一个 Release 周期内的 derivedKeys 兼容视图。
 * 同 role/format 保留响应式宽度数组；同宽重复 recipe 稳定选择一项。
 */
export function projectDerivedImageManifest(input: {
  pipelineVersion: string;
  sourceHash: string;
  variants: readonly AssetVariantProjectionRow[];
}): DerivedImageManifest {
  if (!input.pipelineVersion.trim()) throw new Error("pipelineVersion is required");
  if (!SHA256.test(input.sourceHash)) {
    throw new Error("sourceHash must be a lowercase SHA-256");
  }

  const selected = new Map<string, AssetVariantProjectionRow>();
  for (const row of input.variants) {
    if (row.status !== "ready") continue;
    if (row.pipelineVersion !== input.pipelineVersion) continue;
    const format = projectionFormat(row.mime);
    if (!isRole(row.variantType) || format === null) continue;
    // Validate every eligible ready row, including rows that lose deterministic selection.
    manifestEntry(row);
    const key = `${row.variantType}:${format}:${row.width}`;
    const current = selected.get(key);
    if (!current || compareSameWidthCandidate(row, current) < 0) selected.set(key, row);
  }

  const variants: DerivedImageManifest["variants"] = {};
  for (const role of IMAGE_VARIANT_ROLES) {
    const set: Partial<Record<ImageVariantFormat, DerivedImageVariant[]>> = {};
    for (const format of ["avif", "webp", "jpeg", "png"] as const) {
      const rows = [...selected.entries()]
        .filter(([key]) => key.startsWith(`${role}:${format}:`))
        .map(([, row]) => row)
        .sort((left, right) =>
          (left.width ?? 0) - (right.width ?? 0) ||
          (left.height ?? 0) - (right.height ?? 0) ||
          compareText(left.recipeHash, right.recipeHash),
        );
      if (rows.length > 0) set[format] = rows.map(manifestEntry);
    }
    if (Object.keys(set).length > 0) variants[role] = set;
  }

  return {
    schemaVersion: "1.0",
    pipelineVersion: input.pipelineVersion,
    sourceHash: input.sourceHash,
    variants,
  };
}
