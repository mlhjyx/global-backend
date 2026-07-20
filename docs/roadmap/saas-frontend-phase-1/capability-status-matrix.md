# Phase 1 产品能力多轴状态矩阵

> 文档 ID：AUD-FE-P1-003
> 状态：`COMPLETE_FOR_GATE_1`
> 核验基线：`main@c3f0cca80e228f08f35c89776f759748dac78ce2`
> 目的：把“产品想法、原型页面、后端实现、前端接入、用户可用”拆开，禁止再用一个“已完成”覆盖全部轴

## 1. 读表规则

- 产品：`APPROVED` 仅表示边界或能力已获权威文档/产品负责人确认；`PROPOSED` 表示 Word、研究或原型输入；`FROZEN` 表示保留维护、不新增施工。
- UX：`NONE` / `FLOW_ONLY` / `PROTOTYPE` / `SPEC_READY` / `DESIGNED`。
- 前端：`NONE` / `MOCK_PROTOTYPE` / `IN_PROGRESS` / `MERGED` / `DEPLOYED`。
- API：`NONE` / `DRAFT` / `EXPORTED` / `VERIFIED`。
- 后端：`NONE` / `PARTIAL` / `WIRED` / `VERIFIED` / `EXTERNAL_OWNED`。
- 质量：`UNTESTED` / `UNIT` / `CONTRACT` / `E2E` / `REAL_SERVICE`；这是当前找到的最高证据，不代表下面各级自动完备。
- 可用性：`DISABLED` / `INTERNAL_ONLY` / `PILOT` / `GA` / `UNKNOWN`。

“原型有页面”一律不等于 `MERGED`，“后端有 API”一律不等于 `PILOT`，“本地可构建”一律不等于 `DEPLOYED`。

## 2. 全 SaaS 产品面

