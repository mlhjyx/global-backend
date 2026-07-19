# Site Builder Agent 详细设计 v1

> 配套 [02-architecture.md](02-architecture.md)（§4 编排、§6 模型路由）。本文件是站点生产 agent 的实现级设计：每张卡给足 职责/输入输出/执行流程/prompt 内化来源/工具/护栏/降级，可直接照卡开发。**卡 1 planner 已按 D13 砍（v1 不实现），余 8 张为生产 agent（对应 as-built 7 个 task id，见 §0.4）。**
> Agent 卡**只绑定 `modelProfile`，不绑定供应商型号**。as-built 真值以 `apps/api/src/site-builder/agents/task-routes.ts` 的 active route 为准（见 §0.4）；ADR-020 是已批准 target portfolio，但只有 BrandProfile 已经逐任务评测成为代码级 `promotedRoute`，其余仍待。换型号只改 ModelPolicyRegistry，并保存 model snapshot；不得散落回卡片。
> **卡 1 planner 已按 D13 砍**——职责拆分归位（编排/预算/增量范围 → 「编排/增量规划」确定性零模型；"该有哪些页/每页什么结构" → 卡 6 designSpec；用户自由意图改站 → M2 预留），**v1 不实现，卡片保留仅作历史与 M2 参考**。

## 0. 统一运行时契约（AiTask 基类，所有 agent 共用）

```
AiTask<I, O>：
  1. 输入 zod 校验（fail fast）
  2. prompt 组装：system(固化的角色+rubric) + 模板变量注入(用户数据只进变量位，防 prompt 注入)
  3. 预算 reserve（ModelBroker：workspace 日/月配额 + 单 build 上限）
  4. 网关调用（new-api，按 §6 模型路由；结构化输出走 JSON schema 约束）
  5. 输出 zod 校验 → 不过 = 带校验错误重试（≤2 次，错误文本回填给模型）
  6. settle 实际成本 → site_build_run.cost_summary；全链 trace(输入摘要/模型/tokens/耗时)
```

- **通信模型**：agent 之间不对话，只传**结构化工件**（BuildPlan / BrandBrief / DesignSpec / SiteSpec / Findings），全部落库可追溯——总控（Temporal workflow）是唯一的调度者。
- **Prompt 管理**：每个 agent 的 system prompt + rubric 是**版本化代码资产**（`agents/<name>/prompt.ts`），从当前 Codex 已安装 skills 的方法论内化固化（各卡注明来源）；改 prompt 必须过 eval harness 回归（02 §11.8）。skills 只服务开发过程，生产运行时不依赖 Codex/plugin。
- **工具原则**：库内化优先（进程内直接调），MCP 只在确需外部服务时作传输（续 ADR「MCP=传输非授权」）。

### 0.1 每 task 声明合同（v3.2 §5.3 回写）

每个 AiTask 除运行时基类外，须**版本化声明**下列元数据（缺项不得上线）：

- `taskId`、`owner`（负责的逻辑 Agent，见 §0.5）、input/output **schema version**、**prompt version**、**rubric version**。
- `modelProfile`、allowed capabilities/tools、`timeout`、`maxTokens`、`maxCost`。
- `fallback`/降级策略、**确定性 post-checks**、PII/数据区域策略。
- `currentRoute` / `candidate` / `promotedRoute` **只由 ModelPolicyRegistry 解析**，Agent 卡**不写供应商型号**。

### 0.2 型号绑 profile，不绑型号（v3.2 §1.6/§5.3/§23.4 回写，引 ADR-016）

task 只引用稳定的 **`modelProfile`**（16 档：`deterministic` / `structured.default` / `reasoning.high` / `copy.premium` / `text.bulk` / `multimodal.review` / `text.summary` / `image.precise_edit` / `image.bulk.creative` / `image.premium.design` / `video.primary` / `video.premium` / `speech.production` / `transcription` / `moderation.media` / `embedding.private`），由 registry 映射到当下 snapshot。换型号不改 Agent 卡；所有 alias 运行时解析到 snapshot，ReleaseManifest 存 snapshot 以支持历史重放与回归定位。

ADR-020 的目标映射是：`structured.default → gpt-5.6-terra / claude-sonnet-5`，`reasoning.high → gpt-5.6-sol / deterministic safe blueprint`，`copy.premium → claude-sonnet-5 / gpt-5.6-terra`，`multimodal.review|text.summary → gemini-3.5-flash / gpt-5.6-terra`；图片/视频/embedding 的映射见 02 §6。profile target 不是整档自动切换指令；目前只有 BrandProfile 用该 structured.default 组合完成逐 task 晋级。

### 0.3 每次执行记录（可观测，v3.2 §5.3 回写）

