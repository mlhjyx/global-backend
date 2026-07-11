import { Jurisdiction } from './data-rights.types';

/**
 * 数据主体法域归一（收口⑥）：把 alpha-2 国别码映射到有限法域集。
 * 纯函数、无副作用。未知/缺失 → OTHER（保守，触发更严判定路径）。
 */

/** 欧盟 27 成员国 alpha-2（GDPR 适用域；EEA 的 IS/LI/NO 也按 EU 处理，隐私体系一致）。 */
const EU_ALPHA2 = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EEA（GDPR 经 EEA 协议适用）
  'IS', 'LI', 'NO',
]);

/**
 * alpha-2 → 法域。GB→UK；US→US；CN→CN；EU/EEA→EU；其余 OTHER。
 * 大小写无关；空/无效 → OTHER。
 */
export function normalizeJurisdiction(alpha2?: string | null): Jurisdiction {
  const cc = (alpha2 ?? '').trim().toUpperCase();
  if (!cc) return 'OTHER';
  if (cc === 'GB' || cc === 'UK') return 'UK';
  if (cc === 'US') return 'US';
  if (cc === 'CN') return 'CN';
  if (EU_ALPHA2.has(cc)) return 'EU';
  return 'OTHER';
}
