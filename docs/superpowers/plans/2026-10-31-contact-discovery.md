# 联系人挖掘（决策人 · 联系方式 · 职位）设计稿

> 生命周期：`APPROVED`
> 依据：D1–D8 已由产品负责人拍板（D1/D6/D7/D8 于 2026-10-31；D2–D5 于 2026-11-01，见 §八）；M1 #703、M2a #707 已合入 main，M2b #709 施工中。
> 调研依据：2026-10-31 实读代码与文档（`decision-maker-multi-source-spec.md`、`decision-maker-p0.4-mainchain-wiring-design.md`、`decision-maker-cross-source-identity-design.md`、`provider-registry.md`、`docs/status/current.md`）+ `global_dev` 只读计数。
> 目标：客户拿到的是**具体的人**（姓名 + 职位 + 部门/资历）、**可用且经验证的联系方式**（邮箱/电话/职业社交主页），而不是只有询盘表单。多源、可审计、合规。

## 一、现状（为什么现在挖不到人）

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 官网决策人抽取（Impressum/管理层/团队页 → 姓名+职务） | ✅ 已实现 | `providers/decision-maker.provider.ts`（crawl4ai.fetch + LLM 结构化抽取，robots 从严） |
| 注册处董事/高管 | ✅ 已实现：UK `companies_house`、FR `inpi_rne` | `providers/companies-house.provider.ts`、`inpi-rne.provider.ts` |
| 专利发明人 | ✅ 已实现（缓存），provider `google_patents` 默认 DISABLED | `providers/bigquery-patents.provider.ts` |
| 展会名录（含**公示的商务邮箱/电话**） | ✅ 已实现，provider `trade_fair` 默认 DISABLED | `providers/trade-fair.provider.ts`（Algolia） |
| 邮箱模式排列 + SMTP RCPT 验证 | ✅ 已实现（`smtp_self` ENABLED），`email_guess` DISABLED | `email-guesser.ts`、`email-verify.provider.ts` |
| 跨源身份解析（防重复/防张冠李戴） | ✅ 已实现（四级 Tier + 邮箱冲突守卫 + 合并留痕） | `person-identity.ts` |
| **run 内自动挖人** | ❌ **发现 run 五个阶段（判站→画像→fit→信号→评分）没有任何一步调用联系人发现** | `discovery.workflow.ts`/`activities.ts` |
| 存量 sweep 里的联系人阶段 | ✅ 存在（阶段⑤ `discoverContactsBacklog`、⑤b `guessEmailsBacklog`） | `backlog.workflow.ts` |
| 社媒/渠道源 | ❌ 无适配器（`directory.provider` 反而把 linkedin/xing/facebook 等域名**排除**，防止当公司官网） | `directory.provider.ts` |
| 前端入口 | ❌ gain-saas BFF/UI 未暴露 `discover-contacts`/`guess-emails`/`verify` | gain-saas `apps/server/src/bff/routes.ts` |
| 数据结果 | `canonical_contact` 0 行、`contact_point` 0 行；只有 136 行公司级联系路径 | `global_dev` 只读计数（2026-10-30） |

一句话：**零件都在，三个开关和一条接线没接**——run 不调用、社媒源不存在、前端无入口；`email_guess`/`trade_fair` 还处于默认关闭。

## 二、合规边界（先定边，再谈渠道）

沿用 `decision-maker-multi-source-spec.md` §1 的红线，并针对「社媒」补充落地口径：

| 分级 | 做法 | 说明 |
| --- | --- | --- |
| 🟢 直采 | 官网、注册处、专利、展会公示、招聘页、行业协会/名录的**公开页面** | crawl4ai 本地抓取；robots 从严；source_policy 白名单 |
| 🟡 **只读公开索引** | LinkedIn / Xing / Facebook / Instagram / YouTube / X 的**人**信息，只经搜索引擎已索引的公开片段（SearXNG），或企业主页“About/Impressum”公开页 | **不登录、不带 Cookie、不逆向 API、不绕验证码**；每条都记 `field_evidence`（source URL + license + time） |
| 🔴 不做 | 直爬 LinkedIn 个人主页/登录墙后内容、买 Apollo/Hunter/ZoomInfo 类私库、SMTP 投递 DATA、绕过任何访问控制 | 一次 GDPR 罚款比十条线索更贵——这是差异化而不是短板 |

