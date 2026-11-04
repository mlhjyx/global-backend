# 联系人发现 M5：Golden Set 质量评估（2026-11-03）

> 结论先行：**Impressum 具名决策人的公司级命中率 67%（10/15），命中公司内人级召回 100%（14/14）**；
> 误报集中在两类可定位的机制（姓氏同名 3 人、同名异公司 6 人）；**邮箱覆盖是最大短板**
> （引擎 46 人仅 4 人带邮箱、0 人验证通过），主因是 `email_guess` 当前关闭。
> 评测数据来自第十一班镜像（build 8f204960），未含任何改进。
> **第三轮复测（§9，第十三班镜像 `fe0c7d71`，含 #744/#748）**：零产出 5→4、公司级命中 10→11/15、
> 人级召回 14→17/22、新行误报 19.6%→7.7%（1 条社媒垃圾档案漏网）；存量误报行仍在，称号去重缺陷新发现。
> **第四轮复测（§10，第十四班镜像 `8b142f53`，含 #760/#761）**：零产出 4→2、公司级命中按 §2 口径 12→14/16、
> 人级召回 17→19/22、称号去重成立（trik 重抓 0 重复）；新行误报 2/12（同名异公司 LinkedIn 残留 2 条，
> 守卫把 bts 的 6 条垃圾档案压到 2 条）；邮箱 58/60 仍全 RISKY、VALID 0。

## 1. 范围与样本

- 样本：20 家 `fit=match` 的德/奥泵业相关公司（同一 E2E 工作区），覆盖 7 家已有 run 产出的公司 +
  13 家从未跑过联系人阶段的公司。
- 13 家的引擎产出经管理端 `POST /canonical-companies/:id/discover-contacts`（一次性授权，
  `lawfulBasis=legitimate_interest`，ref=OWNER-DECISION-2026-10-11）首跑获得；其中
  `pumpen-schmid.de` 被 `EXECUTION_BUDGET_GRANT_REUSED` 挡下（该请求作用域此前已被消耗），
  未获评估——即已知「失败后不可重试」缺口的又一实例。
- 评估口径：个人姓名不外发；本报告只给聚合指标与按域名的计数。

## 2. 方法

- **Ground Truth**：逐家抓取官网 Impressum/Über uns 页，人工核对「Geschäftsführer / Geschäftsleitung /
  Vertreten durch / Inhaber」具名人员。20 家中 15 家可得具名 GT；3 家 Impressum 无具名人员或页面 404，
  1 家找不到 Impressum（BTS）。GT 与引擎输出独立获得，互不参考。
- **引擎输出**：经 `GET /canonical-companies/:id` 读取（解密视图），统计人、职位、联系方式及其状态。
- **命中**：姓名与 GT 决策人匹配（容错变音/缩写）。**误报**：既非 GT 决策人、也无法从公司官网员工页
  佐证的具名个人（区分「真实扩展员工」与「误报」）。

## 3. 结果（20 家样本，19 家获评，1 家被授权复用挡下）

| 指标 | 数值 |
| --- | --- |
| 公司级命中（≥1 名 Impressum 决策人被找到） | **10 / 15 = 67%** |
| 人级召回（GT 决策人被找到） | **14 / 22 = 64%**；命中公司内 14/14 = 100% |
| 引擎产出人总数 | 46 |
| 误报 | **9 / 46 = 19.6%**（集中在 2 家） |
| 合法扩展员工（官网员工页可佐证，非误报） | 19 |
| 零产出公司 | 5 / 19（其中 3 家官网有可达的 Impressum） |
| 有邮箱的引擎人 | 4 / 46（3 × UNVERIFIED 直抽、1 × RISKY 猜测）；**VERIFIED 0** |
| GT 决策人带邮箱 | 2 / 14 |
| 本批 12 家首跑花费 | ≈ $0.95（≈8¢/家，D5 上限 20¢/家内） |

## 4. 质量分析

1. **误报=姓氏同名（3 人）**：某公司（域名的词根恰为德国姓氏）在社媒层匹配到印度的同姓个人主页——
   引擎把「姓氏与公司名相同」当成了线索。需要 namesake 守卫：社媒候选必须另有公司关联证据
   （公司域名/雇主字段/官网出现），仅姓氏相同不足以入库。
