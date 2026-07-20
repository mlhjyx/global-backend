# 成功指标、反指标与埋点假设

> 文档 ID：`BASE-FE-P2-006`
> 状态：`READY_FOR_GATE_2_REVIEW`
> 事实基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 注意：本文件定义候选口径和验证方法，不批准 KPI 目标值、不选埋点供应商

## 1. 指标层级

产品范围已有两个承重结果方向：完整增长产品以“每活跃 Workspace 每月新增 QGO”为北极星，并以 QGO→SAO、Outcome、证据和风险护栏验证质量；独立站管理的产品方向是“可信站点被查看、补全、发布并带来有效询盘”。后者的发布和询盘当前未形成可用链，因此 Phase 2 需要区分当前可观测的领先指标与未来结果指标。

```text
平台结果
  └─ QGO / SAO / Verified Outcome（SaaS 目标）
模块结果
  └─ 可信站点发布并产生有效询盘（Site 目标）
领先行为
  └─ 安全 Demo → 资料/事实补全 → Build → 可信预览
能力健康
  └─ 完成、恢复、质量、成本、安全、可访问性
```

“后端 Build succeeded”“生成页数”“AI 调用次数”只是内部活动或健康信号，不是用户成功。

## 2. 平台级候选指标

| Metric ID | 指标 | 口径 | 状态/Owner |
|---|---|---|---|
| `MET-FE-001` | 每活跃 Workspace 月新增 QGO | 当月满足批准 QGO 资格且未重复的 Opportunity 数 / active Workspace | `FIXED_DIRECTION`；SaaS 产品/数据 Owner 待指定 |
| `MET-FE-002` | QGO→SAO 接受率 | 在观测窗内被销售接受的 QGO / 可接受 QGO | `FIXED_GUARDRAIL`；SaaS Opportunity SoR 依赖 |
| `MET-FE-003` | Outcome 回写完整率 | 在 7/30/90 天窗口有结构化结果的 SAO / 应回写 SAO | `FIXED_GUARDRAIL` |
| `MET-FE-004` | 首次价值时间 | Workspace 创建到首次完成批准的核心结果 | `OPEN_DEFINITION`；不同首批产品切口需拍板 |
| `MET-FE-005` | 自助完成率 | 无运营代操作完成核心旅程的 Workspace / 启动旅程 Workspace | `HYPOTHESIS`；需区分 Managed/Collaborative/Self-service |
| `MET-FE-006` | 任务失败后恢复率 | 在规定窗口内恢复且未重复产生副作用的失败任务 / 可恢复失败任务 | `RECOMMENDED_GUARDRAIL` |
| `MET-FE-007` | 未授权外部动作数 | 无有效 Approval/Authorization 的发送、发布、导出或删除 | 目标恒 0；`FIXED_SAFETY` |
| `MET-FE-008` | 错误身份/错误事实率 | 经人工/结果反馈确认错误的关键实体或公开 Claim / 被使用关键项 | `FIXED_QUALITY_DIRECTION` |

## 3. 独立站管理指标树

### 3.1 当前首个纵切可验证指标

