# 删除编排 Art.17 —— contact 主体重物化残留并发窗口收口（设计note + 实施）

> 承 PR #80（`feat/deletion-art17-race-hardening`，merge `f57345d`）对抗复审 **CONFIRMED（2-0，HIGH）** 的残留窗口。
> 决策：**综合方案**（Option 1 的行锁机制置于擦除侧 + Option 2 的有界对账，折进 `eraseSubject`）。2026-07-13。

## 0. 问题（精确复述）

`contact` 主体 DSR：
- `locate()` **只按 `id` 读原始联系人**，`eraseSubject` **只删该 `contactId`**；公司**永不加锁、永不标 `SUPPRESSED`**（正确——单个联系人删除不应封停整公司发现）。
- 抵御「换新邮箱重物化被擦除自然人」的**唯一防线** = `persistDiscoveredContacts` 里的 person-level `contact_key` 闸——一个 READ COMMITTED 下的**非加锁快照读**（`suppressionRecord.findMany({type:'contact_key'})`）。
- **竞态**：并发发现事务若在 `freezeSubject` 提交 `contact_key` **之前**读到该集合 → 漏读 → 新建一条该人的 `canonical_contact`（新 id、新邮箱，`resolvePersonIdentity` 认不出已删原件）。`eraseSubject` 只删原 `contactId` → 重物化行**永久存活**（`contact_key` 闸只在创建时跑，无后台清扫）= 静默 Art.17 违规。

## 1. 四个选项的权衡

| 选项 | 结论 | 理由 |
|---|---|---|
| **3. SERIALIZABLE** | **驳回** | 坏结果是一个**合法串行调度**，非序列化异常。`freeze` 只按 id 读原始联系人；并发 persist 写的是**另一行**（不同 id）+ 读 `suppressionRecord` 谓词——二者不构成 SSI 危险 rw 环 → 不会 abort。即便完美串行 `[persist→freeze]`，因 contact 主体 DSR 删的是**单一具名 id、从不按人重扫**，新行仍存活。高重试成本、~零收益。 |
| **1. 冻结侧 FOR UPDATE（不标 SUPPRESSED）** | **部分** | 关掉「persist 的锁/读**晚于** freeze 的锁」交错（persist 阻塞后复读到已提交键 → 创建闸跳过）；留下「persist **先**抢到行锁、读空键、创建、提交」交错。是机制，非完整修复。 |
| **2. 完成后有界对账（单独）** | **可行但时序脆弱** | 无序列化锚点则无法判定在途 persist 何时排空 → 需延迟/重试启发式（本身是竞态）。 |
| **综合（采纳）** | **完整、同步、无延迟** | 见 §2。 |
| **4. 接受 + 记录** | 备选 | 与「公司路径 recheck-suppression 竞态（单独跟踪）」一致的兜底。 |

## 2. 采纳方案：擦除侧 FOR UPDATE（排空）+ 有界 person-key 对账（折进 `eraseSubject`）

对 **contact 主体**，`eraseSubject` 在删除前：

1. **排空锚点**——对属主公司行取**瞬时 `FOR UPDATE`**（与公司主体路径**同一把锁**，但**不**标 `SUPPRESSED`，故该公司发现不受影响）。并发插入 persist 的 FK `FOR KEY SHARE` / 显式 `FOR SHARE` 与 `FOR UPDATE` 互斥 → 本锁到手即建立 happens-before：**此刻所有竞态 persist 均已提交、其重物化行均已可见**。
2. **有界对账**——同一 tx 内，删除本公司中「person-key 命中被擦除人的 `contact_key`」**且** `createdAt >= deletion_request.createdAt` 的联系人。

这让**并发情形等价于创建闸已能处理的顺序情形**——无延迟、无启发式。锚点之后新起的 persist 读到已提交 `contact_key` → 创建闸跳过 → 无新行。**闭合「DSR 受理后插入的 create-path 重物化」窗口**（残留边界见 §2.1）。

### 2.1 createdAt 语义与 tx-start 顾虑（对抗复审提出 → 实测证伪）

复审提出：若 `canonical_contact.createdAt` 走 Postgres `DEFAULT CURRENT_TIMESTAMP`（= **事务开始时间**），则一条**先于 DSR 开始、于冻结后提交**的竞态 persist 会把重物化行的 `createdAt` 回填到 DSR 之前，逃过 `>= since` 过滤。

**实测证伪**（探针：同一事务内相隔 600ms 的两次 `create`，`createdAt` **不同**：`…:38.720Z` vs `…:39.324Z`；若为 tx-start 则必**相等**）：Prisma `@default(now())` 在 **insert 时刻**取值（不走 DB `DEFAULT CURRENT_TIMESTAMP` 的 tx-start 语义），故 `createdAt` = **实际插入时刻**。任何 **DSR 受理后插入**的重物化行 `createdAt > 受理时` → 被对账捕获。

残留仅剩「insert 于 DSR 受理**之前**、commit 于其后」的 ms 级窄缝——按插入时刻，该行创建**先于请求** = **既有重复行**语义（row-scoped DSR + name-only key 的既有局限，与创建闸同源、与被驳回 sweep 同源），非本变更引入。反向的 **freeze-snapshot** 替代（按冻结可见性而非时间戳判定）**更差**：其盲区是 `[受理, 冻结]` 窗口，因 outbox/Temporal 调度延迟可达**秒级**，远大于本方案的 ms 级窄缝；且要根治「insert-before-DSR」必须删同 person-key 的先存行 = 回到被驳回的数据丢失 sweep（name-only key 无法区分先存同名另一真人）。故 createdAt=插入时刻 的锚点在既有身份模型下**最优**。

