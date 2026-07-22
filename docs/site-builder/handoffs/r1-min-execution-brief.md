# R1-min 执行交接：当前 Codex 任务仅完成 R1-min

> 状态：**历史执行交接（已 superseded）**。R1-min（#157）与 DI-0（#164）均已进入 `main`；当前施工序以 `status/current`、`release-plan`、00 与 09 为准。下文保留当时任务隔离、冲突停止门与 provenance，不再表示 DI-0 待安排或 R1-min 在途。
> 原始创建基线：2026-07-19 已核验的 `origin/main` `874213f206060126f1efd0675418f292f5b111a3`。
> 2026-07-19 边界修订基线：`origin/main` `06c924f5a1c396cdb34186c80955f81bba144f75`；R4-B-min（#153）与 M1-d（#154）已经合并。当前 Codex 任务只负责 R1-min，不在本任务实现 DI-0 或 template-distillation；这不表示 DI-0 被取消、转交或由测试分支替代。
> 本文只约束本次执行边界，不替代架构、ADR、当前状态或发布计划等权威真值。开工前必须重新 fetch 并记录实际 `origin/main`。

## 1. 目标与所有权

并行任务不得共用 worktree，也不得重叠写入：

| 施工线 | 负责人 | 当前目标 |
|---|---|---|
| 已合并前置 | `main` | R4-B-min 与 M1-d 已闭环；R1-min 只消费其稳定接口，不重新打开其实现 |
| R1-min | Codex | 仅审计、设计并在获批后实现 R1-min：不可变对象存储 Release、原子预览指针、跨节点恢复／回收和 unknown-component fail-closed |
| DI-0 主线 | 待独立安排 | 保留 DesignSource／Observation／Rule／DNA／Catalog／Family／DesignBrief／DesignEvaluation **合同**与授权边界；合同定义仍是 M1-e 受控组装前置门，但 `DesignEvaluation` 的运行时生产与评测实例属于 M1-f，不要求在 M1-e 前实现 |
| 模板蒸馏实验 | 现有 `template-distillation` 任务 | 独立测试分支；不属于主线，不承担 DI-0／M1-e 所有权，后续是否吸收另行研判 |

当前合流关系为：

```text
main：R4-B-min -> M1-d（均已合并）
R1-min：当前 Codex 任务 ----------+
DI-0：待独立安排 ----------------+------------> M1-e 前置门
实验：template-distillation（隔离测试；不自动汇入主线）
```

R1-min 必须在可见的 M1-e 组装前完成，DI-0 也必须在 M1-e 受控组装前形成获批合同。当前 Codex R1-min 任务不得依据本文实现或修改 template-distillation、DI-0、M1-d 或 M1-e；该任务排除不改变 DI-0 的路线图地位。

## 2. 权威资料入口

R1-min 任务提方案前必须完整阅读：

1. `AGENTS.md`
2. `CONTRIBUTING.md`
3. `docs/status/current.md`
4. `docs/roadmap/release-plan.md`
5. `docs/product-scope.md`
6. `docs/architecture/current.md`
7. `docs/adr/registry.md`，重点为 ADR-013、ADR-014、ADR-015、ADR-018、ADR-019
8. `docs/site-builder/00-decisions-and-coordination.md`
9. `docs/site-builder/02-architecture.md`
10. `docs/site-builder/03-agents.md`
11. `docs/site-builder/04-sitespec-contract.md`
12. `docs/site-builder/05-deployment-hosting.md`
13. `docs/site-builder/06-security-abuse.md`
14. `docs/site-builder/07-api-contract-draft.md`
15. `docs/site-builder/08-eval-testing.md`
16. `docs/site-builder/09-m1-implementation-design.md`
17. `docs/site-builder/10-model-selection-study.md`
18. `docs/site-builder/13-design-domain-model.md`
19. `docs/site-builder/14-media-foundation-mf0.md`
20. `docs/backend/worktree-management.md`

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
- 与第 5 节 template-distillation 独占文件的任何重叠；
- `codex/template-distillation` 相对 `origin/main` 的 committed 路径清单，以及该 worktree 的 tracked/untracked 清单；只记录路径，不读取或复制未提交内容。

本施工线不得移动、删除、prune 或 clean 任何旧 worktree 或分支。

## 4. 阶段 0：只读审计与设计

阶段 0 只授权检查和设计。不得修改业务代码、Prisma schema、迁移或当前状态／路线图中的能力声明。

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

R1-min 任务必须在实现前定义至少以下失败的预期行为：

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

## 5. 文件所有权与 template-distillation 隔离边界

### 5.1 template-distillation 独占面

R1-min 任务可以在自己的 worktree 中读取 `origin/main` 已合并版本，但不得读取现有 template-distillation worktree 的未提交内容，也不得编辑、stage、commit、rebase、merge、reset、stash、clean、停止进程或变更以下现场：

