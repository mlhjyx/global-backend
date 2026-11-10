/**
 * ISIC Rev.4 行业种子（出口/获客高频行业 —— TRUMPF 等出海制造场景的核心覆盖）。
 * 每个节点：ISIC code + 层级 parent + 中/英/德/意/法/西规范名 + 跨标准对照 + 发现标识
 * （Wikidata QID / OSM 标签）。长尾行业由冷路径 LLM 归一到这些码。
 * 别名(aliases)迁自旧 vocab.ts + 常见中英德意法西口语与产品词。
 *
 * 2026-11-10 行业词汇扩建：补能源设备（光伏/风电/储能）、电力电气、施工安装与 EPC、暖通 HVAC、
 * 泵阀流体、塑料包装、电子元器件、通信设备、汽车零部件、化工材料、批发进出口、工程服务、软件信息服务。
 * crosswalks.cpv 只锚定 cpv-seed.ts 里已核验的码（宁可少而准）；缺失 crosswalk 的行业在
 * ICP→CPV 冷路径会显式产生 icp_seed_gap warning，绝不静默。
 */
export interface IsicNode {
  code: string;
  parent?: string;
  en: string;
  zh: string;
  de?: string;
  it?: string;
  fr?: string;
  es?: string;
  crosswalks?: { cpv?: string[]; fdaPanels?: string[]; fdaProductCodes?: string[]; nace?: string[]; naics?: string[]; gb4754?: string[] };
  wikidataQid?: string;
  osmTags?: { k: string; v?: string }[];
  aliases?: string[]; // 归一到该 code 的别名（中/英/德/意/法/西/口语/产品词）
}

/**
 * 渠道角色词（分销商/批发商/进口商/零售商/贸易商）的 taxonomy kind。
 * 与 industry 分开存：角色词用于检索词构造（本地语言 query 后缀），不是行业身份本身。
 * 同一词可以同时出现在两个 kind 下（term_alias 唯一键是 (kind, term)）。
 */
export const INDUSTRY_ROLE_KIND = 'industry_role' as const;

export interface IndustryRoleNode {
  code: string;
  en: string;
  zh: string;
  de?: string;
  it?: string;
  fr?: string;
  es?: string;
  aliases: string[];
}

