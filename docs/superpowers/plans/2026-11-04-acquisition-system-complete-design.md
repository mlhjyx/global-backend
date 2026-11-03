# 获客挖掘体系完整设计 v1（落地版）

> 生命周期：`DRAFT`
> 依据：产品负责人 2026-11-04「需要完整的设计文档，能够落地的，包括闭环的；多研究开源项目，能借鉴就借鉴、集成；思考全面、主动思考」。
> 文件关系：本文为**总设计**（唯一完整版）。此前三份设计（`acquisition-system-master-plan`、`discovery-quick-deep-tiers`、`discovery-run-2.0-detailed-design`）并入本文对应章节；差异以本文为准，旧文件保留作演进记录。

## 1. 目标与原则

- **用户旅程闭环**：注册 → 卖家资料 → ICP → 快扫出名单（≤8 分钟）→ 深挖（≤15 分钟，可停）→ 判断线索 → 外联草稿 → （美国市场）发送与回复 → 反馈回 ICP 与查询权重 → 下一轮更准。
- **快**：导入名单/渠道池秒级可用；搜索兜底首批 ≤8 分钟；完整链路 ≤15 分钟。
- **准**：意图源优先（海关/展会/协会/招标），两轴排序（ICP fit × intent 强度）。
- **闭环**：判断、回复、退订、监听变化都反哺系统；公司池随变化增量更新。
- **可扩展**：加渠道不改代码——管理后台配 API / 爬取 / 导入三种形态。
- **合规与免费优先**：每渠道登记许可与 robots 结论；付费数据与付费 SaaS 只作可选开关，默认关闭。

## 2. 用户旅程与系统动作（闭环总览）

| 步骤 | 用户看到/做的事 | 系统在背后做的事 |
| --- | --- | --- |
| 注册与向导 | 邮箱/密码/公司名 → 官网/行业/产品/目标市场 | 建 workspace + 公司档案（D16/D17）；无官网也能建档 |
| 上传资料 | 产品目录/证书/案例 | 资料库解析（Docling/文本→分块→BGE-M3→检索） |
| 定 ICP | 目标行业/产品/国家/买家角色 | ICP 规则 + 市场建议（Trade Map） |
| 快扫 | 几分钟内的候选名单（来源标签：海关/展会/搜索） | 渠道池消费 → 规则预筛 → flash 粗判 → provisional leads |
| 深挖 | 自动进行的画像/精判/信号/联系人；可随时停止 | 公司级流水线（子工作流）：画像→fit→信号→联系人 |
| 判断线索 | 接受/拒绝/标记理由 | 写 lead_decision → 反馈聚合（icp_feedback）→ 查询权重与 ICP 建议 |
| 外联 | 草稿审核/发送（按市场分级） | 发送序列、回复识别、退信 DNC、退订；回复结果回写线索状态 |
| 跟进 | 商机状态、提醒 | watches 复检→变化事件→重新评分→通知 |

## 3. 架构总览

```
┌────────────────────── gain-saas（租户面 + 管理后台）──────────────────────┐
│ 找买家/线索/资料库/外联  │  管理后台：渠道管理 · 名单导入 · 平台运营        │
└──────────────▲──────────────────────────────────────▲────────────────────┘
               │ BFF（透传 + 注入 + Grant）             │
┌──────────────┴──────────────────────────────────────┴────────────────────┐
│ 引擎（NestJS + Temporal）                                                 │
│ ① 渠道数据源平台：source_channel(api|crawl|import) + 通用爬虫 + 导入器     │
│ ② 公司池：canonical + 渠道证据 + freshness + intent 信号                   │
│ ③ Run 2.0：Task/TaskRun → 快扫 → 公司级流水线（深挖）→ finalize            │
│ ④ 线索与评分：leads + 六维评分（fit × intent 两轴查看）                     │
│ ⑤ 闭环：icp_feedback / query weights / watches / outreach                 │
│ ⑥ 可观测：run_event / 成本账本 / 告警                                     │
└──────────────────────────────────────────────────────────────────────────┘
外部：SearXNG（84 引擎）· crawl4ai 0.9.1（Apache-2.0）· 模型网关（new-api）·
     BGE-M3（本机 Ollama）· MinIO · 官方源（Companies House/INPI/GLEIF/TED/SAM）·
     展会官网/协会名录（爬取）· 海关名单（导入/付费 API 可选）
```

