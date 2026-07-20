# 响应式、可访问性、性能与国际化规范

> 文档 ID：`FE-GLOBAL-011`
> 层级：`L2 / Normative target`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_4`
> 内容 Owner：`OWN-DESIGN`
> 技术/证据 Owner：`OWN-SAAS-FE`、`OWN-QA-EVIDENCE`（当前未指派）

## 1. 目标与证据边界

SaaS 管理前端和公开输出以 [WCAG 2.2](https://www.w3.org/TR/WCAG22/) AA 为最低目标；组件键盘行为参考 [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)，但 APG 是实践指南而不是 UI 设计系统或 WCAG 合规证明。最终合规还需要自动检查、键盘/读屏/缩放人工验证和真实页面证据。

当前没有正式前端或设计源，因此本文件是目标门，不声称已达标。

## 2. 响应式原则

按内容和任务定义 container/breakpoint，不按设备品牌。每个页面先确定：

- 最小可完成任务、信息优先级和可隐藏/折叠内容；
- 表格的列优先级、横向滚动、卡片化或详情替代，不能直接截断关键状态；
- 导航、对象上下文、Evidence/AI 侧面板在窄屏如何进入/返回；
- 编辑器、diff、批量操作和图表在不足空间时如何安全降级；
- 触摸、键盘、鼠标、放大和屏幕阅读器的等价路径。

至少验证 320 CSS px 宽内容 reflow、400% zoom、横/竖屏、长德语/伪本地化、RTL、系统字号放大和移动软键盘。确需双向滚动的复杂数据表/画布记录例外和可访问替代。

## 3. 语义与导航

- 优先原生 HTML；只有原生语义不足时使用 ARIA，且实现完整角色、状态和键盘行为。
- 页面有唯一且描述结果的 H1，标题层级不跳跃；使用 header/nav/main/aside/footer/region landmarks 和 skip link。
- 链接用于导航，按钮用于动作；div/span 不模拟交互。
- 动态路由/对话框/抽屉有可预测焦点进入与返回；后台刷新不抢焦点。
- 列表、表格、表单、状态、时间、金额和图表有程序可确定的结构/名称/单位。

## 4. 键盘、焦点与目标尺寸

- 所有功能可用键盘完成，Tab 顺序符合视觉/逻辑；复合组件使用一致的箭头键等模式。
- 焦点始终可见且与 selected/active/error 分开；sticky header、Toast 或 dialog 不遮住焦点。
- 不设置键盘陷阱；Escape/关闭/返回行为一致，危险动作不能仅靠 hover。
- WCAG 2.2 AA 的目标尺寸基线为至少 24×24 CSS px 或满足允许例外；项目对主要触摸动作应优先使用更宽松的 semantic control size。
- 拖拽必须有不依赖拖动的替代；快捷键可发现、可关闭且不冲突。

## 5. 表单、错误和身份

- 每个输入有持久 label；placeholder 不是 label。help、format、required、unit 与 error 通过可访问关系关联。
- 客户端即时校验辅助输入，服务端错误仍是结果真值；错误摘要可聚焦并链接字段。
- 不只用颜色/图标，错误文案说明如何修复；保留用户输入，敏感字段例外明确。
- 密码管理器、粘贴、自动填充和可访问认证不被无故阻断；验证码/二次验证需替代方案。
- 多步骤流程显示步骤、保存状态和返回影响，不用时间限制困住用户；必要超时提供警告/延长。

## 6. 动态内容、AI 与数据

- live region 只宣布对当前任务有意义的变化；轮询/streaming/Token 逐字更新不持续打断读屏。
- AI streaming 有“停止生成”、最终结构化结果和非流式可读替代；类型、Evidence 和未知项不靠装饰。
- 进度有名称和值；无法测量时使用 indeterminate，不伪造百分比。
- 图表提供文字摘要、数据表、时间范围、单位和新鲜度；筛选变化能被感知但不抢焦点。
- Canvas/拖拽编辑器、diff、代码块和地图必须定义键盘/读屏替代或明确阻止范围。

## 7. 视觉与媒体

- 普通文本对比至少 4.5:1，大文本至少 3:1；必要的非文本 UI/焦点/图形至少 3:1，按 WCAG 适用例外处理。
- 文本可调整间距并在缩放时不丢内容/功能；禁止把文字烘焙进图片作为唯一表达。
- 有意义图片有与任务相称的 alt；装饰图片空 alt；复杂图有短摘要和详情。
- 视频需要字幕；仅音频/视觉信息提供相应替代。动画、闪烁和视差受控，并尊重 `prefers-reduced-motion`。

## 8. 性能质量门

性能按真实用户任务、设备、网络、locale、数据量和权限状态分层，不能只测空白首页或开发机。

| 面 | 最低计划 |
|---|---|
| Public output | 以当前 [Core Web Vitals](https://web.dev/articles/vitals) “good”方向作为候选外部基线：LCP ≤2.5s、INP ≤200ms、CLS ≤0.1，按 mobile/desktop 的第 75 百分位分别评估；最终产品 SLO 另由 Owner 批准 |
| SaaS initial shell | 记录 HTML/JS/CSS/font/image budget、首个可操作、会话/Workspace 依赖和低端设备基线；具体值在正式栈/测量后决定 |
| Route transition | 避免重复 waterfall；关键对象骨架与已有数据先呈现，后台刷新不造成布局跳动 |
| Large data | server pagination/filter、virtualization 的 a11y、稳定 selection 和 bulk action；不下载全量再前端过滤 |
| Long task | 与任务解耦，可关闭页面/跨设备继续；poll/backoff/stream 重连受预算和可见性控制 |
| Media/upload | 尺寸/格式预检、断点/重试策略、进度、压缩/variant；不可将 PUT 完成冒充处理完成 |
| Third party | 明确必要性、延迟/失败隔离、consent、安全、缓存和退出；第三方脚本不阻断核心任务 |

实验室指标用于回归，field data 用于真实体验；样本不足标 unknown。性能退化必须能关联 Release/route/device/locale，而不是一个全站平均分。

## 9. 国际化与市场适配

| 主题 | 规则 |
|---|---|
| UI/content locale | SaaS UI 语言与 Site 内容语言独立保存和切换 |
| Formatting | locale + Workspace/user timezone 格式化日期、数字、货币、百分比、单位；底层值和时区可追踪 |
| Messages | message ID + ICU 等价 plural/select；禁止字符串拼接和靠词序插变量 |
| Layout | 30–50% 文本扩展、换行、CJK、RTL、双向数字/URL、字体 fallback |
| Search/sort | locale-aware 显示与可预测 server semantics；前后端排序不静默冲突 |
| Content review | 各 locale 有独立生成/审核/降级状态；fallback 明确，不把 renderer smoke 当生成能力 |
| Market/legal | 地址、电话、联系、Cookie/隐私/同意和 Claim 适用范围由市场策略驱动，不靠纯翻译 |
| URLs/SEO | 公开站 slug/hreflang/canonical/fallback 属 Phase 5 输出规范；管理路由不因显示语言破坏稳定 ID |

至少提供伪本地化、RTL 和缺失翻译测试环境；缺 key 应可观察且安全 fallback，不能向用户显示内部 key 或混用错误语言而不标识。

## 10. 浏览器与设备策略

支持矩阵必须由目标客户设备数据、安全更新、企业 IT 约束和关键 Web API 决定，记录 browser/version、支持等级、测试频率和降级。未批准前使用标准 Web 能力与渐进增强，不将某浏览器测试通过写成全支持，也不凭前端库默认列表拍板。

## 11. 验收证据

每次进入 Release Bundle 至少包含：自动 a11y/语义扫描、键盘全流程、至少一种主流屏幕阅读器/浏览器组合、200%/400% zoom、320px reflow、reduced motion、触摸目标、色彩/高对比、伪本地化/RTL、关键路由性能预算和 field/实验室来源。发现问题记录严重度、用户影响、Owner、例外和到期；不能只附 Lighthouse 总分。
