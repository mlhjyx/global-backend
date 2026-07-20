# 页面与能力目录

> 文档 ID：`BASE-FE-P2-004`
> 状态：`READY_FOR_GATE_2_REVIEW`
> 事实基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 用途：回答“完整 SaaS 需要哪些前端能力”；本表不是最终路由表或页面规格

## 1. 状态和优先级

| 标记 | 含义 |
|---|---|
| `SHELL_FOUNDATION` | 进入任何纵切前都需要的全局产品骨架 |
| `FIRST_VERTICAL` | 建议首个 Dev-Ready 纵切的一部分 |
| `NEXT_SITE` | 独立站管理后续能力，需独立 Gate |
| `MAP_FROZEN` | 完整产品地图保留；后端能力冻结，不启动新增施工 |
| `TARGET_EXTERNAL` | 归 SaaS/其他系统，当前只做地图和接缝 |
| `DEFERRED` | 已知后置能力 |
| `PROTOTYPE_ONLY` | 本地 React 页面存在，但只有 Mock/旧 API，不是交付状态 |

页面 ID 稳定，但名称、路由和导航层级须在 Gate 2 批准后才成为规范。

## 2. 全局 Shell 与跨页面面板

| Page ID | 页面/面板 | 主要用户任务 | 首屏/主动作 | 关键对象 | 建议阶段 | 当前实现事实 |
|---|---|---|---|---|---|---|
| `PAGE-FE-001` | 登录/会话入口 | 进入正确账户和 Workspace | 登录、恢复会话、错误/锁定处理 | Identity、Workspace | `SHELL_FOUNDATION` | 本地原型有 localStorage/旧 Spring 流程；与目标 JWKS 边界冲突 |
| `PAGE-FE-002` | Workspace 选择/切换 | 确认正在操作哪个企业 | 当前 Workspace、最近、搜索、切换 | Workspace、Membership | `SHELL_FOUNDATION` | 未发现权威实现 |
| `PAGE-FE-003` | 今日 | 看到今天最重要的行动、审批、异常和机会 | 继续任务、处理异常、进入对象 | Task、Approval、Incident、Opportunity | `SHELL_FOUNDATION` | `/dashboard` 为 Mock 原型 |
| `PAGE-FE-004` | 全局搜索/命令面板 | 跨域找到对象并执行安全快捷动作 | 搜索、过滤、最近访问 | 多域对象读模型 | `SHELL_FOUNDATION` | TopBar 有 Mock 搜索，未接权限/真实索引 |
| `PAGE-FE-005` | 通知中心 | 理解发生了什么并跳到可操作对象 | 标记已读、进入影响对象 | Notification、Event | `SHELL_FOUNDATION` | TopBar 有硬编码通知 |
| `PAGE-FE-006` | 任务/待办中心 | 管理个人与团队下一步 | 接受、分派、完成、升级 | Task、Owner、SLA | `SHELL_FOUNDATION` | 无统一对象/合同 |
| `PAGE-FE-007` | 审批中心 | 集中处理待批准事实和外部动作 | 预览差异、批准、退回、限制范围 | Approval、Claim、Authorization | `SHELL_FOUNDATION` | `/team` 仅 Mock；局部 Claim 状态在后端 |
| `PAGE-FE-008` | 异常与恢复中心 | 找到失败影响、已保留结果和恢复动作 | 重试、补资料、切换、升级运营 | Incident、Run、ProviderHealth | `SHELL_FOUNDATION` | `/anomaly` 为 Mock；后端有局部错误/状态 |
| `PAGE-FE-009` | 长任务中心 | 跨页面继续查看 Build/导入/研究进度 | 打开任务、取消、查看结果 | WorkflowRun、BuildRun | `SHELL_FOUNDATION` | 无全局实现；Site Build 可轮询 |
| `PAGE-FE-010` | 帮助、反馈与支持 | 解决问题并带上下文求助 | 搜索指南、反馈、复制诊断 ID | Guide、Correlation ID | `SHELL_FOUNDATION` | 未发现正式实现 |

### 2.1 Shell 最低状态

所有 Shell 面板至少覆盖：无 Workspace、无权限、未配置、空、加载、局部服务失败、stale、网络中断、跨 Workspace 切换、深链对象不存在和 entitlement 不足。聚合页失败不得阻断用户直接进入仍健康的业务对象。

## 3. 企业、产品与信任

