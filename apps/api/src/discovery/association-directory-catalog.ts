/**
 * 光伏与可再生能源行业协会公开会员名录目录（8 个目标市场 DE/MY/GB/CA/BR/NL/TR/AU + 泛欧 EU）。
 *
 * 准入原则（2026-11-27 逐站 curl 实测核验）：
 *  - 仅收录公开无需登录、HTTP 200 可达、robots.txt 允许抓取、ToS/Legal 无禁止抓取或禁商用条款、
 *    且无 Cloudflare/验证码反爬拦截的企业会员名录；
 *  - 逐域登记至 `source_policy`（`sourceType='association'`, `personalData=false`, `allowedPurpose=['discovery']`），
 *    运维可随时对任意单一协会域置 `SUSPENDED` 立即停抓；
 *  - 单国名录提供确定性 `countryIso` 供清洗层补齐缺失国别；泛欧名录标为 `'EU'`，绝不猜测单国。
 */
import { normalizeDomain } from './identity';

export type AssociationDirectoryCountryIso =
  | 'DE'
  | 'MY'
  | 'GB'
  | 'CA'
  | 'BR'
  | 'NL'
  | 'TR'
  | 'AU'
  | 'EU';

export interface AssociationDirectoryEntry {
  readonly slug: string;
  readonly name: string;
  /** 协会简称/别名（用于检索与清洗层自动剔除协会自身噪声条目）。 */
  readonly aliases: readonly string[];
  /** 经实测 200 OK 的公开会员名录页（稳定安全 HTTPS URL，无查询串/锚点/端口）。 */
  readonly directoryUrl: string;
  /** 规范化主机名（小写、无 www.），与 source_policy.domain 及 source_directory 对齐。 */
  readonly domain: string;
  /** 关联噪声域（如协会自有商城/门户子域），清洗层不将其误认作会员公司官网。 */
  readonly selfRelatedDomains?: readonly string[];
  readonly countryIso: AssociationDirectoryCountryIso;
  readonly region: string;
  readonly industryTags: readonly string[];
  readonly robotsStatus: 'ALLOWS';
  readonly termsStatus: 'REVIEWED_OK';
  readonly license: string;
  readonly tosUrl: string;
  readonly estimatedCompanies: number;
  readonly verifiedAt: string;
  readonly note: string;
}

export interface RejectedAssociationDirectoryCandidate {
  readonly market: AssociationDirectoryCountryIso;
  readonly name: string;
  readonly url: string;
  readonly reasonCode:
    | 'ANTI_BOT_CHALLENGE'
    | 'TOS_PROHIBITS_SCRAPING'
    | 'TOS_NON_COMMERCIAL_ONLY'
    | 'LOGIN_REQUIRED'
    | 'NO_PUBLIC_STATIC_LIST'
    | 'UNREACHABLE';
  readonly reason: string;
}

const PV_CORE_TAGS = Object.freeze([
  'solar',
  'photovoltaic',
  'pv',
  'solar module',
  'solar cell',
  'hjt',
  'topcon',
  'bipv',
  'epc',
  'inverter',
  'energy storage',
  'bess',
  'renewable energy',
  'clean energy',
  '光伏',
  '太阳能',
  '储能',
  '新能源',
]);

const DEFAULT_DIRECTORY_LICENSE =
  'Public trade association member directory — corporate facts reuse only; no bulk republication or personal data harvesting';

const EUROPEAN_ISO2: ReadonlySet<string> = new Set([
  'DE', 'NL', 'GB', 'IT', 'ES', 'FR', 'AT', 'CH', 'BE', 'LU', 'PL', 'SE', 'DK',
  'FI', 'NO', 'PT', 'IE', 'CZ', 'HU', 'RO', 'GR', 'BG', 'HR', 'SK', 'SI', 'EE',
  'LV', 'LT', 'CY', 'MT', 'EU',
]);

