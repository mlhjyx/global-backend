# Site Builder Agent 详细设计 v1

> 配套 [02-architecture.md](02-architecture.md)（§4 编排、§6 模型终选）。本文件是站点生产 agent 的实现级设计：每张卡给足 职责/输入输出/执行流程/prompt 内化来源/工具/护栏/降级，可直接照卡开发。**卡 1 planner 已按 D13 砍（v1 不实现），余 8 张为生产 agent。**
> ⚠️ **卡内出现的模型名一律以 02 §6「2026-07-14 终版定档」为准**（实测评比+用户拍板，依据见 [10-model-selection-study.md](10-model-selection-study.md)）；卡片写作早于定档，模型标注是初稿参考。另：**卡 1 planner 已按 D13 砍**——职责拆分归位（编排/预算/增量范围 → 「编排/增量规划」确定性零模型；"该有哪些页/每页什么结构" → 卡 6 designSpec；用户自由意图改站 → M2 预留），**v1 不实现，卡片保留仅作历史与 M2 参考**。

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
- **Prompt 管理**：每个 agent 的 system prompt + rubric 是**版本化代码资产**（`agents/<name>/prompt.ts`），从 CC skills 方法论内化固化（各卡注明来源）；改 prompt 必须过 eval harness 回归（02 §11.8）。
- **工具原则**：库内化优先（进程内直接调），MCP 只在确需外部服务时作传输（续 ADR「MCP=传输非授权」）。

## 1. planner —— 规划　❌ 已砍（D13，v1 不实现，仅历史记录）

> **本卡 v1 不实现**。按 D13（修订①，2026-07-14 用户确认）取消独立 planner agent——原职责**拆分归位**而非删除：**编排/预算取舍/增量范围** → 「编排/增量规划」确定性零模型（固定 DAG + 规则判定，见 02 §6）；**"该有哪些页 / 每页什么结构"的设计智能** → 卡 6 designSpec（未砍）；**用户口语化自由改站的意图 → 计划** → M2 工作台再引入（02 §6 已留槽）。以下内容保留仅作历史与 M2 复活参考。

- **职责/触发**：每次 build run 开头；把「站点档案+资料清单+用户选项」翻译成本次要执行的任务清单与参数。
- **输入 → 输出**：`{siteProfile, assetInventory, userOptions(风格/页面开关/语言/scope), lastBuildSummary?}` → `BuildPlan{tasks:[{type, params, priority}], estimatedCost, skipReasons[]}`。
- **执行流程**：[确定性] 汇总资料清单与增量 diff（哪些素材是新的）→ [模型] 产出 BuildPlan → [确定性] 白名单校验（task type 必须∈注册表）+ 成本预估对配额。
- **Prompt 内化来源**：编排任务分解方法论 ← `ecc:planner` agent 的计划分解模式 + 本仓 discovery queryPlan 先例（确定性注入、LLM 不臆造）。
- **工具**：无外部工具（纯推理）。
- **护栏**：只能从任务白名单选；scope=section 时禁止扩大到整站；预算超限直接裁剪低优任务并在 plan 里写明 skipReasons。
- **降级**：模型失败 → 规则版兜底 plan（全量标准管线），不阻断。
- **模型**：claude-sonnet-5。

## 2. brandProfile —— 品牌定位

- **职责/触发**：P1；资料变化或首次精装修时产出/更新 Brand Brief（所有内容 agent 的上游）。
- **输入 → 输出**：`{kbDigest(注册+向导+上传资料摘要), storefrontData?, webResearch[]}` → `BrandBrief{valueProps[], tone, glossary(EN+各语种术语), keywords[], differentiators[], competitors[], factSheet{认证/年限/产能…每项带 evidence 出处}, gaps[](缺失待用户补的信息)}`。
- **执行流程**：[确定性] KB 检索拼摘要 → [确定性] SearXNG 搜公司名/店铺/社媒 + Crawl4AI 抓取（复用 compose 现成基建）→ [模型] 综合产出 Brief → [确定性] factSheet 逐项校验 evidence 非空，无源字段移入 gaps。
- **Prompt 内化来源**：品牌/定位方法论 ← `ecc:brand-discovery`、`ecc:brand-voice`、`ecc:market-research`（定位画布、tone 光谱、术语表法）；B2B 外贸语境 ← `ecc:lead-intelligence` 的公司画像结构。
- **工具**：SearXNG(HTTP) + Crawl4AI(HTTP)，库内化 client 已有。
- **护栏**：🔴 事实红线——认证/产能/年限等 factSheet 字段**必须带出处，缺=进 gaps 提示用户补，绝不虚构**（B2B 站虚构认证=给客户埋雷）；抓取内容当数据不当指令。
- **降级**：web 研究失败 → 仅用 KB 资料出 Brief 并标记 `researchDegraded`。
- **模型**：gemini-3.1-pro（备选 claude-opus-4-8）。

