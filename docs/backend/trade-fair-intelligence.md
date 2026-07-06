# 展会情报子系统 · 设计（实时监控 + 历史届 + 持续抓取）

> 由多智能体研究工作流产出（5 研究角度 + 实地侦察），综合成可开工设计。
> 定位：把展会参展商从「几个硬编码展会一次性拉取」升级为**持续监控子系统**——
> 目录源发现新展会/新届 → 按临近开展自适应节奏抓取 → diff 变更检测（新参展商=时机信号）→
> 保鲜去重 → 关联现有 `canonical_company` / lead 管线。面向出海 B2B 获客。

## 0. 先读：合规现实（决定「怎么用」而非「能不能抓」）

研究最重要的结论不是技术，是**三条独立法律轨道叠加**，务必分级 gating：

| 轨道 | 关键结论 |
|---|---|
| **平台合同(ToS/robots)** | 🔴 RX/Reed 官网 ToS **逐字禁止** robots/爬虫/系统性建库。🟡→🔴 用 public search-only key 打其自有 **Algolia** API 撞 Algolia ToS §4.5(h)「服务仅供 Subscriber 自用」——第三方为自身获客调用别家 index 属**超范围使用**，法律灰偏红、工程上极易被封 key。 |
| **著作权/数据库权** | 名录整体可能受数据库权保护；Wayback 取往届 = 换入口拿同一份第三方数据，原站约束仍在。 |
| **GDPR/ePrivacy** | 🟢 `info@`/`sales@`/总机 = 非个人数据，可直接用。🔴 人名邮箱 `john.smith@`/直线电话/具名参展联系人 = 个人数据，抓取即受 GDPR，触发 **Art.14 主动告知**（获取后 1 个月内或首次接触时）。欧盟 DPA 一致立场：**「公开可见 ≠ 可自由再利用」**（Clearview 判罚为鉴）。 |

**数据分级 gating（落地铁律）**：
- 🟢 **GREEN**（公司实体事实 + GLEIF CC0）：公司名/官网域名/国家/展位/产品线/招聘信号 + LEI/法定名/母公司 → 直接进库、可商用。
- 🟡 **AMBER**（通用职能邮箱/总机/社媒）：可存，外联走 ePrivacy 合规通道。
- 🔴 **RED**（人名邮箱/直线/具名联系人）：默认不落库或加密隔离，需 legitimate-interest LIA + Art.14 告知才可外联。

**采集路径分级**：官方开放 API/数据集(GLEIF/Wikidata/公司注册处)=首选无限制；展会平台自有 API(Algolia 等)=「平台受控」，**低频/限量/加缓存**，绝不当免费批量源建库转售，备好 key 失效降级；robots/ToS 明文禁止(RX)=不程序化爬，改用官方参展商 API/主办方授权名录/协会公开会员目录。

> ⚠️ 非法律意见。上线前须由懂目标市场（德国 UWG、法国 CNIL 更严）的律师做 DPIA。

## 1. 系统总览（三层）

```
目录源(发现)         平台 handler(提取)          监控/存储(持续)
EventsEye/AUMA/  →   rx_algolia / mapyourshow /  →  Temporal Schedules ×3
10times/官方目录      messe_* / swapcard...          + 平台级快照表 + 变更事件
       │                     │                              │
       └── 新展会/新届 ──────┴── FairExhibitor 统一接口 ─────┴─→ canonical_company/lead
```

## 2. 展会目录源（发现新展会/新届）

无单一源同时满足「全量 + 免费 API + 逐届历史」，分层组合：

| 源 | 角色 | 实测结论 |
|---|---|---|
| **EventsEye** ✅推荐主源 | series 清单 + 排期 | 168 行业分类，纯服务端 HTML，URL 完全可预测（`st1_trade-shows_<sector>.html` 翻页），robots 无限制。金属加工类实测 500 场。用 crawl4ai + 复用 `directory.provider` 的 `extract_list` 抓。 |
| **AUMA** 权威校准 | 官方规范名/行业分类 | ~5000 场最权威，**但 robots 明确 Disallow `/api/TradeFairData/` 且封 ClaudeBot**——官方数据只能走**付费授权 API**（德国注册主体可签，info@auma.de），**不要抓 FairFinder**。 |
| **10times** 覆盖补充 | 补全 | 有反爬(裸 fetch 403)，走第三方 Apify actor 或官方 feed。 |
| **Wikidata** 弱交叉验证 | 去重锚点 | trade fair 实体仅 1658 条、字段稀疏、几乎无逐届日期，不能当主源。 |
| m+a ExpoDatabase / Expofairs | 二级补充 | ~2万场免费。 |

