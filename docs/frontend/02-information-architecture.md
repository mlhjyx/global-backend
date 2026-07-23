# 统一 SaaS 信息架构

> 文档 ID：`FE-GLOBAL-003`
> 层级：`L2 / Normative target`
> 生命周期：`CURRENT`
> 批准：`APPROVED_WITH_CONDITION`
> 内容 Owner：`OWN-PRODUCT`
> 批准来源：`DEC-FE-P2-003`、`DEC-FE-P2-006`、`DEC-FE-P9-019`、`DEC-FE-P9-020`
> Phase 9 successor：2026-07-23 用户确认完整管理员视图 `8` 个一级 / `38` 个二级

## 1. 顶层 IA

```text
统一 SaaS
├─ 今日
├─ 企业资料
├─ 客户开发
├─ 独立站
├─ 增长执行
├─ 互动与商机
├─ 洞察
└─ 管理与设置

业务导航：7 个一级 / 30 个二级
管理导航：1 个一级 / 8 个二级
全局 Shell 控件：Workspace / Search / Quick Create / Work Center / Notifications / Help / User
企业与对象上下文：Company / Offering / Claim / Evidence / Asset / Activity / Related objects
受控内部入口：Operations Console
```

一级入口代表持续业务责任，不按后端 module、Agent、OSS 或历史 Word 章节拆分。冻结、后置、未购买或未部署能力仍保留在产品地图中，但日常入口由服务端 capability/entitlement/allowed actions 决定。

## 2. 一级区域职责

| Area ID | 区域 | 用户问题 | 拥有/引用对象 | 边界 |
|---|---|---|---|---|
| `AREA-FE-001` | 今日 | 我现在最该处理什么 | Task/Approval/Incident 等读模型 | 不创建另一套业务状态 |
| `AREA-FE-007` | 企业资料 | 我们是谁、提供什么、哪些资料可信且可复用 | Company/Profile/Offering/Claim/Evidence/Asset/KnowledgeSource | canonical 工作区；Site、内容、客户开发和会话只消费引用/投影 |
| `AREA-FE-002` | 客户开发 | 去哪里、找谁、为什么现在 | Market/ICP/Company/Lead/package | 本仓止于 `LeadQualifiedPackage`；新增后端开发冻结 |
| `AREA-FE-003` | 独立站 | 如何建立并持续运营可信海外站 | Site/Profile/Asset/KB/Claim/Build/Version/Release | Astro 输出不是平行 SaaS；当前承诺止于开发预览 |
| `AREA-FE-004` | 增长执行 | 如何把目标转成受控动作 | Initiative/Campaign/Audience/Content/PublishJob | SoR/实现归 SaaS；本仓不补造 |
| `AREA-FE-005` | 互动与商机 | 如何处理响应并推进商业结果 | Conversation/Opportunity/Outcome | 归 SaaS；Site 只在后续产生 Inquiry 接缝 |
| `AREA-FE-006` | 洞察 | 哪些投入有效、哪里需调整 | Read models/Experiment/Metric | 不拥有源对象；不能用 Mock 图表充当事实 |

“管理与设置”是第八个侧栏一级入口，但不是业务价值域。它承载 Workspace/成员/委派/集成/AI 策略/安全/账单/数据退出等控制责任；个人偏好仍从 User menu 进入，平台运营仍使用独立内部 Shell。

## 3. 二级导航 Manifest

| 一级 | 数量 | 二级入口 |
|---|---:|---|
| 今日 | 4 | 工作台、任务、审批、运行与异常 |
| 企业资料 | 5 | 企业概览、产品与服务、资料与知识、事实与证据、素材中心 |
| 客户开发 | 4 | 市场与 ICP、客户池、发现任务、数据权利 |
| 独立站 | 5 | 站点列表、建站任务、版本与发布、域名与托管、表现与维护 |
| 增长执行 | 5 | 目标与活动、内容工作室、媒体工作室、发布与日历、销售触达 |
| 互动与商机 | 3 | 公开互动、统一收件箱、商机 |
| 洞察 | 4 | 经营洞察、归因与实验、成本与用量、指标与数据质量 |
| 管理与设置 | 8 | Workspace 与组织、成员与角色、数据范围与委派、集成与 API、AI 工作策略、安全与审计、套餐/用量与账单、数据导出与关停 |
| **合计** | **38** | 详情页、Drawer、向导、Run 和 Saved View 不计入二级导航 |

