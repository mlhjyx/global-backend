# 获客挖掘体系总体规划（v1）：渠道数据源平台 + Run 2.0 + 反馈闭环 + 管理后台

> 生命周期：`DRAFT`
> 说明：中间稿，已并入 `2026-11-04-acquisition-system-complete-design.md`，以完整设计为准
> 依据：产品负责人 2026-11-04 要求「一个总的方案」「新增渠道数据源，没有 API 的就爬取」「gain-saas 管理后台要有渠道管理」。本文是总规划；子设计：快扫/深挖（`2026-11-04-discovery-quick-deep-tiers.md`，已批）、闭环改造细节（`2026-11-04-discovery-run-closed-loop-redesign.md`，并入本文 §4）。

## 一、目标与原则

- **快**：导入名单 ≤2 分钟可见；搜索通道首批名单 ≤8 分钟；完整链路 ≤15 分钟。
- **准**：意图源优先（海关/展会/招标），搜索兜底；两轴打分（ICP 匹配 × 意图强度）。
- **闭环**：你的判断与触达结果反哺 ICP 与查询权重；公司池随变化增量更新。
- **可扩展**：新增渠道数据源不需要改代码——管理后台配置即可（API / 爬取 / 导入三种形态）。
- **合规与免费优先**：每渠道登记许可与条款；能爬的必看 robots 与 ToS；不允许爬/无 API 的走导入或付费开关。

## 一之二、外贸获客标准工作流与我们的映射

| # | 标准步骤 | 现状 | 缺口 / 本计划改造 |
| --- | --- | --- | --- |
| 1 | 选市场（Trade Map/Comtrade） | 无 | 新增 Trade Map 渠道（宏观，进 ICP 建议） |
| 2 | 定 ICP | 已有 | 接入市场建议与反馈闭环 |
| 3 | 找名单（海关→展会→协会→目录→搜索） | 仅搜索 | **渠道平台**：API/爬取/导入三形态养公司池 |
| 4 | 验证与画像 | 官网/注册/GLEIF 已有 | 渠道 lineage；海关频次作 intent 信号 |
| 5 | 找决策人 | decision_maker/email_guess/SMTP 已有 | LinkedIn 保持手工 |
| 6 | 触达（邮件/WhatsApp/电话） | 仅草稿 | 触达闭环（M3，市场分级） |
| 7 | 跟进与沉淀 | 无 | 反馈闭环 + CRM 投影 |

## 二、总体架构

```
                 ┌────────────────── gain-saas 管理后台 ──────────────────┐
                 │ 渠道管理: 列表/新增/试跑/启停/产出统计/治理信息          │
                 └───────────────▲────────────────────────────────────────┘
                                 │ BFF（admin 路由）
┌────────────────────────────────┴───────────────────────────────────────┐
│ 引擎: 渠道数据源平台（新增第 0 层）                                       │
│  source_channel（api | crawl | import）+ 通用爬虫运行时 + 导入器           │
│        │ 产出统一入公司池（raw→canonical，过治理/去重/抑制门）              │
└────────┼───────────────────────────────────────────────────────────────┘
         ▼
  公司池 canonical（freshness）──► Run 2.0 流水线（公司级 job：快扫→深挖）
         ▲                                  │
         │ watches/定时复检                   ▼
  反馈闭环（判断/来源质量 → 查询权重/ICP 建议）   线索 leads ──► 触达闭环（M3，市场分级）
```

## 三、渠道数据源平台（本次新增的核心）

### 3.1 三种接入形态

| 形态 | 适用 | 运行方式 |
| --- | --- | --- |
| **api** | 有官方/付费 API 的源（TED、SAM.gov、Companies House、GLEIF、TradeData.io 等） | 已有 provider 适配器 + 统一调度 |
| **crawl** | 无 API 但公开可爬的源（展会参展商列表、协会名录、企业官网、招聘页） | **配置驱动的通用爬虫**（见 3.2） |
| **import** | 不允许爬/无公开接口的源（ImportYeti 类海关数据、用户自有名单） | 管理后台上传/粘贴 CSV → 规范化入池 |

### 3.2 通用爬虫运行时（crawl 模式）

配置即渠道（新增源不改代码）：

