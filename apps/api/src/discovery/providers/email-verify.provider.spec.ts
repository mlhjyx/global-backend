import { describe, expect, it } from 'vitest';
import { classifyEmailProvider, isAccepted, isRejected, decideEmailVerdict } from './email-verify.provider';

describe('自建邮箱验证 · 纯逻辑（诚实上限）', () => {
  it('provider 分级：Gmail/M365/Proofpoint/Mimecast = 反枚举', () => {
    expect(classifyEmailProvider(['aspmx.l.google.com'])).toEqual({ provider: 'google_workspace', enumResistant: true });
    expect(classifyEmailProvider(['acme-com.mail.protection.outlook.com'])).toEqual({ provider: 'microsoft_365', enumResistant: true });
    expect(classifyEmailProvider(['mx.pphosted.com'])?.enumResistant).toBe(true);
    expect(classifyEmailProvider(['acme.mail.mimecast.com'])?.enumResistant).toBe(true);
    // 自建/其它 = 可探测
    expect(classifyEmailProvider(['mail.acme.de'])).toEqual({ provider: 'other_or_self_hosted', enumResistant: false });
  });

  it('SMTP 码判定：2xx 接受 / 5xx 拒收 / 其余不确定', () => {
    expect(isAccepted(250)).toBe(true);
    expect(isAccepted(550)).toBe(false);
    expect(isAccepted(null)).toBe(false);
    expect(isRejected(550)).toBe(true);
    expect(isRejected(450)).toBe(false); // 4xx 临时错，非拒收
    expect(isRejected(250)).toBe(false);
  });

  const base = { mxPresent: true, provider: 'other_or_self_hosted', enumResistant: false, smtpReachable: true, mailFromOk: true } as const;

  it('裁决：反枚举 provider 永不 VALID（即便 RCPT 250）', () => {
    const v = decideEmailVerdict({ ...base, provider: 'google_workspace', enumResistant: true, rcptCode: 250, catchAllStatus: 'not_catch_all' });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toContain('anti_enumeration');
  });

  it('裁决：catch-all 域永不 VALID', () => {
    const v = decideEmailVerdict({ ...base, rcptCode: 250, catchAllStatus: 'catch_all' });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toBe('catch_all_domain');
  });

  it('裁决：SMTP 不可达(端口25封) → RISKY 不谎报 INVALID', () => {
    const v = decideEmailVerdict({ ...base, smtpReachable: false, mailFromOk: false, rcptCode: null, catchAllStatus: 'inconclusive' });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toContain('smtp_unreachable');
  });

  it('裁决：MAIL FROM 被拒 → RISKY 不判 mailbox INVALID', () => {
    const v = decideEmailVerdict({ ...base, mailFromOk: false, rcptCode: 550, catchAllStatus: 'not_catch_all' });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toBe('mail_from_rejected');
  });

  it('裁决：唯一 VALID = 可达+MAIL FROM过+接受+catch-all已证伪+非反枚举', () => {
    expect(decideEmailVerdict({ ...base, rcptCode: 250, catchAllStatus: 'not_catch_all' }).status).toBe('VALID');
  });

  it('裁决：真实地址接受但 catch-all 未证伪(inconclusive) → RISKY（不谎报 VALID）', () => {
    const v = decideEmailVerdict({ ...base, rcptCode: 250, catchAllStatus: 'inconclusive' });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toBe('catch_all_unproven');
  });

  it('裁决：RCPT 550 明确拒收(MAIL FROM 过) = INVALID', () => {
    expect(decideEmailVerdict({ ...base, rcptCode: 550, catchAllStatus: 'not_catch_all' }).status).toBe('INVALID');
  });

  it('裁决：无 MX = INVALID', () => {
    expect(decideEmailVerdict({ ...base, mxPresent: false, rcptCode: null, catchAllStatus: 'inconclusive' }).status).toBe('INVALID');
  });
});
