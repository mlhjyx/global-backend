# 13 · 设计智能层领域模型契约（design intelligence domain model）

> 文档 ID：`SITE-DOMAIN-001`
> 生命周期：`CURRENT`
> 当前事实来源：设计目录、共享合同、受控组装与 [状态](../status/current.md)。
> 本文 = 独立站建设**设计智能层的领域契约**。DI-0/#164 已落地 `DesignSourceManifest / DesignObservation / DesignRule / DesignDNA / TemplateFamily / Blueprint / DesignBrief / DesignEvaluation / DesignCatalog` 的共享类型、运行时 validator 与 digest；M1-e-B 已落真实目录条目、DesignBrief producer 和生产/消费链。媒体域 `Asset / AssetVariant / MediaJob / AssetUsage / DemoVisualPack` 仍按各自阶段推进。
> ⚠️ **合同存在不等于全部运行时能力存在**：Catalog=`m1-e-b/1.0.0` 已含六个 approved Family、Blueprint、StylePreset 与 DemoVisualPack；SiteSpec 已为 `1.0.0 | 1.1.0`，受控 1.1 固定 `componentLibraryVersion / rendererVersion / familyId` 等 identity。DesignEvaluation 运行时生产与 quality loop 仍属于 M1-f（见 [04-sitespec-contract.md](04-sitespec-contract.md)、**ADR-014/015**）。
> **非自封权威**：施工真值仍是当前代码、活文档 00-10/[14](14-media-foundation-mf0.md) 与 [ADR registry](../adr/registry.md)；11 是受 ADR-019 取代的历史研究，12 v3.2 是归档 proposal。本文是设计智能层的**目标设计基线**，实际落地时须回写 [03-agents.md](03-agents.md) / [04-sitespec-contract.md](04-sitespec-contract.md) 并把消费者需要的字段合入 `@global/contracts`。
> 实质内容由外部草稿 v3.2 §13–§20 分发而来（逐节标注「v3.2 §X 回写」），v3.2 本身非权威。承重决策**按 ID 引用** ADR-013~020，不复述整条。

---

## 0. 定位与边界

- **本文管什么**：设计智能层"从设计参考 → 平台自有设计知识 → 每次生成的冻结决策 → 质量评测"这条链上的领域模型。它是 [09-m1-implementation-design.md](09-m1-implementation-design.md) 精装修管线（P1→P4）在 M1-d/e/f 阶段的**数据契约层**。
- **本文不管什么**：编排 DAG、Agent 卡执行流（→ [03-agents.md](03-agents.md)）、SiteSpec 页面数据形状（→ [04-sitespec-contract.md](04-sitespec-contract.md)、**ADR-014**）、模型路由四态（→ [10-model-selection-study.md](10-model-selection-study.md)、**ADR-016**）。
- **as-built ↔ target 分界（务必区分）**：
  - **as-built（2026-07-24）**：SiteSpec 1.0/1.1、55 型资格、六个正式 Family、DesignBrief producer、受控 assembly/asset overlay 与 ReleaseManifest v2；`AssetVariant`/MF-0 与 M1-c 纯 Sharp 图片管线。
  - **target（尚未落地）**：DesignEvaluation 运行时实例、质量循环与 `MediaJob`/`AssetUsage`。**ADR 本身只是路线，代码、消费者与验证才是实现证明**。
- **红线继承**：设计智能层不改变 **ADR-013**（固定 DAG + 有界 AI Task，无自由 Agent/Planner）、**ADR-017**（禁虚构身份）、**ADR-019**（Readdy = 净室视觉参考、运行时零依赖）。本文所有实体在这三条约束下成立。

---

## 1. 领域概念分层（先把混在一起的拆开）

> v3.2 §15.1 回写。当前 demo-spec 把「业务原型 / 视觉语法 / 具体 token」混成**一个关键词主题选择**，必须拆成彼此正交的概念。

| 概念 | 回答的问题 | 示例 | 本文归属 |
|---|---|---|---|
| **BusinessArchetype** | 这家公司需要什么页面和证据结构 | OEM 制造、技术目录、B2B 解决方案 | intake/需求侧（非本文，见 09） |
| **TemplateFamily** | 全站使用什么一致的视觉语法 | precision-industrial | §4.3 |
| **StylePreset** | 该语法下的一组具体 token | graphite-cobalt | §4.2 |
| **IndustryPack** | 行业术语、区块偏好和证据提示 | pump-machinery | 内容侧（非本文） |
| **MarketPack** | 目标国家的语言、合规、格式和信任元素 | de-DE | 本地化侧（非本文） |
| **DemoVisualPack** | 无用户素材时可安全展示什么 | generic-machinery-dark | §7.2 |

