/**
 * ELF（Entity Legal Form，ISO 20275）代码 → 可读法人形式。
 * GLEIF 记录只返回 4 位 ELF 码；全表约 2900 条且按辖区细分，这里仅收录目标市场
 * 最常见的**已核验**子集，未命中回退原始码（码本身仍可溯源到 GLEIF ELF 列表）。
 * 标 (API) 者为本项目实测 GLEIF 响应直接确认。
 */
export const ELF_LABELS: Record<string, string> = {
  // ── 德国 ──
  '2HBR': 'GmbH (Gesellschaft mit beschränkter Haftung)', // (API) Brandt & Trumpf GmbH
  '6QQB': 'AG (Aktiengesellschaft)', // (API) Bayerische Motoren Werke AG
  FR3V: 'GbR (Gesellschaft bürgerlichen Rechts)', // (API) Trumpf Vermögensverwaltung GbR
  '8Z6G': 'GmbH & Co. KG',
  V2YH: 'KG (Kommanditgesellschaft)',
  '9JF9': 'OHG (Offene Handelsgesellschaft)',
  '54M6': 'UG (haftungsbeschränkt)',
  XTIQ: 'e.K. (Eingetragener Kaufmann)',
  // ── 欧盟通用 ──
  SGST: 'SE (Societas Europaea)', // (API) TRUMPF Laser SE
  // ── 美国（常见，跨州）──
  '9JVU': 'Inc. (Incorporated)',
  L6UT: 'LLC (Limited Liability Company)',
  '54RM': 'LP (Limited Partnership)',
  '65KP': 'LLP (Limited Liability Partnership)',
  // ── 英国 ──
  '59XT': 'Ltd (Private Limited Company)',
  H8VP: 'PLC (Public Limited Company)',
  // ── 法国 ──
  '2P77': 'SA (Société Anonyme)',
  '7E9U': 'SAS (Société par Actions Simplifiée)',
  A9G8: 'SARL (Société à Responsabilité Limitée)',
  // ── 中国 ──
  K4CX: '有限责任公司 (Limited Liability Company)',
  MIE9: '股份有限公司 (Company Limited by Shares)',
};