### 为什么 `createdAt` 过滤是关键（与 PR #80 驳回的 sweep 的差异）

PR #80 复审驳回的是**无时间界的擦除侧 person-key 扫描删**——它会删掉**先于 DSR 就存在**的同名**另一真人**（数据丢失）。本方案 `createdAt >= deletion_request.createdAt` **只触碰 DSR 受理后新建的行**，先存的同名同事**绝不触碰**。

残留数据丢失面 = 「一个**确实不同**的同名人，恰在竞态窗口内、于**同公司**被新建」。此面：
- **性质上等同于创建闸**已在做的事（顺序情形下创建闸对未来同名创建同样**拒建**）——本方案只是把「拒建」改成对窗口内已建行「删除」，净数据态一致；
- 被 `createdAt` 过滤**界定在新建行**；
- 在 **Art.17 法定义务**面前取舍——重物化被删自然人是法律红线，删掉一个系统身份模型本就会拒建的同名新行是可接受代价。

### 已知更深残留（本方案不引入、不恶化，均为 name-only key / row-scoped DSR 的**既有**局限，与创建闸同源，单独跟踪）

1. **merge-into-先存同事**：竞态窗口内若 persist 走 **merge**（并入一条**先存的**同名同事行）而非 create，则 `createdAt` 对账不覆盖（目标行先存）。但：窗口内原始被擦除件**仍在**（擦除晚于冻结），`resolvePersonIdentity` 极可能命中**原始件**（同身份）→ 并入原始件 → 随擦除级联删净；命中先存**不同**同名同事需其比原始件更优匹配（原始件共享精确身份，几无可能）；完成后创建闸先于 resolve 拦截。故此向可忽略。
2. **归一化盲区**（✅ **已闭合**——见后续 PR `fix/deletion-art17-name-normalization`，栈于本 PR 之上）：原 `contactNameKeyPart` 仅 `lowercase + 折叠空白 + trim`，无 NFC/NFD 归一、无变音符折叠、对顺序敏感，故重物化写成 `Petra Wiederganger`（无变音）/ 分解 Unicode / `Wiedergänger, Petra`（"Surname, Given" 形，openFDA 等路径会产生）会算出**不同** person-key → 同时逃过**创建闸与对账**。**修复**：新增 `contactSuppressionKeys`＝**归一名变体集**（德语音译 ä→ae + 纯去音标 ä→a + umlaut 折叠令无变音锚点的 Mueller↔Muller 也收敛 + NFC 先归 + "Surname,Given" 语序归位 + 称谓剥离），三消费者（冻结/创建闸/对账）统一按变体集**交集**判定，并叠加**旧单值形**向后兼容（既有 contact_key 精确形不静默失配）。**剩余残留**（更窄、方向偏 over-suppress = Art.17 安全侧）：(a) **无逗号**的「Family Given」空格换序无法与「Given Family」区分——自动换序会误伤正常序，有意不做；(b) 对账删除面随之扩到拼写变体的**同名另一真人**（窗口内），仍受 `createdAt >= 受理时` 有界约束、不致无界数据丢失。根治仍属**待办3 强身份**（externalId/CH officer id 精确并，绕开 name-based 模糊）范畴。
3. **先存重复行**（row-scoped DSR）：若被擦除人 P 在 `createdAt < 受理时` 另有一条合法行（历史 dedup 漏并），本次只删目标 + 窗口 straggler，该先存重复行留存 P 的 PII。删它需触碰先存同 person-key 行 = 数据丢失 sweep 领域，故 `createdAt` 锚点有意不及。
4. **dedupeKey 漂移**（LOW）：若 `canonical_company.dedupeKey` 在冻结后变化（如 NEW 公司后来获得域名），冻结所写 `contact_key`（旧键）与后续创建闸的当前键计算不再匹配 → 长效 person 禁联静默失效。对账因目标与候选在同一 tx 内都用当前键、内部自洽，不受影响。属 PR #80 键稳定性既有弱点。

## 3. 实施要点

- 仅动 `eraseSubject` 的 **contact 主体分支**；公司主体分支不变（其已有 erase 侧 `FOR UPDATE` + 全量重查 + `SUPPRESSED`）。
- 幂等：对账只在 `moved.count>0`（首次真擦除、原始件尚在）跑；重跑经 `stats` 早返回，不触对账。
- person-key 与创建闸**同构**：`blindContactKey(contactIdentity({fullName}, company.dedupeKey))`（对账候选读走扩展 client → `fullName` 明文解密；`FOR UPDATE` 走 `$queryRaw` 仅锁 id）。
- 真实计数（回执/`stats`）自然把对账删掉的行计入 `contactsErased/contactPointsErased/fieldEvidenceErased`（复用既有 deleteMany 计数）。

## 4. 验证

- 纯单测（CI）：对账候选判定的纯逻辑（person-key + createdAt 过滤）。
- 真库并发验证（无 sandbox，`scripts/verify-deletion-race-hardening.mts` 新增 **F5**）：contact 主体删除中，一条并发发现事务在冻结提交 `contact_key` **前**读快照、冻结后创建同人新邮箱行 → 擦除侧 `FOR UPDATE` 排空 + 对账删净 → 公司下 0 该人行、回执计数含被对账行。先对现码 RED（残留行存活），实施后 GREEN。

## 5. 风险与评审

HIGH-RISK 合规码：TDD + 真库并发证明 + 对抗复审后开 PR，**人工审查后再合并**（不自动合并）。
