# R4 最小 machine/runtime 安全差额提案

> 生命周期：`APPROVED`
> 生命周期依据：用户已批准的 R4 规格；实现随 #545 与 GrowthOS 补丁线推进，尚无 RuntimeEvidence

状态：**APPROVED_SPEC / IMPLEMENTATION_IN_PROGRESS / NO_RUNTIME_EVIDENCE**。

用户已明确同意本 R4 方案及另行界定的旧执行处置。原审查草案 SHA256：`7ecb2247d670608805d007cb084da874c15d9f57c99387cdfd799b060d03f6d1`。本文记录已批准设计，不表示代码、凭据或部署已完成；切换前仍须逐项取得事实证明。

本文件为经独立审查并获用户确认的规格，不是产品实现、凭据安装、服务部署或 RuntimeEvidence。只推荐下述一个方案；未探测 retained DB/secret/TLS，不假定任何机器证书、签发端点或服务账户已经存在。

## 1. 结论与边界

推荐：在现有 GrowthOS Backend 内增加一个固定用途机器 JWT 签发组件，以单独的受控 mTLS token 入口供 Backend 进程 bootstrap/刷新；GrowthOS 自己的 reader/撤销 consumer 直接调用同一固定用途组件，不通过用户 Session，也不依赖静态 token 文件。Backend API、客户 Worker、平台 Worker 使用同一 Backend OCI digest 的不同职责入口。GrowthOS 撤销 consumer 在现有 GrowthOS Backend 进程内运行独立生命周期与 durable lease，不依赖平台业务 readiness。

不建设独立 Key Authority、OAuth 平台或客户计费系统。不新增订阅、Credits、充值、次数收费；机器 token、TLS 证书和资源限流均不是客户费用门。JWT 取得不签发 Budget Grant，不触发 Workflow、Provider、schedule 或模型。

依据：`/var/tmp/parity-r4-machine-runtime-gap-audit-20260913.md`；已批准 platform-proof 规格 §2–6；已批准 revocation recovery 规格 §4、§6–7、U1–U5。审计表明当前只存在独立签名/验签、reader、receipt/lease 等部分积木，没有完整 bootstrap 与 retained 拓扑。本提案所有新增选择在 §8 集中列明。

权威措辞明确：已批准 platform-proof §4 规定请求 service JWT 由 SaaS Control Plane 签发，GrowthOS 是本计划中该 SaaS Control Plane 的实现，不是在 R4 更换组织/产品权威。新增选择是**GrowthOS 现有 identity keyring 的 server-owned `capability-request` profile、mTLS mint 装配与刷新协议**；不是“把原本独立第三方 issuer 改成 GrowthOS”。此前底层测试签 JWT 不等于这套产品装配已存在。

## 2. 唯一机器 token 路径

```text
Backend 进程自己的 mTLS client certificate + private key
  → GrowthOS 专用内部 HTTPS token endpoint
  → 证书身份与固定 workload/profile allowlist 验证
  → GrowthOS 固定 profile signer
  → 5 分钟机器 JWT，仅驻留调用进程内存
  → 正式 TLS + JWT consumer（GrowthOS capability 或 native Temporal）

GrowthOS 本进程 reader / revoke consumer
  → 同一 fixed-profile signer 的内部接口（不暴露给用户参数）
  → 自己对应用途的短期 JWT
  → Temporal reader mTLS / Backend target lookup HTTPS
```

### 2.1 Bootstrap 身份：明确的新增安全选择

新内部 operation `issuePlatformMachineToken_v1`，具体 HTTP path 只由后续唯一 code-first 合同定义。固定 POST JSON、no-store；请求仅 `{profile, nonce}`，nonce 为新生成 32 位小写 hex；不得提交 sub/issuer/audience/scope/permissions/TTL/JWKS URL。profile 仅从有限机器用途枚举中选择，证书对应的 allowlist 再限制该值，不存在 wildcard 或通用 claim 注入。

选择 mTLS client certificate，不引入 client_secret/refresh_token、用户 token 或长期 bearer bootstrap。部署 manifest 精确绑定 client certificate SPKI SHA-256、subject、workload role、允许 profile 集合、有效期及配置 revision；证书链、clientAuth EKU、有效期和配置记录全部通过后才可签发。证书名称不是独立授权；没有 manifest 登记，即使同 CA 签发也拒绝。

