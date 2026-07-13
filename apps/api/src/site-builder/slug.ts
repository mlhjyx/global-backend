import { randomBytes } from 'node:crypto';

/** 预览子域 slug（06 §7）：可读前缀 + 不可枚举随机尾，整体是合法 DNS label。 */

const SUFFIX_LENGTH = 6;
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_PREFIX_LENGTH = 40; // 前缀上限，留足空间给尾缀且远离 63 字符 label 顶

export function randomSlugSuffix(length = SUFFIX_LENGTH): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SUFFIX_ALPHABET[bytes[i] % SUFFIX_ALPHABET.length];
  }
  return out;
}

/** 拉丁化 kebab 前缀；非拉丁（如纯中文名）产不出前缀时退 'site'。 */
function slugPrefix(name: string | null): string {
  const cleaned = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PREFIX_LENGTH)
    .replace(/-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'site';
}

export function makeSlug(nameEn: string | null, suffix: () => string = randomSlugSuffix): string {
  return `${slugPrefix(nameEn)}-${suffix()}`;
}
