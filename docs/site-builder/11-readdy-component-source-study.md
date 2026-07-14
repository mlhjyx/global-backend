# 11 · readdy 研究：API 能力 + demo 逆向 + 组件库扩展方案

> 2026-07-14。回答两个问题：①「组件不够怎么办」②readdy API 怎么用/怎么联动。
> 方法：官方文档全量检索 + API key 只读真探（ToS §5.3.4 边界内）+ 5 个 demo 经公开 sourcemap 逆向出完整 TSX 源码逐一分析。

## 结论速览

1. **readdy 无公开 API**（官方 docs 零 API reference、Product Hunt 官方答复 no API/MCP plans；`rdy_` key 对全部可发现端点只读真探均被拒）——key 留存 .env，若要 API 唯一正道=邮件 hi@readdy.ai 索取文档。
2. **可用面 = 产品内导出**：React+Tailwind+TS 完整工程 / GitHub 双向同步 / Figma 稿；ToS §6.5 产物归用户可商用（⚠️ §6.6 非独占、§6.7 默认用产物训模型可邮件 opt-out、§5.3.4 禁逆向、§5.3.6 禁训竞品 AI）。
3. **D9 修订建议：仅设计基准 → 开发期设计源**——自己账号生成→导出→按固定工序改造成 Astro 组件入封闭库；运行时逐站生成明确否决（无 API + 撞 D1 + 数据出境）。
4. **readdy 产物直接上线一条红线都过不了**（Google Fonts CDN/cdnjs 图标/readdy 托管图片与表单/Maps iframe/零 a11y/SPA 首屏空 HTML 伤 SEO）——反向验证了我们「封闭组件库+静态直出」架构的正确性；改造工序（自托管字体/本地图标/素材库接管/a11y 补齐）即我们的增值。
5. **组件缺口实证**：v1 17 型已覆盖 readdy 词汇表 13 型（TrustBar/CertWall/WhatsAppFloat 是我们有它没有的外贸特化）；缺口=9 个小难度（合计约 1-1.5 人天）+3 个中难度（v1.5）+沉浸叙事类不进封闭库。建议 **M1-e 扩容 17→26 型**。

---

# 附录 A：API 研究全文

已完成研究与只读真探。以下为完整结论。

---

# Readdy 作为独立站组件/设计源的评估

## 结论先行（TL;DR）

- **Readdy 没有可编程调用的公开 REST API**。官方帮助中心（Mintlify，全站索引 `llms.txt`）**没有任何 API Reference / 端点 / 鉴权文档**；`AI Model Integration` 文档是空壳桩。Product Hunt 官方回复明确「**no API/MCP plans yet**」。
- 账号里那个「**Generate API Key**」（`readdy.ai/user/api-key`，UI 文案「Generate an API Key to access the API.」）**指向一个未公开、无文档的 API**。我用 .env 里的 key（`rdy` 前缀、36 字符）对全部可发现端点做只读真探，**所有已知鉴权头形态都被拒**（下详）。当前这把 key 打不通任何可发现的端点。
- Readdy 的真正价值不在 API，而在**产品内导出**：可把生成结果导出为 **React + Tailwind + TypeScript(Vite)** 独立工程（或 HTML / Vue 系模板），支持 **GitHub 双向同步**、**Figma 导出**、**代码编辑器直看源码**。
- ToS 关键：**你拥有 Output（§6.5 权利转让给你）**、未禁商用；但 **§6.6 非独占**（Readdy 可把相似产物给别人）、**§6.7 用你的输入/输出训模型**（可邮件 opt-out）、**§5.3.4 禁逆向**、**§5.3.6 禁用 Output 去训练/开发与其竞争的 AI**。
- **对我们最合适的姿势是 (a) 开发期设计源**：产品内生成 → 导出 React/Tailwind → 人工改造成 Astro 组件入库。合规、成本可控、与 D1 架构零冲突。**(b) 运行时逐站生成不可行**（无 API + 与封闭组件库架构正面冲突）。

