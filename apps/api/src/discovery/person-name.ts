/**
 * 人名归一共享纯件（选项 B · 待办 2）。
 *
 * 从 {@link ./email-permutation} 抽出**共享**人名解析（消 DRY）：去称谓（Dr./Prof./Herr/Frau）、
 * 贵族/介词前缀（von/van/de/der…）归入姓、"Surname, Given" 语序归位、NFC 归一、德语去音标双音译。
 *
 * 两类消费者：
 *  - `email-permutation`：`parseName` + `transliterateVariants`（邮箱候选生成，**行为逐字不变**，故原样搬迁 + re-export）。
 *  - `person-identity`：`normalizePersonName`（跨源同一人归并的键/匹配），`parsePersonName`（部件）。
 *
 * 纯函数、无副作用、可测。
 */

/** 解析后的姓名部件（音译前）——邮箱排列器沿用其形状。 */
export interface ParsedName {
  /** 名（去称谓后的第一个 token）。 */
  given: string;
  /** 姓（含贵族前缀 von/van/de 时为其后整体；见 surnameCore 备用）。 */
  surname: string;
  /** 姓去掉贵族前缀后的最后一段（如 "von der berg" → "berg"），无前缀时与 surname 相同。 */
  surnameCore: string;
  /** 中间名（多数命名法不用，保留供扩展）。 */
  middles: string[];
}

// 称谓/学位前后缀（去点/连字符后比对）——中小企业官网常见。
const HONORIFICS = new Set([
  'dr', 'prof', 'dipl', 'ing', 'mag', 'med', 'phd', 'mba', 'bsc', 'msc', 'ba', 'ma',
  'herr', 'frau', 'mr', 'mrs', 'ms', 'mx', 'hon', 'rer', 'nat', 'habil',
]);

// 身份归一：明确的**前置**称谓/学位（单 token 即可剥；总出现在名字最前）。从 HONORIFICS 排除
// ma/ba/ing/mag/med/hon/rer/nat——它们同时是真实姓氏/名（"Anna Ma"/"Ma Yun"），单独出现绝不剥（#54 P2）。
const IDENTITY_TITLE_PREFIX = new Set([
  'dr', 'prof', 'dipl', 'phd', 'mba', 'bsc', 'msc',
  'herr', 'frau', 'mr', 'mrs', 'ms', 'mx', 'habil',
]);
// 学术**后缀**：仅当**紧跟已剥的称谓**时才剥（"Dr. med."/"Dr. rer. nat."/"Dipl. Ing." 的空格分写形；#77 P2）——
// 独立出现（"Dr. Ma" 的 Ma、"Erik Ing" 的 Ing）绝不剥。🔴 ma/ba **不**入此集（常见真实姓氏，永不剥）。
const IDENTITY_TITLE_SUFFIX = new Set(['med', 'rer', 'nat', 'ing', 'mag', 'hon']);

// 贵族/介词前缀（归入姓；小写比对）。
const SURNAME_PARTICLES = new Set([
  'von', 'van', 'vom', 'zum', 'zur', 'zu', 'de', 'del', 'della', 'der', 'den', 'di',
  'da', 'dos', 'das', 'du', 'la', 'le', 'el', 'af', 'av', 'ter', 'ten', 'op',
]);

/** 去称谓 token（"dr." / "dipl.-ing." 均可）。 */
function isHonorific(token: string): boolean {
  const parts = token.toLowerCase().split(/[-.]/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => HONORIFICS.has(p));
}

/** 单 token 是否明确**前置**称谓（含多段学位串 "dipl.-ing."：拆 . / - 后各段皆全量 HONORIFICS 即算）。 */
function isIdentityTitlePrefix(token: string): boolean {
  const parts = token.toLowerCase().split(/[-.]/).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length > 1) return parts.every((p) => HONORIFICS.has(p));
  return IDENTITY_TITLE_PREFIX.has(parts[0]);
}

/** 单 token 是否学术**后缀**（med/rer/nat/ing…）——仅供"紧跟称谓才剥"的位置判定。 */
function isIdentityTitleSuffix(token: string): boolean {
  const parts = token.toLowerCase().split(/[-.]/).filter(Boolean);
  return parts.length === 1 && IDENTITY_TITLE_SUFFIX.has(parts[0]);
}

/**
 * 身份归一称谓剥离（**位置感知**，防误剥真实姓名 token）：从前往后剥明确前置称谓；紧跟已剥称谓的学术后缀
 * （"Dr. med. Anna"/"Dipl. Ing. Klaus"/"Dr. rer. nat."）也剥；**一旦遇到非称谓 token，其后全部保留**——
 * "Anna Ma" 的 Ma、"Ma Yun" 的 Ma、"Dr. Ma" 的 Ma（Ma 不在后缀集）都不剥（#54/#77 P2）。方向偏欠并。
 */
function stripIdentityTitles(tokens: string[]): string[] {
  const out: string[] = [];
  let prevStripped = false;
  for (const t of tokens) {
    if (isIdentityTitlePrefix(t) || (prevStripped && isIdentityTitleSuffix(t))) {
      prevStripped = true;
      continue;
    }
    out.push(t);
    prevStripped = false;
  }
  return out;
}

/**
 * 音译成小写 ASCII 变体集合（去重、保序）。返回**多个**变体：
 *  - 德语标准：ä→ae ö→oe ü→ue ß→ss
 *  - 去音标：é→e ñ→n ç→c … + ä→a ö→o ü→u（NFD 去组合记号）
 * 两种都常见于真实公司邮箱，故都作为候选。
 */