## 4. 渠道数据源平台

### 4.1 三形态

| 形态 | 用于 | 运行 |
| --- | --- | --- |
| api | 官方/付费 API（TED、SAM.gov、Companies House、INPI、GLEIF） | 适配器 + 统一调度 |
| crawl | 公开可爬（展会官网 exhibitor、协会名录、企业官网、招聘页） | 配置驱动通用爬虫 |
| import | 禁爬/无接口（海关名单类） | 管理后台 CSV/粘贴导入 |

### 4.2 通用爬虫（配置即渠道）

```json
{ "mode": "crawl",
  "list": { "url": "https://expo.example/exhibitors?page={page}", "maxPages": 20,
            "itemSelector": ".card", "itemUrlSelector": "a::attr(href)" },
  "detail": { "enabled": true, "fields": { "name": "h1", "website": "a.site::attr(href)",
              "country": ".country", "products": ".products li" } } }
```

- 复用 crawl4ai 0.9.1（Apache-2.0，CVE-2026-57572 已在该版本修复；支持 `js_code`/`wait_for`/`js_only` 处理 JS 渲染与翻页；最新 0.9.5，升级按发布纪律）；单域限速（默认 1 req/2s）、页数上限（默认 500/天/渠道）、超时、UA 标识、robots.txt 强制检查（未放行拒绝运行）、抓取留痕（URL/时间/截图可选）。
- 产出先落 raw（带 channelId/evidence）→ 规范化/去重/抑制门 → 公司池；`source_channel_run` 记每轮抓取量/失败/耗时。
- **个人字段保留（2026-11-04 决策）**：渠道页面上的人名/职位/邮箱/电话**不丢弃**——加密存入平台受限存储（与公司/渠道/证据绑定、180 天滚动保留），租户默认不可见；仅当租户 run 处理该公司时物化为该租户的联系人候选（过抑制/制裁门），租户之间互不可见。每次访问/物化记访问审计（谁/何时/公司/字段类/用途）。

### 4.3 治理（硬闸门）

- 每渠道必填：license、tos_url、robots 结论（A 公开可爬 / B 只导入或付费 / C 不做）、负责人。
- 渠道默认停用；试跑（抓 1 页/前 20 条）通过并人工确认后启用；失败率连续 3 轮 >30% 自动停用并告警。
- 新渠道产出默认进入「观察名单」，人工抽查后并入正式池。

### 4.4 渠道目录（首版）

P0：展会官网 exhibitor、海关名单导入；P1：协会名录、企业注册补充、招标、Trade Map；P2：B2B 目录（逐站核条款）、招聘/新闻信号、OSM；C：LinkedIn 自动化与付费联系人库。

**2026-11-04 可爬性实证（三个代表站点）**：

| 站点 | robots | 渲染 | 结论 |
| --- | --- | --- | --- |
| Hannover Messe | 允许 `/en/search/`、`/exhibitor/`；禁 `/autocomplete` | 搜索首屏/字母索引/详情页均 SSR，条目有稳定 `data-cy` 属性 | **可配置抓取**（深翻页需浏览器/state+CSRF） |
| Messe Frankfurt（展会子域） | 允许 | 纯 JS（`#mf-ex-root`），条目走 JSON API（前端公开 apikey，`findEventVariable` 分页，含 `contacts` 字段） | **需专用适配器**（API 型；旧中央目录已不可达） |
| 10times | 展会页未禁，但 `/ajax*?*` 等禁 | Cloudflare 挑战 403（"Just a moment..."） | **不可抓（C）**，从渠道目录移除 |

结论：配置化抓取覆盖 SSR 友好站点（Hannover 类），JS/API 站点落专用适配器（Messe Frankfurt 类），Cloudflare 站点不做——验证了 Q4「配置优先、专用兜底」的边界。

### 4.5 管理后台（gain-saas）

平台运营：渠道列表（状态/产出/失败率）→ 新增向导（选形态→填配置→试跑→治理信息→启用）→ 编辑/立即运行/日志/停用。
租户：只能「启用已批准渠道」+「导入自己的名单」（列映射向导、去重预览、抑制命中提示）。密钥只存引用。

## 5. 外贸获客七步与系统映射

1 选市场（Trade Map→ICP 建议）→ 2 定 ICP → 3 找名单（渠道平台养池）→ 4 验证画像（官网/注册/进口记录）→ 5 找决策人（email_guess+SMTP；LinkedIn 手工）→ 6 触达（市场分级）→ 7 跟进沉淀（回复分类/CRM 投影/反馈）。