| Page ID | 页面 | 目标与主动作 | 对象/SoR | 建议阶段 | 当前事实/缺口 |
|---|---|---|---|---|---|
| `PAGE-FE-020` | 企业资料主页 | 查看和完善企业、产品、公开联系方式与完整度 | CompanyProfile、Offering | `FIRST_VERTICAL` 依赖 | 对象已有；没有统一 SaaS 页面/API 覆盖 |
| `PAGE-FE-021` | 产品/服务目录 | 管理可复用 Offering、参数和适用市场 | Offering | `NEXT_SITE`/跨域 | Schema 有对象，统一 CRUD/版本未完成 |
| `PAGE-FE-022` | 企业事实审查 | 处理 NEEDS_REVIEW、冲突、过期和撤销 | Claim、Evidence、KnowledgeConflict | `FIRST_VERTICAL` 人工 Gate | 后端有对象/bridge；公开审查 API/页面不完整 |
| `PAGE-FE-023` | Evidence Drawer | 从任何事实查看来源、引用、时间、适用范围 | Evidence、SourceSnapshot | `FIRST_VERTICAL` 横切 | 需要统一展示合同；不能泄漏内部 trace/PII |
| `PAGE-FE-024` | 企业知识与资料 | 查看来源、文档、处理状态和缺口 | KnowledgeSource、KbDocument | `FIRST_VERTICAL` 子集 | `/knowledge` 是 Mock；Site KB status 只有汇总 |
| `PAGE-FE-025` | Export Readiness / Buyer Trust | 按维度看证据、缺口、风险和任务 | Assessment、Claim、TrustAsset | `TARGET_EXTERNAL` | Word 提案；无当前机器对象 |
| `PAGE-FE-026` | 资产对象详情 | 查看原件、权利、用途、引用、变体和删除影响 | Asset、AssetVariant | `NEXT_SITE`/横切 | Site Asset API 有局部列表/删除；权利登记不完整 |

企业资料不是一个“填完即结束”的长表单。建议首页呈现可公开程度、关键缺口、待审事实和正在被哪些产品使用；具体字段按任务渐进展开。

## 4. 独立站管理

### 4.1 一级区域与对象入口

| Page ID | 页面 | 目标与主动作 | 对象/SoR | 建议阶段 | 当前事实/缺口 |
|---|---|---|---|---|---|
| `PAGE-FE-030` | 独立站管理首页/站点列表 | 找到站点、状态、下一步和最新可用预览 | Site | `FIRST_VERTICAL` | `GET /sites`/detail 已有；原型只展示首个 Mock Site |
| `PAGE-FE-031` | 站点概览 | 看当前预览、资料缺口、Build/版本和待办 | Site、active SiteVersion、BuildRun | `FIRST_VERTICAL` | 原型 Overview 存在但指标/按钮大多 Mock |
| `PAGE-FE-032` | 首次建站 Intake | 最少输入并安全触发 Demo | Site、CompanyProfile、BuildRun | `FIRST_VERTICAL` | `POST /intake` 已有；SaaS token/BFF/引导未定 |
| `PAGE-FE-033` | Demo 准备/引导卡 | 在生成等待和 READY 后继续下一步 | BuildRun、Site | `FIRST_VERTICAL` | 后端无专用引导状态；前端应组合现有端点 |

### 4.2 资料、素材和事实

| Page ID | 页面 | 首屏与主动作 | 状态必须覆盖 | 合同 | 阶段 |
|---|---|---|---|---|---|
| `PAGE-FE-034` | 建站资料向导 | 缺口、已完成组、继续填写；分组保存 | 初始、草稿、保存中、ETag 冲突、历史 schema 迁移、跳过 | GET/PATCH profile | `FIRST_VERTICAL` |
| `PAGE-FE-035` | 站点资料中心 | 素材/文档清单、用途、处理状态；上传 | presign、上传、commit、queued、processing、ready、duplicate、rejected、retryable failure | Asset APIs | `FIRST_VERTICAL` |
| `PAGE-FE-036` | 上传任务详情 | 解释每个文件进度、错误和已保留结果 | 断网、URL 过期、ACK 不明、校验失败、重复、处理失败 | Asset APIs + 客户端 PUT | `FIRST_VERTICAL` |
| `PAGE-FE-037` | 站点知识状态 | 文档/块统计、gaps、补资料动作 | 空、处理中、部分 ready、失败、stale | KB status | `FIRST_VERTICAL`，汇总版 |
| `PAGE-FE-038` | 站点事实/认证审核 | 待审 Claim、证据、认证 Asset、批准/撤销 | NEEDS_REVIEW、APPROVED、EXPIRED、REVOKED、冲突 | 当前缺公共 API | `FIRST_VERTICAL_BLOCKED` |
| `PAGE-FE-039` | 素材引用与删除影响 | 被哪些 Profile/SiteSpec/Claim 使用，解除引用后删除 | busy、referenced、tombstoned、cleanup pending | DELETE 409 + 目标引用 API | `NEXT_SITE`；首批可人工兜底 |

