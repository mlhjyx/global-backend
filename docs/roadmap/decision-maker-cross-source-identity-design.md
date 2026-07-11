# 选项 B · 待办 2 设计——跨源决策人身份解析（修桥 + 建缝）

> 2026-07-11 设计（会话内已过目、拍板：方案「修桥+建缝」+ `matchRule` 记进 field_evidence 零迁移 + 实现留新会话）。**状态：设计定稿，实现待新会话**。
> 关联：[decision-maker-multi-source-spec.md](decision-maker-multi-source-spec.md)（立项 spec §5 遗留「跨源身份解析」的落地设计）· [decision-maker-p0.4-mainchain-wiring-design.md](decision-maker-p0.4-mainchain-wiring-design.md)（前序 P0.4）· [../product-scope.md](../product-scope.md)（合规红线 🔴 绝不贴错身份）。

## 0. 一句话

落库前加**解析前置步** `resolvePersonIdentity`——先问「这个人在本公司是否已有记录」，有则**并入**、无则新建——比现在「算 key 再盲 upsert」更聪明。既修当下的决策人重复 bug，又建成**待办 3**（专利/注册处/商标身份源）未来要插进来的那道复用缝。

## 1. 问题

**现状 `contactIdentity`**（`apps/api/src/discovery/identity.ts`）：有 email → `e:email`；否则 → `c:公司:归一全名`。

**一个真实的、现在就存在的重复 bug**：同一个人可能变成**两条** `canonical_contact`——
- 无邮箱时发现（团队页/名单）→ 键 `c:公司:john smith`
- 带邮箱时发现（有邮箱的 Impressum）→ 键 `e:john.smith@acme.com`

两者键形不同、**永不合并**。**P0.4 让它更活**：P0.4 给 `c:` 联系人补了邮箱（作为 contactPoint，键不变），之后发现流程若再带该邮箱找到同一人 → 建一条 `e:` 新行 → 与被 P0.4 富集过的 `c:` 行**重复**。此外人名变体（"Dr. John Smith"/"Smith, John"/"J. Smith"）归一不同 → `c:` 键不同 → 也重复。

**诚实前提**：待办 2 的完整命题是「合并**多途径**找到的同一人」，而其他途径（专利/注册处/商标 = 待办 3）**尚未建**——今天只有一个联系人源 `decision_maker`。故本期只能证明「同源去重 + 建可复用的缝」，真正跨源留待办 3。

## 2. Scope（方案「修桥+建缝」，已拍板）

修 email/无-email 桥 + 同公司内人名高置信变体合并 + 抽可复用 `resolvePersonIdentity` 缝供待办 3 插入。**不**做纯 key 迁移（键形不变，桥接靠解析前置步）。

## 3. 设计

### ① 人名归一纯件 `apps/api/src/discovery/person-name.ts`（新）

从 P0.3 `email-permutation.ts` 抽出**共享**（消 DRY）：去称谓（Dr./Prof./Herr/Frau）、贵族前缀（von/van/de/der）、"Surname, Given" 语序归位、NFC 归一、德语去音标双音译。导出：
```ts
export interface ParsedPersonName { given: string; family: string; normalizedFull: string; }
export function parsePersonName(raw: string): ParsedPersonName;
export function normalizePersonName(raw: string): string; // = normalizedFull，keying/匹配共用
```
纯函数、可测。`email-permutation.ts` 改用它（保持其现有行为，回归测不变）。

### ② 解析缝 `apps/api/src/discovery/person-identity.ts`（新，给待办 3 复用）

```ts
export interface PersonResolveInput {
  workspaceId: string; companyId: string; companyKey: string;
  fullName: string; email?: string | null;
  externalIds?: { scheme: string; value: string }[]; // 待办 3：专利 inventor id / 注册号 → Tier-0 精确键
}
export interface PersonResolveHit { contactId: string; matchRule: 'external_id' | 'email_exact' | 'name_exact' | 'name_fuzzy'; }
export async function resolvePersonIdentity(tx, input: PersonResolveInput): Promise<PersonResolveHit | null>;
```
在**同一 companyId 内**找代表同一人的现有 `canonical_contact`，分层：
- **Tier 0 externalId 精确**（待办 3 用；本期 externalIds 为空即跳过）：命中某 contact 的已存 external 标识 → 该 contact。
- **Tier 1 邮箱精确**：给了 email → 找有该 email contactPoint 的同公司联系人（跨名字变体桥接："J. Smith" 带 email ≡ "John Smith"）。`match_rule='email_exact'`。
- **Tier 2 归一名精确**：同公司、`normalizePersonName` 相等。`name_exact`。
- **Tier 3 高置信模糊**：复用 `name-match.ts` 的 `pickBestByName` 对同公司现有联系人打分；**接受门槛 ≥ 0.9**（比公司 0.72 更严——🔴 贴错人比贴错公司危害大）**且 margin ≥ 0.1**（歧义即弃）。`name_fuzzy`。
- 🔴 **邮箱冲突守卫**（贯穿 Tier 2/3）：若候选与命中行**都有 email 且不同** → 判为**不同人**，跳过该命中（防同公司同名两人被并）。
- 返回首个命中 `{contactId, matchRule}`；全不中 → null（新人）。

