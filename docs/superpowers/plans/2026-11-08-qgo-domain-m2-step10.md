# M2 步 10 · QGO/SAO/Opportunity 域与 Candidate≠Lead 落地设计（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：按 §0.6 任务启动门产出（设计 / 闭环 / 联网研究），产品负责人 2026-11-08 已批准（经主会话打包确认，全部按推荐值）；依据协调计划 §0.2 步 10（能力 4）、§18.4 P0-3（QGO/SAO/Opportunity 域 + Candidate/Lead 边界）、§18.6 盲点清单第 4 条（Candidate 与 Lead 语义混用）、§17.9 主干对象链 Candidate → Qualified Buyer Candidate → Lead → QGO → SAO → Verified Commercial Outcome。
> 前置依赖：步 9（M2.1 计划→审批链；QGO 归因到 campaign 须其授权引用）。主会话起草（2026-11-08）。

## 1. 背景与目标

### 1.1 现状缺口（已核）

- 引擎 `lead` 表**同时承担机器候选与业务线索**两种语义（PRD §9.3 点名的同名问题）：run 产出的机器判定（quickScan/deep verdict）与「人工接受后的线索」共用一张表、一个队列字段，无法审计「谁在什么证据下接受了它」。
- 全仓无 QGO（Qualified Growth Opportunity）、SAO（Sales Accepted Opportunity）、Opportunity、Outcome 模型——「合格 Lead → 商机」断链（顶层架构称最危险断点之一）。

### 1.2 目标（步 10 验收口径）

- **Candidate ≠ Lead** 在 API 与事件层分离：候选（机器产出）与线索（人工/规则接受）有各自的对象与审计；CandidateBatch/OriginRef 可追溯。
- Lead → QGO → SAO → Outcome 回写闭环：QGO 必须带**需求/时机证据与合法下一步**；SAO 必须**人工接受**；Outcome 从系统 of record 回写（为步 12 归因与 M2.2 指标供数）。
- 归属：QGO/SAO/Opportunity/Outcome 域归 **gain-saas（Growth Core）**；引擎保留候选与线索的产出与判定证据（§18.4 P0-3 已定）。

## 2. 承重假设（可证伪）

| # | 假设 | 若被证伪 |
| --- | --- | --- |
| A1 | **不重命名、不重建引擎 `lead` 表**；通过「CandidateBatch + OriginRef」事件与只读投影，在 API 层把机器候选语义剥离出来（lead 表退化为候选人池 + 接受后线索的并集，用 `acceptedAt/source` 区分） | 若必须物理拆分，另立迁移设计（代价高，暂不推荐） |
| A2 | QGO/SAO/Opportunity/Outcome 四对象存 gain-saas（新表），引擎侧只发事件（`LeadQualified` 已有；新增 `CandidateBatchCompleted`）并接受回查 | 若放引擎，跨仓授权/UI 成本显著上升 |
| A3 | QGO 创建走**规则+证据门**（至少一条需求/时机证据：如回复、官网采购页、招标命中、海关信号），并记录 `nextStep`；无证据只能停留在 Lead | 若产品要求纯人工建 QGO，门降级为「证据可选+审计」，但不推荐 |
| A4 | SAO 必须人工接受（租户 admin/member 均不可自动）；Outcome 使用闭集枚举 v0：`REPLIED | MEETING_BOOKED | QUOTE_SENT | WON | LOST | NO_RESPONSE | DISQUALIFIED` | 若要更细粒度，扩枚举而非自由文本 |

## 3. 数据模型（gain-saas 新表，additive，FORCE RLS 按既有模式）

- **`qgo`**（Qualified Growth Opportunity）：`id/workspace_id/campaign_id?/lead_ref(引擎 lead id)/canonical_company_ref/icp_ref?/evidence jsonb[](type,url,retrievedAt,support)/next_step text/title/score/state(OPEN|CONVERTED|DROPPED)/created_by(系统|用户)/created_at`。QGO 与 lead 1:1（同一 lead 重复创建幂等）。
- **`sao`**（Sales Accepted Opportunity）：`id/workspace_id/qgo_id/state(ACCEPTED|DECLINED)/decided_by/decided_at/reason/created_at`。人工接受动作即 SAO；拒绝对称留痕。
- **`opportunity_outcome`**：`id/workspace_id/sao_id/outcome(枚举)/occurred_at/source(SYSTEM|MANUAL)/evidence ref/note`。append-only（多事件序列）。
- 引擎侧**无新表**：新增事件 `CandidateBatchCompleted`（run 级：批次号、候选公司 refs、判定分布）+ 既有 `LeadQualified` 扩展字段（向后兼容，schema_version 递增）。

## 4. API 与事件

### 4.1 gain-saas（租户面）

- `POST /api/qgos`（从 lead 提升：入参 lead_ref+evidence+next_step；校验证据门 A3；幂等）。
- `GET /api/qgos`（列表+过滤 state/campaign）、`GET /api/qgos/:id`（含证据与 SAO 状态）。
- `POST /api/qgos/:id/accept` → SAO(ACCEPTED)；`POST /api/qgos/:id/decline`（reason 必填）。
- `POST /api/saos/:id/outcomes`（登记 Outcome 事件；后续步 12 接系统自动回写）。
- 全部 admin/member 可操作（与 P5 审定）；跨租户 404；审计行（audit_log）。

### 4.2 引擎

