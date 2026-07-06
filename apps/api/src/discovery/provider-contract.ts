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
  discoverCompanies(query: CompanyDiscoveryQuery): Promise<DiscoveryResult>;
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
