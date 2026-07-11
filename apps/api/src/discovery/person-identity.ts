/**
 * 跨源决策人身份解析缝（选项 B · 待办 2）。
 *
 * 落库前问「这个人在**本公司**是否已有记录」——有则并入、无则新建——比「算 key 再盲 upsert」更聪明。
 * 修当下决策人重复 bug（email/无-email 桥 + 人名变体），并建成**待办 3**（专利/注册处/商标身份源）
 * 未来插入的复用缝（Tier 0 externalId 精确键）。
 *
 * 🔴 绝不错并两个人：仅**同 companyId** + 严阈值（fuzzy ≥ 0.9）+ margin ≥ 0.1 + 邮箱冲突守卫。
 *    信息内在缺失时**方向偏欠并**（宁欠并不错并）。
 *
 * 纯匹配逻辑（{@link resolveAmongCandidates}）与 DB 查询（{@link resolvePersonIdentity}，薄）分离，便于测试。
 */
import type { Prisma } from '@prisma/client';
import { normalizePersonName } from './person-name';

/** 源侧稳定标识（待办 3：专利 inventor id / 注册号 → Tier 0 精确键）。 */
export interface PersonExternalId {
  scheme: string;
  value: string;
}

export interface PersonResolveInput {
  workspaceId: string;
  companyId: string;
  companyKey: string;
  fullName: string;
  email?: string | null;
  /** 待办 3：源侧稳定标识；本期恒空 → Tier 0 跳过。 */
  externalIds?: PersonExternalId[];
}

export type PersonMatchRule = 'external_id' | 'email_exact' | 'name_exact' | 'name_fuzzy';

export interface PersonResolveHit {
  contactId: string;
  matchRule: PersonMatchRule;
  /** 命中分（仅 name_fuzzy 填），供 identity.merge 证据留痕。 */
  score?: number;
}

/** 同公司现有联系人候选（纯匹配用最小画像）。 */
export interface ContactCandidate {
  id: string;
  fullName: string;
  contactPoints: { type: string; value: string }[];
}

// 🔴 贴错人比贴错公司危害大：fuzzy 门 0.9（比公司 0.72 严），margin 0.1（歧义即弃）。
const FUZZY_MIN_SCORE = 0.9;
const FUZZY_MIN_MARGIN = 0.1;

/** 候选行已有的 email（小写去空）。 */
function emailsOf(candidate: ContactCandidate): string[] {
  return candidate.contactPoints
    .filter((p) => p.type === 'email' && p.value)
    .map((p) => p.value.toLowerCase());
}

/**
 * 🔴 邮箱冲突守卫：input 有 email 且候选也有 email，且**无交集** → 判不同人（防同公司同名两人被并）。
 * input 无 email 或候选无 email → 不冲突（跨 email/无-email 桥接靠此放行）。
 */
export function hasEmailConflict(inputEmail: string | null | undefined, candidate: ContactCandidate): boolean {
  const ie = inputEmail?.toLowerCase();
  if (!ie) return false;
  const candidateEmails = emailsOf(candidate);
  if (candidateEmails.length === 0) return false;
  return !candidateEmails.includes(ie);
}

/**
 * 🔴 externalId 冲突守卫（对称于 {@link hasEmailConflict}）：input 与候选**都有同 scheme** 的
 * externalId 且值不同 → 判不同人（同公司两名同名不同 officer_id 的真实不同人绝不被名字精确误并）。
 * input 无 externalId、或候选无该 scheme 的点 → 不冲突（放行，欠并方向）。
 */
export function hasExternalIdConflict(
  inputExternalIds: PersonExternalId[] | undefined,
  candidate: ContactCandidate,
): boolean {
  if (!inputExternalIds?.length) return false;
  for (const eid of inputExternalIds) {
    const schemePrefix = `${eid.scheme.toLowerCase()}:`;
    const key = `${eid.scheme}:${eid.value}`.toLowerCase();
    const candSameScheme = candidate.contactPoints
      .filter((p) => p.type === 'external_id' && p.value.toLowerCase().startsWith(schemePrefix))
      .map((p) => p.value.toLowerCase());
    if (candSameScheme.length && !candSameScheme.includes(key)) return true; // 同 scheme 有值但都不等 → 冲突
  }
  return false;
}

/**
 * 人名归一 token 集（Tier 3 专用）。**用 normalizePersonName、绝不借公司匹配器**——
 * 公司匹配器的 normForMatch 会剥法人后缀（co/sa/oy/as/ab/bv/pty/company/holdings…），
 * 姓氏恰为这些词时（"Marco Sa"/"Erik Oy"/挪威姓 "…As"）会被剥成只剩名 → 错并两个人。
 */
