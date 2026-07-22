# 全产品交互语言与视觉语义

> 文档 ID：`DESIGN-FE-P9-001`
> 层级：`L2 / Normative design proposal`
> 状态：`DRAFT`
> 事实 Owner：`OWN-DESIGN`
> 关联：`GATE-FE-P9-000`
> 最后核验：2026-07-23

## 1. 设计目标

产品交互语言命名为 **Precision Global Operations / 精密全球运营**。它服务制造型企业的高频事实、任务、渠道和商机协作，优先级依次是：

1. 对象和 Workspace 不出错；
2. 状态、证据、风险和下一步可理解；
3. 密集数据可扫描、可比较、可批量处理；
4. 长任务、外部动作和失败可恢复；
5. 首次用户不被专家密度压垮；
6. 品牌表达不压过业务判断。

它不是服务器面板、创作者工具、聊天空白页或通用 KPI Dashboard。

## 2. 全局构图语法

统一结构为：

`稳定 Shell → 对象头 → 主任务区 → 按需 Inspector → 持久任务/事故落点`

| 区域 | 责任 | 禁止 |
|---|---|---|
| 稳定 Shell | Workspace、六项任务域、搜索、通知、任务、帮助、个人入口 | 供应商名作导航；三层以上常驻侧栏 |
| 对象头 | canonical identity、Owner、业务状态、allowed actions、更新时间 | 把任务状态或 Provider 状态冒充对象状态 |
| 主任务区 | 当前页面唯一主任务和一至两个支持任务 | 功能盘点式卡片海；多个同权主按钮 |
| Inspector | Evidence、关系、活动、影响、成本、帮助 | 固定挤压所有页面；Drawer 内继续叠 Drawer |
| 持久落点 | Task、Run、Incident、Approval、Receipt 详情 | 只用 Toast、Spinner 或临时 Modal 承载长任务 |

### 2.1 页面表面

| Pattern ID | 表面 | 适用任务 | 关键规则 |
|---|---|---|---|
| `PAT-P9-SURFACE-001` | Canvas | Campaign、Site、规则、内容编排 | 主对象明确；不无限自由拖放；高风险动作仍经审批/授权 |
| `PAT-P9-SURFACE-002` | Data Table | 买家、产品、任务、发布、Run | 三档密度、列管理、保存视图、键盘、批量范围可解释 |
| `PAT-P9-SURFACE-003` | Split View | Inbox、Lead、Evidence、内容审核 | 左队列、中主对象、右上下文；移动端改为连续深链 |
| `PAT-P9-SURFACE-004` | Object Workspace | Company、Offering、Site、Opportunity | 固定对象头；业务、运行、同步、质量状态分层 |
| `PAT-P9-SURFACE-005` | Inspector | Evidence、关系、活动、影响、成本 | 按需打开；关闭后焦点回到触发点；有永久深链 |
| `PAT-P9-SURFACE-006` | Decision Dialog | 批准、删除、发送、发布、回滚 | 只做短决策；显示对象、版本、范围、影响和不可逆边界 |

## 3. 平台级交互模式

### 3.1 Today 工作队列

Today 不以 KPI 卡开场，而以“为什么现在需要我处理”组织：

- 来源、优先级、SLA、Owner、影响对象；
- 待我处理、团队未分派、等待外部、异常恢复分组；
- 稍后处理、批量分派、保存视图和解释优先级；
- 指标只在帮助用户排序或判断影响时出现。

### 3.2 列表—详情和批量操作

- 查询范围全选与当前页全选必须分开；
- 批量动作先显示对象数、排除数、禁用原因和预计影响；
- 过滤、排序、列、密度和选中对象写入可恢复 URL/视图；
- 无权、过期、冲突和已变化对象在执行前重新验证；
- 高风险批量动作不使用乐观终态。

### 3.3 资料与知识引导

资料页围绕“用最省力的方式提供真实资料、确认系统理解、缺什么再补什么”组织，不建立固定制造业规格表或独立准备度系统：

- 首次只要求 current Intake/Profile 能表达的最少信息；每组可以保存、跳过并稍后继续；
- 用户可在“引导填写、上传文件/图片、导入网站/店铺”之间自由选择或组合；
- 通用五组 Profile 始终可用；行业问题按行业、目标市场、建站目标和已上传内容条件出现；
- 产品/服务信息继续由 Offering 与 attributes 承载，文件进入 Asset/KB，可信结论进入 Claim/Evidence；不预设 ProductFamily、Variant 或 TechnicalSpecification 对象；
- 模型抽取必须显示原文锚点、候选值和待确认状态；未知、不适用、稍后补充不能写成 `0` 或模型猜测值；
- `KbStatus.gaps`、completeness、解析状态和待审核事实可组合成缺口任务，但只是派生投影，不产生 Readiness 聚合或百分比分数；
- Today 只显示会阻塞当前目标或需要协作的资料任务；完整资料管理仍回到 Site Onboarding/资料与知识页。

