# platform-worker 依赖排空策略修正 · 落地设计文档（2026-11-06）

> 生命周期：`APPROVED`
> 生命周期依据：2026-11-06 产品负责人批准 D-a~D-f 推荐值（「批准开工」）；批准前已完成 §0.6 三项门禁（设计文档 §4 / 闭环设计 §5 / 联网研究 §10）。
> 任务启动门（计划 §0.6）：① 设计文档（本文）② 闭环设计（§5）③ 联网研究（§10）→ 产品负责人过目批准 → TDD。

## 1. 背景与目标

**事件**（2026-11-05 19:20 UTC，发车 #822 期间）：部署窗口的首次 `gctl switch-backend` dry-run 因 readiness 503 被拒——platform-worker 因平台权威（gain-saas capability/budget authority）检查失败，按 fail-closed 设计自行排空（`runtime_process_lease` READY→STOPPED、Temporal worker DRAINED）。容器仍在，但平台工作流（渠道抓取等）约 1 小时无人消费；人工 `runtime.sh restart platform-worker` 后约 1 分钟恢复。记录见 `_archive/backend-runtime-switch-04befb55-xin-20261105/README.md`「之后」节。

**现场证据**（`runtime_process_lease`，本次核验）：

| instance | state | build | started | last_seen | stopped |
| --- | --- | --- | --- | --- | --- |
| `0a077836…` | STOPPED | `dd23a123` | 19:03:37 | 19:20:15 | 19:20:15 |
| —（无任何新实例注册） | — | — | — | — | — |
| `af3f71b1…` | STOPPED | `dd23a123` | 20:23:55 | 20:24:55 | 20:24:55（人工重启） |

19:20:15 排空后到 20:24:55 人工重启之间**没有任何新实例写过 STARTING**——进程没有退出、编排也没有拉起新容器（compose 该镜像已带 `restart: unless-stopped`）。即：排空后的进程一直存活但不再轮询，这是「永久停摆」的直接机制。

**代码链路**（全部已核对）：

1. 能力快照缓存 `createCapabilityCache`（`apps/api/src/platform-authority/platform-capability-cache.ts`）：刷新每 10s 一次、单次超时 3s；**任何一次刷新失败即清空 `cached`**（`.catch(() => { … cached = undefined })`），尽管上一份已签名快照按签发方契约还有效（`expiresAt - issuedAt ≤ 30_000`，`platform-capability-rows.ts:74`）。
2. 外层 `CapabilityRuntime.refresh()` 的 `.catch(() => this.invalidate())` 把整个缓存对象丢弃，同样不区分「本次刷新失败」与「身份/配置失效」。
3. platform-worker 依赖心跳（10s 一次）经 `checkPlatformAuthorityReady`（`apps/api/src/temporal/platform-authority-readiness-gate.ts`）把**任何**权威不可证明都折叠成 `{ code: 'PLATFORM_BUDGET_AUTHORITY_NOT_READY', drainImmediately: true }`；`startWorkerDependencyHeartbeat` 对 `drainImmediately` **首个失败即排空**（`#683` 的契约，回归测试 `platform-authority-capability-regression.spec.ts` 锁着）。
4. 排空 = `worker.shutdown()` 优雅关停 + 租约 DRAINING；`worker.run()` 结束后 main 的 finally 写 STOPPED 并清理。Temporal `Worker` 实例一次性，进程退出后只能靠编排重启、再走启动门重新准入；而 19:20 那次进程没有退出（见上表）。

**根因归纳**：一次持续约 30s 的 gain-saas 抖动（缓存每 10s 刷一次、连续失败 3 次即越过 30s 签名有效期）就能把「权威暂时不可证明」变成「永久停摆」——容忍窗口与恢复通路两者都缺。

**目标**：

1. 平台权威的**瞬时**故障不再造成永久停摆：≤签名有效期的抖动完全无感；更长的故障在权威恢复后**自动**重新准入（无需人工重启）。
2. **不放松 fail-closed**：权威已过期/不可证明时仍在下一个探针停止轮询；危险状态（撤销生效、绑定过期、鉴权失败、迁移不一致）同样立即停止。
3. 每次排空**必留痕**，且工作区自检（`gctl doctor`）能报出来。