**需要你拍板的合规口径**：社媒人是否只走「公开索引片段」？如果要求直接抓 LinkedIn 个人页，需要另行评估 ToS/法律风险（我的建议：只走公开索引与公开企业页，见 §八 决策 D1）。

## 三、目标数据模型（复用现有，零迁移优先）

已有 `canonical_contact`（person，密文/PII 隔离）、`contact_point`（email/phone/url，带状态 VALID/UNVERIFIED/RISKY）、`field_evidence`（每条事实的来源/许可/时间/有效期）、`resolvePersonIdentity`（跨源合并）。设计沿用，**不新增表**：

- 人物事实：`fullName/title/department/seniority/buyingRole` 落 `canonical_contact` 字段 + `attributes` jsonb 存社媒句柄与外部标识（`{"linkedin":"…","xing":"…","github":"…","externalIds":[…]}`）。
- 联系方式：`contact_point.type ∈ {email, phone, linkedin, profile_url}`；邮箱状态沿用 `VALID / RISKY / PROBABLE / UNVERIFIED`（SMTP 验不出的一律降级，不谎报）。
- 证据：每条人物与联系方式各一条 `field_evidence`（`sourceUrl`、`providerKey`、`observedAt`、`freshUntil`）。
- 合并留痕：沿用 `identity.merge` 证据 + 邮箱冲突守卫。

## 四、数据源矩阵（身份 × 联系方式）

### 4.1 身份（WHO：姓名 + 职位 + 部门）

| # | 来源 / 渠道 | 做法（工具） | 落地成本 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 官网 Impressum / 管理层 / 团队页 | `crawl4ai.fetch` + `contact.find_decision_makers` 任务 | 已有 | ✅ |
| 2 | UK Companies House officers / FR INPI RNE dirigeants | 官方免费 API（ToolBroker 收编） | 已有 | ✅ |
| 3 | 专利发明人 | PatentsView/EPO（现有缓存） | 已有；需开 provider | ✅/默认关 |
| 4 | **展会参展商名录**（公示的商务联系人与邮箱） | Algolia 源（现有 `trade_fair`） | 已有；需按 ICP 开 provider | ✅/默认关 |
| 5 | **职业社交（LinkedIn / Xing）** | `searxng.search` 定向 dork（`site:linkedin.com/in "<公司>" "<职务词>"`、`site:xing.com/profile`），只读索引片段 → LLM 抽姓名/职务 | 新适配器 | ⬜ |
| 6 | **招聘页 / ATS**（常直接写招聘负责人/团队联系人） | 官网 careers + Greenhouse/Lever/Personio 公开接口；crawl4ai | 新适配器（低成本、合规绿） | ⬜ |
| 7 | **新闻稿 / PR**（具名高管与职务） | GDELT DOC 2.0（免费无 key）+ `searxng.search` news | 新适配器 | ⬜ |
| 8 | **行业协会 / 行业名录**（理事、会员代表、销售联系人） | 协会官网名录、Europages、WLW（wer liefert was）、Kompass 公开页；crawl4ai | 新适配器 | ⬜ |
| 9 | **企业社媒主页**（Facebook/Instagram/YouTube “About”） | 公开页 fetch（常含联系方式/团队）；遇登录墙即放弃 | 新适配器（与 5 同一适配器） | ⬜ |
| 10 | 技术社区（GitHub org 成员、会议论文作者） | GitHub 公开 API / 会议站点 | 低优先 | ⬜ |
| 11 | DE Handelsregister / OffeneRegister | 自动化受限（灰）→ 先做人工可点链接，不做自动抓 | 低优先 | ⬜ |

### 4.2 联系方式（HOW：邮箱 / 电话 / 主页）

