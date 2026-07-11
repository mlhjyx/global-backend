# 决策人多途径发现与联系方式补全 —— 立项 spec（选项 B）

> 2026-07-10 立项（DRAFT，待评审）。回应真实痛点：官网这一途径能稳定拿决策人**姓名+职务**，但**本人可用邮箱/电话**大多拿不到（官网很少公示到个人）。目标=从「谁是决策人」到「决策人本人可用、经验证、合规可存的联系方式」。
> 关联：[../product-scope.md](../product-scope.md)（边界与合规红线）· [../adr/registry.md](../adr/registry.md) ADR-010（存储侧合规）· [../research/buyer-intelligence-v3.md](../research/buyer-intelligence-v3.md) §B（原始设计）· [release-plan.md](release-plan.md)。
> 已落地基建（复用，不重造）：`decision-maker.provider`（官网抽具名人）· `smtp_self`（SMTP RCPT 验证）· `name-match`（实体解析）· `field_evidence`（来源/许可/时间）· `ToolBroker`（出网闸门）· `source_policy`（用途门）。

## 0. 一句话

**多途径交叉挖到「对的人」→ 邮箱模式排列+SMTP 验证补出「他的邮箱」→ 融合成一份带置信度、带证据、合规隔离的决策人档案。** 不靠单一途径，不碰红线，诚实标注拿不到的。

## 1. 合规红线（先讲边界——这是护城河不是短板）

| 红线 | 说明 |
|---|---|
| 🔴 不直爬 LinkedIn/社媒 | 只经**搜索引擎读已公开索引的片段**（hiQ 判例 + 合同法）；不登录抓取、不账号池、不逆向其 API |
| 🔴 不买私人数据库 | 不接 Apollo/ZoomInfo/Hunter 私人邮箱库（ZoomInfo 近 3000 万美元隐私和解为鉴） |
| 🔴 不绕访问控制 | 不绕验证码/登录/付费墙；robots 从严 |
| 🔴 个人数据隔离 | 具名人一律 `personalData=true` + `field_evidence`（来源/许可/时间）；**无 LIA 记录不解锁 OUTREACH** |
| 🔴 验证不发信 | 邮箱验证只做 SMTP RCPT 握手，不投递 DATA |
| 🔴 法域限定 | GDPR Art.14 告知义务 + PIPL 出境（境外个人数据回传境内）→ 经 `DataRightsService` 按法域判定（收口⑥） |

**战略含义**：竞品的「决策人私人邮箱手机」多靠爬 LinkedIn + 买库。我们**故意不这么做**——在出海 B2B，一个被 GDPR 罚款/诉讼的线索比没线索更糟。合规原生是我们相对腾道/ZoomInfo 的差异化。

## 2. 决策人**身份发现**途径全集（拿到「谁是决策人」）

> 目标 title：采购/Sourcing、供应链、品类经理、产品/工程（OEM 零件）、Owner/GM（SME）——对齐买家委员会。

| # | 途径 | 免费来源 | 挖到 | 合规 | 命中率 | 落地难度 | 现状 |
|---|---|---|---|---|---|---|---|
| 1 | **官网 Impressum/团队/管理层页** | 官网（crawl4ai） | 姓名+职务+（部分）具名邮箱/电话 | 🟢 德国 §5 DDG 法定公示 | 高（德/欧中小企业） | — | ✅ 已落地 |
| 2 | **公司注册处 董事/高管** | UK Companies House officers API（免费绿）· 德 Handelsregister/OffeneRegister（灰·自动化限制）· 各国 registry | 法定董事/总经理姓名+任职 | 🟢🟡 按国 | 高（UK）/中（DE） | 中 | ⬜ |
| 3 | **专利发明人 inventor** | USPTO PatentsView API（免费绿）· EPO OPS（免费 ~4GB/周） | 具名研发/工程决策人 + 雇主 | 🟢 法定公开出版 | 中（限有专利公司） | 中 | ⬜ |
| 4 | **商标 申请人/代表** | USPTO TSDR · EUIPO · WIPO（免费） | 品类品牌主 + 代表联系人 | 🟢 公开注册 | 中 | 中 | ⬜ |
| 5 | **新闻稿/PR 具名高管** | GDELT DOC 2.0（免费无 key）· SearXNG news | 具名高管 + 职务 + 事件 | 🟢 公开新闻 | 低-中 | 中 | ⬜ |
| 6 | **LinkedIn 公开档（经搜索引擎）** | Google/Bing dork `site:linkedin.com/in "职务" "公司"` | 姓名+职务+公司 | 🟡 只读已索引公开片段 | 中 | 中（SERP 亦有 ToS 面） | ⬜ |
| 7 | **展会/会议 演讲者名单** | Swapcard/Sessionize SPA（crawl4ai 抓包） | 具名人 + 职务 | 🟢 公开议程 | 中（限参会） | 中 | 部分（展会源已有） |
| 8 | **行业协会 理事/会员代表** | 协会官网名录 | 具名代表 + 职务 | 🟢 公开名录 | 低-中 | 低 | ⬜ |
| 9 | **技术社区/学术**（for SaaS/tech 买家） | GitHub org 成员、会议论文作者 | 技术决策人 | 🟢🟡 | 低（限技术类） | 中 | ⬜ |