## 6. Run 2.0（域模型与编排）

### 6.1 域模型

```
Workspace → AcquisitionTask（任务=挖掘需求，绑定 ICP）→ TaskRun（每次执行）
TaskRun → DiscoveryRun（引擎不可变执行记录，含 taskRef/phases/mode）
DiscoveryRun → DiscoveryCompanyJob（公司级状态：stage/verdict/lease/cost）
DiscoveryRun → RunEvent（append-only 进度）
CompanyPool(canonical) → CompanyChannelSighting/Evidence（渠道来源与证据）
```

关键字段与状态机见 `discovery-run-2.0-detailed-design.md` §2/§4（并入本文，以此为准实现）：
- job.stage：`prefiltered_out | quick_judged | profiling | fitting | signals | contacts | done | failed | skipped`；
- run 状态：QUEUED→QUICK→DEEP→FINALIZING→DONE/PARTIAL/FAILED/CANCELLED；
- 预算：一次 run 一个 Grant；渠道抓取独立配额；预算耗尽 PARTIAL 并停止启动新公司。

### 6.2 编排决策（R1–R7）

- R1 任务对象前移（Task/TaskRun）；R2 公司级子工作流（并发 16，上限 500 家/run，遵循「子工作流不跨 continue-as-new」约束，父工作流 CAN 时先等待子完成）；
- R3 run 与抓取解耦（池优先、搜索兜底）；R4 快扫粗判批量（8 家/次，失败降级逐家）；R5 预算不分档；R6 影子模式上线；R7 周期 sweep 调度修复（见 6.4）。

### 6.3 进度与可见性

- run_event 增量 API + 3 秒轮询；run 页 = 快扫名单 + 深挖队列（逐家状态/失败码/单家重试）+ 停止按钮 + 汇总；运维按 workflowId Describe 的内部端点替代翻 Temporal UI。

### 6.4 周期任务调度修复（实查 2026-11-04）

客户侧周期任务自平台迁移后全部停摆（`ensurePlatformSchedules` 无调用方；机器身份无 ScheduleService）。修复 R7-A（推荐）：API 内定时器启动 sweep（StartWorkflowExecution 允许；workflowId=xxx-<period> 去重；启动补跑过期项）；R7-B（后续可选）：扩展平台 Temporal 机器策略并重发镜像。旧 dev Temporal（7233/8233）的 10 个空转 schedule 已删除，容器与卷保留待退役。

### 6.5 公司池的合并与休眠（2026-11-04 决策）

- **自动合并为主**：强信号（同注册域名/同注册号/同官网）自动合并；中等信号（名称相似度≥0.92＋同国家＋同城市或电话区号）自动合并但打标、30 天内可一键撤销；弱信号进疑似重复队列。所有合并写审计（来源两条、合并规则、操作者=系统），保留拆分入口。
- **休眠**：连续 12 个月无信号且无租户跟进的公司标记 dormant（默认排序靠后、仍可搜索与点名深挖）；不删除。
- 共享池边界：平台渠道产出进共享池；租户导入名单只进该租户私有池、不共享。

## 7. 闭环设计

### 7.1 反馈闭环（判断→学习）

- 数据：lead_decision（已有）+ icp_feedback（聚合：按来源/渠道/行业/国家/查询族的接受率与 mismatch 理由分布）+ icp_query_performance（查询族 EMA 质量分）。
- 产出：查询/渠道权重自动调整（低产出降权、高产出加权）；ICP 建议卡（"行业 X 全部 mismatch""渠道 Y 零接受"），**人工采纳才改 ICP**。
- 界面：寻源页/ICP 页建议卡；反馈周期 = 每轮 run 结束。

### 7.2 增量闭环（公司池与监听）

- canonical 增 last_seen_at/last_checked_at/profile_hash；fit 判定加 fit_input_hash（ICP revision+画像 hash 不变则复用）。
- watches 修复注册原因（robots/无 sitemap/阈值），由平台定时器（R7）按周期跑 refresh run（mode=refresh，不产新名单，只更新画像/信号/评分）。
- 变化事件→线索状态更新与通知。

### 7.3 触达闭环（M3，合规前置）