专用 machine-bootstrap client CA 必须与 Temporal internode CA、Temporal reader CA 分离；部署私钥不得复用。入口直接消费受控 TLS connector 的 peer certificate，不信任客户端 `X-Client-Cert`/`X-Forwarded-*`。不经未证明可剥离伪造头的通用反代。受控 TLS server CA/hostname、客户端证书与配置安装均是待批准及 readback 的新部署对象，不声称现有 loopback HTTP/Unix relay 已满足。

Backend API、platform Worker、customer Worker 使用不同 client key/cert 和不同固定 subject。相同二进制不表示可以互换 workload credential。Outbox Relay 如果不调用本次 token profile，则不分配 bootstrap 证书；不能为了方便给所有进程同一个全用途证书。

请求体 ≤1 KiB，响应 ≤24 KiB，其中 JWT ≤16 KiB；总 deadline ≤2 秒、禁止 redirect/HTTP downgrade/非受控代理；未知 profile/错误证书在签发前拒绝。签发入口只依赖自身 release admission、TLS 身份、固定 signer/keyring、必要审计持久化和受控配置，不依赖平台 Worker aggregate readiness，防止 bootstrap 环路。每 workload 原子技术限流由显式部署配置给出，不设置客户业务额度。

### 2.2 签名根与固定用途矩阵

| profile | issuer/keyring | 接收方与权限 | 可取得者 |
| --- | --- | --- | --- |
| capability-request | GrowthOS issuer；复用 identity keyring，增加 server-owned 固定用途 | GrowthOS；aud=`platform-automation-capability-read`，scope=`platform-automation-capability-read`，typ=`platform-automation-capability-reader+jwt`，固定 Backend service sub | Backend API、需要读取该 capability 的 platform Worker；分别登记 |
| target-reader | 已批准 identity root 复用，仍须 U1 验证 | 既有 R1 `typ/aud/scope`，固定 GrowthOS control-plane sub 与 targetIssuer 映射 | GrowthOS 内部撤销 consumer；**不通过远程 token 入口发给 Backend** |
| temporal-reader | 新增 GrowthOS temporal-runtime RSA keyring | 已有 native Temporal audience；精确 `platform-automation:read`，固定 GrowthOS reader sub；仍要求 reader mTLS 与三个 RPC allowlist | GrowthOS 内部 reader；**不通过远程入口发给 Backend** |
| temporal-platform-worker | 同一 temporal-runtime keyring、独立固定 sub | 仅 `platform-automation:worker`，由新增服务端 closed Worker RPC authorizer 授予 §2.2.1 的精确执行方法；**不签 broad write/read/admin/system role** | Backend platform Worker 的专用 bootstrap 身份 |
| temporal-customer-worker | 同一 temporal-runtime keyring、独立固定 sub | 仅客户 namespace 的 worker；复用同一 closed Worker RPC authorizer，禁止 platform namespace 权限与 broad write/admin | Backend customer Worker 的专用 bootstrap 身份 |
| temporal-customer-client | 同一 temporal-runtime keyring、独立固定 sub | 客户 namespace 的已登记 API 启动/读回所需权限，禁止平台 schedule/admin | Backend API 的专用 bootstrap 身份 |

Temporal permissions 字段沿当前 native server 官方 JWT claim mapper 的 wire schema，不另造 scope→namespace 隐式翻译。当前 `roles.json:8–10` 确实把 backendWorker 配成 worker+write，不能把它说成当前缺了 worker 权限；本提案明确**收窄它**，移除 broad write 并增加精确服务端执行能力。customer profile、新 issuer/root 和 closed Worker authorizer 均是新增差额。没有 `temporal-system:admin` 自动签发 profile；namespace/schema/schedule provisioning 继续独立精确操作授权，不能经此入口取得管理员 token。

专用 `temporal-runtime` keyring 的理由：普通用户 identity 签名根不应因 R4 自动获得 Temporal worker/write 权限。它是 GrowthOS 中一个 keyring+signer profile，不是新 Key Authority 服务。与 identity/site-build-budget/execution-budget/capability/revocation/ACK key 用途不可混用；native Temporal JWKS 只发布 temporal-runtime 公钥，普通 identity JWT 即使同 issuer 也不能授权 Temporal。新增 keyring 与用途隔离须用户明确批准。

