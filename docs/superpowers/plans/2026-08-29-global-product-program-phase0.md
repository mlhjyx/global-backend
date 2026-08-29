# Global Product Program Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把用户批准的《Global 全局产品与项目总计划（高级产品/项目经理完整替换版）》落实为一个可恢复、可审计的 Phase 0 控制面，冻结 Program A/B 越界施工，完成三向接口裁决，并把产品、工程、运行和文档真值同步到当前权威入口。

**Architecture:** `/global/backend` 根工作区继续只作 main 与现场审计；本计划在 `codex/global-product-program-phase0` 隔离 worktree 实施文档与治理变更。Program A、Program B、GrowthOS 和其他任务的源码只读审计，不从本分支复制、回退或合并；跨 Program 的业务实现必须等 G0 ownership 裁决进入主线后再由唯一 writer 从 current main 开新卡。

**Tech Stack:** Markdown governance docs、Git/worktree provenance、ContractGraph、Node.js document/governance verifiers、systemd/port readback。

**Spec:** 用户在 Codex 任务 `01a04c76-cdff-7951-a338-e39dc1f5c17d` 批准的《Global 全局产品与项目总计划（高级产品/项目经理完整替换版）》；Program A 仍受 `/root/.codex/attachments/87cc329a-8441-47cb-bcfe-834e918ed20b/pasted-text.txt` 的“能力优先实施计划”约束。

## Global Constraints

- 产品定位固定为面向中国 B2B 制造、工贸一体和高客单传统出口企业的海外增长机会操作系统。
- 首发 Job 固定为发现有真实需求证据的海外进口商/采购商，并把至少一个候选推进到人工 QGO 判断。
- 北极星固定为“每活跃 Workspace 每月新增 QGO”；Build 成功率、Raw 数、Provider 数、页面数和测试数不得替代北极星。
- Backend 获客边界止于不可变 `LeadQualifiedPackage + Outbox/ACK`；SaaS 拥有 Opportunity、QGO、SAO、Conversation、Campaign、Outcome。
- Program A 只拥有通用 Execution Authority、GovernedSubject/Relation、Site Quote/Grant、OCI/runtime、统一 RuntimeEvidence/Release；不得拥有 RawSourceRecord、IdentityLink、CanonicalCompany 业务 schema、Provider 或 Opportunity。
- Program B 只拥有 Raw/query receipt、Identity/Canonical、Provider/transport、Discovery 业务 workflow 和 LeadQualifiedPackage；不得拥有通用 Grant 算法、通用 GovernedSubject primitive、SaaS Opportunity 或 runtime deploy。
- Program C 只拥有服务端 handoff consumer、receipt、QualificationSnapshot、Opportunity、QGO/SAO/CLOSED、SalesAcceptance、CommercialOutcome、Conversation linkage 与 commit-before-ACK；不得复制 Buyer Intelligence SoR。
- 固定接口为 `ExecutionAuthority → ToolOperationSubject → B-owned QueryReceipt → B-owned RawSourceRecord UUID → B-owned IdentityLink/CanonicalCompany UUID → A-owned append governed child/relation primitive → Domain ACK`。
- Program A Task 5.2 在 ownership 裁决前不得继续 GREEN。已产生的 RED 或越界提交只保留 provenance 并标 `HOLD_OWNERSHIP`，不得回退、删除、移植或接纳。
- development、pilot、production 共用 Production Parity 业务语义；测试替身、fixture、gallery 和 Dev Token 不进入产品 composition root、OCI 或 Release。
- 客户 Billing/Credits 继续 `DEFERRED / NOT_IMPLEMENTED`；`cap_microusd` 只是平台执行安全包络。
- 不执行 push、PR、merge、deploy、service restart、retained migration、provider/model/paid call、OAuth/email 或凭据变更，除非用户另行明确授权该动作。
- 所有 current 状态必须绑定 exact repo/worktree/commit、evidence class 和限制；`docs:verify`/`governance:verify` 只证明结构与机器合同，不证明运行或用户可用。

