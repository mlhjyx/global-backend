import { AiTaskContract } from './task-contract';
import { resolveTaskRoute } from '../site-builder/agents/task-routes';
import { MAX_CONTACTS_PER_DISCOVERY_ADAPTER } from '../discovery/execution-envelope';

type OutputSchema = Record<string, unknown>;

const boundedString = (maxLength: number, extra: OutputSchema = {}): OutputSchema => ({
  type: 'string', maxLength, ...extra,
});
const boundedNumber = (
  minimum: number,
  maximum: number,
  integer = false,
): OutputSchema => ({ type: integer ? 'integer' : 'number', minimum, maximum });
const boundedArray = (maxItems: number, items: OutputSchema): OutputSchema => ({
  type: 'array', maxItems, items,
});
const closedObject = (
  properties: Record<string, OutputSchema>,
  required: readonly string[] = [],
  extra: OutputSchema = {},
): OutputSchema => ({
  type: 'object', additionalProperties: false,
  ...(required.length > 0 ? { required } : {}),
  properties,
  ...extra,
});

const MODEL_FACT_SCALAR: OutputSchema = {
  oneOf: [
    boundedString(2000),
    boundedNumber(-1_000_000_000_000_000, 1_000_000_000_000_000),
    { type: 'boolean' },
    { type: 'null' },
  ],
};
const MODEL_FACT_VALUE: OutputSchema = {
  oneOf: [
    ...(MODEL_FACT_SCALAR.oneOf as OutputSchema[]),
    boundedArray(32, MODEL_FACT_SCALAR),
  ],
};
const MODEL_FILTER_SCALAR: OutputSchema = {
  oneOf: [
    boundedString(1000),
    boundedNumber(-1_000_000_000_000_000, 1_000_000_000_000_000),
    { type: 'boolean' },
    { type: 'null' },
  ],
};
const MODEL_FILTER_VALUE: OutputSchema = {
  oneOf: [
    ...(MODEL_FILTER_SCALAR.oneOf as OutputSchema[]),
    boundedArray(32, MODEL_FILTER_SCALAR),
  ],
};
const MODEL_RULE_SCALAR: OutputSchema = {
  oneOf: [
    boundedString(1000),
    boundedNumber(-1_000_000_000_000_000, 1_000_000_000_000_000),
    { type: 'boolean' },
    { type: 'null' },
  ],
};
const MODEL_RULE_VALUE: OutputSchema = {
  oneOf: [
    ...(MODEL_RULE_SCALAR.oneOf as OutputSchema[]),
    boundedArray(32, MODEL_RULE_SCALAR),
  ],
};

/**
 * Registry of domain AI Tasks (PRD 9.3 catalog). Each new task in the AI 获客
 * spine — market research, ICP design, lead research, lead qualification, intent
 * triage… — registers its contract here and is orchestrated by a workflow.
 */