---

## 任务 A.1 — Readdy API 到底怎么用（文档层）

### 鉴权 / API 形态
- **公开 API：不存在**。`docs.readdy.ai/llms.txt` 全量索引里**没有** api-reference / endpoints / authentication 任何条目；`integrations/ai-model.md` 仅有标题无正文。
- 账号内有 **API Key 生成器**（前端路由 `api-key`，接口 `POST /api/apikey/generate`、`GET /api/apikey`、`DELETE`）。i18n 串证实其存在：`"You haven't generated an API Key yet." / "Generate an API Key to access the API."` —— 但**「the API」是什么、怎么调、哪个 base、哪种鉴权头，官方 0 文档**。
- 无 `api.readdy.ai` / `mcp.readdy.ai` / `open.readdy.ai` / `developer(s).readdy.ai` / `agent.readdy.ai` 子域（全 NXDOMAIN）；`readdy.ai/mcp`、`readdy.ai/api/mcp` 均 404。**没有 MCP**。

### 产物形态（这才是可用面）
- **代码导出**：`Code Editor` 文档原文——导出 **standalone, production-ready projects built with React, Tailwind CSS and TypeScript**，含 `vite.config.ts`/`tailwind.config.ts`，「**Full Ownership** / zero vendor lock-in」。
- **多模板**：发布文档列出可选框架 **HTML / Vue / Vue-Ant Design / Vue-Element / Vue2 / React / React-Ant Design / React-Shadcn / UniApp**。
- **GitHub 集成**：`/api/project/github/push|pull|repo/bind` —— 建私有仓、双向同步源码（这是把产物拿出来的最顺路径）。
- **Figma 导出**：装 Readdy Figma 插件，导出「当前页面状态」为可编辑设计稿（粘贴 design data 进插件）。
- 均为**付费档**能力（代码/设计导出在订阅内）。

### 配额 / 计费
- **信用点（credits）制**，按功能复杂度扣点，档位见 `account/plans.md`、`account/credit.md`（页面正文未含「API」计费项——因为无公开 API 计费）。

### API ToS（决定能否当组件源的关键）
| 条款 | 内容 | 对我们的影响 |
|---|---|---|
| §6.5 | **你拥有 Output**，Readdy 把全部权利转让给你 | ✅ 生成的站/代码归你，可商用 |
| §6.6 | 转让**非独占**；Readdy 可把「相同或相似」产物给第三方 | ⚠️ 设计**不排他**——不能当「独家资产」，只能当灵感/基线 |
| §6.7 | Readdy 保留用你的 Input/Output **训模型**权（可邮件 hi@readdy.ai opt-out） | ⚠️ 隐私/保密项，商业上一般可接受 |
| §5.3.4 | **禁逆向、反编译、绕过保护机制** | 🔴 不可爬其运行时/逆向其生成系统；本次真探仅用**官方给的 key + 标准鉴权头**、且只读，不触此线 |
| §5.3.5 | 未经书面许可，不得将「Readdy AI Features 内的信息与内容」用于商业/再分发 | ⚠️ 指平台自身内容；你自己的 Output 由 §6.5 覆盖，但**别把 Readdy 模板库整包搬运**当卖点 |
| §5.3.6 | **禁用 Output 训练/开发与 Readdy 竞争的 AI 系统** | 🔴 我们不是做 AI 建站竞品，安全；但别拿它的产出去喂我们自己的「生成组件的 AI」 |

**净判定**：把 Output 导出后**人工改造成自有 Astro 组件**——你在行使 §6.5 所有权、做的是再创作而非再分发、不逆向、不训竞品——是 ToS 下最干净的用法。

---

## 任务 A.2 — 只读真探结果（脱敏）

用 `.env` 的 `READDY_API_KEY`（`rdy` 前缀，36 字符）**只调 GET/list 类**，绝未触发任何生成/写/计费端点。域名固定 `https://readdy.ai`（无独立 API 域）。响应统一信封：`{code, data, meta:{time, request_id, message, detail}}`。

