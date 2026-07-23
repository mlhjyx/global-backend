# Phase 9 全产品信息架构与遗漏覆盖审计

> 文档 ID：`AUD-FE-P9-006`
> 层级：`L3 / Product IA audit and design successor`
> 状态：`DRAFT`
> 批准：`APPROVED_WITH_CONDITION`
> 评审阶段：`STRUCTURE_APPROVED / FIGMA_CORE_SYNC_COMPLETED`
> 产品 Owner：`OWN-PRODUCT`
> 设计 Owner：`OWN-DESIGN`
> 关联决定：`DEC-FE-P9-019`、`DEC-FE-P9-020`
> 最后核验：2026-07-23

## 1. 本轮不是从五张图拼菜单

五张用户确认界面只批准布局密度、层级、色彩和交互模式，不批准其中任何一张的导航、业务对象、示例字段或数量。本轮信息架构按以下证据重新归类：

- `36/36` 项 Phase 9 Feature Candidate；
- `24/24` 个 Phase 9 Page Family；
- `76/76` 个稳定 Page ID；
- 8 个 current Capability Pack；
- 10 条跨域 Handoff；
- current OpenAPI 的 64 个 operation 分类结果；
- 公共站、身份、SaaS、生成站、帮助/开发者和平台运营六种产品表面。

归类门固定为：持续用户责任、canonical 对象/投影、独立生命周期、稳定深链、权限边界和可解释退出。页面多、后端 module 多、Provider 多或参考图出现某个栏目，都不能单独形成一级导航。

## 2. 推荐结构与精确数量

### 2.1 SaaS 主产品

推荐的**完整管理员桌面侧栏**为 **8 个一级入口、38 个二级入口**：

- 7 个一级业务入口，对应 30 个二级业务入口；
- 1 个一级“管理与设置”入口，对应 8 个二级管理入口；
- 另有 7 个全局 Shell 控件，它们不计入一级/二级导航。

普通成员最多看到 7 个业务一级入口；“管理与设置”及其子项按 `allowed actions` 显示。权限不足不是把栏目画成可点击后再报错：导航投影在服务端能力结果基础上隐藏不可发现项，对已知但暂不可操作的对象使用只读/受限状态。

一级业务入口固定顺序：

1. 今日；
2. 企业资料；
3. 客户开发；
4. 独立站；
5. 增长执行；
6. 互动与商机；
7. 洞察。

“管理与设置”是第 8 个**侧栏一级入口**，但不是第八个业务价值域。个人设置由用户菜单进入；平台运营使用独立内部 Shell；公共站、身份、帮助/开发者和客户生成站不进入 SaaS 主导航。

### 2.2 为什么是七个

| 判断门 | 今日 | 企业资料 | 客户/站点/增长/互动 | 洞察 | 管理与设置 | Provider/AI/渠道 |
|---|---|---|---|---|---|---|
| 持续用户责任 | 有：处理跨域行动 | 有：维护可复用企业真相 | 有：各自完成业务结果 | 有：解释结果与投入 | 有控制责任，但非业务价值流 | 无，只提供执行或配置 |
| canonical 对象/投影 | Task/Approval/Run 投影 | Company/Offering/Claim/Evidence/Asset/Knowledge | 各域聚合根 | Metric/read model | Membership/Policy/Connection/Billing | 外部引用/执行映射 |
| 独立生命周期和深链 | 有 | 有 | 有 | 有 | 有，进入管理 Shell | 进入集成或运营详情 |
| 一级业务导航 | 是 | 是 | 是 | 是 | 否 | 否 |

“企业资料”升为一级入口不建立第二份企业数据。它是 Company、Profile、Offering、Claim、Evidence、Asset 和 KnowledgeSource 的 canonical 工作区；Site、内容、客户开发、会话和洞察只消费引用、快照、Drawer 与深链。

## 3. SaaS 一级与二级导航 Manifest

### 3.1 完整树

