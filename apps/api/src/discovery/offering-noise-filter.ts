/**
 * 卖方主营产品（Offering）导航菜单噪音过滤器（Batch 1.5-B）。
 *
 * 现网取证（2026-11-25 琏升科技 `offering` 表）：官网理解阶段把网页导航/功能入口
 * （如 `"下载中心"`、`"产品询问"`）误抽成公司主营产品写入 `offering`，污染卖家画像与开发信。
 * 本过滤表采用确定性精确/正则规则，仅拦截明显站点功能导航词，不误伤真实工业产品名。
 */

const EXACT_NOISE_LOWER: ReadonlySet<string> = new Set([
  // 中文站点导航 / 交互入口
  '首页', '主页', '关于我们', '公司简介', '企业简介', '联系我们', '联系方式',
  '下载中心', '资料下载', '文档下载', '下载', '产品中心', '产品展示', '产品列表',
  '产品询问', '产品咨询', '在线咨询', '在线留言', '留言板', '询盘', '获取报价', '免费报价',
  '新闻中心', '新闻资讯', '新闻动态', '公司新闻', '行业资讯', '案例中心', '成功案例',
  '服务支持', '技术支持', '售后服务', '售后反馈', '客户服务', '常见问题', '帮助中心',
  '加入我们', '人才招聘', '招贤纳士', '投资者关系', '隐私政策', '法律声明', '使用条款',
  '网站地图', '收益计算', '收益计算器', '计算器', '合作伙伴', '登录', '注册', '搜索',
  // 英文 / 欧洲多语种站点导航
  'home', 'about', 'about us', 'company', 'contact', 'contact us', 'contacts',
  'download', 'downloads', 'download center', 'resources', 'documentation', 'datasheets',
  'products', 'product center', 'product inquiry', 'inquiry', 'inquiries', 'get a quote', 'request a quote',
  'news', 'newsroom', 'blog', 'press', 'events', 'media', 'cases', 'case studies',
  'support', 'service', 'services', 'after-sales', 'after sales', 'feedback', 'faq', 'faqs', 'help', 'help center',
  'careers', 'jobs', 'join us', 'investor relations', 'investors', 'partners',
  'privacy', 'privacy policy', 'legal', 'legal notice', 'terms', 'terms of use', 'cookies', 'sitemap',
  'login', 'sign in', 'register', 'search',
  'impressum', 'kontakt', 'über uns', 'ueber uns', 'datenschutz', 'karriere', 'aktuelles',
  'chi siamo', 'contatti', 'azienda', 'notizie', 'lavora con noi', 'note legali',
  'quienes somos', 'contacto', 'noticias', 'aviso legal', 'mentions legales', 'a propos',
]);

const NOISE_PATTERN_RE =
  /^(?:下载中心|资料下载|产品询问|产品咨询|在线咨询|售后反馈|联系我们|关于我们|新闻资讯|收益计算器?|隐私政策|法律声明|加入我们|人才招聘|download\s+center|product\s+inquir(?:y|ies)|contact\s+us|about\s+us|privacy\s+policy|terms\s+(?:of\s+use|and\s+conditions)|after[- ]?sales?\s+(?:service|feedback|support))$/iu;

/** 判断一条候选产品名称是否属于网站导航菜单/功能入口噪音。 */
export function isNavigationNoiseOffering(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return true;
  const normalized = name.trim().replace(/\s+/gu, ' ');
  if (normalized.length < 2) return true;
  const lower = normalized.toLowerCase();
  return EXACT_NOISE_LOWER.has(lower) || NOISE_PATTERN_RE.test(normalized);
}

/** 过滤产品名列表中的站点导航噪音，保持原顺序。 */
export function filterOfferingNames(names: readonly string[]): string[] {
  return names
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !isNavigationNoiseOffering(item));
}
