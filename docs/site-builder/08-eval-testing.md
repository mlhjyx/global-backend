# 评测与测试策略 v1（活文档，分阶段实施）

> 落实 [02 §11.8](02-architecture.md)（eval harness）+ 仓库 TDD 硬规矩。两层质量体系：**运行期质量环**（每次 build 内的审核/SEO/审美三评审，02 §4 P4，已设计）管"这一站好不好"；**离线评测基线**（本文件）管"整条管线有没有随改动退化"。借鉴 Mastra"evals 一等公民"思想（03 §10.5）。
>
> **as-built vs target**：本文的**离线评测已覆盖 7 个已落地 AI Task**（`apps/api/src/site-builder/agents/task-routes.ts`：`brand_profile / copy / design_spec / assemble / assembly_fix / qa_summarize / seo_review`）与 10 个已注册渲染组件（`apps/site-renderer/src/components/Section.astro`）。**审美评审（aesthetic_review）、本地化（localize）、Claim 投影（claim_projection）、视频 QA、DesignEvaluation 契约、通用感检测、shadow/canary 自动化**是**目标态**（M1-d/e/f 与 M2/真实流量后落地），文中逐处标注。26 型封闭组件库是 v1 目标（ADR-015），当前 10 型 as-built。
>
> 模型档相关一律遵 **ADR-016**（ModelProfile 四态路由：`currentRoute`/`evaluatedCandidate`/`targetCandidate`/`promotedRoute` + `deterministicFallback`）；deepseek 只用显式 `v4-pro`/`v4-flash`（`chat`/`reasoner` 别名官方 2026-07-24 关停）。

## 0. 定位与两层质量体系

**质量闭环落在三个构建位置**（v3.2 §0.2 回写），本文的离线评测为这三处提供回归基线：

| 位置 | 当前痛点 | 质量环内容 | 状态 |
|---|---|---|---|
| Demo v0 | 三页固定结构、无素材、仅两种主题 | TemplateFamily 排序 + Blueprint + 安全 DemoVisualPack；全程确定性，P95<10s | 目标（DV-0） |
| M1-e | 有组件但无整站设计语法，易组件拼盘 | DesignDNA + TemplateFamily + 兼容矩阵 + 内容预算 + 26 组件变体 | 目标（M1-e） |
| M1-f | 只检查能否运行，无法识别模板感/空洞感/节奏差 | 三断点截图 + 确定性检查 + 审美评审 + 通用感检测 + 最多三轮结构化修补 | 目标（M1-f） |

**生成与评审分离三原则**（v3.2 §14.1 回写，评测公信力地基）：

1. 生成角色**不能给自己的产物打最终分**。
2. 评审提示词**不能含诱导**（如"这是 Readdy 风格应高分"）；不得让评审看到期望标签。
3. **确定性工具结果优先于模型主观判断**——能机器判的绝不交给模型。

## 1. 分阶段 Golden Set（评测集）

评测集**分阶段建设、累积增长**，不是一次性验收表演；每一阶段只声称它能诚实证明的范围（v3.2 §1.5/§27 回写：完整 shadow/canary、30×3、5 人盲测判为 YAGNI → 6 样本启动，真实流量后再扩）。

### 1.1 Bootstrap：6 个现在可执行的 fixture

3 个行业 × sparse/rich（v3.2 §27.1）：

- **industrial pump**：检验技术规格、询盘 CTA 与工业视觉。
- **auto parts**：检验产品矩阵、兼容/型号事实与测试分支成果。
- **lab / medical instrument**：检验高信任、合规措辞与信息密度。

约束：至少 1 个 fixture 用 **de-DE/EU** 市场；另建 1 个**不计审美胜率的 ar/RTL 合同 smoke fixture**（考组件库 RTL 承载）。`sparse` = 只有公司名/主营/国家/联系方式；`rich` = 含批准产品/图片/地址/证据素材。

作用 = 尽快发现**结构、事实、响应式与"没效果"问题**；**不**用于宣称统计显著、永久终选或跨行业胜率。

### 1.2 视觉子集：6 扩 12（M1-g）

Bootstrap 通过后扩为 **6 个 Family × sparse/rich**，补 CNC/五金、包装机械、食品原料/创新材料等（v3.2 §27.2）。每个 Family **必须在层级、hero 构图、section rhythm、卡片语法、密度上可区分，不能只换颜色**（呼应审美 rubric 的原创性维与通用感检测）。

