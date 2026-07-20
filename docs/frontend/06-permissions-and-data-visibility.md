# 权限与数据可见性规范

> 文档 ID：`FE-GLOBAL-007`
> 层级：`L2 / Normative target`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_4`
> 内容 Owner：`OWN-SAAS-PLATFORM`
> 关联：`CON-FE-P2-014/015/022`、`BLK-FE-003`、`SCN-FE-SHELL-001..003`

## 1. 安全模型

```text
入口可见性 ≠ Entitlement ≠ Authorization ≠ Data scope ≠ Approval ≠ Execution authorization
```

| 层 | 回答的问题 | 权威来源 | 前端责任 |
|---|---|---|---|
| Capability availability | 产品/区域/环境是否提供该能力 | 服务端 capability manifest | 诚实显示三态；缺失 fail-closed |
| Entitlement/quota | Workspace 是否购买、试用或仍有额度 | SaaS 商业/用量服务 | 显示原因、用量和升级/联系路径；不自算套餐 |
| Authorization | 此 actor 能否对该 object 执行动作 | 服务端策略/对象状态 | 只渲染 allowed actions；服务端仍必须强制 |
| Data scope | actor 可见哪些字段/记录/聚合 | 服务端过滤与 redaction | 不请求/缓存/埋点记录无权数据 |
| Approval | 业务决定是否通过 | Approval/域对象 SoR | 显示差异、Evidence 和决定；不等于调用外部动作 |
| Execution authorization | 此时此范围可否发布/发送/导出/删除 | 短时、对象绑定授权 | 二次确认并绑定版本/范围；不可复用过期授权 |

后端 RLS 只证明某些本仓数据按 Workspace 隔离，不等于完整 SaaS Role、Entitlement 或字段范围合同已经存在。

## 2. 数据社会属性

| Data class | 示例 | 默认可见范围 | 特别规则 |
|---|---|---|---|
| `PERSONAL_WORK` | 个人草稿、待办、备忘、未提交 Prompt | 本人 | 管理员不默认读取；共享/调查例外需政策、告知和审计 |
| `TEAM_COLLAB` | Site、Campaign、批准任务、团队评论 | 明确团队/Workspace | Owner、参与者、历史和可见范围可解释 |
| `WORKSPACE_MASTER` | Company/Offering/approved Claim/Asset metadata | Workspace 授权成员 | 字段级敏感信息、权利和用途仍可受限 |
| `RESTRICTED_TRUST` | 未审 Claim、原始 Evidence、认证、法律材料 | 指定编辑/审批人 | 下游只能读取批准快照；外部公开 fail-closed |
| `PERSONAL_DATA` | 联系人、询盘、员工行为 | 目的/法域/角色限定 | 最小化、保留、DSR、导出和审计；管理员非无限读 |
| `PUBLIC_OUTPUT` | 已授权公开站文案/素材 | 公众 | 必须引用特定 Release/Claim/Asset 版本；撤销影响可追踪 |
| `SYSTEM_OPERATIONAL` | trace、provider 错误、Secret、raw prompt | 受控平台运营 | 用户只看脱敏 correlation/业务影响；严禁复制 Secret |
| `CROSS_WORKSPACE_AGGREGATE` | 代理商/平台聚合指标 | 明确授权的聚合 | 阈值、脱敏、不可下钻；不得串客户原始数据 |

## 3. 责任帽子 × 动作基线

本矩阵是产品默认，不是最终 RBAC。正式合同必须将 Actor/role、对象、数据范围和 allowed action 映射；未知时拒绝。

| 动作 | Operator `ACT-FE-002` | Content `ACT-FE-003` | Sales `ACT-FE-004` | Approver `ACT-FE-005` | Admin `ACT-FE-006` | Ops `ACT-FE-007/010` |
|---|---|---|---|---|---|---|
| 查看团队对象 | 按域允许 | 按域允许 | 销售域允许 | 审批范围允许 | 策略允许，不自动含个人数据 | 工单/授权范围 |
| 编辑 Profile/内容/素材 | 通常提交 | 通常编辑 | 只在销售字段范围 | 不因审批权自动编辑 | 不因管理权自动编辑 | 仅批准 SOP 下代操作 |
| 提交 Claim/内容审批 | 允许 | 允许 | 有范围时允许 | 可退回但不替提交者改写 | 不默认 | 可协助，不代签 |
| 批准/撤销 Claim | 不默认 | 不默认 | 不默认 | 允许范围内 | 只有显式兼任 | 禁止代签，除正式授权角色 |
| 启动/取消内部 Build | 通常允许 | 可按站点允许 | 不默认 | 查看影响 | 策略允许不等于业务动作 | 故障 SOP 下受控 |
| 公开发布/外部发送 | 需 Approval + execution auth | 同左 | 触达域同左 | 可作业务批准，但未必执行 | 管理员不自动批准 | 只可执行已批准版本且留审计 |
| 导出/删除/数据退出 | 高风险、通常受限 | 受限 | 目的限定 | 审查/批准视政策 | 策略责任 + 二次授权 | 工单、范围、时限和审计 |
| 成员/角色/集成/套餐 | 不默认 | 不默认 | 不默认 | 不默认 | 允许相应管理动作 | 支持不能静默修改商业/安全策略 |

## 4. 对象关键动作规则

| 对象 | 读 | 写 | 批准/执行 | 删除/保留 |
|---|---|---|---|---|
| Company/Offering | Workspace 范围 + 字段 redaction | 编辑者，ETag/历史 | 公开使用依赖 approved Claim | 影响 Site/Content/Lead 引用，不能直接硬删 |
| Claim/Evidence | 适用范围和敏感级别 | 候选事实可提交/修正 | 审批人与提交者职责分离；撤销可追踪 | Evidence 保留/法务策略；撤销不等于抹历史 |
| Asset | metadata/preview 权限分开 | 上传、用途、权利声明 | 公开使用需权利和引用门 | 有引用时阻塞；tombstone/cleanup 异步表达 |
| Site/BuildRun | Site 成员；Run 继承 object scope | 配置与 Build action 分开 | Build 不等于 Publish；取消受 run state/CAS | Site 退出/保留与 Release/域名分开 |
| Campaign/PublishJob | SaaS 域策略 | planner/editor | 外部动作需内容批准和 execution auth | 法规/渠道/审计保留 |
| Contact/Inquiry/Conversation | purpose + role + region | 最小字段 | 触达/导出需额外依据 | DSR、retention、legal hold 分层 |
| Opportunity/Outcome | 销售范围/Owner | 阶段和结构化结果 | 关键阶段可有批准/SLA | 不通过前端软删掩盖历史 |

## 5. Allowed Actions 合同

正式服务端至少应为对象返回等价语义：

```json
{
  "objectVersion": "opaque-etag-or-version",
  "capabilityVersion": "opaque-manifest-version",
  "allowedActions": [
    {
      "action": "site.build.start",
      "scope": "object",
      "decision": "allowed",
      "requiresApproval": false,
      "requiresConfirmation": true
    }
  ],
  "redactions": ["evidence.raw_content"],
  "decisionExpiresAt": "optional server timestamp"
}
```

这是目标语义，不是已存在 API。实际字段、缓存和策略引擎由 SaaS Owner 决定。前端不得把上次响应跨 Workspace、跨对象或无限期复用；动作提交时服务端必须重新校验。

## 6. 拒绝与不可用表达

| 原因 | 用户表达 | 是否泄漏对象存在 |
|---|---|---|
| 未登录/会话过期 | 重新登录并安全恢复目标 | 不展示对象数据 |
| 无 Workspace | 选择/申请/联系管理员 | 不执行查询 |
| 无对象读取权 | 按政策返回 404 或通用无权 | 默认不泄漏 |
| 有读权无动作权 | 对象可读；动作不可用并说明角色/流程 | 可解释 action policy，不暴露敏感策略 |
| 无 entitlement/quota | 说明套餐/额度/联系路径 | 与权限错误分开 |
| 前置配置缺 | 指明所需集成、资料或审批 | 仅展示有权配置项 |
| 功能未部署/冻结 | `NOT_OFFERED` 或明确维护态 | 不承诺日期 |

“按钮隐藏”不能替代拒绝合同；同时，界面也不应大量展示用户永远无法执行的危险动作。对可申请/可升级/需要审批的情况保留可发现性；永久无关动作不显示。

## 7. 套餐、额度与预算表达

Entitlement 是商业可用性，不是安全授权；quota/预算是可消耗约束，也不自动赋予动作权。界面必须分开显示：

- 当前套餐/试用和 capability availability（若用户有查看账单权限）；
- hard limit、soft warning、已用、预留、结算、unknown 与刷新时间；
- 本动作的 estimate、最大授权、实际 reported/calculated cost 和 unknown；
- 达限后的安全结果：阻止新动作、允许查看/导出/取消、保留已有对象；
- 升级/联系管理员/等待重置/降低范围等真实路径；
- 降级、取消订阅或关停时的数据保留、只读、导出和删除影响。

前端不能根据页面计数、缓存或价格表自行决定额度，也不能用权限错误掩盖配额；estimate 不冒充账单。套餐、价格、超额、试用和降级政策仍是 `OPEN-FE-COMM-001`，未决定前只展示服务端明确事实。

## 8. Support、impersonation 与代理

任何代操作必须有 ticket/reason、actor 与 represented actor、Workspace/object scope、允许动作、开始/到期、可见提示、审计和紧急终止。支持人员不能查看 Secret、个人草稿或无关 Workspace；不能批准自己代提交的 Claim，也不能用 impersonation 绕过套餐、Approval 或 execution authorization。

该能力当前 `OPEN_DECISION`，没有合同前不实现隐藏管理员入口。

## 9. 缓存、日志与分析

- Workspace 切换清理所有租户 cache、持久化 query、subscription、service worker data 和下载 URL。
- 浏览器存储不得保存 raw Evidence、Secret、联系人正文或长期 bearer token；具体存储策略由安全评审决定。
- UI 日志和 analytics 使用内部 ID/hash 与稳定错误类，不记录原始 Prompt、文档、询盘、邮箱或 token。
- 导出链接、presigned URL 和 preview access 按时效、作用域和一次性/撤销策略处理，不能进入通用通知或前端日志。

## 10. 当前 blocker

`BLK-FE-003` 仍未关闭：正式 Workspace/Membership/Role/Entitlement/allowed actions 合同不存在；`CON-FE-P2-015` 的管理员个人数据政策仍需数据/隐私 Owner 批准。因此本文件可以作为目标规范，但不能证明权限体验已可实现或通过验收。
