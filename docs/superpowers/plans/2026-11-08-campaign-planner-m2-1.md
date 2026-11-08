# M2 步 9 · M2.1 受限 Campaign Planner 与审批 UI 落地设计（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：按 §0.6 任务启动门产出（设计 / 闭环 / 联网研究），产品负责人 2026-11-08 已批准（经主会话打包确认，全部按推荐值）；依据协调计划 §0.2 步 9（M2.1）、§0.7 D-MA-3（受限规划器 propose-only）/D-MA-8（决策轨迹与审批并入契约）、F2（审批 UX 规格）。
> 前置依赖：M2.0 契约（gain-saas #69/#71 已合入 main：六表、CampaignPlan v0 校验器、canonical plan_hash、审批状态机、ExecutionAuthorization 双钥匙）；S0 技能运行时（已发车，E2E 通过）；记忆层 v0（#844 已合入 main）。主会话起草（2026-11-08）。

## 1. 背景与目标

### 1.1 目标（M2.1 DoD，计划 §0.2 步 9）

- `campaign.plan` **受限规划器**：只读检索、只产计划不执行；shadow 2–4 周；humanGate。
- **审批 UI 端到端**：真实计划 → 审批（批准/拒绝同权、超时=拒绝、旧同意不可复用）→ 授权签发 → 前端呈现「将执行（影子期）」意图，但**不执行任何动作**。
- 计划可哈希可回放；决策轨迹落表可查（F2 字段组）。

## 2. 承重假设（可证伪）

| # | 假设 | 若被证伪 |
| --- | --- | --- |
| A1 | 规划器是**引擎侧 Temporal 工作流**（`campaignPlanningWorkflow`），由 gain-saas BFF 以租户操作触发（异步 job + 回调回写）；不新增第二编排器 | 若要求同步返回，把 BFF 超时与引擎活动时长绑定，接口不变 |
| A2 | **plan_hash 单一权威在 gain-saas**：引擎只产原始 CampaignPlan JSON（不带 hash），gain-saas 用已合的 canonical 规则校验+哈希+落 revision（DRAFT）。引擎侧不复制哈希实现，避免双实现漂移 | 若引擎需要本地校验，调用 gain-saas 校验端点，不复制算法 |
| A3 | **影子期执行闸门**是 gain-saas 的特性开关 `CAMPAIGN_EXECUTION_SHADOW=on`（默认 on）：审批通过照常签发 ExecutionAuthorization，但任何执行调用方（未来 M2.2）在影子期必须拒绝；M2.1 不交付任何执行接线，因此「不执行」在结构上成立 | 若出现异常执行路径，按负向测试（§8-1）处理 |
| A4 | 规划器**只读输入白名单**：ICP（租户所有）、卖家公司档案（CompanyProfile/Offering/Claim 已批准事实）、记忆 brief（mem 检索服务 v0）、公司池聚合统计（计数，无明细 PII）；不写任何业务表 | 若需新输入源，先改白名单表并在设计增补 |
| A5 | 审批 UI v0 落 gain-saas 现有 vben 前端新页面（Campaign 列表/详情/审批卡/Why 卡三层渐进）；不占 P6 导航重构范围 | UI 全量重建留 P6 |

## 3. 运行时拓扑（两仓职责）

```
租户(BFF 会话)         gain-saas(控制面, SoR)                    backend(引擎, 执行/认知)
  │  POST /api/campaigns/:id/plan-drafts
  │ ─────────────────────► CampaignPlanJob 行(PENDING)
  │                        │ 以服务身份调引擎
  │                        │ POST /internal/v1/campaign-plans/draft (service token)
  │                        │ ─────────────────────────────────► campaignPlanningWorkflow 启动
  │  GET .../plan-drafts/:jobId (轮询)                      │  read-only: ICP/档案/记忆 brief/池统计
  │ ◄───────────────────── job 状态                           │  LLM 产 CampaignPlan JSON(propose-only)
  │                        │  引擎回调 gain-saas
  │                        │ ◄──────── POST /api/internal/v1/campaign-revisions (service token)
  │                        │  zod 校验(CampaignPlan v0) → canonical plan_hash → 落 DRAFT revision
  │                        │  失败→ job=FAILED + CAMPAIGN_PLAN_INVALID issues
```