| 方式 | 做法 | 合规 | 现状 |
| --- | --- | --- | --- |
| A 页面直抽 | Impressum/团队/展会页明确写出的具名邮箱、电话 | 🟢 | ✅ |
| B 邮箱模式排列 + SMTP RCPT 验证 | 姓名+域名 → 排列 → `smtp_self` 验；只握手不投递 | 🟡 | ✅ 引擎就绪，`email_guess` 默认 DISABLED |
| C 公司邮箱格式学习 | 从该公司已知具名邮箱反推格式再套用 | 🟡 | ✅ 已实现 |
| D 社媒主页上的公开联系方式 | 企业页 About/Impressum 上的邮箱/电话 | 🟢 | ⬜（并入 §4.1 适配器） |
| E 新闻/专利/商标文件中带出的邮箱 | 从来源文件抽 | 🟢🟡 | ⬜ |

**诚实天花板**：Gmail/M365 反枚举、30–40% catch-all 域无法确认真伪 → 这类一律标 `RISKY/PROBABLE`，不谎报 VALID；大企业命中率显著低于中小企业。

## 五、架构与挂点

### 5.1 挂点一：发现 run 内（主诉求）

在 `discoveryWorkflow` 的信号阶段之后、物化之前加**联系人阶段**（新活动 `discoverRunContacts`）：

- **对象**：本次 run 的公司中 `fit=match` 或已进 recommended 的 **Top N（默认 8）**——联系人是高成本步骤，先给最可能交付的线索。
- **顺序**：官网 `decision_maker` → 注册处（按国家）→ 展会（按 ICP 行业）→ 社媒/渠道适配器（新）→（可选）邮箱猜测。
- **预算**：每家公司 ≤6 页面抓取、≤1 次 LLM 抽人调用；整阶段受执行预算账本约束；超时继续（best-effort，不阻断评分）。
- **idempotent**：走 `persistDiscoveredContacts`（含 `resolvePersonIdentity` 合并与证据），重复 run 不产生重复人。
- **stats**：`contacts:{companies, people, emails, phones, social}` 计入 run 统计与报告。

### 5.2 挂点二：存量 sweep（补漏）

已有阶段⑤/⑤b 不动，新适配器**注册进同一 `ContactDiscoveryAdapter` 注册表**即自动被 sweep 使用；同时把 `email_guess` 的双闸（kill-switch + lawfulBasis）保持默认关。

### 5.3 新适配器：`social_presence`

一个适配器覆盖「社媒 + 渠道」，内部按可用性降级：

```
输入：公司（名/域名/国家）+ 已知社媒链接（website_profile 的 linkedinCompanyPage、digital_footprint 的 sameAs）
步骤：
1) 公开企业页：crawl4ai.fetch（Facebook/Instagram/YouTube About、公司 LinkedIn 公开页）→ LLM 抽人/联系方式；遇登录墙/验证码立即放弃该源。
2) 搜索索引片段：searxng.search 定向 dork（site:linkedin.com/in、site:xing.com/profile、site:facebook.com）→ 只取标题+摘要 → LLM 抽人；证据标 `indexed_snippet`。
3) 招聘/ATS：careers 页面 + Greenhouse/Lever/Personio 公开 API → LLM 抽招聘负责人。
4) 每源独立限流与超时；任何一源失败不影响其它源。
输出：ContactDiscoveryResult（people[]，每人带 sourceUrl/sourceKind/observedAt）
```

### 5.3b 社媒个人页抓取的具体做法（2026-10-31 追加，回应「用本地爬取工具直接爬」）

本地 crawl4ai（`global-crawl4ai`，0.9.1，带浏览器池）确实能抓公开页。按「先不碰对方服务器、再公开页直抓、最后搜索引擎」三层降级，既拿到数据又把风险压在最低：

