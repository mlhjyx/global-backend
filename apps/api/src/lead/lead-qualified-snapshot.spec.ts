import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConflictException } from '@nestjs/common';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { buildLeadQualifiedSnapshot, classifyLeadQualified } from './lead-qualified-snapshot';
import { LeadService } from './lead.service';

/**
 * 收口③ LeadQualified 快照 v1：decide(accept) 的 outbox payload 从「三字段摘要」升级为
 * **事实的不可变副本**（公司绿区事实 + 联系人 ref + 六维分 + 规则版本）。
 *
 * Consumer Test：快照必须通过 packages/contracts/events/payloads/lead-qualified.v1.schema.json
 * （ajv 2020-12）校验 —— 契约即真值，代码与 schema 漂移在此翻红。
 * 🔴 GDPR 最小化：contact_refs 绝不嵌 full_name/email（SaaS 拿 contact_id 走受控 API 取详情）。
 *
 * 对旧代码 RED：旧 decide payload = {icpId, canonicalCompanyId, totalScore}，无 snapshot_version。
 */

/** 从 cwd 向上找 monorepo 内的契约 schema（vitest 从 apps/api 跑；从仓根跑也能找到）。 */
function contractSchemaPath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'packages/contracts/events/payloads/lead-qualified.v1.schema.json');
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  throw new Error('lead-qualified.v1.schema.json not found — contract file missing');
}

function loadValidator() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(contractSchemaPath(), 'utf8'));
  return { validate: ajv.compile(schema), schema };
}

const WS = '11111111-1111-1111-1111-111111111111';
const LEAD_ID = '22222222-2222-2222-2222-222222222222';
const ICP_ID = '33333333-3333-3333-3333-333333333333';
const COMPANY_ID = '44444444-4444-4444-4444-444444444444';
const CONTACT_ID = '55555555-5555-5555-5555-555555555555';

function makeLead(over: Record<string, unknown> = {}) {
  return {
    id: LEAD_ID,
    workspaceId: WS,
    icpId: ICP_ID,
    canonicalCompanyId: COMPANY_ID,
    status: 'REVIEW',
    queue: 'recommended',
    fitVerdict: 'match',
    fitReasons: { material: 'm', reasons: [] },
    totalScore: 0.55,
    scores: { fit: 0.8, role: 0.5, intent: 0.3, dataQuality: 0.7, reachability: 0.6, engagement: 0 },
    scoreDetail: { rules: [] },
    version: 2,
    ...over,
  };
}

function makeCompany(over: Record<string, unknown> = {}) {
  return {
    id: COMPANY_ID,
    name: 'Acme Pumpen GmbH',
    domain: 'acme-pumpen.de',
    country: 'DE',
    status: 'ENRICHED',
    attributes: {
      gleif: { lei: '5299000J2N45DDNE4Y28' },
      fda: { registration_number: '3001234567' },
    },
    contacts: [
      {
        id: CONTACT_ID,
        fullName: 'Max Mustermann', // 🔴 绝不进快照
        title: 'Head of Procurement',
        seniority: 'director',
        department: 'procurement',
        contactPoints: [
          { status: 'VALID', type: 'email', value: 'max@acme-pumpen.de' }, // 🔴 email 值绝不进快照
          { status: 'UNVERIFIED', type: 'phone', value: '+49 123' },
        ],
      },
    ],
    ...over,
  };
}