| 端点 | 鉴权头 | HTTP | 响应形状（脱敏） |
|---|---|---|---|
| `GET /api/account/info` | 无 | **401** | `code:"UnAuthorized"`, `meta.message:"missing token"` |
| `GET /api/account/info` | `Authorization: Bearer <key>` | **401** | `message:"unknown token type"` |
| `GET /api/account/info` | `Authorization: <key>` / `Api-Key` / `Token` | **401** | `"unknown token type"` |
| `GET /api/account/info` | `X-API-Key` / `Api-Key` / `token` / `X-Readdy-Api-Key` | **401** | `"missing token"`（头未被识别） |
| `GET /api/conf` | Bearer | **401** | `"unknown token type"` |
| `GET /api/apikey`、`/api/form/list`、`/api/project/msg_list` | Bearer | **404** | `404 page not found`（内部端点走会话态 SPA 代理，非直连） |
| `GET /sapi/outreach/leads/lists`、`/sapi/batch_task/tasks` | Bearer | **401** | `"unknown token type"` |

**解读**：`readdy.ai/api/*` 与 `/sapi/*` 是 Web 应用的**会话 JWT 内部端点**（识别 `Authorization` 头但只认其自家 token 类型，故报「unknown token type」；不识别 `X-API-Key` 故报「missing token」）。**这把生成式 API Key 不是这些端点的凭据**——它属于另一套没有任何公开线索的接口（无文档、无子域、无路径提示）。**我未继续暴力猜测 base/头形态**：一是 ToS §5.3.4 禁绕过/逆向，二是无端会打到写端点。

**真探净结论**：文档 + 真探双向印证——**Readdy 现阶段对外没有可用来「按 ICP 逐站生成」的可编程 API**。那把 key 目前处于「能生成、无处可用」状态。

---

## 任务 A.3 — 三种联动姿势评估

### (a) 开发期设计源：生成 → 人工改造入 Astro 组件库 ✅ 推荐
- **可行性**：高。走**产品内交互**（非 API）：描述需求 → 生成 → **导出 React+Tailwind 工程 / GitHub 同步 / Figma 稿** → 团队把版式、间距、配色、交互模式**重写为我们 17 种 section 的第 18…N 种 Astro 组件**。Tailwind 语义与我们渲染器同源，视觉 token 迁移成本低。
- **合规**：最干净。行使 §6.5 所有权 + 再创作，不逆向(§5.3.4)、不训竞品(§5.3.6)、不整包搬运其模板(§5.3.5)。仅需接受 §6.6 非独占 + §6.7 训练（可 opt-out）。
- **成本**：credits 按次，且**一次性**（生成期投入，产物沉淀进我们组件库后零重复计费）。
- **对 D1 架构冲突**：**无**。Readdy 只当「设计稿供给侧」，运行时仍是我们封闭组件库 + SiteSpec JSON 组装，架构不变。
- **落地建议**：把它当「**扩组件时的美术/版式外包**」而非依赖。产出**必须过我们的组件契约与设计系统**（token、a11y、响应式、暗色），Readdy 稿只作视觉参考，代码不直接入库（避免风格漂移 + §6.6 非独占风险）。

### (b) 运行时逐站生成 ❌ 不可行
- **技术**：**无公开 API**（本次已证），根本无法在我们后端按租户 ICP 触发生成。
- **架构**：即便未来开放 API，也与 **D1「封闭组件库 + SiteSpec 组装」正面冲突**——逐站生成 = 每站产出不可控的任意 React 工程，丧失组件白名单、可控渲染、可审计性、批量一致性，等于把我们的确定性渲染器换成黑箱。
- **合规**：把租户/买家数据喂第三方生成器，触碰 §6.7 训练留存 + 数据出境；且 §6.6 非独占意味站与站可能撞脸。
- **判定**：**放弃**。