2. **误报=同名异公司（6 人，含 1 条「公司当人」脏数据）**：一家德国泵店与美/英同名工程公司
   （BTS）全部混淆；且领英返回了一条公司实体被当作个人记录（名字字段是公司名+业务）。
   需要：同名公司消歧（国家/行业信号）与「公司当人」行过滤。
3. **零产出 5 家**：其中 3 家官网 Impressum 可达，说明不是「没有可挖的人」，而是抓取路径没走到
   （入口页发现/robots/渲染）。下一步按公司逐一排查决定抓取（decision_maker）的页面选取。
4. **邮箱是短板**：14 名 GT 决策人只有 2 人带任何邮箱（14%），且 0 人验证通过；`email_guess`
   关闭让「猜+SMTP 验证」这条主路径完全缺席。与 M3/D3 的预期一致——打开开关后再评测一次邮箱维度。

## 5. 建议（按收益排序）

1. **重开 `email_guess` 并复测邮箱维度**（发布线执行中）：预期把「决策人带可用邮箱」比例从 14% 显著抬高。
2. **社媒 namesake 守卫 + 公司当人过滤**（引擎侧小改动）：直接消掉本批 19.6% 的误报来源。
3. **零产出公司的抓取路径排查**：3 家有可达 Impressum 的公司未产出任何候选人，说明入口发现/渲染有盲区。
4. 沿用本次方法，在邮箱开关打开后跑**第二轮 Golden Set**（同 20 家用新 run 或新请求作用域），
   作为 M5 的对照基线。

## 6. 局限

- GT 只认 Impressum 具名人员，销售/技术等职能岗位不在 GT 内——这部分被计入「扩展员工」而非命中。
- 3 家 GT 不可得、1 家找不到 Impressum；1 家被授权复用挡下未评估。
- 样本为单一 workspace 的德奥泵业公司（单 ICP 行业），外推到其他行业需另行采样。
- 本轮花费与统计来自 E2E 工作区账本；人名数据仅存于本机临时目录，报告不含任何个人姓名。

## 7. 第二轮：邮箱维度（2026-11-03 晚，`email_guess` 已开）

- **方法**：对同一 Golden Set 中已有联系人的 12 家公司 / 37 人，经管理端
  `POST /canonical-companies/:id/guess-emails`（每公司一次性授权，`lawfulBasis=legitimate_interest`）补全邮箱。
- **结果**：
  | 指标 | 补全前 | 补全后 |
  | --- | --- | --- |
  | 有邮箱候选的人 | 4 / 37（3 UNVERIFIED 直抽 + 1 RISKY） | **37 / 37** |
  | 状态分布 | — | RISKY 34、UNVERIFIED 3（直抽）、**VALID 0** |
- **25 出站的根因与修复（已查明）**：本机防火墙 OUTPUT 全放行；根因是 Clash TUN 把所有流量
  MATCH 到机场节点，而**该节点只转发 80/443**（实测经它 CONNECT 25/587/22 一律无数据，80/443 正常）。
  在 Clash Verge 的 Merge 配置加 `DST-PORT,25,DIRECT` / `DST-PORT,587,DIRECT`（持久化）并热重载后，
  25 直连恢复正常（Gmail / Outlook / iCloud MX 实测均返回 `220` banner，TUN 保持开启）。
- **SMTP 验证的真实结果（网络修复后重跑）**：37 个点全部完成：
  **2 INVALID、35 RISKY、0 VALID**。2 个 INVALID 均属同一域名（RCPT 明确拒收——该域的邮箱
  命名模式与 `vorname.nachname@` 不符）；0 VALID 是验证器的**诚实口径**而非缺陷：VALID 要求
  「RCPT 接受 + 随机地址被拒（catch-all 证伪）+ 非反枚举」，而德国 SME 大量使用 catch-all 域名或
  灰名单应答，多数候选只能停在 RISKY（`buyer-intelligence-v3.md` §10.3 的既定上限）。