### 1.3 成熟系统集：逐步达 30+（M2 / 真实流量后，含对抗样本）

规模化验收**不当作零流量硬前置**（v3.2 §27.3）：

- **5 BusinessArchetype × 3 Market × 2 资料完整度**。
- **≥10 个对抗样本**：虚假认证、冲突参数、人物/证书、低清产品、prompt injection、缺图、超大 PDF、重复素材、恶意外链。
- 建议构成 = **20 个平台合成/明确授权 + 5 个脱敏真实 + 5 个历史失败回归**；真实数据需权利与隐私审批。
- **新失败案例必须最小化后回灌**；Golden Set 是**累积资产**。

### 1.4 每个 fixture 必存清单

每个 fixture 固定保存（v3.2 §27.4，缺一即回归不可复现）：

- 输入、市场、资料完整度、期望 Archetype/候选 Family。
- **不允许出现的 Claim**、必需页面/section、客观不变量。
- desktop/tablet/mobile 三尺寸截图 + 确定性 QA 结果。
- **DesignEvaluation、owner preference 与选择原因**。
- catalog / model / prompt / schema 版本 + Claim/Offering/Asset snapshot。
- accepted/rejected artifact、trace、token/latency/cost。
- 来源许可、是否允许训练、保留策略；**不得混入原始 Tier B 页面语料**（净室边界，ADR-019）。

### 1.5 存放与脱敏

- **构成**：真实合作工厂（脱敏，授权见 §10.1）+ 合成企业，覆盖 行业 × 资料完整度 × 市场特例（小语种/RTL/多认证）两维矩阵。
- 每家 = **固定输入**（intake+向导+素材+文档）+ **期望锚点**（factSheet 关键事实清单、必出 section、关键词落位、必过硬门）。
- 存 `apps/api/test/fixtures/golden-companies/`（全部脱敏/合成，过 gitleaks，§8 硬门）。

## 2. 评测维度与量化

### 2.1 质量评分 Rubric（9 维加权）

审美评审输出**结构化 9 维加权分**（v3.2 §28 回写；**目标态**，随 M1-f `aesthetic_review` 落地）。硬失败**不靠总分抵消**：

| 维度 | 权重 | 高分标准 | 典型扣分 |
|---|---:|---|---|
| 信息层级 | 15 | 一眼理解业务、主次清晰 | 首屏无业务对象、H1 与正文同权 |
| 全站一致性 | 15 | 同一视觉语法贯穿多页 | 每个 section 像不同模板 |
| 留白与节奏 | 10 | 密度有变化、呼吸合理 | 全站等距、连续卡片墙 |
| 对比与可读性 | 10 | 文本/背景/CTA 清楚 | 灰字过浅、叠图不可读 |
| 图片策略 | 10 | 角色明确、裁切稳定 | 重复占位、拉伸、主题不符 |
| 移动端构图 | 15 | 重排自然、CTA 可触达 | 只是缩小、横向溢出 |
| CTA 清晰度 | 10 | 主要 CTA 单一、路径明确 | 每段都抢主 CTA |
| 可信度 | 10 | 事实与证据匹配 | 虚构数字、空洞形容词 |
| 原创性 / 非模板感 | 5 | 家族一致但不机械重复 | 只换色、结构全同 |

**硬失败清单**（任一命中即阻断，不被总分抵消）：虚构认证/客户/数字/地址、页面不可构建、关键 CTA 不可用、移动端横向溢出、对比度严重不合格、未批准外部请求、未知组件被静默删除。

### 2.2 可量化发布门（11 维阈值 + 阻断条件）

M1 发布门（v3.2 §10.2 回写）；每维带**独立阻断条件**，不允许总平均掩盖单维硬伤：

