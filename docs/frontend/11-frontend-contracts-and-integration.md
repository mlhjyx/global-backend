# 前端合同与集成规范

> 文档 ID：`FE-GLOBAL-012`
> 层级：`L2 / Normative candidate`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_4_REVIEW`
> 内容 Owner：`OWN-SAAS-FE`
> 后端合同 Owner：按 [核心对象登记](../governance/core-object-register.md)分域

## 1. 当前边界

本仓 code-first OpenAPI 是本仓 HTTP 合同的机器真值；身份、Workspace 控制面、完整 SaaS UI 和 Campaign/Conversation/Opportunity 等由外部 SaaS 拥有。正式前端 repo、BFF、客户端生成方式和部署尚未确定，本文件定义消费语义和质量门，不描述 as-built 前端架构。

`packages/contracts/INTEGRATION.md` 存在 dated 漂移，`docs/architecture/current.md` 的手写 path 数也不是长期真值；接入一律引用 operationId/schema/event version，不把手写统计复制进客户端规范。

## 2. 客户端边界

```text
Route / Page composition
  → Product feature adapter
    → Query / command / task state
      → Generated or validated contract client
        → Auth / Workspace / correlation / retry policies
          → SaaS control plane or domain API
```

- 页面不直接散落 URL、HTTP 状态和 JSON cast。
- transport schema 与 UI view model 分开；映射保留 unknown/partial/degraded，不用默认值吞掉新状态。
- 跨域组合优先服务端 read model；若客户端组合，必须定义一致性、新鲜度、局部失败和权限边界。
- 是否使用 BFF、server components 或纯客户端取决于正式 repo/部署/安全/SEO/团队能力，保持 `OPEN_DECISION`。

## 3. 身份与 Workspace

- SaaS 签发/刷新身份，客户端不建立第二套用户表或 JWT；本仓只校验 token/JWKS 并读取 Workspace/user/roles。
- token 存储、刷新、CSRF 和 session 恢复策略由正式 SaaS 安全设计决定；不得从旧 Spring/localStorage 原型继承。
- 每个请求、cache key、subscription、download/preview handoff 明确 Workspace；切换时按 [Shell 规范](05-navigation-and-workspace-shell.md)清理。
- 401、会话过期、Workspace 缺失、403/404、entitlement 和配置错误分开映射；禁止无限 refresh loop。
- support/impersonation 使用独立短时上下文与显著 UI，不替换普通 token 后静默操作。

## 4. HTTP/命令合同

| Concern | 前端必须遵守 |
|---|---|
| operation identity | 引用 OpenAPI `operationId` 和 schema/version；不以 Controller 文件名作产品合同 |
| correlation | 接收/显示脱敏 correlation ID；客户端日志与支持可关联，不能把原始 trace 暴露 |
| idempotency | 创建/外部副作用使用服务端规定 key；ACK 不明复用原 key，不自动生成新对象 |
| optimistic concurrency | 保存/批准/切换使用 ETag/version/CAS；冲突保留本地修改并可比较 |
| validation | 客户端用于即时反馈，服务端仍为最终真值；枚举/limit 从能力合同读取 |
| errors | 稳定 machine code → `STATE-FE-*` + `COPY-FE-*`；unknown code 安全降级并可观察 |
| pagination/filter/sort | 服务端语义、稳定 cursor/order、空/partial/stale；不下载全量替代查询 |
| date/money/cost | ISO/明确 timezone、decimal/minor unit、currency/source；estimate/reported/calculated/unknown 分开 |
| locale | UI locale、content locale、source locale 和 fallback 分开；不根据浏览器默认改业务对象 |
| file upload | presign → PUT → commit → processing/ready 是分步状态；URL 过期和 commit ACK 不明可恢复 |
| cancellation | cancel request、server ACK、terminal state 分开；未确认前不启动冲突任务 |
| compatibility | 对未知 additive 字段/状态有安全策略；breaking change 需版本/迁移/灰度 |

## 5. Error → UX 映射

| 合同事实 | 用户状态 | 规则 |
|---|---|---|
| 401/session invalid | `AUTH_REQUIRED` | 清理敏感视图，登录后只恢复安全目标 |
| 403/action denied | `DENIED` | 可读对象保留；不泄漏策略/其他成员 |
| 404 | not found 或安全 denial | 按域防枚举策略，不猜对象存在 |
| 409 conflict/active run | `CONFLICT` | 拉当前版本/Run、显示差异和合法动作 |
| 412 ETag/version | `CONFLICT` | 不覆盖；刷新/比较/复制本地修改 |
| 422 invalid enum/input | field/section error | 展示服务端允许范围；不自动换成默认值 |
| 429 quota/rate | `UNAVAILABLE` 或 retryable | 区分商业额度和技术限流，显示 retry-after 若可用 |
| 5xx/timeout before ACK | `ACK_UNKNOWN` 或 retryable | 根据幂等/查询合同判断，不能一律“失败” |
| partial/degraded payload | `PARTIAL/DEGRADED` | 保留成功数据，逐项说明 |
| unknown schema/state | fail-safe | 不渲染伪成功；记录兼容性错误并保留旧结果 |

HTTP status 不是最终文案；同一 409 可能是版本冲突、已有 active task 或幂等 payload 冲突，必须以稳定 error code 分辨。

## 6. 长任务、事件与实时更新

长任务的 durable truth 在服务端/Workflow，不在浏览器计时器。正式方案必须定义：

- create/accept 返回的 Run ID 和幂等身份；
- snapshot operation、步骤/成本/error schema 和 freshness；
- polling/SSE/WebSocket 的授权、重连、backoff、visibility、乱序/重复处理；
- cancel/late completion/terminal reconciliation；
- notification/outbox 到客户端的 delivery/ack/read semantics；
- 跨设备、跨标签页和 Workspace 切换后的重新订阅；
- 聚合 Runs/Incidents 读模型失败时的 direct object fallback。

事件用于更新提示，不直接绕过服务端 snapshot 改 canonical object。Temporal replay/outbox redelivery 必须按事件 ID/version 去重。

## 7. Capability、Entitlement 与 Allowed Actions

目标控制面应提供有版本的 capability manifest、Workspace entitlement/quota、对象 allowed actions/redactions 和必要配置。客户端使用同一版本做导航、表单选项和动作解释，但服务端在提交时重判。

manifest 不存在/过期/解析失败时：保留已知只读对象，隐藏或禁用高风险动作并标 unavailable/stale；绝不能默认开放。具体 schema 属 `BLK-FE-003`，本阶段不伪造为已存在端点。

## 8. 缓存和一致性

- cache key 至少含 environment/Workspace/object/type/query/contract version；不得跨 tenant 去重。
- 写后只更新受影响对象/读模型；不以全局 reload 掩盖依赖关系，也不乐观标高风险终态。
- persisted cache、offline queue 和 service worker 只有在数据分级、加密、退出清理和冲突策略批准后启用。
- stale time 按对象风险决定；Claim/Approval/allowed action/发布授权在动作前重验。
- 前后端 clock 不作为业务终态；使用服务端 timestamp/version。

## 9. 导入、迁移与退出

旧官网、产品/素材/客户批量导入以及未来 Shopify/Amazon/WordPress 等来源必须复用有状态 Import/Migration pattern，而不是在各模块上传一个 CSV 后静默处理：

| 阶段 | 必须可见的合同/体验 |
|---|---|
| Connect/authorize | 来源、scope、凭据归属、数据权利、只读/写入和撤销方式 |
| Inspect/preflight | 数据量、字段/文件、locale、限制、成本、预计耗时和不支持项 |
| Map/preview | source→canonical field/object 映射、样例、归一、重复/冲突和不导入项 |
| Dry run/approval | 将创建/更新/跳过/拒绝什么，是否可回滚，谁批准 |
| Execute | durable Run、幂等、分批/断点、部分成功、限流和取消语义 |
| Reconcile | 逐项结果、provenance、duplicate/conflict、修复和只重试失败范围 |
| Rollback/undo | 只有真实补偿合同才承诺；区分撤销新对象、恢复字段和不可逆外部动作 |
| Ongoing sync | direction、source of truth、频率、冲突、新鲜度、删除传播和停用 |

数据退出/停用必须在关闭账号或降级前说明可导出的对象/格式/版本、素材与 Release、审计/法律保留、生成下载、删除等待期、域名迁出、集成撤销、在途任务、重新开通和最终删除证据。套餐降级不能静默丢弃超额站点、成员、语言或历史；应进入只读/选择保留/导出等经批准状态。

这些能力当前多为 `PROPOSED/EXTERNAL_OWNED`。没有对象、合同、权利和退出计划前，不因 Word/OSS 提到连接器就在导航点亮。

## 10. 前端安全

| 风险 | 最低控制 |
|---|---|
| XSS/富文本/AI 输出 | 默认文本；批准 sanitizer/allowlist；禁止执行上传/模型 HTML、script、event handler |
| CSRF/session | 由认证架构明确 cookie/header/origin 策略；不能假定 bearer 自动解决所有场景 |
| external links | 协议/域名显示、安全 `rel`、下载/重定向告知；不透传 token/query |
| upload | 类型/大小客户端提示 + 服务端验证/扫描；preview sandbox；对象存储 key 不泄漏 |
| Secret/PII | 不进 bundle、URL、analytics、console、error report；复制/导出显式授权 |
| clickjacking/embed | SaaS/preview/public output 分开 CSP/frame policy；编辑器 preview 隔离 |
| supply chain | lockfile、来源、License、审计、更新/退出门；Phase 7 决策后才引入 |
| prompt injection | 外部内容当数据；工具/权限/预算在服务端守卫 |

具体 CSP、cookie、security headers 和依赖选择必须结合正式部署建模；本文件不修改 infra。

## 11. 契约变更门

1. OpenAPI/event/schema 的 additive/breaking 分类和 Owner；
2. 生成/校验 client 在 CI 比对 drift；禁止未经验证的 TypeScript cast 充当 runtime validation；
3. contract fixture 覆盖 success/empty/partial/error/unknown enum/version；
4. consumer/provider contract tests 与兼容窗口；
5. feature flag/capability manifest 协调后端先发、前端先发和 rollback；
6. 更新 Capability/Page/Scenario/Copy/Guide/Release Bundle 追踪；
7. 删除旧字段/operation 前有 telemetry、迁移和消费者确认。

当前 `CON-FE-012/013/017` 继续开放；本文件不顺手修改权威架构统计、dated 接入说明或 runtime SiteSpec 实现。

## 12. 正式技术方案前的输入

`BLK-FE-001/003` 关闭后，Phase 5/实施方案才选择 repo、runtime/framework、rendering/BFF、contract generator、query/state、forms、i18n、observability、testing、deployment 和 ownership。候选必须用首个纵切场景、性能/a11y、安全、维护和退出成本比较，而不是继承 Word 或 Mock 技术栈。