每次 task 执行落库：run/workspace/site、routePolicy/provider/model/**modelSnapshot**/fallbackIndex、prompt/schema/rubric 版本、input/output **hash**、tokens/latency/cost/finishReason/providerRequestId、状态/错误、artifact ids。**模型原始输出先过 schema/事实/引用/安全门再入库或进 Renderer**；`finish_reason=length`、空 content、schema 不合、capability 不符必须是显式错误码（非静默降级）。

### 0.4 as-built 路由表与新增 task 边界（v3.2 §2.1/§23.5 回写）

**as-built（`task-routes.ts`，7 个 task id，逐 task active route，非永久终选）**：

| task id | 对应卡 | active primary | fallbacks | state / maxTokens / timeout |
|---|---|---|---|---|
| `site_builder.brand_profile` | 卡2 | gpt-5.6-terra（Responses） | claude-sonnet-5（Messages） | promoted；12k / 240s；可回 DeepSeek Pro→GLM |
| `site_builder.copy` | 卡4 | deepseek-v4-pro（reasoning low） | glm-5.2, doubao-seed-2.0-pro | current；4k / 120s |
| `site_builder.design_spec` | 卡6（生成） | minimax-m3 | doubao-seed-2.0-pro | current；4k / 120s |
| `site_builder.assemble` | 卡7（组装） | glm-5.2 | deepseek-v4-pro | current；16k / 180s |
| `site_builder.assembly_fix` | 卡7（修复） | glm-5.2 | deepseek-v4-pro | current；8k / 180s |
| `site_builder.qa_summarize` | 卡8 | deepseek-v4-flash | doubao-seed-2.0-lite | current；3k / 90s |
| `site_builder.seo_review` | 卡9 | deepseek-v4-flash | doubao-seed-2.0-lite | current；3k / 90s |

- **卡片旧标注（gemini-3.1-pro / gpt-image-2 等）与 as-built 路由不一致**：以本表为准；回退链=合法路由（AiTask 基类逐模型尝试），非静默降级。BrandProfile 的 EvidenceRef v2 任务硬门失败也会进入 Sonnet fallback。
- **未落地为 task 的卡**：卡3 imagePipeline（M1-c 纯 Sharp 确定性，无模型 task；生成式媒体 task 进 M1-c2/M3，引 ADR-018）、卡5 motionVideo（M3）、卡6 的 **aestheticReview 目前无独立路由**——`site_builder.aesthetic_review` 到 M1-f 才增（v3.2 §2.1）。
- **新增 task 复用 AiTask/MediaGateway，不新增自治框架**（v3.2 §23.5）：M1-f 增 `site_builder.aesthetic_review`；M1-d 可增 `site_builder.localize`；媒体 image/video/audio task 进 M1-c2/M3。均走同一 AiTask 基类 + MediaGateway，**不另建 Agent runtime**。

### 0.5 逻辑 Agent 归组、确定性服务与审核三角（v3.2 §5.1/§5.2/§5.4 回写）

现有 task id **不重命名**，只在文档 / owner / trace 上归为 4 个逻辑 Agent：

| 逻辑 Agent | 含 AiTask | 责任 | 禁止 |
|---|---|---|---|
| Brand & Evidence | brand_profile、claim_projection（目标） | 品牌、术语、引用、gaps | 不批准 Claim；不输出具名个人 |
| Content & SEO | copy、localize（目标）、seo_review | 多语言文案、FAQ、metadata、Schema 文本 | 只消费允许公开的 ClaimSnapshot |
| Visual Media Director | image_*（选/质检/编辑）、video_*、aesthetic_review（目标） | 媒体用途、编辑 brief、多模态质检 | 不改原件；证书/人像/Logo 禁生成式改造 |
| Site Composer & Fixer | design_spec、assemble、assembly_fix | Archetype/Family、组件、SiteSpec、受限 JSON Patch | 不生成代码；不绕过白名单 |

**确定性服务（非 Agent，无人格 / 模型自由度 / 自主规划权）**：Workflow Orchestrator、Budget Guard、SiteSpec Validator、Asset Processor、Safety/License Gate、Accessibility/Performance Scanner、Release Manager、Publisher/Domain Manager、Analytics/Event Collector。

**不设 Planner + 审核三角**（续卡1 D13、v3.2 §5.4、引 ADR-013）：固定建站由 DAG/scope/规则选择，不设 Planner；M2 自由语言改站只增 `edit_intent` → 受限 PatchPlan（不获任意编排或代码生成权）。**QA / SEO / Aesthetic 是三个独立视角，生成者不得给自己打最终分**；修复者只消费**冻结** finding、输出 allowlist JSON Patch，**每轮必须让硬门单调改善，最多三轮**（详见卡7）。

## 1. planner —— 规划　❌ 已砍（D13，v1 不实现，仅历史记录）