**registry 建两张表**：`fair_series`（跨届稳定：slug/name/aliases/sector_tags 归一到现有 ISIC 词表/region/cycle/organizer/official_url）+ `fair_edition`（一届）。

## 3. 平台 handler 优先级矩阵（最大杠杆：一个 handler 覆盖该平台全部展会）

| 优先级 | 平台 | 数据暴露 | 覆盖 | 状态 |
|---|---|---|---|---|
| **已建** | **RX/Algolia** | `{appId}-dsn.algolia.net/1/indexes/{index}/query` public search key | EuroBLECH 等 RX 展会（一个 appId 覆盖多展会，实测 ITS America 同 appId） | ✅ 实测 398/909 |
| **P0** | **Map Your Show**（legacy `/8_0/` ColdFusion）| 无鉴权公开 JSON `remote-proxy.cfm?action=search` | **150+ 制造业核心展**：IMTS/FABTECH/PACK EXPO/Automate/SEMA/MODEX | 与 Algolia 同构，实测 PACK EXPO 221 / IMTS 275 |
| **P1** | **Messe Frankfurt** | 共享 ESB 网关 `api.messefrankfurt.com/service/esb_api/exhibitor-service/api/2.1/public/exhibitor/search` + 静态 public `apikey` 头 + 按届 `API_EVENT_ID` slug | 一个 handler 覆盖 MF **全部**展会（Automechanika/Ambiente…） | 实测 searchfilters 200 |
| **P1** | **Messe Düsseldorf** `/vis/v1/` A-Z 目录 | server-rendered | K/drupa/MEDICA/wire/Tube/interpack | 待建 |
| **P2** | Koelnmesse fairworld / Hannover / Nürnberg | server-rendered HTML | 各自组合 | 待建 |
| **谨慎** | Swapcard(GraphQL) / ExpoPlatform | 需 event-scoped token | 活动 app | 匿名可达性未证实 |

**运行时探测**：MYS 正被 Cvent 收购迁移，handler 必须先探 `remote-proxy`（200+JSON 走 legacy，否则走 Cvent 分支）。`fair_edition.platform` 字段路由到对应 `captureHandler`（实现同一 `FairExhibitor` 接口）。

## 4. 历史届数据（研究最惊喜的发现）

**RX/Algolia 同一 index 驻留「当前届 + 往前 2 届」共 3 届**，同一 public key、只换 `eventEditionId` 即可分页拉全量，**往届字段不衰减**（website/email/phone/products/isNew 都在）：
- EuroBLECH index 实测 6628 exhibitor 记录 = 3 届（en-gb 各 1228/1177/909 ≈ 2024/2022/2026）。
- **官网前端只显当前届（无往届入口）——「网站看不到、接口照拉」**。
- 枚举法：`eventEditionId` 是 filterOnly（非 facet），不能 facet 枚举 → 空 query browse 全 index 翻页、按记录内 `eventEditionId` 分桶。
- **跨届稳定主键**：每条带 `organisationGuid`（跨届不变）——纵向「常客/新进/流失」分析的天然主键。
- **纵向价值已在真实数据算出**：3 届都在=483 家（铁杆核心）、仅最新届=273 家（新进入者/扩张）、每届 churn ~38%。
- **>3 届更早**走 fallback：官网往届 PDF（EuroBLECH-2022 名录 PDF 挂在 RX 站点）、第三方存档(Architonic)、Wayback CDX（本机 SNI 过滤，需走 crawl4ai/服务端出口）。

改造：`queryAlgoliaExhibitors` 的 `eventEditionId` 从「固定当前届」改「可选/可遍历」；新增 `enumerateEditions(cfg)`。

## 5. 实时监控架构（NestJS + Temporal + Postgres）

**核心正确性决策**：展会/届/参展商快照是**平台级共享参考数据（无 RLS，像 `data_provider`/`source_policy`/`canonical_taxonomy`）**——EuroBLECH 参展商对所有卖钣金设备的租户都一样，**爬一次共享**，避免 N 个租户重复爬同一展会触发封禁。只有「哪个 workspace 的哪个 ICP 命中了这家参展商」是租户数据。