export function transliterateVariants(raw: string): string[] {
  const lower = raw.toLowerCase().trim();
  if (!lower) return [];
  const stripMarks = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // 变体 1：德语标准替换（ä→ae…）后仍 NFD 去残留音标（é→e），避免未覆盖重音被 clean 直接删成错串
  const german = stripMarks(
    lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'),
  );
  // 变体 2：纯去组合音标（ö→o；ß NFD 不拆，先 ß→ss）
  const stripped = stripMarks(lower.replace(/ß/g, 'ss'));
  const clean = (s: string): string => s.replace(/[^a-z0-9]/g, '');
  const out: string[] = [];
  for (const v of [german, stripped]) {
    const c = clean(v);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** email 侧默认称谓剥离：逐 token 剥全量 {@link HONORIFICS}（行为逐字不变）。 */
function defaultStripHonorifics(tokens: string[]): string[] {
  return tokens.filter((t) => !isHonorific(t));
}

/**
 * 解析全名 → 部件（strip 称谓、识别贵族前缀、拆名/姓）。空/无效返回 null。
 * `stripHonorifics` 可注入（收 token 数组返 token 数组）：email 本地部用默认 {@link defaultStripHonorifics}
 * （逐 token 全量剥，行为逐字不变）；身份路径用位置感知的 {@link stripIdentityTitles}（不误剥真实姓名 token，#54/#77 P2）。
 */
export function parseName(
  fullName: string,
  stripHonorifics: (tokens: string[]) => string[] = defaultStripHonorifics,
): ParsedName | null {
  const tokens = stripHonorifics(
    fullName
      .replace(/[,;]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean),
  );
  if (tokens.length === 0) return null;
  if (tokens.length === 1) {
    // 只有一个 token：当作 given，姓留空（只能出 first/first-only 模式）
    return { given: tokens[0], surname: '', surnameCore: '', middles: [] };
  }
  const given = tokens[0];
  // 找第一个贵族前缀作为姓的起点；没有则姓=最后一个 token
  let surnameStart = tokens.length - 1;
  for (let i = 1; i < tokens.length; i += 1) {
    if (SURNAME_PARTICLES.has(tokens[i].toLowerCase())) {
      surnameStart = i;
      break;
    }
  }
  const surnameTokens = tokens.slice(surnameStart);
  const middles = tokens.slice(1, surnameStart);
  const surname = surnameTokens.join(' ');
  // core = 去掉前缀后的最后一段（"von der berg" → "berg"）
  const nonParticle = surnameTokens.filter((t) => !SURNAME_PARTICLES.has(t.toLowerCase()));
  const surnameCore = (nonParticle[nonParticle.length - 1] ?? surname).trim();
  return { given, surname, surnameCore, middles };
}

// ── 跨源身份归一（新，供 person-identity 复用）──────────────────────────────

/** 归一后的人名部件（音译后，用于跨源同一人归并）。 */
export interface ParsedPersonName {
  given: string;
  family: string;
  /** 归一全名（去称谓 + 语序归位 + NFC + 德语去音标）；keying/匹配共用。 */
  normalizedFull: string;
}

/**
 * 身份归一单变体（**保留** Unicode 字母/数字）：小写 + 德语标准音译（ä→ae ö→oe ü→ue ß→ss）+ 去组合音标，
 * 但不像 email 本地部那样 ASCII-only 删空——否则 "张 Wei"/"李 Wei" 都塌成 "wei" 令不同人误并（#54 P2）。
 * 仅供身份路径（{@link parsePersonName}）；email 本地部仍用 {@link transliterateVariants}（ASCII-only）。
 */
function identityVariant(raw: string): string {
  const lower = (raw ?? '').toLowerCase().trim();
  if (!lower) return '';
  const stripMarks = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const german = stripMarks(lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'));
  return german.replace(/[^\p{L}\p{N}]+/gu, ''); // 保 Unicode 字母/数字，仅去标点/空白/符号
}

/**
 * "Family, Given" 语序归位：仅当逗号左右都有内容时翻转为 "Given Family"。
 * 只处理首个逗号（"Schmidt, Johann, Dr." → "Johann, Dr. Schmidt"，剩余逗号交 parseName 当分隔）。
 */
function reorderSurnameComma(raw: string): string {
  const idx = raw.indexOf(',');
  if (idx <= 0) return raw;
  const before = raw.slice(0, idx).trim();
  const after = raw.slice(idx + 1).trim();
  if (!before || !after) return raw;
  return `${after} ${before}`;
}

const EMPTY_PERSON_NAME: ParsedPersonName = { given: '', family: '', normalizedFull: '' };

/**
 * 解析 + 归一人名（跨源同一人归并用）。NFC → 语序归位 → 去称谓/前缀 → 德语标准音译。
 * `normalizedFull` 保留全部部件（含中间名、贵族前缀压平），**方向偏欠并**（宁多留区分信息不误并）。
 */
export function parsePersonName(raw: string): ParsedPersonName {
  const nfc = (raw ?? '').normalize('NFC').trim();
  if (!nfc) return EMPTY_PERSON_NAME;
  // 身份路径用位置感知称谓剥离（不误剥 Ma/Ba/Ing…，但剥 "Dr. med." 空格后缀）+ 保 Unicode 变体（不删 CJK/西里尔）。
  const parsed = parseName(reorderSurnameComma(nfc), stripIdentityTitles);
  if (!parsed) return EMPTY_PERSON_NAME;
  const given = identityVariant(parsed.given);
  const family = identityVariant(parsed.surnameCore || parsed.surname);
  const normalizedFull = [parsed.given, ...parsed.middles, parsed.surname]
    .map(identityVariant)
    .filter(Boolean)
    .join(' ');
  return { given, family, normalizedFull };
}

/** 归一全名（= parsePersonName().normalizedFull）——Tier 2 精确匹配 / keying 共用。 */
export function normalizePersonName(raw: string): string {
  return parsePersonName(raw).normalizedFull;
}
