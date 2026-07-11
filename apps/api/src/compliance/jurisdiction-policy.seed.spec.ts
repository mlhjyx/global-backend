import { describe, it, expect } from 'vitest';
import { JURISDICTION_POLICY_SEED } from './jurisdiction-policy.seed';
import { evaluateDataRights } from './data-rights.engine';
import { evaluateEmailGate } from '../discovery/compliance/email-verification-gate';
import { DATA_ACTIONS, JurisdictionRule } from './data-rights.types';

const RULES = JURISDICTION_POLICY_SEED as readonly JurisdictionRule[];

describe('jurisdiction_policy 种子矩阵', () => {
  it('green/amber 通配行存在', () => {
    const green = RULES.find((r) => r.dataClass === 'green' && r.action === '*' && r.effect === 'ALLOW');
    const amber = RULES.find((r) => r.dataClass === 'amber' && r.action === '*' && r.effect === 'ALLOW');
    expect(green).toBeDefined();
    expect(amber).toBeDefined();
  });

  it('red × 每个主体法域 × 全 7 动作都有行（无遗漏=无 fail-closed 意外拒）', () => {
    for (const subject of ['EU', 'UK', 'US', 'OTHER'] as const) {
      for (const action of DATA_ACTIONS) {
        const row = RULES.find(
          (r) => r.subjectJurisdiction === subject && r.processorJurisdiction === '*' && r.dataClass === 'red' && r.action === action,
        );
        expect(row, `${subject}/${action}`).toBeDefined();
      }
    }
  });

  it('PIPL 跨境行存在（EU/UK → CN 高风险动作 REQUIRE_APPROVAL）', () => {
    const piplEu = RULES.filter(
      (r) => r.subjectJurisdiction === 'EU' && r.processorJurisdiction === 'CN' && r.effect === 'REQUIRE_APPROVAL',
    );
    expect(piplEu.length).toBe(4); // AI_PROCESS/DERIVE/EXPORT/OUTREACH
    const cnSubject = RULES.find((r) => r.subjectJurisdiction === 'CN' && r.action === 'OUTREACH');
    expect(cnSubject?.effect).toBe('REQUIRE_APPROVAL');
  });

  it('ALLOW_WITH_BASIS 行恒 requiresLawfulBasis=true（不变式）', () => {
    for (const r of RULES) {
      if (r.effect === 'ALLOW_WITH_BASIS') expect(r.requiresLawfulBasis).toBe(true);
    }
  });

  it('无同 (subject,processor,class,action) 重复行（防歧义冲突）', () => {
    const keys = RULES.map((r) => `${r.subjectJurisdiction}|${r.processorJurisdiction}|${r.dataClass}|${r.action}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('引擎 ↔ email 门 一致性（一个大脑）', () => {
  it('人名邮箱无 basis：email 门与 DataRights(red/AI_PROCESS) 一致拒', () => {
    const gate = evaluateEmailGate({
      email: 'max.mustermann@acme.de',
      kind: 'personal',
      policy: { allowPersonalWithoutBasis: false },
    });
    const dr = evaluateDataRights(
      { action: 'AI_PROCESS', dataClass: 'red', subjectJurisdiction: 'EU', processorJurisdiction: 'EU' },
      RULES,
    );
    expect(gate.allowed).toBe(false);
    expect(dr.allowed).toBe(false);
  });

  it('职能邮箱：email 门与 DataRights(amber) 一致放行', () => {
    const gate = evaluateEmailGate({
      email: 'info@acme.de',
      kind: 'role',
      policy: { allowPersonalWithoutBasis: false },
    });
    const dr = evaluateDataRights(
      { action: 'AI_PROCESS', dataClass: 'amber', subjectJurisdiction: 'EU', processorJurisdiction: 'EU' },
      RULES,
    );
    expect(gate.allowed).toBe(true);
    expect(dr.allowed).toBe(true);
  });
});