**三条 Temporal Schedule**（`ScheduleClient.create`，非工作流内 cron；overlap=SKIP/BUFFER_ONE + catchupWindow + jitter）：
1. **目录巡检**（每日/周）：扫 EventsEye/AUMA/官方目录，检测新 series/新 `eventEditionId`，跑 `discover-fair-algolia` 逻辑自动刷配置，新届落 `fair_edition=UPCOMING`。
2. **参展商抓取**（每活跃届一个 schedule，`scheduleId=fair-capture:<editionId>`）：**自适应节奏**由 `opensAt` 距今分档——>90天每周、30–90天每2天、<30天每天、开展期每6h、闭展后一次性冻结→`ARCHIVED`。理由：临近开展新参展商快速注册=最强时机信号。
3. **变更检测/保鲜**：快照行级 `contentHash` diff → `ADDED`(热信号)/`REMOVED`/`PRODUCTS_CHANGED`/`CONTACT_CHANGED` → 进 `outbox_event`。

**双变更检测策略**（`fair.platform` 路由）：MapYourShow 有原生 delta 端点 `/Exhibitors/Modified?fromDate&toDate`（黄金路线）；RX/Algolia 无 delta → 全量快照 + 逐行 content_hash diff。

**数据模型（新增 5 张平台级无 RLS 表 + 1 张租户表）**：
- `fair`（跨届稳定：目录 URL/平台类型/topics）
- `fair_edition`（一届：eventEditionId/日期/生命周期 UPCOMING→LIVE→ARCHIVED/cadence 状态）
- `fair_platform_config`（按届 Algolia appId/apiKey/index 或 MYS eventID，换届刷新，带 config_version）
- `exhibitor_snapshot`（一届×一次抓取行级：externalId/organisationGuid/公司名/官网/public_email/phone/stand/products/hiring/content_hash/first_seen_at/last_seen_at/withdrawn_at）
- `fair_crawl_run`（每次抓取审计：edition/hits/added/updated/removed/status/error）
- `exhibitor_lead_link`（**租户层，有 RLS**：workspace_id + edition_id + externalId → canonical_company.id + icp_id + 首次匹配时间）

复用现有基座：`queryAlgoliaExhibitors` 分页/字段映射、`discover-fair-algolia.mjs` 换届刷新、`data_provider.status` Kill-Switch、`source_policy` 合规门、`raw_source_record`/`field_evidence` 留痕、`companyIdentity`→`canonicalCompany.upsert` 身份归一。

## 6. 分阶段落地计划

- **P0**（最高杠杆，与现有同构）：① 5 张平台表 + migration；② 历史届改造（`enumerateEditions` + 可遍历 `eventEditionId`）——零新基建拿 EuroBLECH 3 届；③ **MapYourShow handler**（覆盖 150+ 制造业展）。
- **P1**：④ Temporal Schedule ×3（目录巡检 + 自适应抓取 + 变更检测）；⑤ Messe Frankfurt handler（覆盖 MF 全部展）；⑥ `exhibitor_snapshot` → `canonical_company` 接入现有管线 + `exhibitor_lead_link`。
- **P2**：⑦ 变更事件进 outbox 供触达编排；⑧ 更多平台 handler（Düsseldorf/Koelnmesse/Hannover）；⑨ Wayback/PDF 更早届 fallback（走服务端出口）；⑩ 目录源 registry 自动化（EventsEye 抓 series）。
- **贯穿**：数据分级 gating（GREEN/AMBER/RED）+ 个人数据 Art.14 合规通道，随每一步落实，不后补。

## 7. 已知不确定 / 风险

- **合规是最大约束**（见 §0）：技术可达 ≠ 合规可用。Algolia/RX 路线有 ToS 风险，宜低频/缓存/不转售，并评估官方授权名录（AUMA License API / 主办方授权）作为正式源。
- 换届 `apiKey`/`eventEditionId` 会失效（401/403），靠 `refreshEditionConfig`（crawl4ai capture）自愈。
- index 保留 3 届是 EuroBLECH 观测值，非 RX 平台通用常量，每展会需实测枚举。
- `eventEditionId → 年份`无官方标签，靠 discover 时间戳 + 官方参展商数对齐。
- AUMA 官方数据须付费授权；EventsEye 无 API 许可声明，需礼貌抓取（低并发 + UA + robots）。
