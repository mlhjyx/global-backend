import { describe, expect, it } from 'vitest';
import { buildSuppressionEntries, selectReconcileStragglerIds } from './deletion-plan';
import { blindContactKey } from './pii-crypto';
import { contactSuppressionKeys } from '../discovery/identity';

describe('deletion-plan buildSuppressionEntries', () => {
  it('contact subject: only lowercased, deduped email entries — never freezes the whole company', () => {
    const e = buildSuppressionEntries({
      subjectType: 'contact',
      emails: ['A.Smith@Acme.com', 'a.smith@acme.com', ' '],
      domain: 'acme.com',
      companyName: 'Acme GmbH',
    });
    expect(e).toEqual([{ type: 'email', value: 'a.smith@acme.com', reason: 'legal' }]);
  });

  it('company subject: emails + domain + company_name, all deduped/lowercased', () => {
    const e = buildSuppressionEntries({
      subjectType: 'company',
      emails: ['info@acme.com', 'INFO@acme.com'],
      domain: 'Acme.com',
      companyName: 'Acme GmbH',
    });
    expect(e).toEqual([
      { type: 'email', value: 'info@acme.com', reason: 'legal' },
      { type: 'domain', value: 'acme.com', reason: 'legal' },
      { type: 'company_name', value: 'acme gmbh', reason: 'legal' },
    ]);
  });

  it('skips empty/whitespace values', () => {
    expect(
      buildSuppressionEntries({ subjectType: 'company', emails: [''], domain: null, companyName: '  ' }),
    ).toEqual([]);
  });

  it('contact subject with person context: adds blinded, email-independent contact_key VARIANTS (Codex P1 + 变体集)', () => {
    const e = buildSuppressionEntries({
      subjectType: 'contact',
      emails: ['klaus@acme.com'],
      contactName: 'Klaus Löschmann',
      companyKey: 'd:acme.com',
    });
    expect(e).toContainEqual({ type: 'email', value: 'klaus@acme.com', reason: 'legal' });
    // 变体集：德语音译(ö→oe) + 纯去音标(ö→o) 两键都写入，令跨源拼写变体重现都能命中禁联
    const keys = contactSuppressionKeys('Klaus Löschmann', 'd:acme.com').map((k) => blindContactKey(k).toLowerCase());
    expect(keys.length).toBe(2);
    for (const k of keys) {
      expect(e).toContainEqual({ type: 'contact_key', value: k, reason: 'legal' });
      expect(k.startsWith('bi:v1:')).toBe(true); // 🔴 盲化 HMAC
    }
    // 🔴 禁联表不存人名明文（含各拼写变体）
    const dump = JSON.stringify(e).toLowerCase();
    expect(dump).not.toContain('löschmann');
    expect(dump).not.toContain('loeschmann');
    expect(dump).not.toContain('loschmann');
  });

  it('contact subject without company context: no person key (backward compatible)', () => {
    expect(buildSuppressionEntries({ subjectType: 'contact', emails: ['a@b.com'] })).toEqual([
      { type: 'email', value: 'a@b.com', reason: 'legal' },
    ]);
  });

  it('company subject: never emits a contact_key even if person context is passed', () => {
    const e = buildSuppressionEntries({
      subjectType: 'company',
      emails: [],
      domain: 'acme.com',
      companyName: 'Acme',
      contactName: 'Someone',
      companyKey: 'd:acme.com',
    });
    expect(e.some((x) => x.type === 'contact_key')).toBe(false);
  });
});