describe('buildLeadQualifiedSnapshot — 快照 v1（Consumer Test：契约 schema 校验）', () => {
  it('完整 lead+company+contacts → ajv 校验通过，字段映射正确', () => {
    const { validate } = loadValidator();
    const snap = buildLeadQualifiedSnapshot({
      lead: makeLead(),
      company: makeCompany(),
      icpVersion: 3,
    });

    const ok = validate(snap);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);

    expect(snap.snapshot_version).toBe(1);
    expect(snap.lead_id).toBe(LEAD_ID);
    expect(snap.workspace_id).toBe(WS);
    expect(snap.icp_id).toBe(ICP_ID);
    expect(snap.icp_version).toBe(3);
    expect(snap.company_ref).toEqual({
      canonical_company_id: COMPANY_ID,
      name: 'Acme Pumpen GmbH',
      domain: 'acme-pumpen.de',
      country: 'DE',
      identifiers: { lei: '5299000J2N45DDNE4Y28', fda_reg: '3001234567' },
    });
    // scores 映射：dataQuality → data_quality；demand_proof：旧 lead（scores 无 demandProof 键）→ null 如实
    expect(snap.scores).toEqual({
      fit: 0.8,
      role: 0.5,
      intent: 0.3,
      demand_proof: null,
      reachability: 0.6,
      data_quality: 0.7,
      engagement: 0,
      total: 0.55,
    });
    expect(snap.fit_verdict).toBe('match');
    expect(snap.evidence_refs).toEqual({ score_detail_available: true, fit_reasons_available: true });
    expect(snap.qualification_rule_version).toBe('additive-6dim-v2');
    expect(snap.storage_rights_decision).toBeNull(); // 未传 storageRightsDecision → 缺省 null（非破坏）
    expect(snap.personal_data_class).toBe('named_person_refs');
    expect(snap.suppression_state).toBe('none');
    expect(snap.recommended_action).toBe('handoff_to_campaign');
    expect(snap.valid_until).toBeNull();
  });

  it('收口⑥：传入 storageRightsDecision → 落进 storage_rights_decision（且仍过契约校验）', () => {
    const { validate } = loadValidator();
    const snap = buildLeadQualifiedSnapshot({
      lead: makeLead(),
      company: makeCompany(),
      icpVersion: 3,
      storageRightsDecision: 'ALLOW',
    });
    expect(validate(snap)).toBe(true);
    expect(snap.storage_rights_decision).toBe('ALLOW');
  });

  it('🔴 contact_refs 只带 ref+职务元数据：绝不含 full_name/email（对象键断言）', () => {
    const snap = buildLeadQualifiedSnapshot({
      lead: makeLead(),
      company: makeCompany(),
      icpVersion: 3,
    });

    expect(snap.contact_refs).toHaveLength(1);
    const ref = snap.contact_refs[0] as Record<string, unknown>;
    expect(Object.keys(ref).sort()).toEqual(
      ['contact_id', 'department', 'has_verified_contact_point', 'personal_data', 'seniority', 'title'].sort(),
    );
    expect(JSON.stringify(snap)).not.toContain('Max Mustermann');
    expect(JSON.stringify(snap)).not.toContain('max@acme-pumpen.de');
    expect(ref.has_verified_contact_point).toBe(true); // 有 VALID contact_point
    expect(ref.personal_data).toBe(true);
  });

  it('未评分 lead（scores=null/totalScore=null）→ 各维 null、total null，仍过 schema', () => {
    const { validate } = loadValidator();
    const snap = buildLeadQualifiedSnapshot({
      lead: makeLead({ scores: null, totalScore: null, scoreDetail: null, fitReasons: null, fitVerdict: null }),
      company: makeCompany({ attributes: null, contacts: [] }),
      icpVersion: null,
    });

    const ok = validate(snap);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(snap.scores).toEqual({
      fit: null,
      role: null,
      intent: null,
      demand_proof: null,
      reachability: null,
      data_quality: null,
      engagement: null,
      total: null,
    });
    expect(snap.fit_verdict).toBeNull();
    expect(snap.icp_version).toBeNull();
    expect(snap.company_ref.identifiers).toEqual({ lei: null, fda_reg: null });
    expect(snap.contact_refs).toEqual([]);
    expect(snap.personal_data_class).toBe('company_facts_only');
    expect(snap.evidence_refs).toEqual({ score_detail_available: false, fit_reasons_available: false });
  });

  it('收口⑤：lead.scores 带 demandProof → 快照 demand_proof 填数值且仍过 v1 契约（预留槽位，零 schema 变更）', () => {
    const { validate } = loadValidator();
    const snap = buildLeadQualifiedSnapshot({
      lead: makeLead({
        scores: { fit: 0.8, role: 0.5, intent: 0.9, demandProof: 0.83, dataQuality: 0.7, reachability: 0.6, engagement: 0 },
      }),
      company: makeCompany(),
      icpVersion: 3,
    });
    const ok = validate(snap);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(snap.scores.demand_proof).toBe(0.83);
  });

  it('SUPPRESSED 公司 → suppression_state=suppressed', () => {
    const snap = buildLeadQualifiedSnapshot({
      lead: makeLead(),
      company: makeCompany({ status: 'SUPPRESSED' }),
      icpVersion: 1,
    });
    expect(snap.suppression_state).toBe('suppressed');
  });

  it('schema 拒绝缺 required 字段与多余字段（additionalProperties:false）', () => {
    const { validate } = loadValidator();
    const good = buildLeadQualifiedSnapshot({ lead: makeLead(), company: makeCompany(), icpVersion: 3 });

    const missing = { ...(good as unknown as Record<string, unknown>) };
    delete missing.lead_id;
    expect(validate(missing)).toBe(false);

    const extra = { ...(good as unknown as Record<string, unknown>), full_name: 'leak' };
    expect(validate(extra)).toBe(false);

    // contact_refs item 层面也拒绝 full_name/email（🔴 契约级 GDPR 护栏）
    const leakedContact = JSON.parse(JSON.stringify(good)) as { contact_refs: Array<Record<string, unknown>> };
    leakedContact.contact_refs[0].email = 'x@y.z';
    expect(validate(leakedContact)).toBe(false);
  });
});

