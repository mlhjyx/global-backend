import type { ExecutionBroker } from '../../tools/tool-contract';
import type { GooglePatentsInput, GooglePatentsOutput } from '../../tools/source-tools';
import { GOOGLE_PATENTS_LICENSE, PatentApplicant } from '../../adapters/bigquery-patents';
import {
  ContactDiscoveryAdapter,
  ContactDiscoveryContext,
  ContactDiscoveryResult,
  ExecutionContext,
  ProviderContactRecord,
} from '../provider-contract';
import { pickBestByName, normForMatch } from '../name-match';
import { normalizePersonName } from '../person-name';

const GOOGLE_PATENTS_BASE = 'https://patents.google.com/'; // 公开专利门户（证据留痕）
// 🔴 公司对齐门（比公司发现门 0.72 更严）：贴错公司 = 把 A 公司发明人挂到 B 公司，危害大（同 CH/EPO）。
const ALIGN_MIN_SCORE = 0.9;
const ALIGN_MIN_MARGIN = 0.1;
// 过滤旋钮：近 5 年 + 每公司上限 25 位 distinct 发明人（防大公司爆量 + 数据最小化）。
const RECENCY_YEARS = 5;
const MAX_INVENTORS = 25;

/** 当前年（UTC）——可注入时钟测。 */
export function currentYear(now: () => number = Date.now): number {
  return new Date(now()).getUTCFullYear();
}

/**
 * 国别门（🔴 防跨境同名并）：company 与 applicant 国别**都为 alpha-2 且不同** → 冲突（弃）。
 * 任一非 alpha-2（如全称 "Germany"）→ 不判冲突（欠并方向，靠名对齐兜底，绝不误杀真匹配）。
 */
export function countryConflicts(companyCountry?: string, applicantCountry?: string): boolean {
  const alpha2 = (s?: string): string | undefined => {
    const t = (s ?? '').trim().toLowerCase();
    return /^[a-z]{2}$/.test(t) ? t : undefined;
  };
  const c = alpha2(companyCountry);
  const a = alpha2(applicantCountry);
  if (!c || !a) return false;
  return c !== a;
}

