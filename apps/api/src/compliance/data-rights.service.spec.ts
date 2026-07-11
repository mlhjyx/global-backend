import { describe, it, expect } from 'vitest';
import { DataRightsService } from './data-rights.service';
import { JURISDICTION_POLICY_SEED } from './jurisdiction-policy.seed';
import { DataRightsContext } from './data-rights.types';

interface LoggedRow {
  [k: string]: unknown;
}

class FakePrisma {
  createdLogs: LoggedRow[] = [];
  rules: Array<Record<string, unknown>> = JURISDICTION_POLICY_SEED.map((r, i) => ({ id: `r${i}`, ...r }));

  jurisdictionPolicy = {
    findMany: async () => this.rules,
  };

  async withWorkspace<T>(_workspaceId: string, fn: (tx: unknown) => Promise<T>): Promise<T> {
    const tx = {
      policyDecisionLog: {
        create: async ({ data }: { data: LoggedRow }) => {
          this.createdLogs.push(data);
          return data;
        },
      },
    };
    return fn(tx);
  }
}

function svc(fake: FakePrisma): DataRightsService {
  return new DataRightsService(fake as never);
}

const WS = '00000000-0000-0000-0000-000000000001';

describe('DataRightsService', () => {
  it('loadRules 映射 DB 行到引擎规则', async () => {
    const fake = new FakePrisma();
    const s = svc(fake);
    const n = await s.loadRules();
    expect(n).toBe(JURISDICTION_POLICY_SEED.length);
    expect(s.ruleCount()).toBe(n);
  });

  it('evaluateAndLog 写 policy_decision_log 并返回判定', async () => {
    const fake = new FakePrisma();
    const s = svc(fake);
    await s.loadRules();
    const ctx: DataRightsContext = { action: 'STORE', dataClass: 'green', subjectJurisdiction: 'US', processorJurisdiction: 'US' };
    const d = await s.evaluateAndLog(WS, ctx);
    expect(d.allowed).toBe(true);
    expect(fake.createdLogs).toHaveLength(1);
    expect(fake.createdLogs[0].effect).toBe('ALLOW');
    expect(fake.createdLogs[0].workspaceId).toBe(WS);
  });

  it('🔴 内容最小化：只落 subjectId/lawfulBasisRef 引用，绝不嵌 note/人名明文', async () => {
    const fake = new FakePrisma();
    const s = svc(fake);
    await s.loadRules();
    const ctx: DataRightsContext = {
      action: 'OUTREACH',
      dataClass: 'red',
      subjectJurisdiction: 'EU',
      processorJurisdiction: 'EU',
      // 有效 basis（放行），但 note 含人名——绝不能进日志。
      lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-42', note: 'contains John Doe secret name' },
    };
    const d = await s.evaluateAndLog(WS, ctx, { subjectType: 'contact', subjectId: '11111111-1111-1111-1111-111111111111', actorId: 'user-9' });
    expect(d.allowed).toBe(true);
    const row = fake.createdLogs[0];
    expect(row.subjectId).toBe('11111111-1111-1111-1111-111111111111');
    expect(row.lawfulBasisRef).toBe('LIA-42');
    // 明文人名（note）绝不出现在任何字段。
    expect(JSON.stringify(row)).not.toContain('John Doe');
  });

  it('lawfulBasisRef 回退到 ctx.lawfulBasis.ref（永不落 note）', async () => {
    const fake = new FakePrisma();
    const s = svc(fake);
    await s.loadRules();
    await s.evaluateAndLog(WS, {
      action: 'AI_PROCESS',
      dataClass: 'red',
      subjectJurisdiction: 'EU',
      processorJurisdiction: 'EU',
      lawfulBasis: { basis: 'consent', ref: 'CONSENT-9', note: 'private note' },
    });
    expect(fake.createdLogs[0].lawfulBasisRef).toBe('CONSENT-9');
    expect(JSON.stringify(fake.createdLogs[0])).not.toContain('private note');
  });

  it('fail-closed：规则未加载时 red 数据一律拒', async () => {
    const fake = new FakePrisma();
    fake.rules = [];
    const s = svc(fake);
    await s.loadRules();
    const d = await s.evaluateAndLog(WS, { action: 'STORE', dataClass: 'red', subjectJurisdiction: 'EU', processorJurisdiction: 'EU' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('unregistered_red');
  });
});