**关系主线**：`DesignDNA`（设计语言抽象）→ 被一个 `TemplateFamily`（可部署设计产品）引用 → 家族聚合若干 `Blueprint`（页面骨架）+ `StylePreset`（token 包）+ `DemoVisualPack`（兜底素材）；每次生成时 `designSpec` 从家族里选定一组决策，冻结成 `DesignBrief`；产出经 `DesignEvaluation` 打分。

---

## 2. 设计来源治理（供给侧）

### 2.1 三层来源与允许用途

来源按**允许用途**分层（A 自动学习复用 / B 视觉研究 / C 授权转换），详见 v3.2 §13.2 与 **ADR-019**：Readdy 属 **B 层**——设计研究 Agent 可看页面抽取设计规律，但**原始源码/完整截图/文案/素材不进生产 RAG 或训练集**，不得生成来源特定克隆。此处不复述分层表，只落治理契约。

### 2.2 `DesignSourceManifest`（来源登记，每个来源必有）

> v3.2 §13.4 回写。**定义**：进入开发工厂的每一个设计来源的权利与用途登记单。允许用途以已登记来源的具体政策为准；五个官方工业来源可用于转换和训练，不设置 SPDX 或额外授权硬门；Readdy 仍只可作净室视觉研究。

**机器字面量（唯一）**：`sourceClass` = `platform_original` | `permissive_licensed` | `owned_export_authorized` | `visual_research_only`；历史稿中的 `visual_reference_only` / `owned_export` 不接受、无运行时别名。完整 TypeScript 条件联合见 [06 §9](06-security-abuse.md)，本领域模型不得另造一套字段。

**公共字段**：`id` · `title` · `sourceClass` · `sourceUrl?` · `capturedAt` · `licenseSpdx?` · `licenseEvidencePath?` · `allowedUses[]`(`visual_analysis`|`token_abstraction`|`structure_abstraction`|`code_transformation`) · `prohibitedUses[]` · `retentionPolicy`(`manifest_only`|`ephemeral_source`|`licensed_archive`) · `trainingPolicy`(`platform_corpus`|`license_permits`|`prohibited`) · `sourceContributionGroup?` · `externalAssets[]`(`{kind, source, disposition:remove|replace|self_host|retain}`) · `reviewer`。

- **`owned_export_authorized` 条件字段**：`ownerAuthorization`（`evidencePath` + `covers.aiSiteBuilder=true` + `covers.derivativeComponents=true` + `covers.commercialDistribution=true` + `covers.training?` + `territories[]` + `validity:{kind:perpetual}|{kind:expires,expiresAt}` + `revocationTerms` + `redistribution:{kind:allowed|prohibited}|{kind:conditional,conditions}` + `recordedAt`）与 `approvedAt` **同时必填**；其他 sourceClass 禁带 `ownerAuthorization`。
- **状态硬门**：`approvedAt` 单独存在不代表授权生效。validator 必须核实授权证据非空、三项范围为真、`validity` 显式且未过期、地域非空、撤回/再分发权已登记；训练还须 `covers.training=true`。缺任一项 fail-closed，既不转换也不训练；不得自动降级绕过。`visual_research_only` 在类型层固定 `trainingPolicy=prohibited`、排除 `code_transformation` 与 `licensed_archive`，外部素材只能 remove/replace；运行时 validator 重复同一组断言，防未类型化 JSON 绕过。
- **生产方**：Reference Curator（Codex 开发期逻辑角色，非生产 Agent）。**消费方**：Design Decomposer、Pattern Aggregator、整条固定工序（§8）。

### 2.3 外部观察提升为平台 `DesignRule` 的 4 条件

> v3.2 §13.3 回写。一条外部观察**只有同时满足以下 4 条**才可提升为平台 `DesignRule`（否则只是个别来源的偶然表达，不入平台设计知识）：