## 2. 承重假设（可证伪）

1. **A1：签名快照在 `validUntil` 内可继续使用是安全的。** 快照是 gain-saas 签发、带 nonce 与 ≤30s 有效期的短时证明；`check()` 已按 `validUntil` 截止（`current >= row.validUntil` → unavailable）。证伪：找出消费方在 `validUntil` 之后仍采信快照的路径，或 gain-saas 期望撤销传播快于 30s。撤销的即时执行另有通路（egress fence 在 DB 内逐活动校验，见 A2），不依赖快照刷新。
2. **A2：平台工作的安全边界在逐活动授权，不在心跳。** 每个平台活动执行时重新走 Grant 签发/验签（`PlatformGrantAdmission` / `PlatformCrawlGrantClient` / `ExecutionBudgetGrantVerifier`）与 egress fence 校验；心跳层的「多等几十秒才排空」不会让任何未授权动作发生。证伪：找出一条平台活动路径在没有有效 Grant/fence 校验的情况下产生外部效果。
3. **A3：排空后经「进程退出 → compose 重启 → 启动门等待」恢复是正确且不放大风险的。** 启动门 `waitForWorkerDependencyAdmission` 在 STARTING 上无限重试、**不轮询**；危险状态持续时新进程会一直停在 STARTING（readiness 诚实 503），危险解除后 ≤30s 重新准入。证伪：复现并观察到启动门在权威不可证明时放行，或观察到 docker 重启风暴。
4. **A4：本设计能覆盖 19:20 的事件类。** ≤30s 的抖动被快照容忍吸收；更长的故障走自动恢复，停摆上限≈「故障时长 + 关停上限 + 启动门一个重试周期（30s）」。证伪：以受控演练（§7）制造 90s 权威不可用，观察是否在恢复后 ≤2 分钟回到 READY。
5. **A5：19:20 不是危险状态（撤销/漂移/绑定过期）。** 若当时存在持续的危险状态，人工重启后的实例会在首个心跳再次排空；实际恢复后稳定运行至今。证伪：查 19:20 前后的 gain-saas 撤销/绑定变更记录与 platform-worker 日志。

## 3. 触点（全部已核对）

| 文件 | 现状 | 改动 |
| --- | --- | --- |
| `apps/api/src/platform-authority/platform-capability-cache.ts` | 刷新失败即 `cached = undefined` | 刷新失败**保留**仍在上 `validUntil` 内的最后良好快照；到期后照旧 unavailable；新增 `verified()`——`refresh()` 失败也会 resolve，运行时只有持有已验证快照的新缓存才允许替换旧缓存 |
| `apps/api/src/platform-authority/platform-capability-runtime.ts` | 刷新周期固定 10s；失败外层 `invalidate()` 丢弃缓存对象 | 失败后 2s 快速重试、成功后回到 10s；普通刷新失败不再 `invalidate()`（身份/pin/token 失效仍立即清空） |
| `apps/api/src/temporal/platform-worker.ts` | `Worker.create` 无 `shutdownGraceTime/shutdownForceTime`；finally 清理无兜底退出；迁移不一致按 3 连败 | 加 `shutdownGraceTime: '30s'`、`shutdownForceTime: '60s'`；finally 内装 15s 强制退出兜底；`MIGRATION_REVISION_MISMATCH` 返回 `drainImmediately: true` |
| `apps/api/src/temporal/worker.ts`（客户 worker） | 同一套关停/心跳接线；启动期排空后 `holdWorkerNotReady` 永久等待、不再探测 | 同样的关停有界参数与退出兜底、迁移不一致立即排空；抽出完整的依赖检查并加启动门（`requireReady:false`），重启后等依赖恢复再自动重新准入，不再永久 hold |
| 新文件 `apps/api/src/runtime/worker-exit-deadline.ts` | — | 强制退出兜底的可注入实现（`exit`/定时器可测） |
| `apps/api/src/runtime/worker-dependency-heartbeat.ts` | 排空仅经 `onBlocked(code)` 打一行字符串 | 排空时额外输出一条结构化事件行（role/taskQueue/code/连续失败次数/时间），`log` 可注入 |
| `apps/api/src/runtime/worker-dependency-heartbeat.spec.ts` | 锁 3 连败/立即排空/loop-lag | 增：结构化排空事件；既有断言保持 |
| `apps/api/src/platform-authority/platform-capability-cache.spec.ts`、`platform-capability-runtime.spec.ts` | 锁「刷新失败即清空既有良好缓存」（`clears previously good cache on failure`） | 改为锁「有效期内保留、到期即失败」，增 2s 重试节奏 |
| `local-config/bin/gctl-doctor.py` | 无运行租约检查 | 新增「运行租约」节：经 `docker exec global-postgres psql` 读 `runtime_process_lease`；最新租约非 READY/不新鲜 → **警告**（不可登记为遗留）；最近 24h 的 STOPPED/DRAINING 转换 → **信息行**（含时间、build、当前是否已恢复 READY），避免每次部署都报警 |
| `local-config/RUNBOOK.md`、`/global/CLAUDE.md` 触发清单 | 排障入口只在归档 README | RUNBOOK 增「worker 排空与自动恢复」一节；CLAUDE.md 触发清单加一项 |

