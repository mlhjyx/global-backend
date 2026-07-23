# Phase 9 Phase 1 设计证据

> 文档 ID：`EVID-FE-P9-001`
> 层级：`L4 / Design QA evidence`
> 状态：`DRAFT`
> 事实 Owner：`OWN-DESIGN`
> 证据日期：2026-07-23
> 关联：`DESIGN-FE-P9-003`、`DESIGN-FE-P9-005`

## 1. 本轮结果

用户确认 Phase 0 范围后，Phase 1 已完成第一轮 Foundations、组件、状态实验室、五类产品模式、十二张 SaaS 桌面代表页、四张产品公共表面代表页，以及客户生成站首页。所有资产仍是设计草稿，不表示正式 SaaS 前端、公共合同、Provider 运行时或生产发布已经存在。

本轮固定执行边界：

- 使用用户选定的五张页面作为布局、密度和视觉语言基线；
- 以 current 文档、OpenAPI、代码证据和产品状态替换截图中的示例事实；
- 不引入固定行业技术规格、统一准备度评分、RFQ/技术评审/样品/报价生命周期；
- Buyer 页面保持 `FROZEN_MAP_ONLY`；Inbox 和 AI 策略保持目标态/候选态；
- Figma 是设计真值，仓内 PNG 只是同视口 QA 快照。

## 2. Foundations 文件证据

