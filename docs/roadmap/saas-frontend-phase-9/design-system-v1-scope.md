# Phase 9 设计系统 v1 范围与差距分析

> 文档 ID：`DESIGN-FE-P9-005`
> 层级：`L2 / Design system scope proposal`
> 状态：`DRAFT`
> 阶段状态：`PHASE_0_APPROVED / PHASE_1_CORE_DRAFT_COMPLETE`
> 事实 Owner：`OWN-DESIGN`
> 最后核验：2026-07-23

## 1. 目的与证据边界

本文件记录正式写入 Figma Variables、组件和页面前的 Phase 0 发现结论，以及用户确认后的 Phase 1 第一轮结果。候选 Token、组件和页面仍未完成响应式、a11y、属性化和用户验证，不升级为 `SPEC_DESIGNED`。

设计依据依次为：

1. Gate 4 已批准的 Shell、权限、状态、AI、响应式和内容合同；
2. Phase 9 已完成的 171/171 文档快照、64/64 OpenAPI operation 映射和 76/76 Page ID 映射；
3. 用户选定的五张视觉基线；
4. 已登记的参考产品和外部设计系统，只用于模式比较，不复制其组件、资产或业务内容。

五张视觉基线批准“白色工作面、深墨正文、克制钴蓝、细边框、低阴影、紧凑信息密度和任务型一至三栏布局”。图中的公司、CNC、RFQ、金额、评分、模型、积分和 KPI 不进入设计系统。

## 2. Phase 0 发现

| 发现 ID | 发现 | 影响与处理 |
|---|---|---|
| `DSDISC-P9-001` | 仓库没有正式 SaaS 前端 repo、生产 Token、Storybook 或可证明的组件实现 | Figma v1 保持 stack-neutral；任何实现映射继续受 `BLK-FE-P9-001` 阻塞 |
| `DSDISC-P9-002` | 五张基线的主蓝并不完全一致，抽样约在 `#1B4CCD` 至 `#626FB1` | 不逐图复制颜色；先以 `#2D5BCC` 为品牌主色候选中心建立语义色阶，再用同状态并排比较、对比度和高风险动作识别测试校正 |
| `DSDISC-P9-003` | 五张基线共享布局语法，但 Shell、侧栏宽度、圆角和控件高度存在差异 | 固化共同模式，不把截图中的偶然尺寸当 Token；所有数值先标 `MEASURED_DRAFT` |
| `DSDISC-P9-004` | 两个既有 FigJam 曾含固定规格、独立准备度和 RFQ/技术评审遗留节点 | Phase 1 前已按 current 对象边界修正指定节点和连接；状态恢复为 `RESEARCH_MAPPED`，仍不等于页面或 Journey 已验证 |
| `DSDISC-P9-005` | 四个正式 Design file 已创建；Phase 1 已写入 Foundations、12 张 SaaS 桌面代表、4 张公共表面、1 张客户生成站、5 个关键状态和 3 张移动端代表 | `FIG-P9-003` 为 `FOUNDATIONS_DRAFT`，`FIG-P9-004/005/006` 为 `HIGH_FIDELITY_DRAFT`；代表页不等于文件内全部页面已完成 |
| `DSDISC-P9-006` | 可用外部库中的 Simple Design System 有基础 Input/Navigation，但缺少本产品所需的高密度表格、Evidence、长任务、Inbox 和多轴状态，视觉也不匹配 | 不导入为核心库；只参考公开模式。核心组件在本地 Figma 文件中净室建立，避免形成外部库依赖 |
| `DSDISC-P9-007` | 中文优先且需要英文、德语长文本与 RTL；Figma 环境可用 Noto Sans SC 与 Inter | 推荐中文 UI 使用 Noto Sans SC，拉丁字符与数字使用 Inter；正式冻结前必须完成缺字、数字对齐、400% zoom 和伪本地化验证 |

## 3. 建议的 v1 Foundations

以下均为 `MEASURED_DRAFT`，只有用户批准 Phase 0 范围并在 Figma 中通过并排视觉 QA 后才冻结。

### 3.1 语义颜色

- `surface.canvas / surface.default / surface.raised / surface.selected`；
- `text.primary / text.secondary / text.muted / text.disabled / text.inverse`；
- `brand.primary / brand.hover / brand.pressed / brand.soft / focus.ring`；
- `border.subtle / border.default / border.strong / border.focus`；
- `status.success / status.warning / status.danger / status.info` 及各自 soft surface；
- `overlay.scrim / overlay.disabled`。

颜色语义固定：绿色只表示已验证或健康；琥珀表示待复核、部分成功或接近阈值；红色表示失败、危险或不可逆动作；品牌蓝不表示“健康”。

### 3.2 排版、间距与密度候选