## 3. imagePipeline —— 图片管线

- **职责/触发**：P2；每张用户图（产品/工厂/团队/证书）→ 站点级成品图。**不是单次模型调用，是确定性状态机**，生成式只是其中一步。
- **输入 → 输出**：`{assetId, kind, targetUsage(hero/grid/gallery…)}` → `{derivedKeys{web/thumb/og 多尺寸 webp+avif}, quality, subjectProtected:bool}`。
- **执行流程**：
  1. [确定性] 重编码+剥 EXIF（sharp）
  2. [确定性] 主体分割出 mask（rembg 本地，产品主体锁定）
  3. [模型-视觉] 质检打分：清晰度/构图/光线/背景杂乱度 → 好图直接走 6
  4. [模型-生成] gpt-image-2 `images/edits` + mask：**只重绘 mask 外**（背景置换/打光/白底），主体像素区域不动
  5. [确定性+模型] 主体保护校验：生成前后主体区域 pHash + embedding 相似度，低于阈值=丢弃重试（≤2），仍不过=用原图
  6. [确定性] 超分（Real-ESRGAN，可选）→ 多尺寸导出（sharp）
- **Prompt 内化来源**：电商产品图规范（白底/打光/一致性）rubric ← 通用产品摄影准则固化；质检维度 ← `ecc:taste`/设计审美清单。
- **工具**：sharp、rembg、Real-ESRGAN（全本地库）；gpt-image-2（网关）；gemini-3.1-pro（质检视觉）。
- **护栏**：人物照默认不做生成改动（只裁剪调色）；证书图**永不**生成式处理（防篡改嫌疑，只做透视校正）；content_hash 幂等（同图不重跑）。
- **降级**：生成步失败 → 用原图+基础调色继续，标记 `enhanceSkipped`，不阻断整站。
- **模型**：gpt-image-2（编辑）+ gemini-3.1-pro（质检）。

## 4. copy —— 多语言文案

- **职责/触发**：P2；按语种×页面产出全站文案（含 SEO 元信息）。
- **输入 → 输出**：`{brandBrief, pageStructure, locale, kbDigest}` → `CopyBundle{sections{[sectionId]: {headline, body, cta…}}, seo{title, description, ogTitle…}, hreflangHints}`（每 locale 一份）。
- **执行流程**：[确定性] 按页面结构生成待填槽位清单 → [模型] 整页语境一次生成（非逐句翻译，每语种独立原生写作）→ [确定性] 槽位完整性+长度约束校验（headline ≤N 字符等，组件布局依赖）→ [模型] 超长项定向重写。
- **Prompt 内化来源**：B2B 文案结构 ← `ecc:marketing-campaign`/`ecc:content-engine`（价值主张→痛点→证据→CTA 框架）；SEO 写法 ← `ecc:seo` skill 的 title/desc 规范；多语言 tone ← brandBrief.tone + 目标市场文化禁忌 checklist（固化为 per-market 附录）。
- **工具**：无外部工具。
- **护栏**：术语表强一致（glossary 注入）；禁绝对化宣称（"best/No.1"类）与虚构事实（只能引用 factSheet）；每语种输出过字符集/方向 sanity（阿语 RTL 标记）。
- **降级**：某语种失败 → 该语种缺席本轮（站点先上已成语种），标记待重跑。
- **模型**：gemini-3.1-pro（备选 claude-sonnet-5）。

