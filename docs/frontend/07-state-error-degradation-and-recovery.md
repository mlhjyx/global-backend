# 状态、错误、降级与恢复规范

> 文档 ID：`FE-GLOBAL-008`
> 层级：`L2 / Normative candidate`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_4_REVIEW`
> 内容 Owner：`OWN-DESIGN`
> 关联：`JRN-FE-007`、`SCN-FE-SHELL-004`、`SCN-FE-SITE-002..018`

## 1. 状态分层

一个页面可同时存在多个状态，不能压成一个彩色 badge：

```text
Session / Workspace / Permission
+ Capability / Entitlement / Configuration
+ Canonical object business state
+ Operation or long-running task state
+ Data freshness / sync state
+ Output quality / degradation state
+ Connectivity / local edit state
```

例如“Site 可用 + 旧 Preview active + 新 Build failed + 德语 degraded + 页面离线”是合法组合。新 Build 失败不能把 Site 整体显示为失败，也不能隐藏旧 Preview。

## 2. 全局状态词典

| State ID | 含义 | 必须告诉用户 | 默认动作 |
|---|---|---|---|
| `STATE-FE-001 INITIALIZING` | 尚未完成会话/路由/必要元数据恢复 | 正在确认什么，短暂且不闪烁错误 | 等待；超时转明确状态 |
| `STATE-FE-002 AUTH_REQUIRED` | 未登录或会话失效 | 数据未展示、如何重新进入 | 登录并恢复安全目标 |
| `STATE-FE-003 WORKSPACE_REQUIRED` | 无当前 Workspace | 为何需要、可选项 | 选择/申请/联系管理员 |
| `STATE-FE-004 DENIED` | 无读/动作权 | 可披露原因、对象是否存在按政策 | 返回安全入口/申请权限 |
| `STATE-FE-005 UNAVAILABLE` | 套餐/地区/配置/部署不满足 | 精确原因、Owner、下一步 | 配置/升级/联系；不虚构日期 |
| `STATE-FE-006 EMPTY` | 查询成功但没有对象 | 空的含义、适合的首次动作 | 创建/导入/调整筛选；不是错误 |
| `STATE-FE-007 LOADING` | 首次读取必要数据 | 范围和结构占位 | 可取消的慢操作提供退出 |
| `STATE-FE-008 REFRESHING` | 已有数据后台刷新 | 保留旧数据并标新鲜度 | 不清空页面/不抢焦点 |
| `STATE-FE-009 READY` | 当前任务所需数据可用 | 状态、更新时间、主动作 | 正常操作 |
| `STATE-FE-010 PARTIAL` | 部分子项成功/可用 | 成功与失败范围、保留结果 | 仅重试失败部分 |
| `STATE-FE-011 DEGRADED` | 可用但质量/能力下降 | 降级项、影响、替代和恢复条件 | 接受/补资料/重试/切换 |
| `STATE-FE-012 STALE` | 数据可能过期 | as-of、原因、是否允许动作 | 刷新；危险动作重新验证 |
| `STATE-FE-013 OFFLINE` | 无网络或服务不可达 | 本地是否保存、服务端是否已接受未知 | 重连/安全离开；不猜结果 |
| `STATE-FE-014 RETRYABLE_ERROR` | 失败且安全重试 | 业务影响、保留内容、重试范围 | 同一幂等身份重试/替代/运营 |
| `STATE-FE-015 TERMINAL_ERROR` | 当前请求不可重试 | 原因类别、如何修复输入/权限 | 修正、返回、联系支持 |
| `STATE-FE-016 CANCELLING` | 取消已请求、终态未确认 | 仍可能有在途工作/成本 | 等待/刷新；禁止新并发动作 |
| `STATE-FE-017 CANCELLED` | 服务端已确认终止 | 已完成/保留/计费范围 | 返回对象或重新开始新任务 |
| `STATE-FE-018 ACK_UNKNOWN` | 提交可能已成功但响应丢失 | “正在确认”，绝不写成功/失败 | 用 idempotency/object identity 查询或重放 |
| `STATE-FE-019 CONFLICT` | 并发/版本/策略改变 | 哪一版本、差异、谁/何时 | 刷新、比较、合并或放弃 |
| `STATE-FE-020 ARCHIVED_RETAINED` | 不再活跃但仍保留 | 可读/可恢复/可导出/删除边界 | 恢复、复制或查看历史 |

模块可添加业务状态，但必须映射到以上用户语义并避免同义词漂移。

## 3. 长任务模型

Build、导入、研究、发布等任务使用同一 task surface：

| 必需字段 | 体验含义 |
|---|---|
| Run ID / object / Workspace | 刷新、跨页、跨设备和支持可恢复 |
| accepted/started/heartbeat/updated | 区分排队、运行和 stale |
| steps + state + attempt | 说明进展，Temporal replay/重试不重复显示业务步骤 |
| current impact | 正在影响什么、旧结果是否仍可用 |
| cancelability + cutoff | 可否取消、取消后在途动作/费用边界 |
| cost: estimate/reported/calculated/unknown | 来源分开，unknown 不继续隐形 fallback |
| result/output pointer | 结果属于哪个版本，不把 Run 当对象 |
| stable error class + correlation ID | 用户可理解，支持可追踪，原始 provider 文本不泄漏 |
| allowed recovery actions | retry failed part / supplement / switch / accept degradation / escalate |

轮询、SSE、WebSocket 或其他传输由技术方案决定；无论方式，后台更新不得重置滚动、焦点或编辑，且要处理迟到、乱序、重复和断线重连。

## 4. 写入、自动保存和并发

| 情况 | 规则 |
|---|---|
| 普通表单 | 明确未保存/保存中/已保存/失败；成功以服务端确认和新版本为准 |
| 自动保存 | 显示最后成功时间；本地队列不称已保存；切 Workspace/关闭前处理在途写入 |
| ETag/version conflict | 不静默覆盖；提供刷新、比较、复制本地修改和重试 |
| 多标签页/多人编辑 | 收到版本变化时标 stale；危险动作重新拉 allowed actions |
| ACK unknown | 使用原 idempotency key 或稳定对象查询；禁用“再建一个”默认 |
| optimistic UI | 仅可安全回滚的低风险动作；外部发送、发布、批准、删除、计费不用乐观终态 |
| undo | 仅当服务端有真实补偿/撤销合同；Toast “撤销”不能是前端幻觉 |

## 5. 错误内容合同

错误面至少回答：

1. 发生了什么（稳定业务语言）；
2. 影响了什么（对象/步骤/版本）；
3. 系统保留了什么（旧结果、草稿、已完成子项）；
4. 用户现在能做什么（按安全顺序）；
5. 若仍不行找谁（Owner、支持入口、correlation ID）。

原始异常、HTTP 状态、SQL、存储 key、模型/provider 名或 trace 只进受控诊断。对安全敏感拒绝可降低细节；但不能仅显示“发生错误”。

## 6. 呈现层级

| 容器 | 适用 | 不适用 |
|---|---|---|
| 字段 inline | 校验、格式、字段冲突 | 系统级失败 |
| 区块/row state | 单文件、单步骤、单卡失败 | 全页授权 |
| Page banner | stale、offline、局部服务降级、旧结果保留 | 一次轻量成功 |
| Empty state | 成功读取且无对象/结果 | loading、403、错误 |
| Toast | 已有持久落点的非关键确认 | 唯一错误说明、审批/发布终态、长任务进度 |
| Modal/dialog | 不可逆/高影响确认、冲突比较、短决策 | 普通导航和可撤回输入 |
| Task/Incident detail | 长任务、部分失败、恢复和支持 | 用 spinner/Toast 替代 |

## 7. 恢复优先级

1. 不破坏现有可用结果；
2. 识别服务端是否已接受，避免重复副作用；
3. 只重试失败范围并复用幂等身份；
4. 允许补资料、切换受支持选项或接受明确降级；
5. 暂时无法恢复时提供导出/复制诊断/人工兜底；
6. 记录恢复动作和结果，用于 `MET-FE-006`、`MET-SITE-009/010`。

## 8. a11y 与实时状态

- 加载和后台刷新不重复轰炸 live region；只有用户相关的状态变化简洁宣布。
- 错误摘要可聚焦并链接字段；焦点不自动跳到每次轮询更新。
- 进度条提供可访问名称和值；未知进度使用 indeterminate 语义，不显示虚假百分比。
- 颜色、图标和动画不能是唯一状态信号；支持 reduced motion。
- 取消/重试动作有明确名称、范围和忙碌状态，键盘操作不会重复提交。

## 9. 场景覆盖门

模块进入 Dev-Ready 时必须选择适用的 `STATE-FE-*`，并用 Scenario 覆盖正常、空、无权、未配置、ACK 不明、幂等、冲突、部分成功、degraded、预算、取消、失败保留旧结果、离线和迟到结果。只画 happy path 不算完成状态设计。