- 决策轨迹双侧：引擎侧规划回合落 `agent_decision_trace`（步 9b 表，`step_type='campaign.plan'`）；gain-saas 侧提交/审批/签发落既有 `campaign_decision_trace`（M2.0 已有）。
- 引擎工作流产物只在**回调**中交付一次（幂等键 `jobId`）；回调失败重试后仍失败 → job FAILED，人工重触发（新 jobId）。

## 4. 契约

### 4.1 引擎 `campaign.plan` AI Task（S0 技能注册）

- skill key：`campaign.plan`（SKILL.md 包 + validator，allowedTools=[]，零工具；模型输出严格 JSON）。
- 输入（PromptContext，全部只读）：ICP 快照（目标市场/条件）、卖家档案摘要（公司/行业/已批准 Offering/Claim）、公司池统计（按国家/行业计数）、记忆 brief（≤2k token，注出处）、工作区预算上限提示。
- 输出：CampaignPlan **v0 形状**（与 gain-saas §4 契约逐字段一致；schemaVersion 固定 `campaign-plan/v0`；`decisionPolicy.maxReplans` 恒 0）。引擎不产 plan_hash。
- humanGate：true（计划只能作为草稿，不落 gain-saas 之外的任何状态）。

### 4.2 gain-saas 新增（最小）

- 表 `campaign_plan_job`：`id/workspace_id/campaign_id/state(PENDING|RUNNING|SUCCEEDED|FAILED)/engine_run_ref/error/issues/created_at/updated_at`（FORCE RLS；additive 迁移）。
- 端点：`POST /api/campaigns/:id/plan-drafts`（admin；创建 job 并调引擎）、`GET /api/campaigns/:id/plan-drafts/:jobId`（轮询）、内部回调 `POST /api/internal/v1/campaign-revisions`（服务令牌，沿用 M2.0 verify 端点同款 guard）、内部 job 状态回写 `PATCH /api/internal/v1/campaign-plan-jobs/:jobId`（引擎用）。
- 校验复用 M2.0 已有 zod validator + canonical hash + revision 落库（state=DRAFT）。

### 4.3 审批 UI（v0 最小）

- **Campaign 列表**：名称/状态/最新 revision 状态/预算上限/更新时间。
- **Campaign 详情**：计划摘要卡（目标、受众 ICP、动作=discovery、预算上限、sizeCap）、revision 时间线、审批卡（批准/拒绝 + 必填拒绝理由）、**Why 卡三层渐进**（第一层人话结论；第二层依据=输入摘要+记忆 brief 出处；第三层技术详情=plan JSON+hash+job id，默认折叠）。
- **影子期横幅**：「影子期：批准不会真的执行；我们只记录决策与指标」。
- 零术语红线：不出现 revision_id/plan_hash/UUID 等裸标识（技术详情折叠区除外）。

## 5. 幂等与重试

- 触发：`POST plan-drafts` 同 campaign 同时只允许 1 个活跃 job（部分唯一索引 `(campaign_id) WHERE state IN ('PENDING','RUNNING')`）。
- 回调幂等：`(jobId, plan_hash)` 唯一；重复回调返回已存在 revision。
- 引擎工作流：活动重试沿用 Temporal 策略；LLM 输出不合 schema → 活动内单次修复重试（重 prompt 附 validator issues），仍失败 → job FAILED（错误码 `CAMPAIGN_PLAN_INVALID`）。

## 6. 预算与成本

- 规划回合走 `execution-budget` 的 workspace 技术 quote（purpose 新增 `campaign.plan`——**需引擎追加 purpose 枚举与 quote 变体**，或复用现有 `understanding.run` 类目？推荐新增 purpose，语义干净）。
- 成本归集：usage_ledger（ref=campaign.plan job）+ job 行汇总；Why 卡展示预估成本。

## 7. 合规

- 输入白名单不含个人数据（联系人不进 planner）；记忆 brief 已按防投毒口径（受信服务写入）。
- 输出仅计划（无外发/无抓取新增）；审计沿用两侧 trace。

## 8. 负向测试（必含）

1. **未审批不可执行**：影子期签发的 authorization 被任何调用方尝试使用时 → 闸门拒绝（`CAMPAIGN_EXECUTION_SHADOW`）；v0 无执行接线，以单测断言「无调用路径」+ 影子开关测试；
2. 跨租户：job/详情/回调 404；服务令牌缺失/错误 → 401/503（复用 M2.0 fail-closed guard）；
3. 契约漂移：引擎产出字段超出/缺失 → `CAMPAIGN_PLAN_INVALID` + issues 落 job；
4. 技能平台停用 `campaign.plan` → job FAILED `SKILL_PLATFORM_DISABLED`，无模型调用（ai_trace 计数 0）；
5. 重复触发并发 job → 409；重复回调 → 幂等返回同一 revision；
6. 旧同意不可复用：批准后产生新 revision → 新审批强制（M2.0 已测，回归覆盖）。

