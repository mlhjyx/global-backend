# 术语、事实状态与责任词典

> 文档 ID：`GOV-FE-002`
> 层级：`L1 / Registry`
> 状态：`CURRENT`
> 事实 Owner：`OWN-DOC-GOV`
> 批准来源：Gate 2 推荐组合，产品负责人于 2026-07-20 明确批准
> 最后核验：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`

本文只定义跨文档可复用的名称、状态和责任语义，不替代 [产品边界](../product-scope.md)、[as-built 架构](../architecture/current.md)、[ADR](../adr/registry.md)、[当前状态](../status/current.md)或机器契约。任何新文档使用不同词义时，必须先登记冲突，不能在正文中自行改义。

## 1. 事实归属规则

一个事实集只能有一个规范归属：

| 事实集 | 唯一规范归属 | 其他文档允许做什么 |
|---|---|---|
| 仓库执行、worktree、PR 和验证规则 | `AGENTS.md`、`CONTRIBUTING.md` | 摘要并链接 |
| 产品面、系统边界和跨仓 ownership | [product-scope.md](../product-scope.md) | 引用，不复制承重边界 |
| 当前已实现架构 | [architecture/current.md](../architecture/current.md) | 引用代码或机器契约补证 |
| 承重决策 | [adr/registry.md](../adr/registry.md) | 用 Decision ID 引用 |
| 当前主线与完成度 | [status/current.md](../status/current.md) | 只写本能力局部状态和核验点 |
| 施工顺序 | [release-plan.md](../roadmap/release-plan.md) | 用 milestone ID 引用 |
| 文档、能力、对象、场景、冲突和追踪 ID | [governance/](README.md) 对应登记表 | 形成读者视图，不再建平行清单 |
| API | `packages/contracts/openapi/openapi.json` | 使用 operationId/路径引用，不手抄总数作长期真值 |
| Schema、RLS 和迁移 | Prisma schema 与已合并 migration | 文档解释业务含义，不复制可漂移结构 |
| 测试、真机和发布证明 | 对应测试、evidence bundle、Release Bundle | 摘要结论并指向精确证据 |

发生冲突时先按“主题 Owner”判断，不按文件更新时间或篇幅判断；无法判断则登记为 `OPEN_CONFLICT`。

## 2. 权威层

| 层级 | 含义 | 能否覆盖上层 |
|---|---|---|
| `L0` | 仓库执行和协作约束 | 只约束工作方式，不重写产品事实 |
| `L1` | 产品边界、as-built、ADR、状态和治理 Registry | 同层按事实主题分工，不能互相静默覆盖 |
| `L2` | 当前活 PRD、设计、契约说明、runbook | 不能覆盖 L1 或机器契约 |
| `L3` | 实施记录、测试、运行和评测证据 | 证明某次实现/验证，不自动升级产品承诺 |
| `L4` | 研究、方案和待批准提案 | 只能成为决策输入 |
| `L5` | 指南、模板和说明 | 面向任务重组，不成为承重真值 |
| `L6` | 兼容入口、dated proposal、superseded/history | 只保留 provenance |
| `EXTERNAL` | 竞品、OSS、外部官方资料和本地无版本来源 | 必须带版本/日期，不能直接成为内部真值 |

## 3. 事实状态

| 状态 | 精确定义 | 最低证据 |
|---|---|---|
| `AS_BUILT` | 当前 `main` 已实现该声明的精确范围 | main 代码或机器契约；涉及持久化时有 Schema/migration；测试强度与声明相称 |
| `APPROVED` | 产品方向、范围或原则已经产品负责人批准 | 可识别的 Gate/Decision 和批准记录；不表示已实现 |
| `APPROVED_NOT_BUILT` | 已批准，但缺少一个或多个实现/质量/部署轴 | 批准记录 + 明确缺口 |
| `PROPOSED` | 有方案或历史输入，尚未批准 | 来源、Owner、目标 Gate |
| `HYPOTHESIS` | 需要用户/数据验证的问题、价值或行为假设 | 验证方法、Owner、观测条件 |
| `FROZEN` | 保留现有能力和事实，不启动新增开发 | 冻结指令和维护边界 |
| `EXTERNAL_OWNED` | SoR、实现或产品 UI 由本仓外的 SaaS/系统拥有 | 边界来源；未知仓库不能补猜 |
| `DEFERRED` | 已知但明确后置，尚未进入当前 Gate | 后置条件或里程碑 |
| `UNKNOWN` | 扫描范围内无法证实 | 缺失输入和获取方式 |
| `REJECTED` | 已作出不采用决定 | 决策记录和原因 |

组合状态必须保留每个轴，例如 `AS_BUILT/FROZEN` 表示后端现有事实真实但新增开发冻结；不得缩写成“完成”。

## 4. 文档生命周期

| 状态 | 含义 | 更新规则 |
|---|---|---|
| `CURRENT` | 该主题当前规范入口 | Owner 变更事实时同步更新或建立替代关系 |
| `ACTIVE_INPUT` | 当前施工仍引用的活设计/方案 | 必须指向更高层真值；不能冒充 current status |
| `FROZEN_EVIDENCE` | 固定提交/日期的审计或 Gate 证据 | 不用新事实重写；用新记录补 delta |
| `DATED_PROPOSAL` | 某时点方案，尚未批准或已被后续选择超越 | 保留日期、版本和迁移去向 |
| `SUPERSEDED` | 已有明确替代载体 | 必须有 `superseded_by`；移动/归档另需授权 |
| `GUIDE` | 面向任务的使用说明 | 只链接规范事实；过期时修复或下线 |
| `EXTERNAL_REFERENCE` | 外部项目/官方资料快照 | 记录 URL、版本、日期、许可和可证明范围 |
| `LOCAL_UNCONTROLLED` | 无 Git/Owner/版本 provenance 的本地输入 | 只读；不得视为发布或设计真值 |
| `RETIRED` | 已不再支持且引用已清零 | 只有引用映射和授权完成后使用 |

`SUPERSEDED` 不等于“可以删除”。在 Phase 8 之前，本项目只登记迁移去向，不移动历史文件。

## 5. 决策与 Gate 状态

| 状态 | 含义 |
|---|---|
| `OPEN_DECISION` | 尚未批准，执行者不得补猜 |
| `RECOMMENDED` | 已比较方案并给出推荐，但不是批准 |
| `APPROVED_AT_GATE_N` | 产品负责人在明确 Gate 语句中批准 |
| `APPROVED_WITH_CONDITION` | 允许继续，但条件仍是后续交付硬门 |
| `REJECTED_AT_GATE_N` | 该方案不再作为当前目标 |
| `SUPERSEDED_DECISION` | 后续 Decision/ADR 已替代 |

计划批准不自动批准全部后续产品决定；Gate 通过也不自动授权下一 Gate 之后的施工。

## 6. 多轴交付状态

每项 Capability 必须分别记录以下轴，禁止只写“已完成”：

| 轴 | 允许状态 |
|---|---|
| 产品 | `UNDEFINED / HYPOTHESIS / PROPOSED / APPROVED / FROZEN / REJECTED` |
| UX | `NONE / FLOW_ONLY / SPEC_READY / DESIGNED / VALIDATED` |
| 前端 | `NONE / MOCK_PROTOTYPE / IN_PROGRESS / MERGED / DEPLOYED` |
| API/事件 | `NONE / DRAFT / EXPORTED / VERIFIED / EXTERNAL_OWNED` |
| 数据/工作流 | `NONE / PARTIAL / WIRED / VERIFIED / EXTERNAL_OWNED` |
| 质量 | `UNTESTED / UNIT / CONTRACT / E2E / REAL_SERVICE / RELEASE_EVIDENCE` |
| 用户可用性 | `DISABLED / INTERNAL_ONLY / PILOT / GA / UNKNOWN` |

最高质量标签只表示找到的最高证据，不表示低层证据自动完整；`DEPLOYED` 必须指明环境，不能由“本地能运行”推出。

## 7. 能力入口可见性

| 状态 | 使用条件 | 用户表达 |
|---|---|---|
| `AVAILABLE` | 已部署且用户有权限、套餐和前置配置 | 正常进入并显示真实状态 |
| `UNAVAILABLE_WITH_REASON` | 能力已提供，但当前用户因权限、套餐、地区或配置不可用 | 明确原因和下一步，不承诺日期 |
| `NOT_OFFERED` | 未批准、未部署、冻结且没有当前用户入口 | 不进入日常导航，但保留在产品地图和 Registry |

这是产品显示语义，不是客户端权限控制；最终 allowed actions 必须来自服务端合同。

## 8. 场景与证据状态

| 状态 | 含义 |
|---|---|
| `CATALOGED` | 场景已登记，但尚无可执行 Fixture/合同 |
| `CONTRACT_BACKED` | 有机器契约可验证预期状态 |
| `CODE_BACKED` | 当前 main 有实现和相称自动化测试 |
| `REAL_SERVICE_VERIFIED` | 在注明环境、日期和版本上完成真实服务验证 |
| `TARGET_NOT_RUNNABLE` | 目标体验存在，但依赖合同/实现未建，不得用于当前验收 |
| `BLOCKED` | 关键 Owner、合同、权限或数据权利缺失 |
| `FROZEN_MAP_ONLY` | 仅用于保持完整产品地图，不启动新实现 |
| `EXTERNAL_OWNED` | 必须由 SaaS/外部系统提供执行与证据 |

Fixture 必须使用合成企业、合成联系人和有明确使用权的资产；不得把生产 PII、客户文件、Readdy 输出或竞品内容直接纳入 Git。

## 9. 责任角色

“唯一 Owner”指每个事实集恰好有一个责任帽子；实际人员未指定时必须显式写 `UNASSIGNED`，不能让 AI 或“团队”成为模糊批准者。

| Owner ID | 责任帽子 | 当前指派 | 负责事实 | 不负责 |
|---|---|---|---|---|
| `OWN-PRODUCT` | 产品负责人 | `ASSIGNED：当前产品负责人` | 用户、问题、范围、IA、承诺、优先级、成功标准 | 技术/合规验收 |
| `OWN-DOC-GOV` | 文档治理 Owner | `UNASSIGNED`；Phase 3 由产品负责人批准 | Registry schema、唯一归属、迁移与链接完整性 | 各域事实内容 |
| `OWN-SITE-BE` | Site Builder 后端/契约 Owner | `ROLE_EXISTS_ASSIGNEE_UNRECORDED` | 本仓 Site API、Schema、Workflow、Renderer/Release 实现事实 | SaaS UI 与产品批准 |
| `OWN-TRUTH-BE` | 企业事实与知识后端 Owner | `ROLE_EXISTS_ASSIGNEE_UNRECORDED` | CompanyProfile、Offering、Claim、Evidence 和共享知识对象实现事实 | SaaS UI 与发布批准 |
| `OWN-BUYER-BE` | Buyer Intelligence 后端 Owner | `ROLE_EXISTS_ASSIGNEE_UNRECORDED` | 本仓发现、富集、资格、信号和 `LeadQualifiedPackage` 实现事实 | SaaS Opportunity 和新增冻结范围 |
| `OWN-SAAS-PLATFORM` | SaaS 平台/身份/控制面 Owner | `UNASSIGNED` | Workspace、Membership、Entitlement、跨域控制面和外部业务 SoR | 本仓后端实现 |
| `OWN-SAAS-FE` | 正式 SaaS 前端 Owner | `UNASSIGNED` | 正式前端仓库、CI、部署、客户端架构和接入 | 产品范围、后端真值 |
| `OWN-DESIGN` | 产品设计 Owner | `UNASSIGNED` | 旅程、IA 细化、交互、设计资产、内容、a11y | API 可行性和产品拍板 |
| `OWN-DATA-PRIVACY` | 数据与隐私 Owner | `UNASSIGNED` | 埋点、口径、保留、同意、个人数据和数据权利 | 商业套餐 |
| `OWN-QA-EVIDENCE` | QA/证据 Owner | `UNASSIGNED` | 场景、回归、E2E、真机和 Release evidence | 自行改写承诺 |
| `OWN-OPS` | 运营/客服 Owner | `UNASSIGNED` | 人工兜底、诊断、SLA、指南和反馈闭环 | 越权读取数据 |
| `OWN-SEC-COMMERCIAL` | 安全/合规/商业 Owner | `UNASSIGNED` | License、Secret、安全门、套餐、预算和高风险授权 | 替代产品/技术 Owner |

未指派责任帽子不阻止 Registry 建立，但会阻止相应能力进入 Dev-Ready、发布或实际前端施工。

## 10. 关键产品术语

| 术语 | 当前定义 | 禁止混写 |
|---|---|---|
| 统一 SaaS | 身份、Workspace、控制面和完整产品 UI 所在产品 | 不能把本仓 API 或 Astro 站当成第二套 SaaS |
| 独立站管理 | SaaS 一级产品区域，管理资料、站点、Build、版本、发布和后续诊断 | 不等于单次生成器或一个 `/site-builder` Mock 页面 |
| Astro 公开站 | 独立站管理产生并管理的版本化输出 | 不是 SaaS 主导航或管理前端 |
| `Site` | Workspace 下的站点业务对象 | 不等于一次 Build 或一次 Release |
| `SiteVersion` | 一次内容/规范版本 | 不等于已部署产物 |
| `SiteRelease` | 不可变构建产物单元 | 当前存在不等于用户可发布、选版或回滚 |
| 开发预览 | active READY Release 的受控预览输出 | 不等于公网生产发布、域名或 SLA |
| Publish | 经检查、授权后把 Release 切换为公开服务的业务动作 | 不能用 Build success 或 preview pointer 代替 |
| `BuildRun` | 有状态、可观察、可取消/恢复的生成任务 | 不等于 Site 总状态 |
| `Claim` | 可审核、带适用范围和生命周期的事实声明 | 不等于 AI 生成文案 |
| `Evidence` | 支撑 Claim 的来源、引用、时间、hash 和资产关联 | 不等于“模型说过”或不可审计链接 |
| `Asset` | 有权利、用途和生命周期的逻辑素材对象 | 不等于 presigned URL 或派生 variant |
| `LeadQualifiedPackage` | 本仓交给 SaaS 的不可变合格线索包 | 不等于 SaaS Opportunity/QGO/SAO |
| Capability Pack | 围绕一个用户结果的规范、设计、契约、场景、证据、指南和发布引用集合 | 不是复制所有事实的新巨型文档 |

## 11. 状态使用红线

- “完成”“已上线”“生产就绪”“全绿”“已审核”必须说明哪个轴、环境、日期、Owner 和证据。
- API 存在不能推导页面存在；页面存在不能推导接入真实；测试通过不能推导部署；本地部署不能推导生产可用。
- `SiteRelease=ready`、`Site.status=ready`、`BuildRun=succeeded` 和公开站在线是四个不同事实。
- `APPROVED` 只代表产品决定；实现仍必须写多轴状态。
- 历史 Word、研究、原型、竞品和 worktree 默认只能是 proposal/evidence/provenance，除非另有批准或已合并证据。

## 12. 变更协议

1. 新状态或术语先在本表登记 Owner、定义和迁移影响。
2. 变更产品边界或承重技术决定时，先走 PDR/ADR，再更新 Registry 引用。
3. 变更能力/对象/场景 ID 时不得复用旧 ID；被取代项保留并指向 successor。
4. 修正当前实现状态时，记录最后核验提交；不要重写冻结 Gate 包。
5. 删除或移动旧文档前，必须先在 [文档登记](document-register.md)完成引用映射并获得单独授权。
