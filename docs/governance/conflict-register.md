# 冲突与开放决策登记

> 文档 ID：`GOV-FE-006`
> 层级：`L1 / Registry`
> 状态：`CURRENT`
> 事实 Owner：`OWN-DOC-GOV`
> 决策基线：Gate 2 推荐组合于 2026-07-20 获产品负责人批准
> 工程核验基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`

本表只保存 Conflict ID、当前状态、唯一 Owner、裁决位置和下一 Gate。完整证据与方案比较仍留在 Phase 1 [冲突证据](../roadmap/saas-frontend-phase-1/conflict-register.md)、[风险/开放决策](../roadmap/saas-frontend-phase-1/open-decisions-and-risks.md)和 Phase 2 [IA 决策包](../roadmap/saas-frontend-phase-2/ia-conflict-and-decision-register.md)，不在这里复制。

## 1. 状态

| 状态 | 含义 |
|---|---|
| `RESOLVED` | 矛盾已由明确权威/Decision 关闭，后续文档只引用裁决 |
| `RESOLVED_WITH_REMEDIATION` | 事实/边界已裁决，但旧实现、文档或安全处置仍需独立收口 |
| `MITIGATED` | 当前有防误读护栏，根因仍在后续 Gate |
| `OPEN_DECISION` | 需要产品/设计/技术/合规 Owner 拍板 |
| `CONTRACT_BLOCKED` | 产品方向可继续，但缺机器合同，不能进入 Dev-Ready/用户承诺 |
| `INPUT_BLOCKED` | 缺仓库、Owner、设计源、数据或外部输入 |
| `PARKED` | 已知但属于后置阶段或冻结产品面 |

## 2. Gate 2 已批准决议

| Decision ID | 批准内容 | 状态 | Decision Owner | 唯一回写位置 |
|---|---|---|---|---|
| `DEC-FE-P2-001` | 首批目标客户为 B2B 制造、工贸一体、传统出口企业 | `APPROVED_AT_GATE_2` | `OWN-PRODUCT` | [能力登记](capability-register.md) |
| `DEC-FE-P2-002` | 海外增长/外贸运营为默认日常操作者 | `APPROVED_AT_GATE_2` | `OWN-PRODUCT` | capability/scenario actor mapping |
| `DEC-FE-P2-003` | 一级 IA 采用“今日/客户开发/独立站管理/增长执行/互动与商机/洞察” | `APPROVED_AT_GATE_2` | `OWN-PRODUCT` | capability area mapping；Phase 4 写正式 IA |
| `DEC-FE-P2-004` | 首个纵切为资料与信任→Build/取消/恢复→可信开发预览 | `APPROVED_AT_GATE_2` | `OWN-PRODUCT` | Site child capability + traceability |
| `DEC-FE-P2-005` | Claim 必须 fail-closed；优先自助审核合同，否则受控运营兜底且显式阻塞 | `APPROVED_WITH_CONDITION` | `OWN-PRODUCT` | `CAP-SITE-CLAIM-001` + Scenario 009/010 |
| `DEC-FE-P2-006` | 保持 Company/Buyer/Site 与 SaaS 对象 ownership；旧 Spring 不改变边界 | `APPROVED_AT_GATE_2` | `OWN-PRODUCT` | [核心对象登记](core-object-register.md) |
| `DEC-FE-P2-007` | 首批用户可见承诺止于可信开发预览 | `APPROVED_AT_GATE_2` | `OWN-PRODUCT` | capability register；Publish 等后置 |
| `DEC-FE-P2-008` | `MET-SITE-001..014` 与反指标方向获批；目标值待基线 | `APPROVED_WITH_CONDITION` | `OWN-PRODUCT` | Phase 4 analytics contract；数据/隐私 Owner 待指派 |
| `DEC-FE-P2-009` | 正式前端仓库/Owner/设计源未确定时继续作为 blocker | `OPEN_DECISION` | `OWN-PRODUCT` | §5 `BLK-FE-001`、`BLK-FE-002` |

## 3. Phase 1 冲突状态迁移

| Conflict ID | 主题 | 当前状态 | 唯一 Owner | 裁决或下一动作 |
|---|---|---|---|---|
| `CON-FE-001` | `/global/frontend` README 称空但实际有源码 | `RESOLVED` | `OWN-SAAS-FE` | 定义为 `LOCAL_UNCONTROLLED` Mock 原型；不再用 README 判断空/非空 |
| `CON-FE-002` | 本地前端无 Git provenance，却写阶段完成 | `INPUT_BLOCKED` | `OWN-SAAS-FE` | 正式 repo/remote/CI/deploy 未提供；原型不得升级为发布真值 |
| `CON-FE-003` | 旧 Spring identity 与 JWKS/Workspace 边界冲突 | `RESOLVED_WITH_REMEDIATION` | `OWN-SAAS-PLATFORM` | product scope 已裁决 SaaS identity；旧服务隔离/安全处置另立任务 |
| `CON-FE-004` | Mock 页面被称为“完成” | `RESOLVED` | `OWN-DOC-GOV` | 统一使用多轴状态，页面数量不再作为交付状态 |
| `CON-FE-005` | 多套一级导航 | `RESOLVED` | `OWN-PRODUCT` | `DEC-FE-P2-003` 六项 IA |
| `CON-FE-006` | Word Next.js 与本地 Vite/React 技术栈冲突 | `OPEN_DECISION` | `OWN-SAAS-FE` | 正式 repo、部署、团队与迁移证据出现后再做技术方案 |
| `CON-FE-007` | 主工作区用户删除/未跟踪资料与分支基线不同 | `MITIGATED` | `OWN-DOC-GOV` | 主工作区现场不恢复、不修改；文档分支只登记 provenance |
| `CON-FE-008` | `CLAUDE.md` 与 `AGENTS.md` 当前真值冲突 | `RESOLVED` | `OWN-SITE-BE` | `AGENTS.md` 是执行入口，CLAUDE 仅兼容历史 |
| `CON-FE-009` | 独立站管理被原型放在 secondary | `RESOLVED` | `OWN-PRODUCT` | 一级产品区域；公开站是输出 |
| `CON-FE-010` | 旧 Spring 默认秘密/管理员种子/JWT fallback 风险 | `OPEN_DECISION` 安全处置 | `OWN-SEC-COMMERCIAL` | 不探测、不复制；由有效 Owner 轮换/封存并审计历史 |
| `CON-FE-011` | 原型只接旧 API，未接本仓 OpenAPI | `RESOLVED` 事实 / `INPUT_BLOCKED` 实施 | `OWN-SAAS-FE` | 机器 OpenAPI 是合同真值；正式前端未定位前不施工 |
| `CON-FE-012` | architecture 手写 `40 paths` 与机器 OpenAPI 漂移 | `OPEN_DECISION` 文档整改 | `OWN-SITE-BE` | Phase 8 删除/生成数字；当前一律机器解析，不修改权威文档 |
| `CON-FE-013` | `INTEGRATION.md` 的 R3-B1 范围与当前 R3-B2/M1-d 合同漂移 | `OPEN_DECISION` 文档整改 | `OWN-SITE-BE` | Phase 4/5 按 operationId/生成类型写接入；当前以 OpenAPI+代码为真 |
| `CON-FE-014` | 原型展示发布/域名/分析/询盘等超范围承诺 | `RESOLVED` | `OWN-PRODUCT` | `DEC-FE-P2-007`；对应 Capability 保持后置状态 |
| `CON-FE-015` | 开发预览与生产 Release/Publish 混写 | `RESOLVED_WITH_REMEDIATION` | `OWN-PRODUCT` | R1-min substrate 已合入；Preview/Release/Publish/Domain 术语仍严格分层 |
| `CON-FE-016` | unknown component 静默缺内容 | `RESOLVED` 于 R1-min promotion gate | `OWN-SITE-BE` | Release 预检 fail-closed；继续由 Scenario 017 防回归 |
| `CON-FE-017` | SiteSpec 仅 TypeScript cast、运行时 validator 未完成 | `CONTRACT_BLOCKED` | `OWN-SITE-BE` | Release 预检不等于通用 runtime schema；Phase 5 前需明确合同/版本门 |
| `CON-FE-018` | 文档目标有 quality loop，当前仍 `skipped_m1f` | `OPEN_DECISION` | `OWN-SITE-BE` | UI 必须显示 skipped/degraded；M1-f 另 Gate，不以 Build success 覆盖 |
| `CON-FE-019` | 宽泛多语种 vs en/de-DE 生成范围 | `RESOLVED` 当前承诺 / `PARKED` 扩展 | `OWN-PRODUCT` | 当前选择器只消费服务端 capability；新语言需独立质量/运营证据 |
| `CON-FE-020` | 本地流程图取消独立 QA 与仓库证据门冲突 | `OPEN_DECISION` | `OWN-QA-EVIDENCE` | 可优化岗位交接，不得取消独立验证责任；Phase 4 定规范 |
| `CON-FE-021` | 活文档混合多个时间点 | `MITIGATED` | `OWN-DOC-GOV` | Registry 指明唯一主题 Owner；具体 truth-sync/banner 在 Phase 8 |
| `CON-FE-022` | Readdy/模板 provenance、License 和用途未知 | `INPUT_BLOCKED` | `OWN-SEC-COMMERCIAL` | 继续 `VISUAL_REFERENCE_ONLY`；Phase 7 逐资产决策 |
| `CON-FE-023` | 历史 worktree 被误认 main 或误清理 | `MITIGATED` | `OWN-SITE-BE` | 只认 main；沿 worktree runbook/Phase 1 provenance，清理需另授权 |
| `CON-FE-024` | Phase 1 冻结基线与 #157 新 main 混写 | `RESOLVED` | `OWN-DOC-GOV` | Phase 1 保持 c3f0cca；Phase 2/3 以 676c6cd 建 delta/current Registry |

## 4. Phase 2 IA 冲突状态迁移

| Conflict ID | 主题 | 当前状态 | 唯一 Owner | 裁决或下一动作 |
|---|---|---|---|---|
| `CON-FE-P2-001` | 一级导航数量与命名 | `RESOLVED` | `OWN-PRODUCT` | `DEC-FE-P2-003` |
| `CON-FE-P2-002` | 独立站管理层级 | `RESOLVED` | `OWN-PRODUCT` | 一级区域；公开站为输出 |
| `CON-FE-P2-003` | Site 内部 8 Tab 与对象/任务结构冲突 | `RESOLVED` 原则 | `OWN-PRODUCT` | 按概览/资料与信任/生成/版本与发布等分区；Phase 4/5 细化 |
| `CON-FE-P2-004` | 企业知识独立入口 vs 共享事实底座 | `RESOLVED` | `OWN-PRODUCT` | Company/Offering/Claim/Evidence/Asset 唯一底座，跨域深链 |
| `CON-FE-P2-005` | 首次承诺终点 | `RESOLVED` | `OWN-PRODUCT` | 可信开发预览 |
| `CON-FE-P2-006` | SiteRelease 是否等于 Publish | `RESOLVED` | `OWN-PRODUCT` | Build/Version/Release/Preview/Publish/Domain 分层 |
| `CON-FE-P2-007` | Site、Build、Release、Public service 状态混写 | `RESOLVED` 原则 / 细节待 Phase 4/5 | `OWN-PRODUCT` | 四层状态分离；Schema/DTO 精确差异仍需 truth-sync |
| `CON-FE-P2-008` | 原型风格/语言范围超出合同 | `RESOLVED` 当前承诺 | `OWN-PRODUCT` | 只展示服务端允许枚举；扩展另 Gate |
| `CON-FE-P2-009` | Claim 审批入口缺失 | `CONTRACT_BLOCKED` | `OWN-TRUTH-BE` | `DEC-FE-P2-005`；自助合同优先，运营兜底需审计 |
| `CON-FE-P2-010` | 首批目标用户过宽 | `RESOLVED` | `OWN-PRODUCT` | `DEC-FE-P2-001` |
| `CON-FE-P2-011` | 日常操作者不明确 | `RESOLVED` | `OWN-PRODUCT` | `DEC-FE-P2-002` |
| `CON-FE-P2-012` | Today 是否拥有对象 | `RESOLVED` IA 原则 | `OWN-PRODUCT` | 只做读模型/深链，不拥有业务对象 |
| `CON-FE-P2-013` | 常驻 AI 是否能绕过结构化对象/权限 | `OPEN_DECISION` | `OWN-PRODUCT` | `DEC-FE-P4-006` 推荐 Global AI 只表达/解释并落结构化对象；等待 Gate 4 |
| `CON-FE-P2-014` | Workspace 权限与数据范围合同缺失 | `CONTRACT_BLOCKED` | `OWN-SAAS-PLATFORM` | [权限候选](../frontend/06-permissions-and-data-visibility.md)已定义角色×对象×动作×社会属性；服务端合同仍缺 |
| `CON-FE-P2-015` | 管理员是否默认读取个人工作数据 | `OPEN_DECISION` | `OWN-DATA-PRIVACY` | `DEC-FE-P4-004` 推荐“不自动可读”，需 Gate 4 和后续政策/审计合同 |
| `CON-FE-P2-016` | Buyer Intelligence 冻结但产品地图需保留 | `RESOLVED` | `OWN-PRODUCT` | IA 保留；日常可见性由 capability/entitlement 决定，不恢复施工 |
| `CON-FE-P2-017` | Campaign/Conversation/Opportunity SoR 与旧原型冲突 | `RESOLVED` 边界 / `INPUT_BLOCKED` 实现 | `OWN-SAAS-PLATFORM` | 归 SaaS；正式 repo/Owner 仍缺 |
| `CON-FE-P2-018` | Inquiry 原始接收与 SaaS 投影 ownership | `OPEN_DECISION` | `OWN-PRODUCT` | M2 前 ADR/PDR + privacy/retention contract |
| `CON-FE-P2-019` | 成功定义被 Build success/Mock 数字替代 | `RESOLVED` 方向 / `INPUT_BLOCKED` 数据 | `OWN-PRODUCT` | 指标+反指标获批；baseline/event/privacy Owner 未定 |
| `CON-FE-P2-020` | 正式前端仓库未知 | `INPUT_BLOCKED` | `OWN-SAAS-FE` | Gate 4/实际施工前必须指定 repo/remote/CI/deploy |
| `CON-FE-P2-021` | 设计事实源未知 | `INPUT_BLOCKED` | `OWN-DESIGN` | Gate 4/实际设计前指定设计 Owner、工具、资产版本和权利 |
| `CON-FE-P2-022` | frozen/deferred/unavailable 的 UI 表达 | `OPEN_DECISION` | `OWN-SAAS-PLATFORM` | Gate 4 候选继续采用三态并要求服务端 manifest；等待 `DEC-FE-P4-002/003` |

## 5. 当前硬 blocker

| Blocker ID | 缺失输入/决定 | Accountable Owner | 最迟 Gate | 阻止范围 | 安全默认 |
|---|---|---|---|---|---|
| `BLK-FE-001` | 正式 SaaS 前端 repo、remote、CI、deploy 与实际 Owner | `OWN-SAAS-FE` | Phase 5 技术方案/任何前端施工前 | 正式客户端架构、实现和发布 | `/global/frontend` 只读 Mock 原型 |
| `BLK-FE-002` | 设计 Owner、设计事实源、Token/组件/资产版本与权利 | `OWN-DESIGN` | Phase 5 视觉施工/设计定稿前 | 设计定稿、视觉回归、组件复用 | 不把代码截图/Readdy 当规范 |
| `BLK-FE-003` | SaaS Workspace/Membership/Role/Entitlement/allowed actions 合同 | `OWN-SAAS-PLATFORM` | Gate 5 | Shell、权限、入口可见性和发布授权 | 服务端 fail-closed，前端不自建角色表 |
| `BLK-FE-004` | Claim public review/impact contract 或正式运营兜底 SOP | `OWN-TRUTH-BE` | Gate 5 | 首个纵切事实 Gate | 自动批准禁止；显式阻塞 |
| `BLK-FE-005` | 指标事件、基线、隐私/保留和实际 Data Owner | `OWN-DATA-PRIVACY` | Gate 5/实际 tracking 前 | KPI 验收、tracking 和发布学习 | 不引入 tracking SDK，不用 Mock 数字 |
| `BLK-FE-006` | QA、运营、安全/商业实际责任人 | `OWN-PRODUCT` | Gate 5/相应 Release Gate | 独立证据、人工恢复、License/套餐和 Release Gate | 责任帽子保持 `UNASSIGNED`，AI 不代签 |
| `BLK-FE-007` | Publish/Domain/Rollback/Inquiry 的对象、合同、infra 和合规 | `OWN-PRODUCT` | 各后续 Capability Gate | 公网发布与访客转化 | 不纳入首个用户承诺 |

## 6. Gate 4 推荐决策

Phase 4 已形成以下全局规范候选；状态为 `RECOMMENDED`，收到产品负责人明确 Gate 4 批准前不改为已决：

| Decision ID | 主题 | 当前状态 | 唯一 Owner | 候选规范 |
|---|---|---|---|---|
| `DEC-FE-P4-001` | 统一体验原则 | `RECOMMENDED` | `OWN-PRODUCT` | [体验原则](../frontend/01-product-experience-principles.md) |
| `DEC-FE-P4-002` | 六项 IA 正式迁入全局规范、事实对象为横切上下文 | `RECOMMENDED` | `OWN-PRODUCT` | [IA](../frontend/02-information-architecture.md) + [Shell](../frontend/05-navigation-and-workspace-shell.md) |
| `DEC-FE-P4-003` | capability/entitlement/authorization/data scope/Approval/execution auth 分层 | `RECOMMENDED` | `OWN-SAAS-PLATFORM` | [权限](../frontend/06-permissions-and-data-visibility.md) |
| `DEC-FE-P4-004` | 数据社会属性；管理员不默认读取个人工作数据 | `RECOMMENDED` | `OWN-DATA-PRIVACY` | [权限 §2–3](../frontend/06-permissions-and-data-visibility.md#2-数据社会属性) |
| `DEC-FE-P4-005` | 全局状态/错误/长任务/恢复模式 | `RECOMMENDED` | `OWN-DESIGN` | [状态与恢复](../frontend/07-state-error-degradation-and-recovery.md) |
| `DEC-FE-P4-006` | AI/Evidence/Approval/执行授权控制链 | `RECOMMENDED` | `OWN-PRODUCT` | [AI 与人工控制](../frontend/08-ai-approval-evidence-and-human-control.md) |
| `DEC-FE-P4-007` | Semantic Token、组件合同、设计资产/Copy ID 治理 | `RECOMMENDED` | `OWN-DESIGN` | [设计系统](../frontend/09-design-system-and-content-guidelines.md) + [设计登记](../design/README.md) |
| `DEC-FE-P4-008` | WCAG 2.2 AA、响应式/i18n/性能进入发布门 | `RECOMMENDED` | `OWN-DESIGN` | [a11y/性能/i18n](../frontend/10-responsive-accessibility-and-performance.md) |
| `DEC-FE-P4-009` | analytics 分层、隐私门和反指标 | `RECOMMENDED` | `OWN-DATA-PRIVACY` | [分析/测试](../frontend/12-analytics-testing-and-release-evidence.md) |
| `DEC-FE-P4-010` | Release Bundle 与发布后学习 | `RECOMMENDED` | `OWN-QA-EVIDENCE` | [发布证据](../frontend/12-analytics-testing-and-release-evidence.md#7-release-bundle-schema) |
| `DEC-FE-P4-011` | 模块复用全局模式，例外需登记 | `RECOMMENDED` | `OWN-DOC-GOV` | [范围与例外](../frontend/00-scope-authority-and-status.md#6-例外流程) |

详细取舍、非含义和批准语句见 [Gate 4 决策包](../frontend/13-open-decisions.md)。

## 7. 关闭冲突的证据要求

1. 产品冲突：Decision/PDR、真实批准人、范围和被放弃方案。
2. 技术冲突：ADR 或机器合同、main 实现和相称测试。
3. 文档冲突：唯一主题 Owner、successor、引用映射和最后核验提交。
4. 权利/安全冲突：真实责任 Owner、适用条款/License、威胁/隐私评审和退出方案。
5. 可用性冲突：正式前端入口、部署环境、标准场景与 Release evidence。

执行者不能因为“推荐合理”自行把 `OPEN_DECISION` 改成 `RESOLVED`。Gate 3 已通过；Phase 4 的 `DEC-FE-P4-*` 仍需产品负责人明确批准，Phase 5–8 仍需逐 Gate 授权。