## 3. 决策人**本人联系方式**途径（拿到「怎么联系他」）

| # | 途径 | 方式 | 挖到 | 合规 | 命中率 | 现状 |
|---|---|---|---|---|---|---|
| A | **官网具名邮箱/电话直抽** | crawl4ai + AI 抽（只抽页面明确写出的，不推断） | 具名邮箱/电话 | 🟢 | 低（页面常只写名字） | ✅ 已落地 |
| B | **⭐ 邮箱模式排列 + SMTP 验证** | 姓名 + 域名 → 排列 `f.last@/first.last@/last@/fl@…` → 逐个 SMTP RCPT 验证 → 命中 VALID 即其邮箱 | 决策人**可用邮箱** | 🟡 验证不发信 | 中（中小企业）/低（大企业 catch-all/M365 反枚举） | ✅ 已落地（P0） |
| C | **公司邮箱格式学习** | 从该公司已知一个具名邮箱（如官网某人）反推格式 → 套用到其他决策人 → 验证 | 同上，命中率更高 | 🟡 | 中 | ✅ 已落地（P0） |
| D | **新闻/专利/商标文件 联系邮箱** | 从 §2 的 3/4/5 途径文件里带出的联系邮箱 | 邮箱（部分职能） | 🟢🟡 | 低 | ⬜ |
| E | WHOIS/RDAP 注册人 | RDAP 查域名注册联系 | 邮箱（多隐私保护） | 🟡 | 很低 | ⬜（低优先） |

**天花板（诚实交底，§10.3）**：Gmail/M365 对未知 IP 反枚举/节流 → 无法逐地址确认；30-40% B2B 域是 catch-all（对任意地址都「接受」）→ 同样测不准。这几类只能靠「排列先验 + 该邮箱在网上出现过的旁证」**降级标 RISKY/PROBABLE，不谎报 VALID**。→ 中小企业成功率明显高于大企业。

## 4. 融合架构（怎么把多途径拼成一份档案）

```
① 身份发现（§2 多途径并行）→ 候选决策人 [姓名, 职务, 来源]
        ↓ name-match 跨源身份解析（姓名+公司匹配，防张冠李戴/合并同一人多源出处）
② 决策人实体（唯一）+ 多源出处证据
        ↓ 联系方式补全（§3）
③ 邮箱：排列生成(B) × 格式学习(C) × 页面直抽(A) × 文件带出(D)
        ↓ SMTP 验证 + 旁证 → 置信打分
④ 决策人档案 = {
     姓名 / 职务 / 买家角色(is_target_role) / 多源出处[]
     邮箱[]{地址, 验证态 VALID|RISKY|PROBABLE, 来源, 时间}
     电话[]{号码, 类型 direct|switchboard, 来源}
     置信度 / personalData=true / field_evidence[] / 法域 }
        ↓
⑤ 合规门：DataRightsService 按法域判 STORE/AI_PROCESS；OUTREACH 需 LIA（发送侧，后延）
```

复用已有件：`decision-maker.provider`（途径 1）· `smtp_self`（验证）· `name-match`（③ 身份解析）· `field_evidence`（来源/许可/时间/可删除）· `ToolBroker`（所有出网）· `source_policy`（用途门）· `suppression`（禁联优先）。

## 5. 分期 backlog（按 ROI × 合规 × 复用现有基建）

