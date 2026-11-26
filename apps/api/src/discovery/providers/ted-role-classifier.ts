/**
 * EU TED 中标公告实体角色分类器（Phase 3 Track 3B）。
 *
 * 反转「把所有 TED 中标方一律当供给侧同行排除」的旧假设，明确区分三类主体：
 * 1. `contracting_authority`：招标方（政府机关、市政公用事业、医院、高校）；
 * 2. `award_winner`：中标项目总包商 / EPC / 工程安装 / 系统集成商
 *    → 刚中标项目急需采购核心设备与配套组件，判定为高意向买家（`TENDER_AWARDED`），
 *      `buyerRole: 'epc_contractor' | 'system_integrator'`，`tedSelfRole: 'buyer'`；
 * 3. `peer_manufacturer`：核心组件同业制造商 / 设备供应同业 → 排除，保持 `tedSelfRole: 'winner'`。
 */

export type TedEntityClassification =
  | 'contracting_authority'
  | 'award_winner'
  | 'peer_manufacturer';

export type TedBuyerRole = 'epc_contractor' | 'system_integrator';

export interface TedRoleClassificationResult {
  readonly entityRole: TedEntityClassification;
  readonly buyerRole: TedBuyerRole | null;
  readonly isHighIntentBuyer: boolean;
  readonly excludeAsPeer: boolean;
  readonly signalType: 'TENDER_AWARDED' | null;
  /** 与 `raw_source_provider_payload_valid_v2` 契约完全兼容的二值角色（'buyer' | 'winner'）。 */
  readonly tedSelfRole: 'buyer' | 'winner';
  readonly confidence: number;
  readonly reason: string;
}

const CONTRACTING_AUTHORITY_RE =
  /\b(?:stadtwerke|city\s+of|ville\s+de|municipality|gemeinde|ministry|ministerium|authority|verwaltung|public\s+works|klinikum|hospital|universit(?:y|ät|é|à)|kommunal|département|regione|comune\s+di|ayuntamiento|prefecture|landkreis|bundesamt|magistrat|water\s+authority|wasserverband)\b/iu;

const SYSTEM_INTEGRATOR_NAME_RE =
  /\b(?:system\s*integration|systemintegration|systems?\s+integrator|integrator|intégration|anlagenbau|energietechnik|solartechnik|gebäudetechnik|elektrotechnik|haustechnik|automation|process\s+engineering|engineering|ingenieurbüro|impianti|instalaciones|installatie|installateur|solutions?\s+(?:gmbh|ag|sas|s\.?r\.?l|b\.?v|ltd))\b/iu;

const EPC_CONTRACTOR_NAME_RE =
  /\b(?:epc|solarbau|kraftwerksbau|windpark|projektbau|bauunternehmen|baugesellschaft|hoch-?\s*und\s*tiefbau|tiefbau|generalunternehmer|construction|contracting|contractor|turnkey|civil\s+works|infrastructure|infrastruktur|montage|chantier|costruzioni|obras|bouw|bau\s+(?:gmbh|ag|kg|se))\b/iu;

const PEER_MANUFACTURER_NAME_RE =
  /\b(?:manufactur(?:ing|er)|fabrik|manufaktur|werke?\s+(?:gmbh|ag)|pompes|pumps?|pumpen|valves?|ventile|compressors?|kompressoren|bearings?|lager|cell\s+manufacturing|module\s+manufacturing|wafer|foundry|gießerei)\b/iu;

/** CPV 45* 工程建设/施工/光伏屋顶/电厂工程；453* 建筑安装；51* 设备安装服务；713* 工程设计服务。 */
function isWorksOrIntegrationCpv(cpvCodes: readonly string[]): {
  hasConstructionCpv: boolean;
  hasIntegrationCpv: boolean;
} {
  let hasConstructionCpv = false;
  let hasIntegrationCpv = false;
  for (const raw of cpvCodes) {
    const code = raw.trim();
    if (code.startsWith('453') || code.startsWith('51') || code.startsWith('713')) {
      hasIntegrationCpv = true;
    } else if (code.startsWith('45')) {
      hasConstructionCpv = true;
    }
  }
  return { hasConstructionCpv, hasIntegrationCpv };
}

function matchesSellerPeerKeywords(
  name: string,
  sellerPeerKeywords?: readonly string[],
): string | null {
  if (!sellerPeerKeywords || sellerPeerKeywords.length === 0) return null;
  const lower = name.toLowerCase();
  for (const raw of sellerPeerKeywords) {
    const kw = raw.trim().toLowerCase();
    if (kw.length >= 3 && lower.includes(kw)) return raw.trim();
  }
  return null;
}