| Metric ID | 指标 | 建议公式 | 观测窗口 | 需要的事件/事实 | 状态 |
|---|---|---|---|---|---|
| `MET-SITE-001` | Intake 提交成功率 | `unique successful intake / valid intake attempts` | 会话/日 | intake attempt/succeeded/error code | `RECOMMENDED` |
| `MET-SITE-002` | 安全 Demo 首次可预览时间 | `p50/p95(preview_ready_at - intake_accepted_at)` | 单次 | intake accepted、active READY Release 时间 | `RECOMMENDED`；P95<10s 仍需真实 E2E 证据 |
| `MET-SITE-003` | Demo 预览打开率 | `workspaces opened demo preview / workspaces with demo ready` | 24h/7d | preview ready、preview opened | `RECOMMENDED` |
| `MET-SITE-004` | 资料补全启动率 | `workspaces started profile/assets after preview / preview openers` | 7d | profile step opened、asset upload started | `HYPOTHESIS` |
| `MET-SITE-005` | 有意义资料完成率 | 达到批准的最小资料/信任门的 Site / 启动补全 Site | 7d/30d | 服务端 completeness/approved facts，不用纯前端字段数 | `OPEN_DEFINITION` |
| `MET-SITE-006` | 素材处理可用率 | `ready or duplicate-resolved assets / committed assets`，按 kind 分层 | 24h | Asset processingStatus | `RECOMMENDED_HEALTH` |
| `MET-SITE-007` | 首次精装修 Build 启动率 | `sites started first refurbish / sites reaching input readiness` | 7d | build create accepted | `HYPOTHESIS` |
| `MET-SITE-008` | 可用预览产出率 | `builds producing active READY preview accepted by user / eligible builds` | 单次/7d | Build terminal、Release active、preview opened/accepted | `RECOMMENDED_OUTCOME` |
| `MET-SITE-009` | 自助恢复率 | `recoverable failures resolved without operator / recoverable failures` | 24h/7d | failure class、recovery action、next successful result | `RECOMMENDED` |
| `MET-SITE-010` | 取消可信度 | `cancel requests reaching cancelled without new paid ops after cutoff / accepted cancel requests` | 单次 | cancel ACK、ledger、terminal state | `RECOMMENDED_GUARDRAIL` |
| `MET-SITE-011` | 事实支持率 | 被用户接受的公开文案关键事实中有 approved Claim/Evidence 的比例 | 每版本 | CopyBundle refs、Claim snapshot | `RECOMMENDED_QUALITY` |
| `MET-SITE-012` | Claim 修正率 | 用户纠正/撤销的机器候选 Claim / 被审机器候选 Claim | 版本/30d | Claim review outcomes | `HYPOTHESIS_LEARNING` |
| `MET-SITE-013` | Build 单位成本分布 | 每个产生可用预览的 Build 的 reported/calculated cost；unknown 单列 | 版本/月 | costSummary v1 | `RECOMMENDED_ECONOMICS` |
| `MET-SITE-014` | 可选 locale 降级率 | optional locale degraded/omitted builds / requested optional locale builds | 周/月 | CopyBundle status、Build steps | `RECOMMENDED_HEALTH` |

### 3.2 公开发布能力落地后才启用

| Metric ID | 指标 | 口径 | 前置 Gate |
|---|---|---|---|
| `MET-SITE-020` | 预览→发布转化率 | 首次可信预览后在窗口内完成 PublishReview 并上线的 Site / eligible Site | Public publish API/UI/production evidence |
| `MET-SITE-021` | 发布成功率 | 成功切换且健康检查通过的 publish attempts / authorized attempts | Release activate + health + rollback evidence |
| `MET-SITE-022` | 发布失败保站率 | 发布失败时旧在线版本仍健康的次数 / 发布失败次数 | Production routing/monitoring |
| `MET-SITE-023` | 域名首次可用时间 | domain setup accepted 到 HTTPS health passed | DNS/SSL ownership/SLA |
| `MET-SITE-024` | 回滚恢复时间 | incident/rollback requested 到旧版本 healthy | Public release/rollback contract |
| `MET-SITE-025` | 站点持续更新率 | 已发布 Site 在 30/90 天内至少一次受控更新的比例 | Version/publish history |

### 3.3 询盘能力落地后才启用

| Metric ID | 指标 | 口径 | 前置 Gate |
|---|---|---|---|
| `MET-SITE-030` | 首次有效询盘时间 | Site publish healthy 到首个通过 anti-abuse/consent 且人工有效的 Inquiry | Inquiry receiver + SaaS projection |
| `MET-SITE-031` | 有效询盘率 | 人工/规则确认有效的 Inquiry / 通过技术接收的 Inquiry | Validity rubric + feedback |
| `MET-SITE-032` | 询盘投递完整率 | 被 SaaS Conversation ACK 的 Inquiry / accepted Inquiry | Outbox delivery/ACK |
| `MET-SITE-033` | 询盘→QGO 转化 | 在归因窗口形成 QGO 的有效 Inquiry / 有效 Inquiry | Conversation/Opportunity SoR |
| `MET-SITE-034` | 垃圾/滥用漏过率 | 后续被判为 spam/abuse 的 accepted Inquiry / accepted Inquiry | Anti-abuse + review |