---

### Task 1: 建立 Phase 0 控制面与 live baseline

**Files:**
- Create: `.superpowers/sdd/2026-08-29-global-product-program-phase0/progress.md`（gitignored）
- Create: `.superpowers/sdd/2026-08-29-global-product-program-phase0/agent-kanban.md`（gitignored）
- Create: `.superpowers/sdd/2026-08-29-global-product-program-phase0/live-baseline.md`（gitignored）
- Modify: `docs/status/current.md`

**Interfaces:**
- Consumes: root/main、origin/main、Program A/B/GrowthOS exact heads，`systemctl show`，`ss -ltnp`，RuntimeEvidence/Release verifier 统计。
- Produces: 所有后续任务使用的 exact baseline、G0-G7 位置、Program RAG、外部授权队列和唯一 writer 表。

- [ ] **Step 1: 捕获根/main 与目标 worktree exact 状态**

  记录 `git status --short --branch`、`git rev-parse HEAD origin/main`、目标 worktree head/dirty/upstream；不得 fetch、sync、stash、reset 或 clean。

- [ ] **Step 2: 捕获 runtime 只读状态**

  记录 API/Worker/Temporal 的 `ActiveState/SubState/NRestarts` 和 3000/3001/3002/3003/8080 的监听地址；不得读取 secret 内容、重启服务或改变端口。

- [ ] **Step 3: 建立 Agent Kanban**

  每张卡必须含 Card ID、Capability/用户结果、Program/Milestone/Gate、Owner、repo/worktree/branch、exact base/head、owned files/schema/migrations、inputs/outputs、non-goals、acceptance、security/privacy/cost boundary、external actions、stop conditions、review owner 和 handoff artifact。

- [ ] **Step 4: 将 current 状态改成证据化摘要**

  `docs/status/current.md` 只保留当前 main、产品阶段、Program A/B/C、G0-G7、live runtime、阻塞、下一用户结果和授权队列；长历史转到 changelog/evidence，不复制到多个 current 文件。

- [ ] **Step 5: 验证 Task 1**

  Run: `pnpm docs:verify && pnpm governance:verify`

  Expected: exit 0；同时明确这不证明 G3-G7。

### Task 2: 完成 A/B 三向接口审计并隔离越界提交

**Files:**
- Create: `.superpowers/sdd/2026-08-29-global-product-program-phase0/ab-three-way-audit.md`（gitignored）
- Modify: `docs/governance/conflict-register.md`
- Modify: `docs/adr/registry.md`

**Interfaces:**
- Consumes: live main `23d111f7b400403deb7466abf34ab709685b8376`、PR #423 head `96e22e82009992aa20523a4d3075943b695f00c2`、Program A RED checkpoint `6c3ca8a0c9715b325eee1cfccf38f7a07db51429`，以及审计时观察到的任何后继 A commit。
- Produces: 每个 RED assertion 的 `ADOPT_AS_A_PRIMITIVE_TEST | REWRITE_AS_B_CONSUMER_TEST | B_OWNED | DROP_DUPLICATE | HOLD_FOR_INTERFACE` 分类，和唯一 producer/consumer/transaction ownership。

- [ ] **Step 1: 重建三个 exact subject 的静态影响面**

  在每个 exact worktree 运行 `pnpm code-intelligence:scan`、status、对 Task 5.2 changed files 的 impact；图只作为候选，逐项回读 migration、writer、Raw v2、query receipt、Identity/Canonical、Temporal tests。

- [ ] **Step 2: 逐条分类三份 RED 测试**

  对 migration contract、writer unit、true PostgreSQL/RLS 中的每个独立断言记录：分类、当前 owner、应保留的位置、生产者、消费者、事务边界、与 PR #423 的重复/冲突和下一动作。

- [ ] **Step 3: 审计 RED checkpoint 后的 Program A 提交**

  任何新增 migration、writer、schema 或调用点都标记为 `QUARANTINED / HOLD_OWNERSHIP`；保留 commit provenance，不执行 revert、reset、drop 或 cherry-pick。