1. **多源成立**：至少在 **5 个独立来源或平台原创实验**中成立；单一来源不能独占规则依据。
2. **去具体化仍通用**：去掉品牌、文案、素材和具体数值后，仍可描述为**通用构图/节奏原则**。
3. **可自有重实现**：可由平台自有组件与 token 重新实现，**不需运行时读取来源**（组件目标态 = 55 型封闭库 **ADR-015**；当前 as-built 55 型）。
4. **非近邻复刻**：生成站与任一单一来源通过**截图 / 结构 / 代码相似度门**，不是近邻复刻。

`DesignRule` = 满足上述条件的跨来源通用原则（携带证据来源数）。**生产方**：Pattern Aggregator。**消费方**：DesignDNA 合成、Blueprint Synthesizer。

### 2.4 平台自有训练语料建立顺序 → `PlatformTemplateCorpus`

> v3.2 §13.3 回写。平台可训练语料**按顺序**建立，未来若微调模型，**优先用这条可追溯的自有语料**，而非抓取 Readdy 原始输出：

```
许可模板/组件种子 → Agent 合成变体 → 独立审美与事实 QA → 用户选择/编辑/发布信号 → PlatformTemplateCorpus
```

- `PlatformTemplateCorpus`：平台自生成、逐条可溯源的设计语料库。**生产方**：固定工序第 9 步（§8）。**消费方**：未来微调 / 检索。失败的家族**不进**运行时或训练语料。

---

## 3. `DesignObservation` 与干净室边界

> v3.2 §13.5 回写。**核心隔离**：设计研究 Agent 看得到来源页面，但 **Blueprint Synthesizer 不读取来源页面**，只读取**跨来源聚合后的观察**——这是净室边界，防止来源特定表达渗入产物。

**定义**：一次对来源在多断点下的结构化设计观察（**不含任何可还原来源的原始表达**）。

**字段**：`sourceManifestId` · `observedAt` · `heroComposition`(`centered`|`split`|`editorial`|`product_stage`|`cinematic`) · `hierarchyScale`(`{headlineBand, bodyMeasureBand}`) · `sectionRhythm[]`(`dense`|`airy`|`proof`|`product`|`narrative`|`cta`) · `imageStrategy`(`{ratioBands[], focalPattern, treatment}`) · `ctaStrategy`(`{primaryCount, placementPattern}`) · `motionIntensity`(`none`|`subtle`|`normal`) · `mobileReflow[]` · `reusablePrinciples[]` · `prohibitedSourceSpecificTraits[]`。

**干净室硬约束**：
- **不保存**原始文案、图片、图标、完整 DOM、代码片段，或足以还原单一页面的精确坐标。
- 短期截图若为分析所需，按 `ephemeral_source` 在**分析完成后删除**。
- **运行时 RAG 只索引获准的** `DesignRule` / `DesignDNA` / `TemplateFamily` / 平台原创示例——来源页面与其观察不进运行时索引。

**生产方**：Design Decomposer（在 375 / 768 / 1440 三断点提取）。**消费方**：Pattern Aggregator（≥5 独立来源聚合成 `DesignRule`）——**不含** Blueprint Synthesizer。

---

## 4. 设计语言与产品实体

### 4.1 `DesignDNA`（设计语言抽象）

> v3.2 §15.2 回写。**定义**：设计语言的抽象 schema，**不包含页面实例**——只描述"这套语言长什么样"。

**字段**（`schemaVersion:"1.0"` · `id` · `name`）：
- `hierarchy`：`displayScale`(`compact`|`balanced`|`editorial`) · `headingContrast`(`low`|`medium`|`high`) · `maxReadingWidthRem`(number)。
- `spatialRhythm`：`sectionGapPx`/`contentGapPx`(各 `[number,number]` 区间) · `density`(`airy`|`balanced`|`dense`)。
- `composition`：`heroModes[]`(`split`|`full_bleed`|`editorial`|`product_stage`|`technical`) · `imageTextRatios[]` · `alignmentBias`(`left`|`center`|`mixed`)。
- `surfaces`：`cardStyle`(`flat`|`bordered`|`elevated`|`tinted`) · `borderWeight`(`none`|`hairline`|`strong`) · `radius`(`none`|`subtle`|`soft`)。
- `imagery`：`preferredSubjects[]` · `cropModes[]`(`contain`|`cover`|`editorial_crop`) · `backgroundPolicy`(`light`|`dark`|`mixed`) · `maxGeneratedMediaRatio`(number)。
- `motion`：`intensity`(`none`|`low`|`medium`) · `allowed[]` · `forbidden[]`。
- `antiPatterns[]`：该语言明确禁止的构图/处理。

