# Site Builder 架构设计 v1

> 配套 [01-prd.md](01-prd.md)。2026-07-13 起草；模型/素材库研究结论见 §6/§8（web 调研回填）。

## 0. 设计原则（五条）

1. **总控 = Temporal Workflow + 规划型 AI Task**，不做自由超级 agent。调度/重试/超时/预算/进度是确定性编排的活；智能只出现在有界任务节点。续用本仓 L0-L3 分层哲学（"AI Task = 有界任务契约"），获客侧已验证。
2. **SiteSpec 结构化产物 + 组件库渲染**（已拍板）：agent 产出结构化 JSON，确定性渲染器构建站点。同 SiteSpec 永远产出同站（可 diff、可回滚）；风格切换 = 换主题 token 秒级重渲染。v2 再开"自定义 section 代码生成"。
3. **两段式生成**：demo v0 秒出（确定性模板+注册信息+一次轻文案调用）；精装修异步分钟级。
4. **每个 agent = 有界 AI Task**：输入/输出 zod schema 严校验、失败重试带错误反馈、预算 reserve-settle、全链 trace。
5. **模型统一走 new-api 网关**（已拍板，付费开闸）：所有 agent 的文本/图像/视频调用集中网关记账，key 不散落。

## 1. 模块与目录

```
apps/api/src/site-builder/
  intake/        # 注册引导接收、建站向导、店铺导入
  kb/            # 知识库：文档解析、切块、pgvector 向量化、检索
  assets/        # 素材：presigned 上传、处理管线状态机、多尺寸导出
  spec/          # SiteSpec zod schema + 校验器 + 主题 token 预设
  render/        # SiteSpec → Astro 构建（容器）→ 产物上传 → 预览
  agents/        # 各 AI Task（§5：8 张生产 agent，原卡 1 planner 已砍）
  temporal/      # siteBuilderWorkflow + activities
  preview/       # 预览签名 URL / 发布
  events/        # outbox: SiteDemoReady / SiteBuildProgress / SiteBuildFailed / InquiryReceived(M2)
```

复用现有：JWKS 鉴权、RLS 基建、Transactional Outbox、模型网关 client、SearXNG+Crawl4AI（品牌研究）、taxonomy 词表（行业级联）、预算 reserve-settle 思路（ToolBroker 同款）。

新增基建：**MinIO**（compose，对象存储）、**Astro 构建容器**（渲染器）、网关新模型通道（§6）。

## 2. 数据模型（Prisma 新表，全部 `workspace_id` + RLS policy）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `site` | status(draft/building/ready/published), active_version_id, locales, style_preset | 每 workspace 可多站（先限 1） |
| `site_version` | spec(jsonb=SiteSpec), artifact_key, build_status, source_run_id | 版本化：回滚=切指针 |
| `site_build_run` | phase, progress, steps(jsonb), cost_summary, temporal_run_id, error | 一次精装修管线 |
| `asset` | kind(logo/product_image/factory_image/cert/doc/video/generated), object_key, derived_keys(jsonb), processing_status, content_hash, meta | content_hash 幂等；EXIF 已剥离后落库 |
| `kb_document` / `kb_chunk` | source(intake/wizard/upload/storefront/web_research), embedding(pgvector) | 知识库 |
| `brand_profile` | value_props, tone, glossary, keywords, competitors, evidence(jsonb), version | Brand Brief 落库，版本化 |
| `inquiry`(M2) | form_data, source_page, status | 询盘回流（未来接获客管线） |

对象存储 key 约定：`ws/{workspace_id}/{site_id}/{kind}/{content_hash}.{ext}`；owner 凭证只在后端，外部一律短时 presigned URL。

## 3. API 面（code-first OpenAPI，交 SaaS 前端）