不改动：`checkPlatformAuthorityReady` 的「权威不可证明 → 立即排空」语义（`#683` 契约与回归测试保持）；`worker-dependency-heartbeat` 的 3 连败阈值与 loop-lag 跳过（`#794`）；能力快照签发契约（≤30s 有效期由 gain-saas 定义）；`runtime_process_lease` 表结构与上报函数（**无迁移**）；`/health/ready` 判定（`#627` 客户写入语义不变）。

## 4. 设计

### 4.1 能力快照：最后已知良好状态，容忍窗口=签发方签名（根因修复）

- `createCapabilityCache.refresh()` 失败时**不再清空** `cached`：`check()` 仍按每行 `validUntil`（≤ `expiresAt` ≤ `issuedAt+30s`）判定，到期即 unavailable——容忍窗口完全由签发方签名定义，不是本地启发式。
- `CapabilityRuntime.refresh()`：普通刷新失败保留上一份缓存对象；`current()`（身份/pin/机器令牌）失败、配置指纹变化、`stop()` 仍立即清空。
- 刷新节奏：成功后 10s 下一次；失败后 2s 重试（快照最多 30s 有效，2s 重试可在到期前追回；恢复时也更快补齐）。失败计数与退避不进持久层。
- 新缓存只有在 `verified()`（确实装入了已验证快照）时才替换旧缓存：`refresh()` 对失败也会 resolve（缓存层自己的旧语义），不设这道门会把**空缓存**装上去顶掉好的。
- 结果：第 1 条链路里「单次刷新失败 → 下一探针立即不可证明」不再成立；≤30s 的 gain-saas 抖动对心跳完全不可见。

### 4.2 排空后自动恢复：有界关停 + 确定退出 + 启动门重准入

- `Worker.create` 增加官方关停边界：`shutdownGraceTime: '30s'`（给在飞活动收尾）、`shutdownForceTime: '60s'`（超时强制关停，`run()` 以 `GracefulShutdownPeriodExpiredError` 拒绝）。排空或 SIGTERM 后的关停时长因此有上限；不会因一个不响应取消的活动把「已排空」拖成无限期。
- 两个 worker 的 main 在 finally 起始处装 15s **强制退出兜底**（`process.exit(0)`，unref 定时器）：覆盖 19:20 现场那种「STOPPED 已写、进程不退出」的清理悬挂。正常清理完成则清除定时器、按原路径退出。
- 进程退出后由 compose `restart: unless-stopped` 拉起（该镜像编排已带，2026-11-05 核实）；新进程在启动门 `waitForWorkerDependencyAdmission` **停在 STARTING**，不轮询、readiness 诚实 503，直到权威可证明后 ≤30s 内重新准入（READY）。危险状态持续时同样只重启不轮询，直到危险解除。
- **不采用**进程内重建 Temporal Worker：`Worker` 实例一次性（§10），进程内重建要做新 Worker + capability runtime + 租约状态机（DRAINING→READY）的全套生命周期，风险大于收益；进程重启复用的正是现有的启动门路径。
- 每次排空最多一次容器重启；启动门是进程内等待，不构成 crash-loop（进程不退出，docker 不会反复拉起）。

