# Phase 9 Figma 交付登记

> 文档 ID：`DESIGN-FE-P9-003`
> 层级：`L2 / Design delivery registry`
> 状态：`DRAFT`
> 事实 Owner：`OWN-DESIGN`
> 关联：`GATE-FE-P9-000`
> 最后核验：2026-07-23

## 1. 状态词汇

| 状态 | 含义 |
|---|---|
| `NOT_CREATED` | 只有交付要求，没有 Figma 文件或节点 |
| `FILE_CREATED_EMPTY` | 已登记受控 Design file，但只有默认空 Page；无 Variables、组件、业务 Frame 或原型 |
| `FOUNDATIONS_DRAFT` | 已有 Variables、Styles、组件、模式或 State Lab；尚未完成发布、响应式、a11y 和用户验证 |
| `HIGH_FIDELITY_DRAFT` | 已有高保真页面并完成作者同视口视觉 QA；尚未完成全状态、原型和目标用户验证 |
| `RESEARCH_MAPPED` | 已建立可编辑的研究/架构节点并完成基础结构核验；不等于视觉方向、组件或页面定稿 |
| `RESEARCH_MAPPED_WITH_STALE_NODES` | 研究/架构节点存在，但含已被 current 决策废弃的对象或流程；完成修正前不得作为页面输入 |
| `DIRECTION_CANDIDATE` | 视觉方向探索；不能作为正式设计系统 |
| `SUPERSEDED_RESEARCH_PROVENANCE` | 已被纠偏决定废弃，只保留来源、哈希和错误边界；不得进入选择、组件、样例数据或批准链 |
| `USER_SELECTED_VISUAL_BASELINE` | 用户确认可作为视觉、密度和布局依据；不等于其中业务内容、对象或接口获批 |
| `SELECTED_FOR_VALIDATION` | 用户选定，等待反向场景验证 |
| `SPEC_DESIGNED` | 有受控 Frame、状态、响应式和 a11y 注释；未完成用户验证 |
| `VALIDATED` | 设计评审和目标用户任务证据均已记录 |
| `SUPERSEDED` | 有 successor、迁移和弃用说明 |

本表的状态不替代 Design Asset Registry。五张用户基线已确定方向家族，`FIG-P9-003/004` 已进入第一轮设计，`FIG-P9-005/006` 已分别建立一张产品表面代表页；Variables 发布、组件属性、全状态、原型和用户验证均未完成，仍不得把页面写成 `SPEC_DESIGNED`。

## 2. Figma Project 文件

