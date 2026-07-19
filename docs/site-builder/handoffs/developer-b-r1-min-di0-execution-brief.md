# Developer B 执行交接：先做 R1-min，并行研究 DI-0

> 状态：Site Builder 当前双人并行施工的有效交接文档。
> 创建基线：2026-07-19 已核验的 `origin/main` `874213f206060126f1efd0675418f292f5b111a3`。
> 本文只约束本次执行边界，不替代架构、ADR、当前状态或发布计划等权威真值。开工前必须重新 fetch 并记录实际 `origin/main`。

## 1. 目标与所有权

两名开发人员并行施工，但不得共用 worktree：

| 施工线 | 负责人 | 当前目标 |
|---|---|---|
| A | Developer A／当前 Codex 任务 | 收口 R4-B-min：BrandProfile 持久幂等、数据库 reserve/settle、真实模型与工具成本记账、`costSummary` 和付费调用 kill switch |
| B | Developer B | 立即审计并设计 R1-min；把 DI-0 消费合同作为次级研究线。只有本文开工门全部满足后才能进入实现 |

合流顺序保持为：

```text
A：R4-B-min -> M1-d -----------------+
B：R1-min + DI-0 研究/设计 ----------+-> M1-e -> M1-f -> M1-g -> M2
```

R4-B-min 必须先于 M1-d 合并。R1-min 和 DI-0 必须在可见的 M1-e 组装前准备好。B 不得依据本文提前实现 M1-d 或 M1-e。

## 2. 权威资料入口

B 提方案前必须完整阅读：

1. `AGENTS.md`
2. `CONTRIBUTING.md`
3. `docs/status/current.md`
4. `docs/roadmap/release-plan.md`
5. `docs/product-scope.md`
6. `docs/architecture/current.md`
7. `docs/adr/registry.md`，重点为 ADR-013、ADR-014、ADR-015、ADR-018、ADR-019
8. `docs/site-builder/00-decisions-and-coordination.md`
9. `docs/site-builder/02-architecture.md`
10. `docs/site-builder/05-deployment-hosting.md`
11. `docs/site-builder/08-eval-testing.md`
12. `docs/site-builder/09-m1-implementation-design.md`
13. `docs/site-builder/13-design-domain-model.md`
14. `docs/site-builder/14-media-foundation-mf0.md`
15. `docs/backend/worktree-management.md`

`docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.2.md` 只是带日期的提案／历史来源。可以用它定位问题，但不得覆盖以上权威文档或当前代码。

## 3. 开工协议与 worktree

不得复用或移动旧 `/global/wt/*` worktree，也不得在 `/global/backend` 本体施工。

从 main checkout 执行：