- 阶段：草稿（已有 outreach_draft）→ 人工审核 → 发送 → 回复识别/退信/退订 → 状态回写。
- 市场分级（硬编码在发送门）：US/UK 允许自动发送（带退订与频控）；DE 等 EU 市场只出草稿（UWG §7 要求事先同意）。
- 通道：先自建 SMTP（专用企业邮箱，SPF/DKIM/DMARC 检查，发送窗口+日上限）；ESP 作为可选。
- 回复处理（借 Mautic 模式）：IMAP 监控，In-Reply-To/Message-ID 关联，回复→停序列+分类（感兴趣/不感兴趣/退订/自动回复），退信→DNC，退订链接 + List-Unsubscribe(-Post)。
- 审计：每次发送落审计（谁/何时/模板版本）；per-tenant 配额；四门（lawful-basis/制裁/抑制/频控）前置。

### 7.4 lawful basis 与访问审计（2026-11-04 决策：取消租户声明）

- 取消租户侧的"数据处理声明"（D6 声明功能退役：设置页入口下架，历史声明只读留存）；BFF 统一注入**平台级 lawful-basis 引用**（平台 LIA，OWNER-DECISION 口径），引擎请求级字段与审计保持不变（随时可恢复声明模式）。
- 补偿控制：个人数据每次访问/物化写访问审计（谁/何时/公司/字段类/用途），保留 180 天；DSR 擦除链不变。
- 隐私政策/LIA 文本同步更新（产品负责人最终签字）。

## 8. 评分与意图（两轴）

- 现状六维：fit/role/intent/dataQuality/reachability/engagement；本轮把 **intent 维度真正填上**：渠道类型与信号加权——海关提单（频次/量）、展会参展、招标命中、招聘扩张、官网变化；线索列表按 fit × intent 排序（队列 recommended/needs_review 保留）。
- ICP 规则分（规则预筛）与模型 fit 分离：规则先杀明显不相关，模型只判剩下。

## 9. 开源项目研究与采用决策

| 项目 | 许可 | 可借鉴/集成 | 决策 |
| --- | --- | --- | --- |
| Temporal 官方 Entity/Child 模式 | Apache-2.0（文档） | 子工作流上限、CAN 约束、幂等 Update 模式 | 借模式（Run 2.0 编排） |
| Crawl4AI（已用 0.9.1） | Apache-2.0 | 浏览器渲染/提取 | 保留为渠道爬虫引擎（版本已含 CVE 修复） |
| Firecrawl | AGPL-3.0（核心） | API 式抓取/反爬 | **不采用**（AGPL 传染 + 运维重） |
| Clay | 商业 | waterfall 补全、信号层、两轴打分、定时重跑 | 借模式，不接 |
| Mautic | GPL-3.0 | 回复识别/退订/DNC/List-Unsubscribe | 借模式（PHP 不集成） |
| coldforge | 开源（MIT 类） | 序列状态机/发送窗口/日上限 | 借模式 |
| Twenty | AGPL-3.0 | CRM 基座 | 可选（法务评估后，仅外围投影） |
| OpenSanctions | 数据 CC BY-NC（商业需付费） | 制裁聚合 | **默认不用**（NC 限制）；保留现有官方名单 |
| ZeroGTM / Signal / AgentSDR / OpenSDR / opengtm | MIT 类 | 5 步富化管线、信号表、回复分类 human-in-loop、6 维 ICP 评分、waterfall 邮箱验证 | 借模式（不引入其应用栈） |
| n8n / Make / Zapier | 各许可 | 工作流编排 | 不采用（Temporal 已足） |
| listmonk | AGPL | 群发 | 不采用（冷邮件≠newsletter） |
| SearXNG（已用） | AGPL | 元搜索 | 已用（自托管服务调用，非代码集成） |

## 10. 数据模型总表

| 表 | 用途 | 阶段 |
| --- | --- | --- |
| source_channel / source_channel_run | 渠道注册与运行统计 | M0 |
| imported_buyer | 导入原始行与去重键 | M0 |
| AcquisitionTask / TaskRun | 任务与执行历史 | M0（与 Run 2.0 同批） |
| discovery_company_job | 公司级流水线 | M0 |
| run_event | 进度事件 | M0 |
| company_channel_sighting/evidence | 渠道来源与证据 | M0 |
| canonical_company 增 last_seen/last_checked/profile_hash | 增量 | M0 |
| icp_feedback / icp_query_performance | 反馈闭环 | M1 |
| outreach_message / reply_event | 触达闭环 | M2（触达） |

