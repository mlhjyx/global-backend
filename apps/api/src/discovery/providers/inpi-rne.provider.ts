import type { ExecutionBroker } from '../../tools/tool-contract';
import type { InpiRneInput, InpiRneOutput } from '../../tools/source-tools';
import { INPI_RNE_LICENSE, FrCompanyHit, FrDirigeant } from '../../adapters/inpi-rne';
import {
  ContactDiscoveryAdapter,
  ContactDiscoveryContext,
  ContactDiscoveryResult,
  ExecutionContext,
  ProviderContactRecord,
} from '../provider-contract';
import { pickBestByName } from '../name-match';
import { normalizePersonName } from '../person-name';

const ANNUAIRE_BASE = 'https://annuaire-entreprises.data.gouv.fr/entreprise/';
// 🔴 公司对齐门（比公司发现门 0.72 更严）：贴错公司 = 把 A 公司负责人挂到 B 公司，危害大。
const ALIGN_MIN_SCORE = 0.9;
const ALIGN_MIN_MARGIN = 0.1;
// 每公司硬上限（按归一名去重后）——防大公司负责人爆量涌入。
const MAX_DIRIGEANTS_PER_COMPANY = 25;

/**
 * FR 判定（🔴 **country 优先**，防跨辖区挂错）：
 *  - country 有值 → 只按 country 判（∈ FR 集合 → true；显式非法辖区一律 false，忽略域名）。
 *    防：把德国 KAESER 的名字丢进**法国注册库** → 命中「KAESER FRANCE」误挂法国负责人到德国公司。
 *  - country 缺失/空 → 才用 `.fr` 域名作**弱兜底**（仅缺国别时）。
 */
const FR_COUNTRIES: ReadonlySet<string> = new Set([
  'fr', 'fra', 'france', 'french republic', 'république française', 'republique francaise',
]);
export function isFrCompany(country?: string, domain?: string): boolean {
  const c = (country ?? '').trim().toLowerCase();
  if (c) return FR_COUNTRIES.has(c); // country 优先：非法辖区不管域名一律拒
  return (domain ?? '').trim().toLowerCase().endsWith('.fr'); // 仅国别缺失时的弱兜底
}

/**
 * qualite → 买家角色分类（不夸大）。执行位（gérant/président/directeur/administrateur/directoire/
 * associé indéfiniment responsable）= 掌预算的经济买家；其它 personne physique dirigeant 泛标 decision_maker。
 */
// 阴阳性并收（Directrice/Administratrice 等女性执行位与男性同权，绝不系统性低标女性高管）。
const EXEC_QUALITE = /g[ée]rant|pr[ée]sident|directeur|directrice|administrat(?:eur|rice)|directoire|associ[ée] ind[ée]finiment responsable/i;
export function classifyRole(qualite: string): { buyingRole: string; seniority?: string } {
  if (EXEC_QUALITE.test(qualite)) return { buyingRole: 'economic_buyer', seniority: 'executive' };
  return { buyingRole: 'decision_maker' };
}

/** 显示名归一（`prénoms + nom` → 词首大写）。best-effort（D'Angelo 等特殊大小写不完美，不影响跨源归一并）。 */
export function toReadableName(d: FrDirigeant): string {
  const ordered = d.prenoms ? `${d.prenoms} ${d.nom}` : d.nom;
  return titleCase(ordered.trim());
}
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'’.-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** 一个 dirigeant → ProviderContactRecord（🔴 具名个人 + Licence Ouverte 署名；**无 externalIds**=name-merge）。 */
export function toContactRecord(d: FrDirigeant, company: FrCompanyHit): ProviderContactRecord {
  const fullName = toReadableName(d);
  const { buyingRole, seniority } = classifyRole(d.qualite);
  return {
    externalId: `inpi_rne:${company.siren}:${fullName.toLowerCase().replace(/\s+/g, '-')}`,
    fullName,
    title: d.qualite, // 可读 qualite（Gérant / Président…）
    seniority,
    buyingRole,
    isTargetRole: false, // 🟡 保守：结构化数据不足以断言匹配卖方 ICP 具体买家画像，不夸大
    personalData: true, // 🔴 具名个人 → persist 写 person.profile 证据（lawful-basis 门前置）
    sourcePage: `${ANNUAIRE_BASE}${company.siren}`,
    license: INPI_RNE_LICENSE, // Licence Ouverte 2.0 署名义务（写入 field_evidence.license，非硬编码 licensed）
    // 无 externalIds —— 法国无 person id，走待办 2 归一名合并（同 EPO，非 Tier 0，见 design §3）
  };
}

