/**
 * CPV 2008 子树种子（有界·手工核验·frozen source='seed'，非全 ~9450 码树）。
 *
 * 覆盖出口/获客高频族：09 能源（含太阳能）、24 化工、31 电气机械（含风电）、32 通信、
 * 34 运输设备、42 工业机械（泵阀/暖通/热泵）、43 施工机械、44 建材、45 施工安装、71 工程服务、72 IT。
 * 每个码都对照过 CPV 官方浏览器（cpvcodes.eu / EUR-Lex Reg. 213/2008 清单 / TED 公告用法）；
 * **宁可少而准**：未核实的码不进来。en 标签为官方英文名，zh/de 为检索用译名。
 *
 * 8 位码 + parentCode 自引用（前缀嵌套）；parent 为 null 表示族根。
 * 供 ISIC.crosswalks.cpv 锚定（isic-seed.ts）+ 产品精修枚举 + node('cpv',code) 校验。
 * seed-taxonomy.mjs 从这里取数（经 dist），保持可重复执行（upsert）。
 */
export interface CpvSeedNode {
  code: string;
  parent: string | null;
  en: string;
  zh?: string;
  de?: string;
}

export const CPV_SEED: CpvSeedNode[] = [
  // ── 09 石油制品、燃料、电力与其他能源（含太阳能族）──────────────────────────
  { code: '09000000', parent: null, en: 'Petroleum products, fuel, electricity and other sources of energy', zh: '石油制品、燃料、电力与其他能源', de: 'Mineralölerzeugnisse, Brennstoffe, Elektrizität und andere Energiequellen' },
  { code: '09300000', parent: '09000000', en: 'Electricity, heating, solar and nuclear energy', zh: '电力、供热、太阳能与核能', de: 'Elektrizität, Heizung, Sonnen- und Kernenergie' },
  { code: '09330000', parent: '09300000', en: 'Solar energy', zh: '太阳能', de: 'Sonnenenergie' },
  { code: '09331000', parent: '09330000', en: 'Solar panels', zh: '太阳能电池板', de: 'Solarpaneele' },
  { code: '09331100', parent: '09330000', en: 'Solar collectors for heat production', zh: '太阳能集热器', de: 'Sonnenkollektoren zur Wärmeerzeugung' },
  { code: '09331200', parent: '09330000', en: 'Solar photovoltaic modules', zh: '光伏组件', de: 'Photovoltaikmodule' },
  { code: '09332000', parent: '09330000', en: 'Solar installation', zh: '太阳能装置安装', de: 'Installation von Solaranlagen' },

  // ── 24 化学产品 ─────────────────────────────────────────────────────────
  { code: '24000000', parent: null, en: 'Chemical products', zh: '化学产品', de: 'Chemische Erzeugnisse' },
  { code: '24300000', parent: '24000000', en: 'Basic inorganic and organic chemicals', zh: '基础无机与有机化学品', de: 'Anorganische und organische Grundchemikalien' },
  { code: '24500000', parent: '24000000', en: 'Plastics in primary forms', zh: '初级形态塑料', de: 'Kunststoffe in Primärformen' },

  // ── 31 电气机械、装置、设备与耗材；照明（含风电族）─────────────────────────
  { code: '31000000', parent: null, en: 'Electrical machinery, apparatus, equipment and consumables; lighting', zh: '电气机械、装置、设备与耗材；照明', de: 'Elektrische Maschinen, Geräte, Ausrüstungen und Verbrauchsmaterialien; Beleuchtung' },
  { code: '31100000', parent: '31000000', en: 'Electric motors, generators and transformers', zh: '电机、发电机与变压器', de: 'Elektromotoren, Generatoren und Transformatoren' },
  { code: '31121000', parent: '31100000', en: 'Generating sets', zh: '发电机组', de: 'Stromerzeugungsaggregate' },
  { code: '31121300', parent: '31121000', en: 'Wind-energy generators', zh: '风能发电机', de: 'Windenergieanlagen' },
  { code: '31121310', parent: '31121300', en: 'Windmills', zh: '风力机', de: 'Windmühlen' },
  { code: '31121320', parent: '31121300', en: 'Wind turbines', zh: '风力涡轮机', de: 'Windturbinen' },
  { code: '31121330', parent: '31121300', en: 'Wind turbine generators', zh: '风力发电机组', de: 'Windkraftgeneratoren' },
  { code: '31121340', parent: '31121300', en: 'Wind farm', zh: '风电场', de: 'Windpark' },
  { code: '31200000', parent: '31000000', en: 'Electricity distribution and control apparatus', zh: '配电与控制装置', de: 'Geräte zur Elektrizitätsverteilung und -steuerung' },
  { code: '31300000', parent: '31000000', en: 'Insulated wire and cable', zh: '绝缘电线电缆', de: 'Isolierte Drähte und Kabel' },
  { code: '31400000', parent: '31000000', en: 'Accumulators, primary cells and primary batteries', zh: '蓄电池、原电池与电池组', de: 'Akkumulatoren, Primärzellen und Batterien' },
  { code: '31500000', parent: '31000000', en: 'Lighting equipment and electric lamps', zh: '照明设备与电灯', de: 'Beleuchtungsgeräte und elektrische Lampen' },
  { code: '31600000', parent: '31000000', en: 'Electrical equipment and apparatus', zh: '电气设备与装置', de: 'Elektrische Geräte und Ausrüstungen' },
  { code: '31700000', parent: '31000000', en: 'Electronic, electromechanical and electrotechnical supplies', zh: '电子、机电与电工用品', de: 'Elektronische, elektromechanische und elektrotechnische Erzeugnisse' },

  // ── 32 通信设备 ─────────────────────────────────────────────────────────
  { code: '32000000', parent: null, en: 'Radio, television, communication, telecommunication and related equipment', zh: '广播、电视与通信设备', de: 'Rundfunk-, Fernseh-, Kommunikations- und Telekommunikationsgeräte' },
  { code: '32500000', parent: '32000000', en: 'Telecommunications equipment and supplies', zh: '电信设备与用品', de: 'Telekommunikationsgeräte und -bedarf' },

  // ── 34 运输设备（含汽车零部件/航空航天）──────────────────────────────────
  { code: '34000000', parent: null, en: 'Transport equipment and auxiliary products to transportation', zh: '运输设备与运输辅助产品', de: 'Transportausrüstungen und Transportzubehör' },
  { code: '34100000', parent: '34000000', en: 'Motor vehicles', zh: '机动车', de: 'Kraftfahrzeuge' },
  { code: '34300000', parent: '34000000', en: 'Parts and accessories for vehicles and their engines', zh: '车辆及其发动机的零部件与附件', de: 'Teile und Zubehör für Fahrzeuge und deren Motoren' },
  { code: '34320000', parent: '34300000', en: 'Mechanical spare parts except engines and engine parts', zh: '机械备件（发动机及发动机零件除外）', de: 'Mechanische Ersatzteile (außer Motoren und Motorenteilen)' },
  { code: '34700000', parent: '34000000', en: 'Aircraft and spacecraft', zh: '航空器与航天器', de: 'Luft- und Raumfahrzeuge' },

  // ── 42 工业机械（泵阀 / 暖通 / 热泵 / 锅炉）───────────────────────────────
  { code: '42000000', parent: null, en: 'Industrial machinery', zh: '工业机械', de: 'Industrielle Maschinen' },
  { code: '42100000', parent: '42000000', en: 'Machinery for the production and use of mechanical power', zh: '机械动力生产与使用设备', de: 'Maschinen zur Erzeugung und Nutzung mechanischer Energie' },
  { code: '42110000', parent: '42100000', en: 'Turbines and motors', zh: '涡轮机与电动机', de: 'Turbinen und Motoren' },
  { code: '42120000', parent: '42100000', en: 'Pumps and compressors', zh: '泵与压缩机', de: 'Pumpen und Kompressoren' },
  { code: '42122000', parent: '42120000', en: 'Pumps', zh: '泵', de: 'Pumpen' },
  { code: '42122130', parent: '42122000', en: 'Water pumps', zh: '水泵', de: 'Wasserpumpen' },
  { code: '42123000', parent: '42120000', en: 'Compressors', zh: '压缩机', de: 'Kompressoren' },
  { code: '42130000', parent: '42100000', en: 'Taps, cocks, valves and similar appliances', zh: '龙头、旋塞、阀门及类似装置', de: 'Hähne, Ventile und ähnliche Armaturen' },
  { code: '42160000', parent: '42100000', en: 'Boiler installations', zh: '锅炉装置', de: 'Kesselanlagen' },
  { code: '42500000', parent: '42000000', en: 'Cooling and ventilation equipment', zh: '制冷与通风设备', de: 'Kühl- und Lüftungsgeräte' },
  { code: '42510000', parent: '42500000', en: 'Heat-exchange units, air-conditioning and refrigerating equipment, and filtering machinery', zh: '换热器、空调与制冷设备及过滤设备', de: 'Wärmetauscher, Klima- und Kältegeräte sowie Filteranlagen' },
  { code: '42511110', parent: '42510000', en: 'Heat pumps', zh: '热泵', de: 'Wärmepumpen' },
  { code: '42520000', parent: '42500000', en: 'Ventilation equipment', zh: '通风设备', de: 'Lüftungsgeräte' },
  { code: '42530000', parent: '42500000', en: 'Parts of refrigerating and freezing equipment and heat pumps', zh: '制冷、冷冻设备与热泵零件', de: 'Teile von Kälte- und Gefriergeräten und Wärmepumpen' },
  { code: '42533000', parent: '42530000', en: 'Parts of heat pumps', zh: '热泵零件', de: 'Teile von Wärmepumpen' },

  // ── 43 采矿、采石与施工机械 ─────────────────────────────────────────────
  { code: '43000000', parent: null, en: 'Machinery for mining, quarrying, construction equipment', zh: '采矿、采石与施工机械', de: 'Maschinen für Bergbau, Steinbruch und Bau' },
  { code: '43300000', parent: '43000000', en: 'Construction machinery and equipment', zh: '施工机械与设备', de: 'Baumaschinen und -geräte' },

  // ── 44 建筑结构与材料 ───────────────────────────────────────────────────
  { code: '44000000', parent: null, en: 'Construction structures and materials; auxiliary products to construction (except electric apparatus)', zh: '建筑结构与材料；施工辅助产品（电气装置除外）', de: 'Baukonstruktionen und Baumaterialien' },
  { code: '44100000', parent: '44000000', en: 'Construction materials and associated items', zh: '建筑材料及相关物品', de: 'Baumaterialien und Zubehör' },
  { code: '44115000', parent: '44100000', en: 'Building fittings', zh: '建筑配件', de: 'Bauzubehör' },
  { code: '44200000', parent: '44000000', en: 'Structural products', zh: '结构件产品', de: 'Bauelemente' },
  { code: '44300000', parent: '44000000', en: 'Cable, wire and related products', zh: '电缆、电线及相关产品', de: 'Kabel, Drähte und verwandte Erzeugnisse' },
  { code: '44600000', parent: '44000000', en: 'Tanks, reservoirs and containers; central-heating radiators and boilers', zh: '储罐、容器；暖气片与锅炉', de: 'Tanks, Behälter; Heizkörper und Kessel' },
  { code: '44610000', parent: '44600000', en: 'Tanks, reservoirs, containers and pressure vessels', zh: '储罐、容器与压力容器', de: 'Tanks, Behälter und Druckbehälter' },
  { code: '44617000', parent: '44610000', en: 'Boxes', zh: '包装箱盒', de: 'Kisten und Schachteln' },
  { code: '44620000', parent: '44600000', en: 'Central-heating radiators and boilers and parts', zh: '暖气片、锅炉及零件', de: 'Heizkörper, Kessel und Teile' },

  // ── 45 施工 ─────────────────────────────────────────────────────────────
  { code: '45000000', parent: null, en: 'Construction work', zh: '建筑工程', de: 'Bauarbeiten' },
  { code: '45100000', parent: '45000000', en: 'Site preparation work', zh: '场地准备工程', de: 'Baustellenvorbereitung' },
  { code: '45200000', parent: '45000000', en: 'Works for complete or part construction and civil engineering work', zh: '完整或部分建筑工程及土木工程', de: 'Bauarbeiten für Gebäude und Tiefbau' },
  { code: '45300000', parent: '45000000', en: 'Building installation work', zh: '建筑安装工程', de: 'Bauinstallationsarbeiten' },
  { code: '45310000', parent: '45300000', en: 'Electrical installation work', zh: '电气安装工程', de: 'Elektroinstallationsarbeiten' },
  { code: '45331000', parent: '45300000', en: 'Heating, ventilation and air-conditioning installation work', zh: '供暖、通风与空调安装工程', de: 'Installation von Heizungs-, Lüftungs- und Klimaanlagen' },
  { code: '45350000', parent: '45300000', en: 'Mechanical installations', zh: '机械装置安装', de: 'Mechanische Installationen' },
  { code: '45400000', parent: '45000000', en: 'Building completion work', zh: '建筑竣工（装修）工程', de: 'Baufertigstellungsarbeiten' },
  { code: '45500000', parent: '45000000', en: 'Hire of construction and civil engineering machinery and equipment with operator', zh: '带操作员的施工机械租赁', de: 'Vermietung von Baumaschinen und -geräten mit Bedienpersonal' },

  // ── 71 工程与技术服务 ───────────────────────────────────────────────────
  { code: '71000000', parent: null, en: 'Architectural, construction, engineering and inspection services', zh: '建筑、工程与检验服务', de: 'Architektur-, Bau-, Ingenieur- und Prüfdienstleistungen' },
  { code: '71320000', parent: '71000000', en: 'Engineering design services', zh: '工程设计服务' },
  { code: '71334000', parent: '71000000', en: 'Mechanical and electrical engineering services', zh: '机电工程服务' },

  // ── 72 IT 服务 ──────────────────────────────────────────────────────────
  { code: '72000000', parent: null, en: 'IT services: consulting, software development, Internet and support', zh: 'IT 服务：咨询、软件开发、互联网与支持', de: 'IT-Dienstleistungen: Beratung, Softwareentwicklung, Internet und Support' },
  { code: '72200000', parent: '72000000', en: 'Software programming and consultancy services', zh: '软件编程与咨询服务', de: 'Softwareprogrammierung und -beratung' },
];
