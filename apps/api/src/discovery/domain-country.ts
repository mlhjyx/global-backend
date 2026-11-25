/**
 * 确定性 ccTLD → ISO 3166-1 alpha-2 国别反推（Batch 1.4-D）。
 *
 * 仅映射语义明确的国家顶级域；刻意排除常被全球 SaaS/创业公司泛用的 ccTLD
 * （如 `.io` / `.ai` / `.co` / `.me` / `.tv` / `.cc` / `.gg` / `.to` / `.ly` / `.sh` / `.ag` / `.fm` / `.so`），
 * 避免误判国别。用于：
 *  1) `public_web` 模型未填 `country` 时自动补齐（如 `.it` → `IT`、`.de` → `DE`）；
 *  2) `contact-persist` / `enrich-contact-email` 在公司 `country` 为空时兜底识别 EU/UK 域，
 *     防止 GDPR Art.14 通知因国别缺失而 fail-open 漏排期。
 */
const UNAMBIGUOUS_CCTLD_TO_ISO2: Readonly<Record<string, string>> = Object.freeze({
  at: 'AT',
  au: 'AU',
  be: 'BE',
  bg: 'BG',
  br: 'BR',
  ca: 'CA',
  ch: 'CH',
  cl: 'CL',
  cn: 'CN',
  cz: 'CZ',
  de: 'DE',
  dk: 'DK',
  ee: 'EE',
  es: 'ES',
  fi: 'FI',
  fr: 'FR',
  gr: 'GR',
  hk: 'HK',
  hr: 'HR',
  hu: 'HU',
  id: 'ID',
  ie: 'IE',
  il: 'IL',
  in: 'IN',
  is: 'IS',
  it: 'IT',
  jp: 'JP',
  kr: 'KR',
  lt: 'LT',
  lu: 'LU',
  lv: 'LV',
  mx: 'MX',
  my: 'MY',
  nl: 'NL',
  no: 'NO',
  nz: 'NZ',
  pl: 'PL',
  pt: 'PT',
  ro: 'RO',
  sa: 'SA',
  se: 'SE',
  sg: 'SG',
  si: 'SI',
  sk: 'SK',
  th: 'TH',
  tr: 'TR',
  tw: 'TW',
  uk: 'GB',
  vn: 'VN',
  za: 'ZA',
});

/** 从域名或 URL 的明确国家顶级域反推两位 ISO 国别码；泛用域名（.com/.eu/.io/.ai 等）返回 undefined。 */
export function inferCountryFromCcTld(domainOrUrl: string | null | undefined): string | undefined {
  if (!domainOrUrl) return undefined;
  let host = domainOrUrl.trim().toLowerCase();
  if (!host) return undefined;
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
  host = host.replace(/\.+$/u, '');
  const lastDot = host.lastIndexOf('.');
  if (lastDot < 1 || lastDot === host.length - 1) return undefined;
  const tld = host.slice(lastDot + 1);
  return UNAMBIGUOUS_CCTLD_TO_ISO2[tld];
}
