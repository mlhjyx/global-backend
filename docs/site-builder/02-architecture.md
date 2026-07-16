# Site Builder 架构设计 v1

> 配套 [01-prd.md](01-prd.md)。2026-07-13 起草；模型/素材库研究结论见 §6/§8（web 调研回填）。

## 0. 设计原则（五条）

1. **总控 = Temporal Workflow + 规划型 AI Task**，不做自由超级 agent。调度/重试/超时/预算/进度是确定性编排的活；智能只出现在有界任务节点。续用本仓 L0-L3 分层哲学（"AI Task = 有界任务契约"），获客侧已验证。
2. **SiteSpec 结构化产物 + 组件库渲染**（已拍板）：agent 产出结构化 JSON，确定性渲染器构建站点。同 SiteSpec 永远产出同站（可 diff、可回滚）；风格切换 = 换主题 token 秒级重渲染。v2 再开"自定义 section 代码生成"。
3. **两段式生成**：demo v0 秒出（确定性模板+注册信息+一次轻文案调用）；精装修异步分钟级。
4. **每个 agent = 有界 AI Task**：输入/输出 zod schema 严校验、失败重试带错误反馈、预算 reserve-settle、全链 trace。
5. **模型统一走 new-api 网关**（已拍板，付费开闸）：所有 agent 的文本/图像/视频调用集中网关记账，key 不散落。

> **补充架构原则（v3.2 §4.1 回写，与上五条并列的工程不变量）**：
> 6. **AI 只做开放性理解 / 生成 / 审美判断**；安全、结构、引用完整性、预算、发布与回滚一律由**确定性代码**决定，模型输出无权改这些。
> 7. **Agent 只交换版本化结构化工件**（schema 化 JSON），不做自由聊天、不产任意代码。
> 8. **SiteSpec 是渲染合同，不是事实数据库**——事实真相源是公共 `Company/Offering/Claim/Evidence`（§9），站点只保存**渠道投影 + 不可变 Release**。
> 9. **所有 AI/媒体任务可重试、取消、追踪、计费、降级、回放**（AiTask 基类内建，§4.4/§6）。
> 10. **Preview 与 Publish 用同一 Release 产物**，切换只动可见指针与域名，绝不二次构建（§4.6、§7）。

### 0.1 运行时硬约束（v3.2 §0.1 回写，护 D1/D13）

- **不让运行时 Agent 自由写 React/Astro/CSS 或任意组件**——只能从**已批准封闭组件库**（ADR-015，26 型为 v1 target）选择组合；当前产物是 SiteSpec，DesignBrief 属 DI-0/M1-e 目标。
- **不新增 planner Agent**——固定 DAG + 规则选择 + 现有 Temporal 编排是**唯一调度**（D13 / ADR-013）。
- **不把"再写一个更长的 prompt"当成设计方案**——设计智能靠开发期工厂沉淀的语料/组件/规则，不靠运行时长 prompt 即兴发挥。

### 0.2 两平面：开发期设计智能工厂 vs 生产期受控组装（v3.2 §0.2/§12 回写，target）

把 01 号"两主题预设 + 固定页面结构"升级为**两层**：

- **开发期平面**（Codex/开发 Agent 工作区，**非用户建站时运行**）：研究多源参考 → 临时分析压成 `DesignObservation` → 只把**聚合规则 / 许可代码 / 原创资产**提升为可运行语料 → 生成内部组件变体、构建 TemplateFamily → 跑合规/截图/性能/原创性评测 → **经 PR 发布版本化 DesignCatalog**。
- **生产期平面**：**当前 as-built 基底仅有** API / Temporal / AiTask / SiteSpec / Astro Renderer，Demo 仍由现有确定性 spec/模板路径生成，**尚无**运行时 DesignCatalog、TemplateFamily/Blueprint 选择或 DesignBrief 消费。**目标（DI-0 → M1-e）**才是按企业资料选择已批准 Family+Blueprint → 按素材/文案/事实证据受控组合 → 输出 DesignBrief/CopyBundle/SiteSpec/Findings。两阶段共同硬约束：不抓 Readdy（ADR-019）、不读原始参考页/模板源码、不生成任意前端代码（护 D1）。
- **两平面不可混合的四条理由**：① 设计研究需大量截图迭代，不适合 Demo 低延迟路径；② 来源许可有边界，不可在生产数据路径动态取用；③ 开发期靠**人工批准 PR**，生产期须**可重放/可计费/可降级**；④ 运行时自由设计会破坏 SiteSpec 白名单 / 缓存 / 可回归性。

> 开发期设计智能工厂的详设归 [13 号领域模型](13-design-domain-model.md)；[14 号](14-media-foundation-mf0.md)只承载媒体地基。本 02 的 as-built 只到上述 API/Temporal/AiTask/SiteSpec/Astro 基底；**两平面的版本化 `DesignCatalog` 单向接缝尚未实现**，属于 DI-0 契约 + M1-e 消费目标，不得被当前代码假定可用。v3.2 吸收 v2 合同并提出四层（设计合法复用抽象成内部资产 / 整站视觉语法+页面节奏+家族一致性 / Demo v0 10 秒也像有效海外站 / Codex 从 M1-c 起哪些立即改哪些延后）——施工状态以 09、13、14 号为准。

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

