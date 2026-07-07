/**
 * intent 事件 → 六维 Intent 维 · 端到端演示（纯确定性，无网络）。
 * 用 #4 网站变更引擎实际投影出的 attributes.intent 形态喂 scoreLead，
 * 对比「无信号 / 近期强信号 / 陈旧信号」三种情形的 Intent 维与总分/队列变化。
 *   node --import tsx scripts/verify-intent-scoring.mts
 */
import { scoreLead, CompanyForScoring, IcpForScoring } from '../src/lead/scoring';

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

// 典型出海制造业 ICP
const icp: IcpForScoring = {
  rules: [
    { kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'manufacturing' },
    { kind: 'EXCLUSION', field: 'country', operator: 'in', value: ['XX'] },
  ],
  triggerSignals: ['扩产', 'new production line', 'sourcing'],
  committeeRoles: [{ role: 'procurement', title: 'Head of Procurement' }],
};

const base = (): CompanyForScoring => ({
  name: 'Acme Fabrication', domain: 'acme.com', country: 'US', industry: 'manufacturing',
  employeeCount: 800, revenueUsd: null, attributes: {}, status: 'ENRICHED',
  contacts: [{ title: 'Head of Procurement', seniority: 'director', contactPoints: [{ type: 'email', status: 'VALID' }] }],
});

// #4 实测：TRUMPF supplier 页命中 supplier_program → SOURCING_OPENED(strength 1)
const intentAttr = (events: { type: string; at: string; strength: number }[]) => ({
  intent: {
    last_change_at: events[0].at,
    intent_score: Math.max(...events.map((e) => e.strength)),
    counts: events.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] ?? 0) + 1 }), {} as Record<string, number>),
    events: events.map((e) => ({ ...e, page_kind: 'sourcing', page_url: 'https://acme.com/suppliers' })),
    _ts: daysAgo(0),
  },
});

const scenarios: { label: string; company: CompanyForScoring }[] = [
  { label: '无 intent 信号（基线）', company: base() },
  {
    label: '近期 SOURCING_OPENED（6 天前，实测 TRUMPF/Flex 命中）',
    company: { ...base(), attributes: intentAttr([{ type: 'SOURCING_OPENED', at: daysAgo(6), strength: 1 }]) },
  },
  {
    label: '陈旧 SOURCING_OPENED（180 天前，≈3 个半衰期）',
    company: { ...base(), attributes: intentAttr([{ type: 'SOURCING_OPENED', at: daysAgo(180), strength: 1 }]) },
  },
  {
    label: '近期 HIRING_UP(采购岗) + NEW_PRODUCTS',
    company: {
      ...base(),
      attributes: intentAttr([
        { type: 'HIRING_UP', at: daysAgo(10), strength: 0.9 },
        { type: 'NEW_PRODUCTS', at: daysAgo(4), strength: 0.7 },
      ]),
    },
  },
];

console.log('六维权重: fit .35 / role .15 / intent .15 / dataQuality .15 / reachability .15 / engagement .05');
console.log('Intent 半衰期 60 天\n');
for (const s of scenarios) {
  const r = scoreLead(s.company, icp, { nowMs: NOW });
  console.log(`── ${s.label}`);
  console.log(`   Intent 维 = ${r.scores.intent}  | 命中信号: ${r.detail.intentSignals.length ? r.detail.intentSignals.join('/') : '—（关键词代理）'}`);
  console.log(`   总分 = ${r.totalScore}  队列 = ${r.queue}`);
  console.log(`   ${r.detail.notes.find((n) => n.includes('Intent')) ?? ''}\n`);
}
