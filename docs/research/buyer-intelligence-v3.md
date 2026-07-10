> 【定位 2026-07-10】本文件是 v3.0 买家智能**研究报告**（Research/RFC），正文多处被 §10 对抗核验修正——凡冲突以 §10 为准；不可平铺当最终需求。落地状态见 [../status/current.md](../status/current.md)。

# 买家智能与决策人触达层（v3.0）：从「公司名单」到「可成单线索」

> 设计文档。研究结论（2025-2026 现状）+ 落地设计。**免费优先**：凡付费源，给出免费/绕付费的技术手段，或诚实标注「确无免费路径」+ 开源自建替代。
> 主用户场景：**中国制造业工厂/外贸企业找海外买家并成单**（platform 是「出海企业增长后端」）。
> 每条研究结论过一遍对抗式核验（专门枪毙「声称免费其实付费/ToS 禁止」）。真实 URL 内联。
> 关联：[discovery-sources.md](discovery-sources.md)（多源蓝图，本文更新其「海关公司级只能付费」旧结论）· [discovery-architecture.md](discovery-architecture.md)（四层/ToolBroker）· [roadmap-ai-acquisition.md](roadmap-ai-acquisition.md)（六维评分）。

## 0. 核心反转：一行 `info@` + 总机号 ≠ 线索

展会/名录给的是**公司存在**的最弱证据。真正成单需要三样现有管线还没产出的东西：

| 缺环 | 现状 | 本文要补 |
|---|---|---|
| **① 谁在买（需求证据）** | 只知「谁存在」（展会/名录/Wikidata） | 海关提单反查「谁在进口我的品类、从谁进（=竞品）、量/频次/趋势」= 需求证据 + 置换目标 |
| **② 对的人（可达决策人）** | 只有 `info@` + 总机；决策人抽取仅 Impressum | 决策人身份（LinkedIn 公开档/专利/新闻）+ **自建邮箱验证管线** + 分渠道触达 |
| **③ 现在就要（时机）** | 静态画像；`⬜ 真实意向信号源`（roadmap 明标未做） | 招聘/招投标/扩产新闻/网站变更/在投广告 → intent 事件 → 六维 Intent 维 |

**这不是从零造。** 一大半能力复用**已建好的基建**（见 §1）。**且几乎全部零付费**——付费源都有免费公开（FOIA/开放数据）通道或开源自建替代（见 §7）。

---

## 1. 复用现有基建 → 解锁买家智能（最关键的工程洞察）

| 已有组件（已跑通） | 换个用法 → 解锁的情报能力 |
|---|---|
| **内容哈希增量 diff**（`source_entity_change`） | 盯目标公司**产品页/招聘页/「求供应商」页** → 变更即发 **intent 事件**（新产线/在招 sourcing/新 RFQ） |
| **首见检测**（acquisition `ADDED`） | 海关流里**首次进口某 HS 的公司** = 新入场买家 = 高意向，同一套 first-seen |
| **pgvector 0.8.x**（已装 pgvector/pg16 镜像，含 HNSW/halfvec/iterative_scan） | ① 成单客户 embedding → 最近邻 = **look-alike 找孪生买家**；② 模糊去重（含 WHERE 过滤下保召回） |
| **name-match.ts**（0.72 门槛 + 歧义边距） | 脏 consignee 名（`SHENZHEN ABC CO LTD`）↔ `canonical_company` **实体解析**终裁纪律，防贴错 |
| **Temporal Schedule**（本轮已建） | 分级信号监控：海关周级、招聘/新闻日级、广告库月级 |
| **crawl4ai `capture_network_requests`**（逆向展会 API 用的） | 泛化成「任意 SPA 目录 URL → 逆向后端 JSON API → 自动生成 adapter」的**平台能力** |
| **ToolBroker**（白名单 + 预算 reserve-settle + 限流 + source_policy + 幂等 + trace） | 付费/受限源的**配额闸门**，逆向与直连都在闸门内 |
| **Outbox 领域事件** | 新信号到达 → **事件驱动重评分**（非定时全量重算） |
| **field_evidence**（`allowed_actions` + `license`） | 字段级权限引擎 → 合规「可发送性」编译产物直接写这里，无需新表 |
| **SuppressionRecord** | 对外动作第一道闸 → 承接 GDPR Art.21 反对 / CASL 撤回 |

> **P0 的最强建议**：先把已有基建的复用价值榨干（数字足迹富集、结构化收割、网站变更 intent、自建邮箱验证），便宜、可控、马上能验证——再谈接外部源。

---

## 2. 能力域 A —— 买家发现（需求证据，不是「谁存在」）