function classifyAwardWinnerByRoleSignals(
  name: string,
  cpvCodes: readonly string[],
): TedRoleClassificationResult {
  const isIntegratorByName = SYSTEM_INTEGRATOR_NAME_RE.test(name);
  const isEpcByName = EPC_CONTRACTOR_NAME_RE.test(name);
  const isPeerMfgByName = PEER_MANUFACTURER_NAME_RE.test(name);
  const { hasConstructionCpv, hasIntegrationCpv } = isWorksOrIntegrationCpv(cpvCodes);

  if (isPeerMfgByName && !isIntegratorByName && !isEpcByName) {
    return {
      entityRole: 'peer_manufacturer',
      buyerRole: null,
      isHighIntentBuyer: false,
      excludeAsPeer: true,
      signalType: null,
      tedSelfRole: 'winner',
      confidence: 0.88,
      reason: '核心设备/组件同业制造企业中标，按同行排除',
    };
  }

  if (isIntegratorByName || (hasIntegrationCpv && !isPeerMfgByName && !isEpcByName)) {
    return {
      entityRole: 'award_winner',
      buyerRole: 'system_integrator',
      isHighIntentBuyer: true,
      excludeAsPeer: false,
      signalType: 'TENDER_AWARDED',
      tedSelfRole: 'buyer',
      confidence: isIntegratorByName && hasIntegrationCpv ? 0.92 : 0.82,
      reason: '中标系统集成商/工程安装商，项目交付期存在核心设备采购需求',
    };
  }

  if (isEpcByName || (hasConstructionCpv && !isPeerMfgByName)) {
    return {
      entityRole: 'award_winner',
      buyerRole: 'epc_contractor',
      isHighIntentBuyer: true,
      excludeAsPeer: false,
      signalType: 'TENDER_AWARDED',
      tedSelfRole: 'buyer',
      confidence: isEpcByName && hasConstructionCpv ? 0.92 : 0.82,
      reason: '中标 EPC/工程总包商，刚中标项目急需采购核心设备与配套件',
    };
  }

  return {
    entityRole: 'peer_manufacturer',
    buyerRole: null,
    isHighIntentBuyer: false,
    excludeAsPeer: true,
    signalType: null,
    tedSelfRole: 'winner',
    confidence: 0.65,
    reason: '常规设备供货中标方（非 EPC/系统集成商），保守按同业供给侧处理',
  };
}

export function classifyTedEntity(input: {
  readonly name: string;
  readonly relationRole?: 'buyer' | 'winner';
  readonly cpvCodes?: readonly string[];
  readonly noticeType?: string;
  readonly sellerPeerKeywords?: readonly string[];
}): TedRoleClassificationResult {
  const name = (input.name ?? '').trim();
  const cpvCodes = input.cpvCodes ?? [];

  if (input.relationRole === 'buyer' || CONTRACTING_AUTHORITY_RE.test(name)) {
    return {
      entityRole: 'contracting_authority',
      buyerRole: null,
      isHighIntentBuyer: false,
      excludeAsPeer: false,
      signalType: null,
      tedSelfRole: 'buyer',
      confidence: input.relationRole === 'buyer' ? 0.95 : 0.85,
      reason: '公共招标方（政府/市政/公用事业机构）',
    };
  }

  const matchedPeerKw = matchesSellerPeerKeywords(name, input.sellerPeerKeywords);
  if (matchedPeerKw) {
    return {
      entityRole: 'peer_manufacturer',
      buyerRole: null,
      isHighIntentBuyer: false,
      excludeAsPeer: true,
      signalType: null,
      tedSelfRole: 'winner',
      confidence: 0.92,
      reason: `命中卖方同行排除关键词「${matchedPeerKw}」，按同业制造方排除`,
    };
  }

  return classifyAwardWinnerByRoleSignals(name, cpvCodes);
}

export function classifyTedAwardWinner(input: {
  readonly winnerName: string;
  readonly cpvCodes?: readonly string[];
  readonly noticeType?: string;
  readonly sellerPeerKeywords?: readonly string[];
}): TedRoleClassificationResult {
  return classifyTedEntity({
    name: input.winnerName,
    relationRole: 'winner',
    cpvCodes: input.cpvCodes,
    noticeType: input.noticeType,
    sellerPeerKeywords: input.sellerPeerKeywords,
  });
}

/**
 * 判断规范公司上的 `attributes.ted` 是否属于高意向中标总包商/系统集成商买家。
 * 供评分与信号投影读取，不破坏既有 PR-03b `raw_source_provider_payload_valid_v2` 约束。
 */
export function classifyStoredTedAwardBuyer(
  companyName: string,
  tedAttributes: unknown,
): TedRoleClassificationResult | null {
  if (!tedAttributes || typeof tedAttributes !== 'object' || Array.isArray(tedAttributes)) {
    return null;
  }
  const ted = tedAttributes as Record<string, unknown>;
  if (ted.self_role !== 'buyer') return null;
  const cpvCodes = Array.isArray(ted.cpv)
    ? ted.cpv.filter((c): c is string => typeof c === 'string')
    : [];
  const res = classifyTedAwardWinner({
    winnerName: companyName,
    cpvCodes,
    noticeType: typeof ted.notice_type === 'string' ? ted.notice_type : undefined,
  });
  return res.isHighIntentBuyer ? res : null;
}