| 维度 | M1 目标 | 阻断条件 |
|---|---:|---|
| Demo API P95 | < 10 秒 | 超过现有 PRD 红线 |
| Demo 生成成功率 | ≥ 99% | 无兜底或生成失败 |
| Lighthouse Performance | ≥ 85 | 任一 Golden 页面 < 85 |
| Lighthouse Accessibility | ≥ 90 | 任一 Golden 页面 < 90 |
| 结构化审美分 | ≥ 85/100 | 任一硬伤维度 < 60 |
| 事实安全 | 100% | 出现无证据认证/客户/数字/承诺 |
| 外部运行时依赖 | 0 个未批准域名 | 字体/图片/脚本/表单偷偷出站 |
| 组件契约覆盖 | 100% | 未知组件被静默丢弃（ADR-015 fail-closed） |
| 三断点溢出 | 0 | 375 / 768 / 1440 任一横向溢出 |
| 新方案盲测胜率 | ≥ 80% | 对当前 Demo 的成对盲测未达标 |
| 同质化 | 10 样本中 ≥ 4 个明显结构家族 | 10 样本只换色不换结构 |

### 2.3 Core Web Vitals 工程阈值

采用公开良好阈值：**LCP ≤ 2.5s / INP ≤ 200ms / CLS ≤ 0.1**（v3.2 §10.2）。**M1 先做实验室门**（Lighthouse/Playwright），**发布后再采集 RUM 真实用户数据**——不把实验室门冒充真实体验数据。

### 2.4 用户可见结果 DoD（7 条质量 bar）

一个合格 Demo 首次生成即应满足（v3.2 §10.1 回写，评测须能逐条判定）：

1. 首屏 5 秒内可判**做什么/服务谁/下一步**。
2. 看起来像**同一品牌**，而非组件样例合集。
3. 不同行业、不同资料完整度**结果差异明显**。
4. 无用户图片时也有**安全、克制、非事实性**视觉占位。
5. **无虚构**客户/认证/年限/团队/案例/统计（ADR-017 红线）。
6. 手机端**独立成立版式**，非桌面压缩。
7. **零**外部字体/图片/未知脚本/托管表单依赖。

### 2.5 DesignEvaluation 输出契约（目标态）

审美评审的机器可判输出 schema（v3.2 §15.5 回写；随 `aesthetic_review` M1-d/f 落地，非当前 as-built）：

~~~ts
export interface DesignEvaluation {
  schemaVersion: "1.0";
  overallScore: number;
  dimensions: {
    hierarchy: number; consistency: number; spacing: number;
    contrast: number; imagery: number; mobileComposition: number;
    ctaClarity: number; credibility: number; originality: number;
  };
  hardFailures: Array<{
    code: string;
    page: string;
    breakpoint: 375 | 768 | 1440;
    selector?: string;
    evidencePath: string;
  }>;
  findings: Array<{
    id: string;
    severity: "blocker" | "major" | "minor";
    target: string;
    rule: string;
    suggestedPatch: object;   // 定向修补，喂 assembly_fix
  }>;
}
~~~

`dimensions` 九维对齐 §2.1 rubric；`hardFailures` 携带断点/选择器/证据路径，供确定性复核与三轮定向修复定位。

### 2.6 通用感检测（M1-f 目标态）

审美分之外新增 **genericness 检查 8 指标**（v3.2 §17.4 回写，专治"换更强模型也治不好"的模板感）：

- 相邻区块结构重复率；卡片组件占全站比例；多页 Hero 构图重复率；图像占位重复率；CTA 文案与位置重复率；与同批次其他站点的 Blueprint 重复率；颜色只换皮但版式相同比例；无证据营销形容词密度。

**建议数值门**（4 条）：

- 同站连续结构重复 ≤ 2；
- 同一站点页面 Hero 构图完全相同 ≤ 50%；
- 同一批 10 样本首页 Blueprint 完全相同 ≤ 30%；
- 卡片式 section ≤ 可见 section 的 50%。

### 2.7 事实忠实度与 Evidence 硬规则

事实忠实度 = **零容忍硬门**（锚点比对 + evidence 门），呼应 ADR-017（禁虚构身份）。

**R4 Evidence 硬规则**（v3.2 §24.7 回写，evidence 门须强制）：

- 所有模型产出的 FactSheet 事实**都须有 quote**，且 quote 命中 `sourceId` 对应的**冻结语料**。
- value 中的**数字/单位/认证代码/关键专名**必须在 quote 中一致出现，否则降 gap。
- web 搜索 **snippet 只能进 research_hint/competitors**，不得直接成 publishable fact。
- web_research 若要支撑事实，须**抓取原始权威页并冻结正文 hash**，仍按低信任来源处理。
- 认证必须**引用 ready 的 cert Asset 或人工 verified**；intake 自填/官网文案不能直接上站。
- valueProps/differentiators/tone **只能从已过闸的 FactSheet 推导**。

