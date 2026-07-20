# 产品能力登记

> 文档 ID：`GOV-FE-003`
> 层级：`L1 / Registry`
> 状态：`CURRENT`
> 事实 Owner：`OWN-PRODUCT`
> 产品批准来源：Gate 2 推荐组合；全局前端来源：Gate 4；Phase 5 Site UX 待 Gate 5（2026-07-20）
> 工程核验基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`

本表是 Capability ID、用户结果和多轴状态的唯一登记。Phase 1 [能力状态矩阵](../roadmap/saas-frontend-phase-1/capability-status-matrix.md)保留审计时点，Phase 2 [页面与能力目录](../roadmap/saas-frontend-phase-2/page-and-capability-catalog.md)保留批准论证；后续前端规范和 Capability Pack 只能引用本表 ID。

## 1. 读表规则

- `产品` 只表示范围/方向是否批准；不代表 UX、前端、API、数据、质量或部署完成。
- `UX/前端`、`API/数据`、`质量/可用性` 各自独立，状态语义见 [词典](terminology-and-status.md#6-多轴交付状态)。
- `Accountable Owner` 是该 Capability 的唯一责任帽子；实现事实仍由追踪矩阵中的代码/契约 Owner 签发。
- `正式能力包` 是当前或未来规范归属；文档轴的 `SPEC_READY` 不自动升级前端、质量或可用性轴。
- 可见性由服务端 capability/entitlement 决定；本表不是客户端 feature flag。

## 2. 全 SaaS 能力地图

| Capability ID | 用户结果 / 产品区域 | 产品 | UX / 前端 | API / 数据与工作流 | 质量 / 可用性 | Accountable Owner | 正式能力包 |
|---|---|---|---|---|---|---|---|
| `CAP-SHELL-001` | 在正确 Workspace 中导航、搜索和恢复上下文 / 公共 Shell | `APPROVED` IA 原则 | `PROTOTYPE / MOCK_PROTOTYPE` | `EXTERNAL_OWNED` | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | [Gate 4 当前全局规范](../frontend/README.md) |
| `CAP-ID-001` | 安全注册、登录、会话和账户恢复 / Shell | `APPROVED` 为 SaaS 所有 | `PROTOTYPE / MOCK_PROTOTYPE` | 旧 Spring 与目标冲突；正式 `EXTERNAL_OWNED` | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | [Gate 4 当前全局规范](../frontend/README.md) |
| `CAP-ONB-001` | 首次建立 Workspace、企业草案和目标 / Shell+企业 | `PROPOSED`；Site intake 子集已建 | `PROTOTYPE / MOCK_PROTOTYPE` | 跨域合同未定 | `UNTESTED / UNKNOWN` | `OWN-PRODUCT` | [Gate 4 当前全局规范](../frontend/README.md) + [Site intake 规格](../frontend/modules/independent-site-management/journeys-and-page-spec.md) |
| `CAP-TODAY-001` | 看见今天最重要的任务、审批、异常和机会 / 今日 | `APPROVED` IA 原则 | `PROTOTYPE / MOCK_PROTOTYPE` | 跨域读模型 `NONE/EXTERNAL_OWNED` | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | [Gate 4 当前全局规范](../frontend/README.md) |
| `CAP-BUYER-001` | 发现、富集和资格化可解释目标客户 / 客户开发 | `FROZEN` | `PROTOTYPE / MOCK_PROTOTYPE` | `EXPORTED / VERIFIED` | `REAL_SERVICE / 后端维护态` | `OWN-BUYER-BE` | `FUTURE_PHASE_6_MAP_ONLY` |
| `CAP-INTENT-001` | 理解需求、时机和为什么现在 / 客户开发 | `FROZEN` | `PROTOTYPE / MOCK_PROTOTYPE` | `EXPORTED / VERIFIED` | `REAL_SERVICE / 后端维护态` | `OWN-BUYER-BE` | `FUTURE_PHASE_6_MAP_ONLY` |
| `CAP-CAMP-001` | 把目标、受众、内容、渠道和预算组织为增长计划 / 增长执行 | `PROPOSED/EXTERNAL_OWNED` | `PROTOTYPE / MOCK_PROTOTYPE` | `NONE / EXTERNAL_OWNED` | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | `FUTURE_PHASE_6` |
| `CAP-CONTENT-001` | 基于批准事实生成、审核和复用内容 / 增长执行 | `PROPOSED/EXTERNAL_OWNED` | `PROTOTYPE / MOCK_PROTOTYPE` | `NONE`；Site 内部 Claim 不能替代平台合同 | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | `FUTURE_PHASE_6` |
| `CAP-PUBLISH-001` | 受控发布多渠道内容并恢复部分失败 / 增长执行 | `PROPOSED/EXTERNAL_OWNED` | `PROTOTYPE / MOCK_PROTOTYPE` | `NONE` | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | `FUTURE_PHASE_6` |
| `CAP-ENGAGE-001` | 聚合互动、回复和升级 / 互动与商机 | `PROPOSED/EXTERNAL_OWNED` | `PROTOTYPE / MOCK_PROTOTYPE` | `NONE / EXTERNAL_OWNED` | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | `FUTURE_PHASE_6` |
| `CAP-OPP-001` | 把互动推进为 QGO/SAO/Outcome / 互动与商机 | `APPROVED` 为 SaaS 所有 | `PROTOTYPE / MOCK_PROTOTYPE` | 本仓 `NONE`；SaaS `EXTERNAL_OWNED` | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | `FUTURE_PHASE_6` |
| `CAP-INSIGHT-001` | 解释质量、成本、归因和下一步 / 洞察 | `PROPOSED/EXTERNAL_OWNED` | `PROTOTYPE / MOCK_PROTOTYPE` | 平台读模型 `NONE`；Site cost 子集已建 | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | `FUTURE_PHASE_6` |
| `CAP-SITE-001` | 在统一 SaaS 中持续管理海外独立站 / 独立站管理 | `APPROVED` 一级区域 | UX `SPEC_READY`；正式 FE `NONE/MOCK_PROTOTYPE`；限定词 `SPEC_READY_WITH_BLOCKERS` | 本仓子域部分 `VERIFIED` | 后端 `CONTRACT+REAL_SERVICE`；用户 `INTERNAL_ONLY` | `OWN-PRODUCT` | [Phase 5 Capability Pack](../frontend/modules/independent-site-management/README.md) |
| `CAP-SITE-002` | 完成 intake、资料、素材、知识与事实准备 / 独立站管理 | `APPROVED` 首个纵切 | UX `SPEC_READY`；正式 FE `NONE`；限定词 `SPEC_READY_WITH_BLOCKERS` | intake/profile/asset/KB `VERIFIED`；Site Claim contract 缺 | `CONTRACT+REAL_SERVICE / INTERNAL_ONLY` | `OWN-PRODUCT` | [Phase 5 Capability Pack](../frontend/modules/independent-site-management/README.md) |
| `CAP-SITE-003` | 启动 Build、观察/取消/恢复并打开可信开发预览 / 独立站管理 | `APPROVED` 首个纵切 | UX `SPEC_READY`；正式 FE `NONE`；限定词 `SPEC_READY_WITH_BLOCKERS` | Build/cancel/status + internal Release/preview `VERIFIED` | `CONTRACT` + 历史真机；`INTERNAL_ONLY` | `OWN-PRODUCT` | [Phase 5 Capability Pack](../frontend/modules/independent-site-management/README.md) |
| `CAP-SITE-004` | 管理 Release、公开发布、域名、SSL 和回滚 / 独立站管理 | `APPROVED_NOT_BUILT` | `TARGET_SPECIFIED_NOT_RUNNABLE`；正式 FE `NONE` | internal immutable Release `AS_BUILT`；public management/publish/domain `NONE` | public chain `UNTESTED / DISABLED` | `OWN-PRODUCT` | [Phase 5 target lane](../frontend/modules/independent-site-management/journeys-and-page-spec.md#4-后置页面摘要) |
| `CAP-SITE-005` | 接收询盘并理解站点转化 / 独立站管理→互动 | `DEFERRED/PROPOSED` | `TARGET_SPECIFIED_NOT_RUNNABLE`；正式 FE `NONE` | receiver `NONE`；Inquiry 边界禁用 | `CONTRACT` 禁用边界 / `DISABLED` | `OWN-PRODUCT` | [Phase 5 target lane](../frontend/modules/independent-site-management/public-site-output-spec.md) |
| `CAP-KNOW-001` | 跨 Site/Content/Campaign 治理企业知识与资料 | `APPROVED` 共享底座原则；全平台能力未建 | `PROTOTYPE / MOCK_PROTOTYPE` | Site KB 子集 `VERIFIED`；平台合同 `NONE` | Site 子集 `REAL_SERVICE / INTERNAL_ONLY` | `OWN-PRODUCT` | [Gate 4 当前全局规范](../frontend/README.md) + `FUTURE_PHASE_6` |
| `CAP-COMP-001` | 维护可解释的市场/竞品观察 | `PROPOSED` | `PROTOTYPE / MOCK_PROTOTYPE` | `NONE` | `UNTESTED / UNKNOWN` | `OWN-PRODUCT` | `FUTURE_PHASE_6` |
| `CAP-INTEG-001` | 授权、诊断和退出外部连接 | `PROPOSED/EXTERNAL_OWNED` | `PROTOTYPE / MOCK_PROTOTYPE` | 正式 vault/OAuth/scope `NONE` | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | [Gate 4 当前全局规范](../frontend/README.md) + `FUTURE_PHASE_7` |
| `CAP-TEAM-001` | 管理成员、角色、审批和数据范围 | `PROPOSED/EXTERNAL_OWNED` | `PROTOTYPE / MOCK_PROTOTYPE` | 正式 Workspace policy `NONE` | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | [Gate 4 当前全局规范](../frontend/README.md) |
| `CAP-SET-001` | 管理个人、Workspace、安全、套餐和偏好 | `PROPOSED/EXTERNAL_OWNED` | `PROTOTYPE / 旧 API 局部接入` | 旧 Spring 与目标边界冲突 | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | [Gate 4 当前全局规范](../frontend/README.md) |
| `CAP-ADMIN-001` | 平台运营以最小权限管理租户和事故 | `UNKNOWN/EXTERNAL_OWNED` | `PROTOTYPE / MOCK_PROTOTYPE` | 旧 Spring 局部实现不构成目标 | `UNTESTED / UNKNOWN` | `OWN-SAAS-PLATFORM` | [Gate 4 当前全局规范](../frontend/README.md) + `FUTURE_PHASE_6` |

## 3. 独立站管理能力分解

以下子能力为追踪和后续 Capability Pack 建立稳定 ID；它们不新增长期承诺。页面 ID 来自 Gate 2 批准的完整地图。

| Capability ID | Parent | 用户结果 | Pages | 产品状态 | 当前合同/实现 | 当前硬边界 | Owner |
|---|---|---|---|---|---|---|---|
| `CAP-SITE-INTAKE-001` | `CAP-SITE-002` | 最少输入后安全建立 Site 和 Demo 任务 | `PAGE-FE-032/033` | `APPROVED` | `POST /intake`；幂等、原子关联和 demo trigger 已建 | SaaS token/BFF/引导消息未定 | `OWN-PRODUCT` |
| `CAP-SITE-PROFILE-001` | `CAP-SITE-002` | 分组查看、保存和纠正建站资料 | `PAGE-FE-020/034` | `APPROVED` | Site profile GET/PATCH；ETag/严格合同 | 统一 CompanyProfile UI/API 和历史迁移 UX 未建 | `OWN-PRODUCT` |
| `CAP-SITE-ASSET-001` | `CAP-SITE-002` | 上传、提交、查看处理状态并安全删除素材 | `PAGE-FE-035/036/039` | `APPROVED`；删除影响后续 | presign/commit/list/delete；lease/fencing/cleanup | URL、PUT、commit、ready 必须分状态；引用影响 API 不完整 | `OWN-PRODUCT` |
| `CAP-SITE-KB-001` | `CAP-SITE-002` | 理解知识处理进度、缺口和部分失败 | `PAGE-FE-024/037` | `APPROVED` 首批汇总 | `GET .../kb/status` + Docling/BGE-M3 内部链 | 无公开文档级完整管理合同 | `OWN-PRODUCT` |
| `CAP-SITE-CLAIM-001` | `CAP-SITE-002` | 审核来源、冲突、认证、撤销和适用范围 | `PAGE-FE-022/023/038` | `APPROVED_WITH_CONDITION` | Claim/Evidence/bridge/snapshot 内部 `AS_BUILT` | 公共审核合同缺；必须 fail-closed，优先自助合同，否则受控运营兜底 | `OWN-PRODUCT` |
| `CAP-SITE-BUILD-001` | `CAP-SITE-003` | 选择受支持 scope/style/locale 并启动 Build | `PAGE-FE-040` | `APPROVED` | `POST .../builds`；site/page/section，严格枚举 | 当前仅 `en/de-DE` 和两个 preset；并发/预算 fail-closed | `OWN-PRODUCT` |
| `CAP-SITE-RUN-001` | `CAP-SITE-003` | 观察步骤/成本/degraded，取消或恢复失败 | `PAGE-FE-041/042/044` | `APPROVED` | build GET/cancel；Temporal、cost summary v1、稳定错误 | cancel ACK 不明不得假终态；estimate 不冒充真实成本 | `OWN-PRODUCT` |
| `CAP-SITE-PREVIEW-001` | `CAP-SITE-003` | 打开完整性校验后的当前开发预览 | `PAGE-FE-043` | `APPROVED` | active READY pointer + hidden `/preview` resolver + digest checks | 仅开发预览；unknown component/坏产物 fail-closed；旧 preview 保留 | `OWN-PRODUCT` |
| `CAP-SITE-EDIT-001` | `CAP-SITE-001` | 编辑结构、文案、多语言和主题 | `PAGE-FE-045/046/047` | `APPROVED_NOT_BUILT` | SiteSpec/Copy/renderer 地基局部存在 | 无正式 SaaS 编辑器、runtime edit contract 或设计系统 | `OWN-PRODUCT` |
| `CAP-SITE-RELEASE-001` | `CAP-SITE-004` | 查看、比较和选择不可变版本 | `PAGE-FE-048` | `APPROVED_NOT_BUILT` | internal SiteRelease/manifest/digest `AS_BUILT` | 无 public list/diff/activate/rollback API | `OWN-PRODUCT` |
| `CAP-SITE-PUBLISH-001` | `CAP-SITE-004` | 经检查和授权后公开发布并保留旧版 | `PAGE-FE-049/050` | `APPROVED_NOT_BUILT` | `NONE` public contract | Build/Release/Preview 不得冒充 Publish | `OWN-PRODUCT` |
| `CAP-SITE-DOMAIN-001` | `CAP-SITE-004` | 配置域名、DNS、SSL 并恢复异常 | `PAGE-FE-051` | `APPROVED_NOT_BUILT` | `NONE` | ownership、infra、SLA、区域和回滚未定 | `OWN-PRODUCT` |
| `CAP-SITE-INQUIRY-001` | `CAP-SITE-005` | 安全接收、同意、去重并投递询盘 | `PAGE-FE-053/054` | `DEFERRED` | renderer 边界 `disabled_until_m2` | receiver/consent/outbox/SaaS projection 未建 | `OWN-PRODUCT` |
| `CAP-SITE-ANALYTICS-001` | `CAP-SITE-005` | 看访问、有效询盘和数据缺口 | `PAGE-FE-055` | `DEFERRED/PROPOSED` | `NONE` | 指标 SoR、隐私、保留和事件 Owner 未定 | `OWN-PRODUCT` |
| `CAP-SITE-DIAGNOSIS-001` | `CAP-SITE-001` | 诊断既有站点的 SEO、性能和证据缺口 | `PAGE-FE-056` | `DEFERRED M3+` | 原型/Word 输入，当前无产品链 | 不属于注册分支，不进入首个纵切 | `OWN-PRODUCT` |
| `CAP-SITE-PUBLIC-OUTPUT-001` | `CAP-SITE-001` | 让海外买家浏览可信、可访问的公开站 | `PAGE-FE-057` | `APPROVED` 方向，生产闭环未建 | Astro/SiteSpec/10 组件局部 `AS_BUILT` | 输出规范不是 SaaS 管理前端；发布/询盘仍缺 | `OWN-PRODUCT` |

## 4. Gate 2 已批准的组合

| Decision | 批准内容 | Capability 影响 |
|---|---|---|
| `DEC-FE-P2-001` | 首批客户：B2B 制造、工贸一体、传统出口 | 所有首批 UX/Fixture 默认围绕该细分，不扩大为通用行业 |
| `DEC-FE-P2-002` | 默认日常操作者：海外增长/外贸运营 | Site 首个纵切以 `ACT-FE-002` 为主角色 |
| `DEC-FE-P2-003` | 六项一级 IA | CAP 映射到今日/客户开发/Site/增长执行/互动与商机/洞察 |
| `DEC-FE-P2-004` | 首个纵切止于可信开发预览 | `CAP-SITE-INTAKE-001` 至 `CAP-SITE-PREVIEW-001` 优先；后续能力不混入 |
| `DEC-FE-P2-005` | Claim fail-closed，优先自助审核，必要时受控运营兜底 | `CAP-SITE-CLAIM-001` 为条件硬门 |
| `DEC-FE-P2-006` | 保持对象 ownership；外部 SaaS repo/Owner 仍待指定 | 不以旧 Spring 或本地原型改变 SoR |
| `DEC-FE-P2-007` | 用户可见承诺止于真实合同范围 | Publish/Domain/Rollback/Inquiry/Analytics 继续后置 |
| `DEC-FE-P2-008` | 指标与反指标方向批准，目标值待基线 | 能力包必须引用 `MET-SITE-001..014` 和 anti-metrics |
| `DEC-FE-P2-009` | 正式前端/设计 Owner 未关闭时保持 blocker | 不进入实际前端设计或实现 |

## 5. Gate 4 当前全局规范与 Phase 5 模块映射

Gate 4 已批准以下 `CURRENT` 横切规范；它们不改变任何 Capability 的前端、质量或可用性轴。Phase 5 只把独立站管理的 UX 文档轴升级为可评审规格：

| Capability 范围 | 全局规范入口 | 仍需模块/实现补齐 |
|---|---|---|
| 全部 | [体验原则](../frontend/01-product-experience-principles.md)、[页面目录](../frontend/04-page-and-capability-catalog.md) | 模块 outcome/page manifest、用户验证 |
| Shell/Today/管理 | [IA](../frontend/02-information-architecture.md)、[Shell](../frontend/05-navigation-and-workspace-shell.md) | SaaS repo、read model、Workspace/capability contract |
| 全部对象与动作 | [权限与数据可见性](../frontend/06-permissions-and-data-visibility.md) | 正式 role/entitlement/allowed actions/privacy policy |
| 全部长任务/异步 | [状态与恢复](../frontend/07-state-error-degradation-and-recovery.md) | 域 error/state mapping、页面设计、E2E |
| 含 AI/事实/外部动作 | [AI/Evidence/Approval](../frontend/08-ai-approval-evidence-and-human-control.md) | task/Claim/Approval/execution auth 合同 |
| 全部 UI | [设计系统与内容](../frontend/09-design-system-and-content-guidelines.md)、[设计登记](../design/README.md) | 受控设计源、Token values、组件实现、视觉验证 |
| 全部 Release | [a11y/性能/i18n](../frontend/10-responsive-accessibility-and-performance.md)、[分析/测试/证据](../frontend/12-analytics-testing-and-release-evidence.md) | 正式 repo、场景 Fixture、真实测试、Release Bundle |
| `CAP-SITE-001..005` | [独立站管理 Capability Pack](../frontend/modules/independent-site-management/README.md)、[低保真线框](../design/independent-site-management-wireframes.md)、[实施蓝图](../frontend/implementation/independent-site-management-blueprint.md) | 正式 repo/设计源/权限/Claim/QA-Ops；发布链合同与 infra |

这些全局规则已在 Gate 4 升级为当前目标规范；Phase 5 规格同样不会把 Mock/`NONE` 的实现轴升级。

## 6. 首个纵切的完成门

`CAP-SITE-INTAKE-001` 至 `CAP-SITE-PREVIEW-001` 只有同时具备以下条件才可从“产品批准/后端地基”升级为“用户可用”：

1. 正式 SaaS 前端仓库、Owner、CI、部署环境和身份/Workspace 接缝；
2. Phase 4 统一权限、状态、长任务、Evidence/Approval、a11y、埋点和内容规则；
3. Phase 5 页面/状态/微文案/响应式/设计资产/前端技术方案；
4. Claim 自助合同或经批准且可审计的运营兜底；
5. [场景目录](scenario-catalog.md)中的关键成功、失败、取消、冲突和恢复场景可执行；
6. 契约、E2E、真实运行和 Release evidence 与声明环境相称；
7. 用户指南、管理员/运营恢复和已知限制同步完成。

任一条件缺失时，Portal 和 UI 只能显示精确多轴状态，不能用“Site Builder 已完成”代替。

## 7. 变更协议

- 新能力先确认是否已有 Parent/ID；不得因新增页面或 OSS 再建同义 Capability。
- Product state 由 `OWN-PRODUCT` 批准；代码状态必须来自 main/机器证据；可用性升级必须有真实前端/部署证据。
- 冻结产品域可以修正文档和安全缺陷，但恢复新增开发需产品负责人明确指令。
- Capability 被拆分时保留 Parent；被拒绝/取代时保留 ID 和 successor，不复用编号。
- 正式 Capability Pack 只引用本表、对象、场景和契约，不复制这些 Registry 的整表内容。