| 一级入口 | 二级数量 | 二级入口 | 稳定 Page / 页面族主归属 | 设计边界 |
|---|---:|---|---|---|
| 今日 | 4 | 工作台；任务；审批；运行与异常 | `PAGE-FE-003/006..009`；`PFAM-P9-004` | Search、通知和帮助属于 Shell；任务必须回到源对象 |
| 企业资料 | 5 | 企业概览；产品与服务；资料与知识；事实与证据；素材中心 | `PAGE-FE-020..026`；`PFAM-P9-006` | `PAGE-FE-025` 的准备度不单独成页；动态 gaps 回到概览/任务 |
| 客户开发 | 4 | 市场与 ICP；客户池；发现任务；数据权利 | `PAGE-FE-060..066`；`PFAM-P9-012` | Company/Lead 详情是对象页，不再复制一个二级“详情”；整体保持冻结地图 |
| 独立站 | 5 | 站点列表；建站任务；版本与发布；域名与托管；表现与维护 | `PAGE-FE-030..056`；`PFAM-P9-007..010` | 导入从站点创建进入；编辑器在 Site 对象内；公开站 `057` 不是管理入口 |
| 增长执行 | 5 | 目标与活动；内容工作室；媒体工作室；发布与日历；销售触达 | `PAGE-FE-070..079`；`PFAM-P9-013..015/017` | 社交发布与一对一触达使用不同生命周期；账号连接回管理控制面 |
| 互动与商机 | 3 | 公开互动；统一收件箱；商机 | `PAGE-FE-080..083`；`PFAM-P9-016/018/019` | 公开评论与私密会话分队列；不新增 RFQ/工程/报价聚合 |
| 洞察 | 4 | 经营洞察；归因与实验；成本与用量；指标与数据质量 | `PAGE-FE-084..086`；`PFAM-P9-020`；指标目录为候选子表面 | 没有 MetricDefinition/水位/权限时显示不可用，不显示 Mock KPI |
| **合计** | **30** | — | 覆盖全部 SaaS 业务页面族 | 详情页、Drawer、向导步骤和筛选视图不计为二级导航 |

桌面侧栏不会同时展开 30 项：默认只显示 7 个一级入口，当前一级域展开其 3–5 个二级入口；对象工作台打开后，二级入口保持稳定，对象 Tab 出现在对象头下方。1280 以下一级导航进入可访问抽屉；移动底栏最多保留“今日 + 当前高频域 + 两个快捷入口 + 更多”，完整结构在“更多”抽屉中可达。

完整管理员视图还在业务组下方显示“管理与设置”，所以最终侧栏总量是 **8 个一级 / 38 个二级**，不是 7/30。7/30 只描述业务导航子树。

### 3.2 “二级入口”不等于所有页面

下列内容不得为了“看起来完整”继续堆入侧栏：

- Company、Lead、Site、Campaign、Conversation、Opportunity 和 Provider Connection 的详情页使用稳定对象 URL 与对象 Tab；
- Intake、Import、OAuth、Publish Review、Data Export 等多步流程使用可恢复向导/Run；
- Evidence、影响、成本来源、同步健康和 AI 建议使用 Inspector/Drawer；
- Saved View、队列、筛选、状态和渠道不是二级导航；
- Provider 名称、模型名称和渠道名称不是产品信息架构。

### 3.3 76 个稳定 Page ID 的导航落点

以下表逐项覆盖稳定 Page ID；一个 Page 只有一个主落点，但不强迫每个 Page 都成为侧栏入口。

