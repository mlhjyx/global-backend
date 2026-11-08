import { describe, expect, it } from 'vitest';
import {
  catchAllClassFromEmailVerdictDetail,
  confidenceForState,
  eventVerdictFromEmailVerdict,
  legacyStatusToState,
  nextReverifyAtForState,
  projectLegacyStatus,
  sourceTypeForContactObservation,
  stateFromEmailVerdict,
  transitionVerificationState,
  verifiedAtStateColumns,
} from './contact-point-verification-state';

/**
 * P1-01/03：contact_point 四态的纯函数面——回填映射、verdict 映射、状态机转换与
 * 来源分类。迁移 SQL 里的回填 CASE 必须与 legacyStatusToState 逐分支一致（静态契约
 * 见 contact-point-four-state.migration.spec.ts）。
 */
describe('四态与 legacy status 投影', () => {
  it('projectLegacyStatus：四态 → legacy status（写入器同步维护旧列）', () => {
    expect(projectLegacyStatus('VALID')).toBe('VALID');
    expect(projectLegacyStatus('INVALID')).toBe('INVALID');
    expect(projectLegacyStatus('CATCH_ALL_RISKY')).toBe('RISKY');
    expect(projectLegacyStatus('UNKNOWN')).toBe('UNVERIFIED');
  });

  it('legacyStatusToState：迁移回填口径（RISKY 只有 catch_all 才进 CATCH_ALL_RISKY）', () => {
    expect(legacyStatusToState('VALID', null)).toBe('VALID');
    expect(legacyStatusToState('INVALID', null)).toBe('INVALID');
    expect(legacyStatusToState('RISKY', 'catch_all')).toBe('CATCH_ALL_RISKY');
    expect(legacyStatusToState('RISKY', 'not_catch_all')).toBe('UNKNOWN');
    expect(legacyStatusToState('RISKY', 'inconclusive')).toBe('UNKNOWN');
    expect(legacyStatusToState('RISKY', 'unknown')).toBe('UNKNOWN');
    expect(legacyStatusToState('RISKY', null)).toBe('UNKNOWN');
    expect(legacyStatusToState('UNVERIFIED', null)).toBe('UNKNOWN');
    // 未知值一律 UNKNOWN（回填不得因脏值中断）。
    expect(legacyStatusToState('WHATEVER', null)).toBe('UNKNOWN');
  });

  it('stateFromEmailVerdict：BLOCKED 不是四态（返回 null，状态不变）', () => {
    expect(stateFromEmailVerdict('VALID', 'smtp_accepted:250')).toBe('VALID');
    expect(stateFromEmailVerdict('INVALID', 'mailbox_rejected:550')).toBe('INVALID');
    expect(stateFromEmailVerdict('RISKY', 'provider_anti_enumeration:microsoft_365')).toBe(
      'CATCH_ALL_RISKY',
    );
    expect(stateFromEmailVerdict('RISKY', 'catch_all_domain')).toBe('CATCH_ALL_RISKY');
    expect(stateFromEmailVerdict('RISKY', 'catch_all_unproven')).toBe('CATCH_ALL_RISKY');
    expect(stateFromEmailVerdict('RISKY', 'smtp_unreachable(port25_blocked?)_mx_present')).toBe(
      'UNKNOWN',
    );
    expect(stateFromEmailVerdict('RISKY', 'mail_from_rejected')).toBe('UNKNOWN');
    expect(stateFromEmailVerdict('RISKY', 'source_policy_suspended')).toBe('UNKNOWN');
    expect(stateFromEmailVerdict('RISKY', 'inconclusive:250')).toBe('UNKNOWN');
    expect(stateFromEmailVerdict('BLOCKED', 'lawful_basis_gate:personal_email_no_lawful_basis')).toBe(
      null,
    );
  });

  it('catchAllClassFromEmailVerdictDetail：反枚举/true catch-all/未证伪', () => {
    expect(catchAllClassFromEmailVerdictDetail('provider_anti_enumeration:microsoft_365')).toBe(
      'unprobeable_provider',
    );
    expect(catchAllClassFromEmailVerdictDetail('catch_all_domain')).toBe('true_catch_all');
    expect(catchAllClassFromEmailVerdictDetail('catch_all_unproven')).toBe('inconclusive');
    expect(catchAllClassFromEmailVerdictDetail('smtp_accepted:250')).toBe('not_catch_all');
    expect(catchAllClassFromEmailVerdictDetail('mailbox_rejected:550')).toBeNull();
    expect(catchAllClassFromEmailVerdictDetail(null)).toBeNull();
  });

  it('catch-all 子类 ↔ A4 三态（写回 legacy catch_all 列）', async () => {
    const { legacyCatchAllFromClass } = await import('./contact-point-verification-state');
    expect(legacyCatchAllFromClass('true_catch_all')).toBe('catch_all');
    expect(legacyCatchAllFromClass('not_catch_all')).toBe('not_catch_all');
    expect(legacyCatchAllFromClass('inconclusive')).toBe('inconclusive');
    expect(legacyCatchAllFromClass('unprobeable_provider')).toBe('unknown');
    expect(legacyCatchAllFromClass(undefined)).toBe('unknown');
  });

  it('eventVerdictFromEmailVerdict：事件账 verdict 词表', () => {
    expect(eventVerdictFromEmailVerdict('VALID', 'smtp_accepted:250')).toBe('valid');
    expect(eventVerdictFromEmailVerdict('INVALID', 'mailbox_rejected:550')).toBe('invalid');
    expect(eventVerdictFromEmailVerdict('RISKY', 'catch_all_domain')).toBe('catch_all');
    expect(eventVerdictFromEmailVerdict('RISKY', 'provider_anti_enumeration:microsoft_365')).toBe(
      'catch_all',
    );
    expect(eventVerdictFromEmailVerdict('RISKY', 'smtp_unreachable(port25_blocked?)_mx_present')).toBe(
      'unknown',
    );
    expect(eventVerdictFromEmailVerdict('BLOCKED', 'suppression_action_gate')).toBe('blocked');
  });
});