**关系**：被 `TemplateFamily.designDnaId` 引用（多个家族可共享/派生一套 DNA）。**生产方**：Pattern Aggregator + Blueprint Synthesizer（开发期）。**消费方**：Component Mapper、Blueprint Synthesizer、运行时 RAG。

### 4.2 `StylePreset`（token 包 + 变体映射）

> 承接 [04-sitespec-contract.md §6](04-sitespec-contract.md) as-built 概念，纳入领域模型。**定义**：某 DesignDNA 语言下的一组**具体 token + 各组件默认变体映射**——工作台"风格类型"切换 = 换 preset 秒级重渲染。

**字段（对齐 04 §6 主题 token 字典）**：`colors`(primary/secondary/surface/onSurface…) · `typography`(fontPair 枚举 = 自托管字体对 + 比例尺) · `spacing`/`radius`/`shadow` 比例尺 · `motionIntensity`(none/subtle/normal) · `density` + **各组件默认 variant 映射**。
- **硬约束（target）**：文本/背景对比度须由确定性校验器按 WCAG 2.2 AA 验证，不合格的 `tokenOverrides` 拒绝。DI-0 只落设计合同，不含该 Renderer/assembly 消费门；实现与测试证据归 M1-e。
- **关系**：`TemplateFamily.stylePresetIds[]` 引用。**生产方**：设计目录（开发期）。**消费方**：designSpec、渲染器、SaaS 工作台切换。

### 4.3 `TemplateFamily`（可部署设计产品，≠ 单页模板）

> v3.2 §15.3 回写。**定义**：一个**可部署的设计产品**——一套一致视觉语法下的完整生产资产集合。**显式声明：TemplateFamily ≠ 一个单页模板**。

**字段**：`schemaVersion:"1.0"` · `id` · `version` · `status`(`draft`|`approved`|`deprecated`) · `designDnaId` · `compatibleArchetypes[]` · `compatibleIndustries[]` · `stylePresetIds[]` · `blueprints`(`Record<string, PageBlueprint[]>`：按页面类型分组) · `componentVariants`(`Record<string, string[]>`) · `adjacencyRules[]`(相邻区块约束) · `contentBudgets`(`Record<string, ContentBudget>`) · `assetRequirements[]` · `demoVisualPackIds[]` · `motionPolicy` · `qualityBaselineId` · `sourceManifestIds[]`(可追溯到来源登记)。

- **状态机**：`draft` →（过固定工序 §8 全门）→ `approved` → `deprecated`（保底渲染两个 major 周期，对齐 04 §8）。仅 `approved` 家族进运行时候选。
- **关系**：引用 1 个 `DesignDNA`、N 个 `StylePreset` / `Blueprint` / `DemoVisualPack`；被 `DesignBrief.familyId` 选中。
- **生产方**：Blueprint Synthesizer（开发期，经独立 PR 发布）。**消费方**：designSpec Agent（P3）、装配、目录快照。

### 4.4 `Blueprint`（页面骨架，≠ 完整模板）

> v3.2 §17.1 回写。**定义**：一个页面的**结构骨架**——描述"这页要什么、按什么顺序、需要什么证据"，**不含**任何具体内容或实现。

**描述（包含）**：页面目标 · 区块角色顺序 · 可选区块 · 证据要求 · 允许的组件变体 · 相邻区块约束 · 图片角色 · 内容预算。
**不含（明确排除）**：具体企业文案 · 第三方图片 · 任意 CSS · 运行时脚本。

- **关系**：归属某 `TemplateFamily.blueprints`；被 `DesignBrief.blueprintIds` 按页面选定。装配时先过**兼容矩阵**（v3.2 §17.2：如 full_bleed Hero 后不接 full_bleed ImageText、连续 card-grid ≤2、StatsStrip 需 ≥2 有证据数值否则删——**证据门对齐 ADR-017**）再写 SiteSpec。
- **生产方**：Blueprint Synthesizer。**消费方**：designSpec、装配 Agent。

---

## 5. 生成期冻结决策与评测

### 5.1 `DesignBrief`（每次生成时的冻结决策）

