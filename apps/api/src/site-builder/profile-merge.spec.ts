import { describe, expect, it } from 'vitest';
import { PROFILE_GROUPS, invalidProfileGroups, mergeProfile } from './profile-merge';

describe('mergeProfile（建站向导五组分步保存：组级替换、可跳过，01 §3.2 / 07 §2）', () => {
  it('patch 提供的组整体替换，未提供的组保留', () => {
    const existing = {
      companyProfile: { founded: 2001, employees: '50-100' },
      brand: { tone: 'professional' },
    };
    const merged = mergeProfile(existing, { brand: { tone: 'friendly', colors: ['#0E5FA8'] } });
    expect(merged).toEqual({
      companyProfile: { founded: 2001, employees: '50-100' },
      brand: { tone: 'friendly', colors: ['#0E5FA8'] },
    });
  });

  it('不改动入参（immutable）', () => {
    const existing = { brand: { tone: 'professional' } };
    const patch = { contact: { whatsapp: '+86...' } };
    const existingCopy = structuredClone(existing);
    const patchCopy = structuredClone(patch);
    mergeProfile(existing, patch);
    expect(existing).toEqual(existingCopy);
    expect(patch).toEqual(patchCopy);
  });

  it('existing 为空（首次保存）时直接采纳 patch 的组', () => {
    expect(mergeProfile(null, { trustAssets: { certs: ['CE'] } })).toEqual({
      trustAssets: { certs: ['CE'] },
    });
  });

  it('组显式置 null = 清空该组', () => {
    const merged = mergeProfile({ brand: { tone: 'x' }, contact: { email: 'a@b.c' } }, { brand: null });
    expect(merged).toEqual({ contact: { email: 'a@b.c' } });
  });

  it('invalidProfileGroups 找出白名单外的组名', () => {
    expect(invalidProfileGroups({ brand: {}, hacker: {}, __proto__2: {} })).toEqual([
      'hacker',
      '__proto__2',
    ]);
    expect(invalidProfileGroups({ companyProfile: {} })).toEqual([]);
  });

  it('白名单恰为 PRD 五组', () => {
    expect([...PROFILE_GROUPS]).toEqual([
      'companyProfile',
      'trustAssets',
      'onlineAssets',
      'brand',
      'contact',
    ]);
  });
});
