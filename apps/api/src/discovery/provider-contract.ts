/**
 * ProviderAdapter 契约（PRD 11.13 / 7.4.7）。领域层只依赖这些接口；
 * Provider 原始 JSON 永不穿透领域层（ADR-017）—— 原样进 raw_source_record，
 * 归一后才进 canonical。
 */

export type SourceClass =
  | 'trade_data'
  | 'b2b_company_person'
  | 'company_registry'
  | 'contact_discovery'
  | 'email_verification'
  | 'public_intelligence'
  | 'industry_data';

export interface CompanyDiscoveryQuery {
  sourceClass: SourceClass;
  filters: Record<string, unknown>;
  keywords: string[];
  limit: number;
}

/** Provider 返回的公司记录（适配器已做字段名归一，值保持原样）。 */
export interface ProviderCompanyRecord {
  externalId: string;
  name: string;
  domain?: string;
  country?: string;
  region?: string;
  industry?: string;
  employeeCount?: number;
  revenueUsd?: number;
  attributes?: Record<string, unknown>;
  /** 公开采集留痕（PRD 8.11）：来源页/抓取时间/内容指纹/解析版本 */
  provenance?: {
    sourceUrl: string;
    fetchedAt: string;
    contentHash: string;
    parserVersion: string;
  };
}

export interface DiscoveryOptions {
  /** Source Registry 中被 SUSPENDED 的域名 —— 适配器必须在爬取前跳过（DAT-011）。 */
  blockedDomains?: string[];
}

export interface ProviderContactRecord {
  externalId: string;
  fullName: string;
  title?: string;
  seniority?: string;
  department?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
}

export interface DiscoveryResult {
  records: ProviderCompanyRecord[];
  costCents: number;
}

export interface ContactDiscoveryResult {
  contacts: ProviderContactRecord[];
  costCents: number;
}

export interface EmailVerdict {
  status: 'VALID' | 'RISKY' | 'INVALID';
  detail?: string;
  costCents: number;
}

/** 公司发现类 Provider（trade_data / b2b / registry / public_intelligence / industry_data）。 */
export interface CompanyDiscoveryAdapter {
  key: string;
  classes: SourceClass[];
  discoverCompanies(query: CompanyDiscoveryQuery, opts?: DiscoveryOptions): Promise<DiscoveryResult>;
}

/** 联系人发现（Waterfall 第 5 步：仅对高价值企业购买联系人）。 */
export interface ContactDiscoveryAdapter {
  key: string;
  discoverContacts(company: {
    name: string;
    domain?: string;
    country?: string;
  }): Promise<ContactDiscoveryResult>;
}

/** 邮箱验证（发送前实时验证，PRD 7.4.7）。 */
export interface EmailVerificationAdapter {
  key: string;
  verifyEmail(email: string): Promise<EmailVerdict>;
}

/** 富集适配器的输入：已归一的 canonical 公司最小画像。 */
export interface CompanyEnrichmentInput {
  name: string;
  domain?: string;
  country?: string;
  region?: string;
}

/**
 * 富集结果。matched=false 表示未命中或置信不足 → 不写入 canonical（绝不贴错）。
 * attributes 命名空间化并入 canonical.attributes；命中的字段各自留 field_evidence。
 */
export interface EnrichmentResult {
  matched: boolean;
  confidence: number; // 0..1
  attributes: Record<string, unknown>;
  provenance?: {
    sourceUrl: string;
    fetchedAt: string;
    contentHash: string;
    parserVersion: string;
  };
  costCents: number;
}

/**
 * 公司富集类 Provider（PRD 7.4.7 Waterfall 富化段）：对已归一的公司补充
 * 结构化属性（法律身份、母子关系、编码…）。与发现相反 —— 输入是公司、输出是增量。
 */
export interface CompanyEnrichmentAdapter {
  key: string;
  enrichCompany(input: CompanyEnrichmentInput): Promise<EnrichmentResult>;
}