```
POST /site-builder/intake                     # 注册引导提交 → 建档 + 触发 demo v0
GET  /site-builder/sites /sites/{id}          # 列表/详情（含预览 URL）
POST /sites/{id}/assets/presign               # 上传三步：presign → PUT 直传 → commit
POST /assets/{id}/commit                      # 触发素材处理管线
POST /sites/{id}/builds                       # 触发精装修（body: 风格/页面开关/语言/scope）
GET  /builds/{id}                             # 进度（阶段+百分比+步骤）
GET  /builds/{id}/events                      # SSE 实时进度（前端也可轮询）
POST /sites/{id}/regenerate                   # scope=site|page|section
PATCH /sites/{id}/spec                        # 人工文案/图片微调=直改 SiteSpec，免跑管线
GET  /sites/{id}/versions  POST /versions/{id}/rollback
POST /site-builder/import/storefront          # 店铺 URL 导入（M3）
POST /sites/{id}/publish                      # 发布（M2）
```

鉴权照旧：SaaS token → JWKS 验签 → workspace_id → RLS。全部接口 OpenAPI 注解，Scalar 门户可见。

## 4. 编排（siteBuilderWorkflow）

**快速通道**：`demoV0Activity` —— 行业模板选择（taxonomy 匹配）+ 注册信息填充 + 一次轻文案调用（deepseek-v4-flash，超时即用模板默认文案），P95 < 10s，同步返回。

**精装修管线**（异步，触发=用户补资料/选风格/点重新生成）：

```
P1 理解     资料解析入库向量化 ‖ brandProfileTask（全网研究）→ Brand Brief
P2 素材     并行 fan-out：imagePipeline(每图) ‖ copyTask(每语种) ‖ motionAssetTask ‖ videoTask(M3)
P3 组装     designSpecTask → siteAssemblyTask → SiteSpec 校验 → Astro 构建 → 预览部署
P4 质量环   ≤3 轮：qaTask ‖ seoTask ‖ aestheticReviewTask → findings → assemblyFixTask → 重构建
P5 发布     outbox: SiteDemoReady → SaaS 前端刷新预览
```

- **增量再生成**：scope 参数决定只重跑受影响 phase；素材处理按 content_hash 幂等跳过。
- **失败策略**：单素材失败不阻断整站（占位图+标记，fail-safe 照旧）；phase 级 Temporal 重试；预算超限 → 暂停 + `SiteBuildFailed(reason=budget)` 事件，绝不静默。
- **并发**：同 site 同时只允许一个 build run（Temporal workflow id = site id 派生，天然去重）。

## 5. Agent 架构卡（原 9 卡；卡 1「规划 planner」已按 D13 砍 → 职责拆入「编排/增量规划」确定性零模型 + designSpec，余 8 张生产 agent）

统一契约：`输入 schema → prompt（用户资料只进模板变量，防注入）→ 网关调用 → 输出 zod 校验（不过=带错误重试 ≤2）→ trace + 成本落 run`。