- `/global/backend/.codex/worktrees/template-distillation`；
- `codex/template-distillation`；
- 活跃任务“蒸馏模版+生成模块”；
- `apps/api/src/site-builder/template-distillation/**`；
- `apps/api/scripts/generate-template-distillation.mts`；
- `packages/contracts/src/site-builder/design-source.ts`；
- `apps/site-renderer/public/assets/mock-manufacturing-*`；
- template-distillation 分支相对 `origin/main` 已改动的任何 `apps/site-renderer/**`、`packages/contracts/**` 或其他路径。

R1-min 任务开工时必须用 Git 路径清单做 overlap audit。只要 R1-min changeset 与上述 committed 或未提交路径有交集，就立即停止，把精确路径列入 `共享文件申请` 并请用户决定串行顺序。禁止用 cherry-pick、复制 hunk、临时改名或“先改后解决冲突”规避所有权。

特别约束：template-distillation 当前正在修改 Renderer。R1-min 任务对 `apps/site-renderer/**` 默认只读；unknown-component fail-closed 优先在 R1-min 的发布前置校验／Release 组装层寻找无冲突 seam。若代码证据证明必须修改 Renderer，必须先申请，不得自行编辑 `Section.astro` 或其他组件。

### 5.2 R1-min 任务的提案和未来实现面

阶段 0 只能在以下位置创建任务专用的审计／设计文档：

- `docs/site-builder/handoffs/`。

阶段 0 不得创建或编辑 verifier、测试、运行时代码、schema、迁移、合同或基础设施文件。阶段 1 获批后，R1-min 任务才可以在获批 changeset 内新增：

- 文件名明确限定为 R1-min 的 verifier／测试；
- 新的 Release／storage／recovery 模块。

从最新 main 建立独立 worktree 后，R1-min 任务可能涉及的实现面包括：

- `apps/api/src/site-builder/renderer-build.ts`；
- `apps/api/src/site-builder/preview-promotion.ts`；
- 新 `release-*` 或 `artifact-*` service 模块及聚焦测试；
- 不触碰 Renderer 的 unknown-component 发布前置校验 seam；
- R1-min 专用 verifier 脚本；
- `docs/site-builder/05-deployment-hosting.md`，以及收口时严格限 hunk 的架构／状态更新。

该清单不是预先批准。阶段 0 必须先从代码证明精确文件集，阶段 1 才能开工。

## 6. 本 R1-min 任务排除的 template-distillation／DI-0 范围

以下内容不进入**当前 R1-min 任务**。这是并行隔离，不是取消或转交：DI-0 仍需作为独立主线研究、设计并在获批后实施；`template-distillation` 仅提供可能的实验输入，不能替代 DI-0 合同或验收。

当前 R1-min 任务不负责 DI-0、模板蒸馏、模板族、演示站或视觉高保真工作，包括但不限于：

- `DesignSourceManifest`、`DesignObservation`、`DesignRule`、`DesignDNA`；
- `TemplateFamily`、Blueprint、`DesignBrief`（DI-0／M1-e）；
- `DesignEvaluation` 合同定义（DI-0）及其运行时生产／评测实例（M1-f）；
- Readdy／第三方模板来源、训练许可、设计语法抽取；
- 任意 React／Astro／Tailwind 模板生成路径；
- fictional manufacturing demo、产品图、页面视觉或交互改造；
- M1-e component 扩展。

如果 R1-min 需要消费未来 DI-0 产物，只能定义最小、抽象、与具体模板无关的 Release 输入边界，并在 `共享文件申请` 中登记；不得进入现有 template-distillation 代码实现。

## 7. 已合并前置接口

R1-min 任务必须从最新 `origin/main` 核验 #153 与 #154 的最终接口，不得根据旧分支或聊天摘要猜测：

- BuildRun 持久 budget limit／reserved／settled／exhausted 真值；
- task-attempt 或 spend-attempt identity 与 fencing；
- `costSummary` schema／version；
- 付费调用 kill-switch 语义；
- BrandProfile retry／provenance 字段；
- 任何新增稳定错误码。

R1-min 可以读取最终 BuildRun／CopyBundle／PublishableClaimSnapshot 状态，但不得重置预算、重造成本真值、引入第二套 task-attempt ledger、修改事实发布语义或进入多语种文案实现。

### 7.1 R4-B-min 已合并稳定接口

以下接口已通过 #153 合并；R1-min 任务仍须以开工时最新 `origin/main` 的 schema 和代码为准核验：