| File ID | 文件 | 类型 | 内容 | URL / File Key | 状态 |
|---|---|---|---|---|---|
| `FIG-P9-001` | Research & Provenance | FigJam | 来源、截图、权利、比较、finding、Conflict/Decision | [Figma board](https://www.figma.com/board/vWBA5KkOtB56ECRGj2PXb4) · file key `vWBA5KkOtB56ECRGj2PXb4` · board node `1:2` | `RESEARCH_MAPPED` |
| `FIG-P9-002` | IA & Journeys | FigJam | 产品表面、旧六域结构、对象接力、12 旅程、Provider 双引擎；待按 `AUD-FE-P9-006` 重构为完整管理员视图 8 个一级/38 个二级、7 个 Shell 控件和对象 Tab | [Figma board](https://www.figma.com/board/8crRdLFh46S3V3z5vU8pLA) · file key `8crRdLFh46S3V3z5vU8pLA` · root `0:1` | `RESEARCH_MAPPED_WITH_STALE_NODES` |
| `FIG-P9-003` | Foundations, Components & Patterns | Design | Variables、Foundations、组件、状态和模式板 | [Figma Design](https://www.figma.com/design/Ujjt9lNj0YibvXJjALyc0c) · file key `Ujjt9lNj0YibvXJjALyc0c` · State Lab `16:2` · Product Patterns `18:2` · Navigation Components `26:2` · Primary/Secondary sets `26:17/26:30` | `FOUNDATIONS_DRAFT` |
| `FIG-P9-004` | SaaS App & Platform Ops | Design | 全页面线框、高保真代表、状态实验室、响应式和原型 | [Figma Design](https://www.figma.com/design/RSZk3Xgg814cDmmqtaxZZw) · file key `RSZk3Xgg814cDmmqtaxZZw` · IA 8/38 `44:2` · Core `6:2/9:2/10:2/11:2/12:2/61:2` · Cross-domain `23:2/23:119/23:236/23:335/29:119/30:2/31:2` · 状态 `18:*` · Mobile `20:*` · Mobile More `53:2` · Prototypes `22:*/24:*/32:*` | `HIGH_FIDELITY_DRAFT` |
| `FIG-P9-005` | Product Public Web, Help & Developer | Design | 产品官网、身份、信任、帮助、开发者、状态 | [Figma Design](https://www.figma.com/design/IMLSUMTQViEEauwBdzbczr) · file key `IMLSUMTQViEEauwBdzbczr` · 产品官网 `3:10` · 身份激活 `8:2` · 帮助 `6:2` · 开发者 `6:45` · Prototype `9:*` | `HIGH_FIDELITY_DRAFT` |
| `FIG-P9-006` | Generated Manufacturing Sites | Design | 使用客户审核资料生成企业、产品/服务、能力、信任、案例和通用询盘入口 | [Figma Design](https://www.figma.com/design/XlpWnitQlAodiF18wxPbDp) · file key `XlpWnitQlAodiF18wxPbDp` · 生成站首页 `3:10` | `HIGH_FIDELITY_DRAFT` |

## 3. Frame 命名

统一格式：

`{PAGE_OR_PFAM} / {SCENARIO} / {ACTOR} / {STATE} / {PRODUCT_STATUS} / {VERSION}`

示例：

`PAGE-FE-041 / SCN-FE-SITE-014 / Operator / FailedOldPreviewRetained / CURRENT_BACKEND_ONLY / v1`

规则：

- 不省略 Workspace/Actor 和 State；
- 不用 `Final`、`New Final`、`Copy 2`；
- blocker、backend-only、frozen、target 和 proposed 写进 Product Status；
- 设计修订使用版本和 successor，不静默覆盖已评审 Frame；
- Frame description 关联 Capability、Object、Contract、Metric、Guide、rights 和 last verified commit。

## 4. 文件内部结构

### 4.1 Foundations / Components

1. Primitive variables；
2. Semantic variables；
3. Typography、spacing、radius、border、elevation、motion、density；
4. Primitives；
5. Composites；
6. Product patterns；
7. State laboratory；
8. Deprecated/migration。

至少提供 Light 与高对比模式；Dark 只有真实使用场景和可访问性验证后建立。

### 4.2 SaaS Screens

产品评审通过 `DEC-FE-P9-020` 后，按完整管理员视图 8 个一级/38 个二级组织，其中 7 个业务一级/30 个业务二级，另有 1 个管理一级/8 个管理二级；再放 7 个横向 Shell 控件。对象详情使用对象 Tab，不在侧栏复制。页面 Frame 不按参考图、部门或 Provider 分组。公共站、生成站和平台运营使用明显 Section 隔离。

### 4.3 Research

每个外部参考必须有：来源 URL/本地路径、抓取日期、实际截图、用途、rights/provenance、学什么、不学什么、finding 和 decision。无法访问的来源保留 blocker 卡，不用搜索结果截图冒充产品体验。

## 5. 用户确认视觉基线

2026-07-23 用户确认以下五张页面“这几版图就可以”，因此不再生成三套视觉方向。五张图共同冻结视觉家族，分别验证不同页面构图；[资料与知识引导 Fixture](visual-direction-content-fixture.md) 约束后续页面内容。

### 5.1 选定基线

| 顺序 | 页面基线 | 文件 | SHA-256 | 状态 | 批准的设计特征 | 不批准的内容 |
|---:|---|---|---|---|---|---|
| 1 | Today 工作队列 | [today-work-queue.png](assets/selected-ui-baseline/today-work-queue.png) | `32a765616738263557737122e75847899df63dc9eab56d6bc9abd3676eb4e7eb` | `USER_SELECTED_VISUAL_BASELINE` | 任务优先、原因/Owner/截止/动作、运行进度、活动与风险辅助列 | 示例公司、域名、KPI 和邮件健康事实 |
| 2 | Site Editor | [site-editor.png](assets/selected-ui-baseline/site-editor.png) | `c88ee62ad0bf79ce60ce67432dd72af302cfd08c71ffcc44a8b5063259d38a19` | `USER_SELECTED_VISUAL_BASELINE` | 结构树—真实预览—上下文设置、稳定版本/预览动作 | CNC/ISO/产能文案及“生成新版本”已可运行的暗示 |
| 3 | Buyer Development | [buyer-development.png](assets/selected-ui-baseline/buyer-development.png) | `501df08793f4feecb118339e1774d25bb98f9f061c1670008991849c0f596692` | `USER_SELECTED_VISUAL_BASELINE` | 保存视图、紧凑表格、选中对象 Evidence/动作、辅助分派列 | 示例公司、评分、联系人、LinkedIn 和推荐动作结论 |
| 4 | Unified Inbox | [unified-inbox.png](assets/selected-ui-baseline/unified-inbox.png) | `766b67c3a9a1982fe3d183406f814071ceea0b5d1f092ff2b239729d03bfa06e` | `USER_SELECTED_VISUAL_BASELINE` | 队列—会话—上下文三栏、直接回复/AI 草稿分离、清楚的协作动作 | RFQ 阶段、金额、技术能力、机会结论和后端可用性 |
| 5 | AI Task Strategy | [ai-task-strategy.png](assets/selected-ui-baseline/ai-task-strategy.png) | `e4b6c6a9dd1b908e1dec13df344e704b61bc9a2648804669c24a8f70507b023e` | `USER_SELECTED_VISUAL_BASELINE` | 管理员任务档位、任务级策略、预算/用量和自动降级反馈 | 具体模型、积分、策略 API 已实现或向用户暴露 new-api |

共同语法：瓷白工作面、深墨文字、克制品牌蓝、细边框、低阴影、稳定一级 Shell 与顶栏、紧凑但可切换的密度。页面按任务使用一至三栏，不强制每页 Inspector。后续 Figma 必须用 current 合同替换示例内容，不能直接临摹像素或把图片当组件源。

### 5.2 已废弃的旧方向研究

2026-07-22 用户指出旧“买家详情 + RFQ 技术资格化”基准越过产品边界，且图片包含无权威来源的工程技术值。以下文件只为保持 provenance 和避免静默覆盖而保留；它们不是候选方向，也不得作为组件、页面规格、样例数据或能力证明。

| 原展示顺序 | Direction | Generated image | SHA-256 | 状态 | 废弃原因 |
|---|---|---|---|---|---|
| 1 | Precision Console | [precision-console.png](assets/visual-directions/precision-console.png) | `5308655dabfc9eedc385a68e7ea8fd9f770b5dd848098df68cc40751b6b68c9c` | `SUPERSEDED_RESEARCH_PROVENANCE` | 旧 RFQ 技术资格化 Fixture 越界，且含无来源工程事实 |
| 2 | Global Ops Cockpit | [global-ops-cockpit.png](assets/visual-directions/global-ops-cockpit.png) | `00511607d1a8e351edef42d54c419eeea00a49fec9a9dbeaa2283dcf501feda6` | `SUPERSEDED_RESEARCH_PROVENANCE` | 旧 RFQ 技术资格化 Fixture 越界，且含无来源工程事实 |
| 3 | Industrial Dossier | [industrial-dossier.png](assets/visual-directions/industrial-dossier.png) | `29904ab001e25a6bdd9b08c51e3edfc008cfbb5a50cd8c275d9e233a531b5eec` | `SUPERSEDED_RESEARCH_PROVENANCE` | 旧 RFQ 技术资格化 Fixture 越界，且含无来源工程事实 |

## 6. 组件与模式登记字段

每项至少记录：

- 稳定名称、purpose、non-use；
- anatomy、slot、variant、density；
- default/hover/focus/disabled/busy/error/partial/degraded/stale；
- keyboard、focus、scroll、async、close/back；
- content/i18n/long text/RTL；
- responsive/reflow/overflow/touch target；
- semantic token binding；
- Page/Scenario/Capability/Object/Copy/Asset；
- Owner、version、status、last verified、deprecation。

必须有独立模式板：对象头、多层状态、表格/保存视图/批量、长任务、Evidence、审批/执行、diff/冲突、协同活动、渠道 Binding、内容渠道变体、Inbox/Conversation、身份归并、指标下钻、帮助/事故。

## 7. QA 证据

每次设计里程碑记录：

1. metadata inspection；
2. 同状态、同视口截图；
3. 参考与设计并排比较；
4. 截断、重叠、字体、间距、图标、图片裁切和错误 Variant finding；
5. keyboard/focus/a11y 人工检查范围；
6. responsive、伪本地化、RTL、德语长文本和压力数据；
7. reviewer、日期、resolution 和 successor。

Figma 链接存在不等于文件内容、图片、原型或验证已完成。

## 8. 当前节点核验记录（2026-07-23）

- `FIG-P9-001`：node `3:46` 已改为动态企业资料与知识，node `4:67` 已改为五张视觉基线 Gate；旧固定规格和三方向 RFQ 选择门不再作为页面输入。
- `FIG-P9-002`：node `1:22`、`3:223`、`3:226`、`7:532` 和 connector `5:421` 已改为私密会话、通用分派/AI 草稿、商机上下文/外部交接和动态缺口。
- `FIG-P9-003`：已建立 4 个 Variable Collection、70 个 Variables、11 个 Text Styles、基础/产品组件、12 状态 State Lab 和五类 Product Patterns；新增 Navigation Components `26:2`、Primary Item set `26:17`、Secondary Item set `26:30` 和“一级 Rail → 二级 Panel → 对象 Tab”模式说明，当前为 `FOUNDATIONS_DRAFT`。
- `FIG-P9-004`：已建立 11 个 Page、42 个本地 Variables、9 个 Text Styles、十三张桌面代表页、五个关键状态、三张 390 宽移动端代表页和五条 SaaS 原型骨架；新增完整 8/38 IA 总图 `44:2`，统一核心/跨域/异常态桌面 Shell，新增移动“更多”抽屉 `53:2`，并以 `61:2` 补齐无伪 KPI 的洞察代表页。六个候选二级入口保留“规划中/合同阻塞”边界，当前仍为 `HIGH_FIDELITY_DRAFT`。
- `FIG-P9-005`：已建立 9 个 Page，以及产品官网 `3:10`、身份激活 `8:2`、帮助中心 `6:2`、开发者中心 `6:45` 和产品官网→安全激活原型 `9:*`；产品官网已从旧六域改为“7 个业务任务域 + 1 个管理控制区”，无虚构 KPI、客户或上线承诺，当前为 `HIGH_FIDELITY_DRAFT`。
- `FIG-P9-006`：已建立 9 个 Page 和客户生成站首页 `3:10`；动态资料和审核边界已写入页面，当前为 `HIGH_FIDELITY_DRAFT`。
- Figma API 当前不支持修改文件名；因此文件外壳可能保留创建时的英文名称，但板内标题、节点和后续界面文案均以中文为主。

Phase 0 的设计系统范围、颜色归一、字体、密度、组件和外部库采用判断见 [设计系统 v1 范围与差距分析](design-system-v1-scope.md)。Phase 1 的 Node、同视口 QA、生成素材和剩余门见 [Phase 1 设计证据](phase-1-design-evidence.md)。
