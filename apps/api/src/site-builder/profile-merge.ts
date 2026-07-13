/**
 * 建站向导五组档案（01 §3.2）：分步保存、组级替换、可跳过。
 * 纯函数：不改动入参（immutable）。
 */

export const PROFILE_GROUPS = [
  'companyProfile',
  'trustAssets',
  'onlineAssets',
  'brand',
  'contact',
] as const;

export type ProfileGroup = (typeof PROFILE_GROUPS)[number];
export type Profile = Partial<Record<ProfileGroup, unknown>>;

const GROUP_SET: ReadonlySet<string> = new Set(PROFILE_GROUPS);

/** patch 中白名单外的组名（供 400 报错定位）。 */
export function invalidProfileGroups(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => !GROUP_SET.has(key));
}

/** 组级合并：patch 提供的组整体替换；显式 null 清空该组；未提供的组保留。 */
export function mergeProfile(
  existing: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Profile {
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  for (const group of PROFILE_GROUPS) {
    if (!(group in patch)) continue;
    const value = patch[group];
    if (value === null) {
      delete merged[group];
    } else {
      merged[group] = value;
    }
  }
  return merged as Profile;
}