### 4.3 生成、进度和可信预览

| Page ID | 页面 | 首屏与主动作 | 状态必须覆盖 | 合同 | 阶段 |
|---|---|---|---|---|---|
| `PAGE-FE-040` | 生成配置 | scope、目标、style、locale、页面、预计影响；启动 | 无 active version、无目标、选项不支持、并发 Build、额度不足 | POST build | `FIRST_VERTICAL` |
| `PAGE-FE-041` | Build 任务详情 | 当前阶段/步骤、成本、已完成结果；取消 | queued/running/degraded/succeeded/failed/cancelled、stale、取消 ACK 不明 | GET/cancel build | `FIRST_VERTICAL` |
| `PAGE-FE-042` | Build 失败恢复 | 原因类别、旧预览仍可用、推荐动作 | 可重试、需补资料、预算耗尽、目标漂移、服务不可用、不可重试 | 稳定错误码 + 运营路径 | `FIRST_VERTICAL` |
| `PAGE-FE-043` | 开发预览 | 打开当前 active READY Release；回到缺口/Build | not ready、digest/产物异常、旧版保留、noindex | Site previewUrl + hidden preview resolver | `FIRST_VERTICAL` |
| `PAGE-FE-044` | Build 成本详情 | 展示真实/计算/估算/未知分层及硬上限 | 未发生、预留、结算、unknown、预算关闭 | costSummary v1 | `NEXT_SITE`；首批可在任务详情摘要 |

首个纵切不需要先做完整可视化编辑器，但必须完整处理 `PAGE-FE-034`–`043` 的关键状态。若 Claim 审核 API 未补，`PAGE-FE-038` 必须显示为阻塞/运营兜底，不能自动跳过事实门。

### 4.4 编辑、版本和公开发布

| Page ID | 页面 | 用户结果 | 状态/依赖 | 阶段 |
|---|---|---|---|---|
| `PAGE-FE-045` | 站点结构编辑器 | 管理页面/板块、排序和启用 | SiteSpec runtime validator、组件目录、并发保存 | `NEXT_SITE`，M1-e/M2 |
| `PAGE-FE-046` | 内容/多语言编辑器 | 编辑 CopyBundle、引用 Claim、锁定人工内容 | en/de-DE 生成、locale fallback、事实引用、保存冲突 | `NEXT_SITE`，M1-e/M2 |
| `PAGE-FE-047` | 风格与主题 | 选择可用 family/style 并预览影响 | 仅服务端可用枚举；原型四风格不可继承 | `NEXT_SITE` |
| `PAGE-FE-048` | 版本历史与对比 | 比较 SiteVersion/Release、识别来源和变化 | Release public API、diff、保留策略 | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-049` | 发布前检查 | 汇总 Claim、素材、locale、表单、SEO、法务和权限 Gate | PublishReview、Approval、Authorization | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-050` | 发布与回滚 | 原子切换 Release、保留旧版、回滚 | publish/activate/rollback API、权限、审计 | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-051` | 域名与 SSL | 配置 DNS、验证、证书、切换和恢复 | ownership、Caddy/infra、SLA、域名争议 | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-052` | 站点设置 | locale、SEO、联系、法务、访问控制 | 各字段 SoR、发布影响、Entitlement | `NEXT_SITE` |

### 4.5 访客转化、分析和诊断

