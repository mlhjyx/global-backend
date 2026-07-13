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

这让**并发情形等价于创建闸已能处理的顺序情形**——无延迟、无启发式。锚点之后新起的 persist 读到已提交 `contact_key` → 创建闸跳过 → 无新行。**完整闭合。**

### 为什么 `createdAt` 过滤是关键（与 PR #80 驳回的 sweep 的差异）

PR #80 复审驳回的是**无时间界的擦除侧 person-key 扫描删**——它会删掉**先于 DSR 就存在**的同名**另一真人**（数据丢失）。本方案 `createdAt >= deletion_request.createdAt` **只触碰 DSR 受理后新建的行**，先存的同名同事**绝不触碰**。

残留数据丢失面 = 「一个**确实不同**的同名人，恰在竞态窗口内、于**同公司**被新建」。此面：
- **性质上等同于创建闸**已在做的事（顺序情形下创建闸对未来同名创建同样**拒建**）——本方案只是把「拒建」改成对窗口内已建行「删除」，净数据态一致；
- 被 `createdAt` 过滤**界定在新建行**；
- 在 **Art.17 法定义务**面前取舍——重物化被删自然人是法律红线，删掉一个系统身份模型本就会拒建的同名新行是可接受代价。

### 已知更深残留（本方案不引入、不恶化，单独跟踪）

竞态窗口内若 persist 走 **merge**（并入一条**先存的**同名同事行）而非 create，则 `createdAt` 对账不覆盖（目标行先存）。但：窗口内原始被擦除件**仍在**（擦除晚于冻结），`resolvePersonIdentity` 极可能命中**原始件**（同身份）→ 并入原始件 → 随擦除级联删净；命中一个先存**不同**同名同事需该同事比原始件更优匹配（原始件共享精确身份，几无可能）；完成后创建闸先于 resolve 拦截。故此向可忽略，且是 name-based 身份模型的**既有**局限（创建闸同源），非本变更引入。

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