### 4.3 迁移不一致：危险码立即排空

- `MIGRATION_REVISION_MISMATCH` 是从 DB 读出的确定性事实（读失败另有 `PLATFORM_WORKER_DATABASE_UNAVAILABLE` 分支），不需要 3 连败观察；在 platform-worker 与客户 worker 的检查里直接返回 `drainImmediately: true`。滚动部署时旧镜像对新库会立即停止轮询并重启，由新镜像接手——这正是期望行为。

### 4.4 观测与告警

- **结构化排空事件**：`startWorkerDependencyHeartbeat.drain()` 输出一条 `{"event":"worker_dependency_drain","role":…,"taskQueue":…,"code":…,"consecutiveFailures":…,"at":…}`（`console.error`，容器日志）。`onBlocked` 既有行不变。
- **durable 痕迹**：`runtime_process_lease` 的 DRAINING/STOPPED 行（含 `stopped_at`、`build_sha`）本来就持久；本次不新增列（见 D-d）。
- **`gctl doctor` 新增「运行租约」节**：对 `WORKER`/`PLATFORM_WORKER` 查最新租约与最近 24h 的 STOPPED/DRAINING 行——最新非 READY/不新鲜 → **警告**（不可登记为遗留，会话开始即自检）；最近 24h 的 STOPPED/DRAINING 转换 → **信息行**（时间、build、当前是否已回到 READY），因为正常部署也会产生 STOPPED，不能每次都报警。排障入口写进 RUNBOOK。

### 4.5 评估过但不采用的候选

- **心跳层加「连续失败时间窗/指数退避」容忍权威故障**：会让「权威已不可证明」期间继续轮询，直接放松 fail-closed；且就绪投影把网络不可达与权威缺失折叠成同一组 `*_UNAVAILABLE` 状态，无法可靠分级（真正的分级信号在传输层，见 D-e）。容忍应来自签发方签名（4.1），不来自本地猜测。
- **只有危险码立即 drain、其余容忍**：同上——投影层没有可靠的「危险/瞬时」判别；且会改掉 `#683` 的回归契约。改为保持「不可证明即排空」，用 4.1 缩小「不可证明」的发生面、用 4.2 保证排空可恢复。
- **gain-saas 快照有效期加长（如 120s）以扩大容忍**：属 gain-saas 契约变更，削弱撤销传播上界，不在本次范围（记为后续可选项）。
- **进程内重建 Worker 自动重准入**：见 4.2。
- **与 #794「假阳性排空」的关系与回归风险**：`#794` 的 loop-lag 跳过解决的是「自身负载把探针拖过超时窗」的假阳性；权威探针读的是本地已签名快照（缓存检查无网络 IO），不存在同类超时。本次原样保留 3 连败阈值与 lag 跳过、回归测试不动；风险在相反方向——**不能**把 lag 跳过套到权威检查上（跳过一轮权威检查=延后 fail-closed），实现时权威探针仍走原 probe 路径。
- **readiness 503 主动告警**：现有 `/health/ready` 503 是发车门的判据，但单机工作区没有独立通知通道。本次把「告警」落在 `gctl doctor`（会话开始自动运行）+ 结构化 drain 事件 + 租约痕迹，足以在下次会话/排障时被看见；未来若接入通知通道，drain 事件行是现成接入点。

## 5. 闭环设计（§0.6 ②）

- **SoR**：签名能力快照（≤30s，gain-saas）、`runtime_process_lease`（状态机 STARTING/READY/DRAINING/STOPPED）、容器日志中的结构化 drain 事件、`gctl doctor` 报告。
- **故障→恢复闭环**：权威抖动 ≤30s → 快照容忍、无事件；>30s → 首个不可证明探针排空（DRAINING/STOPPED 落库 + drain 事件）→ 有界关停 → 进程退出 → compose 重启 → STARTING 启动门（不轮询）→ 权威恢复后 ≤30s 重准入（READY）→ doctor 显示最近一次排空与当前 READY。危险状态 → 立即排空 → 重启后停在 STARTING，直到危险解除；doctor 持续报出。
- **对外语义**：`/health/ready` 在无 READY 平台 worker 租约时保持 503（不变）；客户写入不因 `PLATFORM_WORKER_NOT_READY` 关闭（`#627`，不变）；平台活动仍逐活动验 Grant/fence（不变）。
- **端到端演示（合并后，需发车授权）**：在平台 schedule 处于 paused 的窗口做受控演练——使 gain-saas capability 端点不可用 90s：观察（a）<30s 抖动时不排空；（b）90s 时排空事件出现、容器自动重启、恢复后 ≤2 分钟 READY；（c）doctor 报出该次排空。
- **负向测试**：权威过期后**下一探针即排空**（不许多等）；`POLICY_DRIFT`/`BLOCKED` 立即排空；迁移不一致立即排空；身份/pin/机器令牌失效仍立即清空快照。

