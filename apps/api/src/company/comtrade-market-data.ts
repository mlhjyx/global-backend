/**
 * Deterministic UN Comtrade HS trade-flow baseline dataset (reference year 2024).
 *
 * Used strictly for read-only market recommendation (`isRecommendationOnly: true`);
 * never auto-writes `CompanyProfile.targetMarkets` or `confirmedTargetMarkets`.
 */

export interface ComtradeCountryFlow {
  readonly code: string;
  readonly name: string;
  readonly labelEn: string;
  readonly importVolumeUsd: number;
  readonly yoyGrowthPct: number;
  readonly globalImportSharePct: number;
  readonly rationale: string;
}

export interface ComtradeHsCatalogEntry {
  readonly code: string;
  readonly label: string;
  readonly labelZh: string;
  readonly keywords: readonly string[];
  readonly markets: readonly ComtradeCountryFlow[];
}

export const COMTRADE_REFERENCE_YEAR = 2024 as const;

export const COMTRADE_HS_CATALOG: readonly ComtradeHsCatalogEntry[] = Object.freeze([
  {
    code: '854143',
    label: 'Photovoltaic cells assembled in modules or panels',
    labelZh: '光伏组件 / 太阳能电池板',
    keywords: ['solar', 'photovoltaic', 'pv module', 'pv panel', 'hjt', 'topcon', 'perc', '光伏', '太阳能组件', '组件', '电池板'],
    markets: [
      { code: 'NL', name: '荷兰', labelEn: 'Netherlands', importVolumeUsd: 8_420_000_000, yoyGrowthPct: 6.4, globalImportSharePct: 14.8, rationale: '欧洲光伏集散与分销枢纽，鹿特丹港清关辐射全欧渠道' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 6_180_000_000, yoyGrowthPct: 12.1, globalImportSharePct: 10.9, rationale: '欧洲最大工商业与户用装机市场，EPC 与批发商密度高' },
      { code: 'ES', name: '西班牙', labelEn: 'Spain', importVolumeUsd: 4_390_000_000, yoyGrowthPct: 9.8, globalImportSharePct: 7.7, rationale: '大型地面电站与工商业光伏新增装机强劲，EPC 采购活跃' },
      { code: 'IT', name: '意大利', labelEn: 'Italy', importVolumeUsd: 3_950_000_000, yoyGrowthPct: 15.6, globalImportSharePct: 6.9, rationale: '工商业屋顶与储能配储需求高增长，区域分销商采购频繁' },
      { code: 'BR', name: '巴西', labelEn: 'Brazil', importVolumeUsd: 3_620_000_000, yoyGrowthPct: 11.4, globalImportSharePct: 6.4, rationale: '拉美最大分布式光伏进口市场，本地集成商高度依赖中国组件' },
      { code: 'PL', name: '波兰', labelEn: 'Poland', importVolumeUsd: 2_480_000_000, yoyGrowthPct: 13.2, globalImportSharePct: 4.4, rationale: '中东欧光伏增长核心，批发渠道对高效 N 型组件接受度高' },
      { code: 'AE', name: '阿联酋', labelEn: 'United Arab Emirates', importVolumeUsd: 1_960_000_000, yoyGrowthPct: 18.5, globalImportSharePct: 3.4, rationale: '中东与非洲大型光伏转口贸易及 EPC 总包中心' },
      { code: 'FR', name: '法国', labelEn: 'France', importVolumeUsd: 1_890_000_000, yoyGrowthPct: 8.7, globalImportSharePct: 3.3, rationale: '招标与农光互补项目稳定释放，渠道准入门槛规范' },
    ],
  },
  {
    code: '850760',
    label: 'Lithium-ion accumulators & battery energy storage',
    labelZh: '锂离子储能电池系统',
    keywords: ['battery', 'bess', 'energy storage', 'lithium', 'lifepo4', 'ess', '储能', '锂电池', '电池系统'],
    markets: [
      { code: 'US', name: '美国', labelEn: 'United States', importVolumeUsd: 16_900_000_000, yoyGrowthPct: 19.4, globalImportSharePct: 21.5, rationale: '全球最大表前与工商业储能需求市场，系统集成商采购量大' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 9_850_000_000, yoyGrowthPct: 14.8, globalImportSharePct: 12.5, rationale: '欧洲户储与工商业配储第一大市场，光储一体分销成熟' },
      { code: 'IT', name: '意大利', labelEn: 'Italy', importVolumeUsd: 4_120_000_000, yoyGrowthPct: 16.2, globalImportSharePct: 5.2, rationale: '电网调频与工商业储能招标拉动成套系统进口' },
      { code: 'GB', name: '英国', labelEn: 'United Kingdom', importVolumeUsd: 3_780_000_000, yoyGrowthPct: 13.7, globalImportSharePct: 4.8, rationale: '独立储能电站开发活跃，EPC 与开发商直采意愿高' },
      { code: 'AU', name: '澳大利亚', labelEn: 'Australia', importVolumeUsd: 2_650_000_000, yoyGrowthPct: 17.9, globalImportSharePct: 3.4, rationale: '高屋顶光伏渗透率驱动户用与社区储能高速增长' },
      { code: 'NL', name: '荷兰', labelEn: 'Netherlands', importVolumeUsd: 2_410_000_000, yoyGrowthPct: 15.1, globalImportSharePct: 3.1, rationale: '电网拥堵推动工商业储能激增，兼做欧洲分拨仓' },
    ],
  },
  {
    code: '850440',
    label: 'Static converters & solar inverters',
    labelZh: '逆变器 / 静止变流器',
    keywords: ['inverter', 'converter', 'pcs', 'power supply', 'rectifier', '逆变器', '变流器', '电源'],
    markets: [
      { code: 'US', name: '美国', labelEn: 'United States', importVolumeUsd: 14_200_000_000, yoyGrowthPct: 9.2, globalImportSharePct: 17.8, rationale: '工业电气化与新能源配套拉动高频大功率变流器进口' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 7_450_000_000, yoyGrowthPct: 8.6, globalImportSharePct: 9.3, rationale: '欧洲工业自动化与光伏逆变器核心进口国' },
      { code: 'NL', name: '荷兰', labelEn: 'Netherlands', importVolumeUsd: 5_180_000_000, yoyGrowthPct: 7.9, globalImportSharePct: 6.5, rationale: '欧洲新能源与电源分销中转枢纽' },
      { code: 'IT', name: '意大利', labelEn: 'Italy', importVolumeUsd: 2_920_000_000, yoyGrowthPct: 11.3, globalImportSharePct: 3.7, rationale: '中小工商业光储与机械配套需求旺盛' },
      { code: 'BR', name: '巴西', labelEn: 'Brazil', importVolumeUsd: 2_140_000_000, yoyGrowthPct: 10.5, globalImportSharePct: 2.7, rationale: '光储分销商批量进口混合逆变器与离网电源' },
      { code: 'PL', name: '波兰', labelEn: 'Poland', importVolumeUsd: 1_820_000_000, yoyGrowthPct: 12.0, globalImportSharePct: 2.3, rationale: '东欧电气化改造与光储安装商采购活跃' },
    ],
  },
  {
    code: '841370',
    label: 'Centrifugal and industrial process pumps',
    labelZh: '工业离心泵 / 化工流程泵',
    keywords: ['pump', 'centrifugal', 'kreiselpumpe', 'prozesspumpe', 'slurry pump', 'industrial pump', '工业泵', '离心泵', '化工泵', '水泵'],
    markets: [
      { code: 'US', name: '美国', labelEn: 'United States', importVolumeUsd: 4_860_000_000, yoyGrowthPct: 6.1, globalImportSharePct: 16.4, rationale: '化工、水处理与油气基建持续采购工业流程泵及备件' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 2_740_000_000, yoyGrowthPct: 5.2, globalImportSharePct: 9.2, rationale: '欧洲成套设备集成商与化工水处理工程商聚集地' },
      { code: 'NL', name: '荷兰', labelEn: 'Netherlands', importVolumeUsd: 1_490_000_000, yoyGrowthPct: 7.4, globalImportSharePct: 5.0, rationale: '石化港口集群与水务工程驱动工业泵代理采购' },
      { code: 'IT', name: '意大利', labelEn: 'Italy', importVolumeUsd: 1_280_000_000, yoyGrowthPct: 6.8, globalImportSharePct: 4.3, rationale: '机械成套出口强国，OEM 配套与流体代理需求稳健' },
      { code: 'AE', name: '阿联酋', labelEn: 'United Arab Emirates', importVolumeUsd: 1_120_000_000, yoyGrowthPct: 11.2, globalImportSharePct: 3.8, rationale: '海水淡化与油气工程 EPC 长期采购耐腐蚀工业泵' },
      { code: 'SA', name: '沙特阿拉伯', labelEn: 'Saudi Arabia', importVolumeUsd: 1_050_000_000, yoyGrowthPct: 14.3, globalImportSharePct: 3.5, rationale: '大型水务与工业园基建拉动高压流程泵进口' },
    ],
  },
  {
    code: '847950',
    label: 'Industrial robots & automated handling machinery',
    labelZh: '工业机器人 / 自动化产线设备',
    keywords: ['robot', 'robotics', 'cobot', 'automation', 'amr', 'agv', 'palletizing', '机器人', '工业机器人', '协作机器人', '自动化'],
    markets: [
      { code: 'US', name: '美国', labelEn: 'United States', importVolumeUsd: 3_420_000_000, yoyGrowthPct: 11.8, globalImportSharePct: 19.6, rationale: '制造业回流与仓储物流自动化拉动系统集成商采购' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 2_380_000_000, yoyGrowthPct: 9.4, globalImportSharePct: 13.7, rationale: '汽车与精密制造自动化集成商密集，产线升级刚需' },
      { code: 'MX', name: '墨西哥', labelEn: 'Mexico', importVolumeUsd: 1_360_000_000, yoyGrowthPct: 16.5, globalImportSharePct: 7.8, rationale: '北美近岸制造扩产，新建工厂集中采购工业机器人' },
      { code: 'IT', name: '意大利', labelEn: 'Italy', importVolumeUsd: 1_040_000_000, yoyGrowthPct: 8.9, globalImportSharePct: 6.0, rationale: '包装与金属加工自动化集成商采购活跃' },
      { code: 'PL', name: '波兰', labelEn: 'Poland', importVolumeUsd: 890_000_000, yoyGrowthPct: 13.4, globalImportSharePct: 5.1, rationale: '中东欧制造基地人力成本上升，推动产线自动化替代' },
      { code: 'TH', name: '泰国', labelEn: 'Thailand', importVolumeUsd: 720_000_000, yoyGrowthPct: 12.1, globalImportSharePct: 4.1, rationale: '东南亚汽车与电子制造中心，自动化集成需求上行' },
    ],
  },
  {
    code: '842240',
    label: 'Packing and wrapping machinery',
    labelZh: '包装机械 / 灌装封口设备',
    keywords: ['packaging', 'packing', 'wrapping', 'filling machine', 'cartoning', 'labeling', '包装机', '包装机械', '灌装', '封口机'],
    markets: [
      { code: 'US', name: '美国', labelEn: 'United States', importVolumeUsd: 3_890_000_000, yoyGrowthPct: 7.5, globalImportSharePct: 18.2, rationale: '食品饮料、日化与医药包装产线更新周期稳定' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 1_940_000_000, yoyGrowthPct: 5.8, globalImportSharePct: 9.1, rationale: '欧洲食品与工业品包装渠道商和集成商基础雄厚' },
      { code: 'TH', name: '泰国', labelEn: 'Thailand', importVolumeUsd: 980_000_000, yoyGrowthPct: 11.4, globalImportSharePct: 4.6, rationale: '东南亚食品加工与出口大国，自动化包装产线采购增长快' },
      { code: 'VN', name: '越南', labelEn: 'Vietnam', importVolumeUsd: 860_000_000, yoyGrowthPct: 14.2, globalImportSharePct: 4.0, rationale: '消费品与农产品出口工厂快速扩张，设备性价比敏感度匹配' },
      { code: 'ID', name: '印度尼西亚', labelEn: 'Indonesia', importVolumeUsd: 810_000_000, yoyGrowthPct: 12.6, globalImportSharePct: 3.8, rationale: '庞大快消与食品制造业持续进口自动化包装线' },
      { code: 'MX', name: '墨西哥', labelEn: 'Mexico', importVolumeUsd: 790_000_000, yoyGrowthPct: 10.3, globalImportSharePct: 3.7, rationale: '食品饮料与日化对美出口加工厂集中采购包装机械' },
    ],
  },
  {
    code: '845710',
    label: 'CNC machining centers & metalworking machinery',
    labelZh: '数控加工中心 / 精密金属加工设备与部件',
    keywords: ['cnc', 'machining', 'milling', 'turning', 'sheet metal', 'laser cutting', 'precision metal', '数控', '机加工', '钣金', '激光切割', '精密加工'],
    markets: [
      { code: 'US', name: '美国', labelEn: 'United States', importVolumeUsd: 4_150_000_000, yoyGrowthPct: 7.2, globalImportSharePct: 17.5, rationale: '航空航天、汽车与工业机械加工厂持续采购 CNC 及零部件' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 2_890_000_000, yoyGrowthPct: 4.9, globalImportSharePct: 12.2, rationale: '精密制造与机械工程核心市场，OEM 外协采购体系完善' },
      { code: 'IT', name: '意大利', labelEn: 'Italy', importVolumeUsd: 1_620_000_000, yoyGrowthPct: 6.5, globalImportSharePct: 6.8, rationale: '中小企业制造集群高度活跃，机加工代理与集成商多' },
      { code: 'MX', name: '墨西哥', labelEn: 'Mexico', importVolumeUsd: 1_480_000_000, yoyGrowthPct: 15.1, globalImportSharePct: 6.2, rationale: '北美汽车及工业件供应链转移带动 CNC 设备与外协增长' },
      { code: 'TR', name: '土耳其', labelEn: 'Turkey', importVolumeUsd: 1_190_000_000, yoyGrowthPct: 10.8, globalImportSharePct: 5.0, rationale: '欧亚制造桥梁，金属加工与模具厂扩产显著' },
      { code: 'PL', name: '波兰', labelEn: 'Poland', importVolumeUsd: 1_040_000_000, yoyGrowthPct: 9.7, globalImportSharePct: 4.4, rationale: '欧洲工业外协加工枢纽，对高性价比精密设备需求强' },
    ],
  },
  {
    code: '848180',
    label: 'Industrial valves, taps & flow control appliances',
    labelZh: '工业阀门 / 流体控制部件',
    keywords: ['valve', 'valves', 'actuator', 'manifold', 'flow control', 'fitting', '阀门', '工业阀', '执行器', '管件'],
    markets: [
      { code: 'US', name: '美国', labelEn: 'United States', importVolumeUsd: 9_650_000_000, yoyGrowthPct: 5.9, globalImportSharePct: 18.9, rationale: '工业管网、化工与暖通分销商体量全球第一' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 4_820_000_000, yoyGrowthPct: 4.8, globalImportSharePct: 9.4, rationale: '工业流体工程与过程自动化 OEM 采购密度高' },
      { code: 'NL', name: '荷兰', labelEn: 'Netherlands', importVolumeUsd: 2_310_000_000, yoyGrowthPct: 6.7, globalImportSharePct: 4.5, rationale: '化工与海工贸易批发商面向全欧转口分销' },
      { code: 'AE', name: '阿联酋', labelEn: 'United Arab Emirates', importVolumeUsd: 1_780_000_000, yoyGrowthPct: 12.4, globalImportSharePct: 3.5, rationale: '油气与水务工程集散中心，认证阀门代理活跃' },
      { code: 'SA', name: '沙特阿拉伯', labelEn: 'Saudi Arabia', importVolumeUsd: 1_650_000_000, yoyGrowthPct: 13.8, globalImportSharePct: 3.2, rationale: '能源化工与市政项目持续招标采购工业阀门' },
      { code: 'GB', name: '英国', labelEn: 'United Kingdom', importVolumeUsd: 1_540_000_000, yoyGrowthPct: 5.5, globalImportSharePct: 3.0, rationale: '水务与北海能源维护体系稳定采购工业阀件' },
    ],
  },
  {
    code: '901890',
    label: 'Medical, surgical & diagnostic instruments',
    labelZh: '医疗器械 / 诊断与手术耗材设备',
    keywords: ['medical', 'surgical', 'diagnostic', 'hospital', 'dental', 'ivd', 'healthcare', '医疗器械', '医用', '诊断', '手术', '耗材'],
    markets: [
      { code: 'US', name: '美国', labelEn: 'United States', importVolumeUsd: 24_500_000_000, yoyGrowthPct: 8.1, globalImportSharePct: 26.4, rationale: '全球最大医疗器械进口市场，FDA 合规代理商体系成熟' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 8_920_000_000, yoyGrowthPct: 6.9, globalImportSharePct: 9.6, rationale: '欧洲医疗分销中心，CE MDR 认证渠道覆盖广' },
      { code: 'NL', name: '荷兰', labelEn: 'Netherlands', importVolumeUsd: 7_840_000_000, yoyGrowthPct: 7.4, globalImportSharePct: 8.4, rationale: '跨国医疗物流与欧代分拨枢纽' },
      { code: 'JP', name: '日本', labelEn: 'Japan', importVolumeUsd: 5_120_000_000, yoyGrowthPct: 5.3, globalImportSharePct: 5.5, rationale: '老龄化驱动高质量医疗耗材与诊断设备进口稳定' },
      { code: 'FR', name: '法国', labelEn: 'France', importVolumeUsd: 4_360_000_000, yoyGrowthPct: 6.2, globalImportSharePct: 4.7, rationale: '公立医院集团与区域器械批发商采购规范透明' },
      { code: 'BR', name: '巴西', labelEn: 'Brazil', importVolumeUsd: 2_680_000_000, yoyGrowthPct: 10.9, globalImportSharePct: 2.9, rationale: '拉美最大医疗器械市场，本地进口代理依赖海外制造' },
    ],
  },
  {
    code: '940542',
    label: 'LED commercial & industrial luminaires',
    labelZh: '商业与工业 LED 照明灯具',
    keywords: ['led', 'lighting', 'luminaire', 'floodlight', 'high bay', 'street light', '照明', '灯具', '工业照明', '商业照明'],
    markets: [
      { code: 'US', name: '美国', labelEn: 'United States', importVolumeUsd: 6_840_000_000, yoyGrowthPct: 5.4, globalImportSharePct: 22.1, rationale: '商业建筑与仓储节能改造拉动工业 LED 批发采购' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 3_120_000_000, yoyGrowthPct: 6.3, globalImportSharePct: 10.1, rationale: '欧洲工业照明与市政节能招标规范，电工批发商集中' },
      { code: 'GB', name: '英国', labelEn: 'United Kingdom', importVolumeUsd: 1_960_000_000, yoyGrowthPct: 5.9, globalImportSharePct: 6.3, rationale: '电气分销连锁与工程照明集成商采购稳定' },
      { code: 'FR', name: '法国', labelEn: 'France', importVolumeUsd: 1_780_000_000, yoyGrowthPct: 6.1, globalImportSharePct: 5.8, rationale: '商业地产与公共道路 LED 替换项目持续释放' },
      { code: 'AU', name: '澳大利亚', labelEn: 'Australia', importVolumeUsd: 1_240_000_000, yoyGrowthPct: 7.8, globalImportSharePct: 4.0, rationale: '工业园与矿业照明替换需求稳健，渠道毛利健康' },
      { code: 'AE', name: '阿联酋', labelEn: 'United Arab Emirates', importVolumeUsd: 1_090_000_000, yoyGrowthPct: 11.5, globalImportSharePct: 3.5, rationale: '中东基建与商业综合体项目拉动工程照明进口' },
    ],
  },
  {
    code: '847989',
    label: 'General industrial machinery & B2B equipment',
    labelZh: '通用工业机械与成套设备',
    keywords: ['machinery', 'equipment', 'industrial', 'manufacturing', 'mechanical', '机械', '设备', '工业设备', '成套'],
    markets: [
      { code: 'US', name: '美国', labelEn: 'United States', importVolumeUsd: 18_600_000_000, yoyGrowthPct: 7.8, globalImportSharePct: 18.4, rationale: '全球最大工业设备进口国，分销商与终端工厂采购面广' },
      { code: 'DE', name: '德国', labelEn: 'Germany', importVolumeUsd: 8_940_000_000, yoyGrowthPct: 5.6, globalImportSharePct: 8.8, rationale: '欧洲工业制造与系统集成中心，B2B 供应链成熟' },
      { code: 'NL', name: '荷兰', labelEn: 'Netherlands', importVolumeUsd: 5_420_000_000, yoyGrowthPct: 6.9, globalImportSharePct: 5.4, rationale: '欧洲进口分拨门户，贸易代理覆盖西欧与北欧' },
      { code: 'IT', name: '意大利', labelEn: 'Italy', importVolumeUsd: 4_180_000_000, yoyGrowthPct: 7.2, globalImportSharePct: 4.1, rationale: '制造与机械集成集群发达，中小型企业采购决策链路短' },
      { code: 'MX', name: '墨西哥', labelEn: 'Mexico', importVolumeUsd: 4_050_000_000, yoyGrowthPct: 13.4, globalImportSharePct: 4.0, rationale: '北美制造外溢核心受益国，工业产能扩建活跃' },
      { code: 'TH', name: '泰国', labelEn: 'Thailand', importVolumeUsd: 2_890_000_000, yoyGrowthPct: 9.8, globalImportSharePct: 2.9, rationale: '东盟制造枢纽，对中国高性价比工业设备接受度高' },
      { code: 'PL', name: '波兰', labelEn: 'Poland', importVolumeUsd: 2_760_000_000, yoyGrowthPct: 10.2, globalImportSharePct: 2.7, rationale: '中东欧工业增长主力，制造与分销网络完善' },
      { code: 'AE', name: '阿联酋', labelEn: 'United Arab Emirates', importVolumeUsd: 2_340_000_000, yoyGrowthPct: 12.1, globalImportSharePct: 2.3, rationale: '辐射中东与非洲的工业贸易及工程采购枢纽' },
    ],
  },
]);

export const DEFAULT_FALLBACK_HS_CODE = '847989' as const;