> v3.2 §15.4 回写。**定义**：一次生成时冻结的一组设计决策，**供 copy / assembly / renderer / quality 四方共用**——单一决策源，保证四方看同一份"这次要怎么做"。

**字段**：`schemaVersion:"1.0"` · `catalogVersion` · `familyId` · `familyVersion` · `stylePresetId` · `blueprintIds`(`Record<string,string>` 按页面) · `componentVariantOverrides`(`Record<string,string>`) · `assetStrategy`(`{availableRoles[], demoVisualPackId?, allowGeneratedImages:boolean, allowVideo:boolean}`) · `contentBudgets`(`Record<string,ContentBudget>`) · `localePolicy[]` · `motionIntensity`(`none`|`low`|`medium`) · `variationSeed` · `reasons[]` · `warnings[]`。

**不变量**：
- `catalogVersion` / `familyVersion` / `variationSeed` **必须落入构建工件**，保证**可重放**。
- DesignBrief 一旦进入同一 `SiteBuildRun`，**不因重试随机漂移**（冻结语义，对齐 **ADR-013** 可回放）。
- SiteSpec **只引用已批准的 component + variant**（对齐 **ADR-015** 封闭库）。

- **生产方**：`designSpec` Agent（P3；as-built `design_spec` 路由存在，**M1-e 目标态**扩展为产出本 DesignBrief 全 schema）。**消费方**：copy(P3) / assembly(P3) / renderer / quality(P4)。

### 5.2 `DesignEvaluation`（质量评测产物）

> v3.2 §15.5 回写。**定义**：对构建产物在三断点截图 + rubric 下的结构化评测（P4，M1-f 目标）。生成与评审**必须分开**：生成角色不能给自己产物打最终分，评审提示词不得看到诱导（v3.2 §14.1）。

**字段**：`schemaVersion:"1.0"` · `overallScore`(number) · `dimensions`(`{hierarchy, consistency, spacing, contrast, imagery, mobileComposition, ctaClarity, credibility, originality}` 各 number) · `hardFailures[]`(`{code, page, breakpoint:375|768|1440, selector?, evidencePath}`) · `findings[]`(`{id, severity:blocker|major|minor, target, rule, suggestedPatch:object}`)。

- **状态/门**：`hardFailures` 非空 = 硬失败（阻断发布）；`findings` 喂 assemblyFix（**最多三轮**，三轮仍失败则保留最近可构建版本 + 标 `quality_degraded` + 回退同 Family 安全 Blueprint，**绝不删用户现有站** ADR-013，见 v3.2 §19.3）。
- **生产方**：Visual Evaluator / quality（P4；as-built `qa_summarize` 路由，`aesthetic_review` 为 M1-f 目标路由）。**消费方**：assemblyFix、发布门。

---

## 6. 首批 6 个 `TemplateFamily` 名录

> v3.2 §16 回写。**M1-e 首批只做 6 个家族**，每家族至少：2 个首页 Blueprint / 2 个内页 Blueprint / 2–3 个 Hero 变体 / 1 套移动端重排规则 / 2 个 StylePreset / 1 个 DemoVisualPack / 覆盖 12 个 Golden fixture 中至少 2 个。**不是行业越多越好**——先保证每家族真有明显差异和稳定质量。

| Family | 适用对象 | 设计语言 | 必须避免 |
|---|---|---|---|
| **precision-industrial** | 机械、泵阀、零部件、OEM | 精确网格、深色技术首屏、参数与能力并重 | 全站蓝色卡片、伪仪表盘 |
| **technical-catalog** | SKU 多、规格驱动企业 | 浅色高可读、筛选感、产品图主导 | 首屏纯情绪大图、隐藏技术信息 |
| **oem-capability** | 工厂、代工、供应链 | 制造流程、产能证据、工厂视觉 | 无证据的全球第一、虚构产线数字 |
| **scientific-trust** | 仪器、医疗供应、实验室 B2B | 克制、高对比、证据优先、清晰空白 | 过度霓虹、娱乐化动效 |
| **natural-origin** | 食品原料、农业、天然材料 | 温和色系、产地与工艺叙事、质感近景 | 伪有机认证、泛绿色洗白 |
| **premium-innovation** | 高附加值设备、创新材料、品牌型 B2B | 大留白、编辑式排版、产品舞台 | 大段空白却无价值信息 |

**M1-g 后**再考虑：global-wholesale / b2b-solution / service-expertise / exhibition-campaign。