### A1. 海关提单 / 公司级贸易数据 —— **免费公开通道存在**（更新旧结论）
`discovery-sources.md` 旧结论：公司级只能付费 reseller。**更新**：美线海运有免费公开（FOIA）通道。

- **[ImportYeti](https://www.importyeti.com/faqs)**：经 FOIA 拿到 US Customs **2015 至今全部海运提单**，**免费在线**——按 consignee（美国买家）/shipper（中国工厂）/产品/HS 搜、完整出货时间线、逐单钻取、导出基础数据；有 **BETA API**（`data.importyeti.com`）。法定公开（19 USC 1431，CBP vessel manifest/AMS）。
  - 🟢 免费：按公司名反查、看一家的供应商/客户、时间线。🔴 付费（custom plan）：**按 HS 大批量反查** + power query + 批量下载 CSV。**技术绕法**：免费按公司迭代 + BETA API + 我们自己的落库累积；至规模化 HS 反查时才评估付费插槽。
  - ⚠️ 覆盖仅**美线海运**（无空运/陆运）；`shipper` 侧对中国工厂=看竞品在给谁供货。
- 付费 only（诚实）：Panjiva/ImportGenius/Volza/Tendata（多国 + 空运 + 清洗）——留 `data_provider class='trade_data'` 契约插槽，不默认接。
- **技术机制（复用基建，这才是价值）**：
  1. **进口节奏建模**——consignee 出货时间戳序列 → 推算复购周期 → **预测下次下单窗口**（时机分）。
  2. **供应商切换检测**——`consignee→shipper` 边随时间变化，主供应商掉了 = 切换进行中 = 烫手线索（图边变化检测）。
  3. **首次进口检测**——复用 acquisition 的 `ADDED`/first-seen：某 consignee 首次进口该 HS = 新入场买家。
  4. **竞争置换**——反查买竞品的 consignee = 直接目标名单（见 §5）。
- **落地**：新 `trade_data` SourceClass ProviderAdapter，ToolBroker 闸门内；consignee → `name-match` 链接 canonical_company；信号写 `attributes.customs.*`（不建 canonical）。合规：公司级贸易事实 🟢，但**再分发**受限（法定公开≠可自由转售）——只内部用于打分/线索，不对外售卖原始提单。

### A2. 国家级贸易统计 —— 全免费官方（市场/HS 优先级，**无公司名**）
- **[UN Comtrade API](https://comtrade.un.org/data/doc/api/)**：免费 key = 500 calls/day、100K records/call；国家×HS 进出口额。
- **US Census International Trade API**：官方免费，进出口 by HS×国家×港口，月度 2013 至今。
- **Eurostat Comext**：欧盟 CN8 级免费。
- **用途**：算「国家×HS 优先级分」喂 ICP（哪个市场进口我的品类多且增长）——**上下文层**，非买家名单。写 `attributes` + ICP 国家权重。

### A3. 隐藏 API 逆向 + 结构化数据收割 —— 通用免费抓取技术
**对抗核验的反直觉结论**：我们最先啃的「隐藏 JSON API 逆向」其实是 5 种里唯一 🟡（直连未文档化端点撞 ToS，同 Algolia public-key §4.5(h) 判断）；**schema.org/JSON-LD、sitemap、RSS 是 🟢**——发布者主动供机器消费，更干净、更省力，**应优先做**。

| 技术 | 分级 | 说明 |
|---|---|---|
| schema.org/JSON-LD/microdata（`extruct` 开源自托管） | 🟢 | Web Data Commons 2024-10：**51% 网页含结构化数据、注解站 70% 用 JSON-LD**（~1150 万站）。公司亲手把 Organization/Product/**JobPosting** 结构化递给你——省 LLM token、少贴错身份、**JobPosting=免费招聘信号** |
| sitemap.xml 枚举 | 🟢 | 协议化公开，robots.txt 主动广告其位置（明示邀请） |
| RSS/Atom | 🟢 | 为聚合而生的 opt-in feed（新闻/PR/招聘） |
| GraphQL introspection（开启时） | 🟡 | 免费完整 schema dump；被关闭的**不做**（撞「不绕访问控制」红线，仅留插槽） |
| 隐藏 JSON API 逆向（crawl4ai 抓包） | 🟡 | 泛化 Algolia/MapYourShow 打法；无鉴权公开 JSON 端点。法律面 [Meta v Bright Data 2024](https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn) + hiQ 在我方一侧（未登录抓公开数据难被 CFAA/ToS 定罪）；仍守 robots + 不绕验证码/Cloudflare（那需买代理，踩红线，换 sitemap/RSS/JSON-LD 通常拿同一批数据） |

**落地**：ToolBroker 内跑 crawl4ai `capture_network_requests` → 过滤 `event_type=response & resource_type∈{xhr,fetch} & content-type=json` 的端点 → 导出「端点契约」（url 模板 + headers + 分页）→ codegen 一个 `MonitoredSourceAdapter`（与 `trade-fair-algolia.ts`/`mapyourshow.source.ts` 同形）。

### A4. 网络规模语料 + 图挖掘（免费）—— **独家杀手锏**
- **[Common Crawl](https://commoncrawl.org/)**：匿名 HTTPS（`data.commoncrawl.org`）**无需 AWS 账号、无 key、零成本**。
  - **列式 URL 索引**（Parquet）：用**本地 DuckDB httpfs 谓词下推**（不用 Athena 的 pay-per-query）按 `url_host_tld IN(目标国) AND 域名命中行业 dork AND content_language` → 全网候选域名 → 注入现有 discovery fan-out。
  - **域级网页图（hyperlinkgraph）**：**edges = 谁链谁 = 经销/分销/OEM 网络**——别处免费拿不到，直接服务「工厂找海外分销/找现有分销盲区」。⚠️ 匿名 S3 官方将关，建在 HTTPS/CloudFront 上。
- **[GLEIF Level-2 关系图](https://www.gleif.org/)**：CC0 可商用/再分发/免署名，Golden Copy 无鉴权日更 3 次 + delta。母子/集团图 → account-based 定位（已在用，扩到集团级）。
- **[Wikidata/DBpedia](https://query.wikidata.org/)**：CC0，供应链-所有权-产品图。
- **付费 only（诚实）**：[OpenCorporates](https://opencorporates.com/) 对商用**无免费路径**（其免费仅限记者/NGO/学术的 Public Benefit 计划，我们不符资格；自助 API £2,250–£12,000/年）。**开源替代=绕聚合器直吃上游**：UK Companies House（免费 API + 免费 bulk）、EU BRIS/e-Justice、US 各州 SoS、印度 MCA + GLEIF(CC0) + OpenSanctions bulk。

### A5. B2B 平台 inbound RFQ（询盘意图）
Alibaba/Made-in-China/Global Sources/ThomasNet 的公开询盘/RFQ = 主动需求。免费可见范围有限、ToS 各异 → 谨慎，做 🟡 契约插槽 + 只取公开可见。

---

## 3. 能力域 B —— 决策人触达（对的人 + 可达渠道）

### B1. 决策人身份发现（免费/自建，不买 Hunter/Apollo/Sales Nav）
按产品类型定**买家委员会**目标 title：采购/Sourcing、供应链、品类经理、**产品/工程（OEM 零件）**、Owner/GM（SME）。免费找具名人：
- **LinkedIn 公开档 Google/Bing dork**：`site:linkedin.com/in "Procurement Manager" "CompanyX"` → 名 + title（公开）。⚠️ 直采禁止；只取搜索引擎已索引的公开片段，或交 SaaS 前端用户手动（合规路径）。
- **专利发明人**（EPO OPS / USPTO 免费）、**新闻稿/PR 具名**、**会议演讲者名单**、**Impressum/团队页 NLP**（已有 `decision-maker.provider.ts`，德国 §5 DDG 依法公示总经理=合规金矿）。
- 具名人一律 `personalData=true` 🔴 → 下游合规门（§6）。

### B2. **自建邮箱管线**（排列 + 验证，零付费）
1. **模式排列**：从已知样本推 `first.last@ / f.last@ / first@ …`。
2. **MX 查询**（免费无限）→ **SMTP RCPT-TO 握手自校验**（不发信）→ **catch-all 检测**（探测随机地址是否也「接受」）→ 置信打分。
3. 写 `contact_point`（type=email，状态 `UNVERIFIED→VALID/RISKY/INVALID`，schema 已支持）。
- **替代**：ZeroBounce/NeverBounce 付费 → 上面 MX+SMTP 自建完全覆盖（注意部分邮服 greylisting/catch-all，标 RISKY 而非误杀）。

### B3. 分地域渠道（按买家地理选）
LinkedIn（全球 B2B）、**WhatsApp（拉美/中东/印度/东南亚主导**，WhatsApp Business 云 API 官方合规发起）、微信（中国）、Line（日/台）、KakaoTalk（韩）、Facebook（新兴市场 SMB 老板）、Instagram（品牌/零售买家）。`contact_point.type` 扩 `whatsapp|wechat` 等；渠道句柄同样走验证生命周期。

---

## 4. 能力域 C —— 意图与时机（现在就要）+ 数字足迹

### C1. 数字足迹指纹（**最干净的一层**：全 🟢 公司事实，大半零边际成本）
新 `digital-footprint.provider.ts`（signal 源，fit 门后对有官网的 match 公司跑，**只写 `attributes`**）：

| 信号 | 免费方式 | 价值 |
|---|---|---|
| 技术栈 | 自托管 **wappalyzergo（MIT 引擎）+ enthec/webappanalyzer（GPL-3 指纹 JSON，当数据文件用不触发 copyleft）** | 电商平台=在线卖货；ERP 线索 |
| **在投广告** | HTML 解析 Meta Pixel/Google Ads gtag + **[Meta Ad Library API](https://www.facebook.com/ads/library/api)（免费官方）** | **装了像素/在投广告=活跃需求**（最高 ROI，几乎白得） |
| 邮件商 | MX 记录（免费） | 规模/成熟度 + 定验邮箱策略 |
| 域名族 | **[crt.sh](https://crt.sh/) 证书透明**（+CertSpotter/Censys 免费层 fallback） | 扩子域/关联品牌 |
| 建站年 | **RDAP**（免费结构化，取代 WHOIS） | 公司/域年龄 |
| 服务哪些市场 | 货币/语言选择器 + `hreflang`（复用已抓 HTML） | 目标市场判断 |
> 大半信号从 discovery/enrich **已抓的 HTML+响应头**直接解析，不新增抓取。**BuiltWith 的「技术首见历史」付费独有 → 用我们 `source_entity_change` diff 自建每家技术栈首见/变更时间线。**

### C2. 意图/时机信号（全免费源 → 六维 Intent/timing 分）
- **招聘**：公司**自有 career 页**抽岗位（禁聚合站）；JobPosting JSON-LD（§A3）免费拿。岗位=新产线/扩产/在建采购团队。
- **政府招投标**（免费官方 API，按 CPV/NAICS 反查需求方）：**[EU TED](https://ted.europa.eu/)**（全免费匿名 API + bulk）、**US SAM.gov**（免费 api.data.gov key）、UNGM、各国 e-procurement。
- **扩产/建厂/融资/新品/新认证 新闻**：SearXNG news + 事件抽取（存信号不转载全文）。
- **[Google Trends](https://trends.google.com/)**：品类需求 by 地理（市场优先级）。
- **网站变更监控 = 复用内容哈希 diff**：盯目标公司产品/「求供应商」/RFQ 页 → 变更即 intent 事件。
- **认证/标准注册库**（免费公开，进入受监管市场=需合规供应商）：**[FDA 注册库](https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfrl/textsearch.cfm)**（FOIA 周更，healthdata.gov 有 bulk 数据集）、**[FCC ID](https://www.fcc.gov/licensing-databases/search-fcc-databases)**、CE/UL（网页可查，UL 无免费 API）。
- **展会参展**（已采）= 主动 sourcing 信号。

---

## 5. 进阶定位法（我主动补充，免费数据 + 技术）
1. **竞争置换**：海关反查买竞品的 consignee → 「我们更好/更省」直接切入。
2. **「已从中国进口过」过滤**：consignee 的 shipper 侧已有中国供应商 = **低切换阻力**，优先。
3. **反向供应链**：Amazon/零售 listing → 谁在卖此品类 → 反推谁供货（ThomasNet reverse-sourcing 公开范围）。
4. **评论挖掘**：Trustpilot/Google Maps/论坛 对**现供应商的抱怨** = 切换缺口（NLP 抽负面 + 供应商名）。
5. **认证注册库**（§C2）：谁新拿 FDA/FCC/CE = 进入新市场，需合规供应商。
6. **look-alike**（§6）：从成单客户的 firmographic + 进口行为找孪生。
7. **财务健康/信用**免费信号（避坏账、挑增长）：招聘增速、域名/基础设施扩张、新闻融资。

---

## 6. 能力域 D —— 编排 · 实体解析 · 评分 · 合规（把上面拼成可排序线索）

### D1. 实体解析 + look-alike + 评分（全用现有 Postgres/pgvector 自建）
- **pgvector 0.8.x**（已装）：新 `entity_embedding` 表（`vector(1024)`，HNSW on `halfvec` cosine，RLS on workspace，**只对公司事实 embedding**）。
- **[BGE-M3](https://huggingface.co/BAAI/bge-m3)（MIT，1024 维，100+ 语言含中文 consignee + 德文公司名）**：Ollama/sentence-transformers **本地自托管零成本**（加一个 compose 容器，CPU 可跑）。→ 托管 embedding API（OpenAI/Cohere/Voyage）**不需要**。
- **[Splink 4](https://moj-analytical-services.github.io/splink/)（UK MoJ，MIT）**：Fellegi-Sunter 概率记录连接（consignee↔canonical），+ **pg_trgm**（内置）做廉价 blocking，+ `name-match.ts`（0.72+margin）做终裁防贴错。→ Senzing/Tilores 商用实体解析**不需要**。
- **评分升级**：六维**加法 → 乘法门**——`priority = Fit^a × (1+Intent) × Reachability × (1+DemandProof)`，让**可达性=0 或需求证据=0 的线索不被高 Fit 冲淡误排前**。✅ **Intent 维已接真实信号**（`lead/scoring.ts`：#4 `attributes.intent.*` 逐事件 `strength×新近度衰减(半衰期60d)` 取最强 + ICP 关键词代理兜底，`max(realIntent,keywordIntent)`，代理排除 intent 命名空间防双重计数）——加法模型下先落地；⬜ 加法→乘法门仍待做（需 backtest 校准阈值）。
- **规则 → 学习式 propensity**：**真实标签已躺在库里**——`LeadDecision(accept/reject)` + `Lead.status=CONVERTED` 是监督信号、`IcpBacktest` 是回测台。scikit-learn/LightGBM/**PU-learning**（全 BSD/MIT 本地）→ 无需买数据、无需冷启动。

### D2. 合规即代码（跨法域冷触达）—— 两道独立闸门
**核心结论**：拆成数据模型里两个布尔——
- **(A) 存储/画像门**（GDPR Art.6(1)(f)+Art.14 / CCPA-CPRA，B2B 豁免 2023-01 已日落）：**摄取/富集/评分一个自然人的那一刻就触发**，哪怕永不发信。
- **(B) 发送/信道门**（ePrivacy / UK PECR / 德 UWG §7 / 加 CASL / 美 CAN-SPAM）：**仅在投递营销信息时触发**。
- 一个联系人可过 A 却过不了 B（德国：可依合法利益存名录，但 **UWG §7(2) 发信前需明示同意，无 B2B 豁免 → 发送硬红线**）。再切：**职能邮箱 `sales@`**（多非个人数据，A 门基本 N/A；德国 B 门仍拦）vs **人名 `john@`**（个人数据，A+B 双拦）。

**可发送性矩阵**（冷 B2B 营销邮件·无既有关系）：

| 目标国 | 职能邮箱 sales@ | 人名邮箱 john@ | 关键约束 |
|---|---|---|---|
| **美国** | ✅ 发 | ✅ 发 | CAN-SPAM 纯 opt-out：真实 header/实体地址/可用退订/10 工作日处理/退订机制维持 ≥30 天；违规每封罚至 $51,744。存储侧 CA 居民受 CCPA |
| **英国** | ✅ 发（corporate subscriber Ltd/LLP，PECR 免同意） | ⚠️ named 个人还需 UK-GDPR LIA | 不隐身份 + 退订 |
| **法国** | ✅ 发（CNIL：职业邮箱 B2B 招揽较宽，与其职务相关即可） | ⚠️ | CNIL 招揽指南 |
| **德国** | ⛔ **需事前同意**（UWG §7(2) 无 B2B 豁免） | ⛔ | 冷邮件硬红线 → 只存/画像，不发；改走展会/LinkedIn/表单入站 |
| **加拿大** | ⛔ 默认需同意（CASL opt-in） | ⛔ | 唯一冷路径=conspicuous-publication 隐含同意（地址公开发布 + 无「勿扰」+ 与职务相关）；罚至 CAD $10M |

**落地**：确定性「可发送性策略引擎」——`canStore(contact, originRegion)` + `canSend(contact, targetCountry, channel, contactType)` 两个纯函数（可单测/回放/审计）；规则编译成 `jurisdiction_policy` 表（系统级种子，随 API 启动 seed，同 `data_provider` seed 机制）；产物写 `field_evidence.allowed_actions`；新增 append-only `consent_record` + `lia_record` + `article14_notice` 三表 + Outbox 事件承接撤回联动。→ OneTrust/Usercentrics 付费 CMP **不需要**。

---

## 7. 免费数据源清单（速查）

| 源 | 给什么 | 免费路径 | 分级 | 复用/新增 |
|---|---|---|---|---|
| ImportYeti | 美线海运提单（买家+其供应商+HS+时间线） | 免费按公司搜 + BETA API（FOIA 公开）；HS 批量反查付费 | 🟢事实/🟡再分发 | 新 `trade_data` adapter + first-seen |
| UN Comtrade / US Census / Eurostat | 国家×HS 进出口额（市场优先级，无公司名） | 免费官方 API/key | 🟢 | `attributes` + ICP 权重 |
| schema.org/JSON-LD · sitemap · RSS | 公司事实 + JobPosting（招聘） | `extruct` 自托管，公开标记 | 🟢 | crawl4ai + 收割器 |
| Common Crawl 索引 + 网页图 | 全网候选域名 + 分销网络图 | 匿名 HTTPS + 本地 DuckDB | 🟢 CC0 | 新 `web_corpus` adapter |
| GLEIF L2 / Wikidata | 母子图 / 供应链-产品图 | CC0 无鉴权 | 🟢 | 已有适配器扩展 |
| 官方注册处（Companies House 等） | 法定名/高管/注册号 | 免费 API/bulk（绕 OpenCorporates） | 🟢🟡 | 新 registry adapter |
| Meta Ad Library API | 在投广告=活跃需求 | 免费官方 API | 🟢🟡 | digital-footprint |
| crt.sh / RDAP / MX | 域名族/建站年/邮件商 | 免费无鉴权 | 🟢 | digital-footprint |
| wappalyzergo + enthec | 技术栈/电商平台 | 自托管 MIT+GPL 数据 | 🟢 | digital-footprint |
| EU TED / US SAM.gov | 招投标需求（CPV/NAICS 反查） | 免费官方 API + bulk | 🟢 | 新 tender adapter（signal） |
| FDA 注册 / FCC ID | 进入受监管市场（新认证=需供应商） | 免费公开（FDA 有 bulk 数据集） | 🟢 | signal |
| LinkedIn 公开档 / 专利 / 新闻 | 决策人具名 | 搜索引擎索引 / EPO·USPTO 免费 | 🟡🔴 | 决策人层 |
| BGE-M3 / Splink / pgvector | 实体解析 / look-alike / 评分 | 全开源自托管 | 🟢 | D1 |
| **付费 only（留插槽，不默认接）** | Panjiva/ImportGenius/Volza（多国+空运提单）· OpenCorporates 商用 · BuiltWith 历史 · ZeroBounce | —（均有上面的免费/自建替代或降级为契约插槽） | — | `data_provider` 契约插槽 |

---

## 8. 分期落地（按「最便宜 × 最高价值 × 复用基建」排序）

**P0 —— 零/极少新基建，最高 ROI（全靠复用）** ✅ 四件套已全部落地（详见 [roadmap](roadmap-ai-acquisition.md)）
1. ✅ **数字足迹富集** `digital-footprint.provider.ts`：从已抓 HTML 解析技术栈/广告像素/hreflang + MX/crt.sh/RDAP + Meta Ad Library。→ 喂 Intent/Reachability。
2. ✅ **结构化收割**（JSON-LD/sitemap via 自建解析）：免费补公司事实 + JobPosting 招聘信号。
3. ✅ **自建邮箱验证管线** `smtp_self`（MX+SMTP RCPT）：把已抽的决策人邮箱 `UNVERIFIED→RISKY/VALID`（Gmail/M365/catch-all 走 RISKY）。
4. ✅ **网站变更 = intent 引擎** `web_watch`（`apps/api/src/intent/`）：复用 `source_entity_change` diff 盯目标公司产品/招聘/求供应商/新闻页 → 变更即 intent 事件。**落地要点（对抗核验后修正）**：(a) 真实站多不发 Product/Article JSON-LD → 产品/新闻改用**主内容锚点链接**（去 nav/footer，避全局导航每页误命中）+ 供应商招募走**短语正则**（覆盖 Flex「become suppliers」/TRUMPF「supplier portal/onboarding」）；(b) `signalHash` 只覆盖信号字段 → cosmetic/时间戳/nonce 抖动不误触发；(c) 🔴 新闻只存**指纹哈希**（新闻稿标题可能含具名高管 → 不落原文），事件证据仅数量，纵深防 GDPR + 保留期清理；(d) DAT-011 SUSPENDED + robots + crawl4ai SSRF 守（本引擎是唯一定时对外抓取路径）；(e) 独立 `intentSweep`+Schedule，通用采集 sweep 用 registry **正向**过滤自动排除无适配器源；(f) 租户按 `companyIdentity` dedupeKey（非 raw domain）投影 `attributes.intent.*`。**实测**（crawl4ai 确定性）：TRUMPF supplier→`supplier_program`、Flex→3 招募词、products→主内容 7 品类、newsroom→8 新闻指纹。🔴 **合规分级=对外抓取（高风险）**，PR 走人审、不自动合。

**P1 —— 免费外部源接入**
5. **海关提单**（ImportYeti free + BETA API）：需求证据 + 竞品供应商 + 进口节奏/切换/首见。
6. **国家级贸易统计**（Comtrade/Census）：市场×HS 优先级。
7. **招投标**（TED + SAM.gov）：CPV/NAICS 反查需求方。
8. **决策人身份扩充**（LinkedIn 公开 dork + 专利发明人 + 新闻具名）→ 喂邮箱管线。
9. **Common Crawl** 域发现 + 网页图（分销网络）。

**P2 —— ML / 编排**
10. **pgvector 实体解析 + look-alike + propensity**（BGE-M3/Splink 自托管；评分加法→乘法门；标签已在库）。
11. **合规即代码**（双门 + 可发送性矩阵 + consent/LIA/Art14 表）——**触达前必过**。

---

## 9. 诚实的付费边界（+ 开源自建替代）

| 付费独有 | 我们的免费/自建替代 |
|---|---|
| Panjiva/ImportGenius/Volza（多国+空运清洗提单） | ImportYeti 美线免费 + 累积落库；多国降级为契约插槽 |
| OpenCorporates 商用 API | 直吃上游官方注册处（Companies House 免费 bulk）+ GLEIF CC0 |
| BuiltWith 技术首见历史 | 自建 `source_entity_change` diff 时间线 |
| ZeroBounce/NeverBounce 邮箱验证 | MX + SMTP RCPT 自建 |
| Pinecone/Weaviate 向量库 · OpenAI embedding | pgvector（已装）+ BGE-M3 自托管 |
| Senzing/Tilores 实体解析 · OneTrust CMP | Splink+pg_trgm+name-match · consent/lia/art14 三表 |

> 结论：v3.0 的**全部核心能力可零付费落地**；付费仅剩「多国+空运清洗提单」等少数增强项，留 `data_provider` 契约插槽按需接，不阻断主链。

---

## 10. 对抗核验修正与增补（10 支柱深研落定）

> 10 支柱经并行深研 + 对抗核验（专门枪毙「声称免费其实付费/ToS 禁止」）。以下是对上文的**精确化修正**与**新增免费源**——凡与上文乐观表述冲突的，以此节为准。

### 10.1 海关提单（§A1 修正 —— 更诚实）
- **ImportYeti 免费层的真实硬顶**：只能**按公司名搜**、每公司约 **50 票**上限、**无 CSV 导出、无 HS 反查、无免费 API**（BETA API `data.importyeti.com` 是**积分制付费**，核心约 $600/yr）。上文「免费 + BETA API」表述过乐观，更正之。要做「按 HS/产品反查进口商」必须**逆向其内部 JSON API**（crawl4ai capture_network_requests，把「按公司名」翻转为「按 HS」+绕 50 票分页上限）或落到付费。
- **新增最干净的免费路径 — [Data Liberation Project](https://www.data-liberation-project.org/requests/cbp-bills-of-lading/)**：已通过 **FOIA** 把 CBP 海运提单「解放」成**真免费 + 明示可再分发**的开放数据集（consignee/shipper/品名/量/港/日期）。适合做**冷启动离线基线 + 降级契约兜底**（覆盖为历史样本、非实时增量）。
- **OEC（oec.world）**：有 CBP 提单逐票（2021-01…2026-04 月度），但**逐票/公司级/批量/API 属 Premium 付费**——免费用户只拿聚合，**别当免费逐票源**。
- **法律基石**：美国是唯一把逐票提单**法定公开**（19 U.S.C. §1431 + 19 CFR 103.31）的主要经济体——付费商卖的是**检索与聚合、不是数据授权**，这让「自建免费替代」合法站得住。美国以外（印度 2016 后限制、墨西哥等）交易级基本无免费官方发布。
- **合规红线加严**：consignee 多为公司🟢，但**相当比例是自然人小额进口 → 🔴 人名+地址落 GDPR，默认隔离**；且「美国法定公开 ≠ 全球可随意再分发」，自建应优先用 FOIA/原始舱单而非二爬增值商成品（撞其 ToS）。

### 10.2 国家级贸易统计（§A2 修正 —— 许可）
- 三源全免费且各具优势：**UN Comtrade**（免费 key 500 calls/天×100k 记录，全球报告国、滞后 1-3 月、HS6）、**US Census Intl Trade API**（免费 key，HS10、月度、次月更新）、**Eurostat Comext**（**无需 key**、CN8、CC BY 4.0）。
- **修正**：UN Comtrade「免费获取 ≠ CC 开放许可」——降级为 🟢数据内容（国家聚合无主体）+ **🟡 许可约束**（内部分析/派生指标可，未授权**再分发**有约束）。Eurostat 才是 CC BY 4.0 可再分发。三源同一 HS6 对齐可交叉验证需求信号。

### 10.3 决策人 + 自建邮箱（§B 增补 + 关键诚实点）
- **新增强力免费具名源 — 专利注册册**：**[USPTO PatentSearch/PatentsView](https://search.patentsview.org/)**（免费 key）+ **[EPO OPS](https://developers.epo.org/)**（免费 3.5-4GB/周，覆盖德国/欧盟制造商）。**inventor=具名研发/工程决策人、assignee=雇主公司**，法定公开出版🟢。
- **[GDELT DOC 2.0](https://api.gdeltproject.org/api/v2/doc/doc)**（免费无 key）抓新闻稿具名高管；展会 agenda/演讲者 SPA（Swapcard/Sessionize）走 crawl4ai 抓包。
- **LinkedIn 合规路径**：走**搜索引擎 SERP dork**（`site:linkedin.com/in "职务" "公司"`）解析公开档标题拿「姓名+职务+公司」——只触及搜索引擎、规避 LinkedIn 合同法直爬；但自知抓 SERP 亦有其 ToS 面，量力而行。
- **🔴 自建邮箱验证的真实天花板（务必交底，不谎报「已验证」）**：SMTP RCPT 直探对 **Gmail 反枚举一律返 250**、**Microsoft 365 对未知 IP 节流/屏蔽**——两者**无法逐地址确认**；且 **30-40% 的 B2B 域是 catch-all**（对任意地址都返接受）同样不可逐一确认。这几类只能靠「模式先验 + 该邮箱串在网上出现过的旁证」**降级打分标 RISKY**，不能标 VALID。→ 直接指导本仓 #3 邮箱验证 provider 的状态语义。

### 10.4 意图/时机信号（§C2 增补）
- **政府招投标是最强最干净**：**[EU TED v3 API](https://api.ted.europa.eu/v3/notices/search)** **零鉴权、无 key**（POST expert query）；**US SAM.gov**（免费 key，`ncode`=NAICS 反查）——其 **Sources Sought/Presolicitation 阶段比正式招标早数月**暴露采购意图 = 最高价值前置 timing 信号。UNGM 公开告示页。
- **招聘信号的技术杠杆 = 逆向自有 ATS JSON**：多数买家用 **Greenhouse/Lever**，其自有招聘板有**稳定公开 JSON 端点**（crawl4ai capture 探 token 即直连）——比 sitemap 更全、结构化，且躲开聚合站 ToS。**这直接升级本仓 #2 结构化收割**（sitemap 只是兜底，ATS-JSON 才是主路）。岗位词映射需求：export/procurement=找供应商、new plant=缺设备、certification=缺合规件。
- **[GDELT](https://api.gdeltproject.org/)** + **SEC EDGAR** + 公司 press 页抓扩产/建厂/融资/新品事件（**只存事件元数据，不转载全文**）。
- **修正**：**Google Trends 无稳定免费官方 API**（官方 API 2025.07 才 alpha、配额受限）；`pytrends` **已失维/长期 broken，不能作生产依赖**——需求趋势降级为「不可靠信号」或另寻。

### 10.5 进阶定位（§5 增补 —— 认证注册库是低估的🟢金矿）
- **认证/标准注册库全免费官方 API/开放数据**：**[openFDA](https://open.fda.gov/apis/)**（器械/食品设施注册，**免 key** 起步）、**FCC EAS Web API**（设备认证 getFCCIDList）、**EUDAMED**（欧盟医疗器械，bulk JSON 导出）、**EU Safety Gate/RAPEX**（危险品召回开放数据）、UL Product iQ（免费账号）。**注册人 = 已在目标市场合规卖此品类的法人**，采购意图强、身份可信、CC0/公共可商用。**商标库**（WIPO/USPTO/EUIPO 免费 API）找品类品牌主。
- **修正 Meta 广告库**：**商业广告仅 EU/UK 范围可经 API**；全球范围只能网页 Ad Library UI 浏览——上文「免费官方 API」需加此地域限制。
- **修正评论挖掘**：Trustpilot **ToS 禁爬**、Reddit **免费层=非商业**（商用需付费）——「合规免费源」呈现会误导；评论挖掘降级为**受限/谨慎**，优先论坛公开页 + 自知 ToS。
- **财务健康**：**UK Companies House 免费 API**（破产/账目）剔除高风险买家。

### 10.6 对已建 provider 的直接指导
- **#2 结构化收割**：主路应加**自有 ATS JSON 逆向**（Greenhouse/Lever），sitemap 降为兜底（已实测 Xometry/Fictiv 职位在 ATS 不在 sitemap，印证此点）。
- **#3 邮箱验证**：按 §10.3 —— Gmail/M365/catch-all 一律**不可标 VALID**，走 RISKY + 旁证降级。
- **新增早期高价值源排序**（免费、指向性强）：TED v3（零鉴权）> openFDA/FCC/EUDAMED 认证库 > 专利 inventor > Data Liberation Project 提单基线 > 自有 ATS 招聘。