> **本卡 v1 不实现**。按 D13（修订①，2026-07-14 用户确认）取消独立 planner agent——原职责**拆分归位**而非删除：**编排/预算取舍/增量范围** → 「编排/增量规划」确定性零模型（固定 DAG + 规则判定，见 02 §6）；**"该有哪些页 / 每页什么结构"的设计智能** → 卡 6 designSpec（未砍）；**用户口语化自由改站的意图 → 计划** → M2 工作台再引入（02 §6 已留槽）。以下内容保留仅作历史与 M2 复活参考。

- **职责/触发**：每次 build run 开头；把「站点档案+资料清单+用户选项」翻译成本次要执行的任务清单与参数。
- **输入 → 输出**：`{siteProfile, assetInventory, userOptions(风格/页面开关/语言/scope), lastBuildSummary?}` → `BuildPlan{tasks:[{type, params, priority}], estimatedCost, skipReasons[]}`。
- **执行流程**：[确定性] 汇总资料清单与增量 diff（哪些素材是新的）→ [模型] 产出 BuildPlan → [确定性] 白名单校验（task type 必须∈注册表）+ 成本预估对配额。
- **Prompt 内化来源**：编排任务分解方法论 ← 当前已安装的 `ecc:plan-orchestrate` + 本仓 discovery queryPlan 先例（确定性注入、LLM 不臆造）。
- **工具**：无外部工具（纯推理）。
- **护栏**：只能从任务白名单选；scope=section 时禁止扩大到整站；预算超限直接裁剪低优任务并在 plan 里写明 skipReasons。
- **降级**：模型失败 → 规则版兜底 plan（全量标准管线），不阻断。
- **modelProfile**：`deterministic`（v1 无模型）；M2 若复活自由意图规划，另绑 profile 并走新 ADR/评测。

## 2. brandProfile —— 品牌定位

- **职责/触发**：P1；资料变化或首次精装修时产出/更新 Brand Brief（所有内容 agent 的上游）。
- **输入 → 输出**：`{kbDigest(注册+向导+上传资料摘要), storefrontData?, webResearch[]}` → `BrandBrief{valueProps[], tone, glossary(EN+各语种术语), keywords[], differentiators[], competitors[], factSheet{认证/年限/产能…每项带 evidence 出处}, gaps[](缺失待用户补的信息)}`。
- **执行流程**：[确定性] KB 检索拼摘要 → [确定性] SearXNG 搜公司名/店铺/社媒 + Crawl4AI 抓取（复用 compose 现成基建）→ [模型] 综合产出 Brief → [确定性] factSheet 逐项校验 evidence 非空，无源字段移入 gaps。
- **Prompt 内化来源**：品牌/定位方法论 ← 当前已安装的 `ecc:brand-voice`、`ecc:market-research`（定位画布、tone 光谱、术语表法）；B2B 外贸语境 ← `ecc:lead-intelligence` 的公司画像结构。
- **工具**：SearXNG(HTTP) + Crawl4AI(HTTP)，库内化 client 已有。
- **Evidence 2.0 基础护栏（R4-A1，✅ 2026-07-17 当前交付分支）**：模型调用前先冻结经 PII 清洗、NFC/LF 规范化和有界截断的 intake/KB/storefront/research 语料；KB source 精确到 document/asset/chunk/hash，web 正文使用服务端重算的完整 SHA-256。SearXNG 上游 title/snippet/path/query/fragment 不进入冻结语料或 provenance，只生成「站主公司名 + external origin」最小 `research_hint`，防第三方具名个人落入不可变账本。新 factSheet 事实必须由服务端绑定 `EvidenceRefV2{sourceId,sourceType,sourceRole,contentHash,quote,selector}`，quote 须 8–512 code point 且精确命中冻结 source；未知 source、类型/hash 不符或无 quote 一律降 gap。prompt 只暴露服务端 source ID/type/role/hash 与语料，不暴露 URL、标题或个人联系信息。旧 v1 BrandProfile 仅兼容读取，不伪造 provenance。
- **事实真值/内部消费护栏（R4-A2，✅ 2026-07-19 当前交付分支）**：公共企业事实 allowlist、PII/未消歧案例与 value/quote 关键值门把失败项和所有 `research_hint` 降 gap。fact key 必须原样满足严格 lower_snake_case，schema/gate/投影与 EvidenceRef/Claim 约束均不做静默归一。通过项以稳定分域 key 关联共享 Claim/Evidence，不可变 FORCE RLS bridge 与 exact trigger 锁定同 company 的 BrandProfile/EvidenceRef/source/selector/asset；认证还须 live ready cert Asset。机器 Claim 从 `NEEDS_REVIEW` 开始；审批先锁 Claim 并预检 exact bridge，数据库 security-definer trigger 在同一事务锁 surviving bridge，孤立 Claim 和直写均 fail-closed，manual/legacy null identity 保持兼容。Workspace 仍有 Site 时物理删除被拒，cert Asset 删除扫描由 partial ordered covering index 支撑；status/version CAS 与 outbox 原子性不变。M1-d 已在该内部桥上建立不可变 snapshot/CopyBundle/SiteSpec 消费者，但仍没有公开 claim projection API。
- **产物治理（幂等 + 溯源，v3.2 §24.7 / R4-B-min 与 M1-d 回写）**：BrandBrief 新增 `buildRunId`(唯一引用) / `inputHash` / `promptVersion` / `model·route` / `sourceSnapshotHash` / `usage·cost` 六字段；**同一 `buildRunId` 重试先复用已有成功 BrandBrief，不重复调模型、不追加版本**。R4-B-min 已提供 DB 持久 `reserve/settle`、task attempt fencing 与人工停用开关，M1-d 的 locale fan-out 已复用；`SiteBuildRun.costSummary` 是持久聚合真值（含成功/失败调用、schema repair、timeout、fallback、工具成本），进程内 Map 不算生产真值。
- **降级**：web 研究失败 → 仅用 KB 资料出 Brief 并标记 `researchDegraded`。
- **modelProfile**：`structured.default`。as-built 型号只见 §0.4；目标型号只由 ADR-020 registry 映射。