---

## 7. 媒体域数据合同

> **媒体域完整数据合同已归 [14 · MF-0 媒体地基契约](14-media-foundation-mf0.md)**（`Asset`/`AssetVariant`/`MediaJob`/`AssetUsage`/`SiteSpecAssetReferenceScanner` 表结构、分期触发门、图片 7 类型处理矩阵、删除守卫 409——单一真值在 14 号，本文不重复承载）。本节只列**设计层与媒体域的接口关系**（§7.1）+ 保留**设计层专属**的兜底实体 `DemoVisualPack`（§7.2）。

### 7.1 设计层引用的媒体实体（完整契约见 [14 号](14-media-foundation-mf0.md)）

设计智能层**引用**这些媒体实体但不拥有其数据合同——下表只记生产/消费关系与阶段门，字段/表结构/幂等/删除守卫细节以 14 号为单一真值：

| 实体 | 阶段/门 | 生产方 | 消费方 | 契约 |
|---|---|---|---|---|
| `Asset`（逻辑素材/原件） | `Asset` 已落地；完整字段面 MF-1 | imagePipeline(P2)/上传 | Variant 派生、装配、删除守卫 | [14 §2](14-media-foundation-mf0.md) |
| `AssetVariant`（可发布派生） | MF-0-thin（M1-c 门） | M1-c Sharp 管线 | 渲染器 `<picture>`、`AssetRef` | [14 §2](14-media-foundation-mf0.md) |
| `MediaJob`（异步/生成任务） | MF-1（事件触发） | 媒体工作流 | 成本/审计/对账 | [14 §6](14-media-foundation-mf0.md) |
| `AssetUsage`（持久引用权威） | MF-1（稳定 Release 后） | Release/构建 | 删除守卫、增量重建、版权审计 | [14 §6](14-media-foundation-mf0.md) |
| `SiteSpecAssetReferenceScanner` | MF-0-thin（删除守卫→409） | 素材删除路径（确定性） | 删除 API | [14 §3](14-media-foundation-mf0.md) |
| 图片 7 类型处理矩阵 | M1-c 纯 Sharp（不接 rembg） | imagePipeline | Variant | [14 §4](14-media-foundation-mf0.md) |

### 7.2 `DemoVisualPack`（无用户素材时的安全兜底 · 设计层专属）

> v3.2 §18.3 回写。**定义**：用户未提供素材时可安全展示的一套通用视觉资产（每个包 8 个字段面）。

**内容结构（8）**：① hero 宽图或抽象背景 · ② 3–6 张通用产品/工艺占位 · ③ 纹理/渐变/几何背景 · ④ 图片角色与适配 Family · ⑤ alt 模板 · ⑥ 授权和来源 · ⑦ 主色兼容度 · ⑧ 最小对比度建议。
- **来源三类**：平台自制抽象 SVG/网格/渐变/技术纹理 · 明确可商用并本地化的图片 · （后期）已批准图片模型生成的**非事实性**场景（不进 M1 Demo 必选路径）。
- **关系**：`TemplateFamily.demoVisualPackIds[]` 引用；`DesignBrief.assetStrategy.demoVisualPackId` 选用。**生产方**：设计目录（开发期）。**消费方**：demo 快路径、装配（无真实素材时）。

---

## 8. 设计智能工厂固定工序（10 步）

> v3.2 §14.2 回写。这是**开发期**把设计参考炼成平台自有设计知识的固定管线（Codex 开发期逻辑角色执行，非生产 Agent、非常驻服务）。失败的家族**不进运行时或训练语料**。

1. **登记来源和权利** → `DesignSourceManifest`（§2.2）。
2. 按来源策略获取**临时截图或许可代码**；**视觉研究截图不进长期训练集**。
3. 在 **375 / 768 / 1440** 下提取 `DesignObservation`（§3）；分析完成后按 `retentionPolicy` **清理来源副本**。
4. **Pattern Aggregator** 至少综合 **5 个独立来源/原创实验**，形成 `DesignRule` 和 `DesignDNA`（§2.3 四条件）。
5. 映射到现有组件和变体，**记录缺口**；**Blueprint Synthesizer 只读聚合规则、不读来源页面**（干净室 §3）。
6. 由平台 Agent 生成，**Codex 在开发期重写为 Astro 封闭组件变体**；产物进入平台自有语料候选（**ADR-015** 封闭库）。
7. **清除**外部依赖、品牌标识、第三方文案和素材。
8. 运行 **schema / a11y / 性能 / 三断点截图 / 代码·结构·视觉相似度 / 事实**评测。
9. 生成 `DesignCatalogSnapshot` 与 `PlatformTemplateCorpus` 候选记录。
10. 通过**独立 PR** 发布；失败的家族不进运行时或训练语料。