### (c) 仅设计基准、不联动 ✅ 低成本兜底
- 用 Readdy（及其模板库、Figma 导出）当**竞品/风格基线**：看它对不同行业出的版式、hero/pricing/FAQ 等 section 组织方式，反哺我们「组件不够」时**该补哪些 section 类型**的判断，不导出、不改造。
- **合规**：纯观摩，风险最低。**成本**：仅订阅费。**适合**：先探路，确认某类版式值得做再升级到 (a)。

---

## 查不到 / 需用户拍板的

1. **那把 API Key 到底通向什么**：无任何公开线索。若确有需要，**唯一正道是邮件 hi@readdy.ai 要 API 文档**（我不逆向猜测，受 §5.3.4 约束）。大概率是内测/合作向或绑定某单一功能，**不是通用建站 API**。
2. **导出代码的授权粒度**是否随订阅档变化、Figma/GitHub 导出是否含商用限制细则——文档未逐条列，签约前建议向其确认。
3. **§6.6 非独占**对我们「独立站要差异化」是实质约束：Readdy 产物只能当**起点**，最终视觉必须经我们设计系统再加工才具备排他性。

---

## 给你的一句话建议

**采纳姿势 (a) + 用 (c) 兜底，明确排除 (b)**：把 Readdy 定位成「**开发期扩组件时的设计/版式供给**」——产品内生成、导出 React/Tailwind 或 Figma 稿、**人工重写为 Astro 组件入封闭库**。这既补齐「组件不够」的缺口，又不动 D1 架构、不碰合规红线、不产生运行时依赖。**不要**把它接进后端做运行时逐站生成（无 API + 架构冲突 + 数据出境）。那把 key 暂时留着无用，除非向官方拿到 API 文档。

相关文件（绝对路径，均为本次临时分析产物，可删）：
- `/private/tmp/claude-501/-Users-xin-Documents-Global/43c9deda-5f28-41bd-a6f9-6b55b9e734c7/scratchpad/index.js`（Readdy SPA 主包，用于提取端点清单）
- `/private/tmp/claude-501/-Users-xin-Documents-Global/43c9deda-5f28-41bd-a6f9-6b55b9e734c7/scratchpad/apikey-page.js`（api-key 页面 chunk）
- key 本体在 `/Users/xin/Documents/Global/.claude/worktrees/site-builder-m0/apps/api/.env` 的 `READDY_API_KEY`（未在本输出明文出现）

