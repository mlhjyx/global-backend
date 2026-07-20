# 全产品页面与能力目录

> 文档 ID：`FE-GLOBAL-005`
> 层级：`L2 / Normative candidate`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_4_REVIEW`
> 内容 Owner：`OWN-PRODUCT`
> 数据来源：[能力登记](../governance/capability-register.md)与 Gate 2 Page ID；不是最终路由表

## 1. 如何读这份目录

本文件是“整个项目的前端需要哪些能力”的人类入口。Capability ID、多轴状态和 SoR 仍由治理 Registry 承重；页面名称、路由、布局和交互进入模块 Capability Pack 后才可称 Dev-Ready。

| 状态 | 含义 |
|---|---|
| `SHELL_FOUNDATION` | 所有纵切共同依赖 |
| `FIRST_VERTICAL` | 首个 Site 可信开发预览纵切 |
| `NEXT_SITE` | Site 后续能力，需自己的 Gate |
| `MAP_FROZEN` | 产品地图保留，当前不恢复新增施工 |
| `TARGET_EXTERNAL` | 由正式 SaaS/其他 SoR 负责 |
| `DEFERRED` | 已知后置 |
| `PROTOTYPE_ONLY` | 只在本地 Mock/旧 API 出现 |

## 2. 产品区域目录

| 区域 | Page family | 关键页面/面板 | Capability | 当前深度 |
|---|---|---|---|---|
| Shell/今日 | `PAGE-FE-001..010` | 登录/会话、Workspace、今日、Search、通知、任务、审批、异常、长任务、帮助 | `CAP-ID-001`、`CAP-SHELL-001`、`CAP-ONB-001`、`CAP-TODAY-001` | IA 批准；正式 repo/合同/部署未知；本地多为 Mock |
| 企业资料与信任 | `PAGE-FE-020..026` | 企业资料、Offering、事实审查、Evidence drawer、知识、信任评估、Asset 详情 | `CAP-KNOW-001` + Site Profile/Asset/Claim 子能力 | 后端对象局部已建；统一 CRUD/审核/UX 不完整 |
| 独立站管理 | `PAGE-FE-030..057` | 站点、Intake、资料、素材、KB、Claim、Build、Preview、编辑、版本、发布、域名、询盘、分析、诊断、公开输出 | `CAP-SITE-001..005` + 16 个 Site child | 当前主线；首个承诺仅 `PAGE-FE-030..043` 中合同相称子集 |
| 客户开发 | `PAGE-FE-060..066` | 市场/ICP、客户池、公司/联系人、发现任务、资格包、数据权利 | `CAP-BUYER-001`、`CAP-INTENT-001`、`CAP-COMP-001` | 后端真实能力；前端 Mock；新增开发冻结 |
| 增长执行 | `PAGE-FE-070..079` | Goal/Initiative、Campaign、Audience、内容、素材、发布任务、渠道账号、日历、实验 | `CAP-CAMP-001`、`CAP-CONTENT-001`、`CAP-PUBLISH-001` | 产品地图/原型；正式 SoR 与前端未知 |
| 互动与商机 | `PAGE-FE-080..083` | Inbox、Conversation、Opportunity、Outcome | `CAP-ENGAGE-001`、`CAP-OPP-001` | SaaS external-owned；本仓不建主状态 |
| 洞察 | `PAGE-FE-084..086` | 经营/漏斗、归因、质量/成本/实验 | `CAP-INSIGHT-001` | 目标读模型；Site 仅有局部成本事实 |
| 管理与运营 | `PAGE-FE-090..096` | Team/Role、Integration、Billing/Usage、Settings/Security、数据权利、Operations、审计 | `CAP-TEAM-001`、`CAP-INTEG-001`、`CAP-SET-001`、`CAP-ADMIN-001` | 正式 ownership/合同未知；旧原型不作真值 |

## 3. 完整 Page ID 索引

本索引固定“项目不能漏掉哪些前端表面”。`建议阶段`不是实现状态；具体对象、合同、缺口和 provenance 仍见 [Phase 2 页面目录](../roadmap/saas-frontend-phase-2/page-and-capability-catalog.md)和 [Capability Registry](../governance/capability-register.md)。

### 3.1 Shell 与企业事实

| Page ID | 名称 | 建议阶段 |
|---|---|---|
| `PAGE-FE-001` | 登录/会话入口 | `SHELL_FOUNDATION` |
| `PAGE-FE-002` | Workspace 选择/切换 | `SHELL_FOUNDATION` |
| `PAGE-FE-003` | 今日 | `SHELL_FOUNDATION` |
| `PAGE-FE-004` | 全局搜索/命令面板 | `SHELL_FOUNDATION` |
| `PAGE-FE-005` | 通知中心 | `SHELL_FOUNDATION` |
| `PAGE-FE-006` | 任务/待办中心 | `SHELL_FOUNDATION` |
| `PAGE-FE-007` | 审批中心 | `SHELL_FOUNDATION` |
| `PAGE-FE-008` | 异常与恢复中心 | `SHELL_FOUNDATION` |
| `PAGE-FE-009` | 长任务中心 | `SHELL_FOUNDATION` |
| `PAGE-FE-010` | 帮助、反馈与支持 | `SHELL_FOUNDATION` |
| `PAGE-FE-020` | 企业资料主页 | `FIRST_VERTICAL` 依赖 |
| `PAGE-FE-021` | 产品/服务目录 | `NEXT_SITE/CROSS_DOMAIN` |
| `PAGE-FE-022` | 企业事实审查 | `FIRST_VERTICAL` 人工 Gate |
| `PAGE-FE-023` | Evidence Drawer | `FIRST_VERTICAL` 横切 |
| `PAGE-FE-024` | 企业知识与资料 | `FIRST_VERTICAL` 子集 |
| `PAGE-FE-025` | Export Readiness / Buyer Trust | `TARGET_EXTERNAL` |
| `PAGE-FE-026` | 资产对象详情 | `NEXT_SITE/CROSS_DOMAIN` |

### 3.2 独立站管理

| Page ID | 名称 | 建议阶段 |
|---|---|---|
| `PAGE-FE-030` | 独立站管理首页/站点列表 | `FIRST_VERTICAL` |
| `PAGE-FE-031` | 站点概览 | `FIRST_VERTICAL` |
| `PAGE-FE-032` | 首次建站 Intake | `FIRST_VERTICAL` |
| `PAGE-FE-033` | Demo 准备/引导卡 | `FIRST_VERTICAL` |
| `PAGE-FE-034` | 建站资料向导 | `FIRST_VERTICAL` |
| `PAGE-FE-035` | 站点资料中心 | `FIRST_VERTICAL` |
| `PAGE-FE-036` | 上传任务详情 | `FIRST_VERTICAL` |
| `PAGE-FE-037` | 站点知识状态 | `FIRST_VERTICAL` 汇总版 |
| `PAGE-FE-038` | 站点事实/认证审核 | `FIRST_VERTICAL_BLOCKED` |
| `PAGE-FE-039` | 素材引用与删除影响 | `NEXT_SITE`；首批可受控兜底 |
| `PAGE-FE-040` | 生成配置 | `FIRST_VERTICAL` |
| `PAGE-FE-041` | Build 任务详情 | `FIRST_VERTICAL` |
| `PAGE-FE-042` | Build 失败恢复 | `FIRST_VERTICAL` |
| `PAGE-FE-043` | 开发预览 | `FIRST_VERTICAL` |
| `PAGE-FE-044` | Build 成本详情 | `NEXT_SITE`；首批摘要 |
| `PAGE-FE-045` | 站点结构编辑器 | `NEXT_SITE` |
| `PAGE-FE-046` | 内容/多语言编辑器 | `NEXT_SITE` |
| `PAGE-FE-047` | 风格与主题 | `NEXT_SITE` |
| `PAGE-FE-048` | 版本历史与对比 | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-049` | 发布前检查 | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-050` | 发布与回滚 | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-051` | 域名与 SSL | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-052` | 站点设置 | `NEXT_SITE` |
| `PAGE-FE-053` | 询盘表单设置 | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-054` | 站点询盘 | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-055` | 站点分析 | `NEXT_SITE_BLOCKED` |
| `PAGE-FE-056` | 站点诊断 | `DEFERRED M3+` |
| `PAGE-FE-057` | 公开站输出规范 | 模块输出，不是 SaaS 管理页 |

### 3.3 客户开发

| Page ID | 名称 | 建议阶段 |
|---|---|---|
| `PAGE-FE-060` | 市场机会扫描 | `MAP_FROZEN` |
| `PAGE-FE-061` | 市场研究工作台 | `MAP_FROZEN` |
| `PAGE-FE-062` | ICP 与购买委员会 | `MAP_FROZEN` |
| `PAGE-FE-063` | 客户池/Lead Explorer | `MAP_FROZEN` |
| `PAGE-FE-064` | 客户/Lead 详情 | `MAP_FROZEN` |
| `PAGE-FE-065` | 发现/富集任务 | `MAP_FROZEN` |
| `PAGE-FE-066` | 数据权利与 Suppression | `MAP_FROZEN/OPS` |

### 3.4 增长执行

| Page ID | 名称 | 建议阶段 |
|---|---|---|
| `PAGE-FE-070` | Goal/Initiative | `TARGET_EXTERNAL` |
| `PAGE-FE-071` | Campaign 列表 | `TARGET_EXTERNAL` |
| `PAGE-FE-072` | Campaign Canvas | `TARGET_EXTERNAL` |
| `PAGE-FE-073` | Audience/名单快照 | `TARGET_EXTERNAL` |
| `PAGE-FE-074` | Dry Run 与授权 | `TARGET_EXTERNAL` |
| `PAGE-FE-075` | 内容库 | `TARGET_EXTERNAL` |
| `PAGE-FE-076` | 内容编辑/审核 | `TARGET_EXTERNAL` |
| `PAGE-FE-077` | 内容日历 | `TARGET_EXTERNAL` |
| `PAGE-FE-078` | 发布任务 | `TARGET_EXTERNAL` |
| `PAGE-FE-079` | 渠道账号 | `TARGET_EXTERNAL` |

### 3.5 互动、商机与洞察

| Page ID | 名称 | 建议阶段 |
|---|---|---|
| `PAGE-FE-080` | Unified Inbox | `TARGET_EXTERNAL` |
| `PAGE-FE-081` | 会话详情 | `TARGET_EXTERNAL` |
| `PAGE-FE-082` | Opportunity 列表/看板 | `TARGET_EXTERNAL` |
| `PAGE-FE-083` | Opportunity 详情 | `TARGET_EXTERNAL` |
| `PAGE-FE-084` | 经营洞察 | `TARGET_EXTERNAL` |
| `PAGE-FE-085` | 归因与实验 | `TARGET_EXTERNAL` |
| `PAGE-FE-086` | 成本与用量 | `TARGET_EXTERNAL`；Site 局部事实可引用 |

### 3.6 管理与运营

| Page ID | 名称 | 建议阶段 |
|---|---|---|
| `PAGE-FE-090` | 成员与角色 | `TARGET_EXTERNAL` |
| `PAGE-FE-091` | 数据范围与委派 | `TARGET_EXTERNAL/OPEN_DECISION` |
| `PAGE-FE-092` | 集成中心 | `TARGET_EXTERNAL` |
| `PAGE-FE-093` | Workspace 设置 | `TARGET_EXTERNAL` |
| `PAGE-FE-094` | 安全与审计 | `TARGET_EXTERNAL` |
| `PAGE-FE-095` | 套餐、用量与账单 | `TARGET_EXTERNAL/OPEN_DECISION` |
| `PAGE-FE-096` | 运营控制台 | `TARGET_EXTERNAL` |

该索引共 76 个稳定 Page ID；缺号是预留，不代表遗漏。新增页面先证明既有 Page/Capability 不能承载，并更新 Registry/Decision，而不是直接占一个菜单入口。

## 4. 独立站管理页面边界

| 子区 | Page IDs | 当前用户承诺 |
|---|---|---|
| Site 入口/Intake | `030..033` | Site 列表/概览、最少 intake、安全 Demo 的合同相称体验 |
| 资料与信任 | `034..039` | Profile 分组保存、Asset 上传/处理、KB 汇总；Claim 必须 fail-closed |
| Build 与开发预览 | `040..044` | 合同允许的 scope/style/locale、状态/成本/取消/恢复、可信开发预览；质量结果诚实表达 |
| 设计与内容编辑 | `045..047` | `APPROVED_NOT_BUILT`；不得从 SiteSpec 地基推导编辑器已存在 |
| Release/Publish/Domain | `048..052` | 后置；内部 Release 不等于用户选版、公开发布、回滚或域名 |
| Inquiry/Analytics/Diagnosis | `053..056` | deferred/blocked；不在首个纵切 |
| Astro 公开输出 | `057` | 方向已批准，完整公开输出/生产门在 Phase 5+ |

页面级首次、空、无权、等待、失败、取消、冲突、degraded、stale 和移动状态属于 Phase 5，不在本表用一句“支持”代替。

## 5. Page Manifest 合同

每个进入设计/实现的 Page 必须有一条 manifest：

| 字段 | 要求 |
|---|---|
| `page_id/name/area` | 稳定 ID、用户名称、所在 IA |
| `primary_actor/job/outcome` | 谁为何进入，完成定义是什么 |
| `capability_ids/object_ids` | 引用 Registry，不新造同义 ID |
| `canonical_route/deep_link` | 稳定对象 URL；未定路由写 `OPEN_DECISION` |
| `entry/exit/primary_action` | 第一屏和主动作；危险动作分开 |
| `states` | 引用 `STATE-FE-*` 并补业务特有差异 |
| `permissions/allowed_actions` | 服务端来源、数据范围、不可泄漏策略 |
| `contracts/events` | operationId/event/schema version；无合同写 `NONE/BLOCKED` |
| `design_asset_ids/copy_ids` | 对应受控资产和微文案 |
| `responsive/a11y/performance` | 模式、预算、测试和例外 |
| `scenario/fixture/metric_ids` | 验收、数据和学习关系 |
| `owner/status/last_verified` | 产品、设计、前端、QA 各责任；多轴状态 |

## 6. 页面是否可以出现在产品里

页面进入导航必须同时满足产品批准、真实部署、用户 entitlement、服务端授权和必要配置；缺一不可。只有 Mock、只有 API、只有设计稿、只有菜单入口都不能标 `AVAILABLE`。产品已批准但暂不可用时，只有能提供明确原因和下一步的页面才使用 `UNAVAILABLE_WITH_REASON`；否则保持 `NOT_OFFERED`。

## 7. 防漂移规则

- 新页面优先映射既有 Capability/Object；不能因增加一个表格或 AI 助手就创建新产品域。
- 聚合页不复制业务对象状态；详情、编辑、批准和危险动作回 canonical object。
- 模块页面目录只记录差异；完整 page family 的历史论证见 [Phase 2 目录](../roadmap/saas-frontend-phase-2/page-and-capability-catalog.md)。
- 路由名、页面数、代码目录和后端 Controller 数都不是产品完整度指标。
