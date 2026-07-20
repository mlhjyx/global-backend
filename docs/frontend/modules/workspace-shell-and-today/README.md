# Workspace Shell 与今日 Capability Pack

> 文档 ID：`FE-P6-SHELL-000`
> 层级：`L2 / Map-complete capability pack`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_6_REVIEW`
> Capability：`CAP-SHELL-001`、`CAP-ID-001`、`CAP-ONB-001`、`CAP-TODAY-001`
> 事实 Owner：`OWN-SAAS-PLATFORM`

## 1. Capability

海外增长/外贸运营在正确 Workspace 中安全进入产品，立即知道今天最重要的任务、审批、异常和机会，并能恢复到拥有业务真值的对象页面。Shell 只负责上下文、发现、聚合和深链，不拥有 Site、Lead、Campaign、Conversation 或 Opportunity 的业务状态。

## 2. 用户、问题和完成定义

| Actor | 用户问题 | 完成定义 |
|---|---|---|
| `ACT-FE-002` 海外增长/外贸运营 | 我进入了哪个企业？现在最该做什么？ | Workspace 明确；能进入一个真实对象或完成一项安全动作 |
| `ACT-FE-005` 内容/事实审批人 | 哪些决定在等我，影响什么？ | 看完 Evidence/差异/范围后做出有审计的决定，或明确阻塞 |
| `ACT-FE-006` Workspace 管理员 | 谁能看到和执行什么？ | 成员、权限和套餐能力来自服务端真值，未知动作 fail-closed |
| `ACT-FE-007` 运营/客服 | 哪个任务失败、保留了什么、下一步是什么？ | 通过 correlation/object ID 进入受控诊断或升级路径 |

成功不是“Dashboard 有数字”，而是用户能在不串 Workspace、不越权、不依赖聊天历史的情况下继续一项真实工作。

## 3. 范围与非目标

当前产品方向包含：登录/会话入口、Workspace 选择/切换、今日、搜索、通知、任务、审批、异常、长任务和帮助，对应 `PAGE-FE-001..010`。

本 Pack 不负责：

- 在本仓创建身份、用户、角色、账单或 Session SoR；
- 把 Notification、Task、Approval、Incident 建成覆盖所有域的万能写模型；
- 在 Today 内直接改写业务对象或绕过对象权限；
- 继承本地 Spring 的 HMAC JWT、单字符串角色或 `localStorage` 会话作为目标方案；
- 选定正式前端框架、BFF、搜索引擎或通知供应商。

## 4. 核心旅程与页面 Manifest

```text
会话/深链
→ 校验身份和 Workspace
→ 恢复安全目标或进入 Workspace 选择
→ Today 聚合下一动作/审批/异常/机会
→ 深链 canonical object
→ 对象页完成动作
→ 结果事件更新聚合读模型
```

| Page | 首屏问题 | 主动作 | 必须覆盖的边界 | 当前事实 |
|---|---|---|---|---|
| `001` 登录/会话 | 能否安全进入？ | 登录/恢复会话 | 过期、锁定、无 Workspace、原深链不泄漏 | SaaS external-owned；本地旧实现冲突 |
| `002` Workspace | 正在操作哪家企业？ | 选择/切换 | 切换清缓存/订阅/搜索；失败保留原上下文 | 合同 `NONE` |
| `003` 今日 | 今天最重要的是什么？ | 继续一项真实工作 | 空、stale、局部源失败、不可用能力 | `/dashboard` 为 Mock |
| `004` 搜索/命令 | 对象在哪里？ | 打开 canonical object | 租户、权限、类型、最近访问、无结果 | TopBar 只搜 Mock |
| `005` 通知 | 发生了什么、影响什么？ | 打开影响对象/标已读 | 去重、stale、对象已删除、跨 Workspace | 硬编码通知 |
| `006` 任务 | 下一步由谁在何时做？ | 接受/分派/完成/升级 | 个人与团队范围、SLA、对象状态已变化 | 统一合同 `NONE` |
| `007` 审批 | 要决定什么、依据是什么？ | 批准/退回/限范围 | Evidence、影响、冲突、撤销、双重授权 | Claim 局部；平台合同 `NONE` |
| `008` 异常与恢复 | 失败影响什么、保留了什么？ | 重试/补资料/升级 | 可重试、不可重试、部分成功、旧结果保留 | `/anomaly` Mock |
| `009` 长任务 | 任务现在处于什么阶段？ | 打开/取消 | ACK unknown、跨设备恢复、stale、预算 | Site Build 局部可观察 |
| `010` 帮助/支持 | 用户如何自助或带上下文求助？ | 查指南/复制诊断/反馈 | PII 脱敏、支持权限、已知限制 | 正式入口 `NONE` |

## 5. 对象、权限与状态

- `Workspace`、`Membership/Role/Entitlement` 由 SaaS 控制面拥有；Shell 只消费 capability、object authorization、data scope 和 allowed actions。
- Notification/Task/Approval/Incident 是跨域投影或协调记录；决定仍写回 Claim、Build、Campaign、Opportunity 等 canonical object。
- 个人待办/草稿不因管理员身份默认可读；团队任务、审批和事故按对象范围共享。
- 聚合卡至少表达 `source state + freshness + impact + next action + canonical link`，不能只显示一个红点或 AI 建议。
- Workspace 切换是安全边界：旧对象缓存、搜索结果、流式订阅、草稿恢复键和返回路径必须清理或重新鉴权。

## 6. 失败恢复和人工兜底

| 情况 | 用户可见恢复 | 禁止行为 |
|---|---|---|
| 聚合读模型局部失败 | 标出失效来源和最后更新时间；健康模块仍可直达 | 整个 App 白屏或把空数据当 0 |
| 深链无权/不存在 | 使用不泄漏对象存在性的统一状态，返回安全上下文 | 用前端隐藏代替服务端鉴权 |
| 权限/entitlement 未知 | 隐藏或禁用危险动作并说明需要谁处理 | 默认开放或客户端硬编码管理员 |
| Approval 合同缺 | 只读展示来源和阻塞；走批准的运营 SOP | 用通用按钮猜写入接口 |
| 任务取消 ACK 不明 | 保持 active/confirming，允许对同 ID 安全重查 | 显示假 cancelled 或启动并发任务 |
| 支持升级 | 复制脱敏 correlation/object/time/context | 暴露 token、原始 trace、存储 key 或 PII |

## 7. 当前证据与缺口

- 本地 `/global/frontend/project-12080666` 有 Layout、Sidebar、TopBar、`/dashboard` 和 22 个路由入口，但主要数据来自 `src/mocks`，无 Git provenance、正式 Workspace guard、生成客户端、测试或部署证据。
- 当前 OpenAPI 有 `WhoamiController_whoami_v1`，但它不能替代 Workspace/Membership/Entitlement/allowed-actions 清单。
- Site Build 可提供一个长任务深链样例；这不等于统一 Task/Incident/Notification 读模型已建。
- `BLK-FE-001/003/005/006` 继续阻止正式实现、权限验收、指标和运营签发。

## 8. 指标、反指标与场景

方向指标：到达真实对象的时间、恢复未完成工作的成功率、聚合卡到下一动作转化、跨 Workspace 错误为 0、支持升级上下文完整率。

反指标：Today 停留时长上升但任务完成不升、通知量代替价值、错误隐藏率、无权对象泄漏、聚合失败阻断健康模块。

验收场景：`SCN-FE-SHELL-001..004`。当前均为 `TARGET_NOT_RUNNABLE/BLOCKED`；正式 Fixture、前端、E2E 和 Release Bundle 未创建。

## 9. Handoff

本 Pack 达到 `MAP_COMPLETE / NOT_DEV_READY`。进入实施前至少需要：正式前端 repo/Owner/CI/deploy、身份与 Workspace capability manifest、跨域 Task/Approval/Incident/Notification 读模型、对象深链合同、数据/隐私和 QA/Ops 实际责任人。