| 层 | 做法 | 工具 | 合规与命中 |
| --- | --- | --- | --- |
| L1 档案副本 | 从 **Wayback Machine CDX API**（`web.archive.org/cdx/search/cdx`，免费）与 **Common Crawl 索引**（`index.commoncrawl.org` + WARC 段，免费）取公开个人页的历史归档副本 | `http-get/v1` | 🟢 读的是公共档案，不触发目标站反爬、不影响出口 IP；命中率中（LinkedIn/Xing 公开页多被收录） |
| L2 公开页直抓 | crawl4ai 直接 `GET` 无需登录的个人页（`linkedin.com/in/*`、`xing.com/profile/*`、Facebook/Instagram/YouTube 公开页）；每域名 ≤1 req/3s，连续 3 次 403/999/登录墙即**熔断**并计入 stats | `crawl4ai.fetch` + 浏览器渲染 | 🟡 依产品负责人决定执行（ToS 风险自担）；LinkedIn 多数会返回登录墙，Xing 命中较高 |
| L3 搜索索引 | `searxng.search` 定向 dork（`site:linkedin.com/in "公司" "采购"`），读标题+摘要 | `searxng.search` | 🟢 只读索引片段 |
| L4 官方/半官方公开 API | GitHub 公开 API、Greenhouse/Lever/Personio 招聘接口、GDELT、Companies House/INPI | ToolBroker 收编 | 🟢 结构化、稳定 |

要点：
- **L1 优先**：很多小公司决策人在 LinkedIn/Xing 的公开页已进入 Common Crawl/Wayback；抓档案既拿得到内容，又避免被目标站封禁（也保护 xin 的共享出口 IP）。
- L2 只是补充，且**永不**登录、不绕验证码、不用账号池/换 IP 规避；被拒就停。
- 所有来源都写 `field_evidence`（`sourceUrl`、`observedAt`、`sourceKind ∈ {archive, live_page, serp_snippet, official_api}`），档案副本标 `freshness=archived`，前端展示时区分「现职证据」与「历史档案」。
- 人物合并仍走 `resolvePersonIdentity`（Tier 0 externalId 可放 LinkedIn 公开 slug/URL 作为弱标识，仅作 Tier 2/3 辅助，不单独作精确键）。

**「避免问题」的其他替代路线**（不依赖社媒也能拿到具名联系人）：
1. **展会名录**（已有，Algolia API）——常直接带**具名商务联系人 + 公示邮箱/电话**，DACH 工业展覆盖高，性价比第一；
2. **公司域名邮箱模式 + SMTP 验证**（已有）——对公司已知人补出可用邮箱，命中率高于社媒；
3. **招聘页/ATS**——招聘广告常署名招聘经理/团队负责人；
4. **新闻稿/PR（GDELT）**——具名高管与职务；
5. **注册处与专利**（已有）——法定董事/发明人；
6. **行业协会/名录（Europages、WLW、Kompass）**——中小企业常在名录页公示联系人。

### 5.3c 开源项目融合（2026-10-31 产品负责人同意「不重复造轮子」）

原则：**能包成工具的就不重写爬虫**；所有 OSS 以**独立容器进程**接入 ToolBroker（限速、source_policy、预算、证据留痕都由闸门统一管）。

| 项目 | 许可证（需复核） | 用途 | 接法 | 产出归一 |
| --- | --- | --- | --- | --- |
| theHarvester | GPL-2.0（进程隔离调用，注意分发边界） | 搜索引擎/PGP/证书挖邮箱、主机、员工名 | 新工具 `harvester.search`（docker sidecar，只读网络） | `{emails, hosts, names}` → 联系人/公司事实 |
| social-analyzer（或 Maigret） | MIT（复核） | 域名/用户名 → 数百平台主页 URL | 新工具 `social.discover`（sidecar） | profile URL 列表 → 喂现有解析层（L1/L2/L3） |
| JobSpy | MIT（复核） | 招聘板职位与招聘方 | 新工具 `jobs.search` | 职位里的联系人/部门 |
| Trafilatura | Apache-2.0（复核） | 网页正文清洗 | 内置到抓取管线（或 sidecar） | 干净文本 → LLM 抽人 |
| Common Crawl / Wayback CDX | 数据许可（公共档案） | 社媒公开页档案副本 | 现有 `http-get/v1` | 页面快照 → 解析 |

