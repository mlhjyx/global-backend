import { describe, expect, it } from 'vitest';
import { buildGuessTargets, DEFAULT_MAX_GUESS_CONTACTS, GuessTargetContact } from './email-guess-targets';

/**
 * 共享纯件 buildGuessTargets 单测（选项 B · P0.4 复审 MEDIUM）：格式学习样本的 RISKY/跨域排除、
 * 缺邮箱过滤、cap 截断（+ emaillessTotal 保留总数）、空输入。手动路径与 backlog 阶段⑤b 共用它。
 */

const pt = (type: string, value: string, status = 'UNVERIFIED') => ({ type, value, status });

describe('buildGuessTargets', () => {
  it('knownSamples = 同域非-RISKY email；排除 RISKY 与跨域样本', () => {
    const contacts: GuessTargetContact[] = [
      { id: 'a', fullName: 'Sabine Vogt', contactPoints: [pt('email', 's.vogt@acme.de', 'VALID')] },
      { id: 'b', fullName: 'Guess Risky', contactPoints: [pt('email', 'g.risky@acme.de', 'RISKY')] }, // 本器未证实猜测 → 排除
      { id: 'c', fullName: 'Other Domain', contactPoints: [pt('email', 'x@other.com', 'VALID')] }, // 跨域 → 排除
      { id: 'd', fullName: 'Scraped', contactPoints: [pt('email', 'h.scraped@ACME.de', 'UNVERIFIED')] }, // 大小写域匹配保留
    ];
    const r = buildGuessTargets(contacts, 'acme.de');
    expect(r.knownSamples).toEqual([
      { fullName: 'Sabine Vogt', email: 's.vogt@acme.de' },
      { fullName: 'Scraped', email: 'h.scraped@ACME.de' },
    ]);
  });

  it('emailless = 无任何 email point 的联系人（有 phone/其它 point 也算缺邮箱）', () => {
    const contacts: GuessTargetContact[] = [
      { id: 'a', fullName: 'Has Email', contactPoints: [pt('email', 'a@acme.de', 'VALID')] },
      { id: 'b', fullName: 'No Email', contactPoints: [] },
      { id: 'c', fullName: 'Phone Only', contactPoints: [pt('phone', '+49 1', 'VALID')] },
    ];
    const r = buildGuessTargets(contacts, 'acme.de');
    expect(r.emailless).toEqual([
      { contactId: 'b', fullName: 'No Email' },
      { contactId: 'c', fullName: 'Phone Only' },
    ]);
    expect(r.emaillessTotal).toBe(2);
  });

  it('cap 截断：>maxContacts 时 emailless 只留前 N，emaillessTotal 仍是总数', () => {
    const contacts: GuessTargetContact[] = Array.from({ length: 30 }, (_, i) => ({
      id: `id${i}`,
      fullName: `P${i}`,
      contactPoints: [],
    }));
    const r = buildGuessTargets(contacts, 'acme.de', 25);
    expect(r.emailless).toHaveLength(25);
    expect(r.emailless[0]).toEqual({ contactId: 'id0', fullName: 'P0' });
    expect(r.emailless[24]).toEqual({ contactId: 'id24', fullName: 'P24' });
    expect(r.emaillessTotal).toBe(30); // 截断前总数保留（summary emaillessContacts 用）
  });

  it('默认 cap = DEFAULT_MAX_GUESS_CONTACTS（25）', () => {
    const contacts: GuessTargetContact[] = Array.from({ length: 40 }, (_, i) => ({
      id: `id${i}`,
      fullName: `P${i}`,
      contactPoints: [],
    }));
    expect(buildGuessTargets(contacts, 'acme.de').emailless).toHaveLength(DEFAULT_MAX_GUESS_CONTACTS);
  });

  it('空输入 → 空样本、空 emailless、总数 0', () => {
    const r = buildGuessTargets([], 'acme.de');
    expect(r).toEqual({ knownSamples: [], emailless: [], emaillessTotal: 0 });
  });
});
