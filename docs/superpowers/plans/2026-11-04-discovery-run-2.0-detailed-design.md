# Run 2.0 详细设计：任务对象、公司级流水线、两档编排与进度闭环

> 生命周期：`DRAFT`（中间稿，已并入 `2026-11-04-acquisition-system-complete-design.md`；编排细节以完整设计为准）
> 依据：产品负责人 2026-11-04「run 的研究设计要全面，不要嫌麻烦，该重构就重构」。上位设计：总规划（`2026-11-04-acquisition-system-master-plan.md`）、两档设计（`2026-11-04-discovery-quick-deep-tiers.md`，已批）。本文是 Run 2.0 的实施级设计，含域模型、Temporal 编排、状态机、预算、失败语义、迁移与验收。

## 一、设计结论先行（本文件拍板的工程决策）

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| R1 | **任务对象前移**：gain-saas 引入 `AcquisitionTask`/`TaskRun`，引擎 run 携带 `taskRef` | run 语义本轮就要改（两档/流水线/多 run 历史），后补任务对象需要回填迁移，代价更大 |
| R2 | **公司级子工作流**：每家公司一个 `CompanyPipelineWorkflow`，父工作流限并发（默认 16，公司数上限 500/run） | 隔离失败与取消、逐家可观测；比 DB 租约批处理少一层状态机 |
| R3 | **run 与抓取解耦**：run 只消费公司池；搜索兜底仅在池不足时触发 | 快扫秒级出名单；抓取成本被多 run 摊薄 |
| R4 | **快扫粗判批量**：一次请求判 8 家（解析失败自动降级逐家） | 调用次数降一个量级；单家回退保证鲁棒 |
| R5 | **预算不分档**：一次 run 一个 Grant，快扫+深挖共用；渠道抓取计入工作空间配额（独立于 run 预算） | 保持现有授权模型；抓取是平台成本不是 run 成本 |
| R6 | **影子模式上线**：新版编排与旧路径并行跑、只对比不产出，连续两轮召回不低于旧版才切换 | 重构风险控制 |

## 二、域模型

```
Workspace ─ 1:N AcquisitionTask（挖掘需求：绑定 ICP + 名称 + 触发方式）
AcquisitionTask ─ 1:N TaskRun（每次执行尝试；trigger=manual|schedule）
TaskRun ─ 1:1 DiscoveryRun（引擎执行记录，保持不可变）
DiscoveryRun ─ 1:N DiscoveryCompanyJob（公司级流水线状态）
DiscoveryRun ─ 1:N RunEvent（append-only 进度事件）
CompanyPool(canonical_company) ─ 1:N CompanyChannelSighting（渠道 × 证据 × 时间）
CompanyPool ─ 1:N CompanyChannelEvidence（原始记录 lineage，已有 raw→canonical 链上补 channelId）
```

字段要点：

- `AcquisitionTask`：`(workspace_id, icp_id, name, status: active|paused|archived, created_by, last_run_at)`。
- `TaskRun`：`(task_id, engine_run_id, trigger, requested_by, status, budget_ref, started_at/finished_at)`；`status` 镜像引擎 run 状态，取消/暂停入口在 task 层。
- `DiscoveryRun`（引擎，增列）：`task_ref jsonb null`（`{taskId, taskRunId}`）、`phases jsonb`（`quickStartedAt/quickDoneAt/deepStartedAt/deepDoneAt`）、`mode: full|quick_only|refresh`。
- `DiscoveryCompanyJob`：
  `(workspace_id, run_id, canonical_company_id)` 唯一；`stage: prefiltered_out|quick_judged|profiling|fitting|signals|contacts|done|failed|skipped`；`verdict_quick/verdict_deep`；`attempts`、`last_error_code`、`lease_until`、`cost_cents`、`started_at/finished_at`。
- `RunEvent`（partition-by-run 逻辑）：`(run_id, seq, at, level, type, payload jsonb)`；type ∈ `phase_started/phase_completed/company_entered_stage/company_done/company_failed/budget_exhausted/lease_skipped/run_finished`；保留 90 天，run 完成后聚合为 summary 留存。
- 公司池：`canonical_company` 增 `last_seen_at`（最近被渠道/导入看到）、`last_checked_at`（最近画像）、`profile_hash`；`company_channel_sighting(company_id, channel_id, evidence_url, external_ref, seen_at)`；`company_channel_evidence` 指回 raw 记录（现有 lineage 加 channel 维度）。
- fit 缓存：`lead` 现有 `(workspace, icp, company)` 唯一键可复用；新增 `fit_input_hash`，输入（画像 hash+ICP revision）不变则复用判定。