| 导航/表面落点 | 稳定 Page ID | 访问形态 | 结论 |
|---|---|---|---|
| 身份与会话 | `PAGE-FE-001` | 独立身份流程 | 不进入 SaaS 侧栏 |
| Workspace 切换 | `PAGE-FE-002` | Shell | 不复制为业务二级入口 |
| 今日 / 工作台 | `PAGE-FE-003` | 二级入口 | 保留 |
| Search / Command | `PAGE-FE-004` | Shell | 不进入侧栏 |
| 通知 | `PAGE-FE-005` | Shell + 全页中心 | 全页从 Shell 深链进入 |
| 今日 / 任务 | `PAGE-FE-006` | 二级入口 | 保留 |
| 今日 / 审批 | `PAGE-FE-007` | 二级入口 | 保留 |
| 今日 / 运行与异常 | `PAGE-FE-008/009` | 二级入口 + Run 详情 | 合并导航，不合并对象状态 |
| 帮助与支持 | `PAGE-FE-010` | Shell / 独立帮助表面 | 不进入业务侧栏 |
| 企业资料 / 企业概览 | `PAGE-FE-020/025` | 二级入口 + 概览投影 | `025` 不再独立成固定准备度页 |
| 企业资料 / 产品与服务 | `PAGE-FE-021` | 二级入口 + Offering 对象 | 保留 |
| 企业资料 / 事实与证据 | `PAGE-FE-022/023` | 二级入口 + Evidence Drawer | Drawer 不占侧栏 |
| 企业资料 / 资料与知识 | `PAGE-FE-024` | 二级入口 | 动态 Manifest/抽取/缺口，不固化行业规格 |
| 企业资料 / 素材中心 | `PAGE-FE-026` | 二级入口 + Asset 详情 | 保留 |
| 独立站 / 站点列表 | `PAGE-FE-030/031` | 二级入口 + Site 对象 | Site 概览不是第二个列表入口 |
| 独立站 / 建站任务 | `PAGE-FE-032..044` | 二级入口 + 向导/Run/恢复/预览 | 按真实产品状态显隐 |
| Site 对象 / 设计与内容 | `PAGE-FE-045..047` | Site Tab / 编辑器深链 | 不加入全局二级导航 |
| 独立站 / 版本与发布 | `PAGE-FE-048..050` | 二级入口 + Review/Run | 当前 `TARGET_NOT_RUNNABLE` |
| 独立站 / 域名与托管 | `PAGE-FE-051` | 二级入口 + 绑定详情 | 当前 `TARGET_NOT_RUNNABLE` |
| Site 对象 / 设置 | `PAGE-FE-052` | Site Tab | 不加入全局管理设置 |
| 独立站 / 表现与维护 | `PAGE-FE-053..056` | 二级入口 + 设置/询盘/分析/诊断子页 | 按状态分层，不冒充已建 |
| 客户生成站 | `PAGE-FE-057` | 无 SaaS Shell 的公开输出 | 不是管理页 |
| 客户开发 / 市场与 ICP | `PAGE-FE-060..062` | 二级入口 + 研究/ICP 对象 | 保留冻结边界 |
| 客户开发 / 客户池 | `PAGE-FE-063/064` | 二级入口 + Lead 对象 | 联系人放对象 Tab，不另建一级栏目 |
| 客户开发 / 发现任务 | `PAGE-FE-065` | 二级入口 + Run | 保留 |
| 客户开发 / 数据权利 | `PAGE-FE-066` | 二级入口 + 受控运营 Handoff | 与账号关停分开 |
| 增长执行 / 目标与活动 | `PAGE-FE-070..074` | 二级入口 + Campaign 对象 | `TARGET_EXTERNAL` |
| 增长执行 / 内容工作室 | `PAGE-FE-075/076` | 二级入口 + Content 对象 | `TARGET_EXTERNAL` |
| 增长执行 / 发布与日历 | `PAGE-FE-077/078` | 二级入口 + Publish Run | `TARGET_EXTERNAL` |
| 管理与设置 / 集成与 API | `PAGE-FE-079/092` | 二级入口 + Connection 对象 | 渠道凭证只在连接控制面维护 |
| 互动与商机 / 统一收件箱 | `PAGE-FE-080/081` | 二级入口 + Conversation 对象 | `TARGET_EXTERNAL` |
| 互动与商机 / 商机 | `PAGE-FE-082/083` | 二级入口 + Opportunity 对象 | 不新增 RFQ 聚合 |
| 洞察 / 经营洞察 | `PAGE-FE-084` | 二级入口 | `TARGET_EXTERNAL` |
| 洞察 / 归因与实验 | `PAGE-FE-085` | 二级入口 | `TARGET_EXTERNAL` |
| 洞察 / 成本与用量 | `PAGE-FE-086` | 二级入口 | Site 局部事实与平台目标态分开 |
| 管理与设置 / 成员与角色 | `PAGE-FE-090` | 二级入口 | 保留 |
| 管理与设置 / 数据范围与委派 | `PAGE-FE-091` | 二级入口 | 保留 |
| 管理与设置 / Workspace 与组织 | `PAGE-FE-093` | 二级入口 | 保留 |
| 管理与设置 / 安全与审计 | `PAGE-FE-094` | 二级入口 | 保留 |
| 管理与设置 / 套餐、用量与账单 | `PAGE-FE-095` | 二级入口 | 保留 |
| 平台运营控制台 | `PAGE-FE-096` | 独立内部 Shell | 不进入客户 Workspace 管理 |