describe('评分与重验时间（0–100，迁移回填与写入路径共用）', () => {
  it('confidenceForState：VALID 95 / CATCH_ALL_RISKY 55 / UNKNOWN 20 / INVALID 0', () => {
    expect(confidenceForState('VALID')).toBe(95);
    expect(confidenceForState('CATCH_ALL_RISKY')).toBe(55);
    expect(confidenceForState('UNKNOWN')).toBe(20);
    expect(confidenceForState('INVALID')).toBe(0);
  });

  it('nextReverifyAtForState：UNKNOWN 72h、VALID/CATCH_ALL_RISKY 90 天、INVALID 不再重验', () => {
    const now = new Date('2026-11-09T00:00:00.000Z');
    expect(nextReverifyAtForState('UNKNOWN', now)?.toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(nextReverifyAtForState('VALID', now)?.toISOString()).toBe('2027-02-07T00:00:00.000Z');
    expect(nextReverifyAtForState('CATCH_ALL_RISKY', now)?.toISOString()).toBe(
      '2027-02-07T00:00:00.000Z',
    );
    expect(nextReverifyAtForState('INVALID', now)).toBeNull();
  });
});

describe('状态机（2.3.2.2 转换表）', () => {
  const now = new Date('2026-11-09T12:00:00.000Z');
  const validSince = new Date('2026-10-01T00:00:00.000Z');

  it('UNKNOWN → VALID/INVALID/CATCH_ALL_RISKY/UNKNOWN', () => {
    expect(
      transitionVerificationState({ state: 'UNKNOWN', validSince: null }, { verdict: 'valid' }, now),
    ).toMatchObject({ state: 'VALID', validSince: now, changed: true });
    expect(
      transitionVerificationState({ state: 'UNKNOWN', validSince: null }, { verdict: 'invalid' }, now),
    ).toMatchObject({ state: 'INVALID', validSince: null, changed: true });
    expect(
      transitionVerificationState(
        { state: 'UNKNOWN', validSince: null },
        { verdict: 'catch_all', catchAllClass: 'true_catch_all' },
        now,
      ),
    ).toMatchObject({ state: 'CATCH_ALL_RISKY', catchAllClass: 'true_catch_all' });
    expect(
      transitionVerificationState({ state: 'UNKNOWN', validSince: null }, { verdict: 'unknown' }, now),
    ).toMatchObject({ state: 'UNKNOWN', changed: false, nextReverifyAt: expect.any(Date) });
  });

  it('CATCH_ALL_RISKY：解析器/第二票 valid 才升 VALID；invalid 降 INVALID', () => {
    expect(
      transitionVerificationState(
        { state: 'CATCH_ALL_RISKY', validSince: null },
        { verdict: 'valid' },
        now,
      ),
    ).toMatchObject({ state: 'VALID', validSince: now });
    expect(
      transitionVerificationState(
        { state: 'CATCH_ALL_RISKY', validSince: null },
        { verdict: 'invalid' },
        now,
      ),
    ).toMatchObject({ state: 'INVALID' });
  });

  it('VALID：复验 valid 保持 valid_since；invalid/catch_all 降级并清 valid_since', () => {
    expect(
      transitionVerificationState(
        { state: 'VALID', validSince },
        { verdict: 'valid' },
        now,
      ),
    ).toMatchObject({ state: 'VALID', validSince, changed: false, verifiedAt: now });
    expect(
      transitionVerificationState({ state: 'VALID', validSince }, { verdict: 'invalid' }, now),
    ).toMatchObject({ state: 'INVALID', validSince: null });
    expect(
      transitionVerificationState({ state: 'VALID', validSince }, { verdict: 'catch_all' }, now),
    ).toMatchObject({ state: 'CATCH_ALL_RISKY', validSince: null });
    // 复验 error/unknown 不降级发送资格（plan：重验失败才降）。
    expect(
      transitionVerificationState({ state: 'VALID', validSince }, { verdict: 'error' }, now),
    ).toMatchObject({ state: 'VALID', validSince });
  });

  it('INVALID 是粘性的：验证器事件不推翻，只有 operator 推翻', () => {
    expect(
      transitionVerificationState({ state: 'INVALID', validSince: null }, { verdict: 'valid' }, now),
    ).toMatchObject({ state: 'INVALID', changed: false });
    expect(
      transitionVerificationState(
        { state: 'INVALID', validSince: null },
        { verdict: 'valid', operatorOverride: true },
        now,
      ),
    ).toMatchObject({ state: 'VALID', validSince: now });
  });

  it('BLOCKED：任何来源都不改四态', () => {
    expect(
      transitionVerificationState({ state: 'VALID', validSince }, { verdict: 'blocked' }, now),
    ).toMatchObject({ state: 'VALID', validSince, changed: false });
    expect(
      transitionVerificationState({ state: 'UNKNOWN', validSince: null }, { verdict: 'blocked' }, now),
    ).toMatchObject({ state: 'UNKNOWN', changed: false });
  });

  it('verifiedAtStateColumns：一次性给出写库列（含 legacy status 投影）', () => {
    const cols = verifiedAtStateColumns(
      transitionVerificationState({ state: 'UNKNOWN', validSince: null }, { verdict: 'valid' }, now),
      now,
    );
    expect(cols).toMatchObject({
      verificationState: 'VALID',
      status: 'VALID',
      validSince: now,
      verifiedAt: now,
      nextReverifyAt: expect.any(Date),
      confidence: 95,
    });
  });
});

describe('域盲索引的域解析（回填脚本复用）', () => {
  it('emailDomainOfAddress：小写、去尾点；畸形返回 null', async () => {
    const { emailDomainOfAddress } = await import('./contact-point-verification-state');
    expect(emailDomainOfAddress('Info@Acme-Pumpen.DE')).toBe('acme-pumpen.de');
    expect(emailDomainOfAddress('a@b.example.')).toBe('b.example');
    expect(emailDomainOfAddress('not-an-email')).toBeNull();
    expect(emailDomainOfAddress('@example.com')).toBeNull();
    expect(emailDomainOfAddress('a@localhost')).toBeNull();
    expect(emailDomainOfAddress('a@')).toBeNull();
  });
});

describe('来源分类（替代一刀切 provider）', () => {
  it('官方/社媒/猜测 adapter 的固定映射', () => {
    expect(sourceTypeForContactObservation({ adapterKey: 'social_presence' })).toBe('social');
    expect(sourceTypeForContactObservation({ adapterKey: 'companies_house' })).toBe('directory');
    expect(sourceTypeForContactObservation({ adapterKey: 'inpi_rne' })).toBe('directory');
    expect(sourceTypeForContactObservation({ adapterKey: 'google_patents' })).toBe('directory');
    expect(sourceTypeForContactObservation({ adapterKey: 'email_guess' })).toBe('pattern_guess');
    expect(sourceTypeForContactObservation({ adapterKey: 'hunter' })).toBe('provider');
    expect(sourceTypeForContactObservation({ adapterKey: 'unknown_adapter' })).toBe('provider');
  });

  it('页面型 adapter 按 sourcePage 路径细分 impressum / contact_page / homepage', () => {
    for (const key of ['decision_maker', 'public_web', 'directory'] as const) {
      expect(
        sourceTypeForContactObservation({
          adapterKey: key,
          sourcePage: 'https://acme.example/impressum',
        }),
      ).toBe('impressum');
      expect(
        sourceTypeForContactObservation({
          adapterKey: key,
          sourcePage: 'https://acme.example/mentions-legales',
        }),
      ).toBe('impressum');
      expect(
        sourceTypeForContactObservation({
          adapterKey: key,
          sourcePage: 'https://acme.example/team',
        }),
      ).toBe('contact_page');
      expect(
        sourceTypeForContactObservation({
          adapterKey: key,
          sourcePage: 'https://acme.example/kontakt',
        }),
      ).toBe('contact_page');
      expect(
        sourceTypeForContactObservation({
          adapterKey: key,
          sourcePage: 'https://acme.example/about',
        }),
      ).toBe('homepage');
      expect(sourceTypeForContactObservation({ adapterKey: key })).toBe('homepage');
    }
  });
});
