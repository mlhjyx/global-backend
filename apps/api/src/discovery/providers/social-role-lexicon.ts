/**
 * 社媒联系人发现多语种职位、法人后缀与泛词词表（从 social-presence.provider.ts 拆出，Batch 1.8A）。
 *
 * 覆盖 DE / EN / IT / ES / FR / PT / NL 工业采购、技术定标、高管与运营核心职位词根，
 * 并补充意大利/欧陆常见法定后缀与光伏/工业泛词，防止「公司名仅命中法人词/泛词」误吸无关同名个人主页。
 */

/** 公司名比对里无区分度的法律形式/泛词（"GmbH"/"srl"/"spa" 不能证明页面属于这家公司）。 */
export const LEGAL_FORM_TOKENS: ReadonlySet<string> = new Set([
  // DE / AT / CH / EN
  'gmbh', 'mbh', 'ag', 'kg', 'ohg', 'ug', 'gbr', 'ek', 'inc', 'incorporated',
  'ltd', 'limited', 'llc', 'corp', 'corporation', 'co', 'company', 'plc',
  'holding', 'holdings', 'group', 'gruppe', 'international', 'und', 'the', 'der', 'die', 'das',
  // IT / ES / FR / PT / NL / PL / Nordic
  'srl', 'srls', 'srlu', 'spa', 'snc', 'sapa', 'scrl',
  'sl', 'slu', 'sal', 'sau', 'sa', 'sas', 'sasu', 'sarl', 'eurl', 'sci',
  'ltda', 'eireli', 'bv', 'nv', 'vof', 'cv', 'spzoo', 'zoo', 'aps', 'oy', 'oyj', 'ab',
  'gruppo', 'grupo', 'groupe',
]);

/**
 * 泛词公司名 token（M5 第四轮 + Batch 1.8A 欧陆/光伏补全）：作为公司名出现时不具备区分度的业务通用词。
 * 泛词**单独命中不算公司佐证**——有区分度的 token 照常放行；公司名本身是泛词时须升级为完整域名或多词全名短语。
 * 折叠形（小写、ß→ss、去变音、ae/oe/ue 收敛）。
 */
export const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  // 英语
  'technical', 'technics', 'technology', 'technologies', 'tech',
  'industry', 'industries', 'industrial',
  'system', 'systems', 'solution', 'solutions',
  'consult', 'consulting', 'consultancy', 'consultant', 'consultants',
  'engineering', 'engineer', 'engineers',
  'service', 'services', 'partner', 'partners',
  'global', 'digital', 'media', 'software', 'business', 'management',
  'agency', 'agencies', 'sales', 'marketing', 'development',
  'innovation', 'innovations', 'integration', 'automation',
  'logistics', 'energy', 'construction', 'manufacturing', 'production', 'operations',
  'solar', 'point', 'stock', 'market', 'power', 'green', 'renewable', 'italy',
  // 德语（折叠后）
  'technik', 'industrie', 'systeme', 'losung', 'losungen', 'beratung',
  'unternehmensberatung', 'dienstleistung', 'dienstleistungen',
  'produktion', 'fertigung', 'konstruktion', 'entwicklung', 'planung', 'vertrieb', 'energie',
  // 意大利语 / 欧陆光伏泛词（折叠后）
  'energia', 'solare', 'fotovoltaico', 'fotovoltaici', 'impianti', 'italia',
  'rinnovabili', 'sistemi', 'soluzioni', 'solaire',
]);

/**
 * 多语种职位/职能词表（DE / EN / IT / ES / FR / PT / NL）：社媒标题里公司名之外的**专业佐证**。
 * 折叠后比对（小写、ß→ss、去变音、德语转写 ae/oe/ue→a/o/u）；≥6 字符按词内子串匹配，≤5 字符只认整 token。
 */