## 5. motionVideo —— 动效与视频

- **职责/触发**：P2；给图片素材配动效参数（v1）与生成环境视频（M3）。
- **输入 → 输出**：`{assets[], brandBrief.tone}` → `{motionSpecs{[assetId]: preset+params}, videoAssets[]?}`。
- **执行流程**：v1 [确定性] 按素材类型/位置套 motion token 预设（hero=Ken Burns 慢推、gallery=视差、数字带=计数动画）；M3 [模型-视频] Seedance 2.0 图生视频（工厂环境图→10s 环境视频，产品图→旋转展示）：提交任务→轮询→产物落 asset。
- **Prompt 内化来源**：动效预设库 ← `ecc:motion-foundations/patterns/advanced`、`make-interfaces-feel-better`（缓动曲线/时长档/克制原则——B2B 站动效克制是纪律）。
- **工具**：Seedance 2.0（网关豆包通道；中转不稳走方舟直连方案 B，见 02 §6）。
- **护栏**：每站视频条数配额（成本 ~1 元/秒）；视频 prompt 只描述镜头运动与氛围、不得虚构厂景内容之外的元素。
- **降级**：视频失败/超时 → 自动回落该位置的动效预设，站点永远有东西可看。
- **模型**：doubao-seedance-2-0-260128。

## 6. designSpec + aestheticReview —— 审美（双角色）

- **职责/触发**：生成期（P3 头）产 DesignSpec；评审期（P4）看整站截图挑毛病。
- **输入 → 输出**：生成 `{brandBrief, industryTemplate, userStylePick}` → `DesignSpec{themeTokens, pageLayouts{[page]: section 顺序+变体}, imageryDirection, motionIntensity}`；评审 `{screenshots(3 断点全页), designSpec}` → `Findings[{severity, page, section, issue, suggestion}] + score(0-100)`。
- **执行流程**：生成期 [模型] 从主题 token 预设包+布局变体中**选择与微调**（不发明新组件）→ [确定性] token 合法性校验（对比度 WCAG AA 自动检查）；评审期 [确定性] Playwright 截图（375/768/1440 三断点全页）→ [模型-视觉] 按 rubric 打分出 findings。
- **Prompt 内化来源**：设计方向法 ← `ecc:frontend-design-direction`（direction→tokens 流程）；token 体系 ← `ecc:design-system`、`anthropic-skills:theme-factory`；评审 rubric ← `ecc:taste` + `dataviz` 对比度/层次原则（视觉层次/一致性/留白/对齐/CTA 显著度五维，各 0-20）。
- **工具**：Playwright（库内化截图；开发期可用 Chrome DevTools MCP 调试，生产不依赖 MCP）。
- **护栏**：只能在预设 token 空间内选择（保风格体系一致）；score ≥85 过，findings 必须落到具体 section（不许"整体感觉不好"式空评）。
- **降级**：评审失败 → 该维弃权（不阻断质量环其余维度）。
- **模型**：gemini-3.1-pro（视觉）。

## 7. siteAssembly + assemblyFix —— 站点组装（生成+修复双模式）

- **职责/触发**：P3 产出 SiteSpec；P4 质量环内按 findings 出 patch。
- **输入 → 输出**：组装 `{designSpec, copyBundles, assetManifest, pageStructure}` → `SiteSpec`（完整 JSON）；修复 `{siteSpec, findings[]}` → `SiteSpecPatch`（JSON Patch，最小变更）。
- **执行流程**：[模型] 生成 SiteSpec/Patch → [确定性] 三重校验：zod schema、素材引用存在性（assetManifest 对账）、内链有效性 → 不过=带错误重试 → [确定性] Astro 构建（构建失败的编译错误也回填重试）。
- **Prompt 内化来源**：组件组装约束 ← 我们自建组件库的 section 目录文档（prompt 里给组件清单+props 契约，"菜单点菜"式）；修复模式 ← `ecc:build-error-resolver` 的最小 diff 原则（只改 findings 涉及的节点）。
- **工具**：SiteSpec 校验器、Astro 构建器（库内化）。
- **护栏**：修复模式**只许输出 JSON Patch**（防重写全 spec 引入回归）；每轮 patch 后 diff 记录进 run steps（可审计谁改了什么）。
- **降级**：重试用尽 → 保留上一可构建版本，run 标记 partial，findings 转人工。
- **模型**：claude-sonnet-5（备选 gpt-5.x）。