export const ASSOCIATION_DIRECTORY_CATALOG: readonly AssociationDirectoryEntry[] = Object.freeze([
  // ── DE 德国（4 个） ──────────────────────────────────────────────────────────
  {
    slug: 'bsw-solar-de',
    name: 'BSW-Solar (Bundesverband Solarwirtschaft)',
    aliases: ['BSW-Solar', 'BSW', 'Bundesverband Solarwirtschaft', 'Bundesverband Solarwirtschaft e.V.'],
    directoryUrl: 'https://www.solarwirtschaft.de/unsere-mitglieder/mitgliedersuche/',
    domain: 'solarwirtschaft.de',
    selfRelatedDomains: ['bsw-solar-shop.de'],
    countryIso: 'DE',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'photovoltaik', 'solarenergie', 'solarwirtschaft', 'speicher'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.solarwirtschaft.de/impressum/',
    estimatedCompanies: 1000,
    verifiedAt: '2026-11-27',
    note: '德国太阳能经济联合会公开会员检索（约 1,000 家光伏/储能产业链会员），robots 仅禁 /wp-admin/，Impressum 无禁爬条款',
  },
  {
    slug: 'bves-de',
    name: 'BVES (Bundesverband Energiespeicher Systeme)',
    aliases: ['BVES', 'Bundesverband Energiespeicher Systeme', 'Bundesverband Energiespeicher Systeme e.V.'],
    directoryUrl: 'https://www.bves.de/der-bves/mitglieder/',
    domain: 'bves.de',
    countryIso: 'DE',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'energiespeicher', 'batteriespeicher', 'photovoltaik'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.bves.de/impressum/',
    estimatedCompanies: 472,
    verifiedAt: '2026-11-27',
    note: '德国储能系统协会公开会员名录（页内标注 472 家会员、实测 435 个独立企业外链），robots 仅禁 /wp-admin/ 与 /wp-includes/',
  },
  {
    slug: 'solarcluster-bw-de',
    name: 'Solar Cluster Baden-Württemberg',
    aliases: ['Solar Cluster Baden-Württemberg', 'Solar Cluster BW', 'SolarCluster BW'],
    directoryUrl: 'https://solarcluster-bw.de/de/ueber-uns/mitglieder',
    domain: 'solarcluster-bw.de',
    countryIso: 'DE',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'photovoltaik', 'solarenergie', 'solarcluster'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://solarcluster-bw.de/de/impressum',
    estimatedCompanies: 71,
    verifiedAt: '2026-11-27',
    note: '巴登-符腾堡州光伏集群公开会员名录（实测 71 个光伏/储能企业外链），robots 无 Disallow',
  },
  {
    slug: 'bne-online-de',
    name: 'bne (Bundesverband Neue Energiewirtschaft)',
    aliases: ['bne', 'Bundesverband Neue Energiewirtschaft', 'Bundesverband Neue Energiewirtschaft e.V.'],
    directoryUrl: 'https://www.bne-online.de/verband/unsere-mitglieder/',
    domain: 'bne-online.de',
    countryIso: 'DE',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'solarpark', 'energiewirtschaft', 'photovoltaik', 'speicher'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.bne-online.de/impressum/',
    estimatedCompanies: 80,
    verifiedAt: '2026-11-27',
    note: '德国新能源经济联合会公开会员名录（9 页分页，80+ 家地面光伏开发商、大储与能源运营企业），robots 仅禁 /wp-admin/',
  },

  // ── MY 马来西亚（3 个） ──────────────────────────────────────────────────────
  {
    slug: 'mpsea-my',
    name: 'MPSEA (Malaysian Photovoltaic and Sustainable Energy Industry Association)',
    aliases: [
      'MPSEA',
      'MPIA',
      'Malaysian Photovoltaic Industry Association',
      'Malaysian Photovoltaic and Sustainable Energy Industry Association',
    ],
    directoryUrl: 'https://mpsea.org.my/membership/',
    domain: 'mpsea.org.my',
    selfRelatedDomains: ['mpia.org.my'],
    countryIso: 'MY',
    region: 'Asia',
    industryTags: [...PV_CORE_TAGS, 'malaysia solar', 'sustainable energy'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://mpsea.org.my/',
    estimatedCompanies: 206,
    verifiedAt: '2026-11-27',
    note: '马来西亚光伏与可持续能源产业协会（原 MPIA，mpia.org.my 已 301 重定向至此），实测 206 个光伏企业外链',
  },
  {
    slug: 'seda-rpvsp-my',
    name: 'SEDA Malaysia Registered PV Service Provider Directory',
    aliases: ['SEDA', 'SEDA Malaysia', 'Sustainable Energy Development Authority Malaysia'],
    directoryUrl: 'https://services.seda.gov.my/spqp/listing',
    domain: 'services.seda.gov.my',
    selfRelatedDomains: ['seda.gov.my'],
    countryIso: 'MY',
    region: 'Asia',
    industryTags: [...PV_CORE_TAGS, 'rpvsp', 'nem', 'solar installer'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: 'SEDA Malaysia public statutory RPVSP directory — corporate listing facts only; see official disclaimer',
    tosUrl: 'https://services.seda.gov.my/spqp/tnc',
    estimatedCompanies: 250,
    verifiedAt: '2026-11-27',
    note: '马来西亚可持续能源发展局官方注册光伏服务商名录（700KB 公开清单，约 250+ 家持牌 PV EPC/安装商）',
  },
  {
    slug: 'teeam-my',
    name: 'TEEAM (The Electrical and Electronics Association of Malaysia)',
    aliases: ['TEEAM', 'The Electrical and Electronics Association of Malaysia'],
    directoryUrl: 'https://www.teeam.org.my/directory/',
    domain: 'teeam.org.my',
    countryIso: 'MY',
    region: 'Asia',
    industryTags: [...PV_CORE_TAGS, 'electrical', 'switchgear', 'power distribution'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.teeam.org.my/',
    estimatedCompanies: 100,
    verifiedAt: '2026-11-27',
    note: '马来西亚机电与电子行业协会公开会员名录（含配电、开关柜与光伏机电承包商），robots 仅禁 /wp-admin/',
  },

  // ── GB 英国（4 个） ──────────────────────────────────────────────────────────
  {
    slug: 'beama-gb',
    name: 'BEAMA (UK Energy Infrastructure and Systems Trade Association)',
    aliases: ['BEAMA', 'BEAMA Limited'],
    directoryUrl: 'https://www.beama.org.uk/about-beama/member-directory.html',
    domain: 'beama.org.uk',
    countryIso: 'GB',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'energy infrastructure', 'electrical equipment', 'grid'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.beama.org.uk/cookie-privacy-policy.html',
    estimatedCompanies: 157,
    verifiedAt: '2026-11-27',
    note: '英国能源基础设施与电气系统贸易协会会员名录（实测 157 个会员官网外链），robots 无 Disallow',
  },
  {
    slug: 'renewableni-gb',
    name: 'RenewableNI',
    aliases: ['RenewableNI', 'Renewable Northern Ireland'],
    directoryUrl: 'https://renewableni.com/members/',
    domain: 'renewableni.com',
    countryIso: 'GB',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'renewables', 'wind', 'grid'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://renewableni.com/',
    estimatedCompanies: 57,
    verifiedAt: '2026-11-27',
    note: '英国北爱尔兰可再生能源协会会员名录（实测 57 个光伏/风电/储能开发商与 EPC 外链），robots 仅禁 /wp-admin/',
  },
  {
    slug: 'community-energy-england-gb',
    name: 'Community Energy England',
    aliases: ['Community Energy England', 'CEE'],
    directoryUrl: 'https://communityenergyengland.org/our-members/',
    domain: 'communityenergyengland.org',
    countryIso: 'GB',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'community solar', 'distributed energy'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://communityenergyengland.org/',
    estimatedCompanies: 87,
    verifiedAt: '2026-11-27',
    note: '英格兰社区新能源协会公开会员页（实测 87 个英国分布式光伏与社区能源企业外链），robots 仅禁 /wp-admin/',
  },
  {
    slug: 'gambica-gb',
    name: 'GAMBICA (UK Automation, Instrumentation and Power Electronics Association)',
    aliases: ['GAMBICA', 'GAMBICA Association'],
    directoryUrl: 'https://www.gambica.org.uk/membership/member-directory.html',
    domain: 'gambica.org.uk',
    countryIso: 'GB',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'power electronics', 'automation', 'control'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.gambica.org.uk/cookie-privacy-policy.html',
    estimatedCompanies: 180,
    verifiedAt: '2026-11-27',
    note: '英国自动化与电力电子协会 A-Z 公开会员名录（含电力电子、逆变/控制设备会员），robots 无 Disallow',
  },

  // ── CA 加拿大（3 个） ────────────────────────────────────────────────────────
  {
    slug: 'electrofed-ca',
    name: 'Electro-Federation Canada (EFC)',
    aliases: ['Electro-Federation Canada', 'Electro Federation Canada', 'EFC'],
    directoryUrl: 'https://www.electrofed.com/members/',
    domain: 'electrofed.com',
    countryIso: 'CA',
    region: 'North America',
    industryTags: [...PV_CORE_TAGS, 'electrical distribution', 'power equipment'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.electrofed.com/privacy-statement/',
    estimatedCompanies: 286,
    verifiedAt: '2026-11-27',
    note: '加拿大电气联合会公开会员名录（实测 286 个电气/新能源设备制造与分销企业外链），robots User-agent: * 允许',
  },
  {
    slug: 'electricity-canada-ca',
    name: 'Electricity Canada Corporate Partners',
    aliases: ['Electricity Canada', 'Canadian Electricity Association', 'CEA'],
    directoryUrl: 'https://www.electricity.ca/membership/list-of-corporate-partners/',
    domain: 'electricity.ca',
    countryIso: 'CA',
    region: 'North America',
    industryTags: [...PV_CORE_TAGS, 'electricity', 'utility solar', 'grid'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.electricity.ca/legal/terms-of-use/',
    estimatedCompanies: 100,
    verifiedAt: '2026-11-27',
    note: '加拿大电力协会公开企业合作伙伴名录（实测 100 个电力/光储工程与设备企业外链），robots 仅禁系统目录',
  },
  {
    slug: 'solar-nova-scotia-ca',
    name: 'Solar Nova Scotia',
    aliases: ['Solar Nova Scotia', 'Solar Energy NS', 'SolarNS'],
    directoryUrl: 'https://solarns.ca/directory/',
    domain: 'solarns.ca',
    countryIso: 'CA',
    region: 'North America',
    industryTags: [...PV_CORE_TAGS, 'solar installer', 'canada solar'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://solarns.ca/terms-of-use/',
    estimatedCompanies: 40,
    verifiedAt: '2026-11-27',
    note: '加拿大新斯科舍省太阳能协会分页企业名录（实测含 BayWa r.e.、Alto Solar、2M Solar 等光伏安装/分销商），robots 无 Disallow',
  },

  // ── BR 巴西（4 个） ──────────────────────────────────────────────────────────
  {
    slug: 'absolar-br',
    name: 'ABSOLAR (Associação Brasileira de Energia Solar Fotovoltaica)',
    aliases: ['ABSOLAR', 'Associação Brasileira de Energia Solar Fotovoltaica'],
    directoryUrl: 'https://www.absolar.org.br/associados/',
    domain: 'absolar.org.br',
    selfRelatedDomains: ['absolar.sharepoint.com'],
    countryIso: 'BR',
    region: 'South America',
    industryTags: [...PV_CORE_TAGS, 'energia solar', 'fotovoltaica', 'distribuidor solar'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.absolar.org.br/',
    estimatedCompanies: 345,
    verifiedAt: '2026-11-27',
    note: '巴西太阳能光伏协会官方会员名录（实测 345 家会员条目与 79+ 官网直链），robots.txt 空（允许）',
  },
  {
    slug: 'abeeolica-br',
    name: 'ABEEólica (Associação Brasileira de Energia Eólica e Novas Tecnologias)',
    aliases: ['ABEEólica', 'ABEEolica', 'Associação Brasileira de Energia Eólica'],
    directoryUrl: 'https://abeeolica.org.br/nossos-associados/',
    domain: 'abeeolica.org.br',
    countryIso: 'BR',
    region: 'South America',
    industryTags: [...PV_CORE_TAGS, 'energia renovavel', 'novas tecnologias', 'h2v'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://abeeolica.org.br/termos-e-condicoes-de-uso/',
    estimatedCompanies: 116,
    verifiedAt: '2026-11-27',
    note: '巴西风能与新能源技术协会会员名录（实测 116 个新能源开发/EPC/设备会员外链），robots 无 Disallow',
  },
  {
    slug: 'abraceel-br',
    name: 'ABRACEEL (Associação Brasileira dos Comercializadores de Energia)',
    aliases: ['ABRACEEL', 'Associação Brasileira dos Comercializadores de Energia'],
    directoryUrl: 'https://abraceel.com.br/associados/',
    domain: 'abraceel.com.br',
    countryIso: 'BR',
    region: 'South America',
    industryTags: [...PV_CORE_TAGS, 'energia solar', 'comercializadora', 'mercado livre'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://abraceel.com.br/politica-de-privacidade/',
    estimatedCompanies: 76,
    verifiedAt: '2026-11-27',
    note: '巴西自由能源市场协会会员名录（实测 76 个能源贸易商与大型光伏发电投资商外链），无反爬',
  },
  {
    slug: 'abiape-br',
    name: 'ABIAPE (Associação Brasileira dos Investidores em Autoprodução de Energia)',
    aliases: ['ABIAPE', 'Associação Brasileira dos Investidores em Autoprodução de Energia'],
    directoryUrl: 'https://abiape.com.br/associados/',
    domain: 'abiape.com.br',
    countryIso: 'BR',
    region: 'South America',
    industryTags: [...PV_CORE_TAGS, 'autoproducao', 'energia renovavel'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://abiape.com.br/',
    estimatedCompanies: 25,
    verifiedAt: '2026-11-27',
    note: '巴西能源自发电商协会会员名录（实测 25 个大型工商业自备电厂与光伏投资商外链），robots 仅禁 /wp-admin/',
  },

  // ── NL 荷兰（3 个） ──────────────────────────────────────────────────────────
  {
    slug: 'holland-solar-nl',
    name: 'Holland Solar',
    aliases: ['Holland Solar', 'Branchevereniging Holland Solar'],
    directoryUrl: 'https://hollandsolar.nl/leden/',
    domain: 'hollandsolar.nl',
    countryIso: 'NL',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'zonne-energie', 'zonnestroom', 'zonnepanelen'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://hollandsolar.nl/algemeen/disclaimer.html',
    estimatedCompanies: 189,
    verifiedAt: '2026-11-27',
    note: '荷兰太阳能行业协会公开会员名录（实测 189 个 /leden/<slug> 光伏会员条目），robots 无 Disallow',
  },
  {
    slug: 'nvde-nl',
    name: 'NVDE (Nederlandse Vereniging Duurzame Energie)',
    aliases: ['NVDE', 'Nederlandse Vereniging Duurzame Energie'],
    directoryUrl: 'https://www.nvde.nl/leden/',
    domain: 'nvde.nl',
    countryIso: 'NL',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'duurzame energie', 'zonne-energie', 'energieopslag'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.nvde.nl/',
    estimatedCompanies: 112,
    verifiedAt: '2026-11-27',
    note: '荷兰可持续能源协会会员总表（实测 112+ 家荷兰可再生能源企业公开名单），robots 无 Disallow',
  },
  {
    slug: 'nedzero-nl',
    name: 'NedZero (formerly NWEA)',
    aliases: ['NedZero', 'NWEA', 'Nederlandse WindEnergie Associatie'],
    directoryUrl: 'https://www.nedzero.nl/nl/members',
    domain: 'nedzero.nl',
    countryIso: 'NL',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'duurzame energie', 'energieopslag', 'windenergie'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.nedzero.nl/nl',
    estimatedCompanies: 224,
    verifiedAt: '2026-11-27',
    note: '荷兰清洁能源协会公开会员页（实测 224 个会员企业官网外链与 221 个企业条目），robots 无 Disallow',
  },

  // ── TR 土耳其（4 个） ────────────────────────────────────────────────────────
  {
    slug: 'gensed-tr',
    name: 'GENSED (Güneş Enerjisi Sanayicileri ve Endüstrisi Derneği)',
    aliases: ['GENSED', 'Güneş Enerjisi Sanayicileri ve Endüstrisi Derneği', 'Güneş Enerjisi ve Depolama Sanayicileri Derneği'],
    directoryUrl: 'https://gensed.org/uyelerimiz/',
    domain: 'gensed.org',
    countryIso: 'TR',
    region: 'Eurasia',
    industryTags: [...PV_CORE_TAGS, 'gunes enerjisi', 'güneş enerjisi', 'ges', 'depolama'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://gensed.org/',
    estimatedCompanies: 201,
    verifiedAt: '2026-11-27',
    note: '土耳其太阳能与储能产业协会会员页（实测 193 个独立外链、201 家光伏组件/EPC/逆变器企业），robots 无 Disallow',
  },
  {
    slug: 'gunder-tr',
    name: 'GÜNDER (Uluslararası Güneş Enerjisi Topluluğu Türkiye Bölümü)',
    aliases: ['GÜNDER', 'GUNDER', 'Günder', 'Uluslararası Güneş Enerjisi Topluluğu Türkiye Bölümü'],
    directoryUrl: 'https://www.gunder.org.tr/uyelik/kurumsal-uyeler/',
    domain: 'gunder.org.tr',
    countryIso: 'TR',
    region: 'Eurasia',
    industryTags: [...PV_CORE_TAGS, 'gunes enerjisi', 'güneş enerjisi', 'fotovoltaik'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: 'Public association directory (robots Content-Signal: search=yes, use=reference, ai-train=no) — reference facts only, never for AI training',
    tosUrl: 'https://www.gunder.org.tr/uyelik/uyelik-kosullari/',
    estimatedCompanies: 114,
    verifiedAt: '2026-11-27',
    note: '国际太阳能学会土耳其分会企业会员名录（实测 114 个光伏企业外链），robots 允许 search/reference（禁 ai-train）',
  },
  {
    slug: 'ensia-tr',
    name: 'ENSİA (Enerji Sanayicileri ve İş İnsanları Derneği)',
    aliases: ['ENSİA', 'ENSIA', 'Enerji Sanayicileri ve İş İnsanları Derneği'],
    directoryUrl: 'https://ensia.org.tr/kume-uyelerimiz/',
    domain: 'ensia.org.tr',
    countryIso: 'TR',
    region: 'Eurasia',
    industryTags: [...PV_CORE_TAGS, 'temiz enerji', 'yenilenebilir enerji', 'gunes'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://ensia.org.tr/',
    estimatedCompanies: 109,
    verifiedAt: '2026-11-27',
    note: '土耳其伊兹密尔清洁能源产业集群会员名录（实测 109 个清洁能源制造与工程企业外链），robots 仅禁 /wp-admin/',
  },
  {
    slug: 'eud-tr',
    name: 'EÜD (Elektrik Üreticileri Derneği)',
    aliases: ['EÜD', 'EUD', 'Elektrik Üreticileri Derneği'],
    directoryUrl: 'https://www.eud.org.tr/uyelerimiz/',
    domain: 'eud.org.tr',
    countryIso: 'TR',
    region: 'Eurasia',
    industryTags: [...PV_CORE_TAGS, 'elektrik uretimi', 'yenilenebilir enerji'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.eud.org.tr/',
    estimatedCompanies: 59,
    verifiedAt: '2026-11-27',
    note: '土耳其电力生产商协会会员页（实测 59 个大型发电商与光伏电站投资商外链），robots 无 Disallow',
  },

  // ── AU 澳大利亚（3 个） ──────────────────────────────────────────────────────
  {
    slug: 'smart-energy-council-au',
    name: 'Smart Energy Council (Australia)',
    aliases: ['Smart Energy Council', 'Smart Energy Council Australia', 'SEC'],
    directoryUrl: 'https://portal.smartenergy.org.au/industry-directory/',
    domain: 'portal.smartenergy.org.au',
    selfRelatedDomains: ['smartenergy.org.au'],
    countryIso: 'AU',
    region: 'Oceania',
    industryTags: [...PV_CORE_TAGS, 'smart energy', 'solar installer', 'australia solar'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://smartenergy.org.au/terms-of-use/',
    estimatedCompanies: 1000,
    verifiedAt: '2026-11-27',
    note: '澳大利亚智慧能源理事会公开行业名录（直接渲染光伏/储能企业名称与官网链接，约 1,000 家会员），robots 仅禁预览参数',
  },
  {
    slug: 'energy-efficiency-council-au',
    name: 'Energy Efficiency Council (Australia)',
    aliases: ['Energy Efficiency Council', 'EEC', 'EEC Australia'],
    directoryUrl: 'https://eec.org.au/membership/our-members/',
    domain: 'eec.org.au',
    selfRelatedDomains: ['eeccertified.org.au'],
    countryIso: 'AU',
    region: 'Oceania',
    industryTags: [...PV_CORE_TAGS, 'energy management', 'distributed energy', 'energy efficiency'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://eec.org.au/privacy/',
    estimatedCompanies: 93,
    verifiedAt: '2026-11-27',
    note: '澳大利亚能效与分布式能源理事会会员页（实测 93 个光伏/储能/能源管理企业外链），robots 仅禁 /wp-admin/',
  },
  {
    slug: 'energy-networks-au',
    name: 'Energy Networks Australia',
    aliases: ['Energy Networks Australia', 'ENA Australia'],
    directoryUrl: 'https://www.energynetworks.com.au/about/our-members/',
    domain: 'energynetworks.com.au',
    countryIso: 'AU',
    region: 'Oceania',
    industryTags: [...PV_CORE_TAGS, 'grid', 'distribution network', 'utility'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.energynetworks.com.au/about/privacy-policy/',
    estimatedCompanies: 22,
    verifiedAt: '2026-11-27',
    note: '澳大利亚能源网络协会会员名录（实测 22 个电网与配电运营会员外链），robots 无 Disallow',
  },

  // ── EU 泛欧（4 个；跨国名录，绝不回填单一国家码） ───────────────────────────
  {
    slug: 'solarpower-europe-eu',
    name: 'SolarPower Europe',
    aliases: ['SolarPower Europe', 'SPE'],
    directoryUrl: 'https://www.solarpowereurope.org/membership/meet-our-members',
    domain: 'solarpowereurope.org',
    countryIso: 'EU',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'europe solar', 'utility solar', 'o&m'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://www.solarpowereurope.org/',
    estimatedCompanies: 302,
    verifiedAt: '2026-11-27',
    note: '欧洲太阳能行业协会官方会员页（实测 SSR 内嵌 302 家全欧光伏全链企业及官网 URL），无 robots 限制',
  },
  {
    slug: 'esmc-eu',
    name: 'ESMC (European Solar Manufacturing Council)',
    aliases: ['ESMC', 'European Solar Manufacturing Council', 'ESMC Solar'],
    directoryUrl: 'https://esmc.solar/esmc-members/',
    domain: 'esmc.solar',
    countryIso: 'EU',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'solar manufacturing', 'pv wafer', 'pv cell', 'pv module'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://esmc.solar/privacy/',
    estimatedCompanies: 67,
    verifiedAt: '2026-11-27',
    note: '欧洲光伏制造理事会会员名录（实测 67 个欧洲光伏电池/组件/设备制造企业外链），robots 无 Disallow',
  },
  {
    slug: 'energy-storage-europe-eu',
    name: 'Energy Storage Europe (formerly EASE)',
    aliases: ['Energy Storage Europe', 'EASE', 'European Association for Storage of Energy'],
    directoryUrl: 'https://energystorageeurope.eu/about-us/members/',
    domain: 'energystorageeurope.eu',
    selfRelatedDomains: ['ease-storage.eu'],
    countryIso: 'EU',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'energy storage', 'bess', 'battery'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://energystorageeurope.eu/privacy-and-cookie-policy/',
    estimatedCompanies: 69,
    verifiedAt: '2026-11-27',
    note: '欧洲储能协会（原 EASE）会员名录（实测 69 个光储与电池企业外链），robots 仅禁 /wp-admin/',
  },
  {
    slug: 'solar-heat-europe-eu',
    name: 'Solar Heat Europe',
    aliases: ['Solar Heat Europe', 'ESTIF'],
    directoryUrl: 'https://solarheateurope.eu/about/membership/',
    domain: 'solarheateurope.eu',
    countryIso: 'EU',
    region: 'Europe',
    industryTags: [...PV_CORE_TAGS, 'solar thermal', 'solar heat'],
    robotsStatus: 'ALLOWS',
    termsStatus: 'REVIEWED_OK',
    license: DEFAULT_DIRECTORY_LICENSE,
    tosUrl: 'https://solarheateurope.eu/',
    estimatedCompanies: 44,
    verifiedAt: '2026-11-27',
    note: '欧洲太阳能热利用协会会员名录（实测 44 个欧洲太阳能制造与行业组织外链），robots 无 Disallow',
  },
]);

/** 2026-11-27 实测核验后明确拒收的候选站（留痕备查，绝不注册进 source_policy 批准表）。 */
export const REJECTED_ASSOCIATION_DIRECTORY_CANDIDATES: readonly RejectedAssociationDirectoryCandidate[] =
  Object.freeze([
    {
      market: 'DE',
      name: 'DGS (Deutsche Gesellschaft für Sonnenenergie)',
      url: 'https://www.dgs.de/beratung-und-kompetenz/firmenverzeichnis/',
      reasonCode: 'NO_PUBLIC_STATIC_LIST',
      reason: '会员检索嵌入第三方动态 iframe (server107.der-moderne-verein.de)，主站无公开静态公司清单',
    },
    {
      market: 'MY',
      name: 'MyHIJAU Green Directory',
      url: 'https://www.myhijau.my/directory/category',
      reasonCode: 'NO_PUBLIC_STATIC_LIST',
      reason: '页面为前端模板占位（${category.name}），无公开静态公司列表',
    },
    {
      market: 'GB',
      name: 'Solar Energy UK',
      url: 'https://solarenergyuk.org/membership/member-directory/',
      reasonCode: 'ANTI_BOT_CHALLENGE',
      reason: 'HTTP 403 Cloudflare "Just a moment..." 反爬拦截（绝不绕过）',
    },
    {
      market: 'GB',
      name: 'Energy UK',
      url: 'https://www.energy-uk.org.uk/about-us/our-members/',
      reasonCode: 'TOS_PROHIBITS_SCRAPING',
      reason: 'ToS 明确禁止 scraping, data mining, data extraction and data harvesting',
    },
    {
      market: 'GB',
      name: 'Scottish Renewables',
      url: 'https://www.scottishrenewables.com/membership/directory',
      reasonCode: 'TOS_PROHIBITS_SCRAPING',
      reason: 'ToS §5 明确禁止未经书面许可的 extraction / reorganisation / commercial reuse',
    },
    {
      market: 'GB',
      name: 'MCS Certified',
      url: 'https://mcscertified.com/find-an-installer/',
      reasonCode: 'TOS_NON_COMMERCIAL_ONLY',
      reason: 'ToS 明确禁止对目录数据的任何 storing 或 commercial use',
    },
    {
      market: 'GB',
      name: 'Energy Networks Association (UK)',
      url: 'https://www.energynetworks.org/about-us/our-members',
      reasonCode: 'ANTI_BOT_CHALLENGE',
      reason: 'HTTP 403 Cloudflare "Just a moment..." 反爬拦截',
    },
    {
      market: 'GB',
      name: 'REA (Association for Renewable Energy and Clean Technology)',
      url: 'https://www.r-e-a.net/our-members/',
      reasonCode: 'LOGIN_REQUIRED',
      reason: '会员页正文未公开静态公司列表且导向会员登录',
    },
    {
      market: 'GB',
      name: 'RenewableUK',
      url: 'https://www.renewableuk.com/membership/member-directory/',
      reasonCode: 'NO_PUBLIC_STATIC_LIST',
      reason: '名录页仅渲染城市筛选表单，静态页面无公开公司列表',
    },
    {
      market: 'CA',
      name: 'CanREA Active Member Directory',
      url: 'https://members.renewablesassociation.ca/activememberdirectory',
      reasonCode: 'ANTI_BOT_CHALLENGE',
      reason: 'HTTP 403 Cloudflare 反爬拦截；主站 /go-solar-directory/ 仅嵌 GrowthZone 动态外链无静态名单',
    },
    {
      market: 'CA',
      name: 'Clean Energy BC',
      url: 'https://cleanenergybc.org/members/',
      reasonCode: 'UNREACHABLE',
      reason: 'curl 连接超时/不可达',
    },
    {
      market: 'CA',
      name: 'OSEA (Ontario Sustainable Energy Association)',
      url: 'https://www.ontario-sea.org/members',
      reasonCode: 'UNREACHABLE',
      reason: 'curl 连接超时/不可达',
    },
    {
      market: 'CA',
      name: 'Solar Alberta',
      url: 'https://solaralberta.ca/solar-directory/',
      reasonCode: 'NO_PUBLIC_STATIC_LIST',
      reason: '目录路径返回 404，公开页仅展示少量赞助商无完整企业名录',
    },
    {
      market: 'BR',
      name: 'ABGD / RED',
      url: 'https://www.abgd.com.br/associados/',
      reasonCode: 'NO_PUBLIC_STATIC_LIST',
      reason: '品牌更名为 RED 后原 /associados/ 404，未提供公开企业列表',
    },
    {
      market: 'BR',
      name: 'INEL / APINE / COGEN',
      url: 'https://inel.org.br/associados/',
      reasonCode: 'UNREACHABLE',
      reason: 'curl 连接超时或无响应',
    },
    {
      market: 'NL',
      name: 'Techniek Nederland',
      url: 'https://www.technieknederland.nl/de-vereniging/onze-leden/',
      reasonCode: 'LOGIN_REQUIRED',
      reason: '会员检索导向 LedenLogin 登录墙',
    },
    {
      market: 'NL',
      name: 'Zonnekeur',
      url: 'https://www.zonnekeur.nl/installateurs/',
      reasonCode: 'UNREACHABLE',
      reason: 'curl 连接失败/不可达',
    },
    {
      market: 'TR',
      name: 'GÜYAD (Enerji Yatırımcıları Derneği)',
      url: 'https://www.guyad.org/TR,2295/uyeler.html',
      reasonCode: 'NO_PUBLIC_STATIC_LIST',
      reason: '页面虽 200 但仅含页眉页脚空壳（680 字符，无企业名单）',
    },
    {
      market: 'AU',
      name: 'Clean Energy Council (Australia)',
      url: 'https://cleanenergycouncil.org.au/membership/current-members',
      reasonCode: 'TOS_NON_COMMERCIAL_ONLY',
      reason: 'Legal 条款明确限定仅限 personal or non-commercial use，禁止商业提取',
    },
    {
      market: 'AU',
      name: 'Australian Energy Council',
      url: 'https://energycouncil.com.au/our-members/',
      reasonCode: 'TOS_NON_COMMERCIAL_ONLY',
      reason: 'ToS 明确限定 only for your personal, non-commercial or educational use',
    },
    {
      market: 'AU',
      name: 'APVI (Australian PV Institute)',
      url: 'https://apvi.org.au/members/',
      reasonCode: 'ANTI_BOT_CHALLENGE',
      reason: '页面返回 "Bot Verification" 反爬验证码拦截（绝不绕过）',
    },
  ]);

const BY_DOMAIN: ReadonlyMap<string, AssociationDirectoryEntry> = new Map(
  ASSOCIATION_DIRECTORY_CATALOG.flatMap((entry) => {
    const keys = [entry.domain, ...(entry.selfRelatedDomains ?? [])];
    return keys.map((d) => [d.toLowerCase(), entry] as const);
  }),
);

export function findAssociationDirectoryByDomain(
  domain?: string | null,
): AssociationDirectoryEntry | undefined {
  const normalized = normalizeDomain(domain);
  if (!normalized) return undefined;
  const exact = BY_DOMAIN.get(normalized);
  if (exact) return exact;
  for (const [key, entry] of BY_DOMAIN) {
    if (normalized.endsWith(`.${key}`)) return entry;
  }
  return undefined;
}

export function findAssociationDirectoryByUrl(
  url?: string | null,
): AssociationDirectoryEntry | undefined {
  return findAssociationDirectoryByDomain(url);
}

/**
 * 仅对单一国家名录返回 2 位大写 ISO 国家码；泛欧 `'EU'` 名录与未登记名录返回 undefined（绝不猜国）。
 */
export function associationDirectoryCountryIso(urlOrDomain?: string | null): string | undefined {
  const entry = findAssociationDirectoryByDomain(urlOrDomain);
  if (!entry || entry.countryIso === 'EU') return undefined;
  return entry.countryIso;
}

export interface SelectAssociationDirectoriesInput {
  industryTerms?: readonly string[];
  keywords?: readonly string[];
  countries?: readonly string[];
  regions?: readonly string[];
}

function matchesEntryTags(entry: AssociationDirectoryEntry, needles: readonly string[]): boolean {
  return entry.industryTags.some((tag) =>
    needles.some((needle) => needle.includes(tag) || tag.includes(needle)),
  );
}

/**
 * 按行业词/关键词与目标国筛选已批准的协会名录：
 *  - 指定了目标国时，仅返回命中目标国的单国名录 +（若目标国在欧洲）泛欧 EU 名录；
 *  - 未指定目标国时，按区域或估算规模降序返回匹配行业标签的名录；
 *  - 单国精确命中恒排在泛欧 EU 名录之前。
 */
export function selectAssociationDirectories(
  input: SelectAssociationDirectoriesInput,
): readonly AssociationDirectoryEntry[] {
  const needles = [...(input.industryTerms ?? []), ...(input.keywords ?? [])]
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 2);
  if (needles.length === 0) return [];

  const countrySet = new Set(
    (input.countries ?? []).map((code) => code.trim().toUpperCase()).filter(Boolean),
  );
  const regionSet = new Set(
    (input.regions ?? []).map((region) => region.trim().toLowerCase()).filter(Boolean),
  );
  const includesEurope =
    [...countrySet].some((code) => EUROPEAN_ISO2.has(code)) ||
    regionSet.has('europe') ||
    regionSet.has('eu') ||
    regionSet.has('dach');

  const matched = ASSOCIATION_DIRECTORY_CATALOG.filter((entry) => {
    if (!matchesEntryTags(entry, needles)) return false;
    if (countrySet.size === 0) return true;
    if (countrySet.has(entry.countryIso)) return true;
    return entry.countryIso === 'EU' && includesEurope;
  });

  return matched.sort((left, right) => {
    const leftExact = countrySet.has(left.countryIso) ? 1 : 0;
    const rightExact = countrySet.has(right.countryIso) ? 1 : 0;
    if (leftExact !== rightExact) return rightExact - leftExact;
    if (left.countryIso === 'EU' && right.countryIso !== 'EU') return 1;
    if (right.countryIso === 'EU' && left.countryIso !== 'EU') return -1;
    const leftRegion = regionSet.has(left.region.toLowerCase()) ? 1 : 0;
    const rightRegion = regionSet.has(right.region.toLowerCase()) ? 1 : 0;
    if (leftRegion !== rightRegion) return rightRegion - leftRegion;
    if (left.estimatedCompanies !== right.estimatedCompanies) {
      return right.estimatedCompanies - left.estimatedCompanies;
    }
    return left.slug.localeCompare(right.slug);
  });
}

export interface AssociationSourcePolicySeedInput {
  readonly domain: string;
  readonly sourceType: 'association';
  readonly accessMode: 'crawl';
  readonly reviewStatus: 'APPROVED';
  readonly robotsStatus: 'ALLOWS';
  readonly termsStatus: 'REVIEWED_OK';
  readonly personalData: false;
  readonly allowedPurpose: readonly ['discovery'];
  readonly retentionDays: 365;
  readonly notes: string;
}

/** 派生全部已批准光伏协会名录的逐域 source_policy seed 记录（按 domain 去重）。 */
export function associationDirectorySourcePolicyInputs(): readonly AssociationSourcePolicySeedInput[] {
  const seen = new Set<string>();
  const rows: AssociationSourcePolicySeedInput[] = [];
  for (const entry of ASSOCIATION_DIRECTORY_CATALOG) {
    if (seen.has(entry.domain)) continue;
    seen.add(entry.domain);
    const tags = entry.industryTags.slice(0, 6).join(',');
    rows.push(
      Object.freeze({
        domain: entry.domain,
        sourceType: 'association',
        accessMode: 'crawl',
        reviewStatus: 'APPROVED',
        robotsStatus: entry.robotsStatus,
        termsStatus: entry.termsStatus,
        personalData: false,
        allowedPurpose: Object.freeze(['discovery'] as const),
        retentionDays: 365,
        notes: `${entry.name} [${entry.countryIso}] | tags=${tags} | url=${entry.directoryUrl} | license=${entry.license} | tos=${entry.tosUrl} | verified=${entry.verifiedAt}`,
      }),
    );
  }
  return Object.freeze(rows);
}