## 3. imagePipeline —— 图片管线

- **状态**：M1-c 已于 2026-07-17 在当前交付分支落地并完成开发环境验证；它是确定性 Asset Processor，不新增 AI Task。是否进入 `main` 仍以 PR/CI/合并证据为准，合同与安全边界以 **ADR-018 + [14](14-media-foundation-mf0.md)** 为准。
- **职责/触发**：P2；每张用户图（产品/工厂/团队/证书）→ 安全、可追溯、响应式的站点派生件。
- **输入 → 输出**：`{assetId, kind, targetUsage(hero/grid/gallery…)}` → `AssetVariant[] + DerivedImageManifest`（AVIF/WebP/fallback，多尺寸，带 recipe/checksum/provenance）。
- **M1-c 固定序（纯 Sharp）**：MIME/像素/解码炸弹检查 → 自动方向/sRGB → 解码重编码并剥 EXIF/GPS → 模糊/曝光/噪点质量门 → 安全裁切/focal point → 320/640/960/1440/1920 响应式导出 → `AssetVariant`/兼容 manifest 持久化。
- **工具**：M1-c 仅 `sharp` + 对象存储/校验器；**不调用模型**。
- **护栏**：原件 immutable；content/recipe hash 幂等；人物照只做确定性裁切/调色；证书、Logo、标签与参数图不做生成式改造；单图失败隔离，仅必需 Hero 无 fallback 才阻断。
- **降级**：派生失败时保留原件并给出显式 gap/错误；不得伪造成功 Variant，不得覆盖原件。
- **后置研究（非 M1-c）**：rembg mask、Real-ESRGAN、生成式背景重绘、视觉模型质检和 pHash/embedding 主体保护只作为 M1-c2/M3 候选。只有出现真实消费者、用户同意、权利/成本/能力门与独立 feature flag 后，才另开 PR 评测；本卡不把它们描述为当前工具链。

## 4. copy —— 多语言文案

- **职责/触发**：P2；按语种×页面产出全站文案（含 SEO 元信息）。
- **输入 → 输出**：`{brandBrief, pageStructure, locale, kbDigest}` → `CopyBundle{sections{[sectionId]: {headline, body, cta…}}, seo{title, description, ogTitle…}, hreflangHints}`（每 locale 一份）。
- **执行流程**：[确定性] 按页面结构生成待填槽位清单 → [模型] 整页语境一次生成（非逐句翻译，每语种独立原生写作）→ [确定性] 槽位完整性+长度约束校验（headline ≤N 字符等，组件布局依赖）→ [模型] 超长项定向重写。
- **Prompt 内化来源**：B2B 文案结构 ← `ecc:marketing-campaign`/`ecc:content-engine`（价值主张→痛点→证据→CTA 框架）；SEO 写法 ← `ecc:seo` skill 的 title/desc 规范；多语言 tone ← brandBrief.tone + 目标市场文化禁忌 checklist（固化为 per-market 附录）。
- **工具**：无外部工具。
- **护栏**：术语表强一致（glossary 注入）；禁绝对化宣称（"best/No.1"类）与虚构事实（只能引用 factSheet，引 ADR-017）；每语种输出过字符集/方向 sanity（阿语 RTL 标记）。
- **内容预算与最小询盘合同（M1-d，✅ 2026-07-19）**：Copy 按 **slot / locale / Claim refs** 生成，事实来源唯一为 immutable PublishableClaimSnapshot；无 exact Site bridge、撤销/到期/审批漂移均 fail-closed。模型只建议 slot refs；代码过滤未知/重复/超预算 ref，带 ref 时重建 Claim statement 逐字确定性表示，无支持事实时忽略自由输出并使用中性文案。完整 bundle 校验后才完成 R4-B task attempt；槽位以 grapheme 硬预算和 restricted rich text 校验，超限不截断。`en/de-DE` 使用独立 task attempt，空 snapshot 使用可重放中性文案；权威局部 build 必须覆盖完整 active locale 集。SiteSpec 的 `copyBundleSet` 是新真值，legacy 字符串只在无新集合的旧行上读取。最小 inquiry / consent / future outbox payload 已定义，但表单仍 disabled，公网接收/投递属于 M2。DI-0 只能消费 slot budget/locale 合同，不得提供事实或改文案。
- **降级**：某语种失败 → 该语种缺席本轮（站点先上已成语种），标记待重跑；**Demo 快路径 copy polish 失败 → 直接用 deterministic copy，不阻断 Demo 生成**（v3.2 §18.2）。
- **modelProfile**：高价值文案/本地化=`copy.premium`；低风险批量=`text.bulk`。as-built 型号只见 §0.4。

