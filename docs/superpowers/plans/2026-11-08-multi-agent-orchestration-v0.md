# M2 步 9b · 多 agent 编排 v0 落地设计文档（2026-11-08）

> 生命周期：`DRAFT`
> 生命周期依据：按 §0.6 任务启动门产出（设计 / 闭环 / 联网研究），待产品负责人过目批准后转 `APPROVED`；依据协调计划 §0.2 步 9b 与 §0.7 D-MA-2（agent 语义）/D-MA-4（决策轨迹），前置依赖「步 7 完成（S0 已发车并 E2E 验收）＋步 2 开工（逐源启用已开工：lineage v3 #846 已合）」，两者均已满足。
> 主会话亲自起草（2026-11-08）；批准后按 §13 的 stacked PR 施工。

## 1. 背景与目标

### 1.1 已批决策（D-MA-2 / D-MA-4，2026-11-08）

- **agent = 注册实体**：角色提示词 + 技能子集（Skill Runtime）+ 模型策略 + 记忆作用域 + loop 策略；每个「回合」= 一条 durable 执行记录（输入快照/动作/成本/结果），可重放、可预算。
- 首批角色 agent：**源侦察员**（并行寻源）+ **资格判定员**；协作协议 = 监督者 + 类型化移交 + 共享黑板（产品数据模型本身），**禁自由群聊式多 agent**。
- **不引第二编排器**：agent 只以 Temporal activity / 官方集成形式运行（D-MA-1）。
- **决策轨迹 v0**：先用 ai_trace/usage_ledger 轻量记录，前端「过程」页直接消费；不引 Langfuse/ClickHouse（D-MA-4）。

### 1.2 现状（已核对 main `bf0a7f8d`，2026-11-08）

- 引擎有 24+ Temporal workflow、outbox 事件脊梁、execution budget 围栏、ai_trace/usage_ledger 全域记账、S0 技能注册与 resolver（四表，FORCE RLS，平台启停 + workspace 覆盖 + 契约漂移 fail-closed）。
- discovery 编排是「代码写死的固定管线」：query 阶段天然多源 fan-out（`executeQuery` 内按 source_class 并行召回），quickScan 阶段批量 LLM 判定（`discovery.qualify_fit` skill 已包化）——**能力已存在，缺的是角色化、可注册、可观测的「agent 语义」**。
- 没有 agent 注册表、没有决策轨迹表（只有 run_event 阶段事件与 ai_trace 调用记录），前端无「过程」页数据源。

### 1.3 目标（步 9b 验收口径）

1. 两个角色 agent 在**真实市场并行寻源**（源侦察员按源扇出；资格判定员批量判定）；
2. 全动作**可审计、可预算**（每回合成本归集到 usage_ledger/run 预算）；
3. 前端「过程」页可读决策轨迹（选源/跳过/原因/被否候选）；
4. **零行为变化**：v0 是既有管线的角色化包装 + 轨迹记录，不改变召回、评分、预算语义（golden mini-run 口径验证）。

## 2. 承重假设（可证伪）

| # | 假设 | 若被证伪 |
| --- | --- | --- |
| A1 | v0 agent 不新增执行能力，只把既有阶段（query fan-out / quickScan 判定）**角色化 + 注册化 + 轨迹化**；不新起第二工作流 | 若需要新能力，走 step 10 后新 workflow 立项，不在本步 |
| A2 | agent 注册存 DB（`agent_profile`，仿 skill_registry 模式：seed + FORCE RLS + 平台启停），不存代码常量 | 回退为代码常量 + 文档，失去运营可配 |
| A3 | 决策轨迹落**引擎新表** `agent_decision_trace`（append-only，F2 字段组子集），与 gain-saas `campaign_decision_trace`（活动域）分域共存；引擎侧不加跨仓依赖 | 若强行共用一表，跨库一致性代价高于收益（两库分属不同服务） |
| A4 | 「过程」页 v0 只做**只读时间线**（run 详情内嵌），不做树/瀑布切换（F2 的 UI 三模式留给 P6） | 若产品要求完整三模式，扩 UI 范围但不改后端契约 |

## 3. 触点与数据模型

### 3.1 新表（packages/db 迁移，additive）