覆盖结论：`76/76` 个稳定 Page ID 均有且只有一个主落点；其中侧栏二级入口、对象页、Shell、Drawer、向导/Run、独立表面和公开输出被明确区分。

### 3.4 没有稳定 Page ID、但完整产品需要保留的 6 个二级候选

| 二级候选 | 归属 | 当前状态 | 进入正式 Page ID 的门 |
|---|---|---|---|
| 媒体工作室 | 增长执行 | `PROPOSED` | MediaJob、RightsRecord、Provider 合同与退出完成评审 |
| 销售触达 | 增长执行 | `PROPOSED` | 与社交发布分离的生命周期、审批、回执和 SoR 获批 |
| 公开互动 | 互动与商机 | `PROPOSED` | PublicInteraction、审核、隐藏、升级私聊和回执合同获批 |
| 指标与数据质量 | 洞察 | `PROPOSED` | MetricDefinition、freshness、lineage、权限和事件 Owner 获批 |
| AI 工作策略 | 管理与设置 | `PROPOSED` | 任务档位、预算、allowed model aliases 与运营路由边界获批 |
| 数据导出与关停 | 管理与设置 | `PROPOSED` | ExportJob、保留/删除、审计、撤销窗口和 Provider 退出获批 |

它们被纳入 38 个二级目标结构，是为了避免未来被挤成临时入口；但在 Gate 关闭前必须以 unavailable/coming-later 设计或不显示，不能冒充已实现功能。

## 4. 对象页三级标签

三级标签只在进入 canonical object 后出现，不能替换全局一级/二级导航。

| 对象工作台 | Tab 数量 | Tab |
|---|---:|---|
| 企业 | 7 | 概览；基础资料；产品与服务；资料与知识；事实与证据；素材；影响与活动 |
| 客户/Lead | 7 | 概览；身份；信号与证据；联系人与可达性；资格；Package 与交接；活动与权利 |
| Site | 8 | 概览；资料引用；设计与内容；构建与预览；版本与发布；域名与托管；询盘与表现；设置 |
| Campaign | 8 | 概览；受众；内容；渠道与排期；审核；执行授权；回执；洞察 |
| Conversation | 4 | 对话；客户上下文；相关内容与触点；活动与审计 |
| Opportunity | 6 | 概览；资格；互动；下一步；结果；活动 |
| Provider Connection | 7 | 概览；能力与 Scope；资源绑定；同步与 Webhook；凭证与轮换；用量与成本；审计与退出 |

这些 Tab 是目标 IA，不是 current API 声明。`Conversation/Opportunity/Campaign/Provider Connection` 仍按 `TARGET_EXTERNAL/PROPOSED/CONTRACT_BLOCKED` 表达；Site 的后置 Tab 保持 `TARGET_NOT_RUNNABLE`。

## 5. 管理、个人和全局 Shell

### 5.1 管理与设置：8 个二级入口

| 次序 | 管理入口 | Page / 页面族 | 不得混入 |
|---:|---|---|---|
| 1 | Workspace 与组织 | `PAGE-FE-093`、`PFAM-P9-021` | 个人偏好 |
| 2 | 成员与角色 | `PAGE-FE-090` | 平台运营的 support access |
| 3 | 数据范围与委派 | `PAGE-FE-091` | 客户数据权利处理队列 |
| 4 | 集成与 API | `PAGE-FE-092`、`PFAM-P9-022` | Aitoearn/Chatwoot/BaoTa 后台 UI |
| 5 | AI 工作策略 | `PFAM-P9-021/024` 的 Workspace 管理投影 | new-api Base URL、密钥、原始 Provider 路由 |
| 6 | 安全与审计 | `PAGE-FE-094` | 普通成员的私有草稿/消息原文 |
| 7 | 套餐、用量与账单 | `PAGE-FE-095` | 洞察的业务指标真值 |
| 8 | 数据导出与关停 | `PFAM-P9-023` 候选子表面 | 简化成“删除账号”按钮 |