```bash
cd /global/backend
git status --short --branch
pnpm worktree:new r1-min-release --dry-run
pnpm worktree:new r1-min-release
cd /global/backend/.codex/worktrees/r1-min-release
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

该 helper 创建 `codex/r1-min-release` 分支。如果目标路径或分支已经存在，必须停止并审计；禁止覆盖、删除或静默复用。

采取任何任务动作前，记录：

- worktree 路径；
- 分支；
- `HEAD` 与 `origin/main`；
- tracked/untracked 状态；
- 所有涉及 Site Builder 的开放 PR；
- 与第 5 节 A 独占文件的任何重叠。

本施工线不得移动、删除、prune 或 clean 任何旧 worktree 或分支。

## 4. B0：立即并行的任务（只读审计与设计）

B0 只授权检查和设计。不得修改业务代码、Prisma schema、迁移或当前状态／路线图中的能力声明。

### 4.1 R1-min as-built 审计

完整追踪从请求到可见预览的当前实现，包括：

- `BuildsService` 的启动、幂等、取消和 active-run 规则；
- `refurbishWorkflow` 的 Activity 顺序与补偿；
- `assembleAndBuild`、`finalizeRefurbish` 与预览指针晋级；
- run-scoped 本地 staging、不可变本地产物路径和 `.active/<slug>` symlink 行为；
- `SiteVersion.artifactKey`、`activeVersionId` 与任何恢复／对账路径；
- Renderer 遇到未知 component 时的行为；
- 当前 `StorageService`／MinIO 接缝和部署假设。

针对剩余 R1-min 合同，产出有代码证据的差距表：

| R1-min 必需属性 | 当前代码证据 | 缺失不变量 | 建议负责人／文件 | 验证方式 |
|---|---|---|---|---|
| 生产对象存储中的不可变 Release | | | | |
| 原子指针切换与回滚 | | | | |
| 跨节点崩溃恢复／对账 | | | | |
| 安全的 Release 保留与垃圾回收 | | | | |
| Version／Build fencing | | | | |
| 未知 component fail-closed | | | | |
| 取消与补偿保留旧 Release | | | | |
| 对象 digest／manifest 完整性 | | | | |

审计必须区分：

- 本地开发产物行为与生产对象存储；
- 数据库指针与完整的不可变 Release manifest；
- 可恢复性与单纯的目录持久存在；
- 预览就绪与公开发布；
- 当前 as-built 代码与目标设计。

### 4.2 失败矩阵

B 必须在实现前定义至少以下失败的预期行为：

1. 对象上传成功，但数据库事务失败；
2. 数据库 candidate 行已提交，但指针晋级失败；
3. 指针晋级成功，但 Activity acknowledgement 丢失；
4. worker 在上传中途退出；
5. 另一节点重试同一个 BuildRun；
6. 取消请求分别在发布提交点之前和之后到达；
7. 部分构建仍在渲染时 active Site 发生变化；
8. manifest 引用了缺失对象或 digest 不匹配对象；
9. 垃圾回收与重试或回滚并发；
10. Renderer 收到未知 component 或不支持的合同版本。

每一行必须写明：持久真值源、锁／fencing 原语、重试负责人、补偿动作和用户可见状态。

### 4.3 最小 R1-min 方案

方案必须回答以下问题，但此阶段不得实现：

- 是否需要新增 `SiteRelease`／manifest 模型，以及现有 `SiteVersion` 为什么足够或不足；
- 精确的对象 key 布局与 digest 边界；
- 哪个指针是预览的权威真值；
- 重试如何识别并复用已完成产物；
- 跨节点恢复如何发现遗留 candidate；
- retention／GC 的资格条件，以及什么锁能避免删除仍可回滚的活对象；
- 未知 component 如何在指针晋级前失败；
- 历史行的 forward-only 迁移／回填行为；
- 生产 MinIO／S3 验证与回滚流程。

不得提前构建 M2 域名绑定、公开发布、询盘接入、MediaJob、AssetUsage、生成式媒体或 M1-e component 扩展。

## 5. A 活跃期间的文件所有权与冲突边界

### 5.1 R4-B-min 合并前由 A 独占的文件

B 可以读取但不得编辑：

- `packages/db/prisma/schema.prisma`；
- `packages/db/prisma/migrations/**`；
- `apps/api/src/tools/budget.ts` 及其测试；
- `apps/api/src/tools/tool-broker.ts` 及记账集成；
- `apps/api/src/model-gateway/router-model-gateway.ts`；
- `apps/api/src/model-gateway/types.ts`；
- `apps/api/src/model-gateway/ai-trace.sink.ts`；
- `apps/api/src/site-builder/agents/ai-task.ts`；
- `apps/api/src/site-builder/agents/brand-profile.ts`；
- `apps/api/src/temporal/site-builder.activities.ts`；
- `apps/api/src/temporal/refurbish.workflow.ts`；
- `apps/api/src/temporal/worker.ts`；
- `docs/status/current.md`、`docs/roadmap/release-plan.md`、`AGENTS.md`。

如果 B 的设计需要修改其中任一文件，必须在 `共享文件申请` 中列出精确 hunk 和原因，不得直接编辑。

### 5.2 B 所有的提案和未来实现面

B0 只能在以下位置创建任务专用的审计／设计文档：

- `docs/site-builder/handoffs/`。

B0 不得创建或编辑 verifier、测试、运行时代码、schema、迁移、合同或基础设施文件。B1 获批后，B 才可以在获批 changeset 内新增：

- 文件名明确限定为 R1-min 的 verifier／测试；
- 新的 Release／storage／recovery 模块。

R4-B-min 合并且 B rebase 后，B 可能涉及的实现面包括：

- `apps/api/src/site-builder/renderer-build.ts`；
- `apps/api/src/site-builder/preview-promotion.ts`；
- 新 `release-*` 或 `artifact-*` service 模块及聚焦测试；
- `apps/site-renderer/src/components/Section.astro` 的未知 component fail-closed 行为；
- R1-min 专用 verifier 脚本；
- `docs/site-builder/05-deployment-hosting.md`，以及收口时严格限 hunk 的架构／状态更新。

该清单不是预先批准。B0 必须先从代码证明精确文件集，B1 才能开工。

## 6. DI-0 次级研究线

完成 R1-min 审计后，B 可以把剩余并行时间用于 DI-0 研究，但不得实现。交付物是以下内容的 consumer-first 合同提案：

- `DesignSourceManifest`；
- `DesignObservation`；
- `DesignRule`；
- `DesignDNA`；
- `TemplateFamily` 与 Blueprint；
- `DesignBrief`；
- `DesignEvaluation`；
- source class、license、retention、training permission、owner authorization 与 revocation。

硬边界：

- 运行时不得读取或克隆原始 Readdy 输出；
- 不得新增任意 React／Astro／Tailwind 生成路径；
- 不得实现 M1-e component；
- A 独占 schema 期间不得新增数据库迁移；
- 不得把目标合同描述成 as-built；
- 默认不得使用租户内容训练模型。

DI-0 研究必须找出 M1-e-B 真正会消费的最小合同。没有具名消费者时，不得臆造表结构。

## 7. A 必须提供给 B 的接口

B 不得猜测最终 R4-B schema。A 的 PR 合并后，B 必须 fetch 并 rebase，然后检查已合并接口中的：

- BuildRun 持久 budget limit／reserved／settled／exhausted 真值；
- task-attempt 或 spend-attempt identity 与 fencing；
- `costSummary` schema／version；
- 付费调用 kill-switch 语义；
- BrandProfile retry／provenance 字段；
- 任何新增稳定错误码。

R1-min 可以读取最终 BuildRun 状态，但不得重置预算、重造成本真值或引入第二套 task-attempt ledger。DI-0 不得把设计合同绑定到某个 promoted model。

### 7.1 A 当前交付分支冻结的稳定接口（合并前预告）

以下接口已在 `codex/r4-b-min` 形成并通过真 PostgreSQL verifier；B 仍须等该 PR 实际合并、fetch/rebase 后以 `origin/main` 为准核验，不能把本段当作提前开工授权：

- `SiteBuildBudget` 与 BuildRun 1:1，公开真值为 `cap/reserved/chargedMicrousd`、`paidCallsEnabled`、`disabledReason`、`exhaustedAt`；R1-min 不得重开已关闭的付费门。
- `SiteBuildTaskAttempt` 以 `(buildRunId,taskId)` 唯一，lease/fence 保护 logical task；`SiteBuildSpend` 以 `(buildRunId,operationKey)` 唯一，保护 physical model/tool operation。B 不得新增平行 attempt/spend ledger。
- `BrandProfile.taskAttemptId` 唯一绑定成功 attempt；R1-min 不得修改 BrandProfile 的 replay/provenance 语义。
- `SiteBuildRun.costSummary` 的稳定版本是 `site-builder-cost-summary/v1`；它只在终态 reconcile 后由付费账本写入，reported/calculated/estimated/unknown 保持分层。R1-min 可以读取或随 Release 快照引用，但不得重算、覆盖或把 estimated/unknown 政名为真实成本。
- cancel request 会在 Temporal ACK 前先把 `paidCallsEnabled=false`、`disabledReason=cancellation_requested`；R1-min 的 artifact/release 清理不得依赖重新开放付费调用。
- R4-B-min 未新增 R1 Release/artifact schema，也未改变 MODEL-1 promoted route、transport 或 evidence id；DI-0 继续只消费任务能力合同，不绑定具体模型。

## 8. 停止门与 B1 实现授权

出现以下任一情况，B 必须在 B0 结束后停止并请求复核：

- 方案需要 Prisma／schema 或迁移变更；
- 改变 `SiteBuildRun`／`SiteVersion` 状态或指针语义；
- 需要修改 A 独占文件；
- 新增公开 endpoint 或 OpenAPI 变化；
- 改变对象删除／保留行为；
- 新增生产凭证、bucket policy 变更或基础设施状态；
- 进入 M1-d、M1-e、M2、MF-1 或 MODEL-2 范围。

只有用户认可 R1-min 方案，且已核验 A 的 R4-B-min 合并进入 `origin/main` 后，B1 才能开始实现。B 编辑前必须从该 main rebase。

## 9. B 的必需交接格式

B 的报告必须采用以下结构：

```text
基线
- worktree / branch / HEAD / origin/main / status

当前实现
- 精确代码路径与持久真值源

R1-MIN 差距表
- 必需属性 / 证据 / 缺失不变量 / 方案 / 验证

失败矩阵
- 失败 / 锁或 fence / 重试负责人 / 补偿 / 可见结果

建议 CHANGESET
- 模型与迁移、服务、API、Renderer、测试、文档

共享文件申请
- 所需 A 独占文件与精确 hunk；没有则写“无”

DI-0 研究
- 消费合同、来源/权利边界、延期项

验证计划
- 单测、迁移、真实 PostgreSQL、MinIO/S3、崩溃/重试、合同、安全

待决策事项
- 会实质改变范围的问题；禁止静默假设
```

禁止包含凭证、原始 token 值、`.env` 内容或未脱敏的 presigned URL。

## 10. B1 最终验证门

B1 获批并完成实现后，至少必须执行：

```bash
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/api build
pnpm --filter @global/api test
pnpm --filter @global/api lint
```

还必须完成：

- 从已有数据库和空数据库分别验证 forward migration 完整性；
- 真实 PostgreSQL owner／app_user RLS 与并发验证；
- 真实 MinIO／S3-compatible 对象写入、digest、重试、回滚与清理验证；
- 围绕指针提交点的 crash／ACK 丢失／取消测试；
- Renderer 未知 component 负例；
- 公开面发生变化时的 OpenAPI／contracts 漂移检查；
- gitleaks；
- CI、安全检查、Codex 审查以及全部审查线程解决。

任何开发环境结果都不得描述成生产部署。

## 11. 协同协议

1. R4-B-min 合并核验前，A 独占所有共享 schema／集成热点。
2. B 不修改业务代码，完成 B0 并提交规定格式的交接报告。
3. A 必须报告任何会改变 B 假设的已合并接口。
4. B 编码前先提出共享文件需求；A 提供 adapter seam 或安排串行 integration commit。
5. R4-B-min 合并后，B 从已核验的 `origin/main` rebase；禁止从陈旧 worktree 整分支 cherry-pick。
6. A 进入 M1-d；B 并行实现已经批准的 R1-min 范围。
7. 首个触碰热点的 PR 先合并，另一施工线 rebase 并重跑完整验证门。
8. 每个逻辑变化保持独立 PR。R4-B-min、R1-min、DI-0、M1-d 与 M1-e 不得合成 mega PR。

## 12. 交接文档生命周期

本文只在上述 A／B 分工有效期间生效。以下任一事件先发生时，收口负责人必须把本文标记为 `superseded`、链接替代 PR 或交接文档，并从 `00-decisions-and-coordination.md` 删除 active 链接：

- 已批准的 R1-min 方案改变了范围或负责人；
- R1-min 已合并进入 `main`；
- 用户终止或实质改变双人分工。

历史提交与 PR 证据可以保留本文。但本文中的分支名、基线 hash、负责人和文件认领不得复制到 `docs/status/current.md`、发布计划、ADR 或架构文档中作为长期产品真值。
