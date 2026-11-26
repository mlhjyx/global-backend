const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** HTML 实体解码（`info&#64;acme.de` / `&#105;nfo@…` 是德国 Impressum 常见的防爬编码）。 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&#(\d+);/gu, (match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&([a-z]+);/giu, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * 渲染 HTML → 可见文本（确定性抽取器输入；实体解码、script/style/注释先剥掉）。
 * 结束标签按浏览器容错形态匹配（`</script >` / `</script foo="x">`）——这不是 HTML
 * 消毒器（输出只喂正则抽取、绝不回渲成 HTML），但要剥干净以免脚本体混进文本抽取
 *（CodeQL js/bad-tag-filter，alert #85）。
 */
export function stripHtml(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/giu, ' ')
    .replace(/<!--[\s\S]*?--!?>/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ');
}