文件：[`FIG-P9-003`](https://www.figma.com/design/Ujjt9lNj0YibvXJjALyc0c)，file key `Ujjt9lNj0YibvXJjALyc0c`。

| 内容 | Figma Node | 当前结果 | 状态 |
|---|---|---|---|
| Cover & Index | `10:2` | 文件用途、视觉原则和产品状态边界 | `FOUNDATIONS_DRAFT` |
| Foundations | `10:29` | 颜色、排版、间距、圆角和密度样板 | `FOUNDATIONS_DRAFT` |
| Primitives | `13:6` | Button、Field、Status Tag、Tab | `COMPONENT_DRAFT` |
| Product Components | `14:2` | Task Row、Evidence Row、Async Job Banner、Conversation Item、Provider Summary | `COMPONENT_DRAFT` |
| State Lab | `16:2` | 12 个强制状态与下一步/a11y 文案 | `STATE_LAB_DRAFT` |
| Product Patterns | `18:2` | Today、Site Editor、Buyer Development、Unified Inbox、AI Task Strategy 模式 | `PATTERN_DRAFT` |

已建立 4 个 Variable Collection、70 个 Variables 和 11 个 Text Styles。中文 UI 使用 Noto Sans SC，拉丁和数字使用 Inter；主蓝候选为 `#2D5BCC`。这些值仍为 `MEASURED_DRAFT`，未完成高对比、RTL、伪本地化和用户验证，不能称为生产 Token。

组件集节点：

- Button `13:27`；
- Field `13:44`；
- Status Tag `13:55`；
- Tab `13:62`；
- Task Row `14:49`；
- Evidence Row `14:78`；
- Async Job Banner `14:94`；
- Conversation List Item `14:123`；
- Provider Connection Summary `14:148`。

已知限制：当前远程 Figma 执行环境无法把文本子层批量绑定为可编辑 Component Property，事务已回滚，没有留下半成品。Variant 与视觉状态可用，但文本属性化、键盘说明、发布 Library 和 Code Connect 仍待后续处理。

## 3. SaaS 核心高保真页面

文件：[`FIG-P9-004`](https://www.figma.com/design/RSZk3Xgg814cDmmqtaxZZw)，file key `RSZk3Xgg814cDmmqtaxZZw`。

文件封面与节点索引为 `14:2`，明确列出五张核心页的 Page ID、Figma Node 和产品状态。

| 页面 | Figma Node | Frame 名称 / 状态 | 当前边界 |
|---|---|---|---|
| Today | `6:2` | `PAGE-FE-003 / SCN-FE-SHELL-004 / Operator / Normal / MIXED / v0.1` | 工作队列、运行、活动、建议和风险；无伪 KPI |
| Site Editor | `9:2` | `PAGE-FE-045 / SCN-FE-SITE-011 / SiteEditor / Normal / APPROVED_NOT_BUILT / v0.1` | 结构树—预览—Inspector；不暗示编辑器已实现 |
| Buyer Development | `10:2` | `PAGE-FE-063 / SCN-FE-BUYER-001 / Operator / Normal / FROZEN_MAP_ONLY / v0.1` | 定性 Fit/Intent/可达性和 Evidence；示例数据不构成事实 |
| Unified Inbox | `11:2` | `PAGE-FE-080 / SCN-FE-ENGAGE-001 / Agent / IdentityPending / TARGET_NOT_RUNNABLE / v0.1` | 队列、会话、身份核对、分派和 AI 草稿；无 RFQ 生命周期 |
| AI Task Strategy | `12:2` | `CAND-P9-PAGE-AI-STRATEGY / CAND-P9-SCN-AI-POLICY / WorkspaceAdmin / Normal / MIXED / v0.1` | 候选页面族；只显示任务档位，不暴露 new-api 密钥和路由 |

SaaS 文件已建立 11 个 Page、42 个本地语义/尺寸 Variables 和 9 个 Text Styles。因 Foundations Library 尚未发布，SaaS 文件暂用本地语义镜像；正式冻结时需要迁移到发布后的 Library Variables 并记录 alias 变化。

### 3.1 产品公共表面与客户生成站代表页

| 产品表面 | 文件 / Figma Node | Frame 名称 / 状态 | 当前边界 |
|---|---|---|---|
| 产品官网 | [`FIG-P9-005`](https://www.figma.com/design/IMLSUMTQViEEauwBdzbczr) · `3:10` | `CAND-P9-PUBLIC-HOME / CAND-P9-SCN-PUBLIC-001 / Visitor / Normal / PROPOSED / v0.1` | 解释产品价值、六项任务域、设计预览与信任边界；不使用虚构客户、KPI、部署状态或“所有模块已上线”文案 |
| 身份与安全激活 | [`FIG-P9-005`](https://www.figma.com/design/IMLSUMTQViEEauwBdzbczr) · `8:2` | `CAND-P9-PUBLIC-ACTIVATION / CAND-P9-SCN-ACTIVATION-001 / NewWorkspaceOwner / GuidedActivation / PROPOSED / v0.1` | 邮箱验证、Workspace、角色、安全 Demo、导入和恢复；明确身份由 SaaS/IdP 持有 |
| 帮助中心 | [`FIG-P9-005`](https://www.figma.com/design/IMLSUMTQViEEauwBdzbczr) · `6:2` | `CAND-P9-PUBLIC-HELP / CAND-P9-SCN-HELP-001 / ProductUser / TaskOrientedHelp / PROPOSED / v0.1` | 按 Tutorial、How-to、Reference、Explanation 分流；指南回链对象、状态和原任务 |
| 开发者中心 | [`FIG-P9-005`](https://www.figma.com/design/IMLSUMTQViEEauwBdzbczr) · `6:45` | `CAND-P9-PUBLIC-DEVELOPER / CAND-P9-SCN-DEVELOPER-001 / Developer / ContractFirst / PROPOSED / v0.1` | 从 Workspace、scope、OpenAPI、签名 Webhook、幂等和退出开始；不暴露 Provider secret |
| 客户生成站 | [`FIG-P9-006`](https://www.figma.com/design/XlpWnitQlAodiF18wxPbDp) · `3:10` | `PAGE-FE-057 / CAND-P9-SCN-GENERATED-HOME-001 / Visitor / Normal / DESIGN_FIXTURE / v0.1` | 使用客户审核后的动态资料组织企业、产品/服务、能力、资料和通用询盘入口；不固化 CNC、ISO、产能或统一行业技术字段 |

五张产品表面代表页均为 `1440 × 1024` 桌面草稿，用于验证公共产品表达、SaaS 工作台和客户生成站三层不共用同一信息架构或页面模板。产品官网文件已建立 9 个 Page，生成站文件已建立 9 个 Page；其余页面仍未完成，不得把代表页状态外推为全文件已设计。

### 3.2 四个跨域页面族代表

以下页面用于验证 v2.1 中容易被遗漏或错误合并的产品边界。它们采用同一 SaaS Shell，但对象、状态和允许动作保持独立。

| 页面族 | Figma Node | Frame 名称 / 产品状态 | QA 快照 / SHA-256 |
|---|---|---|---|
| 动态资料与知识 | `23:2` | `PAGE-FE-024 / SCN-FE-TRUTH-003 / ContentOperator / ExtractionReview / CODE_BACKED_SUBSET / v0.1` | [enterprise-knowledge-v0.1.png](assets/figma-phase-1/enterprise-knowledge-v0.1.png) · `9d99ac5292ebce65f935757127ec2c0d36fc4c437398991b8a90e801ee7f5938` |
| Provider 连接详情 | `23:119` | `CAND-P9-PAGE-INTEGRATION-DETAIL / CAND-P9-SCN-PROVIDER-001 / WorkspaceAdmin / ScopeReview / CONTRACT_BLOCKED / v0.1` | [integration-detail-v0.1.png](assets/figma-phase-1/integration-detail-v0.1.png) · `46d3629dfea84145c939aa7c1aff94183687eadbc10ac666bdf60be65a4ea01b` |
| 发布任务与回执 | `23:236` | `PAGE-FE-078 / SCN-FE-GROWTH-003 / Publisher / PartialDelivery / TARGET_NOT_RUNNABLE / v0.1` | [publish-receipts-v0.1.png](assets/figma-phase-1/publish-receipts-v0.1.png) · `e255c8b3fcb6c092b77ae11b4db53b4fe165322ec34b510b3e115db470726f06` |
| 公开互动 | `23:335` | `CAND-P9-PAGE-PUBLIC-ENGAGEMENT / CAND-P9-SCN-ENGAGE-002 / Agent / ModerationPending / CONTRACT_BLOCKED / v0.1` | [public-engagement-v0.1.png](assets/figma-phase-1/public-engagement-v0.1.png) · `e6dfa0c407da60b4d5d838b296b7a11c5a99b0b09f0244d04ea5a30315ab35ee` |

边界检查结果：资料字段来自引导/上传/导入/KB 抽取；连接页按 capability 分权且不暴露密钥；发布页区分失败与 ACK unknown；公开互动与 Unified Inbox 分队列，并且“升级私聊”只形成交接，不写入 Opportunity。

### 3.3 第二批跨产品闭环代表

| 页面族 | Figma Node | Frame 名称 / 产品状态 | QA 快照 / SHA-256 |
|---|---|---|---|
| 首次激活与资料导入 | `31:2` | `CAND-P9-PAGE-ONBOARDING-IMPORT / CAND-P9-SCN-ONBOARDING-002 / WorkspaceOwner / GuidedImport / CODE_BACKED_SUBSET / v0.1` | [onboarding-import-v0.1.png](assets/figma-phase-1/onboarding-import-v0.1.png) · `13404fba68162e48d36b86d42418afb10e48bab15b8589e343498fb3d7b310ec` |
| 数据导出与账户关闭 | `29:119` | `CAND-P9-PAGE-DATA-EXIT / CAND-P9-SCN-DATA-EXIT-001 / WorkspaceAdmin / ExportReady / CONTRACT_BLOCKED / v0.1` | [data-exit-v0.1.png](assets/figma-phase-1/data-exit-v0.1.png) · `f183ff32644420dd6c91e47a36d8fa3a490de249423c03a2320aa5b57c2b3ba4` |
| Provider 故障与退出 | `30:2` | `CAND-P9-PAGE-PROVIDER-EXIT / CAND-P9-SCN-PROVIDER-EXIT-001 / PlatformOperator / ReconcileAndExit / CONTRACT_BLOCKED / v0.1` | [provider-exit-v0.1.png](assets/figma-phase-1/provider-exit-v0.1.png) · `12d303e9c43c857d7a4d3b07ccf6af64e988e4201bcf6bdc23d80a220a95881f` |

三页分别验证最少输入与稍后继续、导出/保留/最后管理员关闭门，以及 Provider 故障时的受限执行、ACK unknown 对账、失败子集重试和可恢复退出。它们不把候选 `DataExportJob`、Workspace 关闭或替代 Provider 运行时画成已实现。

## 4. 同视口视觉 QA

五张参考与 Figma 页面均使用 `1586 × 992` 同一视口并排检查。仓内快照仅用于 provenance；Figma Node 才是可编辑设计源。

| 页面 | QA 快照 | SHA-256 | 已关闭的主要偏差 |
|---|---|---|---|
| Today | [today-v0.1.png](assets/figma-phase-1/today-v0.1.png) | `fd6e218a38623e91bc93c2618a154364aad93d883b2895649f0e3be5dbb1e530` | 收窄侧栏、重排搜索和主区；移除示例 KPI/客户事实 |
| Site Editor | [site-editor-v0.1.png](assets/figma-phase-1/site-editor-v0.1.png) | `1e11449ad0744790fe350c52dc29f4593e7db64f5c1cf99d363058ec565248ff` | 用动态资料、知识来源与审核状态替换 CNC/ISO/产能承诺；目标动作显式不可运行 |
| Buyer Development | [buyer-development-v0.1.png](assets/figma-phase-1/buyer-development-v0.1.png) | `6ffbb8b3df0e58597b16edb2947a22be647fb9f861801a451253384ef93e8d19` | 用高/中/低和来源解释替换伪精确分数；创建动作改为查看冻结任务地图 |
| Unified Inbox | [unified-inbox-v0.1.png](assets/figma-phase-1/unified-inbox-v0.1.png) | `393de2270ff88ace0bfb3204760ad0be1c9ec8198607dca42f07f4bdd3c9cc2a` | 删除 RFQ、金额和技术阶段；改为身份核对、分派和外部交接 |
| AI Task Strategy | [ai-task-strategy-v0.1.png](assets/figma-phase-1/ai-task-strategy-v0.1.png) | `63896947ddc589aad36c49bc08c1cc21a50db6a344965577283d0aeda4380606` | 移除伪用量数字和具体模型；策略保存显式标为目标态 |

产品官网和客户生成站没有用户批准的逐页像素参考，因此本轮只做同视口作者检查，不冒充“与参考图一致”的 QA：

| 页面 | 作者检查快照 | SHA-256 | 已检查边界 |
|---|---|---|---|
| 产品官网首页 | [public-home-v0.1.png](assets/figma-phase-1/public-home-v0.1.png) | `3b1e54bb1683bb3b0188cc03a45c8a45a1c31cfe1eb47f52b6ed90a42e2f3729` | 1440×1024；导航、Hero、产品域、信任说明无裁切/重叠；无伪 KPI、客户案例和运行承诺 |
| 身份与安全激活 | [identity-activation-v0.1.png](assets/figma-phase-1/identity-activation-v0.1.png) | `b0a3ddb79d560e2db3fff49e9e00f24e4b6e3d7b55d35d224923389dfb05b77d` | 1440×1024；激活步骤、责任边界与 CTA 无裁切/重叠；不宣称本仓管理身份 |
| 帮助中心 | [help-center-v0.1.png](assets/figma-phase-1/help-center-v0.1.png) | `8163d6e83eafac1994fffdda8025b253bb1d3adef3239bf14a070c1f5719c3de` | 1440×1024；Diátaxis 分类、诊断入口和产品状态说明无裁切/重叠 |
| 开发者中心 | [developer-center-v0.1.png](assets/figma-phase-1/developer-center-v0.1.png) | `1c106507a020c7de9ab8f2c8a945eb45d5b109368a5e17fc2ffa8de470639159` | 1440×1024；修正 OpenAPI/变更卡片标题换行后无重叠；不暴露 Provider secret |
| 客户生成站首页 | [generated-home-v0.1.png](assets/figma-phase-1/generated-home-v0.1.png) | `5d657aa37d3ee3230f7194c0288d57ece70267009fe09f32ea1ebf1b270a856b` | 1440×1024；Hero 裁切、动态模块、来源/审核说明和询盘入口无裁切/重叠；无固定行业规格 |

本轮桌面 Normal、五个关键状态与三张移动端代表页均已完成作者视觉 QA，但以下仍未完成，不能升级为 `SPEC_DESIGNED` 或 `VALIDATED`：

- hover/focus/disabled/busy 的逐组件交互检查；
- 1280、1024/768、320、横屏与软键盘状态的响应式重排；
- 200%/400% zoom、键盘顺序、焦点恢复、live region、drag alternative；
- 英文、德语长文本、RTL 和伪本地化；
- 其余六条完整 Journey、真实角色测试和第二轮设计评审。

### 4.1 五个关键状态

五个核心页面均从已检查的 Normal Frame 派生，状态只改变可解释的状态层和允许动作，不改变对象边界或伪造后端能力。

| 页面 / 状态 | Figma Node | QA 快照 / SHA-256 | 交互结论 |
|---|---|---|---|
| Today / Degraded | `18:2` | [today-degraded-v0.1.png](assets/figma-phase-1/today-degraded-v0.1.png) · `845729ec02c8e28476630f9be47f5fb5bee24b669c20ce23a0e4246cba88a4b5` | 只显示已确认行动；缺失来源不被解释为“无任务” |
| Site Editor / OfflineDraft | `18:146` | [site-editor-offline-v0.1.png](assets/figma-phase-1/site-editor-offline-v0.1.png) · `e331cb53108d2411daffec3220fb2ed9a97ae0ad6763eb5570e78d9b0d5cc919` | 草稿保存在设备；生成新版本保持不可用，恢复连接后先处理冲突 |
| Buyer / Stale | `18:304` | [buyer-stale-v0.1.png](assets/figma-phase-1/buyer-stale-v0.1.png) · `9f3993f71faab66493698b9063e783b5b7641ce83e22ccc03c74cb59a3f7ea38` | 可查看身份，但过期信号/可达性不可用于新决定 |
| Inbox / ProviderDegraded | `18:553` | [inbox-provider-degraded-v0.1.png](assets/figma-phase-1/inbox-provider-degraded-v0.1.png) · `738b7b28ed44ca60c6d961fe094b2d831ad4dc2a82649314a8fe476b9eee58ce` | ACK unknown 时允许内部备注，禁止把未知当已送达或重复发送 |
| AI Strategy / Denied | `18:744` | [ai-strategy-denied-v0.1.png](assets/figma-phase-1/ai-strategy-denied-v0.1.png) · `1de0415ddd0eca2ca90c723e562c37cc2f9142fade3205a6581f70155da1018e` | WorkspaceMember 只读；修改、预算和降级策略由管理员控制 |

### 4.2 移动端代表页

本轮建立三张 `390 × 844` 代表页，验证移动端优先处理行动、监控、分派和快捷回复，重型编辑器明确桌面接力。

| 页面 | Figma Node | QA 快照 / SHA-256 | 范围 |
|---|---|---|---|
| Today Mobile | `20:2` | [today-mobile-v0.1.png](assets/figma-phase-1/today-mobile-v0.1.png) · `f1eaab3bfd333d2f818dc227a7fe3c69536aa2b65f7561465b21e4493e1b901b` | 优先任务、降级提示和运行监控 |
| Site Mobile Handoff | `20:40` | [site-mobile-handoff-v0.1.png](assets/figma-phase-1/site-mobile-handoff-v0.1.png) · `82b412593c191820417956a3eac0cad898d6cd71f617271a05540597219e6ebb` | 预览、检查和桌面接力；不提供移动端结构/属性编辑 |
| Inbox Mobile | `20:78` | [inbox-mobile-v0.1.png](assets/figma-phase-1/inbox-mobile-v0.1.png) · `f4bf72c483e79fc150e85d6863e4bb12188191196204b3dcec5309a767f9fc2a` | 身份提示、会话、AI 草稿、送审和快捷回复 |

这些 Frame 只关闭 390 宽代表场景；320、平板、横屏、软键盘、200%/400% zoom 和 RTL 仍未验证。

### 4.3 第一批可点击原型

Figma 跨 Page 原型连接不被当前 API 接受，因此在 `10 Prototypes` Page 中创建同页受控副本，并通过共享插件元数据标记 `DESIGN_PROTOTYPE_ONLY`。这不制造新的产品对象或 Page ID。

| 原型 | 起点 → 终点 | 主动作 |
|---|---|---|
| `PROTO-P9-01` | Today `22:142` → Site Editor `22:282` | Today 的“查看” |
| `PROTO-P9-01C` | Site Mobile `22:436` → Site Editor `22:282` | “发送到桌面” |
| `PROTO-P9-02` | Buyer `22:474` → Inbox `22:719` | “加入跟进” |
| `PROTO-P9-03` | Publish Receipts `24:2` → Public Engagement `24:101` → Inbox `22:719` | “查看公开互动” → “升级私聊” |
| `PROTO-P9-04` | Onboarding Import `32:2` → Extraction Review `32:119` | “接受并继续” |
| `PROTO-P9-05` | Provider Reconcile `32:237` → Data Export and Closure `32:354` | “开始迁移” |
| `PROTO-P9-06` | Product Home `9:2` → Safe Activation `9:45` | “开始使用” |

本轮形成六条旅程骨架和一条跨设备接力，不等于 12 条 Journey 已完成；其余六条仍需补关键决定、异常恢复和退出。

## 5. 生成素材 provenance

Site Editor 和客户生成站代表页使用本轮生成的无品牌制造业横幅：

- 文件：[industrial-hero-v1.png](assets/generated/industrial-hero-v1.png)；
- SHA-256：`252261158dc7ecb0dc4140d9841110fff4e59f1e2a91d865cce74540f769fad3`；
- 尺寸：`1672 × 941`；
- 生成方式：内置图像生成工具；
- 用途：Figma 演示 Fixture，不是客户素材或默认公开站资产；
- 权利/风险：无品牌、无文字、无人脸、无认证/产能/公差声明；进入生产品牌资产前仍需人工权利与相似性审核。

生成提示词摘要：现代精密制造车间与 CNC 加工中心，16:9 横幅，设备位于右侧，左侧保留暗部文案空间；石墨、钢色、矿物白与克制钴蓝；禁止品牌、标识、文字、数字、人脸、水印和任何技术/认证承诺。

## 6. 下一阶段门

下一阶段不重复生成视觉方向，而是：

1. 完成 Foundations 的属性化、发布与迁移策略；
2. 继续补 empty/loading/partial/conflict/cancel-confirming/late result；本轮五个首要异常状态已完成；
3. 以已完成的 76/76 Page Manifest 2.0 继续逐页建立唯一 Figma Node；
4. 在已完成的六条原型骨架和三张移动端代表页上继续闭合其余六条 Journey 与全断点；
5. 完成两轮角色任务验证后再申请 `SPEC_DESIGNED/VALIDATED`。