## 5. motionVideo —— 动效与视频

- **职责/触发**：P2；给图片素材配动效参数（v1）与生成环境视频（M3）。
- **输入 → 输出**：`{assets[], brandBrief.tone}` → `{motionSpecs{[assetId]: preset+params}, videoAssets[]?}`。
- **执行流程**：v1 [确定性] 按素材类型/位置套 motion token 预设（hero=Ken Burns 慢推、gallery=视差、数字带=计数动画）；M3 [模型-视频] 经 MediaGateway/new-api 调 `video.primary` 图生视频：提交任务→轮询→产物落 asset。
- **Prompt 内化来源**：动效预设库 ← 当前已安装的 `ecc:motion-foundations`、`ecc:motion-patterns`、`ecc:motion-advanced`、`ecc:make-interfaces-feel-better`（缓动曲线/时长档/克制原则——B2B 站动效克制是纪律）。
- **工具**：MediaGateway + new-api；当前无 M3 as-built 路由。MediaGateway 只可调用 new-api：M3 前若 new-api→Ark 异步任务能力探针失败，`video.primary` 不晋级并使用确定性动效/静态降级。后端直连 provider 当前未获批准；未来必须先有独立 ADR、集中控制面实现和真服务验证，严禁散落 provider fetch。
- **护栏**：每站视频条数配额（成本 ~1 元/秒）；视频 prompt 只描述镜头运动与氛围、不得虚构厂景内容之外的元素。
- **降级**：视频失败/超时 → 自动回落该位置的动效预设，站点永远有东西可看。
- **modelProfile**：M1=`deterministic`；M3=`video.primary`（ADR-020 目标由 registry 解析）。

## 6. designSpec + aestheticReview —— 审美（双角色）

- **职责/触发**：生成期（P3 头）产 DesignSpec；评审期（P4）看整站截图挑毛病。
- **输入 → 输出**：生成 `{brandBrief, industryTemplate, userStylePick}` → `DesignSpec{themeTokens, pageLayouts{[page]: section 顺序+变体}, imageryDirection, motionIntensity}`；评审 `{screenshots(3 断点全页), designSpec}` → `Findings[{severity, page, section, issue, suggestion}] + score(0-100)`。
- **执行流程**：生成期 [模型] 从主题 token 预设包+布局变体中**选择与微调**（不发明新组件）→ [确定性] token 合法性校验（对比度 WCAG AA 自动检查）；评审期 [确定性] Playwright 截图（375/768/1440 三断点全页）→ [模型-视觉] 按 rubric 打分出 findings。
- **Prompt 内化来源**：设计方向法 ← 当前已安装的 `ecc:frontend-design-direction`（direction→tokens 流程）；token 体系 ← `ecc:design-system` + `product-design:ideate`；评审 rubric ← `product-design:audit` + `ecc:frontend-a11y`（视觉层次/一致性/留白/对齐/CTA 显著度五维，各 0-20）。
- **工具**：Playwright（库内化截图；开发期可用已安装的 `playwright-interactive` / `ecc:browser-qa` 现场调试，生产不依赖 Codex/plugin/MCP）。
- **护栏**：只能在预设 token 空间内选择（保风格体系一致）；score ≥85 过，findings 必须落到具体 section（不许"整体感觉不好"式空评）。
- **DesignSpec 职责边界（v3.2 §19.2 回写，引 ADR-015/ADR-019）**：DesignSpec **只**从候选 Family 中选 Blueprint / StylePreset / 组件变体，按素材/事实/文案长度取舍并**解释选择原因与风险**。**禁**：写 JSX/Astro/CSS、发明组件类型、生成无证据支撑的 section、更改工作流、自己抓取 Readdy。
- **受控差异化 7 来源（v3.2 §17.3 回写）**：每次生成的差异**只**来自 ① BusinessArchetype ② TemplateFamily ③ Blueprint ④ StylePreset ⑤ 组件 variant ⑥ 素材完整度 ⑦ `variationSeed`。**`variationSeed` 只能在合法候选中做确定性选择，不能改变事实和组件契约**（反"换皮同版式"通用感；配套 M1-f genericness 检查见 02/08）。
- **审美评审隔离（aestheticReview，v3.2 §23.5 回写）**：评审与生成**必须隔离**——不同 prompt/rubric，**最好不同 provider**；评审**只看冻结截图 + DesignBrief + 事实摘要 + deterministic findings**，输出 `DesignEvaluation` + 结构化 Findings（禁"好看/不好看"自由文本）。**多模态能力探针失败**时审美维**弃权**、确定性 QA 继续、Release 标 `aesthetic_review_unavailable`（不阻断发布门其余维度）。
- **降级**：评审失败 → 该维弃权（不阻断质量环其余维度）。
- **modelProfile**：生成=`structured.default`；评审=`multimodal.review`。as-built 生成型号见 §0.4；aestheticReview 到 M1-f 才新增 task。

