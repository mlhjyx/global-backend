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

/** 解析全名 → 部件（strip 称谓、识别贵族前缀、拆名/姓）。空/无效返回 null。 */
export function parseName(fullName: string): ParsedName | null {
  const tokens = fullName
    .replace(/[,;]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !isHonorific(t));
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

/** 取 ASCII 归一首选变体（德语标准 ä→ae）；空 → ''。 */
function primaryVariant(raw: string): string {
  return transliterateVariants(raw)[0] ?? '';
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
  const parsed = parseName(reorderSurnameComma(nfc));
  if (!parsed) return EMPTY_PERSON_NAME;
  const given = primaryVariant(parsed.given);
  const family = primaryVariant(parsed.surnameCore || parsed.surname);
  const normalizedFull = [parsed.given, ...parsed.middles, parsed.surname]
    .map(primaryVariant)
    .filter(Boolean)
    .join(' ');
  return { given, family, normalizedFull };
}

/** 归一全名（= parsePersonName().normalizedFull）——Tier 2 精确匹配 / keying 共用。 */
export function normalizePersonName(raw: string): string {
  return parsePersonName(raw).normalizedFull;
}

/**
 * 身份归一「纯去音标」变体（NFKD 兼容分解 + 去组合记号，**保 Unicode 字母/数字**）：与 {@link identityVariant}
 * 的**德语标准音译**（ä→ae）互补——此变体 ä→a（丢音标形）、é→e、ñ→n…，并 NFKC/NFKD 折叠兼容字（全角/连字）。
 * 二者并入 {@link personNameKeyVariants} 变体集，令「Müller / Mueller / Muller」等跨源拼写在 Art.17 禁联/对账上收敛。
 * 不改 {@link normalizePersonName}（declined 键 / resolver 模糊并仍用德语形，方向偏欠并）。
 */
function pureStripVariant(raw: string): string {
  const lower = (raw ?? '').toLowerCase().trim();
  if (!lower) return '';
  const stripped = lower.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return stripped.replace(/[^\p{L}\p{N}]+/gu, ''); // 保 Unicode 字母/数字（CJK/西里尔不删），仅去标点/空白/符号
}

/**
 * 归一人名的**多变体键集**（Art.17 禁联/对账用，方向偏 **over-suppress**——宁多误禁不漏禁）。对同一自然人产出
 * 德语标准音译（ä→ae）+ 纯去音标（ä→a）两归一全名，二者覆盖：**变音丢弃** / 德语 ASCII 拼写（Müller↔Mueller↔Muller，
 * 变音锚定时）/ **分解 Unicode**（NFC 先归）/ **"Surname, Given" 语序** / 称谓剥离。去重、稳定排序。空/纯称谓 → []
 *（调用方回退明文键，保留可区分性）。
 *
 * 🔴 与 {@link normalizePersonName}（**单值**·德语形，跨源同一人**合并**键 / resolver 模糊并用）刻意分离：合并方向偏
 * **欠并**（信息缺失时宁欠并不误并两人），禁联方向偏 **过禁**（宁误禁同名另一人也不漏禁被擦除人——over-suppress 于
 * Art.17 是安全侧；对账**删除**侧的同名误删另有 `deletion` 的 createdAt 有界窗口约束，不致无界数据丢失）。
 */
export function personNameKeyVariants(raw: string): string[] {
  const nfc = (raw ?? '').normalize('NFC').trim();
  if (!nfc) return [];
  const parsed = parseName(reorderSurnameComma(nfc), stripIdentityTitles);
  if (!parsed) return [];
  const assemble = (variant: (s: string) => string): string =>
    [parsed.given, ...parsed.middles, parsed.surname].map(variant).filter(Boolean).join(' ');
  const forms = new Set<string>();
  for (const variant of [identityVariant, pureStripVariant]) {
    const full = assemble(variant);
    if (full) forms.add(full);
  }
  return [...forms].sort();
}