export const ROLE_WORDS: readonly string[] = [
  // 德语
  'geschäftsführer', 'geschäftsführerin', 'geschäftsführung', 'geschäftsleitung', 'geschäftsleiter',
  'vorstand', 'vorständin', 'vorstandsvorsitzender', 'leiter', 'leiterin', 'leitung', 'teamleiter',
  'teamleitung', 'abteilungsleiter', 'bereichsleiter', 'gruppenleiter', 'projektleiter', 'projektleitung',
  'produktleiter', 'produktmanagement', 'produktmanager', 'betriebsleiter', 'werkleiter', 'bauleiter',
  'einkaufsleiter', 'einkauf', 'einkäufer', 'beschaffung', 'beschaffungsleiter', 'vertrieb',
  'vertriebsleiter', 'vertriebsingenieur', 'verkauf', 'verkäufer', 'marketing', 'marketingleiter',
  'personalleiter', 'personalreferent', 'personalwesen', 'personalabteilung', 'prokurist', 'inhaber',
  'gesellschafter', 'gründer', 'mitgründer', 'berater', 'beraterin', 'spezialist', 'spezialistin',
  'experte', 'expertin', 'sachbearbeiter', 'sachbearbeiterin', 'fachkraft', 'meister', 'techniker',
  'technikerin', 'technik', 'ingenieur', 'ingenieurin', 'konstrukteur', 'entwicklung', 'entwickler',
  'entwicklerin', 'softwareentwickler', 'anwendungsentwickler', 'kaufmann', 'kauffrau', 'assistent',
  'assistentin', 'assistenz', 'sekretariat', 'referent', 'referentin', 'koordinator', 'koordinatorin',
  'buchhaltung', 'finanzen', 'controlling', 'controller', 'logistik', 'logistikleiter', 'produktion',
  'produktionsleiter', 'fertigung', 'montage', 'monteur', 'servicetechniker', 'kundenbetreuung',
  'kundenberater', 'recruiting', 'ausbilder', 'trainee', 'werkstudent', 'praktikant',
  'mitarbeiter', 'mitarbeiterin', 'angestellte', 'angestellter',
  // 英语
  'manager', 'management', 'director', 'managing', 'head', 'lead', 'leader', 'leadership', 'chief',
  'officer', 'executive', 'president', 'founder', 'owner', 'partner', 'principal', 'consultant',
  'consulting', 'specialist', 'expert', 'coordinator', 'administrator', 'assistant', 'associate',
  'analyst', 'architect', 'designer', 'developer', 'engineer', 'engineering', 'technician',
  'supervisor', 'foreman', 'representative', 'agent', 'advisor', 'adviser', 'strategist', 'planner',
  'buyer', 'purchasing', 'procurement', 'sourcing', 'supply', 'logistics', 'operations', 'finance', 'financial',
  'accounting', 'accountant', 'auditor', 'legal', 'counsel', 'lawyer', 'attorney', 'sales',
  'marketing', 'business', 'development', 'research', 'researcher', 'scientist', 'quality', 'product',
  'program', 'project', 'account', 'customer', 'revenue', 'growth', 'strategy', 'technical',
  'service', 'support', 'teamlead',
  // 意大利语
  'amministratore', 'delegato', 'titolare', 'fondatore', 'cofondatore', 'socio', 'presidente',
  'direttore', 'dirigente', 'responsabile', 'acquisti', 'approvvigionamento', 'commerciale', 'vendite',
  'tecnico', 'tecnica', 'ingegnere', 'ingegneria', 'progettista', 'progettazione', 'operativo',
  'operazioni', 'logistica', 'produzione', 'qualita', 'qualità', 'sviluppo', 'ufficio', 'consulente',
  'specialista', 'coordinatore', 'assistente',
  // 西班牙语
  'administrador', 'apoderado', 'gerente', 'directora', 'fundador', 'cofundador', 'responsable',
  'compras', 'aprovisionamiento', 'comercial', 'ventas', 'ingeniero', 'ingeniera', 'ingenieria',
  'ingeniería', 'operaciones', 'produccion', 'producción', 'calidad', 'desarrollo', 'consultor',
  'especialista', 'coordinador', 'asistente', 'jefe', 'jefa',
  // 法语
  'gerant', 'gérant', 'gerante', 'gérante', 'fondateur', 'cofondateur', 'associe', 'associé',
  'directeur', 'directrice', 'achats', 'acheteur', 'acheteuse', 'approvisionnement', 'commercial',
  'ventes', 'technique', 'ingenierie', 'ingénierie', 'exploitation', 'logistique', 'qualite',
  'qualité', 'developpement', 'développement', 'specialiste', 'spécialiste', 'coordinateur',
  'assistante', 'cadre',
  // 葡萄牙语
  'diretor', 'diretora', 'responsavel', 'responsável', 'suprimentos', 'comprador', 'compradora',
  'vendas', 'engenheiro', 'engenheira', 'engenharia', 'operacoes', 'operações', 'producao',
  'produção', 'qualidade', 'desenvolvimento', 'coordenador', 'coordenadora',
  // 荷兰语
  'eigenaar', 'oprichter', 'medeoprichter', 'bestuurder', 'vennoot', 'inkoop', 'inkoper',
  'inkoopmanager', 'commercieel', 'verkoop', 'technisch', 'operatie', 'logistiek', 'productie',
  'kwaliteit', 'ontwikkeling', 'adviseur',
];

/** 极短 C-level/高管缩写：只认整 token（避开易误撞的 `ad`）。 */
export const SHORT_ROLE_WORDS: ReadonlySet<string> = new Set([
  'ceo', 'cfo', 'cto', 'coo', 'cio', 'cmo', 'cpo', 'cro', 'vp', 'svp', 'evp', 'pdg', 'dg',
]);

/** 职位词比对折叠：小写、ß→ss、去组合变音、德语转写收敛（ae/oe/ue→a/o/u）、标点→空格。 */
export function foldRoleText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const ROLE_KEYS: readonly string[] = [...new Set(ROLE_WORDS.map(foldRoleText).filter(Boolean))];
// ≥6 字符按词内子串匹配（德语复合词 "Einkaufsleiterin" ⊃ einkauf/leiter）；≤5 字符只认整 token——
// "headquarters" ⊃ head、"Agentur" ⊃ agent 这类普通词命中会让垃圾档案原路漏回。
export const ROLE_SUBSTRING_KEYS: readonly string[] = ROLE_KEYS.filter((key) => key.length >= 6);
export const ROLE_EXACT_KEYS: ReadonlySet<string> = new Set(ROLE_KEYS.filter((key) => key.length < 6));

