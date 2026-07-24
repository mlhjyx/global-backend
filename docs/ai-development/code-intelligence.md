# 代码智能使用与边界

> 文档 ID：`GUIDE-AIDEV-004`
> 层级：`L5 / Guide`
> 生命周期：`GUIDE`
> 维护 Owner：`OWN-DOC-GOV（当前 UNASSIGNED）`
> 产品批准：[`DEC-AIDEV-003`](../governance/conflict-register.md#11-aidev-gate-1-已批准决策)
> 最后核验：2026-07-25，`origin/main@af5bf03a995689d5ad6224a32920b23395819898` + `codex/runtime-evidence` 实施候选

## 1. 结论

ContractGraph 是当前 worktree 的可丢弃项目契约地图；CodeGraph 是补充普通语言调用关系的可选二级试点。两者都不是项目真值。它们先回答“这个改动可能影响哪些 Capability、场景、API、事件、工作流、数据、测试和部署入口”，再由 Codex 回到当前源码、机器合同、测试与运行证据核实。

```mermaid
flowchart LR
    A["业务 Registry<br/>CAP / SCN / PAGE / OBJ / OWN / DEC"] --> G["ContractGraph"]
    B["NestJS / TypeScript / Astro"] --> G
    C["Temporal / Outbox / AI route"] --> G
    D["Prisma / migration / RLS"] --> G
    E["pnpm / CI / Compose / systemd"] --> G
    G --> H["影响候选与 UNKNOWN"]
    K["CodeGraph<br/>普通静态调用"] --> H
    H --> I["源码、测试复核"]
    R["RuntimeEvidence<br/>开发环境元数据"] --> I
    I --> J["非技术合并决策卡"]
```

`OWN-*` 是责任帽，不是实际人员。仓库没有记录真实负责人的节点必须显示 `assignee=UNASSIGNED`；图谱不得把角色存在解释成已有人批准。

## 2. 当前覆盖

| 提取面 | 当前输出 | 不能证明 |
|---|---|---|
| 治理 Registry | Capability、Scenario、Page、Object、Decision、Owner 与引用 | 产品状态自动升级或真实人员批准 |
| TypeScript / NestJS | 文件、符号、import、Controller route、Module、constructor DI | 运行时条件分支和容器实际解析结果 |
| Temporal | `workflows.ts` 真实导出、proxy Activity、client start、worker factory、Schedule | workflow history 已执行或 Activity 成功 |
| Outbox | `eventType` 发布、`INTERNAL_COMMANDS`/`INTEGRATION_EVENTS` Set 注册、`.has(eventType)` 消费与明确 switch 分支 | 外部 SaaS 已拉取、ACK 或正确处理 |
| Prisma | model/table、relation、migration、由 migration SQL 证明的 RLS、常见 client 读写 | SQL 运行计划、触发器效果和真实数据状态 |
| AI / 外部边界 | task ID、model-policy/Broker/Provider 静态分支与动态机制、非测试源码中的 URL 候选 | 实际模型路由、kill switch、Secret、配额、许可或外部可用性 |
| workspace / deployment | package 依赖、tsconfig alias、Astro render、CI job、Compose/systemd | 目标环境已部署或健康 |

生成代码只记录生成源或依赖，不重复索引 `dist`、`node_modules` 和已声明 generated 目录。`.env`、凭据、构建产物、测试截图和临时目录排除在 source hash 与派生图之外。

## 3. 命令

在要回答问题的 worktree 内运行：

```bash
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts query CAP-SITE-BUILD-001 --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact apps/api/src/site-builder/builds.controller.ts --repo ../..
```

`scan` 原子写入：

```text
.code-intelligence/
├── graph-v1.json
├── coverage-v1.json
├── diagnostics-v1.json
└── manifest-v1.json
```

这些文件被 Git 忽略，不承担备份职责。`query` 和 `status` 会重新计算当前 worktree、commit 与 source hash；不匹配即返回 `WRONG_WORKTREE` 或 `STALE_GRAPH`，拒绝用 main 图回答功能分支问题。
`manifest-v1.json` 绑定派生文件哈希；手工篡改 JSON 或 schema/content 形状不完整时查询同样拒绝。`impact` 只做高精度、两跳的 ContractGraph 基线，输出仍标 `INFERRED/UNKNOWN`。

### 3.1 CodeGraph 受控试点

只在本机、当前活跃 worktree 内执行：

```bash
pnpm code-intelligence:codegraph:index-main
pnpm code-intelligence:codegraph:index-active
pnpm code-intelligence:codegraph:status-main
pnpm code-intelligence:codegraph:status-active
pnpm --filter @global/code-intelligence exec tsx src/cli.ts unified-impact apps/api/src/tools/tool-broker.ts --repo ../..
pnpm code-intelligence:codegraph:evaluate
```

- 依赖精确固定 [`@colbymchenry/codegraph@1.5.0`](https://github.com/colbymchenry/codegraph/releases/tag/v1.5.0)，不使用 `latest`。
- CLI 在加载依赖前设置 `CODEGRAPH_TELEMETRY=0` 与 `DO_NOT_TRACK=1`。
- 禁止运行 `codegraph install`、`upgrade`、watcher、MCP 或任何会写 `AGENTS.md`、Hooks、编辑器配置的自动安装。
- main 索引来自 `origin/main` 的 Git archive 干净快照，不读取 `/global/backend` 的用户未跟踪资料；另只保留当前活跃 worktree 一个索引。
- active 索引不直接读取可变施工目录：先只复制 Git 已跟踪/已暂存文件到 `.code-intelligence/codegraph-active/source` 不可变快照，再在快照中建 SQLite；索引后重新核对未跟踪集合和逐文件哈希，施工目录若在窗口内变化就删除快照和 evidence 并拒绝完成。新源码须先进入 Git 暂存区，recovery 文件、临时提示词、客户资料或凭据不会进入快照。
- 新 main 快照和证据完整写入后，只清理 `.code-intelligence/codegraph-main/` 下通过 40 位提交哈希校验的旧派生快照；不触碰 Git worktree 或用户文件。
- 查询必须同时通过版本、branch、commit、source hash、project path、index state、pending references、pending changes 与 extraction freshness 校验，否则拒答。
- `unified-impact` 合并 Git diff、ContractGraph 与 CodeGraph；ContractGraph 的 Activity、Workflow、Prisma model 等非文件节点先由 location 还原为源码路径，冲突进入人工复核队列，不自动选择一方。

索引和证据仍只写被忽略的派生目录：

```text
.codegraph/                     # 当前活跃 worktree 的本地 SQLite
.code-intelligence/
├── codegraph-active-v1.json
├── codegraph-main/<commit>/    # origin/main 干净快照、索引和 evidence
└── codegraph-evaluation-v1.json
```

CI 使用：

```bash
pnpm code-intelligence:test
pnpm code-intelligence:check
```

`check` 在内存中完整构建两次，要求字节等价，并拒绝 error 级诊断。仓库完整性测试还锁定 `routeEvent` 对两个 Outbox Registry 的消费边，并逐项核对 Registry 全部字面量的注册边；删除 `.has(eventType)` 或漏登记事件会使 CI 失败。它只增加验证，不能据此跳过 API、契约、Renderer 或现有完整 CI。

### 3.2 开发环境运行证据

PR4 增加仓库 CLI，不增加常驻 MCP、生产追踪或公共 API：

```bash
pnpm code-intelligence:scan
pnpm code-intelligence:runtime:capture
pnpm code-intelligence:runtime:status
pnpm code-intelligence:runtime:diff
```

`runtime:capture` 当前只接受 `development`，并要求 ContractGraph 与当前 worktree、commit、source hash 完全一致且工作区干净。它从 Ubuntu 开发环境采集：

- `/api/v1/health` 与 `/api/v1/health/db` 的状态、耗时和允许字段；
- `global-api.service`、`global-worker.service`、`temporal-dev.service` 的 systemd 状态；
- `global` Compose 的服务名、状态、健康、镜像和创建配置来源；
- Temporal cluster health、Schedule、最近 workflow/run ID 与状态；
- 最新 Prisma migration ID、Outbox event ID/type/delivery state、SiteBuildRun ID/status/Temporal identity。

派生结果仍只写 Git 忽略目录：

```text
.code-intelligence/
├── runtime-evidence-v1.json
├── runtime-evidence-manifest-v1.json
└── runtime-difference-v1.json
```

每条 `RuntimeEvidenceV1` 都有内容哈希；bundle manifest 再绑定整份文件。禁止元数据键包含 payload、body、prompt、Secret、token、credential、email 或 personal data，Outbox payload、业务正文和模型输入永不读取。API 只有在响应精确回显本次 `X-Request-Id` 时才记录 correlation ID；当前健康接口未回显，因此必须报告为未知，不能把客户端自造 ID 冒充服务端关联证据。

运行中的 systemd/Compose/Temporal 当前没有暴露可验证的部署 commit。CLI 把记录的 `commit` 保持为 `UNKNOWN`，另用 bundle 的 `collector` 绑定“由哪个 worktree/commit 采集”；不得用采集器 HEAD 冒充运行二进制版本。`runtime:diff` 只把真实 Schedule→Workflow 最近动作认作运行边；Outbox 行只证明该 event type 发生，不证明任意消费者已执行。报告含：

- `observed*`：当前图中已有且成功观察到的节点/边；
- `staticOnly*`：静态标记需要运行证据、但本次未观察到；
- `runtimeOnly*`：运行证据指向当前图不存在的目标，属于矛盾；
- `PARTIAL`：存在未知 commit、未观察关系或 correlation 缺口；
- `CONTRADICTED`：健康/迁移失败或运行目标不在当前图，命令失败退出。

Compose 容器创建时记录的配置根若不是 canonical `/global/backend`，报告 `RUNTIME_CONFIGURATION_PROVENANCE_DRIFT`；服务只有 `running` 而没有声明 healthcheck 时保持 `UNKNOWN`，不会伪装成健康成功。

absence of evidence 不是 evidence of absence：`staticOnly` 只能增加验证建议，不能声称能力未接通。生产或预发布采集仍需另行批准部署、隐私、成本、保留和回退方案。

## 4. 动态机制登记

动态行为登记在 `packages/code-intelligence/dynamic-mechanisms.json`。每项必须是：

- `EXTRACTOR`：已有确定性提取器；
- `DETERMINISTIC_TEST`：无法静态展开，但有完整性测试；
- `TEMPORARY_EXCEPTION`：记录责任帽、真实 assignee 和到期日。

新增动态字符串分派、注册表、插件发现或运行时路由时，在实现附近加入：

```text
@dynamic-mechanism <registry-id>
```

未登记 ID 产生 `UNCLAIMED_DYNAMIC_MECHANISM` 并阻断 CI。除此之外，生产源码中的 Temporal/Outbox/函数注册表/计算分派/dynamic import/反射等通用动态表面必须被 Registry pattern 或附近已登记 marker 覆盖；只声明不存在的 extractor、`EXTRACTOR` 零匹配和临时例外到期也会阻断。测试与 `verify-*` 夹具不被误报成生产动态机制或真实外部路由。责任帽存在但未记录真实人员只产生可见的 `UNASSIGNED` 信息，不伪造批准。

## 5. 正确使用顺序

1. 确认查询的是当前 worktree，并运行 `status`。
2. 对改动文件先运行 `impact`；它从 canonical Traceability Matrix 的显式边返回 Capability、Scenario、Page、实现锚和测试候选，再用稳定 ID 查询第一张地图。
3. 打开返回的精确文件和行，核对当前分支源码。
4. 对动态边使用完整性测试；对真实发生使用 API correlation ID、Temporal workflow ID、Outbox event ID、migration 与健康证据。
5. 仍无法证明的外部仓库、消费者和运行状态写成 `UNKNOWN/EXTERNAL_OWNED`。
6. 影响分析只能增加建议测试，不能减少现有测试。

发生冲突时，优先级是：业务/产品 Registry 与 ADR → 当前分支机器合同和源码 → 当前环境运行证据 → ContractGraph 派生认知。派生图永远不能覆盖前三层。

## 6. 30 题评测与当前采用决定

2026-07-25 实施候选执行固定 30 题，包含 TypeScript、NestJS、Temporal/Outbox、Prisma/RLS、业务追踪、Astro、部署、已知零调用者、假接通和错误分支控制：

| 门 | 结果 | 要求 | 判定 |
|---|---:|---:|---|
| 职责路由后的统一 precision | 100%（45/45 返回路径） | ≥90% | 通过 |
| 预期事实召回 | 100%（53/53 路径、节点、边） | ≥90% | 通过 |
| 关键动态精确边召回 | 100%（核对 `from/to/kind/confidence`） | 100% | 通过 |
| CodeGraph 原始 precision / recall | 42.2% / 65.5% | 观察项 | 不能单独使用 |
| CodeGraph 参与表面的 precision | 100% | ≥90% | 通过 |
| CodeGraph 参与表面的 recall | 89.5%（17/19） | ≥90% | **未通过** |
| worktree/commit 识别 | 100% | 100% | 通过 |
| 敏感路径泄漏 | 0 | 0 | 通过 |
| 完整构建 | 重复运行约 5.0–9.0 秒 | ≤5 分钟 | 通过 |
| 增量更新 | 重复运行约 108–115 毫秒 | ≤30 秒 | 通过 |
| 最慢常见查询 | 重复运行约 19–21 毫秒 | ≤10 秒 | 通过 |
| 相比 `rg + 文件读取` 的中位提速 | 重复运行约 42%–45% | ≥30% | 通过 |

评测不再把“题目命中率”冒充准确率：每个额外返回路径都计为误报；关键动态题必须命中精确边，只有文件名相同不能过门。Outbox 题同时断言 Set 注册边和 `.has(eventType)` 消费边；外部消费控制绑定 Registry 中精确的 `OWN-SAAS-FE → OBJ-BLK-001` 开放 blocker、`CAP-SITE-RELEASE-001=APPROVED_NOT_BUILT` 与内部 `SiteRelease` 节点，并拒绝本仓前端出现 `PROVEN_RUNTIME` 消费边的矛盾状态。增量耗时只在旧符号消失、新符号与源码可查询、索引 complete、引用和变更队列归零后才计为有效。Prisma、业务追踪、Compose/systemd 与 Astro 非语言依赖按已声明职责只采用 ContractGraph，但仍单独公开 CodeGraph 的原始 precision/recall，不能用路由隐藏其缺陷。

因此采用结果仍固定为 `PILOT_ONLY`：统一路由结果与速度门通过，但 CodeGraph 在自己获准参与的表面仍漏 2/19，89.5% 未达到 90% 独立采用门。ContractGraph + `rg` + 当前源码继续是默认路径；CodeGraph 只在复杂静态调用问题中按需启用，不能据此减少 CI。评测保留真实失败门，不因已经安装而强行采用。

ContractGraph 不需要常驻服务、数据库或网络；删除 `.codegraph/` 与 `.code-intelligence/` 即可完整退出并回到 `rg + 文件阅读`。开发环境 RuntimeEvidence 同样是可重建派生物；本阶段不启用生产追踪。