> **环境与安全边界（2026-07-17 Ubuntu as-built）**：R1-safety 已同时覆盖 Crawl4AI、robots 与平台 `http.get`。API 对每一跳做 global-unicast 校验并把连接钉扎到已验证 IP；Crawl4AI 保留 seed guard 与浏览器 pinning proxy。mihomo fake-IP 只有在系统答案全部位于 `198.18.0.0/15` 时才走固定 DoH 窄回退，broad `CRAWL4AI_ALLOW_INTERNAL_URLS` 已移除。公网抓取和 private/loopback/metadata/IPv4-mapped/redirect-to-metadata 真机矩阵均已验证；loopback 端口绑定只作附加防线。

新增基建：**MinIO**（compose，对象存储）、**Astro 构建容器**（渲染器）、网关新模型通道（§6）。

> **目标态新增/修改目录（v3.2 §25.2/§25.3 回写，target，随 M1-c~g 落地）**：
> - API 侧新增 `design/{catalog,resolver,rules,demo-visual-packs,design-lint,families/,blueprints/}`、`agents/{design-spec,aesthetic-review,model-profiles,model-policy.registry,model-capabilities,model-capability-probe,model-promotion.service}`、`media-gateway/`、`releases/`；修改 `demo-spec`/`task-routes`/`refurbish.workflow`/`site-builder.activities`/`schema.prisma`/迁移。
> - Renderer 侧新增 `components/variants/`、`lib/{design-catalog,design-tokens,picture}`、`fixtures/design/`、`tests/visual/`。
> - 🔴 **Renderer fail-closed（v3.2 §25.3，收敛 as-built）**：`Section.astro` 当前对未知组件**静默返回 null**（ADR-015 as-built，10 组件已注册）；目标改为**开发显错误块 + 测试/生产对未知组件 fail-closed**（不再静默）；`themes.ts` 从"两主题换皮"迁**版本化 StylePreset**；`spec.ts` 已迁共享契约（#117）删重复；locale 路由在 M1-e/M1-g 补完整验证（当前 `[...slug].astro` 只渲染默认 locale）。

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

> **Asset/KB 正确性状态机（v3.2 §26 R2-A 回写，target·failure-semantics）**：素材与知识库落库须做成**可重放正确性状态机**——内容寻址存储(CAS) + canonical copy + tombstone + Outbox + KB lease+retry + `assetId` 唯一 + profile patch schema 校验与并发合并。验收场景（全部须可重放且**绝不留指向已丢失对象的 ready 行**）：重复 commit、`P2002` 唯一冲突、对象删除失败、worker 崩溃、瞬时 embedding 失败、并发 patch。此为 §2/§12 素材与知识库表的**正确性合同**，非新表。

## 3. API 面（code-first OpenAPI，交 SaaS 前端）

```
POST /site-builder/intake                     # 注册引导提交 → 建档 + 【无条件】触发 demo v0（不论有无既有站）
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

> **intake as-built（2026-07-16，#126）**：有/无旧站都无条件建 Demo；响应为 `{siteId,buildId,status:"generating_demo"}` 且不返回 `mode`。`Idempotency-Key` 以 `(workspace, endpoint, key)` 持久化，同键同请求重放首次结果、异请求返回稳定 409；Temporal 使用确定性 workflowId 与 execution-chain ACK 收敛启动不确定窗口。正式形状以 code-first OpenAPI 为准。

鉴权照旧：SaaS token → JWKS 验签 → workspace_id → RLS。全部接口 OpenAPI 注解，Scalar 门户可见。

## 4. 编排（siteBuilderWorkflow）

> Temporal 是**唯一**工作流编排器（ADR-013，无第二条 Agent 流程、无 Planner）。下分**两条构建通道**：Fast Demo（秒级、确定性）与 Refurbish（分钟级、异步精装修）。数据流：

```mermaid
flowchart TD
    A["企业真相\nCompany / Offering / Claim / Evidence"] --> B["渠道快照\nBrand / Catalog / Packs"]
    B --> C["有界 AI Tasks\n内容 / 视觉 / 组装"]
    C --> D["SiteSpec + Copy + Media refs"]
    D --> E["确定性校验 + Astro"]
    E --> F["Immutable Release"]
    F --> G["Preview / Publish / Rollback"]
    H["Temporal / Budget / Audit"] --> C
    H --> E