| # | Agent | 职责 | 输入 → 输出 | 模型（首选） | 工具/护栏 |
|---|---|---|---|---|---|
| ~~1~~ | ~~规划 planner~~ ❌**已砍 (D13)** | **职责已拆分（非删除）**：编排/预算/增量范围 → 「编排/增量规划」确定性零模型（§6·§11 D13）；"该有哪些页/每页什么结构"的设计智能 → 卡 6 designSpec（未砍）；用户自由意图改站 → M2 预留 | — | 无（确定性零模型） | 固定 DAG + 规则判定 |
| 2 | 品牌定位 brandProfile | 资料理解+全网研究 → Brand Brief | KB+店铺/官网/社媒抓取+同行参考 → 价值主张/tone/术语表/关键词/差异点 | deepseek-reasoner（研究综合）| SearXNG+Crawl4AI（已有）；**事实红线：认证/产能/年限等必须带出处，缺=留空提示用户补，绝不虚构** |
| 3 | 图片管线 imagePipeline | 产品/工厂图变"专业站点图" | 原图 → 多尺寸 webp/avif 产物 | gpt-image 系（编辑）+ gemini-2.5-pro（质检） | 确定性步骤：EXIF 剥离→**rembg 主体分割出 mask**→质量评估→生成式仅重绘 mask 外（背景/打光/白底）→超分→导出。**主体保护双保险：mask 锁定 + 生成后主体 pHash/embedding 相似度校验，主体变形=丢弃重试**；人物照默认不做生成改动 |
| 4 | 文案 copy | 每语种全站文案 | Brand Brief+页面结构+KB → locale×section 文案（含 SEO title/desc） | gemini-2.5-pro（多语言） | 术语表一致；每语种原生生成非机翻腔；禁绝对化宣称；目标市场文化禁忌 checklist |
| 5 | 动效/视频 motion/video | v1 动效参数（Ken Burns/视差=确定性零模型）；M3 Seedance 图生视频（工厂环境/产品展示 5-10s） | 图片 → 动效参数 / 视频 asset | Seedance（火山，异步任务轮询） | 每站视频条数配额；视频失败自动降级动效 |
| 6 | 审美 designSpec + aestheticReview | 生成期：DesignSpec（主题 token 选择/板块布局/图文节奏）；评审期：看整站截图挑毛病 | Brand Brief+模板 → DesignSpec；截图 → findings | gemini-2.5-pro（视觉） | Playwright 全页截图（3 断点）；评分 rubric（层次/一致性/留白/对比度/CTA 显著度），≥85 过 |
| 7 | 组装 siteAssembly + assemblyFix | 产出/修补 SiteSpec | DesignSpec+文案+素材清单 → SiteSpec；findings → SiteSpec patch | claude-sonnet-5（网关有则首选）或 deepseek-v4-pro | 输出必过 zod schema+素材引用存在性+内链有效性（确定性校验器），不过=带错误重试 |
| 8 | 审核 qa | 功能/性能体检 | 构建产物 → findings | deepseek-v4-flash（只做汇总） | **主体是确定性工具**：Playwright 遍历（链接/表单/响应式 3 断点/console error）+ Lighthouse（性能/a11y/SEO 基线分） |
| 9 | SEO seo | 技术 SEO+关键词落位 | 构建产物+Brand Brief → findings+patch 建议 | deepseek-v4-flash | 确定性检查：meta/OG/schema.org(Organization+Product)/sitemap/robots/**hreflang 多语言**/图 alt；关键词→页面映射 |

> 评审三人组（8/9/6 评审面）= GAN 式生成-评审循环（生成者改，评审者挑），有界 ≤3 轮防死循环；单维不过阈值出 findings，全过或轮数用尽即出环。
>
> ⚠️ 上表"模型（首选）"列为初稿；**终选以 §6 为准**（2026-07-14 已按能力全市场重选）。
>
> **方法论内化说明**（用户确认的路线）：生产 agent 跑在本后端，CC 生态是**开发期知识源**——各 agent 的 prompt/rubric 从对应 skills 方法论提炼固化（SEO rubric ← seo-specialist 审计清单；审美 rubric ← frontend-design-direction/design-system；动效预设 ← motion-* 系列；质量环 ← GAN harness 模式；a11y ← WCAG 清单）。工具能力以**库内化**为先（Playwright/Lighthouse/sharp/rembg 直接进 activity），MCP 只作确需外部服务时的传输选项（续 ADR「MCP=传输非授权」）。

## 6. 模型选型（**终版定档 2026-07-14**：真实评测 + 用户三轮拍板；依据与全部实测数据见 [10-model-selection-study.md](10-model-selection-study.md)）

> 本表为**唯一真值**。定档方法：三个任务形状在本地网关对活模型真实调用评测（确定性判分+延迟实测）+ 外部信源研究 + 用户拍板。「现役」列今天即可真跑（方舟 agent plan 10 文本模型 + seedream 已接通实测，deepseek 直连双档已接）；「升级位」待对应通道接入后按同套评测题复测再切。初稿的 web 调研表已被本表取代。