## 6. 迁移与回滚

- **无 schema 迁移**、无数据变更；全部为代码与运维脚本改动。
- 回滚 = 镜像回退到上一 digest（`gctl switch-backend`）；租约表、日志、doctor 检查向前/向后兼容（doctor 检查在旧镜像上只会看到常规状态）。

## 7. 测试与 TDD 步骤（先红后绿）

1. `platform-capability-cache.spec.ts`：刷新失败保留最后良好快照；`validUntil` 到期即 unavailable；成功刷新换入新行（撤销/换绑立即生效）；`stop()`/generation 语义不变。
2. `platform-capability-runtime.spec.ts`：失败后 2s 重试、成功后 10s 节奏（fake timers）；身份/pin/令牌失效仍立即 `invalidate()`；启动首刷失败不产生可用快照。
3. `worker-dependency-heartbeat.spec.ts`：既有「3 连败」「drainImmediately 即排空」「loop-lag 跳过」全部保持；新增结构化 drain 事件（注入 `log`）。
4. `platform-authority-capability-regression.spec.ts`：不改断言（危险路径语义保持），补一条「快照到期 → 首个探针即排空」。
5. 迁移不一致：抽出 platform-worker 的检查构造（或等价可测单元），断言 `MIGRATION_REVISION_MISMATCH` 带 `drainImmediately`；客户 worker 同。
6. `worker-exit-deadline.spec.ts`（新）：兜底定时器在 finally 装入、正常完成被清除、超时调用注入的 `exit`。
7. `gctl check`（约 100 秒）全绿；自审（逐文件 + 对抗复审）；PR 必需检查全绿后 squash 合并。
8. 合并后（需发车授权）：受控演练（§5）作为运行证据；结果写入 `docs/evidence/` 或归档 README。

## 8. 风险与开放问题

- **19:20 的悬挂点未被取证**（进程存活、无新租约）：4.2 的兜底同时覆盖「活动不响应取消」与「清理悬挂」两种位置；演练时用 `docker inspect` 的 `RestartCount` 与租约时间线确认退出确实发生。
- **强制关停可能打断在飞活动**（`#683` 的旧伤）：先 30s 宽限、再 60s 强制；活动重试由 Temporal 负责，预算操作具备重放语义。风险与「无限期停摆」相比可接受。
- **恢复延迟**：从权威恢复到重新 READY 最坏≈「强制关停上限 60s + 启动门重试周期 30s + 快照首刷 10s」。若要求更快，可把强制上限调小（常量集中、可测）。
- **依赖 compose 重启策略**：`restart: unless-stopped` 是恢复链的一环；换编排（如换调度器）时必须保留。RUNBOOK 记录。
- **doctor 需要 DB 访问**：经 `docker exec global-postgres psql -U global -d global_dev`（已实测可读）；postgres 容器不在时该节跳过并提示，不算失败。
- **日志轮转**：容器 json-file 无上限；drain 事件量极低，不构成压力。
- 开放：传输层对 gain-saas 401/403 的分级（D-e）；gain-saas 快照有效期是否值得加长（D-e 后续评估）。

## 9. 决策点（请产品负责人确认）