Sources:
- [Readdy Docs — Welcome / llms.txt 索引](https://docs.readdy.ai/welcome)
- [Readdy Docs — Code Editor（React/Tailwind/TS 导出）](https://docs.readdy.ai/features/code-editor.md)
- [Readdy Docs — Publish for React（多框架模板）](https://docs.readdy.ai/features/publish-react-v2.md)
- [Readdy Docs — Export to Figma/MasterGo](https://docs.readdy.ai/integrations/figma.md)
- [Readdy — API Key 页面](https://readdy.ai/user/api-key)
- [Readdy — Terms of Service（§5.3 / §6.5-6.7）](https://readdy.ai/terms-of-service)
- [Product Hunt — Readdy（"no API/MCP plans yet"）](https://www.producthunt.com/products/readdy)

---

# 附录 B：5 demo 逆向分析全文

全部数据已到位，撰写最终报告。

# readdy 5 demo 逆向分析报告（任务 B）

**方法**：5 个预览链接全部 curl 抓取成功（HTTP 200）。关键突破：readdy 预览产物**公开发布了 sourcemap（含 `sourcesContent` 完整原始 TSX 源码）**，本次分析基于逆向还原出的 5 套完整源码树（存于 `/private/tmp/claude-501/-Users-xin-Documents-Global/43c9deda-5f28-41bd-a6f9-6b55b9e734c7/scratchpad/d1_src…d5_src`），非仅 DOM 猜测，结论置信度高。

## 0. 总体指纹（5 个 demo 完全同构的工程骨架）

| 项 | 结论（5/5 一致，除注明外） |
|---|---|
| 框架 | **Vite + React 18+（createRoot）+ react-router v7 + TypeScript**，SPA（`div#root`，无 SSR/SEO 直出——首屏 HTML 只有 meta） |
| 样式 | **Tailwind v3**（`--tw-*` 自定义属性签名，非 v4）+ 每站自定义 token（如 `bone-50`/`ink-900`）+ 自写 `@keyframes` |
| 结构约定 | `src/pages/<route>/page.tsx` + 同目录 `components/<Section>.tsx`，**一个 section = 一个组件文件**（30~770 行），mock 数据以 `const` 数组内联在组件头部 |
| i18n | i18next 全部装了但**零翻译文件、文案硬编码英文**（空壳脚手架） |
| 表单 | 统一 POST 到 **`readdy.ai/api/form/<id>`** 托管收单端点（d1/d3/d4/d5 共 4 处） |
| 图片 | 统一走 **`readdy.ai/api/search-image?query=<长英文prompt>&…`** 动态 AI 图片端点（d1×15、d3×21、d4×7、d5×33）；d2 用 pexels 热链 |
| 视频 | `public.readdy.ai/ai/video_res/*.mp4`（AI 生成）+ `storage.readdy-site.link/project_files/*`（项目素材桶） |
| 第三方外呼 | **Google Fonts + cdnjs（FontAwesome 6.4 + RemixIcon 4.5）5/5 全中**；另有 unpkg/jsDelivr/raw.githubusercontent（d1 three.js+GLTF）、Google Maps iframe（d3）、superspl.at iframe（d4）、Supabase（d4）、pexels（d2） |
| 预览层 | 每站注入 `preview-inject/*`（错误捕获、水印、路由调试、动画预览 runtime）+ `readdy-project-version` meta——是预览器附加物，导出产物应不含 |

## 1. 逐 demo 分析

### Demo 1 — AXIOM 耳机（高端产品发布单页，preview.amazingsite.co = readdy 白标预览域）
- **技术栈特例**：importmap 从 **unpkg 动态加载 three.js 0.160 + GLTFLoader**，GLTF 模型热链 GitHub raw（jsDelivr 兜底）；bundle 438KB 单页全量
- **Section 清单（1 页 ×13 组件）**：① 500vh sticky 滚动叙事 Hero（GridBackground 网格画布 + **three.js 实时渲染 ProductShowcase**（587 行：scroll-scrub 旋转/上色/锚点标注/Chapter2 位移）+ Headline/Subtitle/AnchorLabels(767 行)/TopNav/BottomInfoBar 七件套）② SoundArchitecture 产品系列深潜（716 行）③ Colorways 配色变体切换（723 行，15 张 AI 图）④ StudioSection 品牌故事 ⑤ ReserveSection 预订表单（679 行，选项卡+提交状态机→readdy form API）⑥ SiteFooter（marquee+社交）
- **动效**：自研 `heroSignals.ts` 滚动进度 pub/sub 总线（`scrollY/(docHeight-viewport)` 映射时间轴 0~1 分五幕）、rAF、IntersectionObserver reveal、14 个自命名 keyframes（marquee/shimmer/ripple…）
- **响应式/a11y**：断点类极少（md:5/lg:16）——**本质桌面优先的沉浸页**；aria×9、alt×4、无 focus 样式、无 `prefers-reduced-motion`
- **图片**：全部 readdy AI 端点热链，无 srcset/无 lazy

### Demo 2 — NOVA 创意工作室（单页作品集）
- **Section 清单（1 页 ×6）**：Navbar（scrollY 感知变底）→ Hero（**全屏自动播放 AI 视频** + 3 枚统计数字）→ Work 项目案例列表（hover 展开）→ Studio 介绍（pexels 图）→ Process 五步流程（01-05 编号+周数，hover 交互）→ Journal 文章列表（**类目筛选** All/Essay/Field notes/Interview）；**无独立 Footer**
- **动效**：纯 CSS（transition/hover + fade-up/float-slow/marquee/shimmer keyframes），无 IO、无动效库——最轻的一个
- **响应式/a11y**：md:×77/lg:×34 正经移动适配；aria×5、alt×7
- **字体**：Instrument Serif + Inter + JetBrains Mono + Pacifico（4 族 Google Fonts）

### Demo 3 — Sparkle & Shine 汽车美容（本地服务，**多页**：home/about/services/contact）
- **Section 清单（14+9 共 23 组件）**：home＝Navbar、Hero（289 行**鼠标视差** lerp+rAF、2 条视频）、**Marquee 滚动横幅**、About、Services 六卡、**Gallery 图库**、Process、**Showcase（Before/After 对比 + 促销价目行）**、**Testimonials**、**Plans 会员套餐（定价）**、Faq（内嵌 Google Maps iframe）、Footer；about＝PageHeader/**StatsBand**/Story/**Values**/**Team**/CTA；services＝ServiceGrid/**PackageTable 套餐对比表**/Process；contact＝ContactForm（244 行状态机+校验→readdy form）/ContactInfo/**MapSection（Google Maps embed）**；共享件＝**BackToTop 浮钮**、**LegalModal 法务弹窗**、PageHeader 内页页头
- **动效**：fadeUp reveal-on-scroll（useReveal hook + transition 类）、hover 卡片、marquee
- **响应式/a11y**：md:×148 最佳移动适配；aria×14、focus:×12、role×1——五者中最好但仍不达标（无 reduced-motion）
- **字体**：一口气 6 族 Google Fonts（Cinzel/Cormorant/Italiana/Bodoni/Oswald/Inter）

### Demo 4 — Lux Hotel 建筑住宅（**多页 + 真后端**：home/inquiry/journal/residences/room/:slug/services）
- **技术栈特例**：**GSAP + ScrollTrigger + Lenis 平滑滚动 + 自写 cursor follower**；**@supabase/supabase-js 拉真实 `projects` 表**（residences 列表 + room 详情页动态渲染）；自写 `LazyImage` 组件
- **Section 清单（home ×9 + 5 个内页）**：Navigation、Hero（GSAP 入场+视频）、Marquee、**SpatialViewer（superspl.at 高斯溅射 3D 扫描 iframe，WebXR）**、Philosophy、Residences（Supabase 数据卡片）、Testimonial、InquiryCTA、Footer；inquiry＝长询盘表单（293 行→readdy form）；room＝**动态产品详情页**（slug 路由+图库+特性）
- **动效**：GSAP fromTo + stagger + ScrollTrigger（每个 section 一个 `gsap.context`）、grain 噪点覆层、marquee、cursor follower
- **响应式/a11y**：md:×110/lg:×70；alt×16、focus:×17、aria×4
- **字体**：Fraunces + Inter + Pacifico

### Demo 5 — Mango Loco 芒果汁（消费品牌+**B2B 批发询盘**，多页 ×6：home/our-story/process/taste/global/wholesale）
- **Section 清单（home ×10 + 5 内页 ×3~6）**：Navbar、**HeroSection＝滚动 scrub 视频**（`video.currentTime = progress×duration`，600vh 滚动区+三段式标题切换，152 行）、ManifestoSection（大字宣言+数据带）、ProductionSection、FarmingSection（原产地故事）、VersatilitySection（三用例）、TasteSection、MarketSection（US/EU 市场）、WholesaleCta、Footer；our-story＝StoryHero/Founding/**TimelineSection 年代时间线**/Values/**Team**/CTA；process＝Hero/**ProcessSteps 动画步骤**/CTA；taste＝Hero/TasteFlavors/CTA；global＝Hero/**GlobalRegions 区域网格**/CTA；wholesale＝**InquirySection B2B 询盘表单**（277 行，region 选择 US/EU→readdy form）
- **反模式实锤**：**每个内页各复制一份 Navbar 变体（×6 份近似代码）**——生成式无组件复用的典型病灶
- **动效**：滚动 scrub 视频 + bounce + transition/hover（无动效库）
- **响应式/a11y**：md:×151 最高；aria×3、alt×15、focus:×14
- **字体**：Bebas Neue 单族

## 2. 汇总①：readdy「section 词汇表」全集（去重，5 站归并）

**导航/骨架**：Navbar（scrollY 感知）· PageHeader（内页页头+面包屑位）· Footer · BackToTop 浮钮 · LegalModal
**Hero 家族（5 变体）**：视频自动播放 Hero · **滚动 scrub 视频 Hero** · **500vh three.js 滚动叙事 Hero** · 鼠标视差 Hero · GSAP 入场 Hero
**信任/证据**：StatsBand 数据带 · **Testimonials 评价** · Marquee 滚动横幅（logo/口号带）· **BeforeAfter 对比** · Gallery 图库 · SpatialViewer 3D 扫描嵌入
**产品/服务**：Services/ServiceGrid 图标卡片栅格 · 产品卡片列表（Residences/Work，含数据库驱动）· **产品详情页**（room/:slug）· Colorways 变体选择 · SoundArchitecture 规格深潜 · VersatilityJSON/TasteFlavors 用例与属性可视化
**叙事**：About/Story/Philosophy/Manifesto/Farming 叙事块 · **ValuesGrid 价值观卡** · **TeamGrid 团队** · **TimelineSection 历史时间线** · ProcessSteps/Process 流程（编号步进/hover 交互两种）
**转化**：CtaBanner（×7 变体：GlobalCta/WholesaleCta/InquiryCTA…）· **InquiryForm 询盘/预订表单**（状态机+校验+托管端点）· **Plans/PackageTable 定价与套餐对比表** · MarketSection/GlobalRegions 市场覆盖
**内容**：Journal/NewsList（**含类目筛选**）· Faq 手风琴 · MapSection 地图嵌入 · VideoBlock（视频均以 Hero/背景形态出现，无独立 VideoBlock）

## 3. 汇总②：对照我们 v1 封闭 17 型的缺口 + 改造难度

**已覆盖**（readdy 有 ↔ 我们有）：HeroBanner、ProductGrid、ProductDetail、ProcessTimeline、StatsBand、AboutBlock、FaqAccordion、CtaBanner、InquiryForm、MapLocation、NewsList、CaseStudies(≈Work/Showcase)、FactoryShowcase(≈Production/Farming)。readdy **没有**而我们有：TrustBar、CertWall、WhatsAppFloat（B2B 外贸特化——是我们的差异化，不是缺口）。

**我们缺的 section 类型**（按 B2B 外贸独立站价值排序）：

| 缺口 | readdy 实证 | 难度 | 备注 |
|---|---|---|---|
| **Testimonials 客户评价** | d3/d4 | **小** | 纯静态，B2B 信任必备，建议 v1 就补 |
| **PricingTable/PackageTable 套餐对比表** | d3×2 | **小-中** | 外贸场景改造成 MOQ/贸易条款对比表，响应式表格要 `overflow-x` |
| **TeamGrid 团队** | d3/d5 | **小** | 🔴 具名人像涉个人数据，需在 SiteSpec 标记 |
| **GalleryGrid 图库** | d3 | **小** | FactoryShowcase 的泛化，可参数化合并 |
| **MarqueeStrip 滚动横幅** | d3/d4 | **小** | 纯 CSS keyframes；必须补 `prefers-reduced-motion` |
| **IconFeatureGrid 通用图标卡栅格** | d3 Services/Values、d5 Versatility | **小** | 一个组件吃掉 readdy 三种 section，杠杆最高 |
| **HistoryTimeline 历史时间线** | d5 | **小** | ProcessTimeline 加 `variant: history` 即可，近零成本 |
| **PageHeader 内页页头** | d3 | **小** | 多页站刚需，我们若有内页就必须有 |
| **BackToTop 浮钮** | d3 | **小** | 与 WhatsAppFloat 同一浮层插槽体系 |
| **NewsList+类目筛选** | d2 Journal | **中** | 需要 client island；v1 可先静态降级 |
| **BeforeAfterCompare** | d3 | **中** | 拖拽滑块 island；对机加工/翻新类外贸品类价值高 |
| **RegionsGrid/MarketCoverage 市场覆盖** | d5 | **中** | 外贸「we ship to」刚需，建议列入 v1.5 |
| **ScrollVideoHero 滚动 scrub 视频** | d5 | **大** | 视频素材管线+移动端 `currentTime` seek 性能坑；premium 模板选配 |
| **Interactive3DHero（three.js/GSAP+Lenis 叙事）** | d1/d4 | **大** | 400KB+ 运行时、桌面优先、a11y 全失；**不建议进封闭库**，留作旗舰模板孤例 |
| SpatialEmbed 3D 扫描 | d4 | 小（实现）| 但依赖第三方 iframe 外呼，**GDPR 红线不收** |

## 4. 汇总③：readdy 产物 → Astro 组件改造可行性判断

**结论：高度可行，且比预期更顺——推荐定位为「开发期 section 设计源/参考库」，但产线零依赖。**

**利好（实证）**：
1. **sourcemap 公开 = 直接拿到原始 TSX**，不用从压缩 DOM 反推；组件粒度（一 section 一文件、数据 const 内联在头部）与我们「SiteSpec props + 封闭组件」**同构**，`const` 数组几乎可以 1:1 翻译成 SiteSpec 字段 schema；
2. Tailwind v3 类名可直接搬进 Astro（我们同用 Tailwind 则近零翻译成本）；
3. 5 站里 **约 70% section 是零状态纯展示** → 直译 `.astro` 静态模板（0 JS）；交互件（FAQ 手风琴/筛选/表单/对比滑块）→ Astro island；d3/d5 这类多页站是最接近我们外贸场景的改造母本。

**必做改造清单（每个入库 section 的固定工序）**：
- 🔴 **GDPR 红线全违反，逐项内化**：Google Fonts→fontsource 自托管；cdnjs 图标→本地 RemixIcon 子集（弃 FontAwesome 双份冗余）；readdy AI 图片/视频端点→我们素材库；Google Maps iframe→静态地图/consent 门；unpkg/jsDelivr/superspl.at/pexels 热链全禁——**readdy 产物默认一条都不过我们红线，这本身就否决了「readdy 产物直接上线」路线**；
- 文案抽取进 SiteSpec（它是硬编码英文+i18n 空壳）；自定义 token（`bone-50` 等）映射进我们 design tokens；补 aria/focus/`prefers-reduced-motion`（5 站全部为零）；去重（d5 六份 Navbar 的复制粘贴需收敛为一个参数化组件）；GSAP/Lenis 仅留 premium 模板（GSAP 3 现已全免费、Lenis MIT，授权无碍）；SPA→Astro 静态直出反而**修复了它 SEO 首屏空 HTML 的硬伤**。

**工作量估计**：纯展示 section 每个 0.5~1 人时、交互 island 2~4 人时；上表「小」缺口 9 个合计约 1~1.5 人天可全部入库。

**风险与边界**：① **法律**：只改造**我们自己账号生成**的产物（readdy ToS 通常将生成物权利授予付费用户，需核对当前版本条款；本次 5 个 demo 若非我方生成，仅作结构学习、不搬代码/文案/素材）；② sourcemap 公开可能是 readdy 的疏漏，随时可能关闭——**当前窗口期适合批量采样**，但流程不应依赖它（导出功能才是正路）；③ 它的「AI search-image + 托管 form」是平台锁定点，我们对应能力（素材库+自建询盘落库）已有，不构成依赖。

**给上级的建议动作**：用 readdy 作「设计半成品供给」的最小闭环＝生成→取源码→按上表工序改造入库；优先补 9 个「小」缺口 + Testimonials/PricingTable 两个高价值件；d1/d4 类沉浸叙事不进封闭库，避免拖垮 SiteSpec 契约的简洁性。