| Agent/用途 | 现役主选（实测背书） | 回退链 | 升级位（通道待接） |
|---|---|---|---|
| 编排/增量规划（原 planner 卡1） | **确定性零模型**（D13：固定 DAG + scope 参数 + content_hash 幂等判定——结构化输入下用模型规划=花钱买不可复现）；「站点该有哪些页面/每页什么结构」的规划智能在 **designSpec 行**（未砍，见下） | —（Temporal workflow 即规划器，可回放可审计） | M2+ 自由意图规划（工作台口语化改站需求→任务计划）：GPT-5.6 Terra / deepseek-v4-pro 预留 |
| 品牌研究综合 brandProfile | **deepseek-v4-pro** 或 **minimax-m3**（评测并列 99/100；竞品认证陷阱零踩、引文逐字核验零虚构） | glm-5.2（唯二主动消歧，审计留痕最佳） | gemini-3.1-pro（长文档检索王）/ GPT-5.6 Terra |
| 多语言文案 copy | **deepseek-v4-pro**（德语原生度评测最佳；🔴 必配护栏：`reasoning_effort:"low"` + 长度超限裁剪重写 + factSheet 白名单后校验） | glm-5.2（约束遵循最佳、零 reasoning 税）→ doubao-seed-2.0-pro | GPT-5.6 Luna / gemini-3.1-pro（claude-sonnet-5 营销语气口碑第一，8/31 前介绍价 $2/$10） |
| 站点组装/修复 siteAssembly/Fix | **glm-5.2**（应答质量满分；超时预算 180s 吸收其延迟尾部） | 三重门校验 → 超时/违规**自动回退 deepseek-v4-pro**（加压评测全满分+跨 run 同构）；低成本批量档 doubao-seed-2.0-code（须配校验重试链） | GPT-5.6 Terra / claude-sonnet-5（唯二官方 Structured Outputs） |
| 视觉评审（审美/图片质检） | **minimax-m3**（网关内唯一原生图像输入；plan 端点收图与否 M1-f 真探，不通则该维弃权降级） | doubao-seed-2.0-pro（多模态） | gemini-3.1-pro / GPT-5.6 Terra |
| qa/seo 汇总、demo v0 轻文案 | **deepseek-v4-flash**（$0.14/$0.28 全场最低价） | doubao-seed-2.0-lite | gemini-3-flash |
| 图像生成/编辑 | **doubao-seedream-5.0-lite**（方舟套餐已接通、网关真出图实测；双语文字渲染强、低成本；用户拍板暂用） | — | **gpt-image-2**（文字渲染 Elo 第一 + `images/edits` mask 局部重绘=保主体关键能力；接通后组"贵精/便宜快"双轨，含长文字图必用） |
| 视频生成（M3） | doubao-seedance-2.0（标准/fast/mini）——🔴 **需方舟 Large 档**（现档位实测不含，用户已确认后期升 Large） | 动效预设降级（确定性零模型，M1 即有） | — |
| 知识库 embedding | **BGE-M3 自托管**（Ollama 容器，1024 维；M0 已落地实测） | —（🔴 D14 合规红线：公司资料不出域，**故意不走网关**，配置层禁自由 URL） | 无升级位（换模型=按 embed_version 全量重嵌，非通道问题） |

🔴 评测出的工程硬约束（AiTask 基类内建，全模型适用）：现役全员是 reasoning 模型——`finish_reason=length && content 空`=显式失败必检（换预算/换模型重试，绝不静默）；kimi/minimax 无视 `reasoning_effort` 参数；doubao 不严守 max_tokens（预算按实际用量 settle）；kimi 双档最大输出仅 32k 不选长产出。

**网关通道现状与待接清单**：
1. ✅ **火山方舟 agent plan**（已接，2026-07-14 实测）：10 文本模型（doubao-seed-2.0 全家/kimi 双档/glm-5.2/minimax 双档）+ seedream-5.0-lite 图像；plan 专属路径 `/api/plan/*`（文本 OpenAI 型通道、图像 Custom 型完整 URL——type 45 火山适配器与 plan 路径不兼容）
2. ✅ **DeepSeek 直连**（既有）：deepseek-v4-flash/pro 双档（plan 内同名双档为尝鲜限流版，不绑避免分流）
3. ⬜ OpenAI 通道 → **GPT-5.6 Terra/Luna**（勿接 5.5，已被 5.6 三档取代）+ gpt-image-2（须确认 `images/edits` 端点转发）
4. ⬜ Google 通道 → gemini-3.1-pro + gemini-3-flash（现 Gemini 通道额度耗尽 429）
5. ⬜ Anthropic 通道 → claude-sonnet-5（可选；8/31 前介绍价窗口）

