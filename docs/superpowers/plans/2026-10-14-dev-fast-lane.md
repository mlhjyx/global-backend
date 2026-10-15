# 开发快速通道（dev fast lane）落地设计

> 生命周期：`APPROVED`
> 生命周期依据：用户 2026-10-14 委托 dev-fast-lane 工作流实施；代码与文档按 DEC-AIDEV-004 自审自合，镜像发布、在 xin 打开开关是另外的逐次授权事项。第 5 节三个取舍待 owner 在 PR 上确认。

事实基线：`origin/main@ee340795`。运维步骤见 [开发快速通道](../../backend/dev-fast-lane.md)。

## 0. 结论

在 development 里，让一个测试 workspace 的获客 workflow（卖方入驻理解、发现 run、资格判定）跑在从源码起的 customer worker 上，而管理态受证 API 继续承担全部 HTTP、readiness 与 outbox relay，管理态受证 worker 继续服务其余 workspace。开发者改 worker 侧代码后不用每次发布、切换镜像。pilot/production 结构性拒绝。

## 1. 机制

| 环节 | 做法 | 代码 |
| --- | --- | --- |
| 开关 | 一个变量既是开关又是唯一 workspace；另两个变量给开发用 Temporal 地址与期望 schema 摘要；唯一解析器在非 development 下只会抛错 | `apps/api/src/runtime/dev-fast-lane.ts` |
| API | 启动时解析（大声拒绝），不把开关传给 release identity，API 永远是受证镜像 | `main.ts`、`runtime.module.ts` 的 `DEV_FAST_LANE` |
| 路由 | relay 只对车道 workspace 的三条获客命令改用开发用 Temporal 客户端、车道队列与执行超时；车道命令单独成批轮询，卡住也饿不死其他 workspace | `outbox-relay.service.ts`、`temporal/dev-fast-lane-temporal.client.ts` |
| readiness | 可选 capability `dev_fast_lane`，恒为 `not_proven`，不参与整体状态与写入准入 | `runtime-readiness.service.ts`、`health-openapi.schemas.ts` |
| release identity | 只把「缺回执」改名为 `DEV_FAST_LANE_UNATTESTED`；有效回执照常 attested，无效回执照常 `BUILD_ATTESTATION_INVALID` | `runtime-release-identity.ts` |
| worker | 只在「开关开 + 缺回执 + 唯一失败的准入项是 build」时，于任何管理态副作用之前分叉进车道 worker；其余进程（含看到开关的受证进程）走原路径 | `temporal/worker.ts`、`temporal/dev-fast-lane-worker.ts` |
| 源码事实 | 迁移名与 schema 摘要用构建回执同一组函数从源码树求得；schema 摘要必须等于镜像的 | `build-attestation.ts`、`runtime/dev-fast-lane-source.ts` |
| 治理 | environment-parity 恰好一条 `trust` allowance；RuntimeEvidence 的 `dev-fast-lane-` 前缀只能是 development，且不得进入 release chain | `environment-parity-policy.json`、`scripts/governance-*` |

## 2. 相对裁决版设计的调整（来自复核）