```json
{
  "mode": "crawl",
  "list": { "url": "https://expo.example/exhibitors?page={page}", "maxPages": 20,
            "itemSelector": ".exhibitor-card", "itemUrlSelector": "a::attr(href)" },
  "detail": { "enabled": true, "fields": {
      "name": "h1.company-name", "website": "a.website::attr(href)",
      "country": ".country", "products": ".products li" } }
}
```

- 基于现有 crawl4ai/Playwright 渲染栈，单域速率限制、最大页数、超时与 UA 标识；
- **robots.txt 自动检查**，未放行即拒绝运行；每渠道必须登记 `license` + `tos_url` + `robots_policy`（管理后台强制填）；
- 产出先落 raw（带来源 URL/抓取时间），再走既有规范化/去重/抑制门；`source_channel_run` 记录每轮抓取量、失败与耗时（产出统计进管理后台）；
- 官网变化检测复用该运行时（快照 diff → 增量闭环）。

### 3.3 首批候选渠道（逐源接入前核条款/robots）

判定口径：**A=公开可爬**（robots 放行+条款允许）；**B=只导入/付费**；**C=不做**。

| 类别 | 候选 | 形态与判定 | 备注 |
| --- | --- | --- | --- |
| 海关提单 | ImportYeti（免费浏览、无 API、明确禁爬）；ImportInfo / Port Examiner（查询页）；TradeData.io / Apify（付费 API）；ImportGenius/Panjiva/Volza/腾道（付费） | **B**：import 先行；api 付费可选 | 公开舱单是公开记录，合规路径=导入或付费 API |
| 宏观贸易 | Trade Map（ITC）、UN Comtrade、中国海关统计 | A / API | 只进 ICP 市场建议 |
| 展会 | 10times、TradeFairDates（目录页）；**各展会官网 exhibitor 列表**；mapyourshow、trade_fair（已有） | **A**（展会官网为主）+ 已有 API | 最快出高可信名单的源 |
| 协会/商会 | VDMA、ZVEI、VDA、各国 AHK 商会、Eurochambres 名录 | A（逐站核 robots） | 会员名录常需登录 → 视情况转 B |
| B2B 目录 | Europages、DirectIndustry、Kompass、ThomasNet、GlobalSpec | B 评估 | ToS 不一 |
| 企业注册/信用 | Companies House、INPI、GLEIF（已接）；Handelsregister/KvK/CVR/Bolagsverket（评估）；OpenCorporates、SEC EDGAR | A / API | 补全与核验 |
| 招标 | TED、SAM.gov（已接）；UK Contracts Finder、AusTender、UNGM、World Bank/ADB | A / API | 意图信号强 |
| 招聘/官网信号 | 公司官网 careers、press 页 | A | 信号层 |
| 新闻/融资 | Google News RSS；Crunchbase（付费） | A / 付费可选 | 信号层 |
| 地图/POI | OpenStreetMap Overpass（已接、可再启用）；Google Places（付费） | A / 付费可选 | 补全 |
| 明确不做 | LinkedIn 自动化、X/FB/IG 抓取、Apollo/ZoomInfo/Lusha/Cognism、Instantly/Smartlead/Hunter/Snov 等 | **C** | ToS/付费原则，仅借鉴模式 |

### 3.4 管理后台（gain-saas）

设置 → **数据源管理**（平台管理员 `saas-admin` 可见）：

- 渠道列表：状态（启用/停用）、模式、类别、近 30 天产出（公司数/入池率/失败率）、最近运行时间；
- 新增渠道向导：选模式 → 填配置（api 填 endpoint/密钥引用；crawl 填列表/字段选择器；import 上传文件）→ **试跑预览**（抓 1 页/前 20 条）→ 填治理信息（许可、条款 URL、robots 策略确认）→ 启用；
- 操作：启停、编辑配置、立即运行、查看运行日志/失败原因、删除（软删）；
- 引擎侧 API：`GET/POST/PATCH /source-channels`、`POST /:id/preview`、`POST /:id/run`、`POST /:id/import`（admin scope），全部经 BFF 透传与审计；渠道密钥只存引用（环境变量名），不在 UI 显示值。

## 四、Run 2.0（并入此前两份子设计）

