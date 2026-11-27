export interface ExtractedWebsiteClaim {
  type: string;
  statement: string;
  evidence?: string;
  confidence: number;
}

const COPYRIGHT_OPENING =
  /^[ \t*#>|-]*(?:©|&copy;|&#169;|&#xa9;|copyright\s+(?:\(c\)\s*)?(?:19|20)\d{2}\b)/iu;
const DATED_COPYRIGHT_NOTICE =
  /(?:(?:©|&copy;|&#169;|&#xa9;)\s*(?:copyright\s+)?|\bcopyright\s+(?:\(c\)\s*)?)(?:19|20)\d{2}\b/iu;
const COPYRIGHT_CLOSING = /(?:\ball rights reserved\b|版权所有|保留所有权利)[\s*|.。]*$/iu;
const YEAR_HOLDING_LABEL = /^(?:19|20)\d{2}[ \t]+控股[ \t]*[\p{L}\p{N}·（）()]{1,64}[.。]?$/u;
const NAVIGATION_LABEL =
  /^(?:[#*>-]+\s*)?(?:首页|关于我们|联系我们|售后(?:问题)?反馈|技术支持|在线留言|隐私政策|home|about us|contact us|technical support|after[- ]sales support|feedback form|contact form|privacy policy)[\s.。]*$/iu;
const SLOGAN_DESCRIPTION =
  /(?:作为|用作)(?:其|品牌|公司|企业|网站)?(?:宣传语|广告语|标语|口号)|\bas (?:its|a|the) (?:company |brand )?(?:slogan|tagline)\b/iu;
const SITE_FEEDBACK_DESCRIPTION =
  /^(?:(?:该|此|其)?(?:公司)?(?:网站|官网|页面|网页)[^\n。！？]{0,35}(?:售后(?:问题)?反馈|在线留言|联系表单)|(?:(?:the|its|their|company's) )?(?:website|web ?page|site)\b[^\n.!?]{0,64}\b(?:feedback|support|contact) forms?\b)/iu;

/** Website facts need relevant evidence even when the model is confident in its label. */
export function hasReviewableWebsiteEvidence(
  claim: ExtractedWebsiteClaim,
  pageText?: string,
): claim is ExtractedWebsiteClaim & { evidence: string } {
  const quote = claim.evidence?.trim();
  const statement = claim.statement.trim();
  if (
    !quote ||
    !statement ||
    COPYRIGHT_OPENING.test(quote) ||
    COPYRIGHT_CLOSING.test(quote) ||
    YEAR_HOLDING_LABEL.test(quote) ||
    NAVIGATION_LABEL.test(quote)
  ) {
    return false;
  }
  if (claim.type === 'value_prop' && SLOGAN_DESCRIPTION.test(statement)) return false;
  if (claim.type === 'capability' && SITE_FEEDBACK_DESCRIPTION.test(statement)) return false;

  // Earlier completed extraction activities replay without their page text at the write step.
  if (pageText === undefined) return true;

  let index = pageText.indexOf(quote);
  while (index >= 0) {
    const lineStart = pageText.lastIndexOf('\n', index - 1) + 1;
    const lineEnd = pageText.indexOf('\n', index);
    const line = pageText.slice(lineStart, lineEnd < 0 ? pageText.length : lineEnd);
    const copyrightStart = line.search(DATED_COPYRIGHT_NOTICE);
    const quoteEndsBeforeNotice = copyrightStart < 0 || index + quote.length <= lineStart + copyrightStart;
    if (quoteEndsBeforeNotice && !COPYRIGHT_OPENING.test(line) && !YEAR_HOLDING_LABEL.test(line.trim())) return true;
    index = lineEnd < 0 ? -1 : pageText.indexOf(quote, lineEnd + 1);
  }
  return false;
}