| Capability ID | 产品域/用户结果 | 产品 | UX | 前端 | API | 后端 | 质量 | 可用性 | 事实判断与主要缺口 |
|---|---|---|---|---|---|---|---|---|---|
| `CAP-SHELL-001` | Workspace App Shell、导航与全局上下文 | `APPROVED` 边界 | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `EXTERNAL_OWNED` | `UNTESTED` | `UNKNOWN` | React Layout/Sidebar/TopBar 已有，但无 Workspace、Entitlement、服务端权限或部署证据；正式 IA 未批准 |
| `CAP-ID-001` | 注册、登录、会话与账户安全 | `APPROVED` 为 SaaS 所有 | `PROTOTYPE` | `MOCK_PROTOTYPE` | 仅旧 Spring API | 旧实现与目标边界冲突 | `UNTESTED` | `UNKNOWN` | 当前前端使用 localStorage + HMAC JWT；不得与 NestJS JWKS/Workspace 事实混写 |
| `CAP-ONB-001` | 首次目标/ICP/资料引导 | `PROPOSED` | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | 部分对象分散在两产品面 | `UNTESTED` | `UNKNOWN` | `/goal` 仅本地状态；跨目标、企业资料和建站 intake 的唯一旅程/对象 SoR 未定 |
| `CAP-TODAY-001` | 今日任务、异常和建议 | `PROPOSED` | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `NONE`/跨域聚合未定 | `UNTESTED` | `UNKNOWN` | Dashboard 与通知使用 Mock；优先级、权限、可解释性、恢复动作均未成契约 |
| `CAP-BUYER-001` | 多源发现、富集、资格和联系人证据 | `FROZEN` | `PROTOTYPE` | `MOCK_PROTOTYPE` | `EXPORTED` | `VERIFIED` | `REAL_SERVICE` | 后端维护态；前端 `UNKNOWN` | NestJS 买家智能链较完整且有真源验证，但新增开发已暂停；`/accounts` 未接真实 API |
| `CAP-INTENT-001` | 需求/时机信号与机会解释 | `FROZEN` | `PROTOTYPE` | `MOCK_PROTOTYPE` | `EXPORTED`/内部事件 | `VERIFIED` | `REAL_SERVICE` | 后端维护态 | TED/openFDA/web-watch 等后端已有；原型洞察/机会内容是 Mock，未证明同一事实源 |
| `CAP-CAMP-001` | 战役规划与执行管理 | `PROPOSED`，归 SaaS | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `EXTERNAL_OWNED` | `UNTESTED` | `UNKNOWN` | `/campaigns` 及任务/资源/指标/阶段页面存在，无真实工作流、权限、预算、恢复或归因链 |
| `CAP-CONTENT-001` | 内容规划、生成、审批与复用 | `PROPOSED`，归 SaaS | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `EXTERNAL_OWNED` | `UNTESTED` | `UNKNOWN` | 页面存在；Claim/Evidence 仅在 Site Builder 内部落地，不能推导全平台内容治理已实现 |
| `CAP-PUBLISH-001` | 多渠道发布、失败重试和日历 | `PROPOSED`，归 SaaS | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `EXTERNAL_OWNED` | `UNTESTED` | `UNKNOWN` | 原型声称 OAuth/重试/队列均无真实集成证据 |
| `CAP-ENGAGE-001` | 互动、收件箱、回复和升级 | `PROPOSED`，归 SaaS | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `EXTERNAL_OWNED` | `UNTESTED` | `UNKNOWN` | 页面不证明 Chatwoot/WhatsApp/邮件等接入、合法用途或个人数据边界 |
| `CAP-OPP-001` | Opportunity/QGO/SAO 和业务结果 | `APPROVED` 为 SaaS 所有 | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` 于本仓 | `EXTERNAL_OWNED` | `UNTESTED` | `UNKNOWN` | 后端明确止于 `LeadQualifiedPackage`；原型机会页不能反向扩张本仓边界 |
| `CAP-INSIGHT-001` | 运营洞察、异常、归因与建议 | `PROPOSED`，归 SaaS | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `EXTERNAL_OWNED` | `UNTESTED` | `UNKNOWN` | 图表与指标为 Mock；指标字典、口径、时区、权限和 drill-down 未定义 |
| `CAP-SITE-001` | 独立站管理一级产品区域 | `APPROVED` | `PROTOTYPE` | `MOCK_PROTOTYPE` | `EXPORTED` | `PARTIAL/VERIFIED` | `CONTRACT+REAL_SERVICE`（后端部分） | `INTERNAL_ONLY`（开发预览） | 产品层级已固定；SaaS 页面未接真实 API；公开站是该区域的版本化输出，不是第二个 SaaS 前端 |
| `CAP-SITE-002` | Intake、资料、素材和 KB | `APPROVED` 当前能力 | `FLOW_ONLY/PROTOTYPE` | `MOCK_PROTOTYPE` | `VERIFIED` | `VERIFIED` | `CONTRACT+REAL_SERVICE` | `INTERNAL_ONLY` | 后端链存在，缺正式页面、权限/状态/恢复和端到端验收 |
| `CAP-SITE-003` | 构建、进度、取消、成本与开发预览 | `APPROVED` 当前能力 | `FLOW_ONLY/PROTOTYPE` | `MOCK_PROTOTYPE` | `VERIFIED` | `VERIFIED` | `CONTRACT`，有历史 verify | `INTERNAL_ONLY` | Temporal/预算/preview 已落；质量循环跳过，生产 Release 和 SaaS 接入未落 |
| `CAP-SITE-004` | 生产发布、域名、SSL、回滚 | `APPROVED_NOT_BUILT`/部分待裁决 | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `PARTIAL`（R1-min 未并 main） | `UNTESTED` 于 main 闭环 | `DISABLED` | 原型不可当成发布能力；必须完成对象存储 Release、跨节点恢复/回收、unknown component 门及后续域名设计 |
| `CAP-SITE-005` | 询盘、表单、转化与站点分析 | `DEFERRED/PROPOSED` | `PROTOTYPE` | `MOCK_PROTOTYPE` | 仅 renderer 边界契约 | `NONE` | `CONTRACT`（禁用边界） | `DISABLED` | `disabled_until_m2`；无 receiver、同意记录、投递、分析或 SaaS inbox |
| `CAP-KNOW-001` | 企业知识与资料治理 | `PROPOSED` 平台域；Site Builder 子集已批 | `PROTOTYPE` | `MOCK_PROTOTYPE` | Site Builder KB status only | Site Builder 子集 `VERIFIED` | `REAL_SERVICE` 于子集 | `INTERNAL_ONLY` | 全平台知识库、来源、权限、版本与引用尚无统一对象/接口；不能用局部 KB 推导全局完成 |
| `CAP-COMP-001` | 市场竞品工作台 | `PROPOSED` | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `NONE` | `UNTESTED` | `UNKNOWN` | 页面和数据为原型；采集许可、证据新鲜度、对比口径与任务闭环未定 |
| `CAP-INTEG-001` | 集成账号、API token 与连接健康 | `PROPOSED` | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `EXTERNAL_OWNED` | `UNTESTED` | `UNKNOWN` | 原型展示多种连接和 token，但无 vault、OAuth、scope、轮换或 kill switch 证据 |
| `CAP-TEAM-001` | 团队、审批、角色和数据范围 | `PROPOSED` | `PROTOTYPE` | `MOCK_PROTOTYPE` | `NONE` | `EXTERNAL_OWNED` | `UNTESTED` | `UNKNOWN` | 缺 Workspace 角色、对象级动作、团队/个人数据属性和审批状态矩阵 |
| `CAP-SET-001` | 个人资料、密码和安全设置 | `PROPOSED` | `PROTOTYPE` | `IN_PROGRESS` 仅旧 API | 旧 Spring `EXPORTED` | 旧 Spring `PARTIAL` | `UNTESTED` | `UNKNOWN` | 是唯一实际调用本地 API 的业务页，但 identity SoR 和安全基线未批准 |
| `CAP-ADMIN-001` | 平台管理端用户管理 | `UNKNOWN` | `PROTOTYPE` | `MOCK_PROTOTYPE` | 旧 Spring API | 旧 Spring `PARTIAL` | `UNTESTED` | `UNKNOWN` | 独立 5 文件管理端存在；权限模型、审计、租户隔离和仓库 ownership 均未定义 |

## 3. 独立站管理页面能力拆分

原型的 `/site-builder` 把多种成熟度混在一个视觉页面中。正式文档必须至少拆成以下能力包，且每包有独立状态：

| 能力包 | main 后端事实 | 原型事实 | Gate 1 结论 |
|---|---|---|---|
| 站点总览 | list/detail + preview URL | 有站点卡、状态、指标 | 数据必须重接；指标不可继承 |
| 首次建站/资料完善 | intake + Profile 五组 | 有视觉入口，但非真实向导闭环 | 用户旅程、幂等与恢复待 Phase 2/5 |
| 素材与 KB | upload/commit/list/delete/status | 页面没有完整真实状态机 | 需要独立状态/错误/引用解除设计 |
| 风格与结构 | 两个真实 preset；10 个 renderer 组件 | 原型列四种风格及更多能力 | 枚举冲突；后续须由契约与产品共同裁决 |
| 构建与进度 | site/page/section、轮询、取消、成本 | 只模拟操作与反馈 | 需要长任务、部分成功、未知成本、取消竞态 UX |
| Claim/批准 | 内部 snapshot bridge | 原型没有严谨的批准链 | 角色、数据范围、审批入口是开放决策 |
| 多语种 | en/de-DE 生成；ar renderer smoke | 原型有更宽泛语言暗示 | 必须区分生成语言、仅渲染语言和目标语言 |
| 预览 | 本地开发 preview pointer | 有“预览”按钮 | 只能标 `INTERNAL_ONLY`，不能承诺生产访问 |
| 发布/域名 | main 未闭环 | 有发布、域名、SSL UI | 目标态输入，不得作为当前能力 |
| 询盘/分析/诊断/博客 | 无生产链 | 有统计、询盘、诊断等 Mock | 全部需单独立项和权利/隐私/指标设计 |

## 4. 当前总体判断

1. 我们不是“没有前端”，而是有一套覆盖很广、但缺版本 provenance、契约接入和质量证据的 SaaS 原型。
2. 我们也不是“Site Builder 已经完成”，而是后端地基与生成/开发预览链较深，SaaS 控制面、生产 Release、发布域名和访客转化链仍明显缺失。
3. 买家智能的后端真实度远高于其 SaaS 页面，但该产品面目前冻结；前端文档不能借此绕开冻结施工。
4. Campaign、触达、Conversation、Opportunity、归因和统一身份仍归 SaaS；本仓文档只能定义接缝，不能把 ownership 静默吸回后端。
5. Gate 2 之前最重要的不是再画更多页面，而是拍板用户/任务/对象/一级区域/权限，并选出少量端到端纵切能力作为下一阶段证据链。