所有新机器 JWT 为 RS256、非空 bounded kid、闭合 header/claims，TTL=300 秒，iat/nbf/exp 按各正式 verifier 合同校验，最大未来偏差 60 秒，严格到期拒绝。capability-request 的 typ、唯一 scope 与服务 sub 由 code-first matrix 固定并跨语言测试；保持既有 audience 不变。Temporal JWT 使用 native mapper 的 permissions 字段以及固定 iss/aud/sub/jti/iat/nbf/exp；不得因不同 profile 放宽 audience 或接受额外系统权限。下节已核实当前 delegate 不绑定预期 issuer、不要求 jti，因此固定 issuer、UUID jti、closed profile 的校验是明确新增安全边界；jti 不被夸大为服务端一次性消费账本。

### 2.2.1 核实的 native 真值与拟新增 Worker authorizer

精确本地源码：`/global/backend/infra/temporal-platform/server/go.mod:8` 锁定 `go.temporal.io/server v1.31.2`；`server/cmd/server/main.go:82–86` 使用官方 DefaultJWTClaimMapper，再包装 readerpolicy；`readerpolicy/policy.go:73–86` 先委托验签，非 reader subject 直接返回已验证 claims；`:202–217` 对非 reader subject 委托默认 Authorizer。当前 wrapper 的 reader 专项检查是身份、时间、证书与三个方法，不是通用机器 issuer/jti/profile 验证器。