**已确认的 evidence 门缺陷**（v3.2 §24.2，as-built 代码问题，**须 M1-d 前修**，评测 fixture 须含对抗回归）：

| ID | 代码证据 | 问题 |
|---|---|---|
| R4-1 | `enforceEvidenceGate` | 普通事实无 quote 也过；quote 只查"存在于来源"，不查数字/实体/claim 是否被支持 → 可用真实 URL/无关引文给虚构事实洗白 |
| R4-2 | `brand-research.ts` | 搜索结果只取 snippet 却作 web_research evidence 交给 FactSheet → 摘要可能错配/截断/过时 |
| R4-3 | 认证 evidence | intake/upload 标签 + 任意命中 quote 即放行认证，无强制 ready cert 资产引用 → 自填"ISO"可变成站点事实 |

### 2.8 视频 QA rubric（M3 目标态）

视频/动效不塞进 M1；QA 契约预埋（v3.2 §21.4 回写）：

- **多模态评审模型**（`multimodal.review`，型号经 ADR-016 档选、不硬编码；当前可用多模态候选 = `gemini-2.5-pro`）**按时间戳输出 finding**；模型不可用时保留**确定性时长/编码/闪烁基础门**。
- 检查：产品形状/标签/Logo/人物异常/闪烁/字幕/音画/品牌色/黑帧/违规内容。
- **关键产品或人物严重漂移直接拒绝 Shot**；低风险缺陷可替换为静态图/上一版镜头。
- **证据记录要求**：必须记录输入帧/时间戳、rubric、model snapshot 与置信度，**不能只保存总分**（v3.2 §21.4）。

## 3. task-shaped 模型评测与晋级（ADR-016 四态）

**按 7 个 AI Task 各自的输入→输出契约做有界评测，非笼统跑分**。评审顺序固定：**确定性硬门 → schema/reference → 匿名偏好 → 独立 Judge/人工**（v3.2 §27.6/§23.6）。

### 3.1 task-shaped 分期表

| Task | 永久硬门 | Bootstrap 排序指标 |
|---|---|---|
| Brand | 事实虚构=0、引用捏造=0 | 覆盖、gap、schema、accepted cost |
| Copy / Localization | 未批准 Claim=0、术语/槽位合法 | 目标市场偏好、清晰度、长度、成本 |
| Design / Assemble | 未知组件=0、最终 schema/引用门通过 | 一次成功、修复轮数、审美、P95 |
| Aesthetic Review | 高风险缺陷不能被文风掩盖 | 漏检、误报、定位、成本 |
| Image / Video | 身份/证件/人像违规=0 | 可用率、重做次数、单位合格成本 |
| QA / SEO | 硬门由代码命中 | finding 归并与解释准确度 |

> as-built 覆盖：Brand=`brand_profile`、Copy=`copy`、Design/Assemble=`design_spec`+`assemble`+`assembly_fix`、QA/SEO=`qa_summarize`+`seo_review`（7 个已落地）。Aesthetic Review / Localization / Image·Video 为目标态。

### 3.2 MODEL-1 / MODEL-2 分期

- **MODEL-1（候选接通时）**：真实 endpoint 先跑 **capability probe（失败即停）**，不把官方规格当租户可用事实；每 task 用 **6–12 代表样本 × 固定 prompt/schema/rubric × 2 次**，**先判 schema/事实/身份/延迟/成本，再做偏好比较**；通过者 = `evaluatedCandidate`（保留报告，不进用户路径）。默认晋级原则 = **"满足所有硬门的最低 accepted-artifact 成本"**，只有高价值页面证明可见质量增益才用 premium。
- **MODEL-2（有真实流量或高风险生产切换前）**：扩至 **≥ 30 样本 × 3 次 + 100% shadow**；经批准进 **5%→25%→100% canary**（每档样本/时间门由当时流量与风险写入 ADR，不假装已有统计基础）；任一事实/身份硬失败、P95、provider error 或 accepted-cost regression **触发自动回 `promotedRoute`**。

### 3.3 全阶段硬门阈值（6 条）