1. **开发用 Temporal，而不是原生 Temporal**（复核 CRITICAL）：原生 Temporal 的机器授权器把 customer worker 与 customer client 的队列钉死为 `understanding`（`machine_policy.go` 的 `workerQueue`）。按原设计，relay 投车道队列会得到 PermissionDenied，行不 park、每 2 秒重试，积满一批 20 行后饿死所有租户的 outbox；车道 worker 也会在首次 poll 时被拒。改授权器要重发原生 Temporal 镜像。本实现改用 core 层的开发用 Temporal：relay 只在 development 下为车道命令另建一个明文 loopback 客户端（惰性连接，不影响 API 启动与 readiness），车道 worker 直连它、不取机器令牌。地址只接受 loopback。附带收益：可用开发用 Temporal 的 UI 观察车道 run、用它的 terminate 清理孤儿（customer client 在原生 Temporal 上只有 Start/Describe/GetHistory/RequestCancel 四个操作）。
2. **车道命令单独成批轮询**：即使开发用 Temporal 不可达、车道行持续失败，主批次的查询排除车道命令，车道行另取一批，其他 workspace 不受影响。开关关闭时主查询与原来逐字相同。
3. **车道启动带执行超时**（复核 HIGH）：发现 run 185 分钟（3 小时准入租约加收尾余量），理解与资格判定 30 分钟。没人 poll 的车道 workflow 会结束，不会永久吞掉同 workflowId 的后续请求。
4. **车道 worker 不拿 owner 权限**（复核 HIGH）：不建 owner 连接、不跑三个平台 seed（`seedJurisdictionPolicy` 的 upsert 会覆盖已有规则行）；只注册 understanding、discovery、qualify 三组活动（backlog、external-intent、建站、擦除活动都要 owner 连接或建站依赖，而它们的 workflow 从不进车道）。
5. **worker 改为「早分叉 + 独立模块」，而不是在 `worker.ts` 里就地加约 16 处分支**：复核要求的改动（去 owner、去 seed、去机器令牌、改明文连接、活动子集）让就地分支变成三十处左右，对管理态 worker 的回归风险更大。现在 `worker.ts` 只在准入之后、任何遥测、数据库、租约之前多一个分叉点，管理态路径逐字不变；车道 worker 在 `dev-fast-lane-worker.ts`，与 `worker.ts` 相同的构造（网关、broker、分类器、制裁、三组活动）由源码守卫 spec 逐个调用比较，防止漂移。`worker.ts` 现有的源码守卫 spec 全部原样通过。
6. **schema 摘要核对**（复核 claim 4）：迁移名相等只说明「源码树最新迁移 = 库里最新完成迁移」，不是 schema 等价（`schema.prisma` 多次不带迁移地变化）。车道 worker 另外要求源码 `schema.prisma` 的 sha256 等于运维从 `/health/build` 复制来的 `schema_digest`，不符则 `SCHEMA_DIGEST_MISMATCH` 不 poll。
7. **worktree 基线与首次落地**（复核 claim 4）：车道 worktree 从运行镜像的 `build_sha` 加车道提交创建，不从最新 main；首次落地的镜像若带迁移（主线已含 #647、#648 的迁移），走带迁移的换镜像流程。
8. **运维规程**（复核 HIGH/MEDIUM/LOW）：先起 worker 再开路由；开关前后都要求没有未发布的三类命令与 RUNNING discovery run；迭代前排空，改 workflow 代码用 `patched()`；孤儿 run 标 FAILED；换镜像前关车道；车道开着时不跑不带 workspaceId 的 sweep；覆盖范围与擦除边界写明。见运维页。
9. C2 的测试按复核修正：名字符合迁移格式的普通文件会让枚举报错（`must be a directory`），而不是被跳过。

## 3. 不变的

- `runtime-admission.ts` 一字未改；有效回执、无效回执、test 进程、source-watch 的身份语义不变。
- 租约 SQL、`understanding` 常量、readiness 的 worker 组件、客户写入准入、`/health/build` 都不变。
- 不改 `package.json`、锁文件、`schema.prisma`、`packages/contracts/src`、execution-authority 受保护文件；无迁移、无新服务、无新端口（开发用 Temporal 已在 core 层）。

## 4. 已知限制

- 车道只覆盖三个 workflow 的 workflow 体与活动体；workflow 输入、outbox payload、事件注册表与 API 内的同步获客操作仍是镜像代码。
- 两个车道 worker 同时 poll 同一车道队列不在代码层互斥，靠「一次只起一个、按 PID 管理」的规程。
- 车道观察永远不是 RuntimeEvidence PASS；R4 撤销投递链仍未打通，与本项无关。

## 5. 待 owner 确认

1. allowance 类别：`trust`（本实现；放松的是构建身份信任根）或 `deployment`。
2. 开关形态：环境变量持有 UUID（本实现，公开仓库零 UUID），或代码常量白名单（可用 PR 控制改租户，代价是测试租户 UUID 进公开仓库）。
3. 后续加固是否立项：两个车道 worker 之间的 advisory lock 互斥；workflow/活动层的租户拦截器。
