import { normalizeJurisdiction } from './jurisdiction';
import { DataRightsContext, JURISDICTIONS, Jurisdiction } from './data-rights.types';

/**
 * 把一条 Lead/公司映射成 STORE 动作的 DataRightsContext（收口⑥ 接线：LeadQualified 快照的
 * storage_rights_decision）。**纯函数**——不触 DB/时钟；规则匹配由 {@link DataRightsService.evaluate} 完成。
 *
 * 语义忠于字段名「storage_rights」= 我们是否有权**存储**这条线索的数据：
 * - dataClass：有具名决策人（personalData）→ red；纯公司事实 → green（引擎对 green 恒 ALLOW）。
 * - subjectJurisdiction：公司国别 alpha-2 归一（DE→EU / US→US / 缺失→OTHER，保守触发更严路径）。
 * - suppressed：公司 SUPPRESSED → 引擎最先判 DENY（禁联优先于一切）。
 * - lawfulBasis：快照时不断言租户级 basis（STORE 对 red EU/UK/US 恒 ALLOW，无需 basis；CN 主体才 ALLOW_WITH_BASIS）。
 */

/**
 * 处理地法域（配置：本实例数据处理所在地）。仅 EU/UK 主体 × CN 处理地这一条跨境规则用到它
 *（其余规则对 processor 通配）。**若本实例实际部署在中国而此项未设，EU/UK 决策人的跨境存储
 * 会被误判为 ALLOW 而非 REQUIRE_APPROVAL（GDPR Ch.V/PIPL 人审）——出海中企务必按真实处理地设置。**
 *
 * env DATA_PROCESSOR_JURISDICTION（值 ∈ JURISDICTIONS）。非法值 → 抛（fail-fast 防拼写）；
 * 生产未设 → 大声告警并缺省 EU（不 brick 应用，但运维可见）；dev 未设 → 静默缺省 EU。
 */
function resolveProcessorJurisdiction(raw?: string | null): Jurisdiction {
  const v = (raw ?? '').trim().toUpperCase();
  if (!v) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[compliance] DATA_PROCESSOR_JURISDICTION 未设 → 缺省 EU；跨境规则（EU/UK 主体→CN 处理地）不会触发。请按真实处理地设置。',
      );
    }
    return 'EU';
  }
  if (!(JURISDICTIONS as readonly string[]).includes(v)) {
    throw new Error(
      `DATA_PROCESSOR_JURISDICTION="${raw}" 非法；应为 ${JURISDICTIONS.join(' | ')} 之一`,
    );
  }
  return v as Jurisdiction;
}

export const PROCESSOR_JURISDICTION: Jurisdiction = resolveProcessorJurisdiction(
  process.env.DATA_PROCESSOR_JURISDICTION,
);

export interface StorageRightsLeadInput {
  /** 公司国别 alpha-2（数据主体法域来源）。 */
  country: string | null;
  /** canonical_company.status（SUPPRESSED → 禁联）。 */
  status: string;
  /** 快照是否携带具名决策人 ref（有 → red 个人数据；无 → green 纯公司事实）。 */
  hasNamedContacts: boolean;
}

/** Lead/公司 → STORE 动作的 DataRightsContext（processor 可注入，便于测试与多部署）。 */
export function storageRightsContextForLead(
  input: StorageRightsLeadInput,
  processorJurisdiction: Jurisdiction = PROCESSOR_JURISDICTION,
): DataRightsContext {
  return {
    action: 'STORE',
    dataClass: input.hasNamedContacts ? 'red' : 'green',
    subjectJurisdiction: normalizeJurisdiction(input.country),
    processorJurisdiction,
    lawfulBasis: null,
    suppressed: input.status === 'SUPPRESSED',
  };
}
