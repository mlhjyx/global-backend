import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateEmailGate,
  isValidLawfulBasis,
  resolveEmailVerificationPolicy,
  stampLawfulBasis,
} from './email-verification-gate';

const STRICT = { allowPersonalWithoutBasis: false };
const OPEN = { allowPersonalWithoutBasis: true };

describe('邮箱验证合规门 · 合法性基础裁决（纯逻辑）', () => {
  it('职能邮箱（info@/sales@…）默认放行，无需合法性基础', () => {
    const d = evaluateEmailGate({ email: 'info@acme.de', policy: STRICT });
    expect(d.allowed).toBe(true);
    expect(d.kind).toBe('role');
    expect(d.requiresLawfulBasis).toBe(false);
    expect(d.lawfulBasis).toBeUndefined();
  });

  it('🔴 人名邮箱无合法性基础 → 拦截（默认策略），不携带 basis', () => {
    const d = evaluateEmailGate({ email: 'max.mustermann@acme.de', policy: STRICT });
    expect(d.allowed).toBe(false);
    expect(d.kind).toBe('personal');
    expect(d.requiresLawfulBasis).toBe(true);
    expect(d.reason).toBe('personal_email_no_lawful_basis');
  });

  it('人名邮箱给出有效合法性基础 → 放行并透传 basis（供留痕）', () => {
    const basis = { basis: 'legitimate_interest' as const, ref: 'LIA-2026-014' };
    const d = evaluateEmailGate({ email: 'jane.doe@acme.de', lawfulBasis: basis, policy: STRICT });
    expect(d.allowed).toBe(true);
    expect(d.lawfulBasis).toEqual(basis);
    expect(d.reason).toContain('legitimate_interest');
  });

  it('无效 basis（未知类型）不算数 → 仍拦截', () => {
    const d = evaluateEmailGate({
      email: 'jane.doe@acme.de',
      lawfulBasis: { basis: 'vibes' as never },
      policy: STRICT,
    });
    expect(d.allowed).toBe(false);
  });

  it('显式开关 allowPersonalWithoutBasis → 放行，但合成 basis 留痕（note 标明来自开关）', () => {
    const d = evaluateEmailGate({ email: 'max.mustermann@acme.de', policy: OPEN });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('personal_policy_override');
    expect(d.lawfulBasis?.basis).toBe('legitimate_interest');
    expect(d.lawfulBasis?.note).toMatch(/switch/i);
  });

  it('禁联名单（suppression）命中 → 一律拦截，即便是职能邮箱', () => {
    const role = evaluateEmailGate({ email: 'info@acme.de', suppressed: true, policy: OPEN });
    expect(role.allowed).toBe(false);
    expect(role.reason).toBe('suppressed');
    const personal = evaluateEmailGate({
      email: 'max@acme.de',
      suppressed: true,
      lawfulBasis: { basis: 'consent' as const },
      policy: OPEN,
    });
    expect(personal.allowed).toBe(false);
    expect(personal.reason).toBe('suppressed');
  });

  it('无效语法 → kind=invalid，不拦（交验证器判 INVALID）', () => {
    const d = evaluateEmailGate({ email: 'not-an-email', policy: STRICT });
    expect(d.kind).toBe('invalid');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('invalid_syntax');
  });

  it('🔴 畸形但命中禁联 → BLOCKED（禁联先于语法短路，Codex P2）', () => {
    // 否则畸形地址走 invalid→放行，服务层再路由到忽略 ctx 的 sandbox，可能给禁联地址判非 BLOCKED
    const d = evaluateEmailGate({ email: 'not-an-email', suppressed: true, policy: OPEN });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('suppressed');
    expect(d.kind).toBe('invalid');
  });

  it('调用方显式传 kind 覆盖本地分级（如 impressum 明确具名人）', () => {
    // 本地部分像职能词，但调用方已知其为具名人 → 按 personal 走门
    const d = evaluateEmailGate({ email: 'team@acme.de', kind: 'personal', policy: STRICT });
    expect(d.allowed).toBe(false);
    expect(d.kind).toBe('personal');
  });
});

describe('isValidLawfulBasis', () => {
  it('已知 basis 类型为有效', () => {
    expect(isValidLawfulBasis({ basis: 'consent' })).toBe(true);
    expect(isValidLawfulBasis({ basis: 'contract' })).toBe(true);
  });
  it('空 / 未知类型无效', () => {
    expect(isValidLawfulBasis(undefined)).toBe(false);
    expect(isValidLawfulBasis(null)).toBe(false);
    expect(isValidLawfulBasis({ basis: 'nope' as never })).toBe(false);
  });
});

describe('stampLawfulBasis · 落库前补断言人/时间（Codex #13 P2）', () => {
  it('开关合成的 basis 无 who/when → 必须能被补上（审计可回溯）', () => {
    // 复现问题源头：override 路径合成的 basis 不带 recordedBy/recordedAt
    const synth = evaluateEmailGate({ email: 'max.mustermann@acme.de', policy: { allowPersonalWithoutBasis: true } }).lawfulBasis!;
    expect(synth.recordedBy).toBeUndefined();
    expect(synth.recordedAt).toBeUndefined();
    const stamped = stampLawfulBasis(synth, 'user-1', '2026-07-07T00:00:00.000Z');
    expect(stamped.recordedBy).toBe('user-1');
    expect(stamped.recordedAt).toBe('2026-07-07T00:00:00.000Z');
    expect(stamped.basis).toBe('legitimate_interest'); // 其余字段保留
  });

  it('已带 who/when 的 basis → 尊重原值，不覆盖', () => {
    const stamped = stampLawfulBasis(
      { basis: 'consent', recordedBy: 'orig-user', recordedAt: '2020-01-01T00:00:00.000Z' },
      'user-1',
      '2026-07-07T00:00:00.000Z',
    );
    expect(stamped.recordedBy).toBe('orig-user');
    expect(stamped.recordedAt).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('resolveEmailVerificationPolicy · env + 逐次覆盖', () => {
  afterEach(() => {
    delete process.env.EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS;
  });

  it('默认（无 env、无 ctx）= 保守 false', () => {
    expect(resolveEmailVerificationPolicy()).toEqual({ allowPersonalWithoutBasis: false });
  });

  it('env=true → 全局开', () => {
    process.env.EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS = 'true';
    expect(resolveEmailVerificationPolicy().allowPersonalWithoutBasis).toBe(true);
  });

  it('ctx 显式值优先于 env', () => {
    process.env.EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS = 'true';
    expect(resolveEmailVerificationPolicy({ allowPersonalWithoutBasis: false }).allowPersonalWithoutBasis).toBe(false);
  });
});
