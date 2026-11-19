/**
 * fit-v2 rubric 唯一真值（P3 J09；设计 §4.3.3.2–4.3.3.3）。
 *
 * 规则：
 * - 锚点文本只在本文件出现；prompt 由 `judge-prompt.ts` 从这里插值生成，
 *   禁止在 prompt 里手抄一份（防「prompt 与 rubric 不同步」）。
 * - `RUBRIC_SHA256` = canonical JSON 的 sha256，参与 prompt_hash；任何锚点/权重/
 *   枚举改动都会改变 hash → 测试会红 → 必须显式升 RUBRIC_VERSION 并重跑金标。
 * - 权重在「适用 criterion」上重新归一（聚合器 J10 负责），本文件只声明原始权重。
 * - 锚点档位按设计原文保留（C1/C2 为 10/9/7-8/5-6/3-4/1-2/0，C3–C5 为
 *   10/8-9/6-7/4-5/2-3/0），不得为了“整齐”合并档位。
 */

import { createHash } from 'node:crypto';
import {
  buyerProcurementCriteria,
  type BuyerProcurementScenario,
} from '../buyer-procurement-scenarios';

export const RUBRIC_VERSION = 'fit-v2' as const;

export const CRITERION_IDS = [
  'C1_MATERIAL',
  'C2_ROLE',
  'C3_PROCESS',
  'C4_BUSINESS_MODEL',
  'C5_SIZE',
] as const;
export type CriterionId = (typeof CRITERION_IDS)[number];

export const CRITERION_LABELS = [
  'pass',
  'weak',
  'fail',
  'unclear',
  'not_applicable',
] as const;
export type CriterionLabel = (typeof CRITERION_LABELS)[number];

/** 锚点档位的合法键集合（按设计原文的两种档位形状）。 */
export const ANCHOR_KEY_SET = [
  '10',
  '9',
  '8-9',
  '7-8',
  '6-7',
  '5-6',
  '4-5',
  '3-4',
  '2-3',
  '1-2',
  '0',
  'unclear',
] as const;

export interface CriterionDefinition {
  /** 档位 → 判定文本；键必须来自 ANCHOR_KEY_SET。 */
  readonly anchors: Readonly<Record<string, string | undefined>>;
  readonly applicableWhen: string;
  readonly evidenceRequired: readonly string[];
  readonly hardFailBelowOrEqual?: number;
  readonly id: CriterionId;
  readonly name: string;
  readonly weight: number;
}

export const RUBRIC_CRITERIA = Object.freeze([
  {
    id: 'C1_MATERIAL',
    name: '材质/品类匹配',
    weight: 0.25,
    applicableWhen: 'ICP 未声明 material_required=false 时适用',
    anchors: {
      '10': '候选官网明确列出与 ICP 完全同类的材质/产品（含品类词与工艺词双命中）。',
      '9': '品类明确一致，仅边缘工艺未展示。',
      '7-8': '品类高度一致，存在 1 个次要不确定点（如产品词宽泛）。',
      '5-6': '品类相邻（可加工同类材质但主业不同），需人判。',
      '3-4': '品类沾边但主要产品明显不同。',
      '1-2': '品类不符（如 ICP 要金属，候选做塑料/织物/粉体）。',
      '0': '完全无关品类或纯服务/门户。',
      unclear: '没有任何可用证据，或证据互相矛盾无法裁决。',
    },
    evidenceRequired: [
      'website_profile.products 引文',
      '官网/Impressum 产品页引文',
      '注册库行业码',
    ],
  },
  {
    id: 'C2_ROLE',
    name: '贸易角色',
    weight: 0.3,
    applicableWhen: '始终适用',
    anchors: {
      '10': '明确的下游买家——分销/批发/进口/经销，且在售第三方品牌（尤其含目标来源国品牌）。',
      '9': '明确下游买家，转售证据略弱（如批发业务描述但未列品牌）。',
      '7-8': '强倾向下游买家（采购/转售措辞、产品线含外购品），但无直接转售证据。',
      '5-6': '角色模糊（既做加工又做贸易；或集团内混合业务）。',
      '3-4': '强倾向制造商/服务商，买方角色弱。',
      '1-2': '基本可判为同类产品制造商（竞品），但证据不完整。',
      '0': '明确竞品（自有产线生产 ICP 同类产品并自销）。',
      unclear: '无法从证据判断角色。',
    },
    hardFailBelowOrEqual: 2,
    evidenceRequired: [
      'website_profile.trade_role/carried_brands/own_manufacturing',
      'Impressum 业务描述',
      '官网在售品牌页',
    ],
  },
  {
    id: 'C3_PROCESS',
    name: '工艺子集',
    weight: 0.2,
    applicableWhen: 'ICP 未声明 process_required=false 时适用',
    anchors: {
      '10': '官网/产品页明确展示 ICP 核心工艺（如激光切割+折弯+焊接全套）。',
      '8-9': '核心工艺明确，缺 1 项次要工艺。',
      '6-7': '具备部分核心工艺。',
      '4-5': '仅相邻工艺（如只做机加/磨削）。',
      '2-3': '工艺明显不相关。',
      '0': '无任何制造/加工能力（纯贸易或服务）。',
      unclear: '无工艺信息。',
    },
    evidenceRequired: ['attributes.products/keywords + 官网工艺页引文'],
  },
  {
    id: 'C4_BUSINESS_MODEL',
    name: '商业模式',
    weight: 0.15,
    applicableWhen: '始终适用',
    anchors: {
      '10': '采购并转售实物产品的分销商/批发商/进口商（有库存/品牌代理/批发价目证据）。',
      '8-9': '转售模式明确，缺 1 项佐证。',
      '6-7': '混合模式（制造+分销），转售占比不明。',
      '4-5': '仅信息撮合/目录/门户（weak）。',
      '2-3': '平台型、佣金型、无实物转售。',
      '0': '与 ICP 要求的商业模式相反（如 ICP 要分销商，候选是纯制造商自销）。',
      unclear: '无法判断。',
    },
    evidenceRequired: ['website_profile 商业描述', '品牌代理/库存/批发价目证据'],
  },
  {
    id: 'C5_SIZE',
    name: '规模匹配',
    weight: 0.1,
    applicableWhen: 'ICP 声明了规模规则（employee_count/band）时适用',
    anchors: {
      '10': '员工数在 ICP 范围内且来源可信（注册库/官方）。',
      '8-9': '在范围内，来源为二手聚合。',
      '6-7': '接近范围边界（±20%）。',
      '4-5': '明显偏离但业务形态可能仍匹配（如人数少但营收高）。',
      '2-3': '明确越界（规模量级差 ≥5×）。',
      '0': '明确越界且业务形态不匹配。',
      unclear: '无规模数据。',
    },
    evidenceRequired: ['employee_count 或 employee_band（注册库/Wikidata/公开页）'],
  },
] satisfies CriterionDefinition[]);