- **意义**：`email_guess` 把「有邮箱候选」从 11% 提到 100%，德国 SME 的
  `vorname.nachname@domain` 模式命中率高；但外发前仍需人工确认或打通验证通道。
- **建议**：
  1. 25 出站已修复（Clash Merge 配置已持久化），无需再动网络；
  2. 邮箱可用性的现实路径是「RISKY（catch-all 证伪未遂）→ 人工确认」；UI 上可把
     INVALID（RCPT 拒收，不可用）与 RISKY（可能可用）区分展示，避免人工逐个排查；
  3. 真实客户外发保持现行质量门：RISKY 不自动进入 VALID、外发前人工确认；INVALID 不再重试。

## 9. 第三轮：修复后复测（2026-11-03 晚，第十三班镜像 `fe0c7d71`）

**镜像与前置**：第十三班镜像 `fe0c7d71`（源 `4133259f`），含 #744（社媒同名/机构名守卫）与 #748（人员页
链接回退）；`email_guess` 保持 ENABLED；SMTP 25 出站修复（§7）延续有效。方法与第一轮一致：同一 20 家
Golden Set，逐家 `POST /canonical-companies/:id/discover-contacts`（本轮带 `attemptId` 作用域键，绕开
`GRANT_REUSED`；`lawfulBasis=legitimate_interest`），缺失邮箱的联系人经 `guess-emails` 补全，产出经
`GET /canonical-companies/:id` 读取。采集窗口起点 `T0=2026-11-03T13:59:52Z`，新增行按 `createdAt > T0` 判定。
评估仍只出聚合与域名计数，不含个人姓名。

**结果**：

| 指标 | 第一轮（8f204960） | 第三轮（fe0c7d71） |
| --- | --- | --- |
| 引擎在库联系人总数（同 20 家） | 46 | 59（新增 13 行，其中 1 行为同人去重失败，见下） |
| 零产出公司 | 5 | **4**（`ando-technik.com` 恢复，产出 3 人且 3/3 为 Impressum 决策人） |
| 公司级 GT 命中 | 10 / 15 | **11 / 15**（+`ando-technik.com`） |
| 人级 GT 召回（原 22 人 GT 集） | 14 / 22 | **17 / 22**（`ando-technik.com` 的 3 名决策人全部找回） |
| 新行中的误报 | 9 / 46（19.6%） | **1 / 13（7.7%）**：1 条垃圾社媒档案（headline 恰为公司名，绕过了同名守卫） |
| 存量误报行 | 9（3 同名 + 6 同名异公司，含 1 条公司当人） | 仍是 9（守卫只防新增，存量行未清理） |
| 有邮箱候选的联系人 | 4 / 46 | **53 / 59（≈90%）**；全部 RISKY、VALID 仍 0（catch-all 诚实上限，口径同 §7） |
| `pumpen-schmid.de` | 被 `GRANT_REUSED` 挡下、未评估 | **首次产出并命中 GT 决策人（1/1）**——`attemptId` 作用域键消除了该缺口 |

**修复验证**：