- `SiteBuildBudget` 与 BuildRun 1:1，公开真值为 `cap/reserved/chargedMicrousd`、`paidCallsEnabled`、`disabledReason`、`exhaustedAt`；R1-min 不得重开已关闭的付费门。
- `SiteBuildTaskAttempt` 以 `(buildRunId,taskId)` 唯一，lease/fence 保护 logical task；`SiteBuildSpend` 以 `(buildRunId,operationKey)` 唯一，保护 physical model/tool operation。R1-min 任务不得新增平行 attempt/spend ledger。
- `BrandProfile.taskAttemptId` 唯一绑定成功 attempt；R1-min 不得修改 BrandProfile 的 replay/provenance 语义。
- `SiteBuildRun.costSummary` 的稳定版本是 `site-builder-cost-summary/v1`；它只在终态 reconcile 后由付费账本写入，reported/calculated/estimated/unknown 保持分层。R1-min 可以读取或随 Release 快照引用，但不得重算、覆盖或把 estimated/unknown 政名为真实成本。
- cancel request 会在 Temporal ACK 前先把 `paidCallsEnabled=false`、`disabledReason=cancellation_requested`；R1-min 的 artifact/release 清理不得依赖重新开放付费调用。
- R4-B-min 未新增 R1 Release/artifact schema，也未改变 MODEL-1 promoted route、transport 或 evidence id。

### 7.2 M1-d 已合并稳定接口

#154 已交付事实受限、多语种文案基础。R1-min 可以把已完成的 `SiteVersion`／CopyBundle／PublishableClaimSnapshot 作为 Release 输入，但不得重写：

- `packages/contracts/src/site-builder/copy-bundle.ts` 与 locale 合同；
- PublishableClaimSnapshot 的事实选择和失效语义；
- M1-d Temporal 生成／settlement 语义；
- inquiry consent 的保留边界。

如果 R1-min 必须修改这些接口，先报告精确原因和兼容方案，等待用户确认。

## 8. 停止门与阶段 1 实现授权

出现以下任一情况，R1-min 任务必须在阶段 0 结束后停止并请求复核：

- 方案需要 Prisma／schema 或迁移变更；
- 改变 `SiteBuildRun`／`SiteVersion` 状态或指针语义；
- 与 template-distillation committed 或未提交路径发生重叠；
- 需要修改 `apps/site-renderer/**`、template-distillation 或 DI-0 文件；
- 新增公开 endpoint 或 OpenAPI 变化；
- 改变对象删除／保留行为；
- 新增生产凭证、bucket policy 变更或基础设施状态；
- 进入 DI-0、template-distillation、M1-d、M1-e、M2、MF-1 或 MODEL-2 范围。

只有用户认可 R1-min 方案，并确认 overlap audit 无冲突或已给出串行顺序后，阶段 1 才能开始实现。R1-min 任务编辑前必须从最新 main 建立／更新自己的独立 worktree。

## 9. R1-min 任务的必需交接格式

R1-min 任务的报告必须采用以下结构：

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
- 与 template-distillation 或已合并前置接口重叠的精确文件与 hunk；没有则写“无”

并行隔离审计
- template-distillation committed/uncommitted 路径清单、R1-min overlap 结果、停止门

验证计划
- 单测、迁移、真实 PostgreSQL、MinIO/S3、崩溃/重试、合同、安全

待决策事项
- 会实质改变范围的问题；禁止静默假设
```

禁止包含凭证、原始 token 值、`.env` 内容或未脱敏的 presigned URL。

## 10. 阶段 1 最终验证门

阶段 1 获批并完成实现后，至少必须执行：

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

1. R1-min 任务只在 `/global/backend/.codex/worktrees/r1-min-release` 与 `codex/r1-min-release` 施工。
2. template-distillation 继续由其现有任务、worktree 和分支独占；R1-min 任务不向该任务发送修改指令，也不接管其进程或现场。
3. R1-min 任务先完成阶段 0、overlap audit 和规定格式的交接报告；用户认可后才进入阶段 1。
4. R1-min 任务编码前先提出共享文件需求；发生重叠时由用户决定先后顺序或由单一 integrator 提供 adapter seam。
5. R1-min 任务只从已核验的 `origin/main` 更新；禁止从 `codex/template-distillation`、旧 R4-B worktree 或其他陈旧分支整分支 cherry-pick。
6. template-distillation 合并或更新 main 时，R1-min 任务必须重新 fetch、rebase 并重跑 overlap audit 与完整验证门。
7. 每个逻辑变化保持独立 PR。R1-min 不得夹带 DI-0、template-distillation、M1-d、M1-e 或演示模板改动。

## 12. 交接文档生命周期

本文只在上述 R1-min 任务及其与 template-distillation 实验分支的隔离关系有效期间生效；它不分配 DI-0 的后续负责人。以下任一事件先发生时，收口负责人必须把本文标记为 `superseded`、链接替代 PR 或交接文档，并从 `00-decisions-and-coordination.md` 删除 active 链接：

- 已批准的 R1-min 方案改变了范围或负责人；
- R1-min 已合并进入 `main`；
- 用户终止或实质改变并行任务分工。

历史提交与 PR 证据可以保留本文。但本文中的分支名、基线 hash、负责人和文件认领不得复制到 `docs/status/current.md`、发布计划、ADR 或架构文档中作为长期产品真值。
