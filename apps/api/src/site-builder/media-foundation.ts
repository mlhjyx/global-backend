import { createHash } from "node:crypto";

import type {
  AssetVariantProjectionRow,
  AssetVariantRecipe,
  DerivedImageManifest,
  DerivedImageVariant,
  ImageVariantFormat,
  ImageVariantRole,
} from "@global/contracts";

export type {
  AssetVariantProjectionRow,
  AssetVariantRecipe,
  DerivedImageManifest,
} from "@global/contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const ROLES = ["hero", "card", "thumb", "logo"] as const;

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
  if (!recipe.pipelineVersion.trim()) throw new Error("pipelineVersion is required");
  if (!SHA256.test(recipe.source.contentHash)) {
    throw new Error("source contentHash must be a lowercase SHA-256");
  }
  const hasVariantId = recipe.source.variantId !== null;
  const hasVariantHash = recipe.source.variantContentHash !== null;
  if (hasVariantId !== hasVariantHash) {
    throw new Error("source variant id and content hash must be provided together");
  }
  if (
    recipe.source.variantContentHash !== null &&
    !SHA256.test(recipe.source.variantContentHash)
  ) {
    throw new Error("source variantContentHash must be a lowercase SHA-256");
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
  if (mime === "image/jpeg" || mime === "image/png") return "fallback";
  return null;
}

function isRole(value: string): value is ImageVariantRole {
  return (ROLES as readonly string[]).includes(value);
}

function compareCandidate(
  left: AssetVariantProjectionRow,
  right: AssetVariantProjectionRow,
): number {
  const leftArea = (left.width ?? 0) * (left.height ?? 0);
  const rightArea = (right.width ?? 0) * (right.height ?? 0);
  if (leftArea !== rightArea) return rightArea - leftArea;
  if (left.width !== right.width) return (right.width ?? 0) - (left.width ?? 0);
  if (left.height !== right.height) return (right.height ?? 0) - (left.height ?? 0);
  const byRecipe = left.recipeHash.localeCompare(right.recipeHash);
  return byRecipe || left.objectKey.localeCompare(right.objectKey) || left.id.localeCompare(right.id);
}

function manifestEntry(row: AssetVariantProjectionRow): DerivedImageVariant {
  if (
    row.width === null ||
    row.height === null ||
    row.sizeBytes === null ||
    !Number.isInteger(row.width) ||
    !Number.isInteger(row.height) ||
    !Number.isInteger(row.sizeBytes) ||
    row.width <= 0 ||
    row.height <= 0 ||
    row.sizeBytes <= 0
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
 * 旧 manifest 每个 role/format 只能容纳一项，因此稳定选择面积最大的 ready 输出。
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
    if (row.pipelineVersion !== input.pipelineVersion) {
      throw new Error(`variant ${row.id} belongs to another pipeline`);
    }
    const format = projectionFormat(row.mime);
    if (!isRole(row.variantType) || format === null) continue;
    // Validate every eligible ready row, including rows that lose deterministic selection.
    manifestEntry(row);
    const key = `${row.variantType}:${format}`;
    const current = selected.get(key);
    if (!current || compareCandidate(row, current) < 0) selected.set(key, row);
  }

  const variants: DerivedImageManifest["variants"] = {};
  for (const role of ROLES) {
    const set: Record<string, DerivedImageVariant> = {};
    for (const format of ["avif", "webp", "fallback"] as const) {
      const row = selected.get(`${role}:${format}`);
      if (row) set[format] = manifestEntry(row);
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