export const ISIC_SEED: IsicNode[] = [
  // Section C — Manufacturing
  { code: 'C', en: 'Manufacturing', zh: '制造业', de: 'Verarbeitendes Gewerbe', wikidataQid: 'Q187939',
    aliases: ['制造业', 'manufacturing', 'fertigung', '生产制造', 'industrial manufacturing'] },

  // Division 24 — Basic metals
  { code: '24', parent: 'C', en: 'Manufacture of basic metals', zh: '基本金属制造', de: 'Metallerzeugung',
    it: 'Fabbricazione di metalli di base', fr: 'Métallurgie', es: 'Fabricación de metales básicos',
    crosswalks: { nace: ['24'], naics: ['331'], gb4754: ['31', '32'] }, wikidataQid: 'Q206894',
    aliases: ['钢铁', 'steel', 'steel industry', 'basic metals', 'metallurgy', '冶金', 'stahl'] },

  // Division 25 — Fabricated metal products（钣金/金属加工核心）
  { code: '25', parent: 'C', en: 'Manufacture of fabricated metal products', zh: '金属制品制造', de: 'Herstellung von Metallerzeugnissen',
    it: 'Fabbricazione di prodotti in metallo', fr: 'Fabrication de produits métalliques', es: 'Fabricación de productos metálicos',
    crosswalks: { nace: ['25'], naics: ['332'], gb4754: ['33'] }, wikidataQid: 'Q19541171',
    osmTags: [{ k: 'craft', v: 'metal_construction' }, { k: 'craft', v: 'blacksmith' }],
    aliases: ['金属加工', 'metal fabrication', 'metalworking', 'metallverarbeitung', '金属制品', 'fabricated metal', 'metallbau'] },
  { code: '2599', parent: '25', en: 'Manufacture of other fabricated metal products (sheet metal)', zh: '钣金加工', de: 'Blechbearbeitung',
    crosswalks: { nace: ['25.99'], naics: ['332999'] }, wikidataQid: 'Q1857831',
    osmTags: [{ k: 'craft', v: 'metal_construction' }],
    aliases: ['钣金', 'sheet metal', 'sheet metal fabrication', 'blechbearbeitung', '激光切割', 'laser cutting', '折弯', 'bending', '焊接', 'welding'] },

  // Division 20 — Chemicals
  { code: '20', parent: 'C', en: 'Manufacture of chemicals and chemical products', zh: '化学原料与化学制品制造', de: 'Chemische Industrie',
    it: 'Fabbricazione di prodotti chimici', fr: 'Fabrication de produits chimiques', es: 'Fabricación de productos químicos',
    crosswalks: { cpv: ['24000000', '24300000', '24500000'], nace: ['20'], naics: ['325'], gb4754: ['26'] },
    aliases: ['化工', '化学工业', '化工材料', '化学材料', '化学品', '塑料原料', '树脂', '聚合物',
      'chemicals', 'chemical industry', 'chemical products', 'chemical materials', 'resin', 'polymers',
      'chemische industrie', 'chemie', 'chimica', 'prodotti chimici', 'industrie chimique', 'produits chimiques',
      'química', 'productos químicos'] },

  // Division 22 — Rubber and plastics（塑料包装核心）
  { code: '22', parent: 'C', en: 'Manufacture of rubber and plastics products', zh: '橡胶和塑料制品制造', de: 'Herstellung von Gummi- und Kunststoffwaren',
    it: 'Fabbricazione di articoli in gomma e materie plastiche', fr: 'Fabrication de produits en caoutchouc et en plastique', es: 'Fabricación de productos de caucho y plástico',
    crosswalks: { cpv: ['44617000', '44610000'], nace: ['22'], naics: ['326'], gb4754: ['29'] },
    aliases: ['塑料', '橡塑', '橡胶', 'plastic industry', 'plastics industry', 'rubber and plastics',
      'kunststoff', 'plastica', 'materie plastiche', 'plastique', 'plástico'] },
  { code: '2220', parent: '22', en: 'Manufacture of plastics products', zh: '塑料制品与包装制造', de: 'Herstellung von Kunststoffwaren',
    it: 'Fabbricazione di prodotti in plastica', fr: "Fabrication d'articles en plastique", es: 'Fabricación de artículos de plástico',
    crosswalks: { cpv: ['44617000', '44610000'], nace: ['22.2'], naics: ['3261'], gb4754: ['29'] },
    aliases: ['塑料制品', '塑料包装', '包装', '包装材料', '包装制品', '包装容器', '塑料包装制品',
      'plastic products', 'plastic packaging', 'packaging', 'packaging materials', 'packaging products', 'packaging containers',
      'kunststoffverpackungen', 'verpackung', 'verpackungen', 'imballaggi', 'emballages', 'emballage', 'envases', 'embalajes'] },

  // Division 28 — Machinery & equipment（机床/机械制造；泵阀流体词条在此）
  { code: '28', parent: 'C', en: 'Manufacture of machinery and equipment n.e.c.', zh: '通用及专用设备制造', de: 'Maschinenbau',
    it: 'Fabbricazione di macchinari e apparecchiature', fr: 'Fabrication de machines et équipements', es: 'Fabricación de maquinaria y equipo',
    crosswalks: { cpv: ['42120000', '42130000'], nace: ['28'], naics: ['333'], gb4754: ['34', '35'] }, wikidataQid: 'Q1857831',
    aliases: ['机械制造', 'mechanical engineering', 'machinery', 'maschinenbau', '机床', 'machine tool', 'machine tools', '装备制造', '设备制造',
      'pump', 'pumps', '泵', 'compressor', 'compressors', 'pumps and compressors', 'valve', 'valves', '阀门', '工业阀门', 'ventil', 'ventile',
      '泵阀', '泵阀贸易', '阀门贸易', '泵阀批发', '泵阀经销', '流体设备', 'fluid equipment', 'fluid handling', 'fluid technology', 'fluidtechnik',
      'pompes', 'vannes', 'pompe', 'valvole', 'compressori', 'bombas', 'válvulas', 'compresores'] },
  { code: '2811', parent: '28', en: 'Manufacture of engines and turbines, except aircraft, vehicle and cycle engines', zh: '发动机与涡轮机制造（含风电整机）',
    de: 'Herstellung von Verbrennungsmotoren und Turbinen', it: 'Fabbricazione di motori e turbine', fr: 'Fabrication de moteurs et turbines', es: 'Fabricación de motores y turbinas',
    crosswalks: { cpv: ['31121300', '42110000'], nace: ['28.11'], naics: ['333611'], gb4754: ['34', '35'] },
    aliases: ['风电', '风力发电', '风电整机', '风力发电机', '风电机组', '风能', '汽轮机', '燃气轮机', '涡轮机',
      'wind power', 'wind energy', 'wind turbine', 'wind turbines', 'wind farm', 'gas turbine', 'steam turbine', 'turbines',
      'Windkraft', 'Windenergie', 'Windkraftanlagen', 'Windturbinen', 'energia eolica', 'turbina eolica', 'aerogeneratore',
      'éolien', 'éolienne', 'energía eólica', 'aerogeneradores', 'turbinas'] },
  { code: '2819', parent: '28', en: 'Manufacture of other general-purpose machinery', zh: '其他通用设备制造（含暖通空调/热泵/制冷）',
    de: 'Herstellung von sonstigen Maschinen für allgemeine Zwecke', it: 'Fabbricazione di altre macchine per impieghi generali',
    fr: "Fabrication d'autres machines d'usage général", es: 'Fabricación de otra maquinaria de uso general',
    crosswalks: { cpv: ['42500000', '42510000', '42511110', '42160000'], nace: ['28.25', '28.29'], naics: ['333415'], gb4754: ['34', '35'] },
    aliases: ['暖通', '暖通空调', '中央空调', '空调', '制冷', '制冷设备', '热泵', '空气源热泵', '锅炉', '换热器', '通风设备',
      'hvac', 'heating', 'ventilation', 'air conditioning', 'air-conditioning', 'air conditioning equipment', 'refrigeration', 'refrigeration equipment',
      'heat pump', 'heat pumps', 'boiler', 'boilers', 'heat exchanger', 'heat exchangers', 'ventilation equipment',
      'Heizung', 'Lüftung', 'Klimatechnik', 'Kältetechnik', 'Wärmepumpe', 'Wärmepumpen', 'Kessel', 'Wärmetauscher',
      'riscaldamento', 'climatizzazione', 'condizionamento', 'pompa di calore', 'pompe di calore', 'refrigerazione',
      'chauffage', 'climatisation', 'pompe à chaleur', 'chaudière', 'échangeur de chaleur',
      'calefacción', 'climatización', 'bomba de calor', 'calderas', 'intercambiador de calor'] },

  // Division 29 — Motor vehicles（零部件落 2930）
  { code: '29', parent: 'C', en: 'Manufacture of motor vehicles, trailers and semi-trailers', zh: '汽车制造', de: 'Fahrzeugbau',
    it: 'Fabbricazione di autoveicoli', fr: 'Industrie automobile', es: 'Fabricación de vehículos de motor',
    crosswalks: { cpv: ['34100000', '34300000'], nace: ['29'], naics: ['3361', '3362', '3363'], gb4754: ['36'] }, wikidataQid: 'Q190117',
    aliases: ['汽车', 'automotive', 'automotive industry', 'automobil', 'car manufacturing', '汽车制造'] },
  { code: '2930', parent: '29', en: 'Manufacture of parts and accessories for motor vehicles', zh: '汽车零部件与配件制造',
    de: 'Herstellung von Teilen und Zubehör für Kraftwagen', it: 'Fabbricazione di parti e accessori per autoveicoli',
    fr: "Fabrication de pièces et accessoires pour véhicules automobiles", es: 'Fabricación de partes y accesorios para vehículos de motor',
    crosswalks: { cpv: ['34300000', '34100000'], nace: ['29.3'], naics: ['3363'], gb4754: ['36'] },
    aliases: ['汽车零部件', '汽配', '汽车配件', '零部件', '一级供应商',
      'auto parts', 'automotive parts', 'car parts', 'auto components', 'automotive components', 'spare parts',
      'tier 1', 'tier1', 'tier1 supplier', 'tier one supplier',
      'Kfz-Teile', 'Autoteile', 'Zulieferer', 'ricambi auto', 'componentistica auto', 'pièces automobiles', 'équipementiers',
      'recambios', 'autopartes', 'componentes de automoción'] },

  // Division 303 — Aerospace
  { code: '303', parent: 'C', en: 'Manufacture of air and spacecraft', zh: '航空航天器制造', de: 'Luft- und Raumfahrt',
    it: 'Fabbricazione di aeromobili e veicoli spaziali', fr: 'Construction aéronautique et spatiale', es: 'Fabricación de aeronaves y naves espaciales',
    crosswalks: { cpv: ['34700000'], nace: ['30.3'], naics: ['3364'] }, wikidataQid: 'Q765633',
    aliases: ['航空航天', 'aerospace', 'aviation', 'luft- und raumfahrt', '航空', '航天'] },

  // Division 33 — Repair and installation of machinery（设备安装/Anlagenbau）
  { code: '33', parent: 'C', en: 'Repair and installation of machinery and equipment', zh: '机械设备的修理与安装', de: 'Reparatur und Installation von Maschinen und Ausrüstungen',
    it: 'Riparazione e installazione di macchine e apparecchiature', fr: 'Réparation et installation de machines et équipements', es: 'Reparación e instalación de maquinaria y equipo',
    crosswalks: { cpv: ['45350000'], nace: ['33'], naics: ['8113'], gb4754: ['43'] },
    aliases: ['设备维修', '机械维修', 'installation of machinery', 'machinery repair', 'Maschinenreparatur'] },
  { code: '3320', parent: '33', en: 'Installation of industrial machinery and equipment', zh: '工业设备安装与成套（Anlagenbau）',
    de: 'Installation von industriellen Maschinen und Ausrüstungen', it: 'Installazione di macchinari e attrezzature industriali',
    fr: "Installation de machines et équipements industriels", es: 'Instalación de máquinas y equipos industriales',
    crosswalks: { cpv: ['45350000'], nace: ['33.2'], naics: ['238'], gb4754: ['43'] },
    aliases: ['设备安装', '工业设备安装', '设备成套', '成套设备', '工厂建设',
      'plant engineering', 'plant construction', 'industrial installation', 'machinery installation', 'industrial plant construction',
      'Anlagenbau', 'impiantistica', 'installazione impianti', 'montage industriel', 'montaje industrial', 'instalaciones industriales'] },

  // Division 26 — Electronics（元器件/通信设备子节点）
  { code: '26', parent: 'C', en: 'Manufacture of computer, electronic and optical products', zh: '电子及光学产品制造', de: 'Elektronik',
    it: 'Fabbricazione di prodotti elettronici e ottici', fr: 'Fabrication de produits informatiques, électroniques et optiques', es: 'Fabricación de productos informáticos, electrónicos y ópticos',
    crosswalks: { cpv: ['31700000', '32000000'], nace: ['26'], naics: ['334'], gb4754: ['39', '40'] }, wikidataQid: 'Q11650',
    aliases: ['电子', 'electronics', 'elektronik', '电子制造', 'consumer electronics'] },
  { code: '261', parent: '26', en: 'Manufacture of electronic components and boards', zh: '电子元器件与电路板制造',
    de: 'Herstellung von elektronischen Bauelementen und Leiterplatten', it: 'Fabbricazione di componenti elettronici',
    fr: 'Fabrication de composants électroniques', es: 'Fabricación de componentes electrónicos',
    crosswalks: { cpv: ['31700000', '32000000'], nace: ['26.1'], naics: ['3344'], gb4754: ['39'] },
    aliases: ['电子元器件', '元器件', '电子元件', '被动元件', '电路板', '印制电路板',
      'electronic components', 'electronic component', 'components', 'pcb', 'pcba', 'printed circuit board', 'circuit boards',
      'elektronikkomponenten', 'bauelemente', 'componenti elettronici', 'composants électroniques', 'componentes electrónicos'] },
  { code: '2630', parent: '26', en: 'Manufacture of communication equipment', zh: '通信设备制造',
    de: 'Herstellung von Geräten für die Telekommunikation', it: 'Fabbricazione di apparecchiature di comunicazione',
    fr: "Fabrication d'équipements de communication", es: 'Fabricación de equipos de comunicación',
    crosswalks: { cpv: ['32000000', '32500000'], nace: ['26.3'], naics: ['3342'], gb4754: ['39'] },
    aliases: ['通信设备', '通讯设备', '网络设备', '5g', 'telecom equipment', 'telecommunication equipment', 'communication equipment', 'network equipment',
      'telekommunikationstechnik', 'apparati di telecomunicazione', 'équipements de télécommunication', 'equipos de telecomunicaciones'] },

  // 医疗器械制造（→ FDA 专科 panel crosswalk，供 ICP→FDA 产品码映射 P2；panel 码见 seed-taxonomy FDA_PANEL_SEED）。
  // fdaPanels 只列**已种子 product code 的 panel**（当前 curated=放射 RA）——绝不 over-claim 无码 panel（否则非放射 ICP 静默拿到放射码）。
  // 扩种子（foiclass 全表 / 其它专科）后同步加 panel。wikidataQid=Q6554101（medical device，非 Q12140=medication/药品）。
  { code: '325', parent: 'C', en: 'Manufacture of medical and dental instruments and supplies', zh: '医疗器械制造', de: 'Medizintechnik',
    it: 'Fabbricazione di strumenti medicali e dentari', fr: "Fabrication d'instruments médicaux et dentaires", es: 'Fabricación de instrumentos médicos y dentales',
    crosswalks: { fdaPanels: ['RA'], nace: ['32.5'], naics: ['3391'] }, wikidataQid: 'Q6554101',
    aliases: ['医疗器械', 'medical device', 'medical devices', 'medical equipment', '医疗设备', 'medtech', 'radiology', '放射', '放射影像', 'imaging', 'medical imaging', 'diagnostic imaging', '医学影像', 'radiology imaging devices'] },
  { code: '2610', parent: '26', en: 'Manufacture of electronic components (semiconductors)', zh: '半导体制造', de: 'Halbleiter',
    it: 'Fabbricazione di componenti elettronici (semiconduttori)', fr: 'Fabrication de composants électroniques (semi-conducteurs)', es: 'Fabricación de componentes electrónicos (semiconductores)',
    crosswalks: { nace: ['26.11'], naics: ['334413'] }, wikidataQid: 'Q11661',
    aliases: ['半导体', 'semiconductor', 'semiconductors', 'halbleiter', '芯片', 'chip', '集成电路'] },

  // Division 27 — Electrical equipment（电气设备全链）
  { code: '27', parent: 'C', en: 'Manufacture of electrical equipment', zh: '电气设备制造', de: 'Herstellung von elektrischen Ausrüstungen',
    it: 'Fabbricazione di apparecchiature elettriche', fr: "Fabrication d'équipements électriques", es: 'Fabricación de equipo eléctrico',
    crosswalks: { cpv: ['31000000'], nace: ['27'], naics: ['335'], gb4754: ['38'] },
    aliases: ['电气', '电气设备', '电力设备', '电气制造',
      'electrical equipment', 'electrical machinery', 'electrical industry', 'elektrische ausrüstung', 'elektrotechnik',
      'apparecchiature elettriche', 'électrotechnique', 'équipements électriques', 'material eléctrico'] },
  { code: '271', parent: '27', en: 'Manufacture of electric motors, generators, transformers and electricity distribution and control apparatus', zh: '电机、发电机与输配电控制设备制造',
    de: 'Herstellung von Elektromotoren, Generatoren, Transformatoren und Stromverteilungs- und -steuergeräten',
    it: 'Fabbricazione di motori, generatori e trasformatori elettrici', fr: 'Fabrication de moteurs, générateurs et transformateurs électriques',
    es: 'Fabricación de motores, generadores y transformadores eléctricos',
    crosswalks: { cpv: ['31100000', '31200000'], nace: ['27.11', '27.12'], naics: ['335311', '335312'], gb4754: ['38'] },
    aliases: ['电机', '电动机', '发电机', '变压器', '配电设备', '配电柜', '开关柜', '成套电气', '高低压成套', '逆变器', '光伏逆变器', '变频器',
      'electric motor', 'electric motors', 'motors', 'generators', 'transformer', 'transformers', 'switchgear', 'distribution board',
      'inverter', 'inverters', 'converters', 'Wechselrichter', 'Frequenzumrichter',
      'motori elettrici', 'trasformatori', 'generatori', 'moteurs électriques', 'transformateurs', 'motores eléctricos', 'transformadores', 'generadores'] },
  // Division 272 — 电池/储能（沿用既有码 272，补 CPV 锚与储能别名）
  { code: '272', parent: '27', en: 'Manufacture of batteries and accumulators', zh: '电池制造', de: 'Batterieherstellung',
    it: 'Fabbricazione di batterie e accumulatori', fr: 'Fabrication de piles et accumulateurs', es: 'Fabricación de pilas y acumuladores',
    crosswalks: { cpv: ['31400000'], nace: ['27.2'], naics: ['335910'] }, wikidataQid: 'Q12705122',
    aliases: ['新能源', 'renewable energy', '新能源电池', 'battery', 'batteries', 'new energy', '动力电池', 'energy storage',
      '储能', '储能系统', '储能电池', '蓄电池', '蓄电池组', '锂电', '锂电池', '电芯',
      'lithium battery', 'lithium batteries', 'lithium-ion', 'battery storage', 'accumulators', 'batteries and accumulators',
      'Batteriespeicher', 'batterie', 'accumulateurs', 'baterías', 'acumuladores'] },
  { code: '273', parent: '27', en: 'Manufacture of wiring and wiring devices', zh: '电线电缆与布线器件制造',
    de: 'Herstellung von Kabeln und elektrischem Installationsmaterial', it: 'Fabbricazione di fili e cavi',
    fr: 'Fabrication de fils et câbles', es: 'Fabricación de hilos y cables',
    crosswalks: { cpv: ['31300000'], nace: ['27.3'], naics: ['3359'], gb4754: ['38'] },
    aliases: ['电线电缆', '电缆', '线缆', '布电线', 'wire and cable', 'wires and cables', 'cable', 'cables',
      'kabel und leitungen', 'cavi elettrici', 'câbles électriques', 'cables eléctricos'] },
  { code: '274', parent: '27', en: 'Manufacture of electric lighting equipment', zh: '照明设备制造',
    de: 'Herstellung von Lampen und Leuchten', it: 'Fabbricazione di apparecchiature per illuminazione',
    fr: "Fabrication d'appareils d'éclairage", es: 'Fabricación de equipo de iluminación',
    crosswalks: { cpv: ['31500000'], nace: ['27.4'], naics: ['3351'], gb4754: ['38'] },
    aliases: ['照明', '灯具', '照明设备', 'led照明', 'lighting', 'lighting equipment', 'luminaires', 'led lighting',
      'beleuchtung', 'leuchten', 'illuminazione', 'apparecchi di illuminazione', 'éclairage', 'iluminación', 'luminarias'] },
  { code: '279', parent: '27', en: 'Manufacture of other electrical equipment', zh: '其他电气设备制造（含光伏组件、充电桩）',
    de: 'Herstellung von sonstigen elektrischen Ausrüstungen', it: 'Fabbricazione di altre apparecchiature elettriche',
    fr: "Fabrication d'autres équipements électriques", es: 'Fabricación de otro equipo eléctrico',
    crosswalks: { cpv: ['09331200', '09330000', '09331000', '31600000'], nace: ['27.9'], naics: ['3359'], gb4754: ['38'] },
    aliases: ['光伏', '光伏组件', '光伏设备', '光伏产业链', '太阳能', '太阳能电池', '太阳能电池板', '太阳能组件',
      '充电桩', '充电设备', '电动汽车充电', '储能变流器',
      'solar', 'solar energy', 'solar power', 'solar panel', 'solar panels', 'solar module', 'solar modules',
      'photovoltaic', 'photovoltaics', 'pv', 'pv modules', 'solar cells', 'ev charging', 'charging station', 'charging stations',
      'solarenergie', 'photovoltaik', 'solarmodule', 'ladeinfrastruktur',
      'energia solare', 'fotovoltaico', 'pannelli solari', 'énergie solaire', 'photovoltaïque', 'panneaux solaires',
      'energía solar', 'fotovoltaica', 'paneles solares'] },

  // Section D — 电力、燃气与蒸汽供应（能源公司/公用事业）
  { code: '35', en: 'Electricity, gas, steam and air conditioning supply', zh: '电力、燃气与蒸汽供应', de: 'Energieversorgung',
    it: 'Fornitura di energia elettrica, gas, vapore e aria condizionata', fr: "Production et distribution d'électricité, de gaz, de vapeur",
    es: 'Suministro de energía eléctrica, gas, vapor y aire acondicionado',
    crosswalks: { cpv: ['09000000', '09300000'], nace: ['35'], naics: ['2211'], gb4754: ['44'] },
    aliases: ['电力', '电力公司', '发电', '发电厂', '电网', '能源公司', '公用事业',
      'utility', 'utilities', 'power company', 'power generation', 'energy company', 'energy supplier', 'energy supply',
      'stromversorgung', 'energieversorgung', 'energia elettrica', 'fornitura di energia', 'électricité', "fournisseur d'énergie",
      'electricidad', 'compañía eléctrica'] },

  // Section F — Construction（41/42/43 + 安装子节点）
  { code: '41', en: 'Construction of buildings', zh: '房屋建筑施工', de: 'Hochbau',
    it: 'Costruzione di edifici', fr: 'Construction de bâtiments', es: 'Construcción de edificios',
    crosswalks: { cpv: ['45000000', '45200000'], nace: ['41'], naics: ['236'], gb4754: ['47'] },
    aliases: ['建筑施工', '房屋建筑', '建筑公司', '建筑工程', '总承包', '土建', '建筑',
      'building construction', 'general contractor', 'general contracting', 'construction company',
      'hochbau', 'bauunternehmen', 'edilizia', 'costruzioni', 'construction de bâtiments', 'entreprise générale',
      'construcción de edificios', 'constructora'] },
  { code: '42', en: 'Civil engineering', zh: '土木工程与基础设施（EPC）', de: 'Tiefbau',
    it: 'Ingegneria civile', fr: 'Génie civil', es: 'Ingeniería civil',
    crosswalks: { cpv: ['45200000', '45100000'], nace: ['42'], naics: ['237'], gb4754: ['48'] },
    aliases: ['土木工程', '基建', '基础设施建设', '工程总承包', 'epc', 'epc contractor', 'epc 总承包', '设计采购施工',
      'civil engineering', 'infrastructure construction', 'infrastructure',
      'tiefbau', 'infrastruktur', 'ingegneria civile', 'costruzioni infrastrutturali', 'génie civil', 'infrastructures',
      'ingeniería civil', 'obra civil', 'infraestructuras'] },
  { code: '43', en: 'Specialized construction activities', zh: '建筑安装与专业施工（含零碳建筑改造）', de: 'Bauinstallation und Ausbaugewerbe',
    it: 'Lavori di costruzione specializzati', fr: 'Travaux de construction spécialisés', es: 'Actividades de construcción especializada',
    crosswalks: { cpv: ['45300000', '45400000', '45000000'], nace: ['43'], naics: ['238'], gb4754: ['49', '50'] },
    aliases: ['建筑安装', '专业施工', '装饰装修', '装修', '机电安装', '机电工程',
      '零碳建筑', '零碳', '绿色建筑', '近零能耗建筑', '被动房', '建筑节能', '节能改造', '建筑改造',
      'building installation', 'special trade construction', 'fit-out', 'mep', 'mechanical and electrical installation', 'mechanical and electrical', 'm&e',
      'zero carbon building', 'zero-carbon', 'green building', 'passive house', 'building retrofit', 'energy retrofit', 'retrofit',
      'decarbonisation', 'decarbonization',
      'bauinstallation', 'ausbau', 'gebäudesanierung', 'sanierung', 'edilizia specializzata', 'ristrutturazione',
      'travaux spécialisés', 'rénovation', 'réhabilitation', 'construcción especializada', 'rehabilitación', 'reforma'] },
  { code: '4321', parent: '43', en: 'Electrical installation', zh: '电气安装与楼宇自控', de: 'Elektroinstallation',
    it: 'Installazione elettrica', fr: 'Installation électrique', es: 'Instalación eléctrica',
    crosswalks: { cpv: ['45310000'], nace: ['43.21'], naics: ['23821'], gb4754: ['49'] },
    aliases: ['电气安装', '建筑电气', '楼宇自控', '智能建筑', '弱电', '强电', '综合布线',
      'electrical installation', 'building automation', 'bms', 'building management system', 'smart building', 'low voltage', 'electrical contracting',
      'gebäudeautomation', 'gebäudetechnik', 'installazione elettrica', 'impianti elettrici', 'automazione edifici',
      'installation électrique', 'électricité du bâtiment', 'instalación eléctrica', 'domótica', 'instalaciones eléctricas'] },
  { code: '4322', parent: '43', en: 'Plumbing, heat and air-conditioning installation', zh: '管道与暖通安装', de: 'Sanitär-, Heizungs- und Klimainstallation',
    it: 'Installazione di impianti idraulici e di riscaldamento', fr: 'Installation de plomberie et de chauffage', es: 'Instalación de fontanería y calefacción',
    crosswalks: { cpv: ['45331000', '45350000'], nace: ['43.22'], naics: ['23822'], gb4754: ['49'] },
    aliases: ['管道安装', '暖通安装', '水暖', '水暖安装', '卫生洁具安装',
      'plumbing', 'plumbing and heating', 'heating installation', 'hvac installation', 'sanitary installation',
      'sanitärinstallation', 'heizungsbau', 'haustechnik', 'installazione impianti termici', 'idraulica',
      'plomberie', 'instalación de fontanería'] },

  // Section G — Wholesale trade（批发与进出口）
  { code: '46', en: 'Wholesale trade, except of motor vehicles and motorcycles', zh: '批发与进出口贸易', de: 'Großhandel (ohne Handel mit Kraftfahrzeugen)',
    it: "Commercio all'ingrosso (esclusi autoveicoli)", fr: 'Commerce de gros (sauf automobiles)', es: 'Comercio al por mayor (excepto vehículos de motor)',
    crosswalks: { nace: ['46'], naics: ['423', '424'], gb4754: ['51'] },
    aliases: ['批发', '批发业', '贸易', '贸易公司', '进出口', '进出口贸易', '外贸', '对外贸易', '进口', '出口', '进口商', '出口商',
      'wholesale', 'wholesale trade', 'trading', 'trade', 'import', 'export', 'imports', 'exports', 'importer', 'exporter', 'import and export', 'trading company',
      'commercio all\'ingrosso', 'importazione', 'esportazione', 'commerce de gros', 'importation', 'exportation',
      'comercio al por mayor', 'importación', 'exportación'] },
  { code: '4659', parent: '46', en: 'Wholesale of other machinery and equipment', zh: '机械设备批发（工业分销）', de: 'Großhandel mit sonstigen Maschinen und Ausrüstungen',
    it: "Commercio all'ingrosso di altre macchine e attrezzature", fr: "Commerce de gros d'autres machines et équipements", es: 'Comercio al por mayor de otras máquinas y equipos',
    // 不给 cpv 锚：批发节点的宽锚（如 42120000）会污染 TED 中标反查（公司被归一成批发而非制造）。
    crosswalks: { nace: ['46.6'], naics: ['423830'], gb4754: ['51'] },
    aliases: ['机械设备批发', '工业品分销', '工业分销商',
      'industrial distributor', 'industrial distributors', 'machinery distributor', 'machinery wholesale', 'industrial supply', 'industrial supplies', 'machinery trading'] },
  { code: '4663', parent: '46', en: 'Wholesale of construction materials, hardware, plumbing and heating equipment', zh: '建材与暖通批发', de: 'Großhandel mit Baumaterialien, Eisenwaren sowie Sanitär- und Heizungsbedarf',
    it: "Commercio all'ingrosso di materiali da costruzione e articoli sanitari", fr: 'Commerce de gros de matériaux de construction et de sanitaires', es: 'Comercio al por mayor de materiales de construcción y sanitarios',
    crosswalks: { cpv: ['44100000', '44600000'], nace: ['46.73', '46.74'], naics: ['4237'], gb4754: ['51'] },
    aliases: ['建材批发', '建材贸易', '建材', '水暖器材', '卫浴批发', '暖通批发', '五金批发',
      'construction materials wholesale', 'building materials wholesale', 'building materials', 'plumbing supplies', 'plumbing wholesale', 'heating supplies', 'hardware wholesale',
      'baustoffhandel', 'materiali da costruzione', 'matériaux de construction', 'materiales de construcción'] },

  // Section J — Information and communication（软件与信息服务）
  { code: '62', en: 'Computer programming, consultancy and related activities', zh: '软件与信息技术服务', de: 'Informationstechnologie und Softwareentwicklung',
    it: 'Programmazione, consulenza informatica e attività connesse', fr: 'Programmation, conseil et autres activités informatiques', es: 'Programación, consultoría y otras actividades informáticas',
    crosswalks: { cpv: ['72000000', '72200000'], nace: ['62'], naics: ['5415'], gb4754: ['65'] },
    aliases: ['软件', '软件开发', '软件公司', '信息技术', '信息服务', '系统集成',
      'software', 'software development', 'software company', 'information technology', 'information services', 'system integration', 'saas', 'cloud', 'cloud computing',
      'softwareentwicklung', 'it-dienstleistungen', 'informatica', 'sviluppo software', 'logiciel', 'développement logiciel', 'services informatiques',
      'desarrollo de software', 'servicios informáticos'] },

  // Section M — Professional, scientific and technical activities（工程服务）
  { code: '71', en: 'Architectural and engineering activities; technical testing and analysis', zh: '工程与技术服务（设计/咨询）', de: 'Architektur- und Ingenieurbüros; technische Prüfung',
    it: "Attività degli studi di architettura e d'ingegneria", fr: "Activités d'architecture et d'ingénierie", es: 'Actividades de arquitectura e ingeniería',
    crosswalks: { cpv: ['71000000', '71320000', '71334000'], nace: ['71'], naics: ['5413'], gb4754: ['74'] },
    aliases: ['工程服务', '工程咨询', '工程设计', '勘察设计', '设计院', '技术咨询',
      'engineering services', 'engineering consultancy', 'engineering design', 'design institute', 'engineering company', 'architectural and engineering',
      'ingenieurbüro', 'ingenieurdienstleistungen', 'ingegneria', 'studio di ingegneria', 'ingénierie', "bureau d'études",
      'ingeniería', 'servicios de ingeniería'] },
];