接入规范（每个 OSS 工具都要满足）：
1. **容器化**：独立 image、只读根文件系统、CPU/内存上限、无宿主挂载、只出网到白名单；健康检查失败自动停用该工具（fail-safe，不影响其它源）。
2. **闸门化**：所有出网经 ToolBroker（source_policy 登记域名 + 用途门 discovery/enrichment + 预算 reserve-settle + 限速），adapter 不允许直连。
3. **归一化**：工具输出映射为 `ProviderContactRecord`/`field_evidence`，保留 `sourceKind`（harvester/social_index/jobs/archive/live_page）与原始 URL。
4. **许可证审查**：GPL 类只做**独立进程 CLI 调用**（不链接、不分发到主镜像），MIT/Apache 可直接 sidecar；上线前在 `SECRETS-INVENTORY` 与 `docs/backend/oss-registry.md` 登记版本与许可证。
5. **可替换**：适配器接口不变，底层工具可换实现（如 Maigret 替换 social-analyzer）。

融合顺序：**theHarvester + social-analyzer** 先行（补「社媒主页 + 邮箱」两块，M2b），JobSpy 次之（招聘渠道），Trafilatura 作为抽取出网后的公共清洗件。

### 5.3d 合规与预算的两项结构性改进（2026-10-31 产品负责人同意）

- **per-tenant LIA 采集页（gain-saas）**：前端「数据处理声明」页按租户收集 lawful basis 引用，写入该 workspace 的配置；后端 `decision_maker`/`email_guess` 的 basis 来源从「全局 interim」切换为 **per-tenant**。多租户上线前必须完成；在此之前自动路径保持 fail-closed（或按 D16 显式开关，留痕「无依据」）。
- **联系人阶段独立预算账户**：联系人发现（含 M2 社媒/邮箱）使用**单独的预算账户**（scope=contact.discovery，按 run 派生），撞自己的上限即停，不挤占 run 的查询/画像/评分额度；上限 = 每轮公司数 × 单家上限（动态计算，不写死金额），实际花费仍按用量结算。

### 5.4 前端（gain-saas）

- BFF 增加三条路由（已有引擎端点）：`POST /canonical-companies/:id/discover-contacts`、`POST …/guess-emails`、`POST /contact-points/:id/verify`（写路由走预算 Grant 语义）。
- UI：线索详情/公司档案增加「决策人」卡片（姓名/职位/部门/邮箱状态徽标/来源链接/证据时间），支持「发现联系人」「验证邮箱」按钮；`RISKY/PROBABLE` 明确标注，不伪装确定。
- 周报 CSV 的「联系路径」列升级为「联系人 + 联系方式 + 状态」。

## 六、成本与限流（估算）

| 项 | 单位成本 | 备注 |
| --- | --- | --- |
| crawl4ai / SearXNG | 本地免费 | 只算电与延迟 |
| LLM 抽人 | 每次调用 ~0.1–0.5 美分（gemini-3.8-flash） | 每公司 ≤2 次 |
| SMTP 验证 | 本地，免费 | 每公司 ≤6 探测；仅在你批准启用后 |
| 单 run（8 家公司） | 估 $0.1–0.5 | 入口/出口各一次即可 |

## 七、分阶段落地

| 阶段 | 内容 | 交付物 | 依赖 |
| --- | --- | --- | --- |
| **M1** | run 内接线（复用现有三个适配器：官网/注册处/展会），Top N=8，证据与统计 | 一个引擎 PR | 你批准本设计；`trade_fair`/`google_patents` 是否按 ICP 启用的决定 |
| **M2** | `social_presence` 适配器（社媒索引片段 + 企业社媒公开页 + 招聘/ATS） | 一个引擎 PR | D1（社媒口径）拍板 |
| **M3** | 邮箱补全启用：`email_guess` 双闸打开 + 格式学习验证 + 前端「验证邮箱」 | 引擎+gain-saas PR | 你的启用决定 + per-tenant LIA（多租户前） |
| **M4** | gain-saas 决策人卡片与三个操作入口 | gain-saas PR | M1/M2 上线 |
| **M5** | 质量评估：Golden Set（20 家已知公司）测「人命中率/邮箱命中率/误报率」 | 评估报告 | M1–M4 |