行业元数据、动态问卷和导入映射若未来需要独立合同，必须另过对象/SoR/API Gate；设计稿不得先把它画成已经实现。

### 3.4 Evidence 核验

候选事实、来源原文和当前 canonical value 并排显示：

- 字段/文段锚点、来源时间和适用市场；
- Fact、Inference、Recommendation、Draft 明确分类；
- 冲突、过期、权利和个人数据状态；
- 批准只决定事实是否可用，不能同时授权发布或发送；
- 撤销必须展示下游影响和历史快照边界。

### 3.5 审核、批准、执行三分离

| 层 | 问题 | 结果 |
|---|---|---|
| Review | 内容/事实是否正确、完整、可用 | 候选被接受、退回或标记例外 |
| Approval | 业务 Owner 是否批准该版本和范围 | 版本/范围获得有限批准，带有效期 |
| Authorization/Execute | 此刻是否允许对外发布、发送、删除或计费 | 服务端 allowed action + 幂等执行 + Receipt |

提交者不自动成为批准者；批准过期、对象变化或受众变化后必须重新决策。

### 3.6 长任务与事故

Build、Import、Research、Media、Publish、Sync 使用统一模型：

`queued → running → partial/degraded → succeeded/failed/cancelled`

并显示：步骤、attempt、heartbeat、检查点、保留结果、estimate/reported/calculated/unknown cost、可取消截止点、稳定错误类别、correlation ID 和允许恢复动作。

`ACK_UNKNOWN`、`CANCELLING`、迟到成功与迟到失败必须是显式状态。用户刷新、跨页或跨设备后仍可通过 Run ID 找回。

### 3.7 渠道与互动

- 一个 Platform Account 可有发布、公开互动、私信、分析、媒体等多个 Capability Binding；
- 每个 Binding 单独显示 Provider、scope、健康、过期、Owner、最后成功和撤销影响；
- 公开评论/提及进入 Public Engagement；私密消息进入 Unified Inbox；
- 同一身份可关联，但两者回复框、SLA、权限和 outbound owner 不合并；
- 公开评论可以升级私聊，再由人工升级 Opportunity。

### 3.8 Inbox、会话上下文与外部交接

Inbox 同屏包含队列、会话和企业/Offering/Opportunity 投影上下文，止于接收、回复、分派和可追踪交接：

- 身份匹配置信、冲突和可逆归并；
- 原始消息、翻译和 AI 摘要 provenance；
- 内部备注与外部回复分离；
- AI 回复草稿需显示 Evidence、未知项和批准责任；
- 发送结果使用 queued/submitted/provider-confirmed/ACK unknown/failed Receipt；
- 分派到销售/合规/外部工程系统时记录目标、Owner、最小上下文、附件引用、handoff receipt 和 `queued / ACK unknown / confirmed / failed`；
- 只有 SaaS Opportunity 合同和 allowed actions 存在时才可显示“创建/关联商机”；当前稿保持 `TARGET_EXTERNAL/CONTRACT_BLOCKED`；
- QGO/SAO/Outcome 使用我方业务状态，不使用 Chatwoot、CRM、PLM 或 Provider 标签代替。

当前不新增 RFQ Lite 聚合。完整工程评审、PLM、CPQ、CAD 签核、报价和样品流程进入 `PARK / INTEGRATE`；未来获批后也只保留会话/商机所需的外部引用和交接回执，不复制外部系统内部状态机。

### 3.9 关系与影响分析

Company、Offering、Claim、Evidence、Asset、Site、Content、Conversation、Opportunity 建立可读关系视图，支持：

- 正向查看一个事实被哪些输出使用；
- 反向查看一个页面/内容由哪些事实和素材构成；
- 删除、撤销、过期、替换前预览影响；
- 生成 Task/Incident，而不是静默修改历史输出。

## 4. 状态语法

一个页面可以同时具有：

`Session + Workspace + Permission + Entitlement + Business + Operation + Sync + Freshness + Quality + Connectivity`

不得压成单一 Badge。示例：Site 可用、旧 Preview active、新 Build failed、德语 degraded、当前离线，是合法组合。

| 语义 | 表达规则 |
|---|---|
| Verified/Healthy | 绿色 + 文字 + 图标；只用于已验证或健康 |
| Needs review/Partial | 琥珀 + 范围说明 + 下一动作 |
| Dangerous/Failed | 红色 + 影响 + 恢复/阻止动作 |
| Unknown | 明确写未知和原因，不使用灰色 `0` |
| Stale | 显示 as-of、水位、影响和是否允许继续 |
| Denied | 说明可披露原因、申请路径和安全返回 |
| ACK unknown | 使用“正在确认”；查询/安全重放，不猜成功或失败 |