- **`agent_profile`**：`key`（如 `discovery.source_scout` / `discovery.qualifier`）、`name`、`role_prompt_version`、`skill_keys jsonb`（技能子集，引用 `skill_package.key`）、`model_policy jsonb`、`memory_scope text`、`loop_policy jsonb`（`{maxRounds: 1}` v0）、`status`（`ACTIVE|DISABLED`）、`created_at/updated_at`。FORCE RLS；seed 幂等（照 `skill-catalog.seed` 模式）；平台启停走 ops（复用 S0 ops 面扩展或独立端点）。
- **`agent_decision_trace`**（append-only）：F2 字段组子集——`id/workspace_id/run_id/workflow_id/parent_trace_id/step_type/agent_key/actor_type('agent')/attempt/decision_type(gate)/chosen_option/score/reason_code/evidence jsonb[](url+retrievedAt+support)/rejected_candidates jsonb[](candidateRef/score/rejectReason/revivable)/cost_estimated_micros/cost_actual_micros/created_at`。FORCE RLS；只 INSERT（无 UPDATE/DELETE 代码路径 + 负向测试）。
- 回填与兼容：无回填；历史 run 无轨迹行属预期（trace 从本步开始积累）。

### 3.2 角色化落点（零行为变化的包装点）

| agent | 落点（现有代码） | v0 回合定义 | 轨迹记录点 |
| --- | --- | --- | --- |
| `discovery.source_scout` | `executeQuery` 的多源 fan-out（`discovery.activities.ts` 各 provider 调用前） | 每个（查询 × 源）一次回合：选源/跳过原因 → 召回计数 → 成本 | `decision_type='source.route'`：chosen=source key；rejected_candidates=未路由源及 `planQuerySkipReason` |
| `discovery.qualifier` | quickScan 批量判定（`discovery.run2.*` 的 qualify 批） | 每批一次回合：批量判定 → 逐家 verdict → 归属被否候选 | `decision_type='fit.judge'`：chosen=批次；rejected_candidates=verdict mismatch 公司及理由码 |

- 监督者 = 既有 Temporal workflow（discoveryWorkflow）不变；类型化移交 = 现有活动返回结构；共享黑板 = `canonical_company`/`lead`/`run_event`（产品数据模型本身）。
- **禁自由群聊**：agent 之间无直接消息通道，只经 workflow 编排与数据模型交接（结构上没有旁路）。

### 3.3 预算与成本归属

- 复用 execution budget：agent 回合不新开预算账户，成本仍落 `usage_ledger`（`ref_type='ai_trace'` / `provider_call`）；`agent_decision_trace.cost_*` 存回合级归属（估算=预算信封、实际=台账聚合），不与账本竞争真相。
- `loop_policy.maxRounds` v0 恒 1（单回合，无自我重试循环）；有界重规划（≤2–3 轮）属 M2.2 的 planner 域，不在本步。

## 4. 接口与事件

- **ops 端点（引擎）**：`GET /ops-agents`（列表+状态）、`PATCH /ops-agents/:key/status`（平台启停）。复用 S0 ops 鉴权（`ops:read/ops:write`）。
- **租户只读端点**：`GET /runs/:runId/trace`（分页，run 详情内嵌「过程」时间线数据源；跨租户 404）。
- **事件**：不加对外事件管道（D-MA-4 先表后事件；`agent.*` 版本化事件留到有真实消费方）。
- **技能解析**：两 agent 的技能子集经 S0 resolver 解析（`skill_enablement` 生效：技能平台停用 → 对应回合 fail-closed 并落轨迹 `reason_code='SKILL_PLATFORM_DISABLED'`）。

## 5. 幂等、重试与失败语义

- trace 写入在活动事务内与既有回执同源（随 run 的 at-least-once 语义）：`agent_decision_trace` 以 `(workspace_id, run_id, step_type, discriminator)` 唯一键幂等（discriminator=queryKey/batchId），重试不翻行。
- agent 回合失败=活动失败（既有重试策略），轨迹行记录 `attempt` 与失败码；**不改既有 Temporal 重试语义**。

## 6. 权限与合规

- 两表 FORCE RLS（`app.current_workspace_id`），跨租户不可见；ops 面仅平台字段（status）。
- 轨迹**不含个人数据**：evidence 只存 URL+抓取时间+支持关系；被否候选存公司引用 id 而非联系人或邮箱（PII 红线）。
- DSR：trace 随 run 级联删除（`ON DELETE CASCADE` 走既有 deletion 路径），无独立擦除逻辑。

## 7. 迁移与回滚

- 一条 additive 迁移（两表 + 索引 + RLS 策略 + seed 幂等）；无既有表变更。
- 回滚：关 ops 平台停用两 agent（执行侧回退为未角色化的既有管线——因为 v0 是包装，关掉 trace 与路由记录即行为等价）+ 代码 revert；表保留无害。
- 部署：随发布列车（无 run 硬窗口）。

## 8. 负向测试（必含）