```

### 4.1 Fast Demo 通道（P95 < 10s，v3.2 §4.2/§18.2 回写）

**当前 as-built**：`demoV0Workflow` 只编排一个 `generateDemoV0` activity；真实路径是 **读取 Site/intake → 使用站点 `stylePreset`（缺省时 `pickPreset` 在两套主题间确定性选择）→ 可选轻文案润色 → `buildDemoSpec` 生成 home/products/contact 三页 SiteSpec → 建 SiteVersion → Astro 构建 → 写 ready 预览**。当前没有 Archetype、Family/Blueprint、DesignBrief、DesignCatalog 或 DemoVisualPack。

**目标（DI-0 → M1-e）**才扩为 8 阶段快路径：**注册资料 → 规则识别 Archetype → Family/Blueprint 规则打分排序 → 安全 DemoVisualPack → 确定性 SiteSpec → 可选轻文案润色 → Astro 构建 → 快速 lint + 发布预览**。当前与目标共同硬约束：

- **关键路径不调视觉模型**：当前仅 `pickPreset` 关键词规则；目标 Family/Blueprint 也只用规则打分，不在 10s 预算内调多模态模型（保确定性）。
- **文案润色可取消、非依赖**：一次异步轻文案调用（deepseek-v4-flash）为锦上添花；硬超时即用模板默认文案，Demo 成功不依赖它。
- **只用注册明确事实**（ADR-017 禁虚构身份）；preview-only ≠ 可公开发布。
- **不跑**图片生成 / 视频 / 全页多模态 QA / 网络研究。
- **目标 DemoVisualPack 素材约束**：必须为平台原创、明确许可或程序化生成的**非事实性**素材；推荐三类来源=①平台自制抽象 SVG/网格/渐变/技术纹理；②明确可商用并本地化的图片；③后期由已批准图片模型生成的非事实性场景（不进 M1 Demo 必选路径）。
- **当前视觉能力边界**：`demo-spec.ts` 是 home/products/contact 三页确定性 Demo；`themes.ts` 仅两主题（颜色/系统字体/圆角/motionIntensity）=换皮而非完整设计语言。

### 4.2 Refurbish 精装修管线（异步，触发=用户补资料/选风格/点重新生成）

as-built：`refurbish.workflow.ts` 当前从 P1 直接进 `assembleAndBuild`，`site-builder.activities.ts` 里 `assemble` 仍调 `buildDemoSpec`、image/copy/quality 是**步骤位**——**设计升级落现有步骤位，不另建第二条工作流**。目标态六阶段产物与失败语义（v3.2 §4.2 回写）：

| 阶段 | 产物 | 失败语义 |
|---|---|---|
| P0 Prepare | BuildContext、预算、基准 Release、locks、ResolvedPackSnapshot | 阻断 |
| P1 Understand | BrandProjection、ClaimSnapshot、Gaps | 研究可降级；无可信事实走安全模板 |
| P2 Media+Copy | AssetVariant、MediaJob、CopyBundle | 可选素材/非默认 locale 可降级；必需项阻断 |
| P3 Design+Assemble | DesignBrief、DesignSpec、SiteSpec、BuildArtifact | 有限修复，仍失败**不切指针** |
| P4 Quality | QA/SEO/Aesthetic/Safety Report、FixPatch | 最多三轮；硬门不过不 publishable |
| P5 Release | SiteReleaseManifest、preview URL、Outbox | 原子提交；失败**保留旧 Release** |

原 ASCII 管线是同一意图的粗粒度视图：

```
P1 理解     资料解析入库向量化 ‖ brandProfileTask（全网研究）→ Brand Brief
P2 素材     并行 fan-out：imagePipeline(每图) ‖ copyTask(每语种) ‖ motionAssetTask ‖ videoTask(M3)
P3 组装     designSpecTask → siteAssemblyTask → SiteSpec 校验 → Astro 构建 → 预览部署
P4 质量环   ≤3 轮：qaTask ‖ seoTask ‖ aestheticReviewTask → findings → assemblyFixTask → 重构建
P5 发布     outbox: SiteReleaseCreated / SitePublished → SaaS 前端刷新预览
```

**阶段职责 I/O（v3.2 §19.1 回写，逻辑 agent → 产物）**：

| 阶段 | 输入 | 输出 | 设计相关变化 |
|---|---|---|---|
| P1 brandProfile | intake、资料、研究 | BrandProfile | 不改 |
| P2 imagePipeline | 用户资产 | 派生图片 + 能力摘要 | M1-c 纯 Sharp，不加设计模型（ADR-018） |
| P3 copy | BrandProfile + DesignBrief 内容预算 | CopyBundle | M1-d 增槽位长度 + 证据要求 |
| P3 designSpec | BrandProfile + Catalog + AssetCapabilitySummary | DesignBrief | M1-e 新增 Family/Blueprint/variant 决策 |
| P3 assembly | DesignBrief + CopyBundle + AssetManifest | SiteSpec | 只引批准组件 + 变体 |
| P4 quality | 构建产物 + 三断点截图 | Findings + Patch | M1-f 新增审美 + 通用感 |

### 4.3 增量构建（scope 语义，v3.2 §4.3 回写）

- `scope=site`：全站新快照；`scope=page`：仅重写目标页，但 **Release 仍是全站不可变快照**；`scope=section`：仅重写目标组件，保留 lock/人工编辑/未受影响引用。
- 素材变化由 **AssetUsage 反查**受影响组件；处理按 `content_hash` 幂等跳过。
- Claim 过期/撤销、Offering 更新、Asset 撤权**只创建 `SiteMaintenanceTask`，绝不静默改已发布页**。
- **每次 build 冻结** Pack/Catalog/Prompt/Schema/RoutePolicy/Renderer/ComponentLibrary 版本（可重放地基）。

### 4.4 失败语义与可恢复状态（v3.2 §4.4 回写）

`SiteBuildRun.steps JSON` 只做读模型；一等记录用 `SiteBuildStep(buildRunId,key,itemKey,attempt,status,progress,degraded,errorCode,costCents,artifactRefs,…)`，唯一键 `(buildRunId,key,itemKey,attempt)`。关键失败处理表：

| 场景 | 处理 |
|---|---|
| KB 摄入失败 | 沿用 ready 文档并 degraded |
| Brand 全路由失败 | 用上一版 BrandProjection；无上一版走安全模板 |
| 可选图片失败 | 原图优化 Variant 或占位（fail-safe，不阻断整站） |
| Logo/Hero 必需素材不可用 | 返回明确 gap 并阻断 |
| 非默认 locale 失败 | 本 Release 不含该 locale；**默认 locale 失败阻断** |
| 预算耗尽 | 停发新调用、结算已完成、状态 `resumable` + `SiteBuildFailed(reason=budget)`，绝不静默 |
| 取消 | 停新任务、执行不可取消补偿、**不改旧 Release** |
| 模型通道异常 | 按 registry fallback；**不能用无媒体能力的文本模型硬顶**媒体任务 |

- phase 级 Temporal 重试；**并发**：同 site 同时只允许一个 build run（Temporal workflow id = site id 派生，天然去重）。

### 4.5 DesignBrief 可重放/确定性（v3.2 §15.4 回写，target）

- `catalogVersion`/`familyVersion`/`variationSeed` 必须落入构建工件，**保证可重放**。
- 同一 `SiteBuildRun` 内 DesignBrief **不因重试随机漂移**。
- SiteSpec **只引用已批准**的 component+variant（ADR-014/015）。

### 4.6 不可变 Release 与原子发布（v3.2 §7.1 回写，引 ADR-013）

每次发布产出**不可变 Release**（内容寻址、可回放、可回滚），**异步失败绝不删除用户现有 Site**（ADR-013）。

- **对象前缀固定** `sites/{siteId}/releases/{releaseId}/...`，禁按 slug 覆盖历史目录。
- **ReleaseManifest 快照**冻结：SiteSpec + 各 locale CopyBundle hash、ClaimSnapshot/CatalogSnapshot、Asset/Variant hash+权利+来源、Pack/DesignCatalog/Family/variationSeed、component/renderer/prompt/schema/route policy/model snapshot、QA/SEO/Aesthetic/Safety/PublishReview 报告、artifact 清单 + digest。
- **原子指针**：DB 事务切 `previewReleaseId`/`publishedReleaseId` 同时写 Outbox；失败/取消/未过硬门**都不改当前指针**；回滚=切**完整 Release**，非只切 SiteSpec JSON。
- **Preview 与 Publish 同一 artifact**，禁二次构建导致漂移（详见 §7 域名/证书/tombstone）。
- **公共 Outbox 事件（不建第二消息系统，v3.2 §3.6）**：`SiteIntakeCompleted` / `SiteDemoReady` / `SiteDemoFailed` / `SiteBuildStarted` / `SiteBuildStepChanged` / `SiteBuildCompleted` / `AssetProcessed` / `MediaJobCompleted` / `SiteReleaseCreated` / `SitePublished` / `SiteRolledBack` / `InquirySubmitted` / `SiteMaintenanceRequired`。

## 5. Agent 架构卡（原 9 卡；卡 1「规划 planner」已按 D13 砍 → 职责拆入「编排/增量规划」确定性零模型 + designSpec，余 8 张生产 agent）

统一契约：`输入 schema → prompt（用户资料只进模板变量，防注入）→ 网关调用 → 输出 zod 校验（不过=带错误重试 ≤2）→ trace + 成本落 run`。每个 AiTask 须声明：`taskId`/owner/input+output schema version/prompt version/rubric version、`modelProfile`/allowed capabilities+tools/timeout/maxTokens/maxCost、fallback+degrade policy/deterministic post-checks/PII+data-region policy（v3.2 §5.3）。

### 5.1 四逻辑 Agent（设计视图）↔ 7 物理 AiTask（as-built）映射（v3.2 §5.1/§1.6 回写）

as-built 已落地 **7 个 task id**（`task-routes.ts`：`brand_profile / copy / design_spec / assemble / assembly_fix / qa_summarize / seo_review`）。下表**不做命名重构**，只在文档/owner/trace 上把它们（含 M1 目标新增 task）归成**四个逻辑 Agent**，明确责任与禁止边界：

| 逻辑 Agent | AiTask（含目标 *） | 责任 | 禁止 |
|---|---|---|---|
| Brand & Evidence | `brand_profile`、claim_projection* | 品牌、术语、引用、gaps | 不批准 Claim；不输出具名个人 |
| Content & SEO | `copy`、localize*、`seo_review` | 多语言文案、FAQ、metadata、Schema 文本 | 只消费允许公开的 ClaimSnapshot |
| Visual Media Director | image_select/qc/edit*、video_storyboard/qc*、aesthetic_review* | 媒体用途、编辑 brief、多模态质检 | 不改原件；证书/人像/Logo 禁生成式改造 |
| Site Composer & Fixer | `design_spec`、`assemble`、`assembly_fix` | Archetype/Family、组件、SiteSpec、受限 JSON Patch | 不生成代码；不绕过白名单 |

（* = M1-d/e/f 目标 task，尚未落地；下方 §5.2 的 8 卡是**能力设计视图**，与 7 as-built task 非一一对应——planner 卡已按 D13 砍。）

**确定性服务不是 Agent（v3.2 §5.2）**：Workflow Orchestrator、Budget Guard、SiteSpec Validator、Asset Processor、Safety/License Gate、A11y/Performance Scanner、Release Manager、Publisher/Domain Manager、Analytics/Event Collector 均为**确定性服务**——无人格、无模型自由度、无自主规划权。

**不设 Planner，保留审核三角（v3.2 §5.4 / D13 / ADR-013）**：固定建站由 DAG+scope+规则选择；M2 自由语言改站只增 `edit_intent` → 受限 PatchPlan，不获任意编排/代码生成权。QA/SEO/Aesthetic 是三个独立视角，生成者不得给自己打最终分；修复者只消费冻结 finding，输出 allowlist JSON Patch，每轮硬门须单调改善，最多三轮。

### 5.2 能力设计视图（8 卡；模型列见 §6 四态路由，非终选）

| # | Agent | 职责 | 输入 → 输出 | 模型（首选） | 工具/护栏 |
|---|---|---|---|---|---|
| ~~1~~ | ~~规划 planner~~ ❌**已砍 (D13)** | **职责已拆分（非删除）**：编排/预算/增量范围 → 「编排/增量规划」确定性零模型（§6·§11 D13）；"该有哪些页/每页什么结构"的设计智能 → 卡 6 designSpec（未砍）；用户自由意图改站 → M2 预留 | — | 无（确定性零模型） | 固定 DAG + 规则判定 |
| 2 | 品牌定位 brandProfile | 资料理解+全网研究 → Brand Brief | KB+店铺/官网/社媒抓取+同行参考 → 价值主张/tone/术语表/关键词/差异点 | deepseek-v4-pro（研究综合）| SearXNG+Crawl4AI（已有）；**事实红线：认证/产能/年限等必须带出处，缺=留空提示用户补，绝不虚构（ADR-017）** |
| 3 | 图片管线 imagePipeline | 产品/工厂图生成安全可发布的响应式派生件 | 原图 → 多尺寸 webp/avif + fallback | **M1-c 确定性零模型（纯 Sharp）** | 目标固定序：MIME/像素/解码炸弹检查→方向与 sRGB→重编码去 EXIF/GPS→质量门→安全裁切/focal point→多尺寸导出→`AssetVariant`；原图不可变、单图失败隔离。rembg、超分、生成式背景重绘、视觉质检与 pHash/embedding 主体校验均属 M1-c2/M3 后置能力，出现真实消费者、同意与 provider 门后另行落地（ADR-018） |
| 4 | 文案 copy | 每语种全站文案 | Brand Brief+页面结构+KB → locale×section 文案（含 SEO title/desc） | gemini-2.5-pro（多语言） | 术语表一致；每语种原生生成非机翻腔；禁绝对化宣称；目标市场文化禁忌 checklist |
| 5 | 动效/视频 motion/video | v1 动效参数（Ken Burns/视差=确定性零模型）；M3 Seedance 图生视频（工厂环境/产品展示 5-10s） | 图片 → 动效参数 / 视频 asset | Seedance（火山，异步任务轮询） | 每站视频条数配额；视频失败自动降级动效 |
| 6 | 审美 designSpec + aestheticReview | 生成期：DesignSpec（主题 token 选择/板块布局/图文节奏）；评审期：看整站截图挑毛病 | Brand Brief+模板 → DesignSpec；截图 → findings | gemini-2.5-pro（视觉） | Playwright 全页截图（3 断点）；评分 rubric（层次/一致性/留白/对比度/CTA 显著度），≥85 过 |
| 7 | 组装 siteAssembly + assemblyFix | 产出/修补 SiteSpec | DesignSpec+文案+素材清单 → SiteSpec；findings → SiteSpec patch | claude-sonnet-5（网关有则首选）或 deepseek-v4-pro | 输出必过 zod schema+素材引用存在性+内链有效性（确定性校验器），不过=带错误重试 |
| 8 | 审核 qa | 功能/性能体检 | 构建产物 → findings | deepseek-v4-flash（只做汇总） | **主体是确定性工具**：Playwright 遍历（链接/表单/响应式 3 断点/console error）+ Lighthouse（性能/a11y/SEO 基线分） |
| 9 | SEO seo | 技术 SEO+关键词落位 | 构建产物+Brand Brief → findings+patch 建议 | deepseek-v4-flash | 确定性检查：meta/OG/schema.org(Organization+Product)/sitemap/robots/**hreflang 多语言**/图 alt；关键词→页面映射 |

> 评审三人组（8/9/6 评审面）= GAN 式生成-评审循环（生成者改，评审者挑），有界 ≤3 轮防死循环；单维不过阈值出 findings，全过或轮数用尽即出环。
>
> ⚠️ 上表"模型（首选）"列为初稿；**以 §6 四态路由为准**（ADR-016：currentRoute 现役 as-built，候选只经评测晋级，非终选/非采购承诺）。
>
> **方法论内化说明**（用户确认的路线）：生产 agent 跑在本后端，Codex 与已安装的 ECC/Superpowers skills 是**开发期知识源**——各 agent 的 prompt/rubric 从对应 skills 方法论提炼固化（SEO rubric ← SEO 审计清单；审美 rubric ← frontend-design-direction/design-system；动效预设 ← motion-* 系列；质量环 ← GAN harness 模式；a11y ← WCAG 清单）。工具能力以**库内化**为先（M1 先落 Playwright/Lighthouse/Sharp；rembg 等只有真实消费者出现后才评估），MCP 只作确需外部服务时的传输选项（续 ADR「MCP=传输非授权」）。

## 6. 模型选型（**四态路由现役档 2026-07-14**：真实评测 + 用户三轮拍板；依据与全部实测数据见 [10-model-selection-study.md](10-model-selection-study.md)）

> 本表是**当前路由（currentRoute，as-built）**，不是永久终选——ADR-016 四态路由：`currentRoute` / `evaluatedCandidate` / `targetCandidate` / `promotedRoute` + `deterministicFallback`。「推荐 ≠ 代码已切换」，候选**只经 Golden Set 回归 + 成本/质量门**晋级，非采购承诺。Agent 卡只绑 **ModelProfile 语义档**（能力/成本/延迟约束），不硬编码型号；所有 alias 运行时解析到 snapshot，ReleaseManifest 存 snapshot 供历史重放。定档方法：三任务形状本地网关真实调用评测（确定性判分+延迟实测）+ 外部信源 + 用户拍板。「现役」列今天即可真跑（方舟 agent plan 10 文本模型 + seedream 已接通实测，deepseek 直连双档已接）；「升级位」待通道接入后按同套评测题复测再切。

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

**路由工程门与可观测性（v3.2 §23.7 回写，ADR-016）**：
- 每个 task 固定 `maxTokens`/`timeout`/`reasoningEffort`/`maxCost`/fallback policy（as-built：`task-routes.ts` 已按 task 配齐，回退链=合法路由非静默降级）。
- **显式错误码**：`finish_reason=length`、空 content、schema 不合、capability 不符**必须**是显式错误码，绝不静默。
- **模型原始输出不直接进数据库或 Renderer**——先过 schema → 事实 → 引用 → 安全四门。
- **可观测性记录字段集**：`profile`、`policyVersion`、`channel/provider/model/modelSnapshot`、`fallbackIndex`、`prompt/schema/rubric`、`token/latency/cost`、`finish/fallback/rollback reason`。
- Judge 尽量不与 candidate 同 provider；先跑确定性门再盲评，防高文风掩盖事实错误。

**网关通道现状与待接清单**：
1. ✅ **火山方舟 agent plan**（已接，2026-07-14 实测）：10 文本模型（doubao-seed-2.0 全家/kimi 双档/glm-5.2/minimax 双档）+ seedream-5.0-lite 图像；plan 专属路径 `/api/plan/*`（文本 OpenAI 型通道、图像 Custom 型完整 URL——type 45 火山适配器与 plan 路径不兼容）
2. ✅ **DeepSeek 直连**（既有）：deepseek-v4-flash/pro 双档（plan 内同名双档为尝鲜限流版，不绑避免分流）
3. ⬜ OpenAI 通道 → **GPT-5.6 Terra/Luna**（勿接 5.5，已被 5.6 三档取代）+ gpt-image-2（须确认 `images/edits` 端点转发）
4. ⬜ Google 通道 → gemini-3.1-pro + gemini-3-flash（现 Gemini 通道额度耗尽 429）
5. ⬜ Anthropic 通道 → claude-sonnet-5（可选；8/31 前介绍价窗口）

⚠️ **视频已知坑**（M3 前置）：new-api 对豆包视频任务中转有失败案例（[QuantumNous/new-api issue #2174](https://github.com/QuantumNous/new-api/issues/2174)）——接入时先升级 new-api 最新版实测；中转不稳则**方案 B**：视频 activity 后端直连火山方舟任务接口（异步轮询），key 集中配置，成本照记 `site_build_run.cost_summary`，其余模型不受影响仍统一网关。且 seedance 在 agent plan 中仅 Large/Max 档可用（已实测现档位 UnsupportedModel）。🔴 **视频不得进入 Demo v0 10s 路径**（§4.1）；C2PA/Content Credentials 可后续记录，但**不作 M1 阻断项**（v3.2 §21.3）。

## 7. 权限与安全

- **RLS**：§2 全部新表 workspace policy；worker 写走 `withWorkspace`；本功能无跨租户扫描场景（比获客侧更简单——没有平台级 ownerDb 路径）。
- **对象存储**：key 前缀隔离 + 短时 presigned URL（上传/下载都是）；禁公共桶；构建产物同样按 workspace 前缀。
- **预览（D7 已拍板：独立预览域名）**：每站一个子域 `{slug}.preview.<平台域>`——泛域名 DNS（`*.preview.<平台域>`）+ 泛证书；**预览服务**按 Host 头映射 slug→site_version 从对象存储回源静态产物。未发布 = 随机不可枚举 slug + `noindex` + 可选访问门（带 token 的链接）；发布才公开/绑正式域名。预览域与 SaaS 主域天然隔离（防 cookie 泄漏）；CSP `frame-ancestors` 白名单 SaaS 主域，前端可 iframe 嵌入工作台。
- **上传安全**：MIME 白名单、大小上限、图片一律重编码（剥 EXIF 定位隐私 + 消 payload）、文档解析在受限容器。
- **Prompt 注入**：用户上传资料/抓取内容一律当**数据**（模板变量注入），不进 system prompt；agent 输出过 schema 校验天然限制注入外溢。
- **成本**：ModelBroker 每 workspace reserve-settle + 日/月配额 + 单 build 上限；全链 trace（复用 ToolBroker 模式）。
- **内容合规**：生成文案禁虚构事实字段（§5 卡 2 红线）；广告宣称约束；用户对上传素材权属自担（ToS 条款，提请 SaaS 侧加）。

## 8. 素材与版权基线（2026-07-14 调研结论）

- **readdy.ai 结论（ADR-019 现行边界）**：它支持导出代码/Figma（付费档）并有页面级 REST API，但**没有可供第三方产品调用的"素材库"开放接口**，其模板/素材授权也不随导出转移到我们客户的商用站点——直接联动其素材库不可行。默认仅作 `visual_research_only`：开发期可少量、临时观察并抽象跨来源设计规律，**不导出/复用源码、文案或素材**；只有取得覆盖 AI 建站产品、衍生组件和商业分发的书面授权，并完整登记授权证据、范围、期限、地域、撤回与再分发权后，才可登记为 `owned_export_authorized`，在授权边界内走一次性导出改造工序；缺任一项 fail-closed。生产素材走下方开放授权生态。
- **开放素材生态（均免费，可商用；注意点如下）**：
  - **Unsplash**：免费，Unsplash License 商用无需署名；API 免费（production 档需申请、有速率限制）；Unsplash+ 付费专区不可用；禁原样转售。
  - **Pexels**：免费，Pexels License 商用无需署名；API 免费有速率限制。
  - **Iconify**：框架 MIT；聚合图标集绝大多数 MIT/Apache/ISC/OFL——实现时按许可**白名单过滤**（排除或自动署名 CC BY 集）。
  - **Google Fonts**：OFL 开源、免费商用；🔴 **必须自托管**——德国法院已有判例：网页远程加载 Google Fonts 向 Google 泄露访客 IP 违反 GDPR。
  - **LottieFiles**：平台素材授权混杂（Simple License/订阅内容），**v1 不依赖**——动效走自建 motion token 预设，Lottie 后期按单个素材核授权再用。
- **图库使用原则**：真实工厂/产品图永远优先（B2B 信任的核心），图库图只补氛围位；AI 生成图按目标市场透明度要求处理（欧盟 AI Act 披露义务跟踪）。
- 组件库基底：Astro + Tailwind；section 组件 v1 约 15~20 种（hero/产品网格/工厂实力/认证墙/数字带/时间线/案例/FAQ/CTA/询盘表单/页脚…），每种 2~3 布局变体 × 动效预设。

## 9. 与获客后端的闭环（未来）

### 9.0 复用现有公共对象（不复制，v3.2 §9.1/§9.3 回写）

独立站**消费**仓库已有公共对象、不复制：`CompanyProfile`、`Offering`、`KnowledgeSource`、`Claim`/`Evidence`/`KnowledgeConflict`、`AiTrace`、`UsageLedger`、`OutboxEvent`。

- Site 关联 `companyProfileId`（旧行 additive 回填后再改必填）；`BrandProfile` 是站点**渠道投影**，存 tone/valueProps/glossary/keywords/differentiators/claimRefs/gaps/research summary + 生成版本。
- 公共 `Company/Offering/Claim/Evidence` 是**事实真相源**；文案只消费 evidence gate 过的 `PublishableClaimSnapshot`（认证/数字/客户案例/性能结论须 APPROVED）——ADR-017 禁虚构身份的存储侧对应。
- 构建开始解析 **`ResolvedPackSnapshot`**（IndustryPack 术语+证据要求+推荐组件 / MarketPack locale+法务+单位+SEO+consent / GrowthMotionPack CTA+询盘字段+实验），本 run **不读变化中的 latest**；Pack 更新只建维护建议或新 build，不改旧 Release（§4.3/§4.6 冻结语义）。

### 9.1 增长闭环回流

- 询盘表单 → `inquiry` → outbox 事件 →（恢复获客开发后）线索进获客管线评分。
- `brand_profile`/公司事实反哺获客 ICP 配置。
- 站点分析（流量/询盘转化）作为 intent 信号回流。

## 10. 决策记录（本轮拍板）

> 站建承重决策已于 2026-07-16 收口为 **ADR-013~019**（`docs/adr/registry.md`，唯一决策真值：SCOPE/SiteSpec/封闭组件库/模型档路由/禁虚构身份/媒体地基/Readdy 参考）；下表 D1-D17 为本轮拍板原文，与 ADR 的对应见各 ADR「出处」列。

| # | 决策 | 结论 |
|---|---|---|
| D1 | SiteSpec+组件库 vs 自由写码 | SiteSpec+组件库（用户同意推荐） |
| D2 | 视频方案 | 付费开闸：Seedance（火山）；动效保底降级 |
| D3 | 模型接入 | 全部统一走 new-api 网关 |
| D4 | 生产 agent 运行时 | 自建有界 AI Task（L2 续用），不引入 Claude Agent SDK——网关是 OpenAI 兼容协议，SDK 绑 Anthropic 协议且自主漫游不可控；详见对话记录 |
| D5 | 站点诊断 | 「独立站管理」二级栏目（**非注册分支**，修订④）；已有站用户 SEO 体检，后置 M3+ |
| D6 | 多租户隔离 | RLS + 对象存储前缀 + 签名 URL（§7） |
| D7 | 预览方式 | **独立预览域名** `{slug}.preview.<平台域>`（泛解析+泛证书+Host 回源，§7）；需与 SaaS 侧对齐平台域与 DNS/证书运维归属 |
| D8 | 模型选型原则 | 按 agent 能力需求全市场选型；**2026-07-14 现役档定档**（§6 表=currentRoute as-built：实测评比+用户三轮拍板，依据见 10 号文档；ADR-016 四态路由，候选经评测晋级非终选）；视频=火山 **Seedance 2.0**（需 Large 档，用户将升档） |
| D9 | readdy 定位 | **已由 ADR-019 取代（2026-07-16）**：默认 `visual_research_only`，仅允许开发期少量、临时、多来源净室观察，持久化抽象 `DesignObservation/DesignRule`；**未经覆盖 AI 建站产品、衍生组件和商业分发的书面授权，且未完整登记证据、范围、期限、地域、撤回与再分发权，不得导出或改造 React/Figma**。全部满足后才可登记为 `owned_export_authorized`，按授权边界走一次性改造工序；缺任一项 fail-closed，运行时零依赖、禁止逆向，生产素材仍走开放授权生态（§8）。 |
| D10 | 发布部署 | **海外服务器**（免 ICP 备案）；静态托管=对象存储+CDN 优先（非 VPS）；预览国内友好线路/发布海外 CDN 双链路 |
| D11 | SiteSpec 数据形状 | 对标 **Puck**（MIT 可视化编辑器）兼容形状，渲染器自写 Astro（修订②，用户确认） |
| D12 | 模板策略 | Astro MIT 主题**改造+补缺**为基底，不从零画（修订③，用户确认）；**组件库 v1 扩容 17→26 型**（2026-07-14 用户拍板，readdy demo 缺口实证见 11 号文档：9 个小难度缺口并入 M1-e，中难度 3 个 v1.5，沉浸叙事类不进封闭库） |
| D13 | v1 编排 | **无 planner agent**：固定 DAG + 规则判定增量范围；M2+ 真需要再评估（修订①，用户确认） |
| D14 | 知识库与 embedding | **pgvector + BGE-M3 自托管**（沿 v3.0 D1 既定规格 vector(1024)/HNSW）+ **Docling** 文档解析（详见 §12）；embedding 自托管 day1 起（换模型=全量重嵌，切换成本决定不走"先 API 后自托管"） |
| D15 | 富文本 | v1 即开（用户拍板）：受限 ProseMirror JSON、不存 HTML（04 §5） |
| D16 | 交互地图 | Google Maps **Embed API**（免费无限量）+ 两步加载 GDPR 方案；Geocoding 建站期一次缓存（04 §10 申请清单） |
| D17 | 注册去分支 + 引导式 onboarding | **修订④（2026-07-14 用户确认）**：注册「有无海外独立站」**只作背景知识、不分叉栏目**；后台统一一级「独立站管理」下挂**独立站建设 + 站点诊断**两个二级栏目；注册即**无条件**生成 demo（不论有无既有站）；进后台的引导（消息卡片→跳转预览→引导填向导）**流程与状态全在前端**（本仓不管），后端只提供**已有的预览链接**（`previewUrl`）供卡片跳转、**不为引导新增编排/状态端点** |

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
9. **模板冷启动**：开发期由 Codex 使用生成/评审分离的 GAN 设计循环方法批量产行业模板，再经人工终审——模板质量决定 demo v0 第一印象（M0 的核心工作量）。
10. **内容安全审核**：用户上传图+生成文案过安全审核后才上站（M1）。
11. **SiteSpec 版本化**：`specVersion` 字段+迁移器，保老站向后兼容（M0 起）。
12. **观测**：build 成功率/时长/单站成本 dashboard（M1）。
13. **多站点预留**：schema 1:N（workspace→sites），v1 UI 限 1 站。