- [ ] **Step 4: 登记 load-bearing 决策**

  在 conflict register 登记 A/B overlap、唯一 owner、HOLD 条件和关闭条件；在 ADR registry 追加 Program ownership/interface 决策，但明确 `ACCEPTED` 不代表实现接纳。

- [ ] **Step 5: 验证 Task 2**

  Run: `pnpm docs:verify && pnpm governance:verify`

  Expected: exit 0；审计表必须覆盖每个 RED assertion 和所有 RED 后继提交。

### Task 3: 修正 Program A 计划 provenance 与 Task 5.2 状态

**Files:**
- Modify: `/global/backend/.codex/worktrees/production-parity-capability-cutover/.superpowers/sdd/pasted-text.txt/progress.md`（gitignored，只有在该 worktree 无其他 writer 后）
- Create: `/global/backend/.codex/worktrees/production-parity-capability-cutover/.superpowers/sdd/pasted-text.txt/task-5-2-ownership-handoff.md`（gitignored，只有在该 worktree 无其他 writer 后）
- Modify: `docs/roadmap/release-plan.md`

**Interfaces:**
- Consumes: 当前 binding plan `/root/.codex/attachments/87cc329a-8441-47cb-bcfe-834e918ed20b/pasted-text.txt`，旧 predecessor `/root/.codex/attachments/40238abb-37c2-482a-aa4d-2d226e0680ca/pasted-text.txt`，Task 2 A/B audit。
- Produces: 唯一 plan provenance、`RED_CAPTURED / HOLD_OWNERSHIP / REQUIRES_LIVE_MAIN_REBASE_AND_INTERFACE_DECISION` 状态和面向 Program B 的 consumer-test handoff。

- [ ] **Step 1: 确认 Program A 没有活跃 writer**

  复核任务状态、worktree head/status 和最近提交。若另一个 writer 仍活跃，本 Task 保持 `HOLD_OWNERSHIP`，只在本计划 ledger 登记，不编辑对方 ledger。

- [ ] **Step 2: 修正 plan identity**

  将能力优先计划登记为 binding plan；旧计划登记 `PREDECESSOR / PARTIALLY_IMPLEMENTED / SUPERSEDED_FOR_CURRENT_EXECUTION`；GovernedSubject 登记为派生安全前置，不把 Discovery 业务 ownership 自动交给 Program A。

- [ ] **Step 3: 写 Task 5.2 handoff**

  handoff 必须列出 RED 分类、可复用 A primitive、B-owned tests/implementation、禁止触碰路径、exact base/head、迁移顺序和重新开放 GREEN 的 Gate。

- [ ] **Step 4: 更新 release plan 当前覆盖段**

  在路线顶部写明总计划 Phase 0-5、Program A/B/C ownership、首发 Job、MVP-0/1/Pilot/Site Preview 顺序和 G0-G7；旧日期化路线保留为 historical context，不作为当前执行顺序。

- [ ] **Step 5: 验证 Task 3**

  Run: `pnpm docs:verify && pnpm governance:verify`

  Expected: exit 0；对方 active writer 未停止时不得宣称其 ledger 已修复。

### Task 4: 同步产品主线、对象、Capability、Scenario 与前端真值

**Files:**
- Modify: `docs/product-scope.md`
- Modify: `docs/governance/capability-register.md`
- Modify: `docs/governance/core-object-register.md`
- Modify: `docs/governance/scenario-catalog.md`
- Modify: `docs/governance/traceability-matrix.md`
- Modify: `docs/frontend/README.md`
- Modify: `docs/frontend/04-page-and-capability-catalog.md`
- Modify: `docs/frontend/11-frontend-contracts-and-integration.md`

**Interfaces:**
- Consumes: 用户批准的五阶段价值旅程、七 bounded contexts、两条激活路径、Opportunity/C1-C5、六区 IA、capability manifest、状态词表、Site 状态驱动入口和 GrowthOS local source audit。
- Produces: 不漂移的产品边界、首发 Job、对象 SoR、页面/能力轴、handoff 场景和 current source/release/runtime 分离状态。