// ── LeadService.decide：CAS + 幂等 + 快照 payload（C/H）────────────────────

/**
 * 有状态 decide mock tx：updateMany 按 version 做 CAS（命中才落状态并 version+1），
 * findUnique 每次返回当前快照——重复 decide/并发冲突两条路径都能真实走到。
 */
function makeDecideTx(
  lead: Record<string, unknown>,
  company: Record<string, unknown>,
  outboxCreate: ReturnType<typeof vi.fn>,
  decisionCreate: ReturnType<typeof vi.fn>,
) {
  return {
    lead: {
      findUnique: async () => ({ ...lead }),
      updateMany: async ({
        where,
        data,
      }: {
        where: { version?: number };
        data: Record<string, unknown>;
      }) => {
        if (where.version !== undefined && lead.version !== where.version) return { count: 0 };
        lead.status = data.status;
        lead.queue = data.queue;
        lead.version = (lead.version as number) + 1;
        return { count: 1 };
      },
    },
    leadDecision: { create: decisionCreate },
    canonicalCompany: { findUnique: async () => company },
    icpDefinition: { findUnique: async () => ({ version: 3 }) },
    outboxEvent: { create: outboxCreate },
  };
}

function makeDecideService(tx: unknown, rights: { effect: string; allowed: boolean } = { effect: 'ALLOW', allowed: true }): LeadService {
  const prisma = { withWorkspace: async (_ws: string, fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  // DataRights 桩：decide 用 evaluate().effect（快照）+ .allowed（强制门）；真判定由 data-rights.context.spec 覆盖。
  const dataRights = {
    evaluate: () => ({ reason: 'test', ruleId: null, ruleVersion: 'v1', requiresLawfulBasis: false, article14NoticeRequired: false, ...rights }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new LeadService(prisma as any, dataRights as any);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const decideCtx = { workspaceId: WS, userId: 'user-1' } as any;

describe('LeadService.decide(accept) — 同事务取数、payload=快照（对旧代码 RED）', () => {
  it('accept → outboxEvent.create payload 为 v1 快照且 schemaVersion=1', async () => {
    const outboxCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const decisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const svc = makeDecideService(makeDecideTx(makeLead(), makeCompany(), outboxCreate, decisionCreate));

    await svc.decide(decideCtx, LEAD_ID, 'accept');

    expect(outboxCreate).toHaveBeenCalledTimes(1);
    const created = outboxCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(created.eventType).toBe('LeadQualified');
    expect(created.schemaVersion).toBe(1);
    const payload = created.payload as Record<string, unknown>;
    // 旧 payload = {icpId, canonicalCompanyId, totalScore} → snapshot_version undefined → RED
    expect(payload.snapshot_version).toBe(1);
    // 收口⑥：decide 经 DataRightsService 把存储权利判定接进快照（此前恒 null）
    expect(payload.storage_rights_decision).toBe('ALLOW');
    const { validate } = loadValidator();
    const ok = validate(payload);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('收口⑥ 强制：storage_rights !allowed（DENY/跨境人审）→ accept 抛 CONFLICT，绝不发 handoff', async () => {
    const outboxCreate = vi.fn();
    const svc = makeDecideService(
      makeDecideTx(makeLead(), makeCompany(), outboxCreate, vi.fn()),
      { effect: 'DENY', allowed: false },
    );
    await expect(svc.decide(decideCtx, LEAD_ID, 'accept')).rejects.toMatchObject({
      response: { error: { code: 'STORAGE_RIGHTS_NOT_GRANTED' } },
    });
    expect(outboxCreate).not.toHaveBeenCalled(); // 存储权利不 allow → 不把具名 refs 交给 SaaS
  });

  it('H：含具名人 refs 的快照 → 事件 privacyClassification=RESTRICTED；无联系人 → CONFIDENTIAL', async () => {
    // 有联系人分支
    const withContacts = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    await makeDecideService(makeDecideTx(makeLead(), makeCompany(), withContacts, vi.fn())).decide(
      decideCtx,
      LEAD_ID,
      'accept',
    );
    expect((withContacts.mock.calls[0][0].data as Record<string, unknown>).privacyClassification).toBe('RESTRICTED');

    // 无联系人分支
    const noContacts = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    await makeDecideService(
      makeDecideTx(makeLead(), makeCompany({ contacts: [] }), noContacts, vi.fn()),
    ).decide(decideCtx, LEAD_ID, 'accept');
    expect((noContacts.mock.calls[0][0].data as Record<string, unknown>).privacyClassification).toBe('CONFIDENTIAL');
  });
});

describe('LeadService.decide — 幂等短路 + 并发 CAS（C）', () => {
  it('C 回归：同状态重复 accept → 只 1 条 outbox 事件 + 1 条 decision（第二次直接返回现状）', async () => {
    const lead = makeLead(); // 有状态：首次 accept 后 status 变 QUALIFIED
    const outboxCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const decisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const svc = makeDecideService(makeDecideTx(lead, makeCompany(), outboxCreate, decisionCreate));

    await svc.decide(decideCtx, LEAD_ID, 'accept');
    const second = (await svc.decide(decideCtx, LEAD_ID, 'accept')) as Record<string, unknown>;

    // 旧代码：第二次照样 update + decision + 新 event_id 的 LeadQualified（消费端按
    // event_id 去重失效，SaaS 收两次 handoff）→ 下面两断言 RED。
    expect(outboxCreate).toHaveBeenCalledTimes(1);
    expect(decisionCreate).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('QUALIFIED'); // 幂等返回现状
  });

  it('C 回归：version 不匹配（并发 decide）→ ConflictException CONFLICT，不建 decision、不发事件', async () => {
    const lead = makeLead({ version: 5 }); // findUnique 读到 5……
    const outboxCreate = vi.fn();
    const decisionCreate = vi.fn();
    const tx = makeDecideTx(lead, makeCompany(), outboxCreate, decisionCreate);
    // ……但提交前另一请求已推进到 6（CAS 不命中）
    tx.lead.findUnique = async () => ({ ...lead, version: 4 });
    const svc = makeDecideService(tx);

    await expect(svc.decide(decideCtx, LEAD_ID, 'accept')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.decide(decideCtx, LEAD_ID, 'accept')).rejects.toMatchObject({
      response: { error: { code: 'CONFLICT' } },
    });
    expect(outboxCreate).not.toHaveBeenCalled();
    expect(decisionCreate).not.toHaveBeenCalled();
  });

  it('QUALIFIED→reject 的人工改判仍允许（不落幂等短路）', async () => {
    const lead = makeLead({ status: 'QUALIFIED' });
    const outboxCreate = vi.fn();
    const decisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const svc = makeDecideService(makeDecideTx(lead, makeCompany(), outboxCreate, decisionCreate));

    const r = (await svc.decide(decideCtx, LEAD_ID, 'reject')) as Record<string, unknown>;

    expect(r.status).toBe('REJECTED');
    expect(decisionCreate).toHaveBeenCalledTimes(1);
    expect(outboxCreate).not.toHaveBeenCalled(); // reject 不发 LeadQualified
  });
});

describe('classifyLeadQualified — 分级按内容定（H，与快照同源）', () => {
  it('有 contact_refs → RESTRICTED；空 → CONFIDENTIAL', () => {
    const withRefs = buildLeadQualifiedSnapshot({ lead: makeLead(), company: makeCompany(), icpVersion: 1 });
    expect(classifyLeadQualified(withRefs)).toBe('RESTRICTED');

    const noRefs = buildLeadQualifiedSnapshot({
      lead: makeLead(),
      company: makeCompany({ contacts: [] }),
      icpVersion: 1,
    });
    expect(classifyLeadQualified(noRefs)).toBe('CONFIDENTIAL');
  });
});

describe('mapScores 值域护栏 — 契约是系统边界（J）', () => {
  it('喂超界值（负数/超 1）→ 快照 8 个分值全部落 [0,1] 且仍过契约 schema', () => {
    const { validate } = loadValidator();
    const snap = buildLeadQualifiedSnapshot({
      lead: makeLead({
        // 混合符号权重时代/上游 bug 可能落库的越界历史值
        scores: { fit: 1.7, role: -0.2, intent: 2.5, dataQuality: 0.5, reachability: 1.0001, engagement: -3 },
        totalScore: 1.31,
      }),
      company: makeCompany(),
      icpVersion: 1,
    });

    const values = [
      snap.scores.fit,
      snap.scores.role,
      snap.scores.intent,
      snap.scores.demand_proof,
      snap.scores.reachability,
      snap.scores.data_quality,
      snap.scores.engagement,
      snap.scores.total,
    ];
    for (const v of values) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(snap.scores.fit).toBe(1);
    expect(snap.scores.role).toBe(0);
    expect(snap.scores.total).toBe(1);
    const ok = validate(snap);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
});