所有晋级阶段共用（v3.2 §23.6）：**① 事实/引用违规=0；② 结构化输出经一次 repair 后合法；③ 关键 QA 漏检不超阶段门；④ 产品身份破坏=0；⑤ P95 不超 task 预算；⑥ accepted-artifact 单位成本可核对。** 启动集只用于**筛掉明显不合格候选**，不能宣称统计显著或永久终选。

### 3.4 视觉偏好 5 问与客观硬门

Bootstrap 由产品 owner/用户做**成对比较**（v3.2 §27.5）：

1. 哪个更像可真实发布的海外 B2B 站？ 2. 哪个更快讲清业务和产品？ 3. 哪个更可信？ 4. 哪个移动端更完整？ 5. 哪个更少模板感？

候选需**≥ 4/6 成对比较胜出**，且**事实/a11y/移动端溢出/关键 CTA/性能等客观硬门全过**，才推广。**5 名以上目标用户盲测属 12/30+ 阶段，不阻塞启动集**。

### 3.5 晋级判定

启动集只能把候选标为 `evaluatedCandidate`。成为 `promotedRoute` 前必须（v3.2 §27.8）：① 永久硬门全过；② 主要质量显著优于现路由，或质量非劣且 accepted-artifact 成本更低，或解锁必要 capability；③ 开工时 ADR 明确样本量/成本预算/流量档/回退阈值/owner；④ 报告按 **task / locale / archetype / 资料完整度 / provider failure 切片**，不能用总平均掩盖高风险子集。**"最贵/最新"不是晋级理由**。

### 3.6 Judge 反串谋与可重放

- Judge **尽量不与 candidate 同 provider**；**先跑确定性门再盲评**，避免模型用高文风掩盖事实错误。
- Judge 固定为一个 **ModelProfile**（固定模型+snapshot+温度 0，ADR-016）；换 Judge 需先跑基线校准，否则分数漂移无法归因。
- 所有模型 **alias 运行时解析到 snapshot**；**ReleaseManifest 保存 snapshot**，保证历史重放与回归定位。

## 4. 回归纪律

- **触发**：改 agent prompt / 换模型或模型档 / 改组件库或主题 / 改校验器/evidence 门 → 必须跑回归再合并（写进 PR 模板检查项）。
- **模型档晋升回归门**（ADR-016）：任何 `evaluatedCandidate → promotedRoute` 切换前，**必须过 Golden Set 回归**（§3.2/§3.3 硬门 + §3.5 切片报告），无回归门的晋级 = 违背 ADR-016。
- **分层**：`smoke`（从 Bootstrap 固定抽 2 个 fixture，分钟级日常冒烟；**不代表 Golden Set 规模或覆盖完成**）/ `full`（先跑完整 Bootstrap 6；M1-g 扩成视觉 12 后再跑完整 12，模型或组件库级改动）。Golden 口径始终是 **6 启动 → 12 视觉扩集 → 真实流量后 30+ 成熟集**。
- **执行**：本地 verify 脚本真网关真构建（§8 硬规矩，CI 不跑）；报告（各维分数 vs 基线差值，按 §3.5 切片）贴 PR 描述；**硬门回退 = 改动打回**。
- **基线更新**：有意的质量提升合并后，重跑 full 落新基线（基线文件随 repo 版本化）。

## 5. 代码与真机测试七层（TDD 落到本功能）

**先写测试再实现**（RED→GREEN→IMPROVE），七层覆盖（v3.2 §27.7 回写）：