对锁定 **v1.31.2** 官方源码逐项读回：DefaultJWTClaimMapper `GetClaims:71–103` 读取 sub/permissions；`parseJWTWithAudience:145–190` 验证签名、MapClaims时间有效性及已配置 audience，没有 expected-issuer 比较或 jti 必填约束。默认 Authorizer 按方法 metadata 所需 role 判定，Worker 的 poll/respond 等被 metadata 归为 AccessWrite；RoleWorker 的值低于 RoleWriter，所以不能仅删掉 write 后继续委托默认 Authorizer并声称 Worker 可用。[mapper](https://github.com/temporalio/temporal/blob/v1.31.2/common/authorization/default_jwt_claim_mapper.go#L71)、[authorizer](https://github.com/temporalio/temporal/blob/v1.31.2/common/authorization/default_authorizer.go#L33)、[roles](https://github.com/temporalio/temporal/blob/v1.31.2/common/authorization/roles.go#L7)、[RPC metadata](https://github.com/temporalio/temporal/blob/v1.31.2/common/api/metadata.go#L69)。这些是源码事实，不是 retained运行证明；也不是缺少签名认证的指控。

新增 closed Worker branch 必须在官方 delegate 对原 JWT 验签后校验固定 iss/sub/aud/typ/jti、精确单 namespace 的 worker-only permissions，写入不可由 token 伪造的内部 typed marker。Authorizer 仅对该 marker 执行以下 finite allowlist；未知 subject/profile、额外 reader/write/admin/system role、错 namespace、错实际 request type 全拒绝，不走 default write fallback：

- **poll/respond**：`PollWorkflowTaskQueue`、`PollActivityTaskQueue`、`RespondWorkflowTaskCompleted`、`RespondWorkflowTaskFailed`、`RespondQueryTaskCompleted`。
- **activity heartbeat/complete/fail/cancel ACK**：`RecordActivityTaskHeartbeat`、`RecordActivityTaskHeartbeatById`、`RespondActivityTaskCompleted`、`RespondActivityTaskCompletedById`、`RespondActivityTaskFailed`、`RespondActivityTaskFailedById`、`RespondActivityTaskCanceled`、`RespondActivityTaskCanceledById`。这里只确认/报告已分派 Activity 的取消，不授予 `RequestCancelWorkflowExecution` 或终止新目标的操作。
- **固定 SDK 所需生命周期与 history**：`GetWorkflowExecutionHistory`、`ResetStickyTaskQueue`、`ShutdownWorker`、`RecordWorkerHeartbeat`。不能将任意 Describe/List/Query 接口加入“read”通配。
- **系统只读健康**：仅 `/temporal.api.workflowservice.v1.WorkflowService/GetSystemInfo` 和 `/grpc.health.v1.Health/Check`，空 namespace、真实对应 request type；不签 `temporal-system:read` 或 admin。官方 `frontend_api.go:7–10` 将这两项归为 health，而当前 reader wrapper 特意仍拒绝 reader 的 GetSystemInfo；这次只为固定 Worker profile 保留它们，不扩大 reader 三 RPC。[health API 真值](https://github.com/temporalio/temporal/blob/v1.31.2/common/authorization/frontend_api.go#L7)

所有 namespace-bearing RPC 比对 interceptor 解析的 authority namespace 与 request namespace；poll 还绑定正常 task queue 及 SDK sticky queue 的本 workload/namespace 关联，不能只允许一个常量导致 sticky poll 失效，也不能 wildcard 到其他队列。token-based completion/heartbeat 必须用 native 既有 task-token 解析/校验绑定已分派 namespace/run/task，不能信任 caller 字符串覆盖 token namespace；无法恢复其原生绑定则拒绝。具体 SDK sticky queue 和 task-token integration 必须在 disposable真实 Worker矩阵中证明，不能用 fake request 绕开。

明确拒绝 `Create/Update/Patch/DeleteSchedule`、`StartWorkflowExecution`、`SignalWithStartWorkflowExecution`、`ExecuteMultiOperation`、外部 Signal/Cancel/Terminate/Reset、所有 namespace/admin/OperatorService/WorkerDeployment 配置 API、Nexus 和 standalone Activity start。customer API 客户端仍使用独立 profile，不把其启动权限借给 Worker。

实现不得把上面 closed Worker 执行授权等同 broad NamespaceWriter。WorkflowTaskCompleted 自身可携带合法 workflow commands；本提案不是对受损 Worker 做完整 workflow-command沙箱，固定 DAG/source identity 和既有预算/fence仍是业务控制边界，不能宣称仅禁 Start RPC 就阻止一切 workflow 内部派生行为。若实际锁定 SDK 需要列表外 RPC，先记录真实失败并做明确最小 delta 审查，禁止补回 broad write。

新 keyring 遵循 existing ACTIVE/VERIFY_ONLY、RSA≥2048、0600 与只输出公共 JWKS 字段的边界。部署值、CA、issuer、kid 集合、certificate SPKI 只通过受控配置，不从请求选择。没有 temporary-key 或 unsigned fallback。

### 2.3 自动刷新、重放与停用

客户端按 profile/固定 subject 在进程内保存 token；剩余有效期 ≤60 秒时 single-flight 刷新。后台刷新失败只允许此前取得且尚未到期的 token 在其原权限和原 expiry 内继续使用；这**不允许**复用已经失败或过期的 capability snapshot。到期、主体停用、信任配置变化、运行身份变化立即停止用旧 token，冷启动无 token 就 unavailable。重启必须重新走 mTLS bootstrap；无磁盘长期 bearer token、无浏览器存储、无 refresh token。

HTTP token 响应闭合绑定 profile、nonce、固定 sub、issued/expires、签名 token，客户端核对 nonce/profile/sub/时窗及签名根后才缓存。不把服务响应中的任意 audience/URL 当配置。Backend 不自行签这些身份。

机器 access JWT 是最多 5 分钟的可复用 access credential，**不是一次性 Budget Grant**。jti 用于唯一标识/安全审计，不增加每次读取的“消耗 jti”门，避免一次 token 只能跑一次正常 capability 刷新。每次实际 capability 请求仍使用独立 nonce；旧响应不能刷新新快照。token mint response 丢失可重新 bootstrap，最多得到另一个同权限且短期 token，不产生业务 effect。原响应 nonce 只能给当前等待请求使用；无 token 原文审计存储。

新增 append-only 机器签发安全审计只记 workload/profile、certificate SPKI、jti、token digest、iat/exp、nonce digest、配置/制品 revision；不记私钥、Cookie、JWS、HTTP 原文或客户数据。审计不可写则不向请求方释放新 token。此表不是客户 Billing/Credits 账本。

停用 bootstrap credential 立即阻止新签发；已经签出的 access token 最长仍有 300 秒残余有效期，这必须作为本提案的显式安全取舍。普通 consumer 对 token 的 subject/profile 配置拒绝可立即阻止该 subject；应急 native Temporal subject denylist/根移除属于受控部署操作，不能声称只停 bootstrap 即已撤销全部旧 JWT。本差额不增加全局每 RPC token-jti 在线账本。

## 3. GrowthOS 内部签发与 reader 改造

GrowthOS reader 使用固定 `TemporalReaderTokenProvider`，由上面的 temporal-runtime signer 自动取得/刷新；删除正式 composition 对手工 reader token 文件的依赖。现有 file provider 可作为隔离测试输入或历史迁移参考，但不能保留为按环境选择的第二套产品实现。

Temporal reader mTLS certificate 与 JWT subject、固定 platform namespace、精确三个 RPC 一起验证；自动 JWT 不替代 mTLS。普通 frontend 可沿原配置合同 JWT-only，reader frontend 必须 reader mTLS；internode 始终独立 mTLS，拒绝 reader CA/cert。新 Temporal keyring 公钥通过单独只读 JWKS 发布；真实 reader negative proof 必须绑定 exact native image 与授权 revision。

GrowthOS target-reader 直接由内部固定用途 provider 取得 identity-root token，只有 revoke consumer 可调用此 provider，不新增给用户或 Backend 的任意 token mint API。消费者仍按批准的 2 秒 HTTPS lookup、nonce/tuple/观察 freshness 校验。缺 U1/U2 仍 not ready；不可回退到裸 HTTP/静态文件。

## 4. Backend Worker/namespace/lease：明确推荐拓扑

采用**一个目标 native Temporal cluster**、同一 server exact image/Authorizer，实现两个明确 namespace 的职责隔离：

| 入口/组件 | namespace/queue | 允许职责 | durable identity |
| --- | --- | --- | --- |
| Backend API | customer=`default`，客户 queue 保留既有 `understanding` 合同 | 客户 Workflow 客户端；只读 capability 消费及现有受限控制面 | API lease，不冒充 Worker |
| Backend customer Worker | `default` / `understanding` | Site Builder、理解、客户任务；不注册平台 sweep handlers，不持平台 schedule 写凭据 | 既有 WORKER 语义明确为 customer；namespace/cluster/queue 必填 |
| Backend platform Worker | `platform-automation` / `understanding` | 四个已登记 platform workflow/activity；每 wire 仍受 Grant/fence/UNKNOWN containment | 新 PLATFORM_WORKER lease 与单独 LOGIN/group |
| Backend Outbox Relay | 无 Temporal namespace/queue | 原有 Backend Outbox，不拿它的 lease 代替 GrowthOS revoke consumer | 原 OUTBOX_RELAY lease |
| GrowthOS revoke consumer | 不通过业务 Temporal Worker 执行 | lookup、原字节 revoke/ACK 读回、批准条件内 successor、公平 cursor | GrowthOS durable component lease，见 §5 |

最小推荐明确**保留两类 namespace 下各自的 `understanding` queue 名称**。当前 Backend worker.ts:507 与既有 task queue 合同使用 understanding；队列实际隔离键是 `(cluster, namespace, queue)`，不同 namespace 下同名 queue 不混消费。没有代码证据要求改名，因此删除前版草案提出的 platform queue 改名及其额外 schedule/action/golden 迁移；Worker 职责隔离不靠字符串改名实现。部署时仍逐字核对既有 schedule action 中 namespace/type/queue/input 与受控 source/policy digest，不能以“保留名字”为由放宽 proof。

同一 Backend OCI image 增加显式 `customer-worker` / `platform-worker` 入口；业务模块注册由代码内固定 workload kind 决定，不由任意 env 导入 handler。环境之间只替换资源/凭据/endpoint/trust。用户批准的是职责隔离，不是“两套开发/生产逻辑”。

Runtime lease additive contract：加入 `temporal_cluster_id`、`temporal_namespace`、workload kind；Worker 还绑定 taskQueue。cluster identity 是受控部署标识+证明摘要，不是仅凭地址或响应自报的值。API/Relay 的 Worker 专属字段用明确 NULL 形状，不默认填 `default`。新增 `runtime_platform_worker` group 与专用 LOGIN 只能登记自己的 role/instance lease；它不是 owner/BYPASSRLS。API/customer/platform/Relay source/image/artifact 一致；同 `(cluster, namespace, queue)` 不允许两个 active digest。旧缺 namespace 的 lease 不回填假值、不算新就绪证明。

customer Worker 不加载 platform writer/Temporal platform 权限；platform Worker 不获得 customer scope 写权限。它们可以共享通用调用/预算库，但 composition 提供的 principal 与 task registry 不同且固定。新增进程凭据和 DB role 的权限清单必须独立 review；本提案不假定现有凭据可共享。

平台启动链：native/JWKS/DB → GrowthOS 独立 revoke consumer → 无 RUNNING workflow 也可取得 capability → platform Worker admission → 用户/运维已授权的 schedule 工作。capability 的 Temporal 事实依旧不要求启动新 workflow。客户 Worker 按其客户能力 admission 接单；系统整体 readiness 可汇总所启用产品能力，但 revoke/lookup/bootstrap 的诊断与恢复入口不能依赖此 aggregate，从而不存在 Worker→consumer→Worker 环路。

### 4.1 现有 cluster/history 的切换约束

上述“一个目标 cluster”是推荐终态，不意味着已证明可把现有 start-dev/SQLite 历史直接搬到 native PostgreSQL。实施前必须只读 inventory 精确现有 cluster、namespace、queued/running Workflows、Schedules 与读回路径；未解决的 active history 禁止切换，不重新提交成新 run。

推荐 drain 到零 active work 后再切换新工作；旧 terminal histories/数据库只读保留为历史 provenance，绝不把它们标成新 cluster history。旧 BuildRun 的状态/日志/history 读回必须继续准确定位旧 cluster，或已存在的持久 terminal 读模型能满足正式合同；这一兼容性须验证后才能 cutover。不能靠停止旧服务或只复制 workflowId 即声称迁移成功。若验收要求在途历史不停机迁移，本最小方案不承诺，必须另立历史迁移决定，不能偷偷变成导出导入/重跑。

## 5. 独立撤销 consumer：不增加另一套调度系统

推荐在现有 GrowthOS Backend JVM 中装配一个独立生命周期 consumer executor，而非另起带全套 signer secret 的新服务。它和 HTTP/bootstrap/reader 同一 exact GrowthOS 制品，但其启动/暂停只看自身 release admission、DB、key/clock/TLS 与原请求绑定，不受业务 aggregate 或 platform Worker READY 阻断。

每个 GrowthOS 实例可运行该组件，MySQL durable lease/CAS 决定 schedule/recovery cursor 的单 writer；不是用进程内 Map 选主。新增 component kind=`REVOCATION_CONSUMER`，绑定 instanceId、GrowthOS authority/patch/image digest、cursor ownership、started/lastSeen/expires、state。周期与新鲜度沿批准的 lease ≤30 秒；lease 只能在实际 consumer tick、DB/schema/权限、必要 key/transport readiness 通过后续租，不能由 HTTP health 线程替 idle/dead consumer 续租。

需要持续续租时复用已批准 MySQL持久模式和行锁/CAS；过期或 losing lease 实例不创建新 attempt，已在途 ACK 只在重新验证 request/attempt 归属与幂等事务后接收，不重复推进 effective。JVM重启从 durable cursor 继续；逻辑 pending count 和 oldest 原请求时间不可因重启/successor 变化。

consumer 仅持既有 GrowthOS revoke/outbox/ACK 事务所需 DB 权限及固定内部 signer interfaces；不调用 Grant issuance、不启动 Temporal schedule、不执行 Provider。同 JVM 内的接口隔离不是 OS 级密钥隔离，不夸大安全边界；现有 JVM 本就持这些根是否成立仍须 U1/U4核验。如果现有 key管理不能维持此固定用途边界，不自动把私钥复制到新进程，应回到具体差额审查。

## 6. 冷启动、失败、证据与回退

1. 冷启动无 token、无 capability 缓存：可暴露诊断，禁止新平台 work；先按 mTLS bootstrap 建立固定机器身份。
2. GrowthOS token签发 unavailable：后端不伪造token；strict expiry后不再调用。capability刷新失败立即not ready，不延长底层事实寿命。
3. Temporal认证/方法/namespace错误：reader/proof失败，拒绝Grant相关工作；不能fallback到default namespace、裸连接或客户端假授权。
4. revoke clock/key/TLS/legacy binding未知：按现有批准规格保持pending，能安全原字节ACK读回时继续，不创建无依据successor。
5. 部署先停新工作、核实active histories，再drain-and-swap exact images；新增证书/key/lease schema均有精确manifest与备份，不采用共享mutable dist。
6. 回退不删除任何request/attempt/ACK/history，不重新enablefence；若旧binary不理解新role/namespace/attempt语义，保持not ready并forward-fix，不自动切回旧无认证worker。

RuntimeEvidence须绑定机器profile配置revision、各JWKS kid集合摘要、TLS CA及clientSPKI摘要、Temporal授权revision、两类Worker的cluster/namespace/queue/lease及GrowthOSconsumerlease，并分别记录coldstart与一次token自动刷新。只写摘要，不保存token或privatekey；凭据安装或静态配置存在不是权限证明。

## 7. 必须审查与验证的负例

- 用户/quote/Grant/ACK/capability token不能bootstrap；无证书、错CA、正确CA但未登记SPKI、证书过期、profile越权、caller自填claims、旧配置revision失败。
- Backend API证书不能取得platform-worker或reader profile；customer Worker不能取得platform namespace权限；reader cert/JWT仍不能写/跨namespace/internal-frontend。
- 身份JWT不能冒充Temporal JWT；Temporal JWT不能访问capability/target lookup；capability签名key不能作为身份root。
- Token refresh实际使用同一正式路径：冷启动、single-flight、exp边界、响应nonce错配、慢响应/redirect、刷新失败、进程重启、key轮换与旧key去除；永不接受过期JWT。
- 停bootstrap与已签token残余窗口的真实行为和文档一致，不冒充即时全token撤销。
- 无RUNNING业务workflow时，consumer与capability可以独立启动；consumer停摆/lease失效或pending>30s立即拖垮相应capability，不用零outbox假绿。
- 两类Worker只能poll自己的namespace/queue；缺cluster/namespace的旧lease、混digest、错principal、cross-role写lease都失败。
- 服务端实际RPC矩阵与typedscope/profile/golden vectors跨Java/TypeScript/Go一致；tests不替换官方JWT mapper/native Authorizer。
- 最终三次deterministic产品旅程与受控重启，existingGrant/UNKNOWN不重发合同不变。未验证内容保持HOLD，不将本草案计为RuntimeEvidence。

## 8. 批准边界：哪些沿用，哪些新增

**沿用已批准、不重开产品方向：** 专用serviceJWT用途、GrowthOS签发/Backend验签、capability独立签名根与nonce/fact-expiry、target-reader身份根复用前提、Temporalreader mTLS+精确RPC、平台namespace、同一产品制品路径、独立revocationconsumer、append-only同sequence恢复、客户商业计费deferred。

**本提案新增，必须独立安全审查后由用户确认：**

1. GrowthOS内部mTLS机器token端点、独立bootstrap client CA、按workload证书SPKI绑定有限profile，以及其新证书/服务权限范围。
2. GrowthOS 作为既有 SaaS Control Plane，新增 identity-root `capability-request` 固定profile装配；新增独立temporal-runtimekeyring/JWKS与固定issuer/jti/profile绑定；将当前worker+write收窄为worker-only并增加closed Worker RPC authorizer及明确系统健康例外；customerclient独立profile、自动5分钟accessJWT/60秒提前刷新与最长300秒停用残余窗口。
3. 一个目标nativecluster中的customer/platform职责隔离、显式两个Worker入口、新PLATFORM_WORKER DBlease role/专用principal、cluster/namespace/queue绑定；**保留各自namespace内现有understanding队列，不新增为改名而做的schedule/action/golden迁移**；以及零activehistory后切换与旧历史保留兼容条件。
4. GrowthOS现有JVM内独立consumer生命周期+durablecomponentlease的具体拓扑，不复用Backend OUTBOX_RELAY lease冒充它；机器签发append-only安全审计不是Billing。

**仍是事实门，批准也不能豁免：** U1当前根与签发管理、U2受控TLS链、U3旧请求schedule-wide授权、U4现有DBprincipal/monitoredclock/key保留、U5无target只能pending。新服务证书/key/secret尚未存在或未核验；当前Temporal/customer历史与完整最小RPC权限必须inventory。不要求用户猜这些技术事实，先独立只读核实，无法满足本方案才报告具体差额。

可给用户的精确确认句：同意“GrowthOS作为既有SaaS Control Plane，在identity根装配固定capability请求profile和mTLS机器token入口，Backend自动取得/刷新；Temporal使用独立签名root与固定issuer/profile，Worker仅得closed执行RPC与必要健康权限、不得broadwrite/schedule/start/admin；同一Backend镜像拆分客户/平台Worker并绑定namespace/queue/lease，保留各自namespace内现有understanding队列；GrowthOS既有进程内独立持久撤销consumer；保留未知状态与旧历史，所有新凭据/切换逐项取证，不增加客户计费或Key Authority服务”。

在独立review与此确认前，只能做合同/测试准备与已授权只读事实核验，不据此签发/安装新凭据、迁移保留数据库或切换Temporal。现有广泛部署授权不替代这些新安全角色/信任根的规格决定。