**P0 —— 最高 ROI，直接补痛点，复用 smtp_self**（不接任何新外部源）
1. ✅ **邮箱模式排列生成器**（途径 B，已落地）：`discovery/email-permutation.ts`（纯：姓名解析去称谓/贵族前缀 + 德语标准/去音标双音译变体 + 10 种 B2B 命名法按先验排序、去重、有界）→ `discovery/email-guesser.ts`（编排：**合规门一次判** → 逐候选经 `SelfHostedEmailVerifier`(ToolBroker) SMTP 验证 → 命中 VALID 即停、域级事实一次短路 → 置信打分）。把「有名字没邮箱」变成「有可用邮箱」，零新源。
2. ✅ **公司邮箱格式学习**（途径 C，已落地）：`discovery/email-format-learning.ts`（纯：从站内已知具名邮箱多样本投票反推命名法 → 套用到其他决策人，置信压过盲排列；与排列器共享 `KNOWN_PATTERNS`/`buildLocalPart`，DRY）。
3. ✅ **落库接线**（P0.3，已落地）：`discovery/email-guess-persist.ts`（`guessedEmailWritePlan` 纯决策 + `persistGuessedEmail` 写 `contact_point`(status VALID/RISKY + verifiedAt) + `field_evidence`(email.guess 证据)）+ service `guessEmailsForCompany`（对公司缺邮箱具名决策人批量猜测并落库，照 discoverContacts 的「载入→事务外网络→落库」纪律）。🔴 只落 verified/unverified；**RISKY 猜测 allowedActions 不含 outreach**（不可群发）；suppression 不落；人名邮箱 personal_data 隔离 + lawful_basis 留痕。
4. ✅ **接入主链**（P0.4，已落地，见 [decision-maker-p0.4-mainchain-wiring-design.md](decision-maker-p0.4-mainchain-wiring-design.md)）：①按需端点 `POST /canonical-companies/:id/guess-emails`（调用方带 LIA，per-tenant 干净路径）②存量 sweep 阶段⑤b `guessEmailsBacklog`（**默认关**双闸：全局 kill-switch `email_guess` ENABLED **且** `config.lawfulBasis` 有记录才自动探测；自动路径**永不** allowPersonalWithoutBasis）+ 水位列 `emailGuessAttemptedAt`（30d TTL 防重锤 MX）+ per-company cap（共享纯件 `buildGuessTargets`）。🔴 交底：B 路径 `config.lawfulBasis` 是 interim 全局，per-tenant LIA 采集归收口⑥。
5. ✅ **跨源身份解析**（待办 2，已落地，见 [decision-maker-cross-source-identity-design.md](decision-maker-cross-source-identity-design.md) · PR #54）：落库前 `resolvePersonIdentity` 前置（同公司 4-Tier：externalId/邮箱精确/归一名/高置信模糊 + 🔴 邮箱冲突守卫 + 严阈值 0.9·margin 0.1，宁欠并不错并），修 email/无-email 桥 + 人名变体重复，建成待办 3 复用缝（`externalIds`→Tier 0）。matchRule 走 field_evidence（零迁移）。**遗留**：待办 3 P1 身份源（专利 inventor/注册处董事/商标申请人）。

> **已落地实测**（真库真爬真 SMTP、无 sandbox）：
> - 猜测（`scripts/verify-email-guess.mts`）：searxng 发现德国泵企 → crawl4ai 抽「Ruud Croonen — Geschäftsführer」（无公开邮箱）→ 排列真产 `ruud.croonen@/r.croonen@/…osna-pumpen.de` → 经 ToolBroker 真 SMTP → 诚实降级 `unverified`（`mail_from_rejected`，**不谎报 VALID**）。真数据反抓并加固 `mail_from_rejected`=会话级事实一次短路。
> - 落库（`scripts/verify-email-guess-persist.mts`）：seed 缺邮箱决策人 → `guessEmailsForCompany` → 库内读回 `contact_point: ruud.croonen@osna-pumpen.de status=RISKY`、`field_evidence[email.guess]` allowedActions=`["display","match"]`（无 outreach）、personal_data=true、lawful_basis 已记录。
>
> 质量：**50 单测**（排列/格式学习/编排/落库四模块，含合规 BLOCKED、catch-all/反枚举/no-MX/mail-from-rejected 短路、格式学习优先、suppression 跳过、先拒收后域级事实的 HIGH 回归、落库 VALID/RISKY/suppressed 分支）+ 对抗式复审（HIGH+2MEDIUM+LOW 全修带回归）。

**P1 —— 扩身份途径（免费绿源优先）**
4. **专利 inventor**（USPTO PatentsView / EPO OPS）—— 绿事实、具名工程决策人。
5. **公司注册处董事**（UK Companies House officers API 起步 → 扩德/法）—— 法定董事总经理。
6. **商标 申请人/代表**（USPTO/EUIPO/WIPO）。

**P2 —— 灰区/难，谨慎且量力**
7. **LinkedIn 经搜索 dork**（只读 SERP 公开片段，不直爬）—— 命中好但 SERP 亦有 ToS 面。
8. **新闻 PR 具名高管**（GDELT）。
9. **展会/会议演讲者**（扩现有展会抓包）。
10. 行业协会/技术社区（按客户行业按需）。

每期验收：真实数据实测（有界样本）+ 合规自检（personalData 隔离/无 PII 入 trace/SMTP 不发信）+ 命中率报告（区分中小企业 vs 大企业）+ 对抗审查。

## 6. 诚实的能力预期（写给客户沟通口径）

- **稳定拿到**：决策人姓名 + 职务 + 买家角色（多途径交叉）。
- **中等命中**：决策人本人**可用邮箱**（中小企业 > 大企业；排列+验证+旁证，标注置信度不谎报）。
- **基本拿不到**：决策人**私人手机**（合规免费途径极少公示个人直线）——这是诚实边界，不承诺。
- **不做**：直爬 LinkedIn / 买私人库 / 绕验证码 —— 无论如何不碰。
- **承诺**：多途径尽力 + 每条数据带来源与置信度 + 全程可删除（DSR）+ 合规隔离。

> 一句话对外：**「我们不卖来路不明的私人数据；我们从公开合规来源交叉找到对的人，验证他的工作邮箱，并如实告诉你每条信息的来源和可信度。」** 这正是出海 B2B 场景该有的合规姿态。