## 7. siteAssembly + assemblyFix —— 站点组装（生成+修复双模式）

- **职责/触发**：P3 产出 SiteSpec；P4 质量环内按 findings 出 patch。
- **输入 → 输出**：组装 `{designSpec, copyBundles, assetManifest, pageStructure}` → `SiteSpec`（完整 JSON）；修复 `{siteSpec, findings[]}` → `SiteSpecPatch`（JSON Patch，最小变更）。
- **执行流程（八道校验门顺序，v3.2 §19.3 回写，引 ADR-014/ADR-015）**：[模型] 生成 SiteSpec/Patch → [确定性] 依次过 **① Zod / JSON Schema → ② 组件 + variant 白名单 → ③ 素材引用存在性（assetManifest 对账）→ ④ copy key 完整性 → ⑤ 内链 + locale 完整性 → ⑥ 证据门 → ⑦ 兼容矩阵（见下）→ ⑧ Astro 构建**；任一门不过=带结构化错误回填重试（构建期编译错误同样回填）。
- **兼容矩阵（Assembler 调模型/写 SiteSpec 前必过的 11 条硬约束，v3.2 §17.2 回写）**：① full_bleed Hero 后不接另一个 full_bleed ImageText；② 禁连续三个 card-grid；③ 深色大区块连续最多两个；④ StatsBand 需 ≥2 个有证据数值否则删；⑤ Testimonials 需用户可验证引用否则删；⑥ TeamGrid 需明确授权人物资料否则删；⑦ Certificates/CertWall 需资产或事实证据否则删；⑧ MapLocation 需可验证地址，否则只显地址文本；⑨ 产品 <3 不用 dense ProductGrid；⑩ 缺宽图不选 full_bleed Hero；⑪ 文案超预算优先换变体/定向重写，禁 CSS 缩到不可读。（无证据的 section 一律删，不留空壳。）
- **Prompt 内化来源**：组件组装约束 ← 我们自建组件库的 section 目录文档（prompt 里给组件清单+props 契约，"菜单点菜"式）；修复模式 ← `build-web-apps:frontend-testing-debugging` 的定位/最小改动原则（只改 findings 涉及的节点）。
- **工具**：SiteSpec 校验器、Astro 构建器（库内化）。
- **护栏**：修复模式**只接受结构化 Findings、只许输出 JSON Patch 或受限 SiteSpec Patch**（防重写全 spec 引入回归）；每轮 patch 后 diff 记录进 run steps（可审计谁改了什么）；**每轮必须让硬门单调改善**。
- **降级（assemblyFix 三轮修补失败语义，v3.2 §19.3 回写，引 ADR-013）**：assemblyFix **最多三轮**；三轮仍失败则——**保留最近一次可构建版本** + 标 `quality_degraded` + **回退到同 Family 的安全 Blueprint** + **绝不删除用户现有站点**（ADR-013：异步失败绝不删除用户现有 Site）。run 标记 partial、findings 转人工。
- **modelProfile**：首次组装/普通修复=`structured.default`；连续两次失败后才允许 `reasoning.high` escalation；再失败走确定性安全 Blueprint。as-built 型号见 §0.4。

## 8. qa —— 审核

