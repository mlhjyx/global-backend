import type { ExecutionBroker } from '../../tools/tool-contract';
import type { CompaniesHouseInput, CompaniesHouseOutput } from '../../tools/source-tools';
import { COMPANIES_HOUSE_LICENSE, ChCompanyHit, ChOfficer } from '../../adapters/companies-house';
import {
  ContactDiscoveryAdapter,
  ContactDiscoveryContext,
  ContactDiscoveryResult,
  ExecutionContext,
  ProviderContactRecord,
} from '../provider-contract';
import { pickBestByName } from '../name-match';

const CH_FIND_BASE = 'https://find-and-update.company-information.service.gov.uk/company/';
const OFFICER_SCHEME = 'uk-ch-officer';
// 🔴 公司对齐门（比公司发现门 0.72 更严）：贴错公司 = 把 A 公司董事挂到 B 公司，危害大。
const ALIGN_MIN_SCORE = 0.9;
const ALIGN_MIN_MARGIN = 0.1;

/** GB 判定：英国国别归一集 或 域名以 .uk 结尾（防搜非英公司误挂）。 */
const GB_COUNTRIES: ReadonlySet<string> = new Set([
  'gb', 'uk', 'gbr', 'united kingdom', 'great britain', 'england', 'scotland', 'wales', 'northern ireland',
]);
export function isUkCompany(country?: string, domain?: string): boolean {
  const c = (country ?? '').trim().toLowerCase();
  if (c && GB_COUNTRIES.has(c)) return true;
  const d = (domain ?? '').trim().toLowerCase();
  return d.endsWith('.uk');
}

/**
 * 显示名归一（CH `"SURNAME, Given Middle"` → `"Given Middle Surname"` + 词首大写）。
 * best-effort：McDonald/O'Brien 等特殊大小写不完美——**不影响跨源合并**（合并走 normalizePersonName 归一，与显示名无关）。
 */
export function toReadableName(chName: string): string {
  const idx = chName.indexOf(',');
  const ordered = idx >= 0 ? `${chName.slice(idx + 1).trim()} ${chName.slice(0, idx).trim()}` : chName.trim();
  return titleCase(ordered);
}
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'’.-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** 一个 active director → ProviderContactRecord（🔴 具名个人 + OGL 署名 + officer_id Tier 0 键）。 */
export function toContactRecord(officer: ChOfficer, company: ChCompanyHit): ProviderContactRecord {
  const fullName = toReadableName(officer.name);
  const externalIds = officer.officerId ? [{ scheme: OFFICER_SCHEME, value: officer.officerId }] : undefined;
  const idKey = officer.officerId ?? fullName.toLowerCase().replace(/\s+/g, '-');
  return {
    externalId: `companies_house:${company.companyNumber}:${idKey}`,
    fullName,
    title: 'Director',
    seniority: 'director', // 董事会级——对齐 scoring Role 维（title+seniority 命中委员会角色关键词）
    buyingRole: 'economic_buyer', // 董事掌预算 = 经济买家（买家委员会口径）
    isTargetRole: false, // 🟡 保守：CH 结构化数据不足以断言匹配卖方 ICP 具体买家画像，不夸大
    personalData: true, // 🔴 具名个人 → persist 写 person.profile 证据（lawful-basis 门前置）
    sourcePage: `${CH_FIND_BASE}${company.companyNumber}`,
    license: COMPANIES_HOUSE_LICENSE, // OGL v3.0 署名义务（写入 field_evidence.license，非硬编码 licensed）
    externalIds,
  };
}

/**
 * UK Companies House 董事发现 Provider（待办 3 第一个身份源；`ContactDiscoveryAdapter`）。
 * 官方注册处 API（非爬）→ active director = 具名经济买家 + 稳定 officer_id → Tier 0 externalId 精确并。
 *
 * 🔴 三道护栏绝不挂错公司：GB 门 + 只留 active 公司 + 高置信公司对齐（score≥0.9 且 margin≥0.1，歧义即弃）。
 * 🔴 数据最小化：只取 name+role+officer_id（DOB/国籍/住址在 adapter 层就不映射）。
 * 🔴 用途门：companies_house.search = required 工具，直连前过 §8.8 fail-closed（无 broker = 不出网）。
 * fail-safe：任何失败（无 key/网络/闸门拒绝）返空、不抛穿（单源不阻断其余）。
 */
export class CompaniesHouseContactProvider implements ContactDiscoveryAdapter {
  readonly key = 'companies_house';

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  private log(msg: string): void {
    console.warn(`[companies_house] ${msg}`);
  }

  async discoverContacts(
    company: { name: string; domain?: string; country?: string },
    ctx: ExecutionContext,
    _sellerCtx?: ContactDiscoveryContext,
  ): Promise<ContactDiscoveryResult> {
    // 🔴 GB 门：非英公司不搜（防把英国某同名公司的董事挂到外国公司）。
    if (!isUkCompany(company.country, company.domain)) return { contacts: [], costCents: 0 };
    // 无闸门 = 不允许原始出网（绝不绕 ToolBroker）→ 诚实降级空。
    if (!this.deps?.broker) {
      this.log('skip: broker unavailable (fail-closed, no raw egress)');
      return { contacts: [], costCents: 0 };
    }
    const purposeCtx = {
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      correlationId: ctx.correlationId,
      purpose: 'discovery',
    };
    try {
      // 1) 公司对齐：搜名 → 只留 active → 高置信 + margin（歧义/低置信即弃，绝不挂错公司）。
      const searchRes = await this.deps.broker.invoke<CompaniesHouseInput, CompaniesHouseOutput>(
        'companies_house.search',
        { op: 'search', query: company.name, limit: 5 },
        purposeCtx,
      );
      const active = (searchRes.data.companies ?? []).filter((c) => c.companyStatus === 'active');
      const best = pickBestByName(company.name, active, (c) => c.title);
      if (!best || best.score < ALIGN_MIN_SCORE || best.margin < ALIGN_MIN_MARGIN) {
        return { contacts: [], costCents: 0 };
      }

      // 2) 取 active director（officer_role='director' 且未卸任）→ ProviderContactRecord。
      const officersRes = await this.deps.broker.invoke<CompaniesHouseInput, CompaniesHouseOutput>(
        'companies_house.search',
        { op: 'officers', companyNumber: best.item.companyNumber, limit: 50 },
        purposeCtx,
      );
      const directors = (officersRes.data.officers ?? []).filter(
        (o) => o.officerRole === 'director' && !o.resignedOn,
      );
      const contacts = directors.map((o) => toContactRecord(o, best.item));
      this.log(`✓ ${company.name} → ${best.item.companyNumber} (${best.score.toFixed(2)}): ${contacts.length} active directors`);
      return { contacts, costCents: 0 };
    } catch (err) {
      // fail-safe：单源失败/闸门拒绝不阻断其余源（CLAUDE.md §5）；拒绝原因已入 Broker DENIED trace。
      this.log(`discover failed: ${String(err).slice(0, 150)}`);
      return { contacts: [], costCents: 0 };
    }
  }
}