/**
 * 渠道角色词种子：kind=industry_role（与 industry 分开），code 指向角色节点。
 * 供检索词构造（本地语言 query 后缀：Händler/Großhandel/rivenditore/distributeur/mayorista…）使用；
 * 不改查询构造代码（search-localization 由并行会话维护，这里只提供数据面）。
 */
export const INDUSTRY_ROLE_SEED: IndustryRoleNode[] = [
  { code: 'DISTRIBUTOR', en: 'Distributor', zh: '分销商/经销商', de: 'Distributor', it: 'Distributore', fr: 'Distributeur', es: 'Distribuidor',
    aliases: ['distributor', 'distributors', '经销商', '分销商', '代理商', '渠道商', 'dealer', 'dealers', 'reseller', 'resellers',
      'distributore', 'distributori', 'distributeur', 'distributeurs', 'distribuidor', 'distribuidores',
      'revendeur', 'revendeurs', 'rivenditore', 'rivenditori', 'händler', 'haendler', 'fachhandel'] },
  { code: 'WHOLESALER', en: 'Wholesaler', zh: '批发商', de: 'Großhandel', it: 'Grossista', fr: 'Grossiste', es: 'Mayorista',
    aliases: ['wholesaler', 'wholesalers', '批发商', '批发', 'großhandel', 'grosshandel', 'grossista', 'grossisti',
      'grossiste', 'grossistes', 'mayorista', 'mayoristas', 'atacadista', 'hurtownia'] },
  { code: 'IMPORTER', en: 'Importer', zh: '进口商', de: 'Importeur', it: 'Importatore', fr: 'Importateur', es: 'Importador',
    aliases: ['importer', 'importers', '进口商', 'importeur', 'importeure', 'importatore', 'importatori',
      'importateur', 'importateurs', 'importador', 'importadores', 'import company', 'import and export company'] },
  { code: 'TRADER', en: 'Trading company', zh: '贸易商', de: 'Handelsunternehmen', it: 'Società commerciale', fr: 'Société de négoce', es: 'Comercializadora',
    aliases: ['trader', 'traders', 'trading company', 'trading companies', '贸易商', '贸易公司',
      'handelsunternehmen', 'handelsgesellschaft', 'società commerciale', 'commerciante', 'société de négoce', 'négociant',
      'comercializadora'] },
  { code: 'RETAILER', en: 'Retailer', zh: '零售商', de: 'Einzelhandel', it: 'Dettagliante', fr: 'Détaillant', es: 'Minorista',
    aliases: ['retailer', 'retailers', '零售商', '零售', 'einzelhandel', 'dettagliante', 'dettaglianti',
      'détaillant', 'détaillants', 'minorista', 'minoristas', 'comercio minorista'] },
];