⚠️ **视频已知坑**（M3 前置）：new-api 对豆包视频任务中转有失败案例（[QuantumNous/new-api issue #2174](https://github.com/QuantumNous/new-api/issues/2174)）——接入时先升级 new-api 最新版实测；中转不稳则**方案 B**：视频 activity 后端直连火山方舟任务接口（异步轮询），key 集中配置，成本照记 `site_build_run.cost_summary`，其余模型不受影响仍统一网关。且 seedance 在 agent plan 中仅 Large/Max 档可用（已实测现档位 UnsupportedModel）。

## 7. 权限与安全（用户点名）

- **RLS**：§2 全部新表 workspace policy；worker 写走 `withWorkspace`；本功能无跨租户扫描场景（比获客侧更简单——没有平台级 ownerDb 路径）。
- **对象存储**：key 前缀隔离 + 短时 presigned URL（上传/下载都是）；禁公共桶；构建产物同样按 workspace 前缀。
- **预览（D7 已拍板：独立预览域名）**：每站一个子域 `{slug}.preview.<平台域>`——泛域名 DNS（`*.preview.<平台域>`）+ 泛证书；**预览服务**按 Host 头映射 slug→site_version 从对象存储回源静态产物。未发布 = 随机不可枚举 slug + `noindex` + 可选访问门（带 token 的链接）；发布才公开/绑正式域名。预览域与 SaaS 主域天然隔离（防 cookie 泄漏）；CSP `frame-ancestors` 白名单 SaaS 主域，前端可 iframe 嵌入工作台。
- **上传安全**：MIME 白名单、大小上限、图片一律重编码（剥 EXIF 定位隐私 + 消 payload）、文档解析在受限容器。
- **Prompt 注入**：用户上传资料/抓取内容一律当**数据**（模板变量注入），不进 system prompt；agent 输出过 schema 校验天然限制注入外溢。
- **成本**：ModelBroker 每 workspace reserve-settle + 日/月配额 + 单 build 上限；全链 trace（复用 ToolBroker 模式）。
- **内容合规**：生成文案禁虚构事实字段（§5 卡 2 红线）；广告宣称约束；用户对上传素材权属自担（ToS 条款，提请 SaaS 侧加）。

## 8. 素材与版权基线（2026-07-14 调研结论）

- **readdy.ai 结论**：它支持导出代码/Figma（付费档）并有页面级 REST API，但**没有可供第三方产品调用的"素材库"开放接口**，其模板/素材授权也不随导出转移到我们客户的商用站点——直接联动其素材库不可行。合法用法两种：(a) 开发期付费账号生成参考设计并导出，作**内部设计基准**（审美 rubric 校准、组件库借鉴），不搬素材进客户站；(b) 生产素材走下方开放授权生态。
- **开放素材生态（均免费，可商用；注意点如下）**：
  - **Unsplash**：免费，Unsplash License 商用无需署名；API 免费（production 档需申请、有速率限制）；Unsplash+ 付费专区不可用；禁原样转售。
  - **Pexels**：免费，Pexels License 商用无需署名；API 免费有速率限制。
  - **Iconify**：框架 MIT；聚合图标集绝大多数 MIT/Apache/ISC/OFL——实现时按许可**白名单过滤**（排除或自动署名 CC BY 集）。
  - **Google Fonts**：OFL 开源、免费商用；🔴 **必须自托管**——德国法院已有判例：网页远程加载 Google Fonts 向 Google 泄露访客 IP 违反 GDPR。
  - **LottieFiles**：平台素材授权混杂（Simple License/订阅内容），**v1 不依赖**——动效走自建 motion token 预设，Lottie 后期按单个素材核授权再用。
- **图库使用原则**：真实工厂/产品图永远优先（B2B 信任的核心），图库图只补氛围位；AI 生成图按目标市场透明度要求处理（欧盟 AI Act 披露义务跟踪）。
- 组件库基底：Astro + Tailwind；section 组件 v1 约 15~20 种（hero/产品网格/工厂实力/认证墙/数字带/时间线/案例/FAQ/CTA/询盘表单/页脚…），每种 2~3 布局变体 × 动效预设。

## 9. 与获客后端的闭环（未来）

- 询盘表单 → `inquiry` → outbox 事件 →（恢复获客开发后）线索进获客管线评分。
- `brand_profile`/公司事实反哺获客 ICP 配置。
- 站点分析（流量/询盘转化）作为 intent 信号回流。

## 10. 决策记录（本轮拍板）

| # | 决策 | 结论 |
|---|---|---|
| D1 | SiteSpec+组件库 vs 自由写码 | SiteSpec+组件库（用户同意推荐） |
| D2 | 视频方案 | 付费开闸：Seedance（火山）；动效保底降级 |
| D3 | 模型接入 | 全部统一走 new-api 网关 |
| D4 | 生产 agent 运行时 | 自建有界 AI Task（L2 续用），不引入 Claude Agent SDK——网关是 OpenAI 兼容协议，SDK 绑 Anthropic 协议且自主漫游不可控；详见对话记录 |
| D5 | SEO 诊断分支 | 后置 M3+ |
| D6 | 多租户隔离 | RLS + 对象存储前缀 + 签名 URL（§7） |
| D7 | 预览方式 | **独立预览域名** `{slug}.preview.<平台域>`（泛解析+泛证书+Host 回源，§7）；需与 SaaS 侧对齐平台域与 DNS/证书运维归属 |
| D8 | 模型选型原则 | 按 agent 能力需求全市场选型；**2026-07-14 终版定档**（§6 表=唯一真值：实测评比+用户三轮拍板，依据见 10 号文档）；视频=火山 **Seedance 2.0**（需 Large 档，用户将升档） |
| D9 | readdy 定位 | **修订（2026-07-14 用户拍板）：仅设计基准 → 开发期设计源**——自己账号生成→产品内导出 React/Figma→固定工序改造成 Astro 组件入封闭库（工序与 ToS 边界见 11 号文档）；运行时逐站生成否决（无公开 API+撞 D1+数据出境）；生产素材仍走开放授权生态（§8） |
| D10 | 发布部署 | **海外服务器**（免 ICP 备案）；静态托管=对象存储+CDN 优先（非 VPS）；预览国内友好线路/发布海外 CDN 双链路 |
| D11 | SiteSpec 数据形状 | 对标 **Puck**（MIT 可视化编辑器）兼容形状，渲染器自写 Astro（修订②，用户确认） |
| D12 | 模板策略 | Astro MIT 主题**改造+补缺**为基底，不从零画（修订③，用户确认）；**组件库 v1 扩容 17→26 型**（2026-07-14 用户拍板，readdy demo 缺口实证见 11 号文档：9 个小难度缺口并入 M1-e，中难度 3 个 v1.5，沉浸叙事类不进封闭库） |
| D13 | v1 编排 | **无 planner agent**：固定 DAG + 规则判定增量范围；M2+ 真需要再评估（修订①，用户确认） |
| D14 | 知识库与 embedding | **pgvector + BGE-M3 自托管**（沿 v3.0 D1 既定规格 vector(1024)/HNSW）+ **Docling** 文档解析（详见 §12）；embedding 自托管 day1 起（换模型=全量重嵌，切换成本决定不走"先 API 后自托管"） |
| D15 | 富文本 | v1 即开（用户拍板）：受限 ProseMirror JSON、不存 HTML（04 §5） |
| D16 | 交互地图 | Google Maps **Embed API**（免费无限量）+ 两步加载 GDPR 方案；Geocoding 建站期一次缓存（04 §10 申请清单） |

## 12. 知识库详设（2026-07-14 补，02 §2 kb 表的实现规格）

- **解析**：**Docling**（MIT，IBM）——Word/Excel/PPT/PDF/HTML/图片全格式，复杂表格抽取 97.9% 准度、开源基准第一（0.877）；外贸资料主流是 Word/Excel 产品表，正中其强项。中文复杂版式画册（扫描版 PDF）备选 **MinerU**（上海 AI Lab，CJK 最强 0.831），v1 不引入（KISS）。
- **切块**：结构感知——按标题层级切、表格整块保留（Docling 输出天然带文档树）；产品 SKU 表逐行成 chunk 并带表头上下文。
- **Embedding**：**BGE-M3 自托管**（MIT、1024 维、100+ 语言含中文），compose 加一个容器（Ollama/sentence-transformers，CPU 可跑）——沿 v3.0 D1 既定，**不接付费 embedding API**。理由：公司资料敏感（数据不出域）、KB 吞吐大（零边际成本）、且与获客侧 `entity_embedding` **同一向量空间**——未来"客户产品 ↔ 海外买家需求"跨域匹配的直接红利。
- **存储**：`kb_chunk.embedding vector(1024)` + HNSW（halfvec cosine）+ workspace RLS；行上记 `embed_model`/`embed_version`（换模型=按版本重嵌，不混空间）。
- **检索**：向量 + 关键词（tsvector）混合召回，agent 侧按任务取 top-k 拼 kbDigest。
- **注意**：批量上传高峰的嵌入排队走 Temporal activity 限速，不阻塞交互路径。
- **分租户护栏**（2026-07-14 用户确认）：①每 workspace 存储配额（文档数/总体积上限，防单租户塞爆）；②删除链路：用户删资料 → chunk/向量级联删除；workspace 注销 → 整库可证删除（复用获客侧 Art.17 擦除编排先例）。模型共享、数据隔离：BGE-M3 是平台统一工具，各租户向量存各自 RLS 隔离行，检索只命中本 workspace。
- **分租户护栏（2026-07-14 用户确认）**：①每 workspace 存储配额（文档数/总体积上限，防单租户塞爆）；②删除链路：删资料 → chunk/向量级联删除；用户注销 → 整 workspace 知识库可证删除（复用获客侧 Art.17 擦除编排先例）。
- **Embedding 策略定案（用户确认）**：**第一天即 BGE-M3 自托管**，不走"先付费 API 后切换"——换 embedding 模型=全库重嵌+改列维度，切换成本才是大头；扩容路径=同模型加 GPU/副本（零重嵌）。生成类模型才是付费 API 起步，两条曲线策略相反。

## 11. 补充能力清单（2026-07-14 主动补全，纳入各里程碑）

1. **站点分析**：自托管 Plausible/Umami（免 cookie banner、GDPR 友好）——访问/询盘漏斗数据回流平台（M2）。
2. **隐私合规页**：Privacy Policy/Cookie 政策页按目标市场模板自动生成；询盘表单 GDPR 同意勾选（M1 组件库内置）。
3. **RTL 支持**：目标市场含中东（阿语/希伯来语）时组件库需 `dir=rtl` 变体——**v1 组件库设计期就要定**，后补成本高。
4. **无障碍**：欧盟 EAA（2025 生效）合规压力真实存在；审核 agent a11y 检查按 WCAG 2.2 AA 基线（M2）。
5. **表单反垃圾**：蜜罐字段 + Cloudflare Turnstile（免费、较 reCAPTCHA GDPR 友好）（M2）。
6. **询盘通知邮件**：发信域 SPF/DKIM/DMARC（M2）。
7. **发布 CDN**：发布站挂 CDN（Cloudflare 免费档起步）+ 图片按需变换（M2+）。
8. **质量评测基线（eval harness）**：golden set（N 家真实企业脱敏资料）+ rubric 自动打分回归——每次改 prompt/换模型跑回归防退化；**AI 产品工程化的关键一环**（M1 起建）。
9. **模板冷启动**：开发期用 CC 的 GAN 设计循环（gan-design/theme-factory）批量产行业模板+人工终审——模板质量决定 demo v0 第一印象（M0 的核心工作量）。
10. **内容安全审核**：用户上传图+生成文案过安全审核后才上站（M1）。
11. **SiteSpec 版本化**：`specVersion` 字段+迁移器，保老站向后兼容（M0 起）。
12. **观测**：build 成功率/时长/单站成本 dashboard（M1）。
13. **多站点预留**：schema 1:N（workspace→sites），v1 UI 限 1 站。