**对应关系**：步 1→§2.2 · 步 3→§3 · 步 4→§2.3+§4.1 · 步 5→§4.3/§4.4 · 步 9→§2.4。此工序把"供给侧治理（§2）→ 干净室观察（§3）→ 设计产品（§4）"串成一条可审计、可回退的生产线。

---

## 9. 生产方 / 消费方总表 + 落地映射

> 一张表锁定每个实体"谁产出、谁消费、何时落地"，供该层实际开发时按 milestone 拆 PR、回写 03/04 与 `@global/contracts`。

| 实体 | 生产方 | 消费方 | 落地阶段 | as-built 现状 |
|---|---|---|---|---|
| `DesignSourceManifest` | Reference Curator（开发角色） | Design Decomposer、工序 §8 | DI-0 / M1-e | 合同+validator 已落；无真实 Manifest 目录 |
| `DesignObservation` | Design Decomposer | Pattern Aggregator（**非** Synthesizer） | DI-0 / M1-e | 合同+validator 已落；无生产管线实例 |
| `DesignRule` | Pattern Aggregator | DNA 合成、Synthesizer | DI-0 / M1-e | 五独立贡献组合同已落；无真实 Rule 目录 |
| `DesignDNA` | Pattern Aggregator + Synthesizer | Component Mapper、Synthesizer、RAG | DI-0 / M1-e | 六个 Family 引用的 DNA 已入 Catalog |
| `StylePreset` | 设计目录（开发期） | designSpec、渲染器、工作台 | M1-e | 被引用 preset 已晋级并由受控消费者使用 |
| `TemplateFamily` | Blueprint Synthesizer | designSpec、装配、目录 | DI-0 / M1-e | 六个 approved Family 已入正式 Catalog |
| `Blueprint` | Blueprint Synthesizer | designSpec、装配 | DI-0 / M1-e | 由 DesignBrief 固定并交由 adapter 组装 |
| `DemoVisualPack` | 设计目录 | demo 快路径、装配 | DV-0 / M1-e | 六个 approved pack 已被受控 assembly 消费；Demo v0 保持独立兼容路径 |
| `DesignBrief` | `designSpec` Agent(P3) | copy / assembly / renderer / quality | DI-0 / M1-e | producer、重放与 ReleaseManifest v2 固化已落；quality 仍待 M1-f |
| `DesignEvaluation` | Visual Evaluator / quality(P4) | assemblyFix、发布门 | DI-0 / M1-f | 合同+validator 已落；运行时生产未落 |
| `Asset` | imagePipeline(P2)/上传 | Variant 派生、装配、删除守卫 | MF-1（薄面 MF-0） | 部分 |
| `AssetVariant` | M1-c Sharp 管线 | 渲染器、SiteSpec AssetRef | **MF-0-thin（M1-c 门）** | 表/RLS/删除与 writer 已落；M1-e-B 通过冻结 tenant/catalog overlay 消费 |
| `MediaJob` | 媒体工作流 | 成本/审计/对账 | MF-1（有真实消费者才建） | 无 |
| `AssetUsage` | Release/构建 | 删除守卫、增量重建、版权审计 | MF-1 | 无 |
| `SiteSpecAssetReferenceScanner` | 删除路径（确定性） | 删除 API（409） | **MF-0-thin** | MF0-B 已落并接 DELETE |
| `PlatformTemplateCorpus` | 工序 §8 步 9 | 未来微调/检索 | M1-e+ | 无 |

**回写路径**：本层任一实体实际落地时——① schema 合入 `@global/contracts`（SiteSpec 需升 **1.1.0**，minor 附新增可选字段，**ADR-014**）；② 生产/消费 Agent 卡回写 [03-agents.md](03-agents.md)；③ SiteSpec 引用面回写 [04-sitespec-contract.md](04-sitespec-contract.md)；④ 承重决策若变，追加 ADR 而非改本文。