1. **两档**：快扫（意图源/导入 → 规则预筛 → flash 粗判，≤8 分钟出名单）→ 自动深挖（画像→精判→信号→联系人，≤15 分钟，可随时停止）。
2. **公司级流水线**：`discovery_company_job` + Temporal 子工作流；废阶段屏障；run 事件表驱动界面进度。
3. **反馈闭环**：判断/拒绝理由 → `icp_feedback` → 查询权重（自动）+ ICP 建议（人工采纳，不自动改）。
4. **增量闭环**：公司池 freshness + watches 定时复检 + 变化触发重评分。
5. **触达闭环（M3）**：草稿先行；发送按市场分级（美国可自动发送＋退订/频控；德国等 EU 市场只出草稿，UWG 要求事先同意）；回复识别/退信 DNC/退订链接（Mautic 模式）。

## 五、数据模型变更总表

| 表 | 用途 | 里程碑 |
| --- | --- | --- |
| `source_channel` / `source_channel_run` | 渠道注册与运行统计 | M0 |
| `imported_buyer` | 导入原始行与去重键 | M0 |
| `discovery_company_job` | 公司级流水线状态 | M1 |
| `run_event` | 增量进度事件 | M1 |
| `icp_feedback` / `icp_query_performance` | 反馈闭环与查询权重 | M2 |
| `outreach_message` / `reply_event` | 触达闭环 | M3 |
| canonical_company 增 `last_seen_at/last_checked_at` | 增量 | M2 |

## 六、里程碑（2026-11-04 按产品负责人优先级重排：编排重构最高）

- **M0 编排重构（最高优先）**：快扫/深挖两档 + 公司级流水线 + run 事件/进度 UI + 可恢复 run。
  验收：搜索通道首批 ≤8 分钟、完整链路 ≤15 分钟、界面逐家进度可见。
- **M1 渠道平台（紧随 M0，导入通道先行）**：source_channel + 导入器 + 通用爬虫 v0 + 引擎 admin API + BFF + gain-saas 数据源管理页。
  验收：后台新增一个展会 exhibitor 源并试跑抓到 ≥10 家公司；上传 CSV 名单 ≤2 分钟进快扫名单。
- **M2 闭环**：反馈（查询权重+ICP 建议卡）+ 增量（watches 修复与复检）。
- **M3 触达**：草稿→发送（美国）→回复/退信/退订闭环（EU 只出草稿）。
- **M4 调度与成本**：多租户并发/优先级、成本面板。

## 七、决策点

- **D1 渠道配置的归属**：平台级（运营统一维护，推荐）vs 工作空间级（租户自配）；首版平台级+按工作空间启用白名单。
- **D2 爬虫运行时**：复用 crawl4ai（推荐，已在栈内）vs 独立 Playwright 服务。
- **D3 海关数据**：导入通道先行（推荐）；TradeData.io/ImportYeti 付费 API 作为可选开关，条款评估后进行。
- **D4 管理后台权限**：平台管理员（saas-admin/ops）管理全局渠道；工作空间 admin 只能启用/停用已批准的渠道。

## 七之二、新增决策（2026-11-04）

- **D5 渠道与 run 解耦**：渠道按周期持续养公司池、run 只消费池（推荐）vs run 内现抓。
- **D6 触达市场分级**：US/UK 自动发送 + EU 只草稿（推荐，UWG §7）。
- **D7 需要产品负责人提供的资源**：海关名单样例 CSV、重点展会名单、协会会员账号/名录、历史客户名单（冷启动+抑制）、发送邮箱域名与 DNS 权限、目标市场优先级、付费 API 预算、落地页承接、LinkedIn 账号范围、法务文本确认。

## 八、风险

- 爬取的条款合规：每源在启用前必须人工登记 ToS/robots 结论；运行时强制 robots 检查；被拒的源退回导入模式。
- 通用爬虫的脆弱性：页面结构变化导致选择器失效——运行统计会暴露失败率，管理后台可一键试跑修正。
- 渠道爆炸后的治理：每渠道产出必须过既有 source_policy/抑制/去重门；新渠道默认停用，试跑通过后启用。
- 触达合规：市场分级硬编码在发送门（EU 默认禁发邮件，仅草稿）；退订/DNC 全局生效。
