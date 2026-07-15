# SiteSpec 契约 v1

> 三方核心契约：**组装 agent**（产出）↔ **渲染器**（Astro 构建消费）↔ **SaaS 前端**（展示；将来嵌 Puck 编辑器手动微调）。
> 依据 [02-architecture.md](02-architecture.md) D11：页面数据形状与 Puck 兼容（[Puck Data 官方模型](https://puckeditor.com/docs/api-reference/data-model/data)）。
> 决策依据：**ADR-014**（SiteSpec 三方契约，类型级单一真值 = `@global/contracts`）、**ADR-015**（26 型封闭组件库，D12）、**ADR-013**（建站边界与不可变 Release）——见 [docs/adr/registry.md](../adr/registry.md)，本文不复述整条决策。

> 🔴 **as-built 与目标态严格分栏（阅读前必读）**：
> - **as-built 1.0.0（已落地，#117 DQ-1）**：`packages/contracts/src/site-builder/site-spec.ts`，`SITE_SPEC_VERSION='1.0.0'`——**type-only 共享信封**，`copyBundles` 为 `Record<string, Record<string,string>>`（**纯字符串**），基础 `AssetRef{kind,hash}`。这是**代码事实源**（§8.1 逐字段审计）。
> - **目标态 1.1.0（DI-0 / M1-d/e 通过 semver minor 演进，SiteSpec 现无）**：`componentLibraryVersion`/`rendererVersion`/`archetype`/`familyId`/`claimRefs`/`offeringRefs`/`locks`、`RichTextDoc`、媒体/视频/产品引用契约、DesignBrief/DesignDNA 等**均为目标字段，尚无代码**（§8.2）。凡本文标 **[1.1.0 目标]** 处，`SiteSpec` 当前接口里**不存在该字段**，不得写码时当已存在。
>
> `Reviewed against 12 v3.2` · as-built SHA = #117 合并态 · 组件库 v1 = **26 型**（D12，17→26；ADR-015）。

## 1. 顶层信封

### 1.1 as-built 1.0.0（#117 已落地，代码事实）

以下为 `packages/contracts/src/site-builder/site-spec.ts` 的**当前真实形状**（type-only，两端 `import type`）。字段仅这些——`seoGlobal` 只有 `siteName`，`copyBundles` 在信封顶层且为纯字符串：

```jsonc
{
  "specVersion": "1.0.0",
  "site": {
    "defaultLocale": "en",
    "locales": ["en", "de", "ar"],                 // ar 触发 RTL 渲染（渲染器读 locale 判 dir）
    "theme": { "preset": "modern-industrial", "tokenOverrides": { "colors.primary": "#0E5FA8" } },  // tokenOverrides 可选
    "nav": [{ "labelKey": "nav.home", "pageId": "home" }],
    "seoGlobal": { "siteName": "..." }              // as-built 仅 siteName；orgSchema 是 1.1.0 目标
  },
  "pages": [
    { "id": "home", "path": "/", "puck": { /* Puck Data，见 §2 */ }, "seo": { "titleKey": "seo.home.title", "descriptionKey": "seo.home.desc" } }
  ],
  "assets": { "<assetId>": { "kind": "product_image", "hash": "…" } },  // AssetRef{kind,hash}，manifest 快照供校验器对账
  "copyBundles": { "en": { "home.hero.headline": "…" } }               // locale → (textKey → 纯字符串)
}
```

> DQ-1（#117）已把生产端（`apps/api/.../demo-spec.ts`）与消费端（`apps/site-renderer/.../lib/spec.ts`）两份手写信封**调和为唯一真值**（取兼容超集），双真值漂移**已解决、不再列待做**。逐字段 as-built 审计见 §8.1。

### 1.2 [1.1.0 目标] 信封演进（DI-0 / M1-d/e，SiteSpec 现无这些字段）

DI-0/M1-d/e 拟通过 **semver minor** 在 1.0.0 之上**兼容增量**演进到 1.1.0（老 spec 恒可渲染）。目标信封（**当前接口不含以下加粗新字段**）：

```jsonc
{
  "specVersion": "1.1.0",
  "componentLibraryVersion": "1.0.0",           // [新] 组件库版本 → 决定组件契约兼容
  "rendererVersion": "git-or-image-digest",     // [新] 渲染器版本 → 决定可重放兼容
  "site": {
    "defaultLocale": "en",
    "locales": ["en", "de"],
    "dirByLocale": { "en": "ltr", "de": "ltr" }, // [新] 显式方向表（替代按 locale 猜 dir）
    "archetype": "industrial-manufacturer",       // [新] BusinessArchetype → 决定业务/页面证据结构
    "familyId": "industrial-authority",           // [新] TemplateFamily → 决定全站视觉语法
    "theme": { "preset": "modern-industrial", "tokenOverrides": {} },
    "nav": [], "seoGlobal": {}                     // seoGlobal 目标扩 orgSchema 等
  },
  "pages": [], "assets": {}, "copyBundles": {},
  "claimRefs": {},                                // [新] 公共 Claim 引用（发布状态门，见 06/09）
  "offeringRefs": {},                             // [新] 产品/服务真相引用（§4.2）
  "locks": []                                     // [新] 人工编辑锁（provenance/可追溯）
}
```

**演进门与可重放语义**（v3.2 §6.1 回写）：`familyId` + DesignBrief 决定**视觉语法**；`archetype` 决定**业务结构**；`rendererVersion` + `componentLibraryVersion` 决定**可重放兼容性**。🔴 任一字段只有当**共享类型 + 运行时 Zod + 生产端 + Renderer + fixture + 迁移器同时合并**后才算真正进入 1.1.0——分批半落地的字段不算 1.1.0。

## 2. 页面数据 = Puck 兼容形状

每页 `puck` 字段是原生 Puck Data：`{ content: ComponentData[], root: { props }, zones? }`，其中 `ComponentData = { type, props: { id, ... } }`。**采用 slot 字段路线**（Puck 官方正以 slots 取代 DropZone/zones）：嵌套子组件放在父组件 props 的 slot 数组里，不新增 zones。`props.id` 全局唯一（`{Type}-{nanoid}`），是编辑回写与 patch 定位的锚。

## 3. i18n：结构与内容分离（关键设计）

- 组件 props **不内联文案**，放 `textKey`（如 `"headlineKey": "home.hero.headline"`），指向 per-locale 的 **CopyBundle**（copy agent 的产物，落 site_version）。
- 渲染时按 locale 合并物化 → N 语种共享一份结构，改布局不动翻译、补语种不动结构；`ar` 等 RTL locale 渲染时全局 `dir="rtl"`。
- 给 Puck 编辑器时后端输出**单 locale 物化视图**（文本内联），编辑回写 API 反向写回该 locale 的 CopyBundle（结构变更写回结构）。
- 图片 `alt`、页面 seo 同走 key 间接层。

## 4. 资产引用约定

### 4.1 as-built 约定

`props.image = { "assetId": "ast_…", "usage": "hero", "focalPoint": [0.5, 0.4]? }`。渲染器解析为多尺寸 `<picture>`（webp/avif）；校验器保证 `assetId ∈ assets manifest`；**禁止外链 URL 直嵌**（版权链与稳定性）。视频同理 `videoRef`。内链 = `{ "pageId": "products" }`，外链 = 显式 `{ "url": "…", "external": true }`。

### 4.2 [1.1.0 目标] 固定引用契约（v3.2 §6.3 回写）

1.1.0 把"引用"收紧为**确定性固定形状**，杜绝 Renderer 自行"选最新图/复制一套产品真相"：

- **图片**：`{ assetId, variantId, usage, focalPoint, altKey }`——`variantId` 显式指定用哪个派生尺寸，Renderer **不自行选"最新图"**；`altKey` 走 CopyBundle 键间接层。
- **视频**：固定 `video / poster / caption` 三个 variant + `autoplay / muted / loop / playsInline` + **`reducedMotionFallback`**（用户 prefers-reduced-motion 时降级为静态 poster）。
- **产品/服务**：ProductGrid / ProductDetail 用 `{ offeringRef, snapshotRef, textKey }`——`offeringRef` 指向唯一产品真相源，`snapshotRef` 冻结发布期快照，**不在 SiteSpec 里复制第二套产品数据**。
- **人工编辑 provenance**：所有人工编辑保存 `{ source, editor, locked, claimRefs, prompt/model provenance }`；物化 SiteSpec 可以简洁，但 **ReleaseManifest 必须可追溯**（见 [05](05-hosting-deploy.md)/[09](09-m1-build-plan.md)）。

## 5. v1 组件清单（section 级 26 个，ADR-015 / D12 封闭库）

> 🔴 **26 型封闭库是 v1 目标（ADR-015 / D12，17→26；00 已拍板）**，非全部已落地：渲染器 `apps/site-renderer/src/components/Section.astro` 当前**实注册约 10 个**（AboutBlock, CertWall, CtaBanner, FaqAccordion, HeroBanner, InquiryForm, MapLocation, ProcessTimeline, ProductGrid, StatsBand），**未知组件当前静默返回 `null`**（掩盖契约漂移、页面悄悄缺块）。补齐 26 型 + fail-closed 由 **PR M1-e-A** 落地（v3.2 §26），从测试分支 `feat/site-builder-industrial-template`（IT-0）**选择性提取实现**，🔴 **不允许测试 PR 整体覆盖共享合同**。本表是**契约唯一真值**，测试分支结果不能代替契约更新。

| type | 用途 | 关键 props | 变体 |
|---|---|---|---|
| HeroBanner | 首屏 | headlineKey/subheadKey/cta/bgImage 或 bgVideo | 3（大图/分栏/视频底） |
| TrustBar | 客户 logo 带 | logos[assetId] | 1 |
| ProductGrid | 产品列表 | products[offeringRef]/columns | 2 |
| ProductDetail | 产品详情 | offeringRef/snapshotRef/gallery[]/specTable(行列 key)/certBadges/inquiryCta | 2 |
| FactoryShowcase | 工厂实力 | images[]/statsBand slot | 2 |
| CertWall | 认证墙 | certs[{assetId, labelKey}] | 1 |
| ProcessTimeline | 工艺/合作流程 | steps[{titleKey, bodyKey, icon}] | 2 |
| CaseStudies | 案例 | cases[{titleKey, bodyKey, image, countryCode?}] | 2 |
| StatsBand | 数字带 | stats[{value, labelKey}]（计数动效位） | 1 |
| AboutBlock | 简介+团队 | bodyKey(richtext)/teamImages[]/foundedYear | 2 |
| FaqAccordion | FAQ | items[{qKey, aKey}] | 1 |
| CtaBanner | 行动召唤 | headlineKey/cta | 2 |
| InquiryForm | 询盘表单 | fields 配置/consentKey/蜜罐(内置)/inboxRef | 2 |
| WhatsAppFloat | 浮窗 | phone/presetMsgKey | 1 |
| VideoBlock | 视频位 | video/poster/caption variant/reducedMotionFallback | 1 |
| MapLocation | 工厂位置 | Google Maps **Embed API** 交互地图（D16，两步加载：默认静态占位图，访客点击才载入 iframe）；coords=建站期 Geocoding 一次缓存进 props；addressKey | 2（static/interactive） |
| NewsList (M2) | 新闻 | 数据源引用 | 1 |
| Testimonials | 客户评价 | items[{quoteKey, authorKey, roleKey?, avatar?, companyLogo?}] | 2（卡片网格/轮播） |
| PricingTable | 价格/套餐 | tiers[{nameKey, priceKey, featureKeys[], ctaKey, highlighted?}] | 2（分栏卡/对比表） |
| TeamGrid | 团队成员 | members[{nameKey, roleKey, photo, bioKey?}] 🔴personalData | 2（网格/带简介） |
| GalleryGrid | 图库 | images[{assetId, captionKey?}]/columns/lightbox? | 2（等宽网格/masonry） |
| MarqueeStrip | 滚动条（logo/关键词带） | items[textKey 或 assetId]/speed | 1 |
| IconFeatureGrid | 图标特性网格 | features[{icon, titleKey, bodyKey}]/columns | 2（3 列/4 列） |
| HistoryTimeline | 公司里程碑 | milestones[{year, titleKey, bodyKey}] | 2（纵向/横向） |
| PageHeader | 内页页头 | titleKey/subheadKey/breadcrumb?/bgImage? | 2（简洁/带背景） |
| BackToTop | 回到顶部浮标 | threshold?（滚动阈值触发） | 1 |

新增 9 型（Testimonials/PricingTable/TeamGrid/GalleryGrid/MarqueeStrip/IconFeatureGrid/HistoryTimeline/PageHeader/BackToTop）覆盖评价/定价/团队/图库/跑马灯/特性栅格/沿革/内页头/工具浮标——补齐通用 B2B 独立站版式，缓解"千篇一律"。**v1.5 候选**：News category filter、BeforeAfterCompare、RegionsGrid/MarketCoverage（v3.2 §6.2）。**premium 特例**：ScrollVideoHero、Interactive3DHero **不进通用封闭库**（ADR-015）。

Header/Footer 在 `root.props`（全站一份）。原子字段类型封闭枚举：`textKey / richtextKey / imageRef / videoRef / link / items[] / enum`；每组件另有 `variant` 与 `motionPreset` 枚举位。
**富文本（D15，用户拍板 v1 即开）**：`richtextKey` 指向的值是**受限 ProseMirror/TipTap JSON**（节点白名单：p/strong/em/ul/ol/li/h3/a(仅 https·mailto)/table）——**不存 HTML 字符串**，渲染器白名单序列化 + 输出 sanitize 双保险，注入面≈0。适用长文案字段（AboutBlock 正文/ProductDetail 描述/案例正文/FAQ 答案/新闻正文）；headline 类仍纯文本 `textKey`。copy agent 输出 schema 与校验器同步支持该格式；SaaS 前端编辑器建议 TipTap（同一 JSON 格式，可做 Puck 自定义 field）。[1.1.0 目标] `copyBundles` 从 `Record<string,string>` 升为 `Record<string, string | RichTextDoc>`（§8.2）。

### 5.1 每组件必备产物与 fail-closed（v3.2 §6.2 回写）

每个组件（含新增 9 型）落地时**必须齐备七件套**，缺一不入库：**① schema（props/variant/motion 封闭枚举）② 变体 ③ 内容预算（§5.2）④ a11y 合同 ⑤ reduced-motion 降级 ⑥ fixture ⑦ 三断点视觉回归**。
🔴 **fail-closed**：未知组件 type / 未注册 variant——**开发态显示带路径的错误块**（不静默吞内容），**测试与生产构建直接失败**。这纠正 as-built 的"静默 `null`"行为（PR M1-e-A + 下一 Renderer PR 修，见 §7 兼容门）。

### 5.2 内容预算（Content Budget，v3.2 §17 回写）

每组件每文案字段有**长度上限**，写进组件 schema 与 DesignBrief（[1.1.0 目标] `TemplateFamily.contentBudgets` / `DesignBrief.contentBudgets`，§8.2）。校验器（§7 语义门）超预算时**优先换变体或定向重写，禁止用 CSS 缩字号到不可读**。基线（可按 Family 覆写）：

| 字段类 | 组件示例 | 预算（上限） |
|---|---|---|
| headline | Hero/CtaBanner/PageHeader | ≤ 60 字符 / 8 词 |
| subhead | Hero/PageHeader | ≤ 140 字符 |
| 卡片标题 | ProductGrid/IconFeatureGrid/CaseStudies | ≤ 48 字符 |
| 卡片正文 | IconFeatureGrid/CaseStudies/Testimonials | ≤ 240 字符 |
| 富文本正文段 | AboutBlock/ProductDetail | ≤ 3 段 / 段 ≤ 400 字符 |
| stat 数值/标签 | StatsBand | 数值 ≤ 8 字符、标签 ≤ 24 字符 |
| 引用语 | Testimonials | ≤ 280 字符 |
| 里程碑条目 | HistoryTimeline | 标题 ≤ 40、正文 ≤ 160 字符 |
| CTA 按钮 | 全组件 | ≤ 24 字符 / 4 词 |

### 5.3 兼容矩阵（组件 × 变体 × 相邻，v3.2 §17.2 回写）

Assembler **先过兼容矩阵，再调模型或写 SiteSpec**；[1.1.0 目标] 由 `TemplateFamily.componentVariants` + `adjacencyRules` 约束（§8.2）。硬规则：

- `full_bleed` Hero 后**不得紧接**另一 `full_bleed` 图文块；连续 **card-grid 类组件禁超 3 个**；深色大区块**连续最多 2 个**。
- **证据门（无证据即删组件，绝不虚构 → ADR-017）**：StatsBand 需 ≥2 个有证据数值否则删；**Testimonials 需用户提供的可验证引用**否则删；**TeamGrid 需明确授权的人物资料**（🔴personalData）否则删；CertWall 需资产或事实证据否则删；MapLocation 地址不可验证时**只显地址文本**（不出交互地图）。
- **素材门**：产品 < 3 时不用 dense ProductGrid；缺宽图时不选 `full_bleed` Hero。
- 主题×变体可组合性：`variant`/`motionPreset` 均封闭枚举，Family 声明每组件允许的 variant 集合；不在集合内 = 兼容门失败（fail-closed）。

### 5.4 反模板阈值（Genericness，v3.2 §17.4 回写）

M1-f 确定性 QA 增 genericness 检查，避免"千篇一律"。建议阈值（超阈触发定向重排/重写，最多三轮）：

- 同站**连续结构重复 ≤ 2**；卡片式 section **≤ 可见 section 的 50%**。
- 同站**多页 Hero 构图完全相同 ≤ 50%**；同一批 10 样本**首页 Blueprint 完全相同 ≤ 30%**。
- 监测维度：相邻区块结构重复率、图像占位重复率、CTA 文案/位置重复率、"只换配色不换版式"比例、**无证据营销形容词密度**。

## 6. 主题 token 字典

`colors`（primary/secondary/surface/onSurface…）、`typography`（fontPair 枚举=自托管字体对 + 比例尺）、`spacing`/`radius`/`shadow` 比例尺、`motionIntensity`（none/subtle/normal）、`density`。**风格预设（style preset）= token 包 + 各组件默认变体映射**——工作台"风格类型"切换=换 preset 秒级重渲染。硬约束：文本/背景对比度 WCAG AA 由校验器自动验，不合格的 tokenOverrides 拒绝。

## 7. 校验器（组装/修复输出的三重门 + 兼容门）

> [as-built] `site-spec.ts` 现为 **type-only**（编译期防两端漂移）；**运行时 Zod 三重门尚未落地**，是 DQ-1 的 follow-up（有非可信 JSON 消费者时以独立 PR 叠加，与 TS 合同同源，**非 DQ-1 返工**，v3.2 §25.1）。渲染器 `loadSpec` 处 `parse` 把生产端违约变成响亮构建错误。以下为目标门（v3.2 §6.4 回写为四门）：

1. **Schema 门（结构）**：组件 type、props、variant、motion、RichText、版本——**全部封闭枚举**（Zod schema）。
2. **Reference 门（引用完整性）**：asset/variant/page/text/**claim/offering/lock** 全部存在且**属于相同 workspace/site/release**（各 locale 齐全或标记缺）。
3. **Semantic 门（语义规则）**：每页恰 1 个 H1（hero headline）、询盘入口 ≤2 击可达（InquiryForm 或 CtaBanner 每页可见）、Footer 必在、图片 alt key 覆盖率 100%、nav 页面互通无孤岛、**表单/法务/locale 合法、Claim 发布状态合法、视频降级到位、用户锁定合法**。
4. **Compatibility 门（兼容）**：Renderer **显式声明**支持的 `specVersion` / `componentLibraryVersion` 范围；不兼容时**构建前失败**——🔴 **不静默丢 section / 不返回 `null`**（纠正 as-built Section.astro 静默行为，见 §5.1）。
   构建期 Astro build 失败信息回填组装 agent 重试（02 §5 卡 7）。

## 8. 版本化与迁移

### 8.1 as-built 1.0.0 逐字段审计（#117 DQ-1，代码事实）

`@global/contracts` 的 SiteSpec 1.0.0 **有什么 / 没什么**（`site-spec.ts` 逐条核对）：

| 有（as-built 1.0.0） | 没有（均为 1.1.0 目标，代码现无） |
|---|---|
| type-only 共享顶层信封（`SiteSpec`/`SitePage`/`PuckData`/`PuckBlock`/`AssetRef`） | `componentLibraryVersion` / `rendererVersion` |
| `SITE_SPEC_VERSION='1.0.0'` 常量 | `site.dirByLocale` / `archetype` / `familyId` |
| **string-only** `copyBundles: Record<string, Record<string,string>>` | `claimRefs` / `offeringRefs` / `locks` |
| 基础 `AssetRef { kind, hash }` | `RichTextDoc`（copyBundles 仍纯字符串） |
| `theme.tokenOverrides?` 可选、`root.props?` 可选（调和后） | `DesignBrief` / `DesignDNA` / `TemplateFamily`（尚无代码消费者） |

🔴 DQ-1 **双真值漂移已解决，不能再列待做**。`packages/contracts` 是 SiteSpec 1.0.0 **唯一类型源，不得重建第二份**；API 与 Renderer 都 `import type` 之。

### 8.2 [1.1.0 目标] schema 演进（cross-ref §1.2）

1.1.0 目标信封字段见 **§1.2**；引用契约（媒体/视频/产品/provenance）见 **§4.2**；RichText 升级见 **§5 富文本段**；内容预算/兼容矩阵见 **§5.2/§5.3**。后续设计智能契约（DesignDNA / TemplateFamily / DesignBrief / EvidenceRef / ModelProfile）与 contracts 目录布局见 **§11**。这些**由 DI-0 / M1-d/e/f 增量演进，DQ-1（#117）不复用编号、不返工**。

### 8.3 semver 与迁移规则

`specVersion` 走 semver：**minor**=新增组件/新增可选 props（渲染器容忍未知可选字段→老 spec 永远可渲染，1.0.0→1.1.0 即走此路）；**major**=破坏性变更，附迁移器（`specMigrations[]` 顺序执行，重建前先迁）；组件弃用=标 `deprecated` + 声明替代组件映射，渲染器保底渲染两个 major 周期。🔴 字段"真正进入 1.1.0"的门见 §1.2（六件同时合并）。

## 9. Puck 兼容边界（给 SaaS 前端）

- **兼容的**：页面级 content/root/props/id 形状、slot 嵌套——前端可直接用 Puck 编辑器组件加载物化视图。
- **我们扩展的**：textKey 间接层、assetId 引用、信封层（locales/theme/seo）——对 Puck 是透传字段，编辑器不识别不报错。
- **前端要做的**：按 §5 组件表配置 Puck fields（编辑表单）；调后端"物化视图"接口取单 locale 数据、编辑后调回写接口。字段契约以本文件为唯一真值。

## 10. 拍板记录（2026-07-14 用户拍板，推翻原建议）

1. **D15 富文本 v1 即开**——安全方案见 §5（受限 JSON 富文本，不存 HTML）。
2. **D16 Google Maps 交互地图**——用 **Embed API**（官方免费无限量）+ 两步加载（GDPR 不强制 cookie banner）。
   **用户申请清单**（key 到位后 M0 可接）：
   1. GCP 专用项目（如 `site-builder-maps`）→ 绑卡开计费账号（Embed API 零计费，绑卡是门槛要求）→ 设预算告警（$1 触发邮件）。
   2. 启用两个 API：**Maps Embed API**（主力，免费无限）+ **Geocoding API**（建站期地址转坐标一次并缓存，走每月 1 万次免费额度）。
   3. 建 2 把 key：**前端 key**（HTTP referrer 限制：`*.preview.<平台域>`，客户自定义域由发布流程自动追加）；**后端 key**（限服务器 IP，仅授 Geocoding）。

## 11. 共享契约目录与设计智能契约（as-built 边界 + DI-0 目标态）

> 本节把 SiteSpec 之外的**衍生共享契约**收进同一处（`packages/contracts/src/site-builder/`）。🔴 **除 `site-spec.ts`（#117 已落地）外，本节所有类型均为 DI-0 / M1-d/e 目标态，代码尚无消费者**——不得写成已存在。DesignBrief 深入用途见 [03-agents.md](03-agents.md)，落地分期见 [09-m1-build-plan.md](09-m1-build-plan.md)。

### 11.1 Contracts 目录布局（v3.2 §25.1 回写）

`packages/contracts` **已是 SiteSpec 1.0.0 唯一类型源，不得重建第二份**（API 与 Renderer 共同 `import type`）。DI-0 按**消费者增量新增**以下文件（非一次性造齐；运行时 Zod 仅在出现非可信 JSON 消费者时以独立 PR 叠加，与 TS 合同同源）：

```
packages/contracts/src/site-builder/
  site-spec.ts          # ✅ #117 已落地（1.0.0）
  design-source.ts      # DI-0 目标：DesignSourceManifest / DesignObservation（净室，ADR-019）
  design-dna.ts         # DI-0 目标：DesignDNA（§11.3）
  template-family.ts    # DI-0 目标：TemplateFamily
  design-brief.ts       # DI-0 目标：DesignBrief（每次生成冻结决策）
  design-evaluation.ts  # M1-f 目标：DesignEvaluation（审美/反模板）
  media.ts              # 目标：AssetVariant / 媒体引用契约（§4.2）
  release-manifest.ts   # M2 目标：ReleaseManifest（可追溯，ADR-013）
  model-policy.ts       # MODEL-0 目标：ModelProfile 与四态路由（§11.5，ADR-016）
  index.ts              # 入口导出
```

### 11.2 设计领域模型：六概念必须分开（v3.2 §15.1 回写）

当前 `demo-spec` 把 BusinessArchetype / TemplateFamily / StylePreset 混成一个"关键词主题"选择——**必须拆开**。SiteSpec 1.1.0 的 `archetype` / `familyId` 即这两轴的落点：

| 概念 | 回答的问题 | 示例 |
|---|---|---|
| **BusinessArchetype** | 这家公司需要什么页面和证据结构 | OEM 制造、技术目录、B2B 解决方案 |
| **TemplateFamily** | 全站使用什么一致的视觉语法 | precision-industrial |
| **StylePreset** | 该语法下的一组具体 token | graphite-cobalt |
| **IndustryPack** | 行业术语、区块偏好和证据提示 | pump-machinery |
| **MarketPack** | 目标国的语言、合规、格式和信任元素 | de-DE |
| **DemoVisualPack** | 无用户素材时可安全展示什么 | generic-machinery-dark |

### 11.3 DesignDNA 类型契约（schemaVersion '1.0'，v3.2 §15.2）

设计语言的**抽象**，不含页面实例（`design-dna.ts` 目标）：

```ts
export interface DesignDNA {
  schemaVersion: '1.0';
  id: string; name: string;
  hierarchy: { displayScale: 'compact'|'balanced'|'editorial'; headingContrast: 'low'|'medium'|'high'; maxReadingWidthRem: number };
  spatialRhythm: { sectionGapPx: [number, number]; contentGapPx: [number, number]; density: 'airy'|'balanced'|'dense' };
  composition: { heroModes: Array<'split'|'full_bleed'|'editorial'|'product_stage'|'technical'>; imageTextRatios: string[]; alignmentBias: 'left'|'center'|'mixed' };
  surfaces: { cardStyle: 'flat'|'bordered'|'elevated'|'tinted'; borderWeight: 'none'|'hairline'|'strong'; radius: 'none'|'subtle'|'soft' };
  imagery: { preferredSubjects: string[]; cropModes: Array<'contain'|'cover'|'editorial_crop'>; backgroundPolicy: 'light'|'dark'|'mixed'; maxGeneratedMediaRatio: number };
  motion: { intensity: 'none'|'low'|'medium'; allowed: string[]; forbidden: string[] };
  antiPatterns: string[];
}
```

**TemplateFamily / DesignBrief**（`template-family.ts` / `design-brief.ts` 目标）承载 `blueprints` / `componentVariants` / `adjacencyRules`（§5.3）/ `contentBudgets`（§5.2）/ `variationSeed`（受控差异化）等——`catalogVersion` / `familyVersion` / `variationSeed` **必须落入构建工件保证可重放**，同一 SiteBuildRun 内不因重试漂移。完整字段见 v3.2 §15.3–15.4 与 03-agents。

### 11.4 EvidenceRef：Evidence 2.0（v3.2 §24.7 / PR R4-A，早于 M1-d）

Evidence 从"只贴 sourceType"升级为**引用精确 source/chunk**（`design-source.ts` 或 fact 层目标）：

```ts
export interface EvidenceRef {
  sourceId: string;
  sourceType: 'intake' | 'upload' | 'storefront' | 'web_research';
  contentHash: string;   // 冻结语料 hash
  quote: string;         // 必须命中 sourceId 对应冻结语料
  assetId?: string; url?: string; fetchedAt?: string;
}
```

硬规则（择要）：FactSheet 每条事实**必须有 quote 且命中冻结语料**；value 里的数字/单位/认证代码/专名须在 quote 中一致出现，否则降 gap；**web 搜索 snippet 只作 research_hint，绝不直接成 publishable fact**；认证必须引用 ready 的 cert Asset 或人工 verified（🔴 与 ADR-017 禁虚构身份同源）。

### 11.5 ModelProfile：Agent 只绑 profile 不绑型号（v3.2 §23.4，ADR-016）

新增稳定 `ModelProfile` 联合类型（`model-policy.ts` 目标，15 成员）；业务 Agent 只引用 profile：

```ts
export type ModelProfile =
  | 'structured.default' | 'reasoning.high' | 'copy.premium' | 'text.bulk'
  | 'multimodal.review' | 'text.summary' | 'image.precise_edit'
  | 'image.bulk.creative' | 'image.premium.design' | 'video.primary'
  | 'video.premium' | 'speech.production' | 'transcription'
  | 'moderation.media' | 'embedding.private';
```

路由四态 = `currentRoute`（现役 as-built）/ `evaluatedCandidate` / `targetCandidate` / `promotedRoute` + `deterministicFallback`；候选晋升**只经评测，非采购承诺**。deepseek 一律**显式 `v4-pro` / `v4-flash`**（`chat`/`reasoner` 别名官方 2026-07-24 关停）。[as-built] `apps/api/src/site-builder/agents/task-routes.ts` 现有 **7 个 task**（`brand_profile / copy / design_spec / assemble / assembly_fix / qa_summarize / seo_review`）；MODEL-0 把 `task → model string` 改为 `task → profile + task budget`。详见 [03-agents.md](03-agents.md) 与 [10-model-selection-study.md](10-model-selection-study.md)。
