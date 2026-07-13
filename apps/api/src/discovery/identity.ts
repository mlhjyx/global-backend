/**
 * 身份解析（PRD 8.8）：确定性规则优先 —— 域名精确匹配 > 名称+国家规范化。
 * 纯函数，可测试；匹配规则名记入 identity_link.match_rule 供审计。
 */
import { normalizePersonName, personNameKeyVariants } from './person-name';

const LEGAL_SUFFIXES =
  /\b(gmbh|ag|kg|co\.?|ltd\.?|llc|inc\.?|corp\.?|s\.?a\.?|s\.?r\.?l\.?|b\.?v\.?|oy|ab|as|plc|pty|limited|company|holdings?)\b|有限公司|株式会社|주식회사/gi;

export function normalizeDomain(raw?: string | null): string | null {
  if (!raw) return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split(/[/?#]/)[0];
  return d || null;
}

export function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface IdentityKey {
  dedupeKey: string;
  matchRule: 'domain_exact' | 'identifier_exact' | 'name_country';
}

/** provider 标识（税号/注册号/LEI…）；scheme 命名空间隔离 id 体系。 */
export interface CompanyIdentifier {
  scheme: string;
  value: string;
}

/** 归一 provider 标识：scheme 小写 + 值剥非字母数字（"DE 291499156"→"de291499156"）；空值 → null。 */
export function normalizeIdentifier(id?: CompanyIdentifier | null): string | null {
  if (!id) return null;
  const value = id.value.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!value) return null;
  return `${id.scheme.toLowerCase()}:${value}`;
}

export function companyIdentity(rec: {
  name: string;
  domain?: string | null;
  country?: string | null;
  identifier?: CompanyIdentifier | null;
}): IdentityKey {
  const domain = normalizeDomain(rec.domain);
  if (domain) return { dedupeKey: `d:${domain}`, matchRule: 'domain_exact' };
  // §8.4：无域名但有 provider 标识（税号/注册号）→ 按 id 归一，防同名同国不同实体误并；
  // 无域名的 TED 中标方常见。scheme 命名空间隔离，绝不跨 id 体系（ted-natid ≠ lei）串号。
  const id = normalizeIdentifier(rec.identifier);
  if (id) return { dedupeKey: `id:${id}`, matchRule: 'identifier_exact' };
  return {
    dedupeKey: `n:${normalizeCompanyName(rec.name)}:${(rec.country ?? '').toLowerCase()}`,
    matchRule: 'name_country',
  };
}

/** 联系人去重键的人名归一（小写 + 折叠空白 + 去首尾）；contactIdentity 的明文 c 形用。 */
function contactNameKeyPart(fullName: string): string {
  return fullName.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * **拒并键**的人名判别符：用 resolver 同款 {@link normalizePersonName}（去称谓 / "Family, Given" 语序 /
 * 音译）——与 `resolveWithReason` 判同名歧义的归一同源，故 "Anna Weber" / "Dr. Anna Weber" / "Weber, Anna"
 * 落**同一** declined 行（幂等，#67 P2）。归一为空（纯称谓/无解析）时回退明文键，保留可区分性、不塌成一键。
 */
function declinedNameKeyPart(fullName: string): string {
  return normalizePersonName(fullName) || contactNameKeyPart(fullName);
}

export function contactIdentity(contact: { fullName: string; email?: string | null }, companyKey: string): string {
  if (contact.email) return `e:${contact.email.trim().toLowerCase()}`;
  return `c:${companyKey}:${contactNameKeyPart(contact.fullName)}`;
}

/**
 * 联系人**禁联/对账**键集（GDPR Art.17 person-level）：对同一自然人产出**多归一变体**的
 * `c:<companyKey>:<归一名变体>` 键（{@link personNameKeyVariants}：德语音译 ä→ae + 纯去音标 ä→a 两形，
 * 覆盖变音丢弃 / 德语 ASCII 拼写 Müller↔Mueller↔Muller / 分解 Unicode / "Surname, Given" 语序 / 称谓）。
 * 令被 Art.17 擦除的具名人以**任一拼写变体**（换邮箱 / 无邮箱 / 跨源不同拼写）重现都命中禁联而不重建、被对账删净。
 * 归一为空（纯称谓）时回退 {@link contactNameKeyPart} 明文键，保留可区分性、不塌成 `c:<ck>:` 空键。
 *
 * 🔴 与 {@link contactIdentity} 的**单值 dedupe 键**分离（各司其职）：dedupe（去重 upsert）走 contactIdentity +
 * resolver 模糊并（方向偏**欠并**，绝不误并两人）；禁联/对账走此**变体集**（方向偏**过禁**——over-suppress 于
 * Art.17 是安全侧，宁误禁同名另一人也不漏禁被擦除人；对账**删除**侧的同名误删另受 deletion 的 createdAt 有界窗口约束）。
 * email-独立（禁联从不按邮箱，被擦除人换邮箱也须拦），故仅取 fullName + companyKey。
 */
export function contactSuppressionKeys(fullName: string, companyKey: string): string[] {
  // 变体集（德语音译 / 纯去音标 / umlaut 折叠）+ **旧单值形**（保变音/称谓/语序的 contactNameKeyPart）。
  // 🔴 叠加旧单值形是**向后兼容**：本改动前写入的 contact_key（= blind(c:<ck>:<旧归一>))仅存盲值、明文已擦除、
  //    无法回填——把旧形留在键集里，令这些既有记录仍按其精确形命中，杜绝「静默失配回归」（变体集只增不减匹配面）。
  // 空/纯称谓时旧形亦为空 → filter 去空 → []（不塌成 `c:<ck>:` 空键；调用方按空集处理）。
  const parts = [...personNameKeyVariants(fullName), contactNameKeyPart(fullName)].filter((p) => p.length > 0);
  return [...new Set(parts.map((part) => `c:${companyKey}:${part}`))].sort();
}

/** 源侧稳定标识排序取首（确定性，不受输入顺序影响）；归一为 `scheme:value` 小写。空 → null。 */
function stableExternalIdKey(externalIds?: { scheme: string; value: string }[]): string | null {
  if (!externalIds?.length) return null;
  const normalized = externalIds.map((e) => `${e.scheme}:${e.value}`.toLowerCase()).sort();
  return normalized[0] ?? null;
}

/**
 * **拒并键**（待办 2 create 层收尾）：`resolvePersonIdentity` 明确「拒并」（同名歧义 / RISKY 猜测邮箱）
 * 但 {@link contactIdentity} 的明文键与既有**不同**联系人碰撞时，改用此键新建独立行——既尊重 resolve
 * 的拒并、绝不并回错行，又**确定性** → 同源再跑落到同一行（幂等）。
 *
 * 判别符优先级 **externalId > 可信 email > 人名**（越强越先，绝不塌不同人为一键）：
 *  - **externalId** `dx:x:<companyKey>:<scheme:value>`（全局稳定：同名不同 officer_id 各自成键，
 *    同一董事跨源经 Tier 0 再归并）；
 *  - **可信 email** `dx:e:<companyKey>:<归一名>:<email>`（🔴 同名不同人各带不同 VALID 邮箱靠 email 区分、
 *    **不同名共用同一 catch-all 地址靠人名区分**——名+邮箱双判别符，不同人绝不塌成一行）——⚠️ 调用方须只在
 *    email **可信**（未被既有行占用 = 非 catch-all/RISKY 共享地址）时才传入 email，已占用则传 undefined 退回纯人名；
 *  - **人名** `dx:c:<companyKey>:<归一名>`（无 externalId、无可信 email 的兜底；同名无其他信息才折叠=floor）。
 *  - `dx:` 命名空间与明文 `e:`/`c:` 互斥 → declined 行绝不与既有 non-declined 行碰撞；按 `companyKey` 隔离。
 */
export function declinedContactIdentity(
  contact: { fullName: string; email?: string | null; externalIds?: { scheme: string; value: string }[] },
  companyKey: string,
): string {
  const eid = stableExternalIdKey(contact.externalIds);
  if (eid) return `dx:x:${companyKey}:${eid}`;
  // 名+邮箱双判别符：不同名（Alice/Bob）共用一 catch-all 地址靠名分开；同名不同邮箱靠邮箱分开。
  // 人名部用 resolver 同款归一（#67 P2），称谓/逗号语序变体幂等落同一 declined 行。
  const nameKey = declinedNameKeyPart(contact.fullName);
  if (contact.email) return `dx:e:${companyKey}:${nameKey}:${contact.email.trim().toLowerCase()}`;
  return `dx:c:${companyKey}:${nameKey}`;
}
