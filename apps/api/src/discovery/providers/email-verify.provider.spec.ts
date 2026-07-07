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

  it('裁决：反枚举 provider 永不 VALID（即便 RCPT 250）', () => {
    const v = decideEmailVerdict({ mxPresent: true, provider: 'google_workspace', enumResistant: true, smtpReachable: true, rcptCode: 250, catchAll: false });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toContain('anti_enumeration');
  });

  it('裁决：catch-all 域永不 VALID', () => {
    const v = decideEmailVerdict({ mxPresent: true, provider: 'other_or_self_hosted', enumResistant: false, smtpReachable: true, rcptCode: 250, catchAll: true });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toBe('catch_all_domain');
  });

  it('裁决：SMTP 不可达(端口25封) → RISKY 不谎报 INVALID', () => {
    const v = decideEmailVerdict({ mxPresent: true, provider: 'other_or_self_hosted', enumResistant: false, smtpReachable: false, rcptCode: null, catchAll: false });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toContain('smtp_unreachable');
  });

  it('裁决：唯一 VALID 路径 = 可达+接受+非catch-all+非反枚举', () => {
    const v = decideEmailVerdict({ mxPresent: true, provider: 'other_or_self_hosted', enumResistant: false, smtpReachable: true, rcptCode: 250, catchAll: false });
    expect(v.status).toBe('VALID');
  });

  it('裁决：RCPT 550 明确拒收 = INVALID', () => {
    const v = decideEmailVerdict({ mxPresent: true, provider: 'other_or_self_hosted', enumResistant: false, smtpReachable: true, rcptCode: 550, catchAll: false });
    expect(v.status).toBe('INVALID');
  });

  it('裁决：无 MX = INVALID', () => {
    expect(decideEmailVerdict({ mxPresent: false, provider: 'x', enumResistant: false, smtpReachable: false, rcptCode: null, catchAll: false }).status).toBe('INVALID');
  });
});