## 4. 反指标

| Anti-metric ID | 看似增长 | 为什么危险 | 应同时检查 |
|---|---|---|---|
| `ANTI-FE-001` | 页面/菜单数量增加 | 可能只是把 Mock 铺得更广 | 有真实对象/合同/用户任务的纵切完成率 |
| `ANTI-FE-002` | Build succeeded 比例高 | 用户可能没打开、不接受或内容 degraded | MET-SITE-008、011、014 |
| `ANTI-FE-003` | Demo 生成更快 | 可能牺牲事实安全或视觉可信 | 错误事实率、预览打开/继续率 |
| `ANTI-FE-004` | Profile 字段完成率高 | 可能用强制长表单换数字 | 首次价值时间、跳失、字段纠正率 |
| `ANTI-FE-005` | AI 生成次数/Token 增加 | 可能代表重复失败或低质量重做 | 可用结果/成本、修正距离、unknown cost |
| `ANTI-FE-006` | 发布站数量增加 | 可能存在未批准 Claim、坏表单或无维护 | PublishReview pass、健康、有效询盘、更新率 |
| `ANTI-FE-007` | 原始 Lead 数增加 | 不代表可联系、值得销售接受 | Reachability、LeadQualified、QGO→SAO |
| `ANTI-FE-008` | 通知/任务数量增加 | 可能是系统制造噪音 | 完成率、忽略率、time-to-action |
| `ANTI-FE-009` | 用户停留时间增加 | 企业工具里可能表示找不到状态/动作 | task completion、错误恢复、步骤数 |
| `ANTI-FE-010` | 运营人工“解决率”高 | 可能掩盖产品不能自助和单位经济失控 | 人工分钟/Workspace、自助恢复、重复问题 |

## 5. 事件与属性假设

事件命名只是逻辑登记，Phase 4/5 才形成正式 analytics contract。不得在未选择埋点平台前引入 SDK。

### 5.1 通用事件信封建议

| 字段 | 规则 |
|---|---|
| `event_name` | 稳定动宾或状态事实，例如 `site.build_started` |
| `occurred_at` | 服务端时间优先；客户端时间另列 |
| `workspace_id` | 只用内部 ID；分析权限仍按租户隔离 |
| `actor_id_hash` | 最小化；不记录邮箱/姓名 |
| `actor_role_snapshot` | 服务端确认的有效角色/责任帽子 |
| `object_type/object_id` | 稳定业务对象，不记录敏感内容 |
| `capability_id/page_id` | 关联本计划 ID |
| `source` | `client/server/workflow`，避免重复计数 |
| `correlation_id` | 连接页面、API 和 workflow；对用户/支持可脱敏展示 |
| `result` | success/partial/degraded/failed/cancelled/denied |
| `error_class` | 稳定业务错误类，不记录原始 provider 文本 |
| `entitlement_snapshot` | 可用能力版本，不包含付费敏感明细 |
| `schema_version` | 事件 schema 版本 |

### 5.2 首个 Site 纵切事件

