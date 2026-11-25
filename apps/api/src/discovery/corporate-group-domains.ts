/**
 * L1 集团/母子公司域名同源校验（Batch 1.4-B）：
 *
 * 解决欧洲/全球工业集团常见的「官网域与邮箱域分离」问题（例如官网 `coesaenergy.it`、
 * 集团邮箱 `coesa.it`，或 GLEIF 登记的母公司/品牌域）。
 *
 * 安全硬约束（fail-closed）：
 *  - 严禁把公共免费邮箱（gmail/outlook/libero/gmx/qq 等）误判为集团域；
 *  - 精确匹配 / 子域匹配始终放行；
 *  - 若调用方提供经 GLEIF/官网验证的 `verifiedAliasDomains`，命中即放行；
 *  - 无显式别名时仅对「品牌词根 ≥5 字符 + 同 ccTLD 或主流企业 TLD + 受控企业后缀变体」放行
 *    （如 `coesaenergy.it` ↔ `coesa.it`、`solarplace.it` ↔ `solarplace.eu`），绝不放宽为模糊子串。
 */

const FREE_WEBMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.de', 'yahoo.it', 'yahoo.fr', 'yahoo.es', 'yahoo.co.uk', 'yahoo.co.jp',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de', 'freenet.de',
  'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'tin.it', 'pec.it',
  'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net',
  'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br',
  'qq.com', '163.com', '126.com', 'sina.com', 'foxmail.com', 'yeah.net',
  'yandex.ru', 'mail.ru', 'naver.com', 'daum.net', 'zoho.com',
]);

const MULTI_PART_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'me.uk', 'com.br', 'net.br', 'org.br', 'com.mx', 'com.au', 'net.au',
  'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.cn', 'com.hk', 'com.tw', 'com.sg', 'com.tr',
  'co.in', 'co.za', 'com.ar', 'com.co', 'com.pe', 'com.sa', 'com.eg', 'co.il', 'co.nz',
]);

const CORPORATE_DOMAIN_SUFFIXES: ReadonlySet<string> = new Set([
  'energy', 'energia', 'energie', 'solar', 'solare', 'solaire', 'pv', 'power', 'green',
  'group', 'gruppo', 'gruppe', 'groupe', 'grupo', 'holding', 'holdings', 'corp',
  'tech', 'technology', 'technologies', 'technik', 'tec', 'systems', 'system', 'solutions',
  'engineering', 'eng', 'industrial', 'industries', 'industry', 'mfg', 'global', 'intl',
  'europe', 'eu', 'italia', 'italy', 'de', 'deutschland', 'france', 'iberia', 'brasil',
  'usa', 'uk', 'gmbh', 'srl', 'spa', 'sas', 'ltd', 'inc', 'bv', 'ag', 'se',
]);

export function normalizeDomainHost(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  if (/^https?:\/\//iu.test(value)) {
    try {
      value = new URL(value).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  value = value.replace(/^www\./u, '').replace(/\.+$/u, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(value)) {
    return null;
  }
  return value;
}

export function isFreeWebmailDomain(domain: string): boolean {
  const norm = normalizeDomainHost(domain);
  return norm !== null && FREE_WEBMAIL_DOMAINS.has(norm);
}

/** 拆出可注册域名的 (主标签, 公共后缀)，兼容 .co.uk / .com.br 等双段后缀。 */
export function splitRegistrableDomain(domain: string): { root: string; suffix: string; registrable: string } | null {
  const norm = normalizeDomainHost(domain);
  if (!norm) return null;
  const parts = norm.split('.');
  if (parts.length < 2) return null;
  const lastTwo = parts.slice(-2).join('.');
  if (parts.length >= 3 && MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) {
    const root = parts[parts.length - 3]!;
    return { root, suffix: lastTwo, registrable: `${root}.${lastTwo}` };
  }
  const suffix = parts[parts.length - 1]!;
  const root = parts[parts.length - 2]!;
  return { root, suffix, registrable: `${root}.${suffix}` };
}

function suffixTokenMatchesBrandVariant(longer: string, shorter: string): boolean {
  if (shorter.length < 5 || longer.length <= shorter.length) return false;
  if (!longer.startsWith(shorter)) return false;
  const tail = longer.slice(shorter.length).replace(/^-+/u, '');
  return tail.length > 0 && CORPORATE_DOMAIN_SUFFIXES.has(tail);
}

/**
 * 判断候选邮箱域是否与目标公司官网域属同一企业集团。
 * 支持：精确/子域匹配、经核验别名域列表（GLEIF/官网跳转）、同 ccTLD 品牌词根+企业后缀变体、
 * 同品牌词根跨 .com/.eu/.net/本国 TLD（词根 ≥5 字符且不含连字符碰撞）。
 */
export function isSameCorporateGroupDomain(
  candidateDomain: string,
  companyDomain: string,
  verifiedAliasDomains?: readonly string[],
): boolean {
  const candidate = normalizeDomainHost(candidateDomain);
  const company = normalizeDomainHost(companyDomain);
  if (!candidate || !company) return false;
  if (FREE_WEBMAIL_DOMAINS.has(candidate)) return false;

  if (candidate === company || candidate.endsWith(`.${company}`) || company.endsWith(`.${candidate}`)) {
    return true;
  }

  for (const aliasRaw of verifiedAliasDomains ?? []) {
    const alias = normalizeDomainHost(aliasRaw);
    if (!alias || FREE_WEBMAIL_DOMAINS.has(alias)) continue;
    if (candidate === alias || candidate.endsWith(`.${alias}`) || alias.endsWith(`.${candidate}`)) {
      return true;
    }
  }

  const candSplit = splitRegistrableDomain(candidate);
  const compSplit = splitRegistrableDomain(company);
  if (!candSplit || !compSplit) return false;

  // 同一可注册域名（不同子域，如 mail.acme.de vs shop.acme.de）
  if (candSplit.registrable === compSplit.registrable) return true;

  // 同品牌词根（≥5 字符）跨主流企业 TLD（如 solarplace.it ↔ solarplace.net / .com / .eu）
  const cleanCandRoot = candSplit.root.replace(/-/gu, '');
  const cleanCompRoot = compSplit.root.replace(/-/gu, '');
  if (cleanCandRoot.length >= 5 && cleanCandRoot === cleanCompRoot) {
    return true;
  }

  // 同国家/同 TLD 下的品牌+企业后缀变体（如 coesaenergy.it ↔ coesa.it、acmegroup.de ↔ acme.de）
  if (candSplit.suffix === compSplit.suffix) {
    if (
      suffixTokenMatchesBrandVariant(cleanCandRoot, cleanCompRoot) ||
      suffixTokenMatchesBrandVariant(cleanCompRoot, cleanCandRoot)
    ) {
      return true;
    }
  }
  return false;
}
