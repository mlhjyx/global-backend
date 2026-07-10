# 选项 B · P0.4 落地设计——邮箱猜测接入主链

> 2026-07-10 设计（会话内已过目、拍板：混合姿态 + interim 全局 LIA 默认关 + 加水位列迁移）。
> 关联：[decision-maker-multi-source-spec.md](decision-maker-multi-source-spec.md)（立项 spec，本文件是其 P0.3「遗留：接入主链」的落地设计）·
> [../product-scope.md](../product-scope.md)（合规红线）· [../adr/registry.md](../adr/registry.md) ADR-010（存储侧合规）· [release-plan.md](release-plan.md) §1.6。

## 0. 一句话

已落地但**无生产调用方**的 `DiscoveryService.guessEmailsForCompany` 接进主链，让 fit=match + 有域名 + 缺邮箱的**具名决策人自动补全邮箱**——两条路：①按需 HTTP 端点（人工触发、调用方带 LIA，per-tenant 干净路径）②存量 sweep 自动触发（默认关、双闸合规门）。**service 方法零改动**，两条路复用它或它的底层纯件（与 `discoverContacts`/`discoverContactsBacklog` 共用 `persistDiscoveredContacts` 是同一 DRY 缝）。

## 1. 现状与接线点（三个决定性发现）

1. **发现 run 没有联系人阶段**：`discoveryWorkflow` 明确「联系人发现/邮箱验证是后续按需步骤，不在此」。联系人真正落库只有两处——按需 `discoverContacts(ctx, companyId)` 与存量 sweep 阶段⑤ `discoverContactsBacklog`。→ 自动补邮箱的唯一正确挂点 = **存量 sweep**（阶段⑤之后加⑤b）。
2. **合规门在自动语境下默认全 blocked**：`EmailGuesser` 探测的都是人名邮箱=个人数据，`evaluateEmailGate` 无 `lawfulBasis` 且未开 `allowPersonalWithoutBasis` → 一律 `blocked`、零探测。自动路径必须解决「lawful basis 从哪来」，且**绝不**用 `allowPersonalWithoutBasis` 捅穿红线。
3. **基建就位**：`canonical_company` 已有 4 个同族水位列（`lastEnrichedAt/lastSignalAt/lastWatchAt/contactDiscoveryAttemptedAt`）+ `WatermarkField` 联合类型；`data_provider` 已有 `ownerDb.dataProvider` kill-switch 先例（ted/openfda/web_watch），且有 `config Json?` 列可存可审计配置。

## 2. 合规姿态（混合，已拍板）

| 路径 | 谁给 lawful basis | 默认态 | 说明 |
|---|---|---|---|
| **A 按需端点** | 已鉴权调用方（SaaS 前端代客户）调用时带 | 随调用 | per-tenant 干净路径，`ctx.userId` 作 basis 断言人 |
| **B sweep 自动** | 双闸：全局 kill-switch ENABLED **且** `email_guess` provider 的 `config.lawfulBasis` 有记录 | **DISABLED（关）** | 两闸都过才探；自动路径永不 `allowPersonalWithoutBasis` |

🔴 **诚实交底（限制，必须知道）**：B 路径的 `config.lawfulBasis` 是**全局 interim**——ENABLED 时对该实例所有租户套同一条 LIA 引用，**仅适用于当前单客户/dev**。**per-tenant LIA 采集是收口⑥ `DataRightsService` + SaaS 前端的活**；真开给多租户生产前，B 路径的 basis 来源**必须**换成 per-tenant（否则用 A 客户的 LIA 给 B 客户探测 = 问责缺口）。默认 DISABLED 即为此设计——不点 kill-switch，B 路径一个都不探。

## 3. 组件 A — 按需 HTTP 端点

- 路由 `POST /canonical-companies/:id/guess-emails`（class 级 `AuthGuard` 已在），照 `discover-contacts` + `contact-points/:id/verify` 样式。
- `GuessEmailsDto` 镜像 `VerifyContactPointDto`：`lawfulBasis?/lawfulBasisRef?/lawfulBasisNote?/allowPersonalWithoutBasis?` + 可选 `maxContacts?/maxProbe?`（后两者有界护栏）。
- controller 组装 `{ lawfulBasis: {basis, ref, note}, allowPersonalWithoutBasis, maxContacts, maxProbe }` → 调 `discovery.guessEmailsForCompany(ctx, id, opts)`（**service 零改动**）。
- 返回既有 summary（emaillessContacts/attempted/persisted/verified/unverified/blocked/perContact）。

## 4. 组件 B — 存量 sweep 自动触发（阶段⑤b）

新活动 `guessEmailsBacklog(args: BacklogPage & { icpId })`，**镜像 `discoverContactsBacklog` 结构**：

1. **双闸前置**（活动开头一次判，未过 → 直接返回 `{ scanned:0, attempted:0, guessed:0, skipped:true, reason }`，零触网）：
   - 全局 kill-switch：`ownerDb.dataProvider.findFirst({ where:{ key:'email_guess', status:'ENABLED' } })`，无 → `reason:'kill_switch_disabled'`。
   - 已记录 LIA：解析该行 `config.lawfulBasis`（`{ basis, ref?, note? }`，`basis ∈ LAWFUL_BASIS_KINDS`），无/非法 → `reason:'no_lawful_basis_configured'`。
