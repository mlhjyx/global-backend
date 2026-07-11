import { describe, expect, it } from 'vitest';
import { isLikelyIndividualApplicant, FDA_CLEARANCE, FDA_CLEARANCE_STRENGTH } from './openfda-intent-projection.service';

// isLikelyIndividualApplicant = §6 GDPR 边界的**高精度**闸门：只在明确人名格式（头衔 / "Surname, Given"）上触发，
// 绝不按「几个大写词」形状误伤真公司（会丢线索、损核心功能）。裸「John Smith」式不自动判个体（风险有界——从不落
// contact/邮箱等具名个人字段）。DB 端到端投影/幂等/§8.8 门走真实 verify 脚本（verify-openfda-510k-intent.mts）。
describe('§6 个体户自然人边界（isLikelyIndividualApplicant）—— 高精度、不误伤真公司', () => {
  it('公司名（含 3 词公司名、CJK 公司）一律保留，绝不按形状误判', () => {
    for (const n of [
      'Shenzhen Beauty Every Moment Intelligent Electric Co., Ltd.',
      'Guangdong Jinme Medical Technology Co., Ltd.',
      'Philips Ultrasound LLC',
      'Siemens Healthineers GmbH',
      'Boston Scientific Corporation',
      'Karl Storz Endoscopy', // 3 词公司名（形状似人名，绝不误伤）
      'GE Precision Healthcare', // 3 词公司名
      'Ischemaview', // 单词品牌
      'Medtronic',
      '3M',
      'Johnson & Johnson',
      '深圳市某某医疗器械有限公司',
      'John Smith', // 裸人名式：不自动判个体（避免误伤真公司），风险有界
    ]) {
      expect(isLikelyIndividualApplicant(n)).toBe(false);
    }
  });

  it('明确人名格式 → 跳过（人称头衔 / "Surname, Given"）', () => {
    for (const n of ['Dr. Jane Smith', 'Mr. Robert Miller', 'Prof. Alan Turing', 'Smith, John', 'Miller, Robert J.']) {
      expect(isLikelyIndividualApplicant(n)).toBe(true);
    }
  });

  it('逗号但带组织标记（"Ever Fortune.Ai, Co., Ltd."）→ 保留（非人名）', () => {
    expect(isLikelyIndividualApplicant('Ever Fortune.Ai, Co., Ltd.')).toBe(false);
  });

  it('头衔起头但带法人后缀（"Dr. Mach GmbH & Co. KG"）→ 保留（组织标记先判，Codex 复审回归）', () => {
    expect(isLikelyIndividualApplicant('Dr. Mach GmbH & Co. KG')).toBe(false);
    expect(isLikelyIndividualApplicant('Prof. Zimmer Medical Ltd')).toBe(false);
  });

  it('空名 → 跳过（不可入库）', () => {
    expect(isLikelyIndividualApplicant('')).toBe(true);
    expect(isLikelyIndividualApplicant('   ')).toBe(true);
  });
});

describe('FDA_CLEARANCE 常量', () => {
  it('type 与强度（新品/上市时机，略弱于 TED 开放招标 0.9）', () => {
    expect(FDA_CLEARANCE).toBe('FDA_CLEARANCE');
    expect(FDA_CLEARANCE_STRENGTH).toBeGreaterThan(0);
    expect(FDA_CLEARANCE_STRENGTH).toBeLessThan(0.9);
  });
});

// ─── 收口⑤：从 source_signal 只读投影（回归锁：真跑抓到的 taxonomy 键大小写 bug）───
import type { PrismaService } from '../prisma/prisma.service';
import { companyIdentity } from '../discovery/identity';
import { OpenFdaIntentProjectionService } from './openfda-intent-projection.service';

const WS = 'ws-1';
const DAY = 86_400_000;

function fdaSignal(name: string, over?: Record<string, unknown>) {
  const country = (over?.subjectCountry as string) ?? 'IL';
  return {
    id: `sig-${name}`,
    providerKey: 'openfda',
    signalType: 'FDA_CLEARANCE',
    externalId: (over?.externalId as string) ?? 'K261234',
    subjectName: name,
    subjectCountry: country,
    subjectKey: companyIdentity({ name, country }).dedupeKey,
    taxonomyKeys: (over?.taxonomyKeys as string[]) ?? ['fda:QAS'],
    strength: 0.85,
    occurredAt: (over?.occurredAt as Date) ?? new Date(Date.now() - 5 * DAY),
    payload: { product_code: 'QAS', k_number: 'K261234', device: 'BriefCase', source: 'openfda' },
    status: (over?.status as string) ?? 'ACTIVE',
    ...over,
  };
}

function fdaFakePrisma(signals: Record<string, unknown>[]) {
  const companies = new Map<string, Record<string, unknown>>();
  const evidence: unknown[] = [];
  const tx = {
    canonicalCompany: {
      findUnique: async ({ where }: { where: { workspaceId_dedupeKey: { dedupeKey: string } } }) =>
        companies.get(where.workspaceId_dedupeKey.dedupeKey) ?? null,
      upsert: async ({ where, create }: { where: { workspaceId_dedupeKey: { dedupeKey: string } }; create: Record<string, unknown> }) => {
        const key = where.workspaceId_dedupeKey.dedupeKey;
        if (!companies.has(key)) companies.set(key, { id: `co-${companies.size}`, ...create });
        return { id: (companies.get(key) as { id: string }).id };
      },
    },
    fieldEvidence: { create: async ({ data }: { data: unknown }) => (evidence.push(data), { id: 'fe' }) },
  };
  const prisma = {
    companies,
    evidence,
    sourceSignal: {
      findMany: async ({ where, take }: { where: { status: string; occurredAt: { gte: Date } }; take: number }) =>
        signals
          .filter((s) => s.status === where.status && (s.occurredAt as Date).getTime() >= where.occurredAt.gte.getTime())
          .sort((a, b) => (b.occurredAt as Date).getTime() - (a.occurredAt as Date).getTime())
          .slice(0, take),
    },
    withWorkspace: async (_ws: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return prisma as unknown as PrismaService & { companies: typeof companies; evidence: typeof evidence };
}

describe('OpenFdaIntentProjectionService.projectClearances —— source_signal 只读投影', () => {
  it('回归锁：wanted 码小写输入也命中 fda: 前缀键（真跑抓到 toUpperCase 整键永不相等 bug）', async () => {
    const prisma = fdaFakePrisma([fdaSignal('Aidoc Medical Ltd')]);
    const svc = new OpenFdaIntentProjectionService({ prisma });
    const r = await svc.projectClearances(WS, { productCodes: ['qas'] });
    expect(r.signalsMatched).toBe(1);
    expect(r.companiesTouched).toBe(1);
  });

  it('码不符 / 非 ACTIVE → 不投影；个体户主体防御纵深跳过', async () => {
    const prisma = fdaFakePrisma([
      fdaSignal('Other Corp', { taxonomyKeys: ['fda:LLZ'], externalId: 'K1' }),
      fdaSignal('Expired Inc', { status: 'EXPIRED', externalId: 'K2' }),
      fdaSignal('Smith, John', { externalId: 'K3' }),
    ]);
    const svc = new OpenFdaIntentProjectionService({ prisma });
    const r = await svc.projectClearances(WS, { productCodes: ['QAS'] });
    expect(r.signalsMatched).toBe(1); // 仅 Smith, John 的 QAS 键匹配
    expect(r.skippedIndividual).toBe(1); // §6 防御纵深
    expect(r.companiesTouched).toBe(0);
  });
});