## 三、编排（Temporal）

### 3.1 工作流树

```
TaskRunWorkflow（每个 TaskRun 一个）
 ├─ activity: prepareRun（建 run 行、校验 Grant、读取 task/plan/pool 摘要）
 ├─ 快扫阶段
 │   ├─ activity: prefilterPool（规则：来源/国家/行业/关键词命中 → job 行 prefiltered_out 或候选）
 │   ├─ activity: quickJudgeBatch（批 8 家 flash；写 verdict_quick + job 行）
 │   └─ activity: materializeProvisionalLeads（幂等 upsert；queue=needs_review, tier=quick）
 ├─ 深挖阶段（对 verdict_quick ∈ {match, weak}，可被用户「停止深挖」取消）
 │   ├─ 父循环：启动 CompanyPipelineWorkflow 子工作流（并发 ≤16）
 │   └─ 每个子工作流：
 │       profile（画像；缓存优先）→ fit（精判）→ signals（enrich+GLEIF/信号）→ contacts（联系人）
 │       每步：写 job.stage + RunEvent + cost；失败按阶段重试预算（上游 429 → 5/25 分钟退避，可配）
 └─ activity: finalizeRunV2（聚合 jobs → run stats/summary；写 phases；DONE/PARTIAL/FAILED/CANCELLED）
```

- **暂停**：仅在两阶段之间与每家公司阶段之间检查 `task.status=paused`；暂停后父工作流等待信号（`signal: resume/cancel`）。
- **取消**：父工作流 cancel 子工作流 → 每家写 `cancelled` job → finalize CANCELLED（沿用已验证的取消语义）。
- **可恢复**：所有活动幂等（job 租约 + 状态 CAS）；worker 重启后由 Temporal 重试在飞活动；父工作流 continue-as-new 于 job 数 >1000 时切分（防历史膨胀）。
- **replay 安全**：新编排挂在 `DISCOVERY_RUN2_PATCH` 下；旧历史 replay 走旧路径。发布用 worker Build ID（对齐 Phase 4 设计）钉版本。

### 3.2b 周期任务（sweeps）调度修复（2026-11-04 实查）

**发现**：平台迁移后（10-31 起），客户侧周期任务在真实集群上**全部停摆**——`ensurePlatformSchedules` 在代码中无调用方；即便调用，`temporal-customer-client` 机器身份在平台授权策略里只允许 StartWorkflow/Describe/History/RequestCancel，**没有 ScheduleService 权限**，无法创建/维护 schedule。此前看到的 10 个 schedule 全在旧 dev Temporal（7233）里，且没有 worker 消费——每分钟/每 5 分钟空转产出 456 条僵尸工作流（已于 2026-11-04 删除 schedule 并终止在跑项）。dev 集群的 UI（8233）只展示这个旧集群，真实客户工作流不在这里。

**影响**：raw-source 保留期清理（合规相关）、backlog/intent 补扫、site-release 维护、KB 恢复、费用对账等周期任务自迁移起未运行。

**修复方案（R7，推荐 A）**：
- **A（推荐，先做）**：API 内调度器（Nest 定时器）启动 sweep 工作流——现有机器身份允许 StartWorkflowExecution；用 `workflowId=xxx-<period>` + WorkflowIdReusePolicy 实现去重/防叠跑；启动时补跑最近一次过期 sweep（catchup）。
- **B（后续可选）**：扩展平台 Temporal 的机器策略（新增 ScheduleService 白名单）并重发 Temporal 镜像，恢复 Temporal 原生 schedule 语义（overlap/catchup）。成本高，不阻塞。
- 退役 dev Temporal 与 8233 暴露随 gctl core 组成调整一并处理（容器保留卷）。



- 快扫候选来源顺序：① 公司池（渠道/导入；按 freshness 与 intent 排序）→ ② 池不足阈值（默认 <20 家）时触发一次有界查询（现有 executeQuery 批 2，改造为按需触发、结果直接入池）；
- `mode=refresh`：只对已有公司做画像/信号刷新，不产生新名单（watches 调度使用）。