/** 公司名的可比 token（≥3 字符、去法律形式）：raw 供包含匹配，folded 供泛词分类。 */
export function companyNameTokens(company: { name: string }): { raw: string; folded: string }[] {
  return company.name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !LEGAL_FORM_TOKENS.has(token))
    .map((token) => ({ raw: token, folded: foldRoleText(token) }));
}

export type CompanyMatchLevel = 'distinctive' | 'generic' | 'none';

/** 公司佐证强度：命中的是有区分度的公司名 token / 域名词根（distinctive），还是只有泛词（generic），还是没有（none）。 */
export function companyMatchLevel(
  text: string,
  company: { name: string; domain?: string },
): CompanyMatchLevel {
  const haystack = text.toLowerCase();
  let generic = false;
  for (const token of companyNameTokens(company)) {
    if (!haystack.includes(token.raw)) continue;
    if (!GENERIC_NAME_TOKENS.has(token.folded)) return 'distinctive';
    generic = true;
  }
  const root = company.domain?.toLowerCase().split('.')[0];
  if (root && root.length >= 3 && haystack.includes(root)) {
    if (!GENERIC_NAME_TOKENS.has(foldRoleText(root))) return 'distinctive';
    generic = true;
  }
  return generic ? 'generic' : 'none';
}

/** 任何公司名 token / 域名词根出现即算命中（L2 富化门：只为已过 L3 证据门的候选补数据）。 */
export function matchesCompany(text: string, company: { name: string; domain?: string }): boolean {
  return companyMatchLevel(text, company) !== 'none';
}

function isDomainBoundaryChar(ch: string | undefined): boolean {
  if (!ch) return true;
  const code = ch.charCodeAt(0);
  const isLowerAlpha = code >= 97 && code <= 122;
  const isDigit = code >= 48 && code <= 57;
  return !isLowerAlpha && !isDigit && ch !== '-';
}

/** 公司域名整体出现（纯字符边界匹配，零动态 RegExp：允许 www./路径前缀，拒绝 technical.design 这类同前缀 TLD）。 */
export function textMentionsDomain(text: string, domain: string | undefined): boolean {
  const needle = domain?.toLowerCase().replace(/^www\./, '');
  if (!needle) return false;
  const haystack = text.toLowerCase();
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    const before = pos > 0 ? haystack[pos - 1] : undefined;
    const after = haystack[pos + needle.length];
    if (isDomainBoundaryChar(before) && isDomainBoundaryChar(after)) {
      return true;
    }
    pos = haystack.indexOf(needle, pos + 1);
  }
  return false;
}

/** 多词公司名的完整短语（折叠后按 token 边界连续出现）：比单个泛词更有区分度。 */
export function textContainsCompanyPhrase(text: string, company: { name: string }): boolean {
  const tokens = companyNameTokens(company)
    .map((token) => token.folded)
    .filter(Boolean);
  if (tokens.length < 2) return false;
  return ` ${foldRoleText(text)} `.includes(` ${tokens.join(' ')} `);
}

/** 泛词命中时的升级佐证：完整域名出现，或多词公司名以完整短语出现。 */
export function hasDistinctiveCompanyEvidence(
  text: string,
  company: { name: string; domain?: string },
): boolean {
  return textMentionsDomain(text, company.domain) || textContainsCompanyPhrase(text, company);
}

/** 公司名的匹配 token（与 matchesCompany 同源：≥3 字符、去法律形式）+ 域名词根分词，折叠形。 */
export function companyRoleMatchTokens(company: { name: string; domain?: string }): Set<string> {
  const tokens = new Set<string>();
  for (const raw of company.name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 3 && !LEGAL_FORM_TOKENS.has(raw)) tokens.add(foldRoleText(raw));
  }
  const root = company.domain?.toLowerCase().split('.')[0];
  if (root && root.length >= 3) {
    for (const part of foldRoleText(root).split(' ').filter(Boolean)) tokens.add(part);
  }
  return tokens;
}

/** headline 里是否除人名与公司名之外仍有职位/职能词（多语种专业佐证）。 */
export function hasRoleEvidence(
  headline: string,
  personName: string,
  company: { name: string; domain?: string },
): boolean {
  const drop = new Set<string>([...foldRoleText(personName).split(' '), ...companyRoleMatchTokens(company)]);
  drop.delete('');
  const residual = foldRoleText(headline)
    .split(' ')
    .filter((token) => token && !drop.has(token));
  return residual.some(
    (token) =>
      SHORT_ROLE_WORDS.has(token) ||
      ROLE_EXACT_KEYS.has(token) ||
      ROLE_SUBSTRING_KEYS.some((key) => token.includes(key)),
  );
}
