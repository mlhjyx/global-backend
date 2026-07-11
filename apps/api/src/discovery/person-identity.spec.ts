import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  ContactCandidate,
  hasEmailConflict,
  resolveAmongCandidates,
  resolvePersonIdentity,
} from './person-identity';

const cand = (
  id: string,
  fullName: string,
  emails: string[] = [],
  extra: { type: string; value: string }[] = [],
): ContactCandidate => ({
  id,
  fullName,
  contactPoints: [...emails.map((value) => ({ type: 'email', value })), ...extra],
});

describe('resolveAmongCandidates · 四 Tier 命中', () => {
  it('Tier 0 externalId 精确（待办 3 缝）', () => {
    const hit = resolveAmongCandidates(
      { fullName: 'Whoever', externalIds: [{ scheme: 'uspto-inventor', value: 'X123' }] },
      [cand('c1', 'Unrelated Name', [], [{ type: 'external_id', value: 'uspto-inventor:x123' }])],
    );
    expect(hit).toEqual({ contactId: 'c1', matchRule: 'external_id' });
  });

  it('Tier 1 邮箱精确（跨名字变体桥接：不同显示名同邮箱即同人）', () => {
    const hit = resolveAmongCandidates(
      { fullName: 'J. Smith', email: 'John.Smith@acme.com' },
      [cand('c1', 'John Smith', ['john.smith@acme.com'])],
    );
    expect(hit).toEqual({ contactId: 'c1', matchRule: 'email_exact' });
  });

  it('Tier 2 归一名精确（去称谓变体，无邮箱冲突）', () => {
    const hit = resolveAmongCandidates(
      { fullName: 'Dr. John Smith' },
      [cand('c1', 'John Smith')],
    );
    expect(hit).toEqual({ contactId: 'c1', matchRule: 'name_exact' });
  });

  it('Tier 3 高置信模糊（token 重排，score≥0.9 且 margin≥0.1）', () => {
    const hit = resolveAmongCandidates(
      { fullName: 'Johann Schmidt' },
      [cand('c1', 'Schmidt Johann')],
    );
    expect(hit?.contactId).toBe('c1');
    expect(hit?.matchRule).toBe('name_fuzzy');
    expect(hit?.score).toBeGreaterThanOrEqual(0.9);
  });

  it('Tier 顺序：email 精确压过名字（先返邮箱命中）', () => {
    const hit = resolveAmongCandidates(
      { fullName: 'John Smith', email: 'js@acme.com' },
      [cand('c1', 'John Smith'), cand('c2', 'Someone Else', ['js@acme.com'])],
    );
    expect(hit).toEqual({ contactId: 'c2', matchRule: 'email_exact' });
  });
});

describe('resolveAmongCandidates · 🔴 邮箱冲突守卫（宁欠并不错并）', () => {
  it('同公司同名但邮箱不同 → 判不同人 → null（不并）', () => {
    const hit = resolveAmongCandidates(
      { fullName: 'John Smith', email: 'john.b@acme.com' },
      [cand('c1', 'John Smith', ['john.a@acme.com'])],
    );
    expect(hit).toBeNull();
  });

  it('Tier 2 冲突时跳过冲突行、命中下一无冲突同名行', () => {
    const hit = resolveAmongCandidates(
      { fullName: 'John Smith', email: 'john.b@acme.com' },
      [cand('c1', 'John Smith', ['john.a@acme.com']), cand('c2', 'John Smith')],
    );
    expect(hit).toEqual({ contactId: 'c2', matchRule: 'name_exact' });
  });

  it('hasEmailConflict：input 无 email 或候选无 email → 不冲突（放行桥接）', () => {
    expect(hasEmailConflict(null, cand('c', 'X', ['a@x.com']))).toBe(false);
    expect(hasEmailConflict('a@x.com', cand('c', 'X'))).toBe(false);
    expect(hasEmailConflict('a@x.com', cand('c', 'X', ['b@x.com']))).toBe(true);
    expect(hasEmailConflict('A@X.com', cand('c', 'X', ['a@x.com']))).toBe(false); // 大小写不敏感
  });
});

describe('resolveAmongCandidates · margin 弃 + 跨 email/无-email 桥', () => {
  it('两个同置信候选（margin<0.1）→ 歧义即弃 → null', () => {
    const hit = resolveAmongCandidates({ fullName: 'Johann Peter Schmidt' }, [
      cand('a', 'Schmidt Johann Peter'),
      cand('b', 'Peter Johann Schmidt'),
    ]);
    expect(hit).toBeNull();
  });

  it('无邮箱现有行 + 带邮箱输入（同名）→ Tier 2 名命中（并入无邮箱行）', () => {
    const hit = resolveAmongCandidates(
      { fullName: 'John Smith', email: 'john@acme.com' },
      [cand('c1', 'John Smith')],
    );
    expect(hit).toEqual({ contactId: 'c1', matchRule: 'name_exact' });
  });

  it('无候选 → null（新人）', () => {
    expect(resolveAmongCandidates({ fullName: 'John Smith', email: 'x@y.com' }, [])).toBeNull();
  });
});

describe('resolveAmongCandidates · 🔴 法人后缀姓氏不误并（HIGH 回归）', () => {
  // Tier 3 用 normalizePersonName（不剥法人词），不再借 pickBestByName/normForMatch——
  // 后者会把 "Sa"/"Co"/"Oy"/"As"/"Ab" 当法人后缀剥掉，令不同姓被误判 score=1 → 错并两个人。
  it('姓氏恰为法人后缀词（"Marco Sa" vs 候选 "Marco Co"，均无邮箱）→ null 不并', () => {
    expect(resolveAmongCandidates({ fullName: 'Marco Sa' }, [cand('c1', 'Marco Co')])).toBeNull();
  });

  it('芬兰/挪威姓（"Erik Oy" vs "Erik As"）→ null 不并', () => {
    expect(resolveAmongCandidates({ fullName: 'Erik Oy' }, [cand('c1', 'Erik As')])).toBeNull();
  });

  it('保留重排价值："Johann Schmidt" vs "Schmidt Johann" → name_fuzzy 命中', () => {
    const hit = resolveAmongCandidates({ fullName: 'Johann Schmidt' }, [cand('c1', 'Schmidt Johann')]);
    expect(hit?.contactId).toBe('c1');
    expect(hit?.matchRule).toBe('name_fuzzy');
  });
});

describe('resolvePersonIdentity · DB 薄查询（假 tx）', () => {
  it('按 workspaceId+companyId 查同公司候选并解析', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'c1', fullName: 'John Smith', contactPoints: [{ type: 'email', value: 'john@acme.com' }] },
    ]);
    const tx = { canonicalContact: { findMany } } as unknown as Prisma.TransactionClient;

    const hit = await resolvePersonIdentity(tx, {
      workspaceId: 'w1',
      companyId: 'co1',
      companyKey: 'd:acme.com',
      fullName: 'J. Smith',
      email: 'john@acme.com',
    });

    expect(hit).toEqual({ contactId: 'c1', matchRule: 'email_exact' });
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', companyId: 'co1' },
      include: { contactPoints: true },
    });
  });

  it('无候选 → null', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const tx = { canonicalContact: { findMany } } as unknown as Prisma.TransactionClient;
    const hit = await resolvePersonIdentity(tx, {
      workspaceId: 'w1',
      companyId: 'co1',
      companyKey: 'd:acme.com',
      fullName: 'New Person',
    });
    expect(hit).toBeNull();
  });
});