2. **载入 tx**：`backlogEligibleWhere({ watermarkField:'emailGuessAttemptedAt', requireDomain:true, requireEmaillessContact:true })` 选目标公司（fit=match + 域名 + 有缺邮箱决策人 + 水位过期）；连带载入每家缺邮箱决策人 + 同域已知非-RISKY 邮箱样本（格式学习）+ 禁联名单 + 首选 `smtp_self` 验证器（`routeEmailVerification`）。
3. **事务外**：逐公司 `new EmailGuesser(verifier)`，对其缺邮箱决策人逐人 `guess({fullName, domain, knownSamples}, { lawfulBasis, actor:'backlog', suppressedEmails, maxProbe })`。DAT-011：SUSPENDED 域跳过（照⑤纪律）。
4. **短事务落库**：逐结果 `persistGuessedEmail`（复用纯件，RISKY 无 outreach、suppression 不落、personal_data + lawful_basis 留痕）。
5. **水位 stamp-all**：本批全部扫到的公司（命中/未命中/跳过）`stampProcessed(..., { emailGuessAttemptedAt: now })`——照⑤「无具名决策人属常态、防每 sweep 重烧」纪律，防活锁。

workflow：`backlogSweepWorkflow` 加阶段⑤b（`slowActs.guessEmailsBacklog`，30min 长活动、`maxGuessRounds ?? 3`、`guessBatch ?? 6`），fail-safe try/catch（单阶段失败不阻断⑥重评分），stats 加 `guesses:{ scanned, attempted, guessed }`。

## 5. 组件 C — 水位列 + eligibility

- **迁移**（加性、可空、RLS 中性，镜像 4 个同族列）：`canonical_company` 加 `emailGuessAttemptedAt DateTime? @map("email_guess_attempted_at")` + `@@index([workspaceId, emailGuessAttemptedAt])`。
- `backlog.eligibility.ts`：
  - `WatermarkField` 加 `'emailGuessAttemptedAt'`；`BACKLOG_WATERMARK_TTL_MS` 加 **30d**（SMTP 探测贵、别老锤 MX，准静态复核）；`STALE_OR`/`LRU_ORDER` 加对应字面量子句（保持 Prisma 类型收窄、不落 any）。
  - `BacklogEligibleOpts` 加 `requireEmaillessContact?: boolean` → `contacts: { some: { contactPoints: { none: { type:'email' } } } }`（有至少一个缺 email 决策人的公司）。

## 6. 测试 & 实测（真实数据、无 sandbox）

- **单测**（vitest 纯单测，无 DB/网络）：
  - eligibility：新水位字段 TTL/STALE_OR/LRU_ORDER；`requireEmaillessContact` 谓词形状。
  - activity 双闸：kill-switch DISABLED→skip、config 无 LIA→skip、双闸过→按 basis 探测（注入假验证器 + 假 ownerDb/prisma）。
  - watermark stamp-all（命中/未命中/DAT-011 跳过都 stamp）。
  - endpoint：DTO→service 入参透传（lawfulBasis 组装、maxContacts/maxProbe 传递）。
  - 复用现成 guesser/persist 50 测不动。
- **实测** `apps/api/scripts/verify-email-guess-backlog.mts`（`node --import tsx`，手动载 .env，有界样本）：
  - seed 真 workspace + ICP + 少量 fit=match+域名+缺邮箱决策人公司（复用 P0.3 verify seed 思路）→ 开 `email_guess` + 配 `config.lawfulBasis` → 跑 `guessEmailsBacklog`（limit 小）。
  - 断言：contact_point RISKY/VALID 落库、`field_evidence[email.guess]` allowedActions 无 outreach、`emailGuessAttemptedAt` 已 stamp。
  - 重跑幂等（水位新鲜→跳）；翻 `email_guess` DISABLED → skip 证明；config 去 LIA → skip 证明（红线可证伪）。

## 7. 交付 & 风险

- 一个 PR：`feat(contact): 选项 B P0.4——邮箱猜测接入主链（按需端点 + 存量 sweep 自动触发，默认关）`。
- **风险清单**（PR 正文标注）：① 迁移=加性可空列（低风险，镜像现有水位列，RLS 中性）；② interim 全局 LIA（§2 交底，默认关，per-tenant 归收口⑥）；③ 自动路径永不 `allowPersonalWithoutBasis`（红线，单测证伪）。
- 本地必绿：`db generate`（schema 变）→ `api build`（tsc）→ `vitest run` → eslint 0；provider/采集类改动另需真实数据实测。
- 对抗式复审（code-reviewer，专盯合规/诚实降级/事务纪律），HIGH/CRITICAL 先修带回归再合。CI 绿 + 复审清 + 实测通过后自主 squash 合并（用户已授权）。

**不在本 PR**：待办 2 跨源身份解析（name-match 合并多源同一人）、待办 3 P1 身份源（专利/注册处/商标）——后续独立 track。