颜色永远不是唯一编码。

## 5. 视觉语义

### 5.1 基线气质

- 工程精度、全球清晰、商业可信；
- 矿物白/瓷白工作画布，深墨或海军蓝正文；
- 克制钴蓝只用于品牌和主动作，不兼任成功色；
- 绿色=验证/健康，琥珀=复核/部分成功，朱红=危险；
- 层级优先使用排版、间距、对齐和分隔线，再使用浅底、边框，最后才是阴影；
- 圆角以 4–8px 为主，胶囊只用于标签、筛选和状态；
- 正文 14–16px；数字使用 tabular numerals；ID/代码才用等宽字体；
- 动效只服务反馈、状态变化和上下文切换，支持 reduced motion。

具体字体、色值、间距、圆角和阴影在视觉方向选择前保持未冻结。

### 5.2 图像与图表

- 产品 UI 使用真实制造产品、工艺、材料细节或有来源的技术示意；
- 用户 Asset 与产品 UI Asset 分离；
- AI 生成图像登记模型、Prompt 边界、权利、人物/商标审查和人工批准；
- 图表显示单位、时间范围、水位、阈值、不确定性和定义；
- 所有图表提供摘要或表格替代。

### 5.3 明确禁止

- 宝塔式服务器术语、多重侧栏、终端/Docker/数据库暴露；
- 创作者市场式粉紫渐变和“连接成功”单状态；
- Readdy 式标题 + KPI 卡 + 表格的万能页面；
- 大面积玻璃拟态、glow、卡片套卡片和无意义 Hero；
- 聊天空白页作为整个产品入口；
- 在客户前台显示模型 Provider、Base URL、API Key 或 new-api 路由；
- 公开评论和私信共用无差别回复框。

## 6. 已选视觉基线

用户已确认五张页面足以作为当前视觉方向，不再生成三套替代方向。五张基线分别验证不同任务构图：

| 页面 | 构图模式 | 主要借鉴 |
|---|---|---|
| Today | 工作队列 + 运行中 + 活动 + 建议/风险 | 以行动和原因开场，指标退居辅助 |
| Site Editor | 结构树 + 真实预览 + 上下文设置 | 内容与设置贴近当前选区，版本/预览动作稳定 |
| Buyer Development | 保存视图 + 数据表 + 选中对象证据/动作 | 高密度扫描、列表—详情和证据解释 |
| Unified Inbox | 队列 + 会话 + 业务上下文 | 三栏协作、原文/草稿分离和明确回复动作 |
| AI Task Strategy | 任务档位矩阵 + 按任务策略 + 用量反馈 | 管理员理解能力/成本，不暴露 Provider 密钥 |

统一视觉语义为：瓷白工作面、深墨正文、克制品牌蓝、细边框、低阴影、稳定一级 Shell 与顶栏。绿色只表示验证/健康，琥珀表示复核/部分成功，红色表示危险；示例中的具体公司、评分、CNC 内容、RFQ 阶段、模型和用量数字一律不继承。

布局不是固定三栏：Today 可使用主区 + 辅助列，Site Editor 和 Inbox 可三栏，数据列表可列表 + 详情，简单设置可单栏/双栏。Inspector 只在需要上下文时出现。

正式 Figma、Token 和组件冻结前，还须完成 docs 全量对账、资料动态引导 Fixture、对象/SoR 校正、Figma file key 登记及至少一个相反复杂度页面验证。

## 7. 响应式、国际化与可访问性

- 设计/验证视口：1440、1280、1024、768、390、320；
- 支持 200%/400% zoom、软键盘、横屏、高对比、reduced motion；
- UI locale 与 Site content locale 分离；
- 验证中文、英文、德语长文本、RTL、时区、币种、SI/英制和长单位表达；
- 桌面支持密集工作台；移动端优先审批、分派、监控和快捷回复；
- 重型 Site/Content/规则编辑器在移动端提供摘要与“继续在桌面”，保留深链上下文；
- 所有拖拽、悬停和颜色动作都有键盘、按钮和文本替代；
- Dialog/Inspector 关闭后恢复焦点，后台刷新不抢焦点。

## 8. 设计评审门

每个受控页面/模式必须同时具备：

1. Page/Scenario/Actor/State/Product Status；
2. normal 与适用异常状态；
3. responsive、i18n、a11y 注释；
4. 真实制造业压力数据；
5. 对象、SoR、API、权限、Evidence、成本和 Guide 追踪；
6. 同视口参考对比和 finding 处置；
7. 目标用户任务结果。

Markdown、截图或 AI 自评不能把资产升级为 `DESIGNED` 或 `VALIDATED`。