function personTokens(name: string): Set<string> {
  return new Set(normalizePersonName(name).split(' ').filter(Boolean));
}

/** 人名 token Jaccard（无 subset 加权——"John Smith"⊂"John Michael Smith" 可能是不同人，方向欠并）。 */
function personNameJaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const inter = [...a].filter((t) => b.has(t)).length;
  return inter / (a.size + b.size - inter);
}

/**
 * 在候选集内分层解析同一人（纯函数）。首个命中即返回；全不中 → null。
 * Tier 0 externalId → Tier 1 邮箱精确 → Tier 2 归一名精确 → Tier 3 高置信模糊。
 * Tier 2/3 受邮箱**与 externalId** 冲突守卫（跳过冲突候选继续找下一个）；Tier 0/1 精确相同即同人，不受此限。
 */
export function resolveAmongCandidates(
  input: { fullName: string; email?: string | null; externalIds?: PersonExternalId[] },
  candidates: ContactCandidate[],
): PersonResolveHit | null {
  const email = input.email?.toLowerCase() || null;

  // Tier 0：externalId 精确（待办 3）。本期 externalIds 恒空即跳过。
  // TODO(待办3)：现无 person external_id 存法；externalIds 到位后按 contactPoint type='external_id' 存/查（勿为它加 schema）。
  const externalIds = input.externalIds ?? [];
  for (const eid of externalIds) {
    const key = `${eid.scheme}:${eid.value}`.toLowerCase();
    const hit = candidates.find((c) =>
      c.contactPoints.some((p) => p.type === 'external_id' && p.value.toLowerCase() === key),
    );
    if (hit) return { contactId: hit.id, matchRule: 'external_id' };
  }

  // Tier 1：邮箱精确（跨名字变体桥接："J. Smith" 带 email ≡ "John Smith"）。
  if (email) {
    const hit = candidates.find((c) => emailsOf(c).includes(email));
    if (hit) return { contactId: hit.id, matchRule: 'email_exact' };
  }

  // Tier 2：归一名精确（同公司），跳过邮箱**或 externalId**冲突候选（🔴 同名不同 officer_id 绝不误并）。
  const inputNorm = normalizePersonName(input.fullName);
  if (inputNorm) {
    const hit = candidates.find(
      (c) =>
        normalizePersonName(c.fullName) === inputNorm &&
        !hasEmailConflict(email, c) &&
        !hasExternalIdConflict(input.externalIds, c),
    );
    if (hit) return { contactId: hit.id, matchRule: 'name_exact' };
  }

  // Tier 3：高置信模糊 = 空格语序重排（"Johann Schmidt"≡"Schmidt Johann"，Tier 2 只处理逗号语序）。
  // 用人名归一 token Jaccard（严阈值 + margin），先滤掉邮箱**或 externalId**冲突候选。
  const eligible = candidates.filter(
    (c) => !hasEmailConflict(email, c) && !hasExternalIdConflict(input.externalIds, c),
  );
  if (inputNorm) {
    const inputTokens = new Set(inputNorm.split(' ').filter(Boolean));
    const scored = eligible
      .map((c) => ({ contact: c, score: personNameJaccard(inputTokens, personTokens(c.fullName)) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best) {
      const margin = best.score - (scored[1]?.score ?? 0);
      if (best.score >= FUZZY_MIN_SCORE && margin >= FUZZY_MIN_MARGIN) {
        return { contactId: best.contact.id, matchRule: 'name_fuzzy', score: best.score };
      }
    }
  }

  return null;
}

/**
 * 在**同一 companyId** 内解析代表同一人的现有 canonicalContact（DB 薄查询 + 纯匹配）。
 * @returns 命中 `{contactId, matchRule, score?}`；全不中 → null（= 新人）。
 */
export async function resolvePersonIdentity(
  tx: Prisma.TransactionClient,
  input: PersonResolveInput,
): Promise<PersonResolveHit | null> {
  const rows = await tx.canonicalContact.findMany({
    where: { workspaceId: input.workspaceId, companyId: input.companyId },
    include: { contactPoints: true },
  });
  const candidates: ContactCandidate[] = rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    contactPoints: r.contactPoints.map((p) => ({ type: p.type, value: p.value })),
  }));
  return resolveAmongCandidates(input, candidates);
}