个人中心不占管理侧栏，固定为 4 个 Tab：个人资料与语言、通知偏好、会话与个人安全、我的 Workspace。平台级模型路由、Provider/source policy、Webhook redrive 和事故处置不进入 Workspace 管理。

### 5.2 全局 Shell：7 个入口

| Shell 入口 | 承载内容 |
|---|---|
| Workspace switcher | 当前 Workspace、最近、代理/环境状态和切换确认 |
| Search / Command | 权限过滤对象、最近访问和安全命令预览 |
| Quick Create | 按当前能力显示 Site、任务、内容等安全创建入口 |
| Work Center | 任务、审批、长任务和事故的摘要与深链 |
| Notifications | 去重通知、来源、新鲜度、对象深链和偏好 |
| Help / Feedback | 上下文帮助、脱敏诊断、反馈与支持 |
| User menu | 个人设置、会话安全、Workspace 和退出 |

`Work Center` 是聚合入口，完整任务/审批/运行页面仍归“今日”。Shell 数量是视觉入口数，不改写 `SHELL-FE-001..008` 的能力登记。

## 6. SaaS 之外的完整导航

### 6.1 产品公共站：6 个一级栏目

产品；制造业解决方案；客户案例；资源；定价；信任中心。登录和开始使用是操作，不计为栏目；公司介绍、法律、隐私、状态和联系入口进入页脚或上下文链接。

### 6.2 帮助与开发者：6 个一级栏目

学习入门；操作指南；概念说明；API 参考；更新日志；系统状态。支持/诊断是上下文动作，不与文档分类混成第七栏。内容遵循 Tutorial、How-to、Explanation、Reference；没有真实 UI 时不伪写逐步操作。

### 6.3 身份与 Onboarding

身份页和 Onboarding 不使用持久产品导航。它们采用可恢复步骤：注册/登录 → 验证/MFA → Workspace → 最少企业资料 → 目标选择 → 上传/导入 → 安全 Demo → 进入首个业务域。企业资料导入、Site Import 和数据退出分别回到其 canonical 域，不合成万能“迁移中心”。

### 6.4 平台运营控制台：8 个一级栏目

运营总览；Provider 与连接；模型与路由；来源策略；Webhook 与同步；Workflow 与事件；事故与恢复；数据权利与清理。该 Shell 只供内部运营/安全角色，不出现在普通用户 Figma 导航中。

### 6.5 客户生成站

生成站不能规定一个跨行业固定栏目数。导航由 approved content graph 与 TemplateFamily 生成：`首页` 和 `联系/询盘` 是固定职责；产品/服务、能力、行业/应用、信任/资质、资源、关于等为条件化栏目。每站桌面主导航建议 5–7 项，超过时重组内容树，不把后台业务导航套到公开站。

## 7. 36 项功能候选的去向核对

| Candidate 范围 | 唯一去向 | 结果 |
|---|---|---|
| `001` | 产品公共站 | 覆盖 |
| `002..004` | 身份/Onboarding/上下文导入 | 覆盖；不进 SaaS 一级导航 |
| `005..006` | 今日 + Shell | 覆盖 |
| `007..010` | 企业资料 | 覆盖；独立准备度页拒绝并折叠 |
| `011..014` | 客户开发 | 覆盖；保持冻结/数据权利分层 |
| `015..021` | 独立站 + 生成站 | 覆盖；Preview/Publish/Domain/Inquiry 状态分层 |
| `022..024/026` | 增长执行 | 覆盖；社交发布与销售触达分离 |
| `025/028/030` | 互动与商机 | 覆盖；公开/私密/商机分离 |
| `027/032..034` | 管理与设置 | 覆盖；连接、AI、账单和退出分层 |
| `029` | 当前拒绝 | 不进入导航；外部工程系统只显示受权状态/deep link |
| `031` | 洞察 | 覆盖 |
| `035` | 平台运营 | 覆盖；普通用户不可见 |
| `036` | 帮助与开发者 | 覆盖 |

结论：`36/36` 候选均有唯一主归属；没有为了容纳一项功能增加 Provider、AI、渠道、导入、客服或媒体等一级栏目。

