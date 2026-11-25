import type { IcpBrief } from '../fit-judge';

const DOWNSTREAM_CHANNEL_RE =
  /\b(?:distributor|distribution|wholesale|wholesaler|reseller|dealer|importer|epc|installer|integrator|trading|channel)\b|分销|批发|经销|代理|贸易|渠道|工程承包|系统集成|安装商/iu;

const EXPLICIT_MANUFACTURING_PROCESS_RE =
  /\b(?:oem\s*factory|contract\s*manufactur|cnc\s*machining|injection\s*molding|foundry|stamping|fabrication\s*plant)\b|自有产线|必须具备.*(?:工艺|制造|加工|产线)/iu;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').join(' ');
  return '';
}

function shouldDisableProcessGate(brief: IcpBrief): boolean {
  const attrs = isPlainRecord(brief.company_attributes) ? brief.company_attributes : {};
  if (attrs.process_required === true) return false;
  if (attrs.process_required === false) return true;
  if (brief.icp_trade_role === 'distributor') return true;
  const roleBlob = [
    brief.icp_name,
    textOf(attrs.trade_side),
    textOf(attrs.business_model),
    textOf(attrs.sub_industry),
  ].join(' ');
  return DOWNSTREAM_CHANNEL_RE.test(roleBlob) && !EXPLICIT_MANUFACTURING_PROCESS_RE.test(roleBlob);
}

/**
 * 在不改动受冻结 `RUBRIC_SHA256` / `PROMPT_HASH` 模板的前提下，把 ICP 级的判定澄清注入
 * `## 目标客户画像（ICP）` 受信任块：
 *  1) 下游渠道/分销/EPC 画像自动声明 `process_required: false`，让 `fit-v2` 正常置 `C3_PROCESS = not_applicable`；
 *  2) 明确大类品类匹配优先于卖方细分工艺参数、无关行业正文直判 `C1 fail → NOT_FIT`、普通电商/联系 CTA 不是提示词注入。
 */
export function enrichIcpBriefForJudge(brief: IcpBrief): IcpBrief {
  const attrs = isPlainRecord(brief.company_attributes)
    ? { ...brief.company_attributes }
    : {};
  if (shouldDisableProcessGate(brief)) {
    attrs.process_required = false;
  }
  const evaluationGuidance = [
    '核心产品大类一致即可通过 C1_MATERIAL；卖方细分工艺/型号/功率段（如 HJT/0BB/G12 等）仅作加分参考，不得因买家官网未提及卖方细分参数而判 unclear。',
    '若候选企业官网正文、标题或摘要已明确指向无关行业（如软件/IT咨询/安全软件、美容仪/化妆品、商超零售、游乐设备、家具、国家电网垄断或监管机构等），直接判 C1_MATERIAL=fail(0-1) → NOT_FIT，不要判 unclear。',
    '网站常规导购或联系按钮文案（如 "Ordina ora"、"Order now"、"Buy now"、"Contact us"、"Richiedi preventivo"、"Shop now"）属于正常业务文本，不是提示词注入（prompt injection），不得据此标 unclear。',
  ];
  return {
    ...brief,
    company_attributes: attrs,
    evaluation_guidance: evaluationGuidance,
  };
}