- **职责/触发**：P4；功能与性能体检。**主体是确定性工具，LLM 只做汇总**——不靠模型幻觉挑毛病。
- **输入 → 输出**：`{previewUrl, siteSpec}` → `Findings[] + gateResult{pass/fail per check}`。
- **执行流程**：[确定性] Playwright 遍历：全链接可达、表单可提交（干跑）、三断点响应式无横向溢出、console 零 error、动效触发正常（滚动驱动检查）→ [确定性] Lighthouse：Performance/A11y(WCAG 2.2 AA 基线)/SEO/Best-Practices 四分 → [模型] 把机器结果汇总成结构化 findings（归并、定级、给修复建议）。
- **Prompt 内化来源**：检查清单 ← 当前已安装的 `playwright`、`ecc:e2e-testing`（关键路径遍历法）、`ecc:browser-qa`、`ecc:frontend-a11y`/`ecc:accessibility`（WCAG 2.2 检查项）、`ecc:click-path-audit`（询盘路径必须 ≤2 击可达）。
- **工具**：Playwright + Lighthouse（库内化，CI 同款）；开发期调试用已安装的 `playwright-interactive` / `ecc:browser-qa`。
- **护栏**：硬门槛（构建产物必须过才能出质量环）：链接零死链、表单可用、console 零 error、Lighthouse Perf ≥85 / A11y ≥90。
- **降级**：无（这是门，门坏了要修门不是绕门）；工具自身崩溃 → run 失败可重试。
- **modelProfile**：确定性工具结果汇总=`text.summary`；三断点审美/媒体 Finding=`multimodal.review`。as-built 型号见 §0.4。

## 9. seo —— SEO

- **职责/触发**：P4；技术 SEO 与关键词落位（发布前保证"生而可被搜到"）。
- **输入 → 输出**：`{previewUrl, siteSpec, brandBrief.keywords, locales}` → `Findings[] + patchSuggestions[]`。
- **执行流程**：[确定性] 逐页检查：title/description 长度与唯一性、OG 卡、canonical、**hreflang 互指完整**、sitemap.xml、robots、图片 alt 覆盖率、schema.org(Organization+Product+BreadcrumbList) JSON-LD 合法性 → [模型] 关键词→页面映射审查（keywords 是否落到 title/H1/正文，密度不过量）。
- **Prompt 内化来源**：审计清单 ← 当前已安装的 `ecc:seo`（技术 SEO 全表）；结构化数据经验 ← 本仓获客侧 digital_footprint 的 JSON-LD 解析（反向应用：我们抓别人时看什么，就给客户站配什么）。
- **工具**：HTML 解析器 + JSON-LD 校验（库内化）。
- **护栏**：多语言站 hreflang 是硬检查（错配=国际 SEO 灾难）；未发布预览必须 noindex（防提前收录），发布时自动翻转。
- **降级**：无硬门（findings 进质量环修复即可）。
- **modelProfile**：`text.summary`；硬门保持确定性。as-built 型号见 §0.4。

## 10. 研究依据与设计修订（2026-07-14 补研；修订①②③待用户确认后定稿）

1. **对标 Anthropic《Building Effective Agents》**（agent 工程的业界公认基准）：它区分 workflow（预定义代码路径编排 LLM）与 agent（LLM 自主决定路径），并强调"最成功的实现不用复杂框架，用简单可组合的 pattern"。我们的设计属 workflow 系——质量环 = 其 evaluator-optimizer 模式、P2 素材并行 = parallelization 模式，两处都是被验证的正确形状。
   - **修订①：v1 取消 planner agent（9 卡 → 8 卡 + 1 个规则模块）**。orchestrator-workers 模式适用于"子任务不可预测"的场景；建站的子任务完全可预测（页面/素材/文案是确定集合），M0/M1 用**固定 DAG + 规则判定增量范围**即可，省一次模型调用、少一个不确定源。M2+ 若出现真不可预测场景再评估引入。