1. **#748 人员页回退成立**：`ando-technik.com` 从零产出恢复为 3 名 Impressum 决策人；`bridge-industry-
   consulting.de` 由 3 人扩到 9 人，新增 6 人均可在其团队页佐证（Backoffice/营销/财务等岗位）。
2. **#744 守卫成立（预防性）**：`bts-engineering.de` 与 `heide-pumpen.de` 本轮新增 0 人——第一轮的两类
   误报机制没有再增行；`bts` 的 6 条存量误报行尝试补邮箱时全部 `undeliverable_domain`（域名不可投递），
   不会进入外发。
3. **零产出残留 4 家**：`avag-pumpen.de` 的 Impressum 里仍有可达的 GT 决策人但未抓到，`ava-berlin.de`、
   `jaeckel-ohg.de`、`michalowski-gmbh.de` 无产出——入口发现/渲染盲区仍在，需要逐家排查（与第一轮结论一致）。

**本轮新发现（按优先级）**：

1. **学术称号导致同人去重失败**：同一人带 `Dipl.-Wirt.-Ing.` 前缀与不带前缀的两条记录各占一行
   （`trik-pumpen.de`，姓氏与职位一致）。姓名归一化应剥离德语学术称号（`Dr.`/`Dipl.-…`/`Prof.`）后再算
   `dedupeKey`，否则每次重抓都可能重复入库。
2. **社媒守卫仍有一类漏网**：垃圾/无关的 LinkedIn 个人档案，其 headline 字段恰等于公司名时满足
   「标题含公司佐证」，被收录（本轮 1 条）。可考虑要求「档案姓名与标题中的人员姓名一致」或「headline
   的公司名之外仍有职位词」，而不是仅字符串包含。
3. **存量误报行未清理**（第一轮 9 条）：守卫只防新增；需要一次性的存量清理/重识别路径，否则统计口径里
   永久背着 15% 的存量误报。

**成本**：本批 20 家 discover + 7 家 guess，按第一轮同口径（≈8¢/家）估算 ≈ $1.6–2.0；因 HTTP 路径不落
`tool_budget` 成本字段，未做逐笔复核。

**下一步建议**：① 修称号去重（引擎侧小改动，同一 PR 可加上述职位的守卫收紧）；② 存量误报清理方案；
③ 剩余 4 家零产出逐家排查；④ 邮箱维度维持「RISKY + 人工确认」外发口径。

## 10. 第四轮：修复后复测（2026-11-04，第十四班镜像 `8b142f53`，含 #760/#761）

**镜像与前置**：第十四班镜像 `8b142f53`（digest `e2cfa8cc…`），含 #760（零产出三类根因：robots 坏跳转、
原始 HTML 补抽门槛、尾斜杠规范化 + 首页兜底）与 #761（德语学术称号去重 + 社媒岗位词守卫）；`email_guess`
保持 ENABLED。方法与第三轮一致：同一 20 家 Golden Set、同一 GT，逐家
`POST /canonical-companies/:id/discover-contacts`（`attemptId` 作用域键；`lawfulBasis=legitimate_interest`），
缺邮箱联系人经 `guess-emails` 补全，产出经 `GET /canonical-companies/:id` 读取；采集窗口起点
`T0=2026-11-04T05:38:41Z`，新增行按 `createdAt > T0` 判定。**基线与中断**：第三轮清理后
（`_archive/m5-contact-cleanup-20261104/`，删 11 行）在库 48 行；采集进行到 05:56Z 时发布线把运行时切换到
第十六班镜像（`fb02916c`，含 5 个迁移），后 10 家的 discover 被 502 打断后在新镜像上补跑——两镜像间联系人
发现链路只新增 Q25 访问审计、无行为变化；零产出 4 家与 bts 守卫的全部观察都在 `8b142f53` 上完成。
评估仍只出聚合与域名计数，不含个人姓名。

**结果**：

| 指标 | 第三轮（fe0c7d71） | 第四轮（8b142f53；后 10 家 fb02916c） |
| --- | --- | --- |
| 引擎在库联系人总数（同 20 家） | 48（清理后） | **60**（+12 新行；无重复行） |
| 零产出公司 | 4 | **2**（`ava-berlin.de`、`abendi.de`） |
| 公司级 GT 命中（§2 口径，16 家） | 12/16（§9 的「11/15」按 15 家记；见下方订正） | **14/16** |
| 人级 GT 召回（22 人 GT 集） | 17/22 | **19/22** |
| 新行中的误报 | 1/13（7.7%） | **2/12（16.7%）**：2 条同名异公司 LinkedIn 档案 |
| 存量误报行 | 9（本轮前已清理） | **0**（旧 9 条均未复现，被守卫在源头丢弃） |
| 有邮箱候选的联系人 | 53/59（≈90%） | **58/60（96.7%）**；RISKY 57、INVALID 1、**VALID 0**（口径同 §7） |
| `trik-pumpen.de` 重复行 | 1 条（称号重复） | **0**（重抓并入原行，id 与 `createdAt` 未变） |

**修复验证**：

1. **#760 尾斜杠规范化 + 首页兜底成立（4 家零产出恢复 3 家）**：
   - `avag-pumpen.de`：恢复 1 人，即其 Impressum 具名决策人（GT 1/1）；证据页为
     `…/unternehmen/impressum/`（带尾斜杠）。
   - `michalowski-gmbh.de`：恢复 3 人（1 名 Impressum 决策人 + 2 名团队页成员，均在官网可佐证）；
     证据页含 `…/impressum/`（带尾斜杠）与团队子页。
   - `jaeckel-ohg.de`：恢复 6 人（含 2 名 geschäftsführender Gesellschafter），全部 6 人可在其首页佐证；
     证据页为首页 `https://jaeckel-ohg.de/`（首页兜底）。
   - `ava-berlin.de` 仍零产出（根因见「残留」2）。