- 事件载荷扩展：`LeadQualified` 增 `candidateBatchRef/evidenceDigest`（可选字段，旧消费方不受影响）；新增 `CandidateBatchCompleted`（每 run 每批一条）。
- 只读 Tool Contract：`GET /api/v1/leads/:id`（已有）保持不变；候选语义由 `lead.queue=needs_review` + `scoredAt/fitVerdict` 组装，新增 `GET /api/v1/lead-candidates?runId=`（只读视图，不复制表）。

### 4.3 消费侧（gain-saas event-consumer）

- `LeadQualified` → 生成/更新「候选线索」影子行（现有 QualifiedLead 表就地演进），供 QGO 提升入口列出。
- `CandidateBatchCompleted` → 运营台归因页指标（批次产出/判定分布）。

## 5. 幂等与重试

- QGO 提升幂等键 `(workspace_id, lead_ref)`；SAO `(workspace_id, qgo_id)` 唯一；Outcome append-only（无幂等约束，人工登记可重复事件；系统回写用 (sao_id,source_event_id) 幂等）。
- 事件消费沿用 outbox at-least-once + 现有幂等模式。

## 6. 权限、合规与审计

- QGO evidence 只存 URL/时间/摘录摘要，**不存联系人 PII**；联系人展示仍走引擎 owner-only 口径。
- 人工动作（提升/接受/拒绝/Outcome）落 audit_log（who/what/when）+ 决策留痕。
- DSR：lead_ref 指向引擎对象，DSR 级联时 gain-saas 行随 workspace 级联删除；Outcome 属运营证据，按 retention 策略（同 campaign trace）。

## 7. 负向测试（必含）

1. 无证据建 QGO → 400 `QGO_EVIDENCE_REQUIRED`；2. 跨租户提升/接受/Outcome → 404；3. 重复提升 → 幂等返回同一 QGO；4. 非 OPEN QGO 再接受 → 409；5. Outcome 枚举外值 → 400；6. `CandidateBatchCompleted` 旧 run 回放（无新字段）→ 兼容消费不报错。

## 8. 闭环与经济

- 闭环位置：Qualify → **Convert** 段（§17.9）；QGO 证据来自引擎判定与信号（现有证据链），SAO 人类确认，Outcome 为步 12 归因与 M2.2 北极星（cost per positive outcome）供数。
- SoR：候选/线索=引擎；QGO/SAO/Outcome=gain-saas；证据引用双向可查（事件 + 只读端点）。

## 9. 迁移与回滚

- gain-saas 一条 additive 迁移（三表+索引）；引擎无迁移。回滚=revert（表保留无害）。

## 10. 施工拆分（批准后 TDD）

1. **10-1（引擎）**：`LeadQualified` 载荷扩展（向后兼容）+ `CandidateBatchCompleted` 事件 + 只读候选视图端点 + 真实 run 事件回归；
2. **10-2（gain-saas）**：三表迁移 + QGO/SAO/Outcome 服务与端点 + 事件消费演进 + 负向 1–6；
3. **10-3（gain-saas web）**：线索页「提升为 QGO」入口 + QGO 列表/详情（证据卡）+ 接受/拒绝 + Outcome 登记；
4. **10-4（联调）**：E2E-M2.10——真实 run → 候选批量事件 → 提升 QGO（带证据）→ SAO 接受 → 登记 Outcome → 归因页/仪表可见。

## 11. 风险

- R1 引擎 lead 语义仍是并集（A1 的代价）：候选列表依赖 queue 约定，若历史数据 queue 漂移需一次性核对脚本（只读）；
- R2 QGO 证据门若过严会卡住早期使用——v0 证据类型枚举放宽为「任一结构化信号或人工备注+来源」，由人工担责留痕；
- R3 与 M2.1 的 campaign 引用为可选外键（计划未批前允许无 campaign 的 QGO）。

## 12. 决策点（请逐项确认）

| # | 决策 | 推荐 |
| --- | --- | --- |
| D-10-a | 归属：QGO/SAO/Outcome 四对象存 gain-saas，引擎不建新表（A1/A2） | 接受 |
| D-10-b | QGO 证据门（至少一条结构化证据 + next_step；无证据只能留 Lead） | 接受 |
| D-10-c | SAO 必须人工接受（无自动路径）；拒绝需理由 | 接受 |
| D-10-d | Outcome v0 闭集 7 枚举（REPLIED/MEETING_BOOKED/QUOTE_SENT/WON/LOST/NO_RESPONSE/DISQUALIFIED） | 接受 |
| D-10-e | 候选语义走事件+只读视图，不物理拆分 lead 表 | 接受（拆分代价高，收益低） |
| D-10-f | 施工顺序 10-1→10-4；UI 归 P6 前的最小页（不占导航重构） | 接受 |

## 13. 联网研究（承接既有结论）

- 主干对象链与 Gate 语义沿用顶层架构 §2.3 / PRD §7.16；CRM 对标（Twenty）仅作字段参考、不集成（D13/D14）。本轮无新增依赖。

## 14. 给产品负责人的说明

- **得到什么**：「合格的线索」不再混在机器候选里——每一家被提升为商机（QGO）都带证据与下一步；销售接受（SAO）必须人工确认；结果（回复/会议/报价/赢单/丢单）被结构化记录，成为归因与单位经济的原料。
- **没改什么**：引擎判定与线索评分不变；不拆 lead 表；无自动外发动作。
- **风险与回退**：纯 additive；回退=revert；证据门可配置。
- **建议**：批准 D-10-a~f 按推荐值；引擎侧（10-1）可先开工，gain-saas 侧随 M2.1 同批推进。