| Event ID | 逻辑事件 | 主要来源 | 用途 |
|---|---|---|---|
| `EVT-FE-001` | `site.intake_accepted` | server | MET-SITE-001/002 分母 |
| `EVT-FE-002` | `site.demo_preview_ready` | workflow/server | 首次可预览时间 |
| `EVT-FE-003` | `site.preview_opened` | client + preview edge 去重 | 预览采用；区分内部检查和用户打开 |
| `EVT-FE-004` | `site.profile_group_saved` | server | 有意义补全路径；不记录字段内容 |
| `EVT-FE-005` | `site.asset_upload_started` | client/server | 定位上传漏斗 |
| `EVT-FE-006` | `site.asset_committed` | server | 处理分母 |
| `EVT-FE-007` | `site.asset_terminal` | server/workflow | ready/duplicate/rejected/failed |
| `EVT-FE-008` | `site.claim_reviewed` | server | approved/rejected/revoked/corrected |
| `EVT-FE-009` | `site.build_started` | server | Build 漏斗和幂等事实 |
| `EVT-FE-010` | `site.build_terminal` | workflow/server | 状态、degraded、成本摘要引用 |
| `EVT-FE-011` | `site.build_cancel_requested` | server | 取消可信度 |
| `EVT-FE-012` | `site.recovery_action_taken` | client/server | 自助恢复路径；动作枚举需批准 |
| `EVT-FE-013` | `site.preview_result_accepted` | client + server object | 区分“打开”与“认为可继续” |

`preview_opened` 不能只靠前端页面 load 计数：预加载、刷新、机器人和内部健康检查需排除。最终口径需要 preview edge/server 与客户端关联。

## 6. 分母、去重和归因原则

1. 所有转化率先定义 eligibility，避免把无权限、未部署或不支持 locale 的用户放入分母。
2. 以 Workspace/Site/Build 等业务对象去重，不能用点击次数代替用户完成。
3. 客户端事件描述意图和交互，服务端/工作流事件描述业务事实；结果指标以服务端为准。
4. 重试、Temporal replay、页面刷新和多标签页不能重复计数；使用 object ID + idempotency key + schema-defined window。
5. Managed 服务和 Self-service 分开报告；不能把运营代操作包装成产品采用。
6. `unknown`、`degraded`、`skipped`、`stale` 单独统计，不能并入 success。
7. 指标按首批行业、市场、Workspace maturity 和 locale 分层，但样本小于隐私阈值时不展示。

## 7. 隐私、保留和权限

- 不在分析事件中写原始 Claim、Prompt、文档文本、联系人、询盘正文、邮箱、电话或完整 URL query。
- 页面行为分析与业务审计分开；审计不可被普通产品分析清理规则覆盖。
- 数据保留、跨境、用户同意、员工行为可见性和第三方分析供应商均需隐私 Owner 批准。
- 代理商/集团汇总只能使用明确授权的聚合指标，不能跨客户下钻原始对象。
- Operations Console 访问分析/诊断数据必须留审计，并对用户支持场景最小化。

## 8. 建议验证窗口

| 阶段 | 样本 | 主要验证 | 不做的结论 |
|---|---|---|---|
| 可用性验证 | 5–8 名目标操作者 | 找入口、理解状态、完成资料/Build/恢复 | 不推断市场规模或商业续费 |
| 内部 Alpha | 10–20 个可控 Workspace | 契约、状态、错误、成本、恢复和数据质量 | 不称 PMF/GA |
| Design Partner Pilot | 批准的真实企业 | 首次价值、继续完成、预览接受、人工成本 | 不把运营代操作混为自助采用 |
| 发布/询盘 Pilot | 生产 Gate 后 | 发布健康、有效询盘、Opportunity 接缝 | 未有 Outcome 窗口前不称增长成功 |

目标值应在有基线后设定。PRD 中“30 分钟激活”“15 分钟精装修”“P95<10s Demo”可以作为待验证门槛，不应在没有真实前端和生产证据时写成已达到 SLA。

## 9. Gate 2 建议

1. 批准 `MET-FE-001`–`008` 为平台指标方向，其中具体数据 Owner 和 active Workspace 定义待 SaaS 决定。
2. 批准 `MET-SITE-001`–`014` 作为首个纵切候选指标；Gate 5 前关闭精确分母和目标值。
3. 明确 `MET-SITE-020`–`034` 只有相应 Publish/Inquiry 能力发布后才启用。
4. 批准反指标 `ANTI-FE-001`–`010`，禁止用页面数、Build 成功、AI 调用或原始 Lead 数替代用户结果。
5. 指定产品数据 Owner、隐私 Owner 和事件合同 Owner；未指定前不引入新 tracking SDK。