/**
 * 法国 dirigeants 发现 Provider（待办 3 第三个身份源；`ContactDiscoveryAdapter`）。
 * 开放政务 API（非爬）→ dirigeant = 具名经济买家 → **name-merge**（无 Tier 0，见 design §3）。
 *
 * 🔴 三道护栏绝不挂错公司：FR 门 + 只留 active 公司 + 高置信公司对齐（score≥0.9 且 margin≥0.1，歧义即弃）。
 * 🔴 数据最小化：只取 nom/prenoms/qualite（DOB/国籍在 adapter 层就不映射）。
 * 🔴 用途门：inpi_rne.search = required 工具，直连前过 §8.8 fail-closed（无 broker = 不出网）。
 * fail-safe：任何失败（无 broker/网络/闸门拒绝）返空、不抛穿（单源不阻断其余）。
 */
export class InpiRneContactProvider implements ContactDiscoveryAdapter {
  readonly key = 'inpi_rne';

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  private log(msg: string): void {
    console.warn(`[inpi_rne] ${msg}`);
  }

  async discoverContacts(
    company: { name: string; domain?: string; country?: string },
    ctx: ExecutionContext,
    _sellerCtx?: ContactDiscoveryContext,
  ): Promise<ContactDiscoveryResult> {
    // 🔴 FR 门：非法国公司不搜（防把某法国同名公司的负责人挂到外国公司）。
    if (!isFrCompany(company.country, company.domain)) return { contacts: [], costCents: 0 };
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
      // 1) 公司对齐：搜名（dirigeants 内联）→ 只留 active → 高置信 + margin（歧义/低置信即弃，绝不挂错公司）。
      const searchRes = await this.deps.broker.invoke<InpiRneInput, InpiRneOutput>(
        'inpi_rne.search',
        { op: 'search', query: company.name, limit: 10 },
        purposeCtx,
      );
      const active = (searchRes.data.companies ?? []).filter((c) => c.etatAdministratif === 'A');
      const best = pickBestByName(company.name, active, (c) => c.name);
      if (!best || best.score < ALIGN_MIN_SCORE || best.margin < ALIGN_MIN_MARGIN) {
        return { contacts: [], costCents: 0 };
      }

      // 2) dirigeant → ProviderContactRecord（按归一名去重 + 每公司 cap）。
      const seen = new Set<string>();
      const contacts: ProviderContactRecord[] = [];
      for (const d of best.item.dirigeants) {
        const rec = toContactRecord(d, best.item);
        const nameKey = normalizePersonName(rec.fullName);
        if (!nameKey || seen.has(nameKey)) continue; // 归一名去重（同名负责人不重复采）
        seen.add(nameKey);
        contacts.push(rec);
        if (contacts.length >= MAX_DIRIGEANTS_PER_COMPANY) break;
      }
      this.log(`✓ ${company.name} → ${best.item.siren} (${best.score.toFixed(2)}): ${contacts.length} dirigeants`);
      return { contacts, costCents: 0 };
    } catch (err) {
      // fail-safe：单源失败/闸门拒绝不阻断其余源（CLAUDE.md §5）；拒绝原因已入 Broker DENIED trace。
      this.log(`discover failed: ${String(err).slice(0, 150)}`);
      return { contacts: [], costCents: 0 };
    }
  }
}