其中媒体工作室、销售触达、公开互动、指标与数据质量、AI 工作策略、数据导出与关停仍是 `PROPOSED`；Gate 未关闭时不进入日常可用导航，不能因 IA 有位置就冒充已实现。

## 4. 企业资料与横切消费

Company/Offering/Claim/Evidence/Asset/KnowledgeSource 是共享企业事实底座，也具有持续维护、审核、撤销和影响分析责任，因此“企业资料”是独立一级业务入口，但不建立第二份真值：

- “企业资料”提供 canonical 编辑、审核、撤销和影响入口；
- Site、Content、Campaign、销售资料等页面都引用同一对象并可深链；
- 编辑、批准、撤销和删除只发生在 canonical object；下游只做引用和影响提示；
- Evidence drawer 是跨页面视图，不复制 Claim/Evidence；
- Team、Integration、Billing、Security 是管理域，不混入业务一级导航。

## 5. 对象、聚合与输出的层级

| 类型 | 例子 | URL/状态规则 |
|---|---|---|
| Canonical object | Company、Site、BuildRun、Opportunity | 稳定 URL；服务端验证 Workspace/permission；对象主页拥有状态与动作 |
| Aggregate/read model | Today、Approvals、Incidents、Insights | 每项深链到对象；允许独立局部失败；不拥有源状态 |
| Task surface | Intake、upload、Build wizard | 可刷新/跨设备恢复到 Run/Object；会话内草稿不是唯一真相 |
| Versioned output | SiteRelease/Astro preview/public output | 与管理前端身份和 cookie 隔离；Preview/Publish/Domain 分层 |
| Internal control | Operations Console | 独立 entitlement、审计、告知和最小权限；不得伪装普通用户 UI |

## 6. 深链与上下文合同

所有业务链接都应携带足以解析的 Workspace + object/run identity，但不能在 URL 泄漏敏感内容。打开时：

1. 恢复或选择 Workspace；
2. 服务端鉴权并判断对象是否可见；
3. 403/404 按信息泄漏策略表达；
4. 恢复 canonical object 和来源筛选；
5. 若对象 stale/archived/deleted/retained，展示准确状态与可用动作；
6. 无法完成重操作的移动端深链提供安全摘要和“在桌面继续”，不丢任务。

聚合页到对象使用来源上下文辅助返回，但 canonical URL 不依赖来源。浏览器 Back 应恢复原筛选/分页；通知、邮件或支持链接不得把用户送到无对象上下文的泛化首页。

## 7. 独立站内部 IA

```text
独立站
├─ 站点列表
└─ Site Workspace
   ├─ 概览
   ├─ 资料引用
   ├─ 设计与内容
   ├─ 构建与预览
   ├─ 版本与发布
   ├─ 域名与托管
   ├─ 询盘与表现
   └─ 设置

二级能力：站点诊断（M3+，不是注册分支）
```

Phase 4 只固定该层级与边界。PAGE-FE-030..057 的页面级流程、状态和设计资产在 Phase 5 完成；未建子区域不得以空白 Tab 冒充可用能力。

## 8. 入口可见性

| 状态 | 导航表现 | 要求 |
|---|---|---|
| `AVAILABLE` | 正常入口 | 部署、权限、entitlement、配置都满足 |
| `UNAVAILABLE_WITH_REASON` | 在有解释价值时可见 | 指明权限/套餐/地区/配置原因和安全下一步 |
| `NOT_OFFERED` | 不进日常导航 | 未批准、未部署或冻结且无当前任务；仍在 Registry/产品地图 |

上述状态只决定产品表达，不是授权。前端不得只靠隐藏入口保护数据，也不得在 capability manifest 缺失时默认点亮。

## 9. IA 验证

Gate 5 已批准 Site 书面流程；Phase 9 已完成 76/76 Page、36/36 Feature Candidate 和 24/24 Page Family 的唯一主落点审计。正式实装前仍应使用 `RES-FE-003..007` 和至少以下任务走查：首次找 Site、从 Today 恢复失败 Build、从 Approval 进入 Claim、跨 Workspace 切换、从 Company 追到 Site 引用、从通知返回原筛选。若真实用户研究推翻入口名称或优先级，先登记 Decision；不能仅改侧栏代码。

完整逐页落点、对象 Tab、公共/帮助/运营表面与候选状态见 [Phase 9 信息架构与遗漏覆盖审计](../roadmap/saas-frontend-phase-9/information-architecture-and-coverage-audit.md)。