/** 显示名归一（"Surname, Given" → "Given Surname" + 词首大写）。best-effort，不影响合并（合并走 normalizePersonName）。 */
export function toReadableName(name: string): string {
  const idx = name.indexOf(',');
  const ordered = idx >= 0 ? `${name.slice(idx + 1).trim()} ${name.slice(0, idx).trim()}` : name.trim();
  return ordered.toLowerCase().replace(/(^|[\s'’.-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * 一位发明人 → ProviderContactRecord（🔴 具名个人 + CC BY 署名 + **无 externalIds**）。
 * 无 externalIds：Google Patents/IFI 无消歧到人的稳定 id，硬凑「公开号+名字」键会令同一人跨专利被误拆
 * （`hasExternalIdConflict` 触发）——故不产 Tier 0 键，合并走待办 2 的归一名（Tier 2/3）。
 */
export function toContactRecord(rawName: string, applicantName: string): ProviderContactRecord {
  const fullName = toReadableName(rawName);
  const idKey = normalizePersonName(rawName).replace(/\s+/g, '-') || fullName.toLowerCase().replace(/\s+/g, '-');
  return {
    externalId: `google_patents:${applicantName.toLowerCase().replace(/\s+/g, '-')}:${idKey}`, // 记录自身键（persist 不据此去重，仅留痕）
    fullName,
    title: 'Inventor',
    buyingRole: 'technical_buyer', // 发明人 = 技术评估席（买家委员会口径）
    isTargetRole: false, // 🟡 保守：专利数据不足以断言匹配卖方 ICP 具体画像，不夸大
    personalData: true, // 🔴 具名个人 → persist 写 person.profile 证据（lawful-basis 门前置）
    sourcePage: GOOGLE_PATENTS_BASE,
    license: GOOGLE_PATENTS_LICENSE, // CC BY 4.0 署名义务（写入 field_evidence.license，非硬编码 licensed）
    // 🔴 无 externalIds（见上）——不走 Tier 0，走 Tier 2/3 归一名并。
  };
}

/**
 * BigQuery Google Patents 发明人发现 Provider（待办 3 · 替代被封 EPO OPS；`ContactDiscoveryAdapter`）。
 * 官方 BigQuery 公共数据集（非爬）→ 近期专利具名 inventor = 技术买家 → 高置信对齐公司 → 归一名并入决策人图谱。
 *
 * 🔴 三道护栏绝不挂错公司：applicant 名高置信对齐（score≥0.9 且 margin≥0.1）+ 国别门 + 歧义即弃返空。
 * 🔴 数据最小化：只取 inventor name（residence/地址/国籍在 adapter 层就不映射）。
 * 🔴 用途门：google_patents.search = required 工具，直连前过 §8.8 fail-closed（无 broker = 不出网）。
 * fail-safe：任何失败（无 creds/网络/闸门拒绝/超额）返空、不抛穿（单源不阻断其余）。
 */
export class GooglePatentsInventorProvider implements ContactDiscoveryAdapter {
  readonly key = 'google_patents';

  constructor(private readonly deps?: { broker?: ExecutionBroker; now?: () => number }) {}

  private log(msg: string): void {
    console.warn(`[google_patents] ${msg}`);
  }

  async discoverContacts(
    company: { name: string; domain?: string; country?: string },
    ctx: ExecutionContext,
    _sellerCtx?: ContactDiscoveryContext,
  ): Promise<ContactDiscoveryResult> {
    const name = company.name?.trim();
    if (!name) return { contacts: [], costCents: 0 };
    // 无闸门 = 不允许原始出网（绝不绕 ToolBroker）→ 诚实降级空。
    if (!this.deps?.broker) {
      this.log('skip: broker unavailable (fail-closed, no raw egress)');
      return { contacts: [], costCents: 0 };
    }
    const toYear = currentYear(this.deps.now);
    const fromYear = toYear - RECENCY_YEARS;
    const purposeCtx = {
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      correlationId: ctx.correlationId,
      purpose: 'discovery',
    };
    try {
      const res = await this.deps.broker.invoke<GooglePatentsInput, GooglePatentsOutput>(
        'google_patents.search',
        { applicant: name, fromYear, toYear },
        purposeCtx,
      );
      const patents = res.data.patents ?? [];
      if (!patents.length) return { contacts: [], costCents: 0 };

      // 1) 收集 distinct applicant 候选（**按归一名去重**：同一公司的拼写变体 "Siemens AG"/"Siemens
      //    Aktiengesellschaft" 不自相竞争把 margin 压到 0 而误弃）→ 高置信对齐（歧义/低置信即弃，绝不挂错公司）。
      const applicantMap = new Map<string, PatentApplicant>();
      for (const p of patents) {
        for (const a of p.applicants) {
          const key = normForMatch(a.name);
          if (a.name && key && !applicantMap.has(key)) applicantMap.set(key, a);
        }
      }
      const best = pickBestByName(name, [...applicantMap.values()], (a) => a.name);
      if (!best || best.score < ALIGN_MIN_SCORE || best.margin < ALIGN_MIN_MARGIN) {
        return { contacts: [], costCents: 0 };
      }
      // 2) 国别门（都为 alpha-2 且冲突 → 弃）。
      if (countryConflicts(company.country, best.item.country)) return { contacts: [], costCents: 0 };

      // 3) 只留**独家申请人**为对齐公司的专利 → 收发明人（按归一名去重、上限 cap）。
      // 🔴 biblio 的 applicants[]/inventors[] 无「谁属谁」映射：合著专利（Siemens+Bosch）无法判定某发明人
      //    属哪家 → 若保留会把合作方员工误挂到对齐公司（还会喂错下游邮箱猜测）。故**只取独家申请人专利**，
      //    合著专利整条弃（诚实边界：漏采 < 错挂）。applicant 比对走归一名（容同公司拼写变体）。
      const alignedNorm = normForMatch(best.item.name);
      const seen = new Set<string>();
      const contacts: ProviderContactRecord[] = [];
      outer: for (const p of patents) {
        const sole = p.applicants[0];
        if (p.applicants.length !== 1 || normForMatch(sole.name) !== alignedNorm) continue;
        // 🔴 跨境同名防漏并：归一名去重只留了**首个** applicant，同归一名但不同国别的 applicant
        //    （DE "Acme" 对齐后，US "Acme Inc" 归一同为 'acme'）其专利会溜进本循环 → 逐专利再过国别门，
        //    把国别与本公司冲突的独家申请人专利整条弃，绝不把他国同名公司的发明人并进本公司。
        if (countryConflicts(company.country, sole.country)) continue;
        for (const inv of p.inventors) {
          const norm = normalizePersonName(inv.name);
          if (!norm || seen.has(norm)) continue;
          seen.add(norm);
          contacts.push(toContactRecord(inv.name, best.item.name));
          if (contacts.length >= MAX_INVENTORS) break outer;
        }
      }
      this.log(`✓ ${name} → ${best.item.name} (${best.score.toFixed(2)}): ${contacts.length} inventors`);
      return { contacts, costCents: 0 };
    } catch (err) {
      // fail-safe：单源失败/闸门拒绝不阻断其余源（CLAUDE.md §5）；拒绝原因已入 Broker DENIED trace。
      this.log(`discover failed: ${String(err).slice(0, 150)}`);
      return { contacts: [], costCents: 0 };
    }
  }
}