| Page ID | 页面 | 用户结果 | 当前状态 | 阶段 |
|---|---|---|---|---|
| `PAGE-FE-053` | 询盘表单设置 | 配置字段、同意、接收方和反垃圾 | Inquiry receiver `disabled_until_m2` | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-054` | 站点询盘 | 查看投递、去重和 SaaS Conversation 入口 | 无当前 receiver/Conversation 接缝 | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-055` | 站点分析 | 查看访问、转化和数据缺口 | 无分析 SoR；原型数字为 Mock | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-056` | 站点诊断 | 对既有站做 SEO/性能/证据体检 | 明确后置 M3+；原型页面不构成能力 | `DEFERRED` |
| `PAGE-FE-057` | 公开站输出规范 | 让买家可信浏览并发起有效询盘 | Astro/Renderer 局部 as-built；发布/询盘未闭环 | 模块输出规范，不是 SaaS 页面 |

## 5. 市场与客户开发（完整地图，当前冻结）

| Page ID | 页面 | 主要结果 | 核心对象 | 状态 |
|---|---|---|---|---|
| `PAGE-FE-060` | 市场机会扫描 | 比较市场候选及证据 | MarketThesis、Evidence | `MAP_FROZEN`；无真实前端 |
| `PAGE-FE-061` | 市场研究工作台 | 研究问题、证据、结论和采用动作 | ResearchProject、MarketEvidence | `MAP_FROZEN` |
| `PAGE-FE-062` | ICP 与购买委员会 | 定义条件、排除、角色和样例回测 | ICP、Persona、BuyingCommitteeRole | `MAP_FROZEN`；后端有对象/API |
| `PAGE-FE-063` | 客户池/Lead Explorer | 看推荐、待确认、拒绝和禁止 | CanonicalCompany、Lead、Score | `MAP_FROZEN`；`/accounts` Mock |
| `PAGE-FE-064` | 客户/Lead 详情 | 理解身份、证据、信号、联系人、资格和下一步 | Company、Lead、Signal、Contact | `MAP_FROZEN` |
| `PAGE-FE-065` | 发现/富集任务 | 查看来源、成本、质量、部分失败和恢复 | DiscoveryRun、Provider、Evidence | `MAP_FROZEN` |
| `PAGE-FE-066` | 数据权利与 Suppression | 查看允许动作、删除/限制和禁联 | Rights、Suppression、DeletionRequest | `MAP_FROZEN`/运营 |

## 6. 增长执行、内容与渠道（SaaS 目标态）

| Page ID | 页面 | 主要结果 | 对象 | 当前状态 |
|---|---|---|---|---|
| `PAGE-FE-070` | Goal/Initiative | 定义业务目标、市场、Owner、预算和结果口径 | Goal、Initiative | `TARGET_EXTERNAL`；`/goal` 本地状态 |
| `PAGE-FE-071` | Campaign 列表 | 找到草稿、运行、暂停和完成的计划 | Campaign | `TARGET_EXTERNAL`；原型 Mock |
| `PAGE-FE-072` | Campaign Canvas | 组织目标、受众、内容、渠道、授权和结果 | Campaign、Audience、Revision | `TARGET_EXTERNAL` |
| `PAGE-FE-073` | Audience/名单快照 | 固定查询、样例、排除和成本 | Audience、Lead refs | `TARGET_EXTERNAL` |
| `PAGE-FE-074` | Dry Run 与授权 | 预览目标、内容、渠道、成本和风险后批准 | Approval、Authorization | `TARGET_EXTERNAL` |
| `PAGE-FE-075` | 内容库 | 管理可复用内容和版本 | ContentAsset、Claim refs | `TARGET_EXTERNAL`；原型 Mock |
| `PAGE-FE-076` | 内容编辑/审核 | 生成、编辑、事实检查和审批 | Brief、ContentAsset、Approval | `TARGET_EXTERNAL` |
| `PAGE-FE-077` | 内容日历 | 组织多平台版本、排期和状态 | ContentAsset、PublishJob | `TARGET_EXTERNAL` |
| `PAGE-FE-078` | 发布任务 | 查看部分成功、重试和回执 | PublishJob、DeliveryReceipt | `TARGET_EXTERNAL`；原型“AI 发布”Mock |
| `PAGE-FE-079` | 渠道账号 | 管理 OAuth/scope/健康和失效 | ChannelAccount、CredentialRef | `TARGET_EXTERNAL` |

## 7. 互动、商机和洞察（SaaS 目标态）

| Page ID | 页面 | 主要结果 | 对象 | 当前状态 |
|---|---|---|---|---|
| `PAGE-FE-080` | Unified Inbox | 聚合回复/表单、识别意向并分派 | Conversation、Message、Intent | `TARGET_EXTERNAL`；`/engagement` Mock |
| `PAGE-FE-081` | 会话详情 | 看上下文、证据、翻译、回复和升级 | Conversation、Contact、Claim refs | `TARGET_EXTERNAL` |
| `PAGE-FE-082` | Opportunity 列表/看板 | 管理候选、QGO、SAO 和阶段 | Opportunity | `TARGET_EXTERNAL`；`/opportunities` Mock |
| `PAGE-FE-083` | Opportunity 详情 | 资格、Owner、下一步、触点和结果 | Opportunity、Outcome | `TARGET_EXTERNAL` |
| `PAGE-FE-084` | 经营洞察 | 看 QGO/SAO/Outcome、成本和质量 | Read models | `TARGET_EXTERNAL`；`/insights` Mock |
| `PAGE-FE-085` | 归因与实验 | 解释证据、不确定性和下一轮验证 | Attribution、Experiment | `TARGET_EXTERNAL` |
| `PAGE-FE-086` | 成本与用量 | 跨能力查看预算、真实/估算成本和异常 | UsageLedger、Entitlement | `TARGET_EXTERNAL`；Site 局部已有 |

## 8. 团队、集成、设置与运营

| Page ID | 页面 | 主要结果 | 对象 | 当前状态 |
|---|---|---|---|---|
| `PAGE-FE-090` | 成员与角色 | 邀请、分配角色和查看有效权限 | Membership、Role | `TARGET_EXTERNAL`；`/team` Mock |
| `PAGE-FE-091` | 数据范围与委派 | 定义团队/个人/Workspace/代理商范围 | Policy、Delegation | `TARGET_EXTERNAL/OPEN_DECISION` |
| `PAGE-FE-092` | 集成中心 | 添加、授权、诊断和移除连接 | Integration、CredentialRef | `TARGET_EXTERNAL`；`/integrations` Mock |
| `PAGE-FE-093` | Workspace 设置 | 企业偏好、地区、默认语言和政策 | WorkspacePolicy | `TARGET_EXTERNAL` |
| `PAGE-FE-094` | 安全与审计 | 会话、Secret、日志、删除和事故 | Audit、CredentialRef、DeletionRequest | `TARGET_EXTERNAL` |
| `PAGE-FE-095` | 套餐、用量与账单 | 理解 entitlement、额度、升级/降级 | Entitlement、Subscription、Usage | `TARGET_EXTERNAL/OPEN_DECISION` |
| `PAGE-FE-096` | 运营控制台 | 受控诊断任务、Provider、事故和删除 | ProviderHealth、Incident、WorkflowRun | `TARGET_EXTERNAL`；独立 admin 原型无权威性 |

## 9. 本地原型页面映射

| 当前路由 | 对应目录项 | 当前结论 |
|---|---|---|
| `/dashboard` | PAGE-003 | Mock 聚合，不是 Today 契约 |
| `/campaigns` 及四个子路由 | PAGE-071/072 | 页面原型覆盖，不存在 Campaign SoR |
| `/accounts` | PAGE-063/064 | 未接真实 Buyer Intelligence API |
| `/content` | PAGE-075/076 | Mock |
| `/publish` | PAGE-077/078 | Mock，不得声称 OAuth/发布/重试可用 |
| `/anomaly` | PAGE-008 | Mock，不是统一 Incident/Recovery |
| `/opportunities` | PAGE-082 | Mock；Opportunity 归 SaaS |
| `/engagement` | PAGE-080/081 | Mock；无真实渠道/Conversation |
| `/insights` | PAGE-084/085 | Mock 指标，无口径和 SoR |
| `/site-builder` | PAGE-031/034–055 混合 | 单页混入当前/目标/延后能力，必须拆状态和契约 |
| `/site-builder/diagnosis` | PAGE-056 | 后置 M3，原型不能升级状态 |
| `/knowledge` | PAGE-024 | Mock；Site KB 只有局部汇总合同 |
| `/competitors` | PAGE-060/061 的候选子能力 | Mock |
| `/integrations` | PAGE-092 | Mock |
| `/team` | PAGE-007/090 | Mock，审批与成员概念混用 |
| `/settings` | PAGE-093–095 | 仅少量旧 Spring API，目标 ownership 未定 |

## 10. 第一纵切的页面边界

建议 Gate 2 只批准以下 Dev-Ready 队列，后续 Phase 4/5 再写正式规格：

```text
PAGE-001/002（由 SaaS 提供身份与 Workspace 前提）
→ PAGE-030/031 进入独立站管理
→ PAGE-034 资料向导
→ PAGE-035/036/037 素材与 KB 状态
→ PAGE-038 事实审核（若 API 未落则显式阻塞/人工兜底）
→ PAGE-040 创建 Build
→ PAGE-041/042 进度、成本、取消和恢复
→ PAGE-043 打开可信开发预览
```

不在该纵切内：PAGE-045–057 的可视化编辑、版本管理、公开发布、域名、询盘、分析和诊断。它们不能因为原型已有按钮而进入首批“用户可用”承诺。

## 11. Gate 2 需要批准

1. 是否接受本目录作为完整 SaaS 页面地图，而不要求所有页面同时 Dev-Ready。
2. 是否批准 §10 为首个纵切。
3. 是否同意独立站管理从当前原型的单页八 Tab 拆成对象/任务导向的多页面工作区。
4. 是否将 PAGE-038 的事实审核作为首个纵切硬依赖；若暂缺合同，采用什么人工 Gate。
5. 哪些 `TARGET_EXTERNAL` 页面由哪个正式 SaaS 仓库和 Owner 承担。
