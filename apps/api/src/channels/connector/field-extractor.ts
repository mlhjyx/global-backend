import {
  CHANNEL_MANIFEST_CONTACT_FIELD_KEYS,
  CHANNEL_MANIFEST_FIELD_KEYS,
  type ChannelManifestDocument,
} from '@global/contracts';
import { extractJsonPath, extractJsonPathFirst } from './json-path';

/**
 * 字段抽取与清洗（章节 §6.3.5）：JSONPath 子集 + transforms（trim / emailLowercase /
 * websiteHttps / regexStrip）。输出统一「原始记录」形状（不接 canonicalize）：
 *   { fields: Partial<Record<ChannelFieldKey, string>>, sourceUrl }
 * 列宽截断与 source_channel_record 的列定义一致；空 name 的行丢弃（与爬虫的既有语义一致）。
 */

export type ChannelFieldKey = (typeof CHANNEL_MANIFEST_FIELD_KEYS)[number];

export interface RawChannelRecord {
  readonly fields: Partial<Record<ChannelFieldKey, string>>;
  readonly sourceUrl: string | null;
}

const MAX_LENGTHS: Record<ChannelFieldKey, number> = {
  name: 300,
  website: 2048,
  country: 100,
  industry: 200,
  products: 2000,
  keywords: 2000,
  contactName: 200,
  contactTitle: 200,
  email: 320,
  phone: 64,
};

/** 多值字段：抽取全部命中并拼成逗号串（products/keywords 在库里是 Json，物化层再拆分）。 */
const MULTI_VALUE_FIELDS: ReadonlySet<ChannelFieldKey> = new Set(['products', 'keywords']);

type Transforms = NonNullable<ChannelManifestDocument['transforms']>;

function applyTransforms(value: string, key: ChannelFieldKey, transforms: Transforms | undefined): string {
  let result = value;
  for (const strip of transforms?.regexStrip ?? []) {
    try {
      result = result.replace(new RegExp(strip.pattern, strip.flags ?? ''), '');
    } catch {
      // 保存时已编译校验；运行时坏正则按不应用处理（绝不因配置空转）。
    }
  }
  if (transforms?.trim !== false) result = result.trim();
  if (key === 'email' && transforms?.emailLowercase !== false) result = result.toLowerCase();
  if (key === 'website' && transforms?.websiteHttps !== false) {
    if (/^http:\/\//iu.test(result)) result = result.replace(/^http:\/\//iu, 'https://');
    else if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(result) && /^[^\s/]+\.[^\s/]+/u.test(result)) {
      result = `https://${result}`;
    }
  }
  return result.slice(0, MAX_LENGTHS[key]);
}

function scalarString(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  return null;
}

function collectStrings(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const scalar = scalarString(value);
    if (scalar !== null) out.push(scalar);
    else if (Array.isArray(value)) {
      for (const item of value) {
        const nested = scalarString(item);
        if (nested !== null) out.push(nested);
      }
    }
  }
  return out;
}

/** 抽取单条记录（只填 fieldMapping 里声明的字段）。 */
export function extractRecordFields(
  manifest: ChannelManifestDocument,
  item: unknown,
): Partial<Record<ChannelFieldKey, string>> {
  const mapping = manifest.fieldMapping ?? {};
  const fields: Partial<Record<ChannelFieldKey, string>> = {};
  for (const key of CHANNEL_MANIFEST_FIELD_KEYS) {
    const path = mapping[key];
    if (!path) continue;
    const raw = MULTI_VALUE_FIELDS.has(key)
      ? collectStrings(extractJsonPath(item, path)).join(', ')
      : extractJsonPathFirst(item, path);
    if (raw === null || raw === '') continue;
    const cleaned = applyTransforms(raw, key, manifest.transforms);
    if (cleaned.length > 0) fields[key] = cleaned;
  }
  return fields;
}

export interface ExtractRecordsResult {
  readonly records: RawChannelRecord[];
  readonly skipped: number;
}

export function itemsArray(body: unknown, itemsPath: string): unknown[] | null {
  for (const match of extractJsonPath(body, itemsPath)) {
    if (Array.isArray(match)) return match;
  }
  return null;
}

export function extractRecordsFromJson(
  manifest: ChannelManifestDocument,
  body: unknown,
  sourceUrl: string,
): ExtractRecordsResult {
  const items = itemsArray(body, manifest.records?.itemsPath ?? '$.items') ?? [];
  const records: RawChannelRecord[] = [];
  let skipped = 0;
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      skipped += 1;
      continue;
    }
    const fields = extractRecordFields(manifest, item);
    if (!fields.name) {
      skipped += 1;
      continue;
    }
    records.push({ fields, sourceUrl });
  }
  return { records, skipped };
}

export function isContactFieldKey(key: string): boolean {
  return (CHANNEL_MANIFEST_CONTACT_FIELD_KEYS as readonly string[]).includes(key);
}

/** 试跑/抽检展示用样本：联系人字段只看命中与否，其余字段截断 160 字符。 */
export function sanitizeRecordForSample(
  fields: Partial<Record<ChannelFieldKey, string>>,
): Record<string, string | { present: boolean }> {
  const sample: Record<string, string | { present: boolean }> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string') continue;
    sample[key] = isContactFieldKey(key) ? { present: value.length > 0 } : value.slice(0, 160);
  }
  return sample;
}