2. **#761 称号去重成立**：`trik-pumpen.de` 重抓后仍为 1 行、0 新增，原行 id 与 `createdAt` 未变（并入而非重复）；
   全批 14 家有存量行的公司本轮重抓均 0 新增（ando/biergans/bridge/heide/mms/nodes/pt-naegel/pumatec/
   pumpen-dunkel/pumpen-schmid/rudolf-schabmueller/schmedding/trik/viptech），去重面整体成立。
3. **#761 岗位词守卫成立（部分）**：`bts-engineering.de` 第三轮被清理的 6 条垃圾社媒档案（1 条机构当人 +
   5 条无职位词）本轮只回来 2 条——1 条机构当人（`social_organisation_dropped`）与 3 条无职位词
   （`social_uninformative_dropped`）被源头丢弃。20 家诊断合计：namesake 丢弃 24、无信息丢弃 4、机构丢弃 1、
   社媒拉取 4（第三轮 7）、`social_circuit_open` 0（第三轮 5）。

**残留与新发现（按优先级）**：

1. **同名异公司仍漏 2 条（守卫语义上限）**：`bts-engineering.de` 的 2 条 LinkedIn 档案 headline 同时含
   真实职位词与「BTS Engineering」公司名，通过两层守卫，但实为美国同名结构工程公司（德方是泵店，两人
   姓名在德方官网不可见）。守卫只能证明「headline 里有职位 + 公司名」，区分不了同名实体；要归零需引入
   国家/域名级消歧（档案地域/行业信号，或要求公司名与域名同时匹配）。两条档案 **SMTP 探测均未落库**
   （attempted 2、persisted 0），不进入外发。
2. **残留零产出 2 家同根因（Impressum 路径非常规）**：`abendi.de` 与 `ava-berlin.de` 的 Impressum 位于
   `/info/impressum.html`、`/common/info/impressum.html`（Shopware/Siquando 结构），两站首页均有直链、
   robots 不拦，但引擎的页面选取未跟进该链接（`/impressum` 返回 404）。两家 Impressum 均有具名决策人
   （ava 为 2 名 Geschäftsleitung），建议页面选取覆盖嵌套 Impressum 链接（或按站内链接文本「Impressum」跟进）。
3. **GT 分母订正**：按 §2 口径（Impressum 具名 Geschäftsführer/Geschäftsleitung/Vertreten durch/Inhaber），
   `ava-berlin.de` 的 2 名 Geschäftsleitung 应计入 GT——GT 共 16 家/22 人，§3/§9 的「15 家」系算术笔误
   （人级分母 22 不受影响）。本轮统一按 16/22 口径把第三轮快照重放为 12/16、17/22（人级与 §9 一致）。

**耗时与成本**：20 家 discover 机器时间合计 ≈31 分钟（单家 49–129 秒，中位 ≈89 秒）；含两次外部栈中断
（第十六班切换 + 一次重启）的墙钟约 40 分钟。本轮窗口 `usage_ledger` 记 ai_tokens 295,071（第三轮首小时
≈206k，同量级）；HTTP 路径仍不落 `cost_usd`，按第三轮同口径（≈8¢/家）估算 ≈$1.6–2.0。

**下一步建议**：① 同名异公司消歧（bts 2 条残留，国家/域名级证据）；② 嵌套 Impressum 链接纳入页面选取
（abendi/ava 两家）；③ 存量误报清零后以「0 存量 + 新行误报率」为每轮复测口径（本轮 2/12）；④ 邮箱维度
维持「RISKY + 人工确认」外发口径。