- [ ] **Step 1: 修正产品范围**

  把“五层”修正为“五阶段用户价值旅程 + 七 bounded contexts”；锁定进口商/采购商首发 Job、QGO 北极星、Managed/Collaborative 起步和当前明确不做；删除或标 superseded 的客户 Credits/套餐收费方向。

- [ ] **Step 2: 修正对象与 Capability 轴**

  登记 `LeadHandoffReceipt`、`QualificationSnapshot`、`Opportunity`、`SalesAcceptance`、`CommercialOutcome` 与 Conversation 子面；每项分别表达 PRODUCT/UX/SOURCE/TEST/RUNTIME/RELEASE/PILOT，不因 local source 或菜单存在升级为 available。

- [ ] **Step 3: 修正 handoff 场景**

  固定 `server consume → validate → transaction receipt+Opportunity+snapshot → commit → ACK`；覆盖 replay×10、ACK_PENDING、payload digest drift、restart、DSR/retention/suppression 和跨 workspace 负例；删除“先 ACK 再创建 candidate”的错误顺序。

- [ ] **Step 4: 修正 GrowthOS/frontend 真值**

  将正式源码状态改为 `LOCAL_SOURCE_AUTHORITY_FOUND / REMOTE_CI_RELEASE_UNVERIFIED`；Conversation 标为 Engagement substrate，canonical Opportunity 仍未实现；Builder dirty/ignored materialization 不是 authority；Campaign/Publish/Insights 保持 `NOT_OFFERED` 或 prototype。

- [ ] **Step 5: 验证 Task 4**

  Run: `pnpm docs:verify && pnpm governance:verify`

  Expected: exit 0；不得把 local tests 写成 deployed/runtime/UAT 通过。

### Task 5: Phase 0 独立复审与 G0 裁决

**Files:**
- Create: `.superpowers/sdd/2026-08-29-global-product-program-phase0/phase0-review.md`（gitignored）
- Modify: `.superpowers/sdd/2026-08-29-global-product-program-phase0/progress.md`（gitignored）
- Modify: `.superpowers/sdd/2026-08-29-global-product-program-phase0/agent-kanban.md`（gitignored）

**Interfaces:**
- Consumes: Tasks 1-4 的 diff、tests、audit 和所有 rulings。
- Produces: spec compliance + quality verdict、剩余 blocker、下一张唯一实现卡和用户需单独授权的外部动作队列。

- [ ] **Step 1: 运行完整文档与治理门**

  Run: `git diff --check && pnpm docs:verify && pnpm governance:verify`

  Expected: exit 0。

- [ ] **Step 2: 重建 ContractGraph 并检查变更影响**

  Run: `pnpm code-intelligence:scan`

  Run: `pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..`

  Run: `pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact <all-changed-paths> --repo ../..`

  Expected: graph/status 绑定本 worktree 和当前 HEAD/dirty source；impact 只作静态候选。

- [ ] **Step 3: 独立 reviewer 检查**

  Reviewer 必须分别给出产品/范围、架构/ownership、文档治理、运行/证据四个 verdict；实现者不得自签。

- [ ] **Step 4: 决定 G0**

  仅当 A/B 分类完整、唯一 owner 明确、Program A 越界提交隔离、没有活跃重叠 writer 且 provenance 已修正时，G0 才可从 FAIL 变为 PASS。任何一项未满足则保持 `HOLD_OWNERSHIP`，但可启动不依赖该接口的 Program C C1 规格/TDD或 Program A 非 Discovery 拆分卡。

- [ ] **Step 5: 选择下一张卡**

  优先顺序：`Program C C1 service principal + handoff receipt contract`，或 `Program A Technical Quote current-main slice`；不得启动 Discovery GREEN、真实 Pilot、runtime cutover、Provider wire 或邮件发送。