- **D-a 快照容忍**：刷新失败时保留最后良好快照直到签发方 `validUntil`（≤30s），并加 2s 快速重试。（推荐：是）
- **D-b 不放松排空语义**：权威不可证明 → 下一探针即排空（不加心跳容忍）；迁移不一致改为立即排空。（推荐：是）
- **D-c 自动恢复**：有界关停（grace 30s / force 60s）+ finally 15s 强制退出兜底 + 依赖 compose `restart: unless-stopped` + 启动门重准入；不做进程内重建 Worker。（推荐：是）
- **D-d 留痕与告警**：结构化 drain 事件 + `runtime_process_lease` 既有 STOPPED 行 + `gctl doctor` 新增「运行租约」检查（最新非 READY → 警告、不可登记为遗留；24h 内 STOPPED → 信息行）；本次不加 DB 列（无迁移）。（推荐：是）
- **D-e 后续项**：传输层把 gain-saas 的 401/403（鉴权拒绝/绑定过期）映射为独立危险码以即时排空；本次不做，列入后续。（推荐：是）
- **D-f 演练**：合并发车后在平台 schedule paused 的窗口做一次 90s 受控演练，作为运行证据。（推荐：是）

## 10. 联网研究结论（§0.6 ③；2026-11-06）

- **Kubernetes 探针语义**：`failureThreshold` 默认 3、「连续失败 `failureThreshold` 次才判定失败」；liveness 失败 → **重启容器**，readiness 失败 → 仅移出端点、容器继续跑（<https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/>）。→ **借**：失败阈值不是「容忍危险状态」，而是避免单次抖动误判；我们 3 连败用于基础设施探针、权威探针用签发有效期做容忍边界。**避**：只把失败当 readiness（永久移出端点）而不重启——正是 19:20 的形态；恢复必须走 liveness 式重启。
- **Azure 断路器模式**：Closed/Open/Half-Open；Open 期满后放少量探针，成功即闭合、失败即重新打开（<https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker>）。→ **集**：启动门即 Half-Open 探针（STARTING 不轮询、成功后才 READY）；进程重启是 Open→Half-Open 的载体。
- **AWS Builders' Library「静态稳定性」**：依赖受损时系统用**已有/最后已知良好状态**继续工作，不在故障中依赖控制面动作或新建资源（<https://aws.amazon.com/builders-library/static-stability-using-availability-zones/>）。→ **借**：快照容忍 = 在签发方授权的有效期内使用最后已知良好状态，而不是每次刷新失败就自断。
- **Temporal Worker 关停语义**：`shutdown()` 单向、`run()` 在 Worker 到达 `'STOPPED'` 后完成；Core 下「活动未完成则关停不完成」；`shutdownGraceTime`（默认 0）/`shutdownForceTime` 是有界关停的官方手段（<https://docs.temporal.io/encyclopedia/workers/worker-shutdown>、<https://typescript.temporal.io/api/interfaces/worker.WorkerOptions>）；`Worker` 单次使用，重准入需新 Worker/新进程（<https://typescript.temporal.io/api/classes/worker.Worker>）。→ **借**：关停必须设上限；自动恢复用「新进程 + 启动门」而非复活旧 Worker。
- **结论（借/集/建/避）**：借——k8s 的失败阈值与 liveness 重启语义、AWS 的最后已知良好状态、Temporal 的有界关停；集——Azure Half-Open 对应启动门；自建——快照容忍与 drain 事件/doctor 检查的组合（无现成组件覆盖）；避——用本地启发式容忍替代签发方签名窗口、以及只做 readiness 不做重启。

## 11. 给产品负责人的说明

- **得到什么**：gain-saas/权威的瞬时故障（≤30s）对 platform-worker 完全无感；更长故障或危险状态下仍立即停止轮询，但会**自动重启并在权威恢复后自动重新准入**，不再需要人工重启；每次排空都有结构化日志 + 租约痕迹 + `gctl doctor` 告警。
- **没改什么**：不改 `#683` 的「权威不可证明即排空」语义与回归测试；不改 `#794` 的 loop-lag 保护；不改能力快照签发契约；无数据库迁移；`/health/ready` 的 503 与客户写入语义不变；平台活动仍逐活动验 Grant/fence。
- **风险与回退**：强制关停上限可能打断在飞活动（有 30s 宽限，Temporal 重试兜底）；恢复依赖 compose `restart: unless-stopped`（现已具备）。回退 = 镜像回滚，无数据影响。
- **建议**：批准 D-a~D-f 后按 §7 TDD 施工、一个 PR 合入；合并后按 D-f 做一次受控演练并留档。
