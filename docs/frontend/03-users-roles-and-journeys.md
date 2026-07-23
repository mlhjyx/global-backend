# 用户、责任角色与端到端旅程

> 文档 ID：`FE-GLOBAL-004`
> 层级：`L2 / Normative target`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_4`
> 内容 Owner：`OWN-PRODUCT`
> 批准来源：`DEC-FE-P2-001`、`DEC-FE-P2-002`、`DEC-FE-P2-004`

## 1. 首批用户范围

首批目标客户是 B2B 制造、工贸一体和传统出口企业。默认日常操作者是海外增长/外贸运营；老板/出海负责人、品牌/内容、销售、事实审批、Workspace 管理员和平台运营以责任帽子参与。SaaS、专业服务、代理商多 Workspace 等仍是候选扩展，不得用一套默认流程覆盖。

这些是 Gate 2 的产品选择，不是一手研究已经验证的结论。研究状态和方法仍见 `RES-FE-001..008`。

## 2. 责任帽子

| Actor ID | 责任帽子 | 主要结果 | 典型高风险动作 | 不应默认获得 |
|---|---|---|---|---|
| `ACT-FE-001` | 老板/出海负责人 | 方向、预算、结果与关键批准 | 套餐、预算、发布、数据退出 | 全部个人工作数据 |
| `ACT-FE-002` | 海外增长/外贸运营 | 资料、Site、客户开发、执行和恢复 | Build、Campaign、导入、批量动作 | Claim/法务/安全最终批准 |
| `ACT-FE-003` | 品牌/内容运营 | 品牌、素材、内容与多语言质量 | 素材使用、文案提交 | Workspace 安全或销售私密数据 |
| `ACT-FE-004` | 销售/BD | 联系、Opportunity、结果回写 | 外部触达、阶段和 Outcome | 站点系统配置、全量原始资料 |
| `ACT-FE-005` | 事实/合规审批人 | Claim/Evidence、权利与发布前审查 | 批准、驳回、撤销 | 无关业务对象的运营权限 |
| `ACT-FE-006` | Workspace 管理员 | 成员、集成、策略和安全 | 邀请、角色、集成、数据政策 | 员工个人草稿/待办的默认读取权 |
| `ACT-FE-007` | 数据/运营/客户成功 | 数据与作业质量、恢复和采用辅导 | 诊断、人工补救、SLA 跟进 | 默认读取全部个人/客户数据、业务批准代签 |
| `ACT-FE-008` | 代理商项目经理 | 多客户隔离交付 | 切换 Workspace、委派、报告 | 跨客户原始数据聚合 |
| `ACT-FE-009` | 海外买家/站点访客 | 判断供应商可信度并发起有效询盘 | 浏览公开输出、提交有同意的询盘 | SaaS 管理面、内部 Evidence/Workspace 数据 |
| `ACT-FE-010` | 平台运营/安全人员 | 受控诊断系统异常和安全事件 | support access、redrive、kill switch、事故处置 | 无审计 impersonation、业务批准代签 |

Actor 是体验责任帽子，不等于未定义的 RBAC role 字符串。一个人可以戴多个帽子，但每个动作仍需服务端授权、数据范围和审计。

## 3. 核心 Jobs

| Job ID | 用户要完成的进展 | 结果对象 |
|---|---|---|
| `JOB-FE-001` | 用最少可信资料进入产品并看到可继续的价值 | Workspace/Site/Demo |
| `JOB-FE-002` | 建立可复用、可审、可追踪的企业事实与素材 | Company/Claim/Evidence/Asset |
| `JOB-FE-003` | 建立和持续管理可信海外独立站 | Site/Version/Release |
| `JOB-FE-004` | 将资料转成受控内容与开发预览 | BuildRun/Preview |
| `JOB-FE-005` | 理解长任务、成本、失败并安全恢复 | Run/Incident/Task |
| `JOB-FE-006` | 找到匹配且有时机的潜在客户 | ICP/Company/Lead |
| `JOB-FE-007` | 将合格线索交给销售并回写结果 | LeadQualifiedPackage/Opportunity/Outcome |
| `JOB-FE-008` | 将增长目标变成有边界的 Campaign 和执行 | Campaign/PublishJob |
| `JOB-FE-009` | 跨站点、内容和销售材料复用可信事实 | Claim reference graph |
| `JOB-FE-010` | 集中处理响应并避免遗漏 | Conversation/Task |
| `JOB-FE-011` | 推进商机并形成可学习结果 | Opportunity/Outcome |
| `JOB-FE-012` | 看清质量、成本、漏斗和下一步 | Metric/Experiment/read model |

## 4. 旅程目录

| Journey ID | 起点 → 终点 | 当前产品状态 | 主要横切规范 |
|---|---|---|---|
| `JRN-FE-001` | 首次进入 → 安全 Demo | `APPROVED`，正式 Shell/前端缺 | 会话、Workspace、intake、ACK 不明、Demo 边界 |
| `JRN-FE-002` | 资料补全 → 可信开发预览 | 首个批准纵切 | Profile/Asset/KB/Claim/Build/cancel/recover/preview |
| `JRN-FE-003` | 审核 → 公开发布/域名/回滚 | `APPROVED_NOT_BUILT`，不在首个承诺 | PublishReview、授权、版本、域名、保站 |
| `JRN-FE-004` | 市场假设 → 可解释 package | 后端真实、前端 Mock、开发冻结 | Evidence、资格、Reachability、拒绝原因 |
| `JRN-FE-005` | package → 销售接受/Outcome | `EXTERNAL_OWNED` | 跨仓 handoff、SLA、反馈 |
| `JRN-FE-006` | 候选事实 → 跨域可信复用 | 后端地基，用户审核合同缺 | Evidence、Approval、适用范围、撤销影响 |
| `JRN-FE-007` | 失败 → 安全恢复 | 原则批准，统一前端未建 | 错误、长任务、旧结果、人工兜底 |
| `JRN-FE-008` | 多 Workspace 代理交付 | `HYPOTHESIS/DEFERRED` | 委派、隔离、白标、汇总和审计 |

本文件是跨模块用户与旅程的当前入口；页面级步骤和状态由[页面与能力目录](04-page-and-capability-catalog.md)及相应 Capability Pack 维护，不在这里复制。

## 5. 旅程交付合同

任何 Journey 进入 Dev-Ready，必须具备：

1. Segment、primary/collaborating Actor、问题和完成定义；
2. 入口、canonical object、前置、退出和跨设备恢复；
3. 权限、数据范围、entitlement 和职责分离；
4. normal/empty/waiting/partial/degraded/error/cancel/conflict/offline；
5. AI/Evidence/Approval 和成本边界；
6. 桌面/移动/键盘/屏幕阅读器/长文本与 locale 变体；
7. Capability/Page/Object/Contract/Scenario/Metric 追踪；
8. 人工兜底、Owner、已知限制和退出路径；
9. 原型或设计资产版本、验证参与者、finding 和结论。

## 6. 多角色协作原则

- “查看”“编辑”“批准”“执行外部动作”“管理策略”分开；提交者不自动成为批准者。
- 个人草稿、待办和备忘与团队协作对象分层；管理员不因角色名自动读取个人内容。
- 交接使用对象、状态、Owner、deadline、Evidence 和活动记录，不依赖聊天转述。
- 代理商/平台运营切换身份或 Workspace 时必须显式标识、限时、最小范围并留审计。
- 若责任人未指派，界面显示阻塞/运营入口，不让 AI 或默认管理员代签。

## 7. 已知但尚未登记为正式 Journey 的闭环

完整页面地图还隐含以下跨模块闭环。因为对象、合同、首发市场或产品范围未批准，Phase 4 只登记缺口，不自行分配新的 `JRN-FE-*`：

| 候选闭环 | 主要 Actor | 必须先关闭 |
|---|---|---|
| 海外买家浏览公开站 → 核验信任 → 有同意地询盘 → SaaS 接管 | `ACT-FE-009/004` | Public publish、Inquiry/consent/anti-abuse/Conversation 合同 |
| 邀请成员 → 角色/数据范围 → 离职移交/撤权 | `ACT-FE-006/007` | Membership/Role/Delegation、个人数据与审计政策 |
| 集成连接 → scope/健康 → 失效/重连 → 撤销/退出 | `ACT-FE-006/010` | Credential/OAuth/Secret/exit ownership |
| 导入/迁移 → 映射/预演 → 部分失败 → 对账/回滚 | `ACT-FE-002/007` | Import/Migration 对象、provenance、补偿和权利合同 |
| 套餐/额度 → 升降级 → 只读/导出 → 关闭账号/删除 | `ACT-FE-001/006` | 商业、保留、账单、DSR 和数据退出政策 |
| 支持请求 → 受控 impersonation → 恢复 → 用户确认/审计 | `ACT-FE-007/010` | support access、SLA、最小权限和告知 |

这些闭环缺失会影响“完整 SaaS”但不会扩大当前 Site 首个承诺。相应 Capability 进入路线图时，先走产品 Decision，再加入 Scenario/Page/Metric/Guide。

## 8. 仍需验证

优先验证默认操作者、Demo→补资料顺序、Claim/Evidence 术语、入口偏好、发布前责任、失败恢复动作和续费价值。研究结论必须记录参与者范围、方法、证据、反例和改变的 Decision；5–8 人可发现可用性问题，但不能单独证明市场规模或普遍商业需求。
