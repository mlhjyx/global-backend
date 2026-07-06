import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  ContactDiscoveryAdapter,
  ContactDiscoveryResult,
  DiscoveryResult,
  EmailVerdict,
  EmailVerificationAdapter,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';

/**
 * Sandbox Provider（Provider 合同签署前的第一版数据源，见路线图「数据源先 sandbox」）。
 * 关键约束——数据真实性 P-04：sandbox 产出的一切都明确标记为合成数据
 * （license='sandbox'、域名 *.sandbox.example.com），绝不冒充真实企业；
 * 它的价值是让 发现→归一→评分→Lead 管线端到端可验证，真源接入后只换适配器。
 *
 * 生成是【确定性】的：同一查询永远得到同一批记录（哈希种子），保证
 * 幂等、可测试、Temporal 重试安全。
 */

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rnd: () => number, arr: T[], fallback: T): T =>
  arr.length ? arr[Math.floor(rnd() * arr.length)] : fallback;

const asStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];

const NAME_STEMS = ['Nova', 'Vertex', 'Orion', 'Atlas', 'Zenith', 'Kestrel', 'Meridian', 'Quanta', 'Solis', 'Borealis'];
const NAME_SUFFIX = ['Manufacturing', 'Industries', 'Systems', 'Works', 'Group', 'Technologies'];
const TITLES = [
  { title: 'CEO', seniority: 'c_level', department: 'management' },
  { title: 'Head of Procurement', seniority: 'director', department: 'procurement' },
  { title: 'Technical Director', seniority: 'director', department: 'engineering' },
  { title: 'Operations Manager', seniority: 'manager', department: 'operations' },
];

export class SandboxDiscoveryProvider
  implements CompanyDiscoveryAdapter, ContactDiscoveryAdapter, EmailVerificationAdapter
{
  readonly key = 'sandbox';
  readonly classes: SourceClass[] = [
    'trade_data',
    'b2b_company_person',
    'company_registry',
    'public_intelligence',
    'industry_data',
  ];

  async discoverCompanies(query: CompanyDiscoveryQuery): Promise<DiscoveryResult> {
    const seed = hash32(JSON.stringify({ c: query.sourceClass, f: query.filters, k: query.keywords }));
    const rnd = mulberry32(seed);
    const countries = asStrArr(query.filters.country ?? query.filters.countries ?? query.filters.region);
    const industries = asStrArr(query.filters.industry ?? query.filters.industries ?? query.filters.sub_industry);
    const certs = asStrArr(query.filters.certifications);
    const keywords = query.keywords ?? [];
    const n = Math.min(query.limit, 25);

    const records: ProviderCompanyRecord[] = [];
    for (let i = 0; i < n; i++) {
      const stem = pick(rnd, NAME_STEMS, 'Nova');
      const suffix = pick(rnd, NAME_SUFFIX, 'Industries');
      const country = pick(rnd, countries, 'DE');
      const industry = pick(rnd, industries, 'manufacturing');
      const id = `${query.sourceClass}-${seed.toString(36)}-${i}`;
      const employeeBuckets = [80, 150, 260, 420, 700, 1200, 2400];
      const employeeCount = employeeBuckets[Math.floor(rnd() * employeeBuckets.length)];
      records.push({
        externalId: id,
        name: `${stem} ${suffix} ${country} #${i + 1}`,
        domain: `${stem.toLowerCase()}-${i + 1}.sandbox.example.com`,
        country,
        industry,
        employeeCount,
        revenueUsd: Math.round(employeeCount * (80_000 + rnd() * 120_000)),
        attributes: {
          certifications: certs.filter(() => rnd() > 0.4),
          keywords: keywords.filter(() => rnd() > 0.5),
          source_class: query.sourceClass,
          sandbox: true, // 显式标记：合成数据
        },
      });
    }
    return { records, costCents: 0 };
  }

  async discoverContacts(company: { name: string; domain?: string }): Promise<ContactDiscoveryResult> {
    const seed = hash32(company.domain ?? company.name);
    const rnd = mulberry32(seed);
    const count = 2 + Math.floor(rnd() * 2);
    const first = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Robin', 'Casey'];
    const last = ['Weber', 'Tanaka', 'Novak', 'Silva', 'Larsen', 'Petrov'];
    const contacts = Array.from({ length: count }, (_, i) => {
      const f = pick(rnd, first, 'Alex');
      const l = pick(rnd, last, 'Weber');
      const role = TITLES[i % TITLES.length];
      return {
        externalId: `${seed.toString(36)}-p${i}`,
        fullName: `${f} ${l}`,
        ...role,
        email: company.domain ? `${f.toLowerCase()}.${l.toLowerCase()}@${company.domain}` : undefined,
      };
    });
    return { contacts, costCents: 0 };
  }

  async verifyEmail(email: string): Promise<EmailVerdict> {
    const h = hash32(email) % 100;
    const status = h < 70 ? 'VALID' : h < 85 ? 'RISKY' : 'INVALID';
    return { status, detail: 'sandbox deterministic verdict', costCents: 0 };
  }
}