## 八、需要你拍板的决策

- **D1 社媒口径（2026-10-31 产品负责人拍板：直爬个人页）**：允许对 **无需登录即可访问的公开个人页** 发起直接抓取（LinkedIn `in/*`、Xing `profile/*` 等），不再局限于搜索引擎索引片段。随之明确三条边界并写入实现：①**仍不做**登录墙后内容、验证码绕过、账号池/轮换代理伪装、逆向其 API（这些不是「直爬公开页」，而是规避访问控制）；②本仓 spec 原「robots 从严」红线就此**由产品负责人显式改写**为「站点 robots 允许才抓；LinkedIn/Xing 属负责人已接受例外的域名，抓取失败或 999/403 即停，不重试不换 IP」——这条覆盖需同步到 `decision-maker-multi-source-spec.md`；③风险接受：LinkedIn ToS 违约与 IP 声誉风险由产品负责人承担；抓取端每域名限速（≤1 req/3s）、连续 3 次被拒即熔断并计入 run 统计。**共享主机提示**：xin 上还有其他项目共用出口，若该出口 IP 被 LinkedIn 拉黑将影响全机——熔断阈值与只读公开页是为此设的边界。
- **D2 展会与专利源（2026-11-01 产品负责人拍板：同意）**：按 ICP 行业自动启用 `trade_fair`、`google_patents`（展会名录带**公示邮箱/电话**，性价比最高）。
- **D3 邮箱补全（2026-11-01 产品负责人拍板）**：`email_guess`（SMTP 只握手）在 **M3 阶段**启用；多租户前**接受全局 interim LIA** 口径（11-01 已写入 `decision_maker` 配置，ref=`OWNER-DECISION-2026-10-11`，D6 落地后换 per-tenant）。
- **D4 覆盖范围（2026-11-01 产品负责人拍板：同意）**：第一批渠道优先级按「官网 → 注册处 → 展会 → 社媒索引 → 招聘/ATS → 新闻/协会」。
- **D5 成本上限（2026-11-01 产品负责人拍板：同意）**：单 run 联系人阶段预算上限 $0.5，每家抓取页数 ≤6。

**追加决策（2026-10-31 已拍板）**：D6 per-tenant LIA 采集页按 §5.3d 实施；D7 联系人阶段独立预算账户按 §5.3d 实施；D8 OSS 融合按 §5.3c（theHarvester + social-analyzer 先行，JobSpy 次之，Trafilatura 作清洗件），每项接入前做许可证与安全复核。

## 九、验收标准

- 一次真实 run：≥8 家公司被联系人阶段覆盖；≥50% 公司至少 1 名具名决策人（官网+注册处+展会口径）；所有人与联系方式均有 `field_evidence`（来源/时间/许可）。
- 邮箱：直抽 + （启用后）猜测验证的分布如实记录；`RISKY/PROBABLE` 不进入 `VALID`。
- 同一人跨源出现只保留一条（`resolvePersonIdentity` 合并证据可见）。
- 前端可看到人卡并可触发发现/验证；周报 CSV 含联系人与状态。
- 合规：`personalData=true` 全链路；suppression 阻断生效；DSR 删除可定位到 person-level。

## 十、明确不做

- 不买私库、不绕任何访问控制（登录墙/验证码/账号池/换 IP）、SMTP 不投递。社媒公开个人页按 D1 执行：档案副本优先，直抓仅限无需登录的公开页，被拒（999/403/登录墙）即停。
- 不做个人手机号的「猜号」（SIM 段推断属高风险，不做）。
- 不把联系人塞进公司级 reachability 分数（评分口径另行评估，避免联系人质量污染推荐）。