## 9. 闭环设计

- SoR：计划/generation job=引擎；revision/审批/授权=gain-saas（M2.0）。
- 闭环位置：Plan → Approve 两段（§17.9 十二阶段）；上游 Target（ICP）+记忆；下游 Execute 由 M2.2 接线（影子期不接）。
- 端到端演示（E2E-M2.1）：创建 campaign → 触发 plan-draft → 轮询 SUCCEEDED → 详情页看 Why 卡三层 → 批准 → 状态机到 APPROVED 并签发 authorization → 影子横幅确认「将执行但不执行」→ 拒绝路径同理 → trace 两库均可查。

## 10. 迁移与回滚

- gain-saas 一条 additive 迁移（campaign_plan_job 表 + 索引）；引擎无迁移（purpose 枚举为代码扩展）。
- 回滚：关 `CAMPAIGN_PLAN_JOB_ENABLED=false`（BFF 停触发）+ revert；表保留无害。

## 11. 施工拆分（批准后 TDD）

1. **M2.1-1（backend）**：`campaign.plan` 技能包 + 任务注册 + `campaignPlanningWorkflow` + 只读输入装配 + 负向 4；
2. **M2.1-2（gain-saas）**：campaign_plan_job 迁移/服务/三端点 + 回调校验落 revision + 幂等/负向 2/5；
3. **M2.1-3（gain-saas web）**：Campaign 列表/详情/审批卡/Why 卡/影子横幅；
4. **M2.1-4（联调）**：E2E-M2.1 全链 + 归档证据。

## 12. 风险

- R1 引擎 purpose 枚举扩展触碰 execution-budget 合同（protected 指纹需重签）——按仓库流程重钉指纹，单独 PR 评审；
- R2 LLM 计划质量 v0 无 Golden Set（M2.2 建 golden brief 10–20 条）——影子期以人工审批作为质量闸门，与设计一致；
- R3 shadow 开关误关 → 执行接线不存在，最坏情况是「可点批准但依旧无执行」，无风险扩散。

## 13. 决策点（请逐项确认）

| # | 决策 | 推荐 |
| --- | --- | --- |
| D-M2.1-a | 触发拓扑=异步 job（BFF 创建 job → 引擎工作流 → 服务回调回写） | 接受（规划 30–120s，同步会拖死 BFF 超时） |
| D-M2.1-b | plan_hash 单一权威在 gain-saas（引擎交原始 JSON） | 接受（避免双实现漂移） |
| D-M2.1-c | 影子期闸门=`CAMPAIGN_EXECUTION_SHADOW=on`（默认 on，M2.2 翻默认前须产品决策） | 接受 |
| D-M2.1-d | Why 卡 v0=三层渐进（结论/依据+出处/技术详情折叠） | 接受（F2 三模式中的最小子集） |
| D-M2.1-e | 新增引擎 purpose `campaign.plan` 做预算 quote（不复用 understanding.run） | 接受（语义干净；指纹重签走单独评审） |

## 14. 联网研究

- 沿用计划 §0.7-B/F1/F2 的既有调研（编排选型、审批 UX、Regie next-best-action）；本轮无新增依赖、无新外部服务。影子期（shadow）模式沿用计划 M2.1 既定口径。

## 15. 给产品负责人的说明

- **得到什么**：经营大脑的第一形态——你说一句话（或系统按 ICP）生成一份结构化 Campaign 计划草稿；你（或管理员）在界面上看到「计划做什么、依据是什么、花多少钱上限」，一键批准/拒绝；批准后系统签发授权但**影子期不真的执行**。这就是 L1 参谋落地。
- **没改什么**：不执行任何外部动作；不改发现/评分/预算语义；审批与授权沿用 M2.0 已上线机制。
- **风险与回退**：job 开关一关即停；计划质量靠人工审批把关（M2.2 建 Golden Set 后量化）。
- **建议**：批准 D-M2.1-a~e 按推荐值，施工按 M2.1-1→M2.1-4 顺序；backend 侧可先开（不依赖 UI），gain-saas 侧待你点过设计后开工。