export const AI_TASKS: Record<string, AiTaskContract> = {
  'company_understanding.extract_claims': {
    id: 'company_understanding.extract_claims',
    // 理解管线的页面抓取以本契约身份经 Broker（understanding.activities）——白名单收口②填实。
    allowedTools: ['crawl4ai.fetch'],
    maxCostCents: 20,
    maxOutputTokens: 4_096,
    timeoutMs: 180000,
    description:
      '从企业官网/文档文本中抽取带类型与置信度的企业事实（Claim）。覆盖 KNW-002 全范围：能力、认证、案例、参数、MOQ、交期、市场、企业基本面；发现营销性/绝对化表述时输出 forbidden_expression_candidate 供品牌审核。只抽文本中明确存在的信息。',
    outputSchema: closedObject({
      claims: boundedArray(64, closedObject({
        type: boundedString(80, {
          description:
            'capability | certification | case | param | moq | lead_time | market | company_fact | value_prop | forbidden_expression_candidate',
        }),
        statement: boundedString(4000),
        evidence: boundedString(2000, {
          description: '来源文本中支持该结论的原文片段（用于溯源，必须来自给定文本）',
        }),
        confidence: boundedNumber(0, 1),
      }, ['type', 'statement', 'evidence', 'confidence'])),
    }, ['claims']),
    // 抽取是高频、结构化任务 → 用快而省的 flash（中转站里可配成带 fallback 的模型组）。
    model: 'deepseek-v4-flash',
    risk: 'medium',
    humanGate: true, // Claims land as NEEDS_REVIEW; approval before outbound use.
  },

  'company_understanding.extract_profile': {
    id: 'company_understanding.extract_profile',
    allowedTools: [],
    maxCostCents: 10,
    maxOutputTokens: 4_096,
    timeoutMs: 120000,
    description:
      '从企业官网首页文本提炼企业画像：行业归类与一段话简介（中文，仅基于给定文本，不得编造规模/年份等未出现的信息）。',
    outputSchema: closedObject({
      industry: boundedString(500, { description: '主行业，如「精密金属加工设备制造」' }),
      summary: boundedString(8000, { description: '80-150 字中文简介' }),
    }, ['industry', 'summary']),
    model: 'deepseek-v4-flash',
    risk: 'low',
    humanGate: false, // 画像随 Claim 审批可被人工修正
  },

  'company_understanding.extract_offerings': {
    id: 'company_understanding.extract_offerings',
    allowedTools: [],
    maxCostCents: 20,
    maxOutputTokens: 4_096,
    timeoutMs: 180000,
    description:
      '从企业官网页面文本中抽取结构化的产品/服务（Offering）：名称、简述、关键属性（MOQ/交期/参数/认证/材料等，仅当文本中明确出现时才填），并附来源原文片段。禁止编造文本中不存在的属性。',
    outputSchema: closedObject({
      offerings: boundedArray(128, closedObject({
        name: boundedString(500, { description: '产品/服务名（保留原文语言）' }),
        description: boundedString(4000, { description: '一句话简述' }),
        attributes: closedObject({
          moq: MODEL_RULE_VALUE,
          lead_time: MODEL_RULE_VALUE,
          materials: MODEL_RULE_VALUE,
          params: MODEL_RULE_VALUE,
          certifications: MODEL_RULE_VALUE,
        }, [], {
          description: '仅收录文本中明确出现的属性，如 moq/lead_time/materials/params/certifications',
        }),
        evidence: boundedString(2000, { description: '来源文本中支持该产品存在的原文片段' }),
        confidence: boundedNumber(0, 1),
      }, ['name', 'description', 'evidence', 'confidence'])),
    }, ['offerings']),
    // 与 Claim 抽取同为高频结构化任务 → flash。
    model: 'deepseek-v4-flash',
    risk: 'low', // 只进结构化知识库，不直接对外
    humanGate: false,
  },

  'icp.design': {
    id: 'icp.design',
    allowedTools: [],
    maxCostCents: 40,
    maxOutputTokens: 4_096,
    timeoutMs: 180000,
    description:
      '基于卖方企业的已确认事实(Claim)，设计理想客户画像(ICP)：目标公司属性、痛点、采购触发信号、排除条件、价值主张、目标市场、买家委员会角色，以及机器可评估的验证规则(qualification_rules)。规则的 field 使用规范属性名：industry/sub_industry/region/country/employee_count/revenue/certifications/keywords/tech/business_model/end_markets。',
    outputSchema: closedObject({
      name: boundedString(200, { description: 'ICP 名称，如「欧洲中型汽车零部件制造商」' }),
      company_attributes: closedObject({
        industry: MODEL_FACT_VALUE,
        sub_industry: MODEL_FACT_VALUE,
        region: MODEL_FACT_VALUE,
        country: MODEL_FACT_VALUE,
        employee_count: MODEL_FACT_VALUE,
        revenue: MODEL_FACT_VALUE,
        certifications: MODEL_FACT_VALUE,
        keywords: MODEL_FACT_VALUE,
        tech: MODEL_FACT_VALUE,
        business_model: MODEL_FACT_VALUE,
        end_markets: MODEL_FACT_VALUE,
        product: MODEL_FACT_VALUE,
        trade_side: MODEL_FACT_VALUE,
      }, [], { description: '目标公司属性：行业/规模/地区/技术等' }),
      pain_points: boundedArray(8, boundedString(2000)),
      trigger_signals: boundedArray(8, boundedString(2000),),
      exclusions: boundedArray(8, boundedString(2000)),
      value_props: boundedArray(8, boundedString(2000)),
      target_markets: boundedArray(8, boundedString(300)),
      personas: boundedArray(8, closedObject({
        title: boundedString(200),
        goals: boundedArray(4, boundedString(500)),
        pain_points: boundedArray(4, boundedString(500)),
      }, ['title', 'goals', 'pain_points'])),
      buying_committee: boundedArray(32, closedObject({
        role: boundedString(80, {
          description: 'decision_maker | influencer | user | technical | finance | procurement',
        }),
        title: boundedString(200),
        concerns: boundedArray(4, boundedString(500)),
      }, ['role', 'title', 'concerns'])),
      qualification_rules: boundedArray(64, closedObject({
        kind: boundedString(20, {
          enum: ['MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION'],
          description: 'MUST_HAVE | NICE_TO_HAVE | EXCLUSION',
        }),
        field: boundedString(200, {
          description:
            '规范属性名：industry/sub_industry/region/country/employee_count/revenue/certifications/keywords/tech/business_model/end_markets',
        }),
        operator: boundedString(80, {
          enum: ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'gte', 'lte', 'matches'],
          description: 'eq | neq | in | not_in | contains | not_contains | gte | lte | matches',
        }),
        value: { ...MODEL_RULE_VALUE, description: '操作数：标量或数组' },
        weight: { ...boundedNumber(0, 100), description: 'NICE_TO_HAVE 权重，默认 1' },
        rationale: boundedString(2000, { description: '该规则依据哪条企业事实/推理，保持推断透明' }),
      }, ['kind', 'field', 'operator', 'value', 'rationale'], {
        description:
          '机器可评估的验证规则（LED-003）。每条规则针对一个候选公司属性做确定性判断；EXCLUSION 优先于一切正向评分。',
      })),
    }, [
      'name', 'company_attributes', 'pain_points', 'trigger_signals', 'exclusions',
      'value_props', 'target_markets', 'personas', 'buying_committee',
      'qualification_rules',
    ]),
    // ICP 设计是低频、策略推理任务 → 用更强的 pro。
    model: 'deepseek-v4-pro',
    risk: 'medium',
    humanGate: true, // ICP 生成后为 HYPOTHESIS，回测/人工确认后才 ACTIVE。
  },

  'discovery.extract_company': {
    id: 'discovery.extract_company',
    // PublicWebDiscoveryProvider 以本契约身份经 Broker 搜索/抓取（收口②：白名单真实生效）。
    allowedTools: ['searxng.search', 'crawl4ai.fetch'],
    maxCostCents: 15,
    maxOutputTokens: 4_096,
    timeoutMs: 180000,
    description:
      '判断给定网页是否为一家真实企业的官网，若是则抽取结构化企业属性。只允许使用网页文本中明确出现的信息，禁止编造或从画像上下文照抄。若不是企业官网（是目录/百科/新闻/市场平台/博客），is_company_site 置 false。',
    outputSchema: closedObject({
      is_company_site: { type: 'boolean', description: '该页面是否为某家企业自己的官网' },
      name: boundedString(500, { description: '企业名称（原文语言）' }),
      country: boundedString(300, { description: '国家/地区（能从文本判断时）' }),
      industry: boundedString(300, { description: '行业（英文小写，如 metal fabrication）' }),
      employee_count: {
        type: ['integer', 'null'], minimum: 0, maximum: 1_000_000_000,
        description: '员工数（仅当文本明确出现）',
      },
      products: {
        ...boundedArray(32, boundedString(500)),
        description: '主要产品/服务',
      },
      keywords: {
        ...boundedArray(32, boundedString(300)),
        description: '能力/技术关键词',
      },
      evidence: boundedString(2000, { description: '支持判断的原文片段' }),
      confidence: boundedNumber(0, 1),
    }, ['is_company_site']),
    // 判站 + 抽取是高频任务。原用 gemini-2.5-flash（快、长上下文、便宜）；2026-07-09 网关 Gemini
    // 预付额度耗尽（429）→ 改路由到同为高频便宜档的 deepseek-v4-flash。额度恢复后可切回 gemini-2.5-flash。
    model: 'deepseek-v4-flash',
    risk: 'low',
    humanGate: false,
  },

  'contact.find_decision_makers': {
    id: 'contact.find_decision_makers',
    // DecisionMaker/public_web 联系人路径以本契约身份经 Broker 搜索/抓取（收口②）。
    allowedTools: ['searxng.search', 'crawl4ai.fetch'],
    maxCostCents: 15,
    maxOutputTokens: 4_096,
    timeoutMs: 120000,
    description:
      '从企业的 Impressum/法律声明/团队/管理层/联系页文本里抽取**具名的人**及其职务与联系方式，并按买家委员会角色分类。铁律：只抽取页面文本中**明确出现**的人名/职务/邮箱/电话，禁止编造或推断未写出的邮箱；抽不到就返回空数组。德国 Impressum 依法列 Geschäftsführer（总经理）——优先抽取。给定卖方 ICP 的目标买家角色时，标注每个人是否命中目标角色。所有具名人属个人数据。',
    outputSchema: closedObject({
      people: {
        ...boundedArray(MAX_CONTACTS_PER_DISCOVERY_ADAPTER, closedObject({
          full_name: boundedString(500),
          title: boundedString(500, {
            description: '职务原文（如 Geschäftsführer / Head of Production）',
          }),
          email: boundedString(320, { description: '仅当页面明确出现该人邮箱' }),
          phone: boundedString(80, { description: '仅当页面明确出现' }),
          department: boundedString(80, {
            description: 'management/production/procurement/engineering/sales/finance/other',
          }),
          seniority: boundedString(80, {
            description: 'owner/c_level/vp/director/manager/staff/unknown',
          }),
          buying_role: boundedString(80, {
            description: 'decision_maker/economic_buyer/technical_buyer/influencer/user/gatekeeper/unknown',
          }),
          is_target_role: { type: 'boolean', description: '是否命中卖方 ICP 的目标买家角色' },
          evidence: boundedString(2000, { description: '支持判断的原文片段' }),
        }, ['full_name'])),
        description: '页面明确出现的具名人员（去重）',
      },
    }, ['people']),
    // 原 gemini-2.5-flash；2026-07-09 网关 Gemini 额度耗尽（429）→ 改 deepseek-v4-flash（额度恢复可切回）。
    model: 'deepseek-v4-flash',
    risk: 'medium', // 涉及个人数据抽取，下游必须过合规门
    humanGate: false,
  },

  'discovery.extract_list': {
    id: 'discovery.extract_list',
    // DirectoryDiscoveryProvider 以本契约身份经 Broker 搜索/抓取（收口②）。
    allowedTools: ['searxng.search', 'crawl4ai.fetch'],
    maxCostCents: 20,
    maxOutputTokens: 4_096,
    timeoutMs: 180000,
    description:
      '判断给定网页是否为一个企业名录/列表页（协会会员名录、展会参展商名单、行业目录），若是则抽取其中列出的**多家公司**。只允许使用页面文本中明确出现的公司，禁止编造。若页面只讲一家公司或根本不是名录，is_directory 置 false、companies 置空。每家公司尽量给出官网与所在地（仅当文本出现）。',
    outputSchema: closedObject({
      is_directory: { type: 'boolean', description: '该页是否为多公司名录/列表页' },
      list_kind: boundedString(80, {
        enum: ['association_members', 'trade_fair_exhibitors', 'industry_directory', 'other'],
        description: '名录类型：association_members / trade_fair_exhibitors / industry_directory / other',
      }),
      companies: {
        ...boundedArray(128, closedObject({
          name: boundedString(500, { description: '公司名（原文语言）' }),
          website: boundedString(2048, { description: '官网 URL 或域名（仅当页面出现）' }),
          location: boundedString(500, { description: '城市/国家（仅当页面出现）' }),
          detail_url: boundedString(2048, { description: '该公司在名录内的详情页链接（仅当页面出现）' }),
        }, ['name'])),
        description: '页面中列出的公司（去重）',
      },
      has_next_page: { type: 'boolean', description: '页面是否有下一页/分页' },
    }, ['is_directory', 'companies']),
    // 列表抽取是长上下文任务（一页多公司）。原 gemini-2.5-flash；2026-07-09 网关 Gemini 额度耗尽（429）
    // → 改 deepseek-v4-flash（同为长上下文/便宜档，额度恢复可切回）。
    model: 'deepseek-v4-flash',
    risk: 'low',
    humanGate: false,
  },

  'taxonomy.normalize': {
    id: 'taxonomy.normalize',
    description:
      '词表归一（冷路径）：把一个行业/国家自由词归一到给定标准码表中已有的一个 code。只能从候选码表里选，选不到必须返回 null，禁止编造码。',
    outputSchema: closedObject({
      code: { type: ['string', 'null'], maxLength: 80 },
    }, ['code']),
    allowedTools: [], // 纯生成，无工具
    maxCostCents: 5,
    maxOutputTokens: 4_096,
    timeoutMs: 60000,
    model: 'deepseek-v4-flash', // 高频、便宜、冷路径
    risk: 'low',
    humanGate: false,
  },

  'discovery.qualify_fit': {
    id: 'discovery.qualify_fit',
    allowedTools: [],
    maxCostCents: 20,
    maxOutputTokens: 4_096,
    timeoutMs: 180000,
    description:
      '给定卖方 ICP 与一家候选公司，判断它是否为该卖方的真实目标客户。必须通过四个门：\n1) 材质门：候选的加工材质是否与 ICP 目标一致（如金属 vs 塑料/织物/粉体）——注意 "RF welding"（射频热合塑料）≠ 金属焊接，"toll processing/筛分" 处理粉末≠金属工件加工。\n2) 角色门：候选是设备/产品的下游买家，还是与卖方同类的设备制造商（竞品）？竞品判 mismatch。\n3) 工艺子集门：候选是否真正从事 ICP 核心工艺，还是仅相邻工艺（如纯机加/磨削而无激光/钣金/折弯/焊接）。\n4) 商业模式门：候选是自有产线的制造商，还是聚合第三方供应商的采购中介平台？中介平台判 weak。\n任一硬门失败判 mismatch；边缘/相邻判 weak；全部通过判 match。只依据给定信息，理由需具体。',
    outputSchema: closedObject({
      verdict: boundedString(8, {
        enum: ['match', 'weak', 'mismatch'], description: 'match | weak | mismatch',
      }),
      material_gate: boundedString(1000, { description: 'pass | fail | unclear + 一句依据' }),
      role_gate: boundedString(1000, { description: 'pass(下游买家) | fail(竞品) | unclear' }),
      process_gate: boundedString(1000, { description: 'pass(核心工艺) | weak(相邻工艺) | fail | unclear' }),
      business_model_gate: boundedString(1000, { description: 'pass(自有产线) | weak(中介平台) | unclear' }),
      reasons: { ...boundedArray(16, boundedString(1000)), description: '具体判定依据' },
    }, ['verdict', 'material_gate', 'role_gate', 'process_gate', 'business_model_gate', 'reasons']),
    // 资格判别要准（评测显示 flash 召回过宽）→ 用 pro 档。原 gemini-2.5-pro；2026-07-09 网关 Gemini
    // 额度耗尽（429）→ 改 deepseek-v4-pro（同为 pro 档强推理，已用于 icp.design/query_plan）。
    // ⚠️ 勿降到 deepseek-reasoner/deepseek-chat：官方已宣布 2026-07-24 彻底关停二别名（过渡期透传 v4-flash），
    // 用了既撞关停又重蹈 flash 召回过宽。全仓一律显式 deepseek-v4-pro / deepseek-v4-flash。
    // 额度恢复后可切回 gemini-2.5-pro。
    model: 'deepseek-v4-pro',
    risk: 'low',
    humanGate: false,
  },

  'discovery.query_plan': {
    id: 'discovery.query_plan',
    allowedTools: [],
    maxCostCents: 40,
    maxOutputTokens: 4_096,
    timeoutMs: 180000,
    description:
      '把 ICP 翻译成多数据源可执行的查询计划（LED-005）。针对 PRD 7.4.7 的七类 source_class 生成有序查询：按 ICP 行业与市场特征挑选最相关的源，发现类在前（contact/email 验证属后续补全，不出现在此）。\n当前每个 source_class 下真实可用的子源（可用 filters.source_hint 精确路由，省略=该类全跑）：\n- public_intelligence → public_web（SearXNG 官网挖掘，关键词驱动）、ted（欧盟招投标中标发现：需 filters.cpv + filters.buyer_country；CPV 由系统按 ICP 冷路径确定性注入，勿自行臆造码）\n- company_registry → wikidata（结构化：按行业+国家零爬取查公司+官网+员工数）\n- industry_data → openstreetmap（地理：按工业标签+地区枚举工厂）、public_web\n结构化源需要规范的 filters：industry（行业词，中/英均可，如「金属加工」/"metal fabrication"）、country 或 region（如「德国」/"Germany"/"Baden-Württemberg"）。这些词会经规范词表映射到 Wikidata QID / OSM 标签。keywords 用于 public_web 全文搜索。',
    outputSchema: closedObject({
      queries: boundedArray(64, closedObject({
        source_class: boundedString(80, {
          enum: [
            'trade_data', 'b2b_company_person', 'company_registry',
            'public_intelligence', 'industry_data',
          ],
          description:
            'trade_data | b2b_company_person | company_registry | public_intelligence | industry_data',
        }),
        filters: closedObject({
          industry: MODEL_FILTER_VALUE,
          sub_industry: MODEL_FILTER_VALUE,
          country: MODEL_FILTER_VALUE,
          region: MODEL_FILTER_VALUE,
          source_hint: MODEL_FILTER_VALUE,
          area_name: MODEL_FILTER_VALUE,
          hs_code: MODEL_FILTER_VALUE,
          cpv: MODEL_FILTER_VALUE,
          buyer_country: MODEL_FILTER_VALUE,
          product: MODEL_FILTER_VALUE,
          product_code: MODEL_FILTER_VALUE,
          trade_side: MODEL_FILTER_VALUE,
          establishment_type: MODEL_FILTER_VALUE,
          iso_country: MODEL_FILTER_VALUE,
          since_days: MODEL_FILTER_VALUE,
        }, [], {
          description:
            '结构化过滤条件。发现类必备 industry + country/region（规范词表可映射的行业/国家词）；可选 source_hint（public_web|wikidata|openstreetmap|ted）精确路由；TED 专用 filters：cpv（逗号分隔 8 位 CPV 前缀码）+ buyer_country（ISO-3，如 DEU/FRA，均由系统冷路径注入）；可选 area_name/hs_code 等。',
        }),
        keywords: {
          ...boundedArray(32, boundedString(200)),
          description: '检索关键词（含本地语言变体）',
        },
        rationale: boundedString(4000, { description: '为什么选这个源、这些条件' }),
        priority: {
          ...boundedNumber(1, 10_000, true),
          description: '执行顺序，1 最先（低成本源在前，PRD 7.4.8）',
        },
      }, ['source_class', 'filters', 'keywords', 'rationale', 'priority'])),
      estimated_volume: {
        ...boundedNumber(0, 1_000_000_000, true), description: '预计候选公司量级',
      },
    }, ['queries', 'estimated_volume']),
    // 计划生成是低频推理任务 → pro。
    model: 'deepseek-v4-pro',
    risk: 'low', // 只产出计划，执行前还有成本 Dry Run 与人工确认
    humanGate: true,
  },

  'site_builder.brand_profile': {
    id: 'site_builder.brand_profile',
    // 品牌 web 研究的两条出网通道（Broker allowedTools 白名单据此裁决，09 §2.4 / C1-C3）。
    allowedTools: ['searxng.search', 'crawl4ai.fetch'],
    // Site Builder 的 route/budget/timeout 唯一真值在 task-routes；getter 避免本通用
    // ToolBroker 合同复制第二份会随 MODEL promotion/rollback 漂移的快照。
    get maxCostCents() {
      return resolveTaskRoute('site_builder.brand_profile').maxCostCents;
    },
    get maxOutputTokens() {
      return resolveTaskRoute('site_builder.brand_profile').maxTokens;
    },
    get timeoutMs() {
      return resolveTaskRoute('site_builder.brand_profile').timeoutMs;
    },
    description:
      '独立站建设：从 KB digest + 站主档案 + 联网研究综合品牌档案（价值主张/语气/词表/差异化/竞品定位/factSheet+evidence/gaps）。逐项证据分级溯源，认证类断言网络单源不上站；workspace gaps 可保留待核实姓名/身份与联系方式，限 AuthGuard+RLS 内部使用。Claim/FactSheet/SiteSpec 不得使用这些内部个人资料自动公开，必须另行具备证据与发布授权。输出与提示词详见 site-builder/agents/brand-profile.ts（模型路由由 site-builder/agents/task-routes.ts 配置驱动）。',
    outputSchema: { type: 'object' }, // 真 schema 在任务模块内随调用传入（网关按请求 schema 校验）
    get model() {
      return resolveTaskRoute('site_builder.brand_profile').primary;
    },
    risk: 'medium', // 内部品牌资产，上站文案另有 copy 侧 factSheet 闸
    humanGate: false,
  },
};

export function getTask(id: string): AiTaskContract | undefined {
  return AI_TASKS[id];
}