2. **业界建站产品对标**：市场三分——design-first（Framer/Webflow）、business all-in-one（Wix ADI/Durable/10Web）、code-first（v0/Lovable/Bolt）。Wix ADI 的"问卷 → 生成 → 可视化微调"与 Durable 的"30 秒出站"分别验证了我们的 intake 问答路线与 demo v0 秒出路线；我们的定位 = business all-in-one 里的 **B2B 外贸工厂询盘站细分**，暂无专精直接竞品。
3. **修订②：SiteSpec 数据形状对标 Puck**（MIT 开源 React 可视化编辑器，JSON in/JSON out、自托管零锁定，2026 活跃）。SiteSpec 采用 Puck 兼容形状（content/zones/components+props）：(a) schema 设计被市场验证；(b) **SaaS 前端将来做"用户手动微调"编辑器可直接嵌 Puck 编辑器组件**，与我们后端数据天然互通，前端工作量骤降。渲染端仍 Astro 静态构建（数据形状兼容、渲染器自写，不引 React 运行时进客户站）。
4. **修订③：模板不从零画**。Astro 官方主题库多款 MIT 免费商用（Astrofy/Foxi/Odyssey business/shadcn+Tailwind 4 corporate 系）——M0 选 2~3 款改造成参数化行业模板，比手搓 15~20 个 section 快一个量级，§8 组件库条目相应调整为"改造+补缺"。
5. **框架选型确认（研究后维持自建）**：对比 Mastra（TS 原生，Replit/PayPal/Adobe 生产在用，workflows/evals/observability 一等公民）与 LangGraph.js（TS 版滞后 Python 4-8 周）。结论：**维持 Temporal + 自建薄 AiTask**——引入 Mastra 与 Temporal 双编排打架（KISS），其统一模型路由价值与 new-api 网关重叠；但**借鉴其"evals 一等公民"**思想建 eval harness（02 §11.8）。
6. **补充建议（研究联想）**：
   - **国内访问链路**：预览是给国内工厂用户看的（国内友好线路/SaaS 反代），发布站是给海外买家看的（海外 CDN）——两条链路受众不同，别用一套 CDN 方案；与前端/运维对齐。
   - **每站成本单（SaaS 定价依据）**：demo v0 ≈ ¥0.5 内；精装修一轮 token ≈ ¥5-15；图片 gpt-image-2 中档 ≈ ¥0.4/张 × N；视频 ¥15/条 × N。全配一次 ≈ ¥50-60、纯图文 ≈ ¥15——SaaS 侧按次数/配额设计套餐有了底数。
   - **狗粮灰度**：golden set 里放 2~3 家真实合作工厂资料，每个里程碑先给"自己人"全链跑通再放量。

## 11. 开发期 Codex 工作流（内化的"生产线"）

生产运行时零 Codex/plugin 依赖；开发这些 agent 时使用仓库代码、确定性工具和当前已安装 skills：
1. 模板/组件库：`product-design:ideate` + `ecc:design-system` 提出候选，`product-design:audit` 独立评审，人工终审后才入封闭组件库。
2. Rubric 提炼：用 `ecc:seo` / `ecc:frontend-design-direction` / `ecc:accessibility` 输出方法框架，再固化成版本化 prompt 常量与确定性检查表。
3. Eval harness：`ecc:eval-harness` / `ecc:verification-loop` 驱动 golden set 全管线基线；以后每次改 prompt/模型均先回归再合并（02 §11.8）。
4. 联调验证：真库真网关 verify 脚本（§5 硬规矩同获客侧），用 `playwright` / `playwright-interactive` 现场核验渲染结果；生产不依赖 MCP。

### 11.1 开发期 8 个 Codex 设计角色分工（v3.2 §14.1 回写）

这些是**开发期 Codex 逻辑角色，不是新增的生产 Agent 卡、也不常驻服务**（生产运行时零 Codex/plugin 依赖）。生成与评审严格分开：生成角色不给自己产物打最终分；评审 prompt 不得看到"这是 Readdy 风格应高分"之类诱导；确定性工具结果优先于模型主观判断。

| 角色 | 输入 | 输出 | 禁止 |
|---|---|---|---|
| Reference Curator | 候选 URL、截图、许可证 | DesignSourceManifest、来源层级、保留/训练策略 | 未核许可就下载进模板库或训练集 |
| Design Decomposer | 已登记的许可资产或临时视觉参考 | DesignObservation、Reference Card | 复制原文案/素材/独特代码，或保存可还原页面的坐标集 |
| Pattern Aggregator | 多个 DesignObservation + 平台原创实验 | 跨来源 DesignRule、证据来源数 | 让单一 Readdy 页面决定正式规则 |
| Component Mapper | DesignDNA + 现有组件库 | 映射表、缺口表、变体建议 | 为单一参考无限增组件 |
| Blueprint Synthesizer | 获准 DesignRule + 行业需求（**不可见原始来源页面**） | TemplateFamily、Blueprint | 输出任意运行时代码或来源特定克隆 |
| Compliance Rewriter | 授权源码或内部草稿 | 自托管 Astro 变体 | 保留 CDN、追踪、托管表单 |
| Visual Evaluator | 三断点截图 + rubric | DesignEvaluation、结构化 Findings | 只给"好看/不好看"的自由文本 |
| Originality Reviewer | 来源截图 + 生成截图 | 相似性风险、差异说明 | 把像素差当作唯一版权结论 |

> 组件库口径：Component Mapper 映射进的**封闭组件库 v1 目标 26 型**（ADR-015/D12）；main 现注册 10 型（见 §0.4、02/04），扩库=显式加注册 + 版本 minor。
> 干净室边界（引 ADR-019）：Pattern Aggregator 至少综合 5 个独立来源/原创实验才形成 DesignRule；Blueprint Synthesizer 只读聚合规则、不读来源页面；运行时不读原始 Readdy 页面（详见 11-Readdy 边界文档、02 开发/生产两平面）。