export const REQUIRED_PROCUREMENT_CRITERIA = [
  'C1_MATERIAL', 'C2_ROLE', 'C3_PROCESS', 'C4_BUSINESS_MODEL',
] as const satisfies readonly CriterionId[];

export function procurementRubric(
  scenario: Exclude<BuyerProcurementScenario, 'distribution'>,
): readonly CriterionDefinition[] {
  const criteria = buyerProcurementCriteria(scenario);
  const titles = {
    C1_MATERIAL: '采购场景的泵种与适用性',
    C2_ROLE: '采购场景角色',
    C3_PROCESS: '泵的实际用途',
    C4_BUSINESS_MODEL: '采购或配套责任',
  } as const;
  const proof = {
    C1_MATERIAL: '指出使用或选型的泵种与卖方产品的具体交集。相邻设备不算证据。',
    C2_ROLE: scenario === 'factory_direct'
      ? '指出该企业是自用工厂或实际运营方。泵制造或销售本身不算。'
      : '指出该企业承担设备工程或系统集成。单纯转发产品资料不算。',
    C3_PROCESS: '指出泵在该工艺、产线、设备或项目中的具体用途。只写经营行业不算。',
    C4_BUSINESS_MODEL: scenario === 'factory_direct'
      ? '指出工厂对该用途有使用、采购或项目实施责任。仅同属一个集团不算。'
      : '指出企业对相关泵承担工程选型、集成或采购责任。无需证明转售。',
  } as const;
  return RUBRIC_CRITERIA.map((criterion) => {
    if (criterion.id === 'C5_SIZE') return criterion;
    return {
      ...criterion,
      name: titles[criterion.id],
      anchors: {
        '10': `直接证据明确支持本项。场景为${criteria.label}。${proof[criterion.id]}`,
        '8-9': '直接证据支持本项，只有次要细节待核实。',
        '6-7': '证据与该场景相符，但产品用途或采购责任仍有一项需核实。',
        '4-5': '只证明相邻业务，尚未支持本项。',
        '2-3': '明确证据表明本项与该场景不符。',
        '0': '直接证据明确反证本项，例如已证实企业在该项目没有采购、选型或使用责任。',
        unclear: '没有可核实的证据或证据冲突。',
      },
      evidenceRequired: [`本项必须判定；缺证据填 unclear。引用快照逐字证据：${proof[criterion.id]}`],
    };
  });
}

export const RUBRIC_AGGREGATION = {
  hardFail: ['C2<=2 with evidence', 'C1<=2 with evidence'],
  fit: 'weightedScore >= 7.0 and all applicable criteria >= 5',
  notFit: 'weightedScore <= 3.5 or hardFail',
  else: 'UNKNOWN',
  evidenceGate: 'any applicable criterion label=unclear -> UNKNOWN',
} as const;

export const RUBRIC_SAMPLING = { temperature: 0.7, k: 3 } as const;

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

/** canonical JSON（顺序由本文件对象字面量定义，禁止重排）。 */
export function rubricCanonicalJson(): string {
  return canonicalJson({
    rubricVersion: RUBRIC_VERSION,
    criteria: RUBRIC_CRITERIA,
    aggregation: RUBRIC_AGGREGATION,
    sampling: RUBRIC_SAMPLING,
  });
}

export const RUBRIC_SHA256 = createHash('sha256')
  .update(rubricCanonicalJson(), 'utf8')
  .digest('hex');