1. **单测**（vitest，CI 跑）：schema/状态机/**引用扫描**/evidence 门/object key/image recipe/budget reserve-settle/**route registry**；SiteSpec 校验器（合法/非法/边界表驱动）、richtext 白名单序列化（注入样本集）、prompt 模板变量转义、发布门 L1 规则表、CopyBundle 槽位与长度、locale/RTL 工具、指针切换幂等。
2. **属性 / fixture 测**：**SiteSpec 兼容演进**（`specVersion` minor 容错）、RichText sanitize、JSON Patch、locale、lock preservation。
3. **编排单测**：复用 PR #73 的 mock `proxyActivities` harness——`siteBuilderWorkflow` 分支覆盖：scope 增量重跑 / 单素材失败不阻断 / 预算超限暂停 / 质量环 ≤3 轮出环 / 同 site 并发去重 / **补偿 / 取消 / provider 回退**。
4. **集成（本地真库）**：intake→demo v0 全链、素材状态机（presign→commit→处理→引用对账）、spec PATCH→秒级重渲染、**RLS/FORCE RLS 隔离证明**（`APP_DATABASE_URL` app_user 跑 + is_superuser guard，复用既有先例）。
5. **真机 verify（真实数据无 sandbox）**：PostgreSQL/FORCE RLS、MinIO、Docling、BGE-M3、Gateway、Sharp、Astro、Playwright/Lighthouse。每里程碑一份 `verify-site-builder-m{N}.mts`——M0=真网关真构建出真预览 URL 并可访问；M1=Golden 一家全管线；M2=发布门+域名绑定干跑。
6. **契约测试**：OpenAPI diff/schema 快照 + [07](07-api-contract-draft.md) 示例作 contract fixtures、**SiteSpec fixtures**、**Renderer 兼容**、**capability snapshot**——防接口与渲染契约无声漂移（前端依赖面，ADR-014）。
7. **安全测**：恶意文件、解码炸弹、SSRF、prompt injection、XSS、外呼域、撤权与下架。R1-safety ① 已锁定 Renderer 子进程 env 精确 allowlist、临时目录/文件权限、成功/异常双路径清理，并以真 Astro build 证明产物可用且父进程密钥未进入子进程。R1-safety ② 已用单测与真机覆盖公网 `/md`+`/crawl`、无二次 DNS pinning，以及 private/loopback/metadata/IPv4-mapped/redirect-to-metadata 负向。

## 6. 里程碑评测门与测试泳道

各里程碑的**合并门/测试泳道**（DoD，v3.2 §26 回写）：

- **测试泳道 IT-0（Industrial Template 效果验证）**：可与 R2 并行、非架构主序列。基于最新 main 重跑（或记录落后 SHA）；industrial pump 与 auto-parts 各有 sparse/rich fixture，存 1440/768/390 截图；记录 Astro build/axe/性能预算/unknown component/copy 与事实风险；输出**"可保留原创 / 需按合同改造 / 应丢弃"清单**；**未经组件合同审查不得整包合并 Section/themes/demo-spec**。
- **M1-c 合并门（9 条 DoD，ADR-018）**：`AssetVariant` additive migration + RLS/FORCE RLS A/B 租户测试（不预建 MediaJob/AssetUsage）；原件永不覆盖 + recipe 相同不重复；commit/processing CAS/lease/重试/取消/zombie write；EXIF-GPS 真图复验 + 方向/色彩/透明 + AVIF/WebP/fallback 可解码；cert/person/logo 不进生成式且无 provider 调用；单图失败隔离、仅必需 Hero 无 fallback 才阻断；被引用 Asset 删除 409 + 扫描器覆盖 SiteSpec 1.0.0 全 AssetRef；MinIO 对象/Variant/checksum 可对账且对象清理不在 DB 事务；derivedKeys 双写兼容 + 停双写迁移条件；MF-1 触发条件已记录。
- **PR M1-f（确定性 QA + 审美与反模板感）**：先断点/溢出/对比度/资源/链接/schema/事实/a11y，**再冻结截图多模态审美**；**最多三轮定向修复，禁随机全站重生成**。
- **PR EVAL-bootstrap（可执行启动集）**：6 fixture（§1.1）；存输入/不变量/desktop-mobile 截图/质量/成本-延迟；产品 owner 成对偏好，**4/6 胜且客观硬门全过才扩 12 视觉 fixture**；启动集不宣称统计显著。（施工顺序 #11，v3.2 §0.3）
- **PR MODEL-1（候选真探与小样本评测）**：依赖 MODEL-0/EVAL-bootstrap；每候选先 capability probe，再跑 6–12 task-shaped 样本与 accepted-artifact cost；**只产 `evaluatedCandidate` 报告，不自动切生产**。（施工顺序 #12 分期，v3.2 §0.3）
- **PR M1-g（阶段收口）**：启动集扩至 12 视觉子集；跑 Catalog/模型/事实/安全/a11y/性能/回滚回归；**记录尚未完成的 30+ 成熟系统集，不得把计划冒充覆盖**。

## 7. 指标与可观测性

**指标六层**（v3.2 §3.6 回写，事件进公共 Outbox、不建第二套消息系统）：

| 层 | 至少记录 |
|---|---|
| 激活 | Demo ready rate、P95 |
| 资料 | profile completion |
| 构建 | publishable Claim 覆盖、build success/degraded、成本 |
| 发布 | preview→publish |
| 增长 | CTA / form / inquiry conversion |
| 护栏 | hallucination、identity rejection、a11y/performance、abuse/takedown |

- 访客分析受 region/consent 控制；**询盘正文与个人信息不得进入分析事件**。
- **Search Console、Safe Browsing 状态监控**按 [06](06-security-abuse.md) 后续接入；sitemap/canonical/hreflang/JSON-LD/OG 继续归 **SEO/QA**（`seo_review` task）（v3.2 §22.3）。

## 8. CI 边界

CI 只跑**纯单测 + 契约快照**（仓库规矩，无 DB/网络）；集成/E2E/评测 = 本地 verify + 里程碑门；**gitleaks 覆盖 fixtures**（Golden Set 必须脱敏）。

## 9. Demo"没效果"八根因（评测须能捕捉）

评测机制存在的理由——**换更强模型无法替代设计资产、受控变体与质量闭环**（v3.2 §2.2 回写，按优先级）：

1. 素材为空（无视觉锚点）→ 任何主题只能像线框稿。
2. 结构过于固定（行业不同但页面/区块节奏相同）。
3. 主题过薄（只换色/圆角/字体，不改构图/密度/图片占比/节奏/CTA 策略）。
4. 组件覆盖不足（设计意图落不成合法 SiteSpec，退化通用卡片）。
5. 缺内容预算（短标题塞长文，或无事实时生成空洞 Stats/Testimonials/Certificates）。
6. 缺整站一致性契约（每 section 单独合理不代表全站像同一套设计）。
7. 缺截图级审美门（schema/构建/Lighthouse 都过，页面仍可能"廉价、拥挤、AI 味重"）。
8. 无反模板感指标（判不出"连续三卡片网格""每页同 Hero""所有站蓝色工业风"）。

> §2（rubric/发布门/通用感检测）与 §3（task-shaped eval）逐条对应上述根因：3/6→一致性维、7→审美门、8→通用感检测、5→内容预算门、4→组件契约覆盖 + 未知组件 fail-closed。

## 10. 待拍板

1. 真实工厂资料进 Golden Set 的**授权方式**（2~3 家合作工厂：口头授权+书面记录 or 简单授权书模板）。
2. **Judge 固定 ModelProfile 选型**（ADR-016）：需固定模型+snapshot+温度 0，且**尽量异 provider 于被评 candidate**（§3.6 反串谋）。当前网关可用模型 = `deepseek-v4-pro`/`v4-flash` + `gemini-2.5-pro`/`gemini-2.5-flash`；建议主 Judge 用 `gemini-2.5-pro`（多模态审美评审）、文案/事实类交叉校验用 `deepseek-v4-pro`（跨 provider）——具体 snapshot 由 MODEL-1 校准后写入 ADR。
3. Bootstrap 6 fixture 的 sparse/rich 素材与期望锚点**由谁产出、何时冻结**（EVAL-bootstrap PR 前置）。

---

## 完成定义（DoD）— M0-M3 分层验收门（v3.2 §33 回写 · DOC-12 补漏）

> **只有分层全部满足才能说 M1 完成**——"页面看起来不错"不能替代可靠性、安全与发布合同。本节是**跨里程碑的正式验收契约**（此前散在 v3.2 §33、未分发，completeness-critic 查漏后补回）。多数条目的**机制真值在他处**（R0 审计见 [09 §10](09-m1-implementation-design.md)、MF-0 见 [14](14-media-foundation-mf0.md)、组件/契约见 [04](04-sitespec-contract.md)、模型门见 [10](10-model-selection-study.md)、发布治理见 [06](06-security-abuse.md)/[05](05-deployment-hosting.md)）；本清单是**统一的"是否可发布"门**，按 ID 引 ADR。
>
> **as-built 注记（2026-07-16）**：#121/#123/#124 已完成无条件 Demo、禁虚构身份、业务邮箱隔离、真取消与失败保站；#126 已补齐 `buildId`、intake 幂等、Temporal 启动证据和 Swagger/OpenAPI，并以单测、真 PostgreSQL 与真实 Temporal probe 覆盖 DoD-1 第一项。

### DoD-1 M0~M1-b 回补
- [x] hasWebsite true/false 都无条件产生同一 site 的 demo buildId，Idempotency-Key 可重放。（R0-1/2，#121/#126）
- [ ] Demo 不虚构企业类型/工厂/团队/认证/年限/客户/数字；P95 < 10s。（🔴 ADR-017 / R0-3）
- [ ] active preview 不被失败/取消/未发布 build 覆盖；Release/版本分配并发安全。（ADR-013）
- [ ] businessEmail 不进通用 KB/embedding/品牌 Prompt；存量 chunk 已重建清理。（R0-4 隐私）
- [ ] Asset/KB 在重复 commit/duplicate race/worker 崩溃/存储故障下可恢复。
- [ ] BrandProfile 同 buildRun 幂等；事实有冻结 quote；snippet 不洗白；认证强引 cert Asset/人工批准。（ADR-017）
- [ ] 首个付费 fan-out 前预算 reserve/settle、AiTrace、costSummary 可持久对账。

### DoD-2 M1-c 媒体基础与图片
- [x] AssetVariant additive migration/RLS/recipe 幂等/derivedKeys 兼容/回滚通过；M1-c 不预建 MediaJob/AssetUsage。（MF0-A/B + M1-c verifier；ADR-018 / 14）
- [x] M1-c 纯 Sharp；原图 immutable；EXIF/GPS/方向/色彩/透明与响应式格式由实际 Sharp fixture/开发环境 MinIO 对账覆盖；不把编码子进程描述为生产容器/cgroup 隔离。
- [x] active SiteSpec 引用素材不可删（→409）；对象/DB/checksum 可对账；MF-1 后无感切 AssetUsage。（MF0-B + M1-c verifier）
- [x] video/audio/poster/caption 演进方向已记录，且 M1-c 未调用 video/TTS provider。（14 §6–7）

### DoD-3 M1-d~g 内容、设计与质量
- [ ] 6 Family 各 ≥2 首页 + 2 内页 Blueprint，差异可解释；26 组件 schema/Astro/fixture/a11y/content budget/visual test 一致。（04 / 13）
- [ ] Demo 无模型也有视觉锚点；sparse 不虚构、rich 正确利用产品/工厂/证书/地址。
- [ ] Copy 只消费 PublishableClaimSnapshot；人工锁定 + locale 降级语义通过。
- [ ] SiteSpec 三重门 / Renderer compatibility / 三断点 / Lighthouse / WCAG / 外呼域进 CI。
- [ ] aesthetic review 不可用有显式降级；修复 ≤3 轮；安全 Family fallback 可重放。（ADR-013）
- [ ] SiteReleaseManifest 可重建相同 artifact digest；回滚恢复完整文案/素材/代码/配置。
- [ ] 6 Bootstrap fixture ≥4/6 成对偏好胜出，性能/事实/a11y 无回退；扩 12 后设多人盲测门。

### DoD-4 模型、运维与公开发布前门
- [ ] MODEL-0 保持 currentRoute；Agent 卡不散落型号。（ADR-016）
- [ ] MODEL-1 候选完成 capability probe + 6-12 样本报告；仅 evaluatedCandidate 可申请 30×3/shadow/canary，未批不改 promotedRoute。
- [ ] 每 Release 可追溯 model snapshot/routePolicy/prompt/schema/rubric/accepted-artifact cost。
- [ ] PublishReview / 域名 ownership+tombstone / 询盘隐私+滥用 / Claim 过期维护 / taken-down+appeal 在首次公开发布前可用。（06）
- [ ] Readdy/字体/图标/图片/视频/音乐许可来源撤权可审计；Tier B 原始输出不入生产 RAG/训练。（ADR-019）

### DoD-5 M3 媒体门（不阻断 M1）
- [ ] MF-1 MediaJob/AssetUsage 由视频真实消费者驱动落地；Seedance Shot job/取消/重试/成本/QA/静态降级可用，Veo 仅 policy 进 premium/shadow。
- [ ] 旁白/转写/字幕/poster/reduced-motion/移动端码率完整；无声音克隆。
- [ ] 产品/Logo/人物/文字时序 QA 通过；失败只重做 Shot，回滚恢复整套媒体。