## 8. qa —— 审核

- **职责/触发**：P4；功能与性能体检。**主体是确定性工具，LLM 只做汇总**——不靠模型幻觉挑毛病。
- **输入 → 输出**：`{previewUrl, siteSpec}` → `Findings[] + gateResult{pass/fail per check}`。
- **执行流程**：[确定性] Playwright 遍历：全链接可达、表单可提交（干跑）、三断点响应式无横向溢出、console 零 error、动效触发正常（滚动驱动检查）→ [确定性] Lighthouse：Performance/A11y(WCAG 2.2 AA 基线)/SEO/Best-Practices 四分 → [模型] 把机器结果汇总成结构化 findings（归并、定级、给修复建议）。
- **Prompt 内化来源**：检查清单 ← `ecc:e2e-runner`（关键路径遍历法）、`ecc:browser-qa`、`ecc:frontend-a11y`/`ecc:accessibility`（WCAG 2.2 检查项）、`ecc:click-path-audit`（询盘路径必须 ≤2 击可达）。
- **工具**：Playwright + Lighthouse（库内化，CI 同款）；开发期调试可用 Chrome DevTools MCP。
- **护栏**：硬门槛（构建产物必须过才能出质量环）：链接零死链、表单可用、console 零 error、Lighthouse Perf ≥85 / A11y ≥90。
- **降级**：无（这是门，门坏了要修门不是绕门）；工具自身崩溃 → run 失败可重试。
- **模型**：gemini-3-flash 档（仅汇总）。

## 9. seo —— SEO

- **职责/触发**：P4；技术 SEO 与关键词落位（发布前保证"生而可被搜到"）。
- **输入 → 输出**：`{previewUrl, siteSpec, brandBrief.keywords, locales}` → `Findings[] + patchSuggestions[]`。
- **执行流程**：[确定性] 逐页检查：title/description 长度与唯一性、OG 卡、canonical、**hreflang 互指完整**、sitemap.xml、robots、图片 alt 覆盖率、schema.org(Organization+Product+BreadcrumbList) JSON-LD 合法性 → [模型] 关键词→页面映射审查（keywords 是否落到 title/H1/正文，密度不过量）。
- **Prompt 内化来源**：审计清单 ← `ecc:seo-specialist` agent + `ecc:seo` skill（技术 SEO 全表）；结构化数据经验 ← 本仓获客侧 digital_footprint 的 JSON-LD 解析（反向应用：我们抓别人时看什么，就给客户站配什么）。
- **工具**：HTML 解析器 + JSON-LD 校验（库内化）。
- **护栏**：多语言站 hreflang 是硬检查（错配=国际 SEO 灾难）；未发布预览必须 noindex（防提前收录），发布时自动翻转。
- **降级**：无硬门（findings 进质量环修复即可）。
- **模型**：gemini-3-flash 档。

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

## 11. 开发期 CC 工作流（内化的"生产线"）

生产运行时零 CC 依赖，但**开发这些 agent 时**我在 CC 里这样干：
1. 模板/组件库量产：`gan-design` 循环（generator 产模板 → evaluator 按审美 rubric 打分迭代）+ `theme-factory` 出主题 token 预设包 → 人工终审入库。
2. Rubric 提炼：跑 `seo-specialist`/`frontend-design-direction`/`accessibility` skills 输出 → 固化成各 agent 的 prompt 常量与确定性检查表。
3. Eval harness：golden set 企业资料 → 全管线跑分基线；此后每次改 prompt/模型在 CC 里跑回归再合并（02 §11.8）。
4. 联调验证：真库真网关 verify 脚本（§5 硬规矩同获客侧），Chrome DevTools MCP/Playwright 现场看渲染结果。