## 8. 24 个页面族的唯一主归属

| 页面族 | 主归属 | Shell 模式 |
|---|---|---|
| `PFAM-P9-001` | 产品公共站 | no shell |
| `PFAM-P9-002` | 身份 | no shell |
| `PFAM-P9-003` | Onboarding | compact shell |
| `PFAM-P9-004` | 今日 | full shell |
| `PFAM-P9-005` | 帮助与开发者 | no shell / utility |
| `PFAM-P9-006` | 企业资料 | full shell |
| `PFAM-P9-007..010` | 独立站 | full shell |
| `PFAM-P9-011` | 客户生成站 | no shell |
| `PFAM-P9-012` | 客户开发 | full shell |
| `PFAM-P9-013..015/017` | 增长执行 | full shell |
| `PFAM-P9-016/018/019` | 互动与商机 | full shell |
| `PFAM-P9-020` | 洞察 | full shell |
| `PFAM-P9-021..023` | 管理与设置 | management shell |
| `PFAM-P9-024` | 平台运营 | internal shell |

该表覆盖 `24/24` 页面族且每项只有一个主归属。跨域消费统一通过对象引用、Inspector、Drawer、Receipt 或 canonical deep link，禁止复制编辑状态。

## 9. 遗漏、冲突与处置

| Finding ID | 遗漏/冲突 | 处置 |
|---|---|---|
| `FIND-FE-P9-IA-001` | 原 L2 把企业资料写成横向入口，但已有 7 个 Page、canonical 对象和持续维护责任 | 提升为一级业务入口；不复制对象 |
| `FIND-FE-P9-IA-002` | 五张参考图的一级/二级名称、数量、顺序不一致 | 只继承视觉模式；导航以本 Manifest 为唯一设计输入 |
| `FIND-FE-P9-IA-003` | Unified Inbox 使用局部产品菜单，像独立客服系统 | 使用全产品 Shell；队列、渠道和 SLA 留在 Inbox 页内 |
| `FIND-FE-P9-IA-004` | 洞察 Design Page 原为空 | 已补 `61:2` 指标可用性代表页；未知不显示为 0，指标定义/水位/权限/新鲜度不足时不生成趋势或归因结论 |
| `FIND-FE-P9-IA-005` | 移动底栏无法容纳完整产品域 | 底栏保留高频/当前域，增加“更多”抽屉覆盖 7 域和管理入口 |
| `FIND-FE-P9-IA-006` | 导入/迁移/退出被当成同一功能 | Onboarding 导入、企业资料导入、Site Import 和数据退出分别归属 |
| `FIND-FE-P9-IA-007` | 渠道账号在增长和集成页重复管理 | 连接/Scope/轮换/退出只在管理；任务页只选已绑定能力 |
| `FIND-FE-P9-IA-008` | 参考图把客户上下文、AI 助手、指标卡当侧栏栏目 | 这些是 Inspector/Drawer/对象投影，不是一级/二级导航 |
| `FIND-FE-P9-IA-009` | AI Task Strategy 有代表页但没有正式 IA 归属 | Workspace 管理提供任务档位/预算；平台运营掌握真实路由/密钥 |
| `FIND-FE-P9-IA-010` | 帮助、开发者、状态、平台运营容易塞进 SaaS 主侧栏 | 使用独立产品表面和权限 Shell |

## 10. Figma 与验收门

- 桌面全产品 Shell 固定七项顺序，所有代表页一致；二级导航按本文件，不从参考图抄录。
- 页面选中态必须跟随一级域、二级任务和对象三层，三种状态视觉上可区分。
- 管理与设置位于业务组之外；个人设置位于用户菜单；平台运营使用独立 Shell。
- 移动端不强求七项常驻，但“更多”必须可达全部七域、管理、帮助和退出。
- 每个一级域至少有一张高保真代表；每类对象工作台至少有一张注释线框。
- blocked、frozen、target、proposed 和 backend-only 必须在页面 Manifest 与 Frame 名称中表达，不绘制成已经可执行。
- 在本结构完成产品评审前，不批量修改现有 Figma 侧栏；先建立 IA 总览、导航组件和一张相反场景验证页。