### ③ 落库路径改造 `apps/api/src/discovery/contact-persist.ts`

`persistDiscoveredContacts` 现在对每个 contact「算 `contactIdentity` → upsert(workspace,dedupeKey)」。改为**解析前置**：
1. `const hit = await resolvePersonIdentity(tx, {...})`。
2. 命中 → **并入** `hit.contactId`：新 contactPoint / field_evidence 挂到它上；`title/seniority/department` 取更优（有则不覆盖已有非空，或按资历升级）；不建新行。
3. null → 按**现有 keying**（`contactIdentity`，键形不变）新建。

这样：带邮箱的人并进此前无邮箱的 `c:` 行（Tier 1/2/3）→ 不再生 `e:` 重复行；同名不同邮箱两人（Tier 邮箱冲突守卫）→ 不并、各自建行（`e:` 键不撞）。**零 key 迁移**——`contactIdentity` 与 `(workspace,dedupeKey)` 唯一约束都不动，桥接完全靠解析前置步。

P0.4 的 `email-guess-persist.ts` / `guessEmailsForCompany` **不改**（它们只给**已存在**的具名联系人补 email point，不新建联系人，天然不产生重复；本期只改「联系人发现落库」这条产生新行的路径）。

### ④ 合规留痕（🔴，零迁移）

合并 = 个人数据的身份归属。命中并入时写一条 `field_evidence`（`entityType='contact'`, `field='identity.merge'`, value=`{ matchRule, matchedFrom: <来源 adapterKey>, score? }`），照公司身份解析 `identity_link.match_rule` 先例做**可审计、可回溯误并**。**用 field_evidence 而非新建 identity_link 的 person 记录**（已拍板：零迁移）。

## 4. 残留边界（诚实交底）

同公司**两个无邮箱同名人** → 无区分信息 → Tier 2 会并成一条（`c:` 键本就碰撞）。信息内在缺失、罕见；**方向安全（宁欠并不错并）**，文档标注。待办 3 的 externalId（专利/注册号）到位后可区分。

## 5. 待办 3 复用缝

专利 inventor / 注册处董事落库前调**同一个** `resolvePersonIdentity`，把源侧稳定标识经 `externalIds` 传入 → Tier 0 精确键。patent 的 "John Smith @ Acme" 自动并进 Impressum 联系人。本期把缝建好、Tier 0 留空跑通即可。

## 6. 文件清单

- 新 `apps/api/src/discovery/person-name.ts` + `person-name.spec.ts`
- 新 `apps/api/src/discovery/person-identity.ts` + `person-identity.spec.ts`（注入假 tx，覆盖四 Tier + 邮箱冲突守卫 + margin 弃）
- 改 `apps/api/src/discovery/contact-persist.ts`（解析前置 + 并入/新建）
- 改 `apps/api/src/discovery/email-permutation.ts`（改用 `person-name.ts` 共享归一，回归测不变）
- 新实测 `apps/api/scripts/verify-cross-source-identity.mts`

## 7. 测试 & 实测（真实数据、无 sandbox）

- **单测**：person-name 变体（称谓/贵族前缀/语序/去音标）；resolve 四 Tier；邮箱冲突守卫（同名不同邮箱→不并）；margin 弃（同公司多同前缀名→弃）；跨 email/无-email 桥接。复用现成 email 测不动。
- **实测** `verify-cross-source-identity.mts`（app_user 非 superuser 硬 guard）：
  - seed 一人两次发现（一次 `c:` 无邮箱、一次带邮箱）→ 走 `persistDiscoveredContacts` → 断言**单条合并行** + email point 挂在原行 + `identity.merge` 证据。
  - seed 同公司同名不同邮箱两人 → 断言**两条不并**。
  - seed 人名变体（"Dr. J. Smith" vs "John Smith"）同公司 → 断言合并（Tier 3 高置信）。

## 8. 交付 & 风险

- 实现走一个功能 PR：`feat(contact): 选项 B 待办 2——跨源决策人身份解析（resolvePersonIdentity 前置 + 人名归一共享 + 合并留痕）`。
- **风险**：① 🔴 过度合并（错并两人）——靠严阈值 0.9 + margin + 邮箱冲突守卫 + 同公司限定 + 证据留痕，方向偏欠并；② 无 schema 迁移（键形不变、matchRule 走 field_evidence）；③ `email-permutation` 重构须保回归绿（行为不变）。
- 本地必绿：`api build`（tsc）→ `vitest run` → eslint 0；contact 类改动另需真实数据实测。对抗式复审专盯：🔴 错并/邮箱冲突守卫/欠并方向/事务纪律。

**不在本设计**：待办 3 P1 身份源（专利/注册处/商标）——本设计只建缝、留 Tier 0 空跑通。
