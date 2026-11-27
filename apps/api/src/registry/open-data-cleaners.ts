/**
 * 官方开放企业注册数据清洗与隐私护栏（UK Companies House / AU ABR ABN / BR RFB CNPJ）。
 *
 * 硬底线（全部为纯函数，无 IO / 无 DB，供流式预处理 CLI 与单测共用）：
 *  - 只输出纯公司事实（注册号、企业名、法律形式、在营状态、行业码、城市/州/邮编级注册地）；
 *  - 严禁自然人姓名、个人住址（门牌街道）、个人邮箱或电话进入输出；
 *  - 澳洲严格跳过 `<LegalEntity>` / `IND`（个体户）及易含自然人姓名的家庭信托/养老金；
 *  - 巴西严格跳过 MEI（Simples `opcao_mei=S`）与个体工商户（Natureza `2135`）/非企业形态，
 *    且从不读取 `Socios*.zip` 自然人合伙人表；
 *  - 英国/澳洲/巴西均校验官方注册号格式与校验位（AU ABN mod-89、BR CNPJ 14 位双校验码）。
 */
import {
  BR_SOLAR_ELECTRICAL_CNAE_CODES,
  UK_SOLAR_ELECTRICAL_SIC_CODES,
  extractUkSicCode,
  mapBrCnaeToNace,
  mapUkSicToNace,
  normalizeBrCnae,
} from './industry-map';

const UK_SOLAR_SIC_SET = new Set(UK_SOLAR_ELECTRICAL_SIC_CODES);
const BR_SOLAR_CNAE_SET = new Set(BR_SOLAR_ELECTRICAL_CNAE_CODES);

/** 澳洲允许入库的商业法人企业类型（严格排除 IND 个体户、OIE 社团协会、SMF 养老金及家庭信托）。 */
export const AU_CORPORATE_ENTITY_TYPES = new Set(['PRV', 'PUB', 'COP', 'LPT']);

/** 巴西允许入库的法人企业 Natureza Jurídica（严格排除 2135 个体户、1xxx 政府、3xxx 社团、4xxx 个人）。 */
export const BR_CORPORATE_NATUREZAS: Readonly<Record<string, string>> = Object.freeze({
  '2011': 'ep',
  '2038': 'sem',
  '2046': 'sa',
  '2054': 'sa',
  '2062': 'ltda',
  '2070': 'snc',
  '2089': 'scs',
  '2097': 'sca',
  '2127': 'scp',
  '2143': 'coop',
  '2151': 'consorcio',
  '2178': 'foreign',
  '2240': 'ltda',
  '2305': 'eireli',
  '2348': 'inova',
});

const UK_CRN_PATTERN = /^(?:[A-Z]{2}\d{6}|\d{8}|[A-Z]\d{7})$/u;
const AU_ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;
const BR_CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const;
const BR_CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const;

/** 规范化英国 CRN（6–7 位纯数字补前导 0 至 8 位；字母前缀大写去空格）。 */
export function normalizeUkCrn(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/gu, '');
  if (/^\d{1,8}$/u.test(cleaned)) return cleaned.padStart(8, '0');
  return cleaned;
}

/** 校验英国 Companies House CRN 格式（8 位数字或 2 位前缀 + 6 位数字等）。 */
export function isValidUkCrn(raw: string): boolean {
  return UK_CRN_PATTERN.test(normalizeUkCrn(raw));
}

/** 校验澳洲 11 位 ABN 官方 ATO mod-89 校验位。 */
export function isValidAuAbn(raw: string): boolean {
  const digits = raw.replace(/\s+/gu, '');
  if (!/^\d{11}$/u.test(digits)) return false;
  let sum = (Number(digits[0]) - 1) * AU_ABN_WEIGHTS[0];
  for (let i = 1; i < 11; i++) {
    sum += Number(digits[i]) * AU_ABN_WEIGHTS[i]!;
  }
  return sum % 89 === 0;
}

/** 校验巴西 14 位 CNPJ 官方 Receita Federal 双 mod-11 校验位。 */
export function isValidBrCnpj(raw: string): boolean {
  const digits = raw.replace(/[^0-9]/gu, '');
  if (!/^\d{14}$/u.test(digits)) return false;
  if (/^(\d)\1{13}$/u.test(digits)) return false;
  const checkDigit = (weights: readonly number[]): number => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += Number(digits[i]) * weights[i]!;
    }
    const rem = sum % 11;
    return rem < 2 ? 0 : 11 - rem;
  };
  return (
    checkDigit(BR_CNPJ_W1) === Number(digits[12]) &&
    checkDigit(BR_CNPJ_W2) === Number(digits[13])
  );
}

