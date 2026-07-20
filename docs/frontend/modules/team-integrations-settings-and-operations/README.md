# 团队、集成、设置与运营 Capability Pack

> 文档 ID：`FE-P6-CONTROL-000`
> 层级：`L2 / Map-complete capability pack`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_6`
> Capability：`CAP-TEAM-001`、`CAP-INTEG-001`、`CAP-SET-001`、`CAP-ADMIN-001`
> 事实 Owner：`OWN-SAAS-PLATFORM`

## 1. Capability

Workspace 管理员安全管理成员、数据范围、套餐、偏好、集成和审计；平台运营人员在独立、最小权限、全审计的控制面诊断租户与事故。用户设置、Workspace 控制面和平台运营台不是一个“设置”大页面，也不能用旧 Spring/Admin 原型定义目标身份或权限。

## 2. 三个不同表面

| 表面 | 主要用户 | 所有权与边界 |
|---|---|---|
| 个人设置 | 当前用户 | 个人语言、通知、会话/安全偏好；不改变 Workspace 政策 |
| Workspace 控制面 | 管理员/被授权角色 | 成员、角色、数据范围、集成、套餐、审计和组织政策 |
| 平台运营控制台 | 内部运营/安全 | 受控诊断、provider/任务/事故/删除；默认不能冒充用户或读取业务/个人数据 |

## 3. 页面工作簿

| Page | 用户结果/主动作 | 安全/恢复要求 | 当前事实 |
|---|---|---|---|
| `090` 成员与角色 | 邀请、停用、分配责任/角色、查看有效权限 | invite expiry、last admin、离职移交、pending、audit | `/team` Mock；正式 Membership `NONE` |
| `091` 数据范围与委派 | 定义团队/个人/区域/代理商范围 | preview effective access、time-bound delegation、conflict | 政策 `OPEN_DECISION` |
| `092` 集成中心 | 添加、授权、诊断、轮换、导出和移除连接 | OAuth state/scope、secret never reveal、health、revoke/exit | `/integrations` Mock；vault/OAuth `NONE` |
| `093` Workspace 设置 | 设置企业偏好、地区、默认语言和政策 | impact preview、inheritance、conflict、audit | 正式 policy `NONE` |
| `094` 安全与审计 | 管理会话、密钥、审计、删除和事故 | immutable audit、PII mask、step-up auth、export/delete | 旧 Spring 不满足目标边界 |
| `095` 套餐、用量与账单 | 理解 entitlement、额度、使用和升级/降级影响 | effective date、hard cap、unknown spend、grace、export | 商业策略/账单 SoR `OPEN_DECISION` |
| `096` 运营控制台 | 诊断 Provider/Workflow/Incident/DSR 并受控恢复 | purpose、scope、approval、break-glass、full audit | 本地 admin 原型无权威性；本仓有局部运维 API/服务 |

## 4. 权限与数据社会属性

- Role 名称不是权限真值；UI 消费 capability、entitlement、object authorization、data scope、Approval 和 execution authorization。
- Workspace 管理员不自动读取个人待办、私有草稿、联系人原文或运营 trace；例外需目的、告知、范围、时间和审计。
- 集成凭据只存 secret manager；前端只持一次性授权状态和 `CredentialRef`，不回显明文。
- 成员停用必须处理任务/审批/对象 Owner 移交；删除账号不等于删除 Workspace 业务事实。
- 平台运营与客户管理员分开；break-glass/impersonation 若未来允许，必须 step-up、审批、时间限制、显著告知和不可变审计。
- 套餐变化不能由客户端本地开关实现；服务端 entitlement/allowed actions 为唯一执行真值。

## 5. 生命周期与恢复

```text
Invite → Pending → Active → Suspended → Removed
Integration Draft → Authorizing → Active → Degraded/Expiring → Revoked → Removed
Subscription Trial/Active → Grace/PastDue → Restricted → Cancelled
Incident Open → Triaged → Mitigating → Monitoring → Resolved → Reviewed
```

以上只是产品目标模型，不证明机器合同已存在。未知或冲突时保持 fail-closed：最后一个管理员不能静默删除；OAuth ACK 不明先对账；移除集成前说明数据副本/退出；套餐降级先展示影响；事故 redrive 必须校验对象终态、幂等和权限。

## 6. 当前代码/原型结论

- `/global/frontend/project-12080666` 有 `/team`、`/integrations`、`/settings`，数据主要来自 Mock；设置页只有少量旧 API 接入。
- `/global/frontend/admin-frontend` 只有登录和用户列表，缺正式租户隔离、审计和 provenance。
- `/global/frontend/backend` 是旧 Spring identity 原型，包含自签 HMAC JWT、单角色、MySQL 和危险默认配置，与“身份归 SaaS、本仓只验 JWKS”冲突；不得作为目标 SoR。
- 当前 NestJS 有 JWKS/RLS、Whoami、Provider 状态、Suppression/Deletion、Temporal/Outbox 与 Site 运维地基，但没有 SaaS Membership/Entitlement/Billing/Integration vault/运营授权控制面。

## 7. 指标、反指标、运营 FAQ

方向指标：邀请成功与权限生效时间、离职移交完整率、越权数恒 0、集成健康/恢复时间、secret 暴露为 0、套餐限制解释率、事故恢复/复盘闭环率、DSR SLA。

反指标：成员数、集成数量、管理员操作量、break-glass 使用量、用弹窗代替服务端门、为支持方便默认读取所有数据、移除连接后仍无法导出/删除副本。

常见问题：

- 管理员能看所有个人数据吗？不能默认这样设计。
- 集成卡显示 connected 就说明可用吗？不能；还需 scope、健康、过期、最后成功、错误与退出。
- 平台运营能直接替用户操作吗？默认不能；未来若有必须单独高风险能力 Gate。
- 旧 Admin 页面能继续开发吗？在正式 ownership、安全处置和仓库决定前只能作来源审计。

## 8. Handoff

本 Pack 达到 `MAP_COMPLETE / TARGET_EXTERNAL / NOT_DEV_READY`。进入任何实现前需关闭 `BLK-FE-001/003/005/006` 的适用部分，裁决身份/控制面正式仓库与 SoR、商业套餐、运营权限、集成/secret 模型和审计/隐私政策；外部候选只按 [Phase 7 Registry](../../../backend/oss-registry.md) 的触发器重新评审，不由本 Pack 自动采用。