1. 未注册 agent key 不可运行（活动直接拒绝，`AGENT_NOT_REGISTERED`）；
2. agent 平台 DISABLED → 对应回合 fail-closed（`AGENT_DISABLED`），run 按既有失败语义走；
3. 技能被平台停用 → 回合 fail-closed 且轨迹落 `SKILL_PLATFORM_DISABLED`；
4. trace 无 UPDATE/DELETE 路径（源码断言 + 无对应方法）；
5. 跨租户读 trace → 404；
6. 同一 (run,step,discriminator) 重放 → 不新增轨迹行（幂等）。

## 9. 闭环设计

- **SoR**：agent 定义=引擎（`agent_profile`）；轨迹=引擎（`agent_decision_trace`）；线索/公司=既有模块，不变。
- **闭环位置**：Discover（源侦察员）与 Qualify（资格判定员）两段的**过程可视与治理**；上游接 planner（步 2 的源覆盖），下游喂 M2.2 的指标与前端「过程」页。
- **端到端演示（E2E-9b）**：一次真实 mini-run（3–5 家口径）→ `GET /runs/:runId/trace` 可读选源决策与批量判定结果（含被否候选）→ ops 停用资格判定员 → 再跑 → run 以 `AGENT_DISABLED` 失败且无模型调用 → 恢复。

## 10. 风险

- R1 轨迹行数与 run 规模成正比（每查询×源一行 + 每批一行）→ 索引与保留随 run 级联，量级可控（百行/run）。
- R2 `executeQuery`/run2 文件与整改线 B2/B3 在飞（同文件）→ 施工前 merge main 并由主会话裁决接口；B2/B3 先落的改动优先。
- R3 前端「过程」页落在 gain-saas（与 P6 的关系：v0 是 run 详情内嵌只读时间线，不占 P6 导航范围）。

## 11. 决策点（请逐项确认）

| # | 决策 | 推荐 |
| --- | --- | --- |
| D-9b-1 | 轨迹表归属：引擎新表 `agent_decision_trace`（与 gain-saas 活动域 `campaign_decision_trace` 分域） | 接受（跨库共表代价高于收益；两域各自 append-only） |
| D-9b-2 | agent 注册存 DB（seed + RLS + ops 启停）而非代码常量 | 接受（与 skill_registry 同模式，运营可配） |
| D-9b-3 | v0 两个 agent `loop_policy.maxRounds=1`（单回合，无自我循环）；有界重规划留 M2.2 | 接受 |
| D-9b-4 | 「过程」页 v0=run 详情内嵌只读时间线（树/瀑布切换留 P6） | 接受 |
| D-9b-5 | 施工顺序：9b-1 注册表+resolver+trace 表（可先行）→ 9b-2 源侦察员角色化 → 9b-3 资格判定员 → 9b-4 租户 trace 端点+前端时间线 | 接受 |

## 12. 联网研究（承接既有调研，不重复烧钱）

- 编排层结论沿用计划 §0.7-B（2026-11-08 三路调研）：持久化执行引擎（Temporal）+ agent 语义以官方集成/Task 形式出现；Unify 的 planner+brain/hands 架构与本设计同构；全自主对外动作失败率高（11x/Artisan 证据），故 v0 严格 propose-observe。
- 轨迹词表沿用 F2（OTel span + W3C PROV 词汇，字段组已在 §3.1 收敛）。
- 本轮无新增外部依赖评估（不引 Langfuse/ClickHouse/新 SDK）。

## 13. 施工拆分（批准后 TDD，stacked PR）

1. **9b-1**：迁移（两表+RLS+seed）+ agent registry store/resolver + 负向测试 1/2/4/6；
2. **9b-2**：源侦察员角色化（executeQuery 路由点 + 轨迹写入）+ golden mini-run 召回不降；
3. **9b-3**：资格判定员角色化（quickScan 批 + 轨迹写入含被否候选）；
4. **9b-4**：`GET /runs/:runId/trace` 租户端点 + gain-saas run 详情「过程」时间线（只读）+ E2E-9b。

## 14. 给产品负责人的说明

- **得到什么**：两个「角色 agent」正式上岗——源侦察员按源并行寻源、资格判定员批量判定，每一次选源/跳过/判定都留下可回放、可预算的决策轨迹；前端 run 详情能看到「过程」（选了哪些源、为什么跳过、哪些公司被否、成本多少）。这是经营大脑（M2.1/M2.2）观察与学习的眼睛，也是步 10 QGO 的判定证据来源。
- **没改什么**：召回、评分、预算、既有重试语义全部不动（v0 是角色化包装+轨迹）；不加对外事件；不引第二编排器与新依赖。
- **风险与回退**：迁移 additive；关 agent/技能即回退行为；轨迹无 PII。
- **建议**：批准 D-9b-1~5 按推荐值，施工顺序 9b-1 先行，其余与整改线 B2/B3 合流后排期。