export function cleanCorporateText(raw: string | null | undefined, max = 500): string {
  if (!raw) return '';
  return raw.replace(/\p{Cc}+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// 1. 英国 Companies House（BasicCompanyData）流式清洗
// ---------------------------------------------------------------------------

export interface UkRawRow {
  companyNumber: string;
  companyName: string;
  companyStatus: string;
  companyCategory: string;
  postTown?: string;
  county?: string;
  postCode?: string;
  sicTexts: readonly string[];
}

export interface CleanedUkRow {
  CompanyNumber: string;
  CompanyName: string;
  CompanyStatus: string;
  CompanyCategory: string;
  PostTown: string;
  County: string;
  PostCode: string;
  MatchedSic: string;
  NaceCode: string;
}

export type CleanRowOutcome<T> =
  | { keep: true; row: T }
  | { keep: false; reason: string };

export function cleanUkCompaniesHouseRow(input: UkRawRow): CleanRowOutcome<CleanedUkRow> {
  const regNumber = normalizeUkCrn(input.companyNumber);
  if (!isValidUkCrn(regNumber)) return { keep: false, reason: 'invalid_reg_number' };

  const name = cleanCorporateText(input.companyName, 500);
  if (!name) return { keep: false, reason: 'missing_name' };

  const statusLower = input.companyStatus.trim().toLowerCase();
  if (statusLower === 'active - proposal to strike off') {
    return { keep: false, reason: 'strike_off_pending' };
  }
  if (statusLower !== 'active') return { keep: false, reason: 'inactive_status' };

  let matchedSic: string | null = null;
  let nace: string | null = null;
  for (const text of input.sicTexts) {
    const sic = extractUkSicCode(text);
    if (sic && UK_SOLAR_SIC_SET.has(sic)) {
      matchedSic = sic;
      nace = mapUkSicToNace(sic);
      break;
    }
  }
  if (!matchedSic || !nace) return { keep: false, reason: 'industry_unmatched' };

  return {
    keep: true,
    row: {
      CompanyNumber: regNumber,
      CompanyName: name,
      CompanyStatus: 'Active',
      CompanyCategory: cleanCorporateText(input.companyCategory, 80),
      PostTown: cleanCorporateText(input.postTown, 120),
      County: cleanCorporateText(input.county, 120),
      PostCode: cleanCorporateText(input.postCode, 24).toUpperCase(),
      MatchedSic: matchedSic,
      NaceCode: nace,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. 澳洲 ABR ABN Bulk Extract 流式清洗与光伏/电气关键词分类
// ---------------------------------------------------------------------------

const AU_EXCLUDE_NOISE =
  /\b(SOLARIUM|TANNING|NAILS?|BEAUTY|SALON|TINT(?:ING)?|WINDOW FILM|GLASS TINT|POOL HEATING|SOLARIS|GOLF|BOWLING|SPORTING|CHARITY|FOUNDATION|CHURCH|MINISTRIES|SCHOOL|KINDERGARTEN|SOCIAL CLUB)\b/iu;
const AU_AUTO_MARINE_NOISE =
  /\b(AUTO(?:MOTIVE)?\s+ELECTR\w*|CAR\s+(?:&|AND)\s+TRUCK\s+ELECTR\w*|VEHICLE\s+ELECTR\w*|MARINE\s+ELECTR\w*|DIESEL\s+ELECTR\w*|TRUCK\s+ELECTR\w*|MOBILE\s+AUTO\s+ELECTR\w*)\b/iu;
const AU_SOLAR_STRONG =
  /\b(SOLAR|PHOTOVOLTAIC|PV\s+(?:ENERGY|POWER|SOLUTIONS?|SYSTEMS?|SOLAR|INSTALL|TECH|GROUP|AUSTRALIA|AUST|HOLDINGS?)|SUNPOWER|SOLARPOWER|BATTERY STORAGE|ENERGY STORAGE|SOLAR INVERTER|MICROGRID)\b/iu;
const AU_WHOLESALE_SIGNAL =
  /\b(ELECTRICAL\s+(?:WHOLESAL\w*|DISTRIBUT\w*|SUPPL\w*|TRADING|IMPORT\w*)|SOLAR\s+(?:WHOLESAL\w*|DISTRIBUT\w*|SUPPL\w*|TRADING|IMPORT\w*)|SWITCHGEAR|TRANSFORMER\w*|INVERTER\w*)\b/iu;
const AU_INSTALL_SIGNAL =
  /\b(ELECTRICAL\s+(?:CONTRACT\w*|INSTALL\w*|SERVICE\w*|ENGINEER\w*|SOLUTION\w*|MAINTENANCE|GROUP|SYSTEM\w*|PTY)|ELECTROTECH\w*|POWER\s+(?:INSTALL\w*|CONTRACT\w*|ENGINEERING))\b/iu;
const AU_GEN_SIGNAL =
  /\b(SOLAR\s+(?:FARM|PARK|GENERATION|POWER|ENERGY|ASSET|PROJECT|HOLDING)|RENEWABLE\s+ENERGY|CLEAN\s+ENERGY|GREEN\s+ENERGY|POWER\s+GENERATION)\b/iu;
const AU_WHOLESALE_WORD = /\b(WHOLESAL\w*|DISTRIBUT\w*|SUPPL\w*|IMPORT\w*|TRADING)\b/iu;
const AU_INSTALL_WORD = /\b(INSTALL\w*|CONTRACT\w*|ELECTRIC\w*|ROOF\w*|SERVICE\w*)\b/iu;
const AU_ENERGY_RESCUE = /\b(PHOTOVOLTAIC|ELECTRICAL|ENERGY|POWER|INVERTER|BATTERY|RENEWABLE)\b/iu;

export interface AuClassification {
  nace: string;
  matchRule: string;
  matchedName: string;
}

/** 对澳洲企业法定名 + 注册商号执行光伏/电气 B2B 确定性分类（含汽车电路/美黑贴膜降噪）。 */
export function classifyAuCorporateNames(
  legalName: string,
  tradingNames: readonly string[],
): AuClassification | null {
  const candidates = [legalName, ...tradingNames]
    .map((entry) => cleanCorporateText(entry, 200))
    .filter((entry) => entry.length > 0);
  if (candidates.length === 0) return null;

  for (const name of candidates) {
    const result = classifySingleAuName(name);
    if (result) return { ...result, matchedName: name };
  }
  return null;
}

function classifySingleAuName(name: string): { nace: string; matchRule: string } | null {
  if (AU_EXCLUDE_NOISE.test(name) && !AU_ENERGY_RESCUE.test(name)) return null;
  if (AU_AUTO_MARINE_NOISE.test(name) && !AU_SOLAR_STRONG.test(name)) return null;

  const hasSolar = AU_SOLAR_STRONG.test(name);
  const hasWholesale = AU_WHOLESALE_SIGNAL.test(name);
  const hasInstall = AU_INSTALL_SIGNAL.test(name);
  const hasGen = AU_GEN_SIGNAL.test(name);
  if (!hasSolar && !hasWholesale && !hasInstall && !hasGen) return null;

  if (hasWholesale || (hasSolar && AU_WHOLESALE_WORD.test(name))) {
    return { nace: '46.69', matchRule: 'solar_elec_wholesale' };
  }
  if (hasInstall || (hasSolar && AU_INSTALL_WORD.test(name))) {
    return { nace: '43.21', matchRule: 'solar_elec_install' };
  }
  if (hasGen) return { nace: '35.11', matchRule: 'solar_power_gen' };
  return { nace: '27.90', matchRule: 'solar_pv_general' };
}

export interface AuRawRecord {
  abn: string;
  status: string;
  entityTypeInd: string;
  isIndividual: boolean;
  legalName: string;
  tradingNames: readonly string[];
  state?: string;
  postcode?: string;
  asicNumber?: string;
  gstStatus?: string;
}

export interface CleanedAuRow {
  Abn: string;
  LegalName: string;
  Status: string;
  EntityType: string;
  State: string;
  Postcode: string;
  NaceCode: string;
  Acn: string;
  GstStatus: string;
  MatchRule: string;
  MatchedTradingName: string;
}

export function cleanAuAbnRecord(input: AuRawRecord): CleanRowOutcome<CleanedAuRow> {
  const abn = input.abn.replace(/\s+/gu, '');
  if (!isValidAuAbn(abn)) return { keep: false, reason: 'invalid_abn' };
  if (input.status.trim().toUpperCase() !== 'ACT') return { keep: false, reason: 'inactive_status' };

  const entityType = input.entityTypeInd.trim().toUpperCase();
  if (input.isIndividual || entityType === 'IND') {
    return { keep: false, reason: 'skipped_individual' };
  }
  if (!AU_CORPORATE_ENTITY_TYPES.has(entityType)) {
    return { keep: false, reason: 'skipped_non_corporate_type' };
  }

  const legalName = cleanCorporateText(input.legalName, 500);
  if (!legalName) return { keep: false, reason: 'missing_name' };

  const classified = classifyAuCorporateNames(legalName, input.tradingNames);
  if (!classified) return { keep: false, reason: 'industry_unmatched' };

  const acnRaw = (input.asicNumber ?? '').replace(/\s+/gu, '');
  const acn = /^\d{9}$/u.test(acnRaw) ? acnRaw : '';
  const matchedTradingName =
    classified.matchedName.toUpperCase() === legalName.toUpperCase()
      ? ''
      : classified.matchedName.slice(0, 120);

  return {
    keep: true,
    row: {
      Abn: abn,
      LegalName: legalName,
      Status: 'ACT',
      EntityType: entityType,
      State: cleanCorporateText(input.state, 16).toUpperCase(),
      Postcode: cleanCorporateText(input.postcode, 16).toUpperCase(),
      NaceCode: classified.nace,
      Acn: acn,
      GstStatus: cleanCorporateText(input.gstStatus, 16).toUpperCase(),
      MatchRule: classified.matchRule,
      MatchedTradingName: matchedTradingName,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. 巴西 RFB CNPJ 开放数据流式清洗（严禁 MEI / 个体户 / 个人联系信息）
// ---------------------------------------------------------------------------

export interface BrRawRecord {
  cnpjBasico: string;
  cnpjOrdem: string;
  cnpjDv: string;
  matrizFilial: string;
  situacaoCadastral: string;
  cnaePrincipal: string;
  razaoSocial: string;
  nomeFantasia?: string;
  naturezaJuridica: string;
  porte?: string;
  isMei: boolean;
  municipio?: string;
  uf?: string;
  cep?: string;
}

export interface CleanedBrRow {
  Cnpj: string;
  RazaoSocial: string;
  SituacaoCadastral: string;
  NaturezaJuridica: string;
  CnaePrincipal: string;
  Municipio: string;
  Uf: string;
  Cep: string;
  Porte: string;
  NomeFantasia: string;
}

export function cleanBrCnpjRecord(input: BrRawRecord): CleanRowOutcome<CleanedBrRow> {
  if (input.matrizFilial.trim() !== '1') return { keep: false, reason: 'skipped_branch' };
  if (input.situacaoCadastral.trim() !== '02') return { keep: false, reason: 'inactive_status' };
  if (input.isMei) return { keep: false, reason: 'skipped_mei' };

  const nat = input.naturezaJuridica.trim();
  if (nat === '2135') return { keep: false, reason: 'skipped_individual_entrepreneur' };
  if (!(nat in BR_CORPORATE_NATUREZAS)) {
    return { keep: false, reason: 'skipped_non_corporate_natureza' };
  }

  const cnpj = `${input.cnpjBasico.trim().padStart(8, '0')}${input.cnpjOrdem.trim().padStart(4, '0')}${input.cnpjDv.trim().padStart(2, '0')}`;
  if (!isValidBrCnpj(cnpj)) return { keep: false, reason: 'invalid_cnpj' };

  const cnae = normalizeBrCnae(input.cnaePrincipal);
  if (!cnae || !BR_SOLAR_CNAE_SET.has(cnae) || !mapBrCnaeToNace(cnae)) {
    return { keep: false, reason: 'industry_unmatched' };
  }

  const name = cleanCorporateText(input.razaoSocial, 500);
  if (!name) return { keep: false, reason: 'missing_name' };

  const cepDigits = (input.cep ?? '').replace(/[^0-9]/gu, '');
  const cep = cepDigits.length === 8 ? cepDigits : '';

  return {
    keep: true,
    row: {
      Cnpj: cnpj,
      RazaoSocial: name,
      SituacaoCadastral: '02',
      NaturezaJuridica: nat,
      CnaePrincipal: cnae,
      Municipio: cleanCorporateText(input.municipio, 120),
      Uf: cleanCorporateText(input.uf, 8).toUpperCase(),
      Cep: cep,
      Porte: cleanCorporateText(input.porte, 8),
      NomeFantasia: cleanCorporateText(input.nomeFantasia, 120),
    },
  };
}