| 类别 | v1 候选 |
|---|---|
| 字体 | 中文 `Noto Sans SC`；拉丁/数字 `Inter`；无授权品牌字体假设 |
| 字号/行高 | Display `28/36`、H1 `24/32`、H2 `20/28`、H3 `16/24`、Body `14/22`、Compact `13/20`、Caption `12/18`、Micro `11/16` |
| 间距 | `4, 8, 12, 16, 20, 24, 32, 40, 48` |
| 圆角 | `4, 6, 8, 10, 12, full`；大面积容器优先低圆角 |
| 表格密度 | Compact `36`、Default `44`、Comfortable `52` 行高候选 |
| 阴影 | 默认靠边框分层；仅浮层、拖拽和强覆盖使用低强度 elevation |
| 动效 | 仅反馈、状态变化与空间连续性；支持 reduced motion，不使用装饰性长动画 |

## 4. v1 组件与模式边界

### 4.1 Foundations 与基础控件

- Button、IconButton、Input、Textarea、Search、Select、Checkbox、Radio、Switch；
- Avatar、Badge、StatusTag、Tooltip、Popover、Dialog、Toast；
- Tabs、SegmentedControl、Pagination、Breadcrumb。

### 4.2 Shell 与高密度工作面

- Topbar、WorkspaceSwitcher、GlobalSearch、PrimaryNav、SecondaryNav、UserMenu；
- ObjectHeader、InspectorSection、ContextPanel、ResizablePane；
- DataTable、TableHeader、TableRow、Cell、SavedView、DensityControl、BulkActionBar；
- TaskRow、ProgressRow、ActivityItem、Alert、NotificationItem。

### 4.3 产品特有组件

- EvidenceRow、SourceAnchor、FreshnessIndicator、ConflictSummary、ClaimDiff；
- ApprovalBar、AuthorizationSummary、AllowedActionState；
- AsyncJobBanner、PartialFailureSummary、RetrySubsetAction、CancelConfirming、AckUnknown；
- UploadQueue、KnowledgeSourceRow、ExtractionReview、DynamicGapPrompt；
- ConversationListItem、MessageBubble、InternalNote、ReplyComposer、AIDraftReview；
- ProviderConnectionSummary、CapabilityBindingRow、SyncHealth、DeliveryReceiptRow。

### 4.4 组合模式

1. 稳定 Shell 与 Today 行动队列；
2. 列表—详情与保存视图；
3. 页面树—预览—Inspector 的 Site Editor；
4. 队列—会话—业务上下文—回复区的 Unified Inbox；
5. 任务档位—预算—权限—降级记录的 AI 策略管理；
6. 动态资料引导—上传/导入—抽取复核—缺口补充；
7. 草稿—审核—批准—外部执行—回执；
8. State Lab：normal、empty、loading、partial、degraded、stale、denied、conflict、offline、ACK unknown、cancel-confirming、late result。

生成站的导航、Hero、产品/服务、能力、证据和询盘组件不进入 SaaS 核心库；它们在 `FIG-P9-006` 中服从 TemplateFamily/DesignDNA 单独建立。

## 5. Phase 0 后的写入顺序与当前结果

1. 两个 FigJam 的越界节点和连接关系已修正；
2. `FIG-P9-003` 已建立 4 个 Variable Collection、70 个 Variables、11 个 Text Styles、9 组组件和 12 状态 State Lab；
3. Today、Site Editor、Buyer Development、Unified Inbox 和 AI Task Strategy 已完成 `1586 × 992` 第一轮高保真及同视口对照；
4. 产品官网、身份激活、帮助中心、开发者中心和客户生成站已完成 `1440 × 1024` 代表页与作者检查，分别验证公共产品表达、安全激活、指南/合同入口和动态客户资料输出；
5. 五个关键异常状态、三张 `390 × 844` 移动端代表页、七个跨域/退出页面族代表和六条可点击原型骨架已完成；
6. 76/76 Page Manifest 2.0 已完成第一轮登记；Token、组件属性、全断点、a11y、长文本和用户验证尚未冻结；
7. 下一步进入其余状态、页面族、断点和剩余 6 条完整 Journey。

## 6. Phase 1 批准记录与剩余门

2026-07-23 用户以“确认”批准以下范围：

- 采用五张基线的共同视觉语法，不逐图复制不同蓝色和偶然尺寸；
- 以 `#2D5BCC` 色系、Noto Sans SC + Inter 和上述密度作为可校正候选，而不是已冻结生产值；
- 不导入外部 Design System 作为核心依赖；
- 先修正 FigJam 旧对象，再写 Variables/Components；
- Figma 是单一设计真值，Canva 等 Figma 页面冻结后再制作评审材料。

批准后已按上述范围写入 `FIG-P9-003/004/005/006`。详细 Node、截图、已知限制和生成素材 provenance 见 [Phase 1 设计证据](phase-1-design-evidence.md)。公共站与生成站当前只有首页代表页，Token、文件内其余页面和全部交互仍未通过最终设计评审。
