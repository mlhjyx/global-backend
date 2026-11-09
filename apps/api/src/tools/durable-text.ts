/**
 * 工具持久结果的文本整形（searxng / social / deepseek 共用）。
 * typed projection 只接受 NFC、无 NUL、无孤立代理项的文本；上游原始 HTML、标题与页面
 * 正文里这些都真实存在，不整形会让 registry.project 拒绝一个合法的上游结果（2026-11-02
 * acceptance run：这类拒绝曾把已付费操作留在 RESERVED 并打死整条活动）。
 */

/** With the u flag a surrogate pair reads as one astral code point, so this matches lone surrogates only. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Text the typed projection accepts: NFC, without NUL and without lone surrogates. */
export function isDurableText(value: string): boolean {
  return !value.includes("\0") && !LONE_SURROGATE.test(value) && value === value.normalize("NFC");
}

/** A provider title as durable text, cut to the contract without splitting a surrogate pair. */
export function durableTitle(raw: string, maxChars = 2000): string | null {
  let title = raw.replaceAll("\0", "").replace(/[\uD800-\uDFFF]/gu, "�").normalize("NFC");
  if (title.length > maxChars) {
    title = title.slice(0, maxChars);
    if (/[\uD800-\uDBFF]$/u.test(title)) title = title.slice(0, -1);
  }
  return isDurableText(title) ? title : null;
}

/** Page text shaped like the social/deepseek fetch contracts: NUL removed, lone surrogates replaced, NFC, bounded. */
export function durablePageText(raw: string, maxChars: number): string {
  let text = raw.replaceAll("\0", "").replace(/[\uD800-\uDFFF]/gu, "�").normalize("NFC");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
  }
  return text;
}

/** Profile pages of individual people: their URL and title name the person. */
export const PERSON_PROFILE_PAGES: readonly (readonly [domain: string, path: RegExp])[] = [
  ["linkedin.com", /^\/(?:in|pub)\//iu],
  ["xing.com", /^\/profile\//iu],
];

export function isPersonProfileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/\.$/u, "");
  return PERSON_PROFILE_PAGES.some(
    ([domain, path]) => (host === domain || host.endsWith(`.${domain}`)) && path.test(parsed.pathname),
  );
}