## 11. 落地计划（PR 序列）

- **M0-pre（先行小项）**：⓪ 取消租户声明（BFF 注入平台级 lawful-basis 引用 + 设置页入口下架 + 访问审计字段与隐私/LIA 文本更新）——独立小 PR，先于编排重构。
- **M0（P0，编排重构）**：① 域模型迁移（jobs/events/task/taskRef/pool freshness）② Task/TaskRun+BFF+taskRef ③ 快扫阶段 ④ 深挖流水线+取消/暂停 ⑤ 进度 API+run 页最小改造 ⑥ finalize V2+影子模式+告警 ⑦ R7 sweep 调度修复（可与①并行）。
- **M1（P0.5，渠道平台）**：⑧ source_channel+导入器 ⑨ 通用爬虫 v0+试跑 ⑩ 管理后台渠道页+租户导入 ⑪ 观察名单与失败告警。
- **M2（P1，闭环）**：⑫ icp_feedback+查询权重+建议卡 ⑬ watches 修复+refresh run 调度。
- **M3（P2，触达）**：⑭ 草稿审核→SMTP 发送（US/UK）→回复/退信/退订 ⑮ 审计与配额。
- **M4（P2，运维）**：⑯ 多租户调度/并发与成本面板；旧 dev Temporal 退役。

每步独立验收、可回退；高风险改动（流水线/影子）先影子对比。

## 12. 验收标准（量化）

1. 导入 200 家名单 ≤2 分钟进快扫名单；搜索兜底首批 ≤8 分钟；完整链路 ≤15 分钟（25 家 mini-run + 一轮真实 run）。
2. 取消 60 秒内生效、暂停/恢复可用；事件可重放（按 seq 拉齐）。
3. 预算耗尽 PARTIAL 且不越界；单公司失败不拖全局。
4. 渠道：后台新增展会源试跑 ≥10 家；失败率告警；robots 拒绝时不可启用。
5. 反馈：连续两轮 run 低产出来源权重下降；ICP 建议卡可见且人工采纳生效。
6. 影子两轮召回不降（golden set）。
7. 触达：草稿→发送→回复→停序列/退订 DNC 全链留审计；EU 市场发送被硬门拒绝。

## 13. 合规与风险

- 爬取：逐源 A/B/C 判定 + robots 强制 + 条款登记；被抓站投诉→立即停用（后台一键）。
- 个人数据：渠道个人字段加密入平台受限存储（180 天滚动），按租户物化时过抑制/制裁门并记访问审计；lawful basis 采用平台级 LIA 引用（租户声明已取消）；资料库与线索按租户隔离；DSR 级联不变。
- 触达：EU 禁发邮件、退订/频控/DNC 全局；发送域 SPF/DKIM/DMARC 检查。
- 许可：AGPL 类（Firecrawl/Twenty/listmonk）只作参考或外围评估；数据许可（OpenSanctions NC）不用于商业路径。
- 重构风险：patch 守卫 + Build ID 版本化 + 影子模式 + 迁移 expand-only。

## 14. 需要产品负责人提供/拍板

1. 海关名单样例 CSV（导入器列映射与验收）；2. 行业重点展会名单；3. 协会/商会会员账号或名录导出；4. 历史客户/询盘/名片名单（冷启动+抑制）；5. 发送邮箱域名与 DNS 权限、目标市场优先级；6. 付费 API 预算（默认全免费）；7. 落地页承接；8. LinkedIn 人工账号范围；9. 法务文本（隐私/退订/LIA）；10. R7 方案 A/B、触达通道、渠道归属层级、爬虫栈四决策。

## 15. 参考

- Temporal Entity/Child 模式：https://docs.temporal.io/design-patterns/entity-workflow
- Crawl4AI vs Firecrawl（许可与运维）：https://blog.apify.com/crawl4ai-vs-firecrawl/
- OpenSanctions 许可：https://www.opensanctions.org/licensing/
- Mautic 监控邮件/退订：https://deepwiki.com/mautic/mautic/3.6-monitored-email-and-bounce-handling
- coldforge：https://glama.ai/mcp/servers/Makeph/coldforge
- Open-source AI SDR 综述：https://maskin.io/alternatives/open-source-ai-sdr/
- Clay waterfall/signals：https://www.clay.com/tools/generate-leads-with-intent-data