## 四、状态机与失败语义

- 单公司：`queued → prefiltered_out | quick_judged → profiling → fitting → signals → contacts → done`；任一步失败进入 `failed(error_code)`，重试由子工作流内活动策略决定（不阻塞其它公司）。
- run 汇总：全部 done → DONE；有 failed/skipped → PARTIAL（带 failure 分类计数）；预算耗尽 → PARTIAL(budget_exhausted) 并停止启动新公司；致命错误（Grant 撤销/租约过期）→ FAILED。
- 死信：连续失败达上限的 job 写 `failed_terminal`，RunEvent 标记，UI 可单家重试（新 job 或 job 重置，按 idempotency 设计）。

## 五、预算与成本

- 一次 run 一个 Grant（不变）；快扫粗判、深挖各阶段、联系人全部记 `usage_ledger`（现有）。
- `job.cost_cents` 逐家累积，run 汇总进 stats `cost`；预算剩余不足一个公司预算时停止启动新 job（PARTIAL）。
- 渠道抓取（2c）消耗记平台账（工作空间配额），不进 Grant；每渠道每日页数上限（默认 500）。

## 六、进度与可观测

- `RunEvent` 由父/子工作流写入（同一事务边界内尽量与状态更新合并，避免双写不一致）；
- API：`GET /discovery-runs/:id/events?after=<seq>`（增量拉取）+ run summary；前端 3 秒轮询；
- UI（2b-1 最小改造）：run 页 = 快扫结果区（公司/来源/粗判）+ 深挖队列（每家状态行、失败码、单家重试）+ 停止深挖按钮 + 总量（已进入/完成/失败）；
- 告警：run 超过 30 分钟未完成、失败率 >30%、预算耗尽、事件停滞 → 平台告警。

## 七、迁移与兼容

1. **expand-only 迁移**：新增表/列全部 nullable；不改旧列语义；`DiscoveryCompanyJob`、`RunEvent`、`TaskRef`、pool freshness 一版迁移。
2. **旧 run**：无 taskRef → 读取路径兼容（run 页按 stats 渲染旧视图）；不强制回填；首次从旧 ICP 页面触发时懒创建"默认任务"。
3. **Task 创建**：gain-saas 在「找买家」页创建/复用任务；TaskRun 创建时调用引擎 run 端点（现有 execute 端点加 `taskRef` 透传）。
4. **影子模式**：`DISCOVERY_RUN2_SHADOW=on` 时同一 run 双跑；对比报告落 `run_shadow_diff`（召回家数/判定一致率/耗时/成本），连续两轮达标后切默认。

## 八、TDD 与交付拆分（2b-1 内部分 PR）

| PR | 内容 | 验收 |
| --- | --- | --- |
| 1 | 域模型与迁移（jobs/events/task_ref/pool freshness/task 表）+ 引擎迁移规格 | 迁移 up/down 测试、旧数据兼容读、治理清单更新 |
| 2 | 任务对象（gain-saas Task/TaskRun + BFF + 引擎 taskRef 透传） | 创建任务→发起 run→历史列表；旧端点兼容 |
| 3 | 快扫阶段（prefilter + quickJudgeBatch + provisional leads + events） | 单测（规则命中/批量判定降级/幂等物化）+ 迷你 run |
| 4 | 深挖流水线（子工作流 + profile/fit/signals/contacts 逐家）+ 取消/暂停 | 编排单测（子工作流并发上限/取消传播/租约 CAS）+ 迷你 run |
| 5 | 进度 API + run 页最小改造 | 事件增量拉取、UI 逐家状态、停止深挖 |
| 6 | finalize V2 + 影子模式 + 告警 | 汇总一致性、影子报告、告警演练 |

## 九、验收（2b-1 总）

1. 搜索通道：首批名单 ≤8 分钟；完整链路 ≤15 分钟（25 家规模 mini-run + 一轮真实 run 各一次）；
2. 取消/暂停可用：取消后 60 秒内所有子工作流停止、run 记 CANCELLED；
3. 逐家进度：UI 每 3 秒可见增量；事件丢失可重放（按 seq 拉齐）；
4. 预算耗尽：run PARTIAL、停止启动新公司、已完成的公司结果保留；
5. 影子对比连续两轮召回不低于旧版（golden set）；
6. 旧历史 replay 全量单测通过；发布可用 Build ID 钉版本。
