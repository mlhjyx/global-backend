import type { AssetVariantOutputFormat } from '@global/contracts';

/**
 * 对象存储键布局（02 §2）与上传安全闸（06 §2）。
 * canonical：ws/{workspace_id}/{site_id}/{kind}/{content_hash}.{ext}
 * staging  ：ws/{workspace_id}/{site_id}/uploads/{asset_id}（commit 校验+算哈希后搬运）
 * 租户隔离靠 key 前缀 + 短时 presigned URL；bucket 永不公开。
 */

export const ASSET_KINDS = ['logo', 'product_image', 'factory_image', 'cert', 'doc', 'video'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

const MB = 1024 * 1024;
const IMAGE_MAX_BYTES = 20 * MB;
const DOC_MAX_BYTES = 50 * MB;
const VIDEO_MAX_BYTES = 500 * MB;

const KIND_LIMITS: Record<AssetKind, number> = {
  logo: IMAGE_MAX_BYTES,
  product_image: IMAGE_MAX_BYTES,
  factory_image: IMAGE_MAX_BYTES,
  cert: DOC_MAX_BYTES, // 证书可为图或 PDF，取文档档
  doc: DOC_MAX_BYTES,
  video: VIDEO_MAX_BYTES,
};

/** MIME 白名单 → 扩展名。HTML/SVG/可执行类永不入列（脚本注入面，06 §2）。 */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'video/mp4': 'mp4',
};

/** kind × MIME 相容表（Codex P2：全局白名单不够——pdf 混进 product_image 会走错管线）。 */
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const DOC_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/markdown',
];
const KIND_MIMES: Record<AssetKind, ReadonlySet<string>> = {
  logo: new Set(IMAGE_MIMES),
  product_image: new Set(IMAGE_MIMES),
  factory_image: new Set(IMAGE_MIMES),
  cert: new Set([...IMAGE_MIMES, 'application/pdf']),
  doc: new Set(DOC_MIMES),
  video: new Set(['video/mp4']),
};

export function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

export function kindAcceptsMime(kind: AssetKind, mime: string): boolean {
  return KIND_MIMES[kind].has(mime);
}

export function extForMime(mime: string): string | null {
  return MIME_EXT[mime] ?? null;
}

export function maxBytesForKind(kind: AssetKind): number {
  return KIND_LIMITS[kind];
}

export function buildObjectKey(
  workspaceId: string,
  siteId: string,
  kind: AssetKind | 'generated',
  contentHash: string,
  ext: string,
): string {
  return `ws/${workspaceId}/${siteId}/${kind}/${contentHash}.${ext}`;
}

export function buildStagingKey(workspaceId: string, siteId: string, assetId: string): string {
  return `ws/${workspaceId}/${siteId}/uploads/${assetId}`;
}

/**
 * 派生物独占命名空间；assetId + 单输出 recipeHash 把对象键绑定到 DB provenance。
 * JPEG 的规范 recipe 名为 jpeg，对象扩展名保持通用 jpg。
 */
export function buildVariantObjectKey(
  workspaceId: string,
  siteId: string,
  assetId: string,
  recipeHash: string,
  format: AssetVariantOutputFormat,
): string {
  const ext = format === 'jpeg' ? 'jpg' : format;
  return `ws/${workspaceId}/${siteId}/variants/${assetId}/${recipeHash}.${ext}`;
}

/**
 * Producer-isolated write key. An expired producer can only recreate its own non-canonical
 * attempt object; promotion to the public Variant key requires the current DB fencing token.
 */
export function buildVariantAttemptObjectKey(
  workspaceId: string,
  siteId: string,
  assetId: string,
  producerToken: string,
  recipeHash: string,
  format: AssetVariantOutputFormat,
): string {
  const ext = format === 'jpeg' ? 'jpg' : format;
  return `ws/${workspaceId}/${siteId}/variant-attempts/${assetId}/${producerToken}/${recipeHash}.${ext}`;
}

interface MagicRule {
  mime: string;
  matches(head: Buffer): boolean;
}

const MAGIC_RULES: MagicRule[] = [
  { mime: 'image/jpeg', matches: (h) => h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  {
    mime: 'image/png',
    matches: (h) => h.length >= 8 && h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    matches: (h) =>
      h.length >= 12 && h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { mime: 'application/pdf', matches: (h) => h.subarray(0, 5).toString('latin1') === '%PDF-' },
  {
    // docx/pptx/xlsx 都是 zip 容器；细分交解析器，这里挡住"扩展名撒谎"的非 zip 载荷
    mime: 'application/zip',
    matches: (h) => h.length >= 4 && h[0] === 0x50 && h[1] === 0x4b && (h[2] === 0x03 || h[2] === 0x05 || h[2] === 0x07),
  },
  {
    // mp4：4-11 字节应为 ftyp box
    mime: 'video/mp4',
    matches: (h) => h.length >= 8 && h.subarray(4, 8).toString('latin1') === 'ftyp',
  },
];

/** 魔数嗅探（不信 Content-Type）。未识别返回 null，调用方按 rejected 处理。 */
export function sniffMime(head: Buffer): string | null {
  for (const rule of MAGIC_RULES) {
    if (rule.matches(head)) return rule.mime;
  }
  return null;
}

/** 声明的 MIME 与嗅探结果是否相容（zip 容器族共用 application/zip 魔数）。 */
export function mimeMatchesSniffed(declared: string, sniffed: string | null): boolean {
  if (sniffed === null) {
    // 纯文本类无魔数：只允许显式声明的 text 白名单
    return declared === 'text/plain' || declared === 'text/markdown';
  }
  if (sniffed === 'application/zip') {
    return declared.startsWith('application/vnd.openxmlformats-officedocument.');
  }
  return declared === sniffed;
}