describe('deletion-plan selectReconcileStragglerIds (Art.17 contact-subject 对账)', () => {
  const companyKey = 'd:acme.com';
  const erasedName = 'Petra Wiedergänger';
  const freeze = new Date('2026-07-13T12:00:00.000Z');
  const before = new Date('2026-07-13T11:59:00.000Z');
  const after = new Date('2026-07-13T12:00:30.000Z');

  it('🔴 选中「同 person-key + createdAt >= since」的重物化行（竞态窗口内新建）', () => {
    const ids = selectReconcileStragglerIds({
      erasedName,
      companyKey,
      since: freeze,
      candidates: [{ id: 'straggler', fullName: erasedName, createdAt: after }],
    });
    expect(ids).toEqual(['straggler']);
  });

  it('🔴 绝不选「先于 since 就存在」的同名行（先存同名同事，避免数据丢失=与被驳回 sweep 的关键差异）', () => {
    const ids = selectReconcileStragglerIds({
      erasedName,
      companyKey,
      since: freeze,
      candidates: [{ id: 'preexisting-same-name', fullName: erasedName, createdAt: before }],
    });
    expect(ids).toEqual([]);
  });

  it('createdAt === since 视为窗口内（>= 含边界）', () => {
    const ids = selectReconcileStragglerIds({
      erasedName,
      companyKey,
      since: freeze,
      candidates: [{ id: 'boundary', fullName: erasedName, createdAt: freeze }],
    });
    expect(ids).toEqual(['boundary']);
  });

  it('不同人名（person-key 不符）即便窗口内也不选', () => {
    const ids = selectReconcileStragglerIds({
      erasedName,
      companyKey,
      since: freeze,
      candidates: [{ id: 'other-person', fullName: 'Someone Else', createdAt: after }],
    });
    expect(ids).toEqual([]);
  });

  it('归一化对齐创建闸：大小写/空白差异的同名仍命中（与 contactSuppressionKeys 同构）', () => {
    const ids = selectReconcileStragglerIds({
      erasedName,
      companyKey,
      since: freeze,
      candidates: [{ id: 'normalized', fullName: '  petra   WIEDERGÄNGER ', createdAt: after }],
    });
    expect(ids).toEqual(['normalized']);
  });

  it('🔴 本 PR 核心：拼写变体重物化行也被对账捕获（变音丢弃 / "Surname,Given" 语序 / 分解 Unicode）', () => {
    const dropAccent = selectReconcileStragglerIds({
      erasedName, // 'Petra Wiedergänger'（ä）
      companyKey,
      since: freeze,
      candidates: [{ id: 'drop-accent', fullName: 'Petra Wiederganger', createdAt: after }], // ä→a
    });
    expect(dropAccent).toEqual(['drop-accent']);

    const comma = selectReconcileStragglerIds({
      erasedName,
      companyKey,
      since: freeze,
      candidates: [{ id: 'comma-order', fullName: 'Wiedergänger, Petra', createdAt: after }], // "Surname, Given"
    });
    expect(comma).toEqual(['comma-order']);

    const decomposed = selectReconcileStragglerIds({
      erasedName,
      companyKey,
      since: freeze,
      candidates: [{ id: 'decomposed', fullName: 'Petra Wiedergänger', createdAt: after }], // a + U+0308 组合变音
    });
    expect(decomposed).toEqual(['decomposed']);
  });

  it('🔴 德语 ASCII 拼写变体（Müller→Mueller）跨源重物化被对账捕获', () => {
    const ids = selectReconcileStragglerIds({
      erasedName: 'Hans Müller',
      companyKey,
      since: freeze,
      candidates: [{ id: 'ascii-spell', fullName: 'Hans Mueller', createdAt: after }],
    });
    expect(ids).toEqual(['ascii-spell']);
  });

  it('空候选集 → 空结果', () => {
    expect(
      selectReconcileStragglerIds({ erasedName, companyKey, since: freeze, candidates: [] }),
    ).toEqual([]);
  });

  // 🔴 已接受的有界代价（design note §2「为什么 createdAt 过滤是关键」）：窗口内新建的**同名另一真人**
  // 会被选中删除——name-only key 无法与被擦除人区分，且这与创建闸顺序情形下对同名的**拒建**净数据态一致。
  // 显式编码此 by-design 行为，令取舍进入测试而非隐含。
  it('by-design 有界代价：窗口内（createdAt >= since）新建的同名另一真人也被选中（与创建闸拒建等价）', () => {
    const ids = selectReconcileStragglerIds({
      erasedName,
      companyKey,
      since: freeze,
      candidates: [{ id: 'in-window-different-person', fullName: erasedName, createdAt: after }],
    });
    expect(ids).toEqual(['in-window-different-person']);
  });
});
