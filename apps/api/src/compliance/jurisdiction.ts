import { Jurisdiction } from './data-rights.types';

/**
 * 数据主体法域归一（收口⑥）：把国别（alpha-2 / ISO alpha-3 / 常见英文国名）映射到有限法域集。
 * 纯函数、无副作用。未知/缺失 → OTHER（保守，触发更严判定路径）。
 *
 * 为何也收 alpha-3 / 国名（Codex P1 on PR #72）：`canonical_company.country` 来源多样，部分源存
 * ISO-3（`CHN`/`DEU`）或国名（`China`/`Germany`）。若只认 alpha-2，这些会静默落 OTHER →
 * 漏判 CN 主体（STORE=ALLOW_WITH_BASIS）与 EU/UK 主体×CN 处理地（跨境=REQUIRE_APPROVAL）。
 * 故先把 alpha-3 / 国名归一到 alpha-2 再走原判定。只覆盖**影响判定的法域**（GB/US/CN + EU/EEA）；
 * 其余国别归一后仍落 OTHER（与既有语义一致）。
 */

/** 欧盟 27 成员国 alpha-2（GDPR 适用域；EEA 的 IS/LI/NO 也按 EU 处理，隐私体系一致）。 */
const EU_ALPHA2 = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EEA（GDPR 经 EEA 协议适用）
  'IS', 'LI', 'NO',
]);

/** ISO alpha-3 → alpha-2（仅影响判定的法域：GB/US/CN + EU/EEA；其余留给 OTHER）。 */
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  GBR: 'GB', USA: 'US', CHN: 'CN',
  AUT: 'AT', BEL: 'BE', BGR: 'BG', HRV: 'HR', CYP: 'CY', CZE: 'CZ', DNK: 'DK', EST: 'EE',
  FIN: 'FI', FRA: 'FR', DEU: 'DE', GRC: 'GR', HUN: 'HU', IRL: 'IE', ITA: 'IT', LVA: 'LV',
  LTU: 'LT', LUX: 'LU', MLT: 'MT', NLD: 'NL', POL: 'PL', PRT: 'PT', ROU: 'RO', SVK: 'SK',
  SVN: 'SI', ESP: 'ES', SWE: 'SE', ISL: 'IS', LIE: 'LI', NOR: 'NO',
};

/** 常见英文国名（大写归一后） → alpha-2（仅影响判定的法域）。 */
const NAME_TO_ALPHA2: Record<string, string> = {
  'UNITED KINGDOM': 'GB', 'GREAT BRITAIN': 'GB', BRITAIN: 'GB', ENGLAND: 'GB',
  SCOTLAND: 'GB', WALES: 'GB', 'NORTHERN IRELAND': 'GB',
  'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', AMERICA: 'US',
  CHINA: 'CN', "PEOPLE'S REPUBLIC OF CHINA": 'CN', PRC: 'CN', '中国': 'CN',
  AUSTRIA: 'AT', BELGIUM: 'BE', BULGARIA: 'BG', CROATIA: 'HR', CYPRUS: 'CY',
  CZECHIA: 'CZ', 'CZECH REPUBLIC': 'CZ', DENMARK: 'DK', ESTONIA: 'EE', FINLAND: 'FI',
  FRANCE: 'FR', GERMANY: 'DE', GREECE: 'GR', HUNGARY: 'HU', IRELAND: 'IE', ITALY: 'IT',
  LATVIA: 'LV', LITHUANIA: 'LT', LUXEMBOURG: 'LU', MALTA: 'MT', NETHERLANDS: 'NL',
  POLAND: 'PL', PORTUGAL: 'PT', ROMANIA: 'RO', SLOVAKIA: 'SK', SLOVENIA: 'SI',
  SPAIN: 'ES', SWEDEN: 'SE', ICELAND: 'IS', LIECHTENSTEIN: 'LI', NORWAY: 'NO',
};

/**
 * 国别 → 法域。收 alpha-2 / alpha-3 / 常见英文国名（大小写无关）；GB/UK→UK、US→US、CN→CN、
 * EU/EEA→EU，其余（含未知 alpha-3/国名）→ OTHER。空/无效 → OTHER。
 */
export function normalizeJurisdiction(country?: string | null): Jurisdiction {
  const raw = (country ?? '').trim().toUpperCase();
  if (!raw) return 'OTHER';
  // 归一到 alpha-2：2 位直接用；否则试 alpha-3 / 国名映射；仍未知则原样进判定（落 OTHER）。
  const cc = raw.length === 2 ? raw : (ALPHA3_TO_ALPHA2[raw] ?? NAME_TO_ALPHA2[raw] ?? raw);
  if (cc === 'GB' || cc === 'UK') return 'UK';
  if (cc === 'US') return 'US';
  if (cc === 'CN') return 'CN';
  if (EU_ALPHA2.has(cc)) return 'EU';
  return 'OTHER';
}
