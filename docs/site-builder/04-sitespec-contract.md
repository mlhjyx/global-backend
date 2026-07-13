# SiteSpec 契约 v1

> 三方核心契约：**组装 agent**（产出）↔ **渲染器**（Astro 构建消费）↔ **SaaS 前端**（展示；将来嵌 Puck 编辑器手动微调）。
> 依据 [02-architecture.md](02-architecture.md) D11：页面数据形状与 Puck 兼容（[Puck Data 官方模型](https://puckeditor.com/docs/api-reference/data-model/data)）。

## 1. 顶层信封

```jsonc
{
  "specVersion": "1.0.0",
  "site": {
    "defaultLocale": "en",
    "locales": ["en", "de", "ar"],          // ar 触发 RTL 渲染
    "theme": { "preset": "modern-industrial", "tokenOverrides": { "colors.primary": "#0E5FA8" } },
    "nav": [{ "labelKey": "nav.home", "pageId": "home" }],
    "seoGlobal": { "siteName": "...", "orgSchema": { /* schema.org Organization */ } }
  },
  "pages": [
    { "id": "home", "path": "/", "puck": { /* Puck Data，见 §2 */ }, "seo": { "titleKey": "seo.home.title", "descriptionKey": "seo.home.desc" } }
  ],
  "assets": { "<assetId>": { "kind": "product_image", "hash": "…" } }   // manifest 快照，供校验器对账
}
```

## 2. 页面数据 = Puck 兼容形状

每页 `puck` 字段是原生 Puck Data：`{ content: ComponentData[], root: { props }, zones? }`，其中 `ComponentData = { type, props: { id, ... } }`。**采用 slot 字段路线**（Puck 官方正以 slots 取代 DropZone/zones）：嵌套子组件放在父组件 props 的 slot 数组里，不新增 zones。`props.id` 全局唯一（`{Type}-{nanoid}`），是编辑回写与 patch 定位的锚。

## 3. i18n：结构与内容分离（关键设计）

- 组件 props **不内联文案**，放 `textKey`（如 `"headlineKey": "home.hero.headline"`），指向 per-locale 的 **CopyBundle**（copy agent 的产物，落 site_version）。
- 渲染时按 locale 合并物化 → N 语种共享一份结构，改布局不动翻译、补语种不动结构；`ar` 等 RTL locale 渲染时全局 `dir="rtl"`。
- 给 Puck 编辑器时后端输出**单 locale 物化视图**（文本内联），编辑回写 API 反向写回该 locale 的 CopyBundle（结构变更写回结构）。
- 图片 `alt`、页面 seo 同走 key 间接层。

## 4. 资产引用约定

`props.image = { "assetId": "ast_…", "usage": "hero", "focalPoint": [0.5, 0.4]? }`。渲染器解析为多尺寸 `<picture>`（webp/avif）；校验器保证 `assetId ∈ assets manifest`；**禁止外链 URL 直嵌**（版权链与稳定性）。视频同理 `videoRef`。内链 = `{ "pageId": "products" }`，外链 = 显式 `{ "url": "…", "external": true }`。

## 5. v1 组件清单（section 级 17 个）

| type | 用途 | 关键 props | 变体 |
|---|---|---|---|
| HeroBanner | 首屏 | headlineKey/subheadKey/cta/bgImage 或 bgVideo | 3（大图/分栏/视频底） |
| TrustBar | 客户 logo 带 | logos[assetId] | 1 |
| ProductGrid | 产品列表 | products slot[ProductCard]/columns | 2 |
| ProductDetail | 产品详情 | gallery[]/specTable(行列 key)/certBadges/inquiryCta | 2 |
| FactoryShowcase | 工厂实力 | images[]/statsBand slot | 2 |
| CertWall | 认证墙 | certs[{assetId, labelKey}] | 1 |
| ProcessTimeline | 工艺/合作流程 | steps[{titleKey, bodyKey, icon}] | 2 |
| CaseStudies | 案例 | cases[{titleKey, bodyKey, image, countryCode?}] | 2 |
| StatsBand | 数字带 | stats[{value, labelKey}]（计数动效位） | 1 |
| AboutBlock | 简介+团队 | bodyKey/teamImages[]/foundedYear | 2 |
| FaqAccordion | FAQ | items[{qKey, aKey}] | 1 |
| CtaBanner | 行动召唤 | headlineKey/cta | 2 |
| InquiryForm | 询盘表单 | fields 配置/consentKey/蜜罐(内置)/inboxRef | 2 |
| WhatsAppFloat | 浮窗 | phone/presetMsgKey | 1 |
| VideoBlock | 视频位 | videoRef/posterImage | 1 |
| MapLocation | 工厂位置 | Google Maps **Embed API** 交互地图（D16，两步加载：默认静态占位图，访客点击才载入 iframe）；coords=建站期 Geocoding 一次缓存进 props；addressKey | 2（static/interactive） |
| NewsList (M2) | 新闻 | 数据源引用 | 1 |

Header/Footer 在 `root.props`（全站一份）。原子字段类型封闭枚举：`textKey / richtextKey / imageRef / videoRef / link / items[] / enum`；每组件另有 `variant` 与 `motionPreset` 枚举位。
**富文本（D15，用户拍板 v1 即开）**：`richtextKey` 指向的值是**受限 ProseMirror/TipTap JSON**（节点白名单：p/strong/em/ul/ol/li/h3/a(仅 https·mailto)/table）——**不存 HTML 字符串**，渲染器白名单序列化 + 输出 sanitize 双保险，注入面≈0。适用长文案字段（AboutBlock 正文/ProductDetail 描述/案例正文/FAQ 答案/新闻正文）；headline 类仍纯文本 `textKey`。copy agent 输出 schema 与校验器同步支持该格式；SaaS 前端编辑器建议 TipTap（同一 JSON 格式，可做 Puck 自定义 field）。

## 6. 主题 token 字典

`colors`（primary/secondary/surface/onSurface…）、`typography`（fontPair 枚举=自托管字体对 + 比例尺）、`spacing`/`radius`/`shadow` 比例尺、`motionIntensity`（none/subtle/normal）、`density`。**风格预设（style preset）= token 包 + 各组件默认变体映射**——工作台"风格类型"切换=换 preset 秒级重渲染。硬约束：文本/背景对比度 WCAG AA 由校验器自动验，不合格的 tokenOverrides 拒绝。

## 7. 校验器（组装/修复输出的三重门）

1. **结构**：zod schema（组件 type/props/variant 封闭枚举）。
2. **引用完整性**：assetId ∈ manifest、pageId 存在、textKey ∈ CopyBundle（各 locale 齐全或标记缺）。
3. **语义规则**：每页恰 1 个 H1（hero headline）、询盘入口 ≤2 击可达（InquiryForm 或 CtaBanner 每页可见）、Footer 必在、图片 alt key 覆盖率 100%、nav 页面互通无孤岛。
   构建期 Astro build 失败信息回填组装 agent 重试（02 §5 卡 7）。

## 8. 版本化与迁移

`specVersion` 走 semver：**minor**=新增组件/新增可选 props（渲染器容忍未知可选字段→老 spec 永远可渲染）；**major**=破坏性变更，附迁移器（`specMigrations[]` 顺序执行，重建前先迁）；组件弃用=标 `deprecated` + 声明替代组件映射，渲染器保底渲染两个 major 周期。

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
