# status/release-plan —— 稳定产品主线与发布门（L2）

> 文档 ID：`DOC-ROADMAP-001`
> 生命周期：`CURRENT`
> 最后核验：2026-11-12（工程审计元数据核对；正文未逐条复验）
> 当前事实来源：[当前状态](current.md) · [as-built 架构](../architecture/current.md)。
> 2026-07-10 v2（获客合流定稿）；2026-07-27 模型候选重基线更新；2026-09-04 产品顺序与 currentness 分离更新；2026-11-02 按 [文档目录与维护规则](../documentation-rules.md) 从 `docs/roadmap/` 迁至 `docs/status/`。历史实施日志见 [changelog.md](../roadmap/changelog.md)。
>
> **2026-10-14 覆盖说明（先读）**：下方「Ordered delivery」的 MVP-0 / MVP-1 / Pilot 3-A / Site 3-B / MVP-2 顺序，以及「Concurrency and authorization boundaries」里 Pilot 3-A 的范围与上限，已被产品负责人 2026-10-10 / 2026-10-11 的决定与 PRD 4.0（L2「能力路线图与 Release 门」，目前在私有目录，入库待 PRD4-D10）的 RL1–RL6 覆盖，只作历史产品序列保留，直到 PRD 4.0 入库后本页收缩。Pilot 3-A 写的「zero model / paid / send」与「named-person collection disabled」**不再是当前约束**：RL1 的发现（含 ICP 资格门的 fit 判定）使用真实模型调用（产品请求由 SaaS 签发的 Budget Grant 授权），评分本身是确定性计算、不调用模型；2026-10-11 产品负责人决定保留个人数据路径（具名个人邮箱与姓名、决策人、SMTP 探测、展会来源），风险自担，改为如实计数（PRD4-D16）。仍然有效的是：RL1 不做任何发送；G0–G7 的定义与下方逐项授权的边界不变。当前 Release 与执行事实只看[当前状态](current.md)。
>
> **2026-11-02 追加**：联系人线 M1–M4 已上线（run 内联系人阶段、社媒三层降级、邮箱补全双闸、决策人卡片），`email_guess` 已按 D3 重开（双闸：`decision_maker.config.lawfulBasis` interim LIA + `smtp_self`）；下文的「email guessing … disabled」与「Pilot 3-A 只跑 TED/GLEIF/官网」均属历史 Pilot 范围，不再是当前约束。Agent auto-send、Publish/Domain 等边界不变。
>
> **PRD 4.0 Release 结构**（只列结构与退出指标名称；范围、门槛与时间以 PRD 4.0 为准，并行度不超过两条线）：
>
> - **RL1 线索试点**（当前 Release）：一个 ICP、一个国家、一个品类，Managed 周报交付。退出指标：真实产出、精度、可达、证据、成本、商机、合规、节奏。
> - **RL2 可达与合规**：每条线索有合法联系路径与「为什么现在」，加第二个 ICP / 国家。退出指标：两个 ICP 的周报、推荐精度、建议联系路径覆盖、LIA 签署。
> - **RL3 商机与反馈**：QGO 宿主落地（宿主待 PRD4-D4），客户在页面上判断，结果回流评分。退出指标：月度 QGO 数、7 天 Outcome 回写率、客户独立完成判断。
> - **RL4 受控触达**：用户授权的单一发送渠道。退出指标：投诉率、退信率、回复进入 Conversation。
> - **RL5 对话与 Inbox**：回复识别 → Conversation → 商机候选。退出指标：一个渠道闭环。
> - **RL6 内容与站点**：Site Builder 作为「被找到」的信任资产按条件复活。退出指标：客户主动要求（触发条件）。
> - **X 减负线**（与 RL1–RL2 并行）：冻结 Site / R4、门改 lint、文档归档、缩短 CI（Site 冻结待 PRD4-D1，门改 lint 待 PRD4-D12，归档清单待 PRD4-D11；R4 冻结已由 PRD4-D2 于 2026-10-31 重开并完成向 gain-saas 的迁移，平台 schedule 恢复仍待单独拍板）。退出指标：每 PR 固定开销。

> 当前执行与运行采用先看[当前状态](current.md)。旧执行预算、平台调度与 Site Builder 模式见[运行架构](../architecture/current.md#运行模式与开关)。下文保留 RL 阶段、退出门与选定时的授权口径。

## Stable product sequence

**2026-11-23：先闭底座再启动，旧产品目标纳入首期**

依据产品负责人本次明确选择“先闭底座再启动”，采纳安全底座、首期旧产品目标、并行归档三分组。该决定只改变启动顺序，不把任何未交项标为完成，也不产生源码、费用、模型、渠道、数据库、部署或发布许可。

本节是稳定排期与验收边界，不记当前head、PR、镜像、测试计数或运行结论。实际状态仍按当前状态页及对应专业/运行原件核验。下列旧验收索引与Program A/B/C是不同命名，不改变各程序对象归属。

**启动前只关闭必要安全底座**

**硬门 · 必须保留的证明**
- **联系人执行安全**：每次物理调用有权威费用约束；同操作幂等与UNKNOWN恢复不产生无依据的第二次调用/扣费；当前请求、contact/subject、联系点、结果与回执不串位，不把甲结果用于乙；本次写回不损坏正确既有及并发产生的VALID，域写入和冷读真实一致。
- **SaaS安全与关键页面不回归**：适用依赖/发布安全及现有关键页面的功能、权限、语言与体验非回归有对应版本证据；只读保护和已有合法路径不退化。
- **正式同头审合**：正式来源与适用专业审查、必需检查、PR合并对应同一准确头；私有候选或作者自测不替正式交付。
- **匹配制品与部署**：两仓来源/合同/制品匹配，必要迁移和R4绑定与实际部署身份一致，回退输入和读回可核；不能用根checkout或health代替。
- **有界真实验证**：在另获准确数据/费用/运行窗口后，验证无重复费用、不串联系人、原操作可恢复与真实持久结果。样本有界，允许诚实不足/空/负结果，不要求先有订单。

单测、元数据、类型或合同生成、health及局部测试通过均不单独关闭这些硬门。未由主管按实际证据核闭前，不从准备转入新方案、新AI或新渠道实施。原适用阶段门和每项准确授权仍保留，不把所有历史产品目标、长期愿景或商业订单重新追加成启动前置。

**首期必须承接的旧产品目标**

- 正式市场候选UI及已选同公司恢复入口，包含服务身份与个人登录/读写权限的安全中英文提示，不凭HTTP状态猜用户无权。
- 真实候选set/candidate/revision与有效输入血缘进入独立受权画像动作，再由显式原流程完成后续找买家采用；假设画像不等已经找到买家、联系人或获得发送许可。
- 卖方文档原句、位置与版本进入待审事实，由有权者纠正、拒绝、审批后进入现有真实消费者；变版、失权和删除不得伪完成，既有合法结构化输入保持可用。
- 文档机制首片和默认受控辅助分别验收。人工选句只是机制验证/临时保底，默认辅助提取仍是首期旧承诺，不要求客户先证明手工失败，也不无限推到新AI总案以后。
- 完整联系人质量及相关读面：合资格且归属正确的无邮箱者可补强，RISKY弱占位/弱缓存不挡适用补强，UNKNOWN不冒可靠提升，正确VALID不受弱回写损害；个人点、公司渠道、归属与角色事实分层，本轮/历史/重放分母真实。

实现与新方案重叠时合并交付，不做平行主存、重复模型/渠道体系或重复实施。已闭限定源码和专业结果按原scope复用，不重开；未覆盖的产品、采用和真实验收仍按下面去向交付。

**A05/A06只交叉既有安全不回归切面。** 完整A05质量与A06深层归属仍属首期。本次安全片必须保护正确既有/并发VALID，且请求与contact/subject、点、结果/回执不串位；“首期”不允许当前写回损坏旧正确状态或把甲结果用于乙。同地址真实新负证据仍沿既有状态机，不永久冻结VALID，不新增质量功能或启动门。

**每项旧义务去向与不可丢的验收**

“底座”只指上面的安全切面；“首期”不是取消或无限延期；“并行”仍有真实归档责任，但不单独挡新方案启动。跨组条目按明确切面拆验，不让一个编号把整项产品需求重新变成启动前置。

**原索引 · 旧义务 · 当前去向与不得丢的验收**
- **S1** · 参数错误/合法空结果的持久诊断：首期复用既有已闭源码；对应采用与未覆盖产品验收继续，不能借局部完成代全链。
- **S2-S0** · 联系人补全剩余次数帽：首期复用既有已闭源码；对应采用与未覆盖产品验收继续，不能借局部完成代全链。
- **B0** · 不预选目标市场仍可保存资料：首期复用既有已闭源码；对应采用与未覆盖产品验收继续，不能借局部完成代全链。
- **B1** · 候选持久化、修订、反馈与冷读：首期复用既有已闭源码；对应采用与未覆盖产品验收继续，不能借局部完成代全链。
- **B2** · 受控候选生成的限定合同：首期复用既有已闭源码；对应采用与未覆盖产品验收继续，不能借局部完成代全链。
- **B-DESIGN** · 候选设计正文与实际体验分层：首期；不以纸面CLOSED或B0另一页面体验替B3页面通过
- **A01** · 无邮箱且归属正确者可补强：首期；合资格无邮箱进入既有流程，无结果仍缺失，不伪造地址
- **A02** · RISKY占位不挡补强：首期；RISKY点不能单凭非空挡finder；旧风险证据留存，VALID不受损
- **A03** · UNKNOWN复验不算可靠提升：首期；仍UNKNOWN不计新可靠；跳过有具体门因，不用邮箱非空代替
- **A04** · 替代VALID与旧INVALID分别留证：首期；新旧点各自留证，正确新VALID可用；旧INVALID不可抹掉或算新有效
- **A05** · 保护存量VALID及并发新VALID：底座仅本次写回不损坏正确既有/并发VALID，按原状态机处理真实新证据；完整质量资格、重验及读回闭环仍首期，不增加功能门。
- **A06** · 有效地址不代归属：底座仅本次请求与contact/subject/点/结果/回执绑定一致，不串人、不把甲结果用于乙；深层真实归属与角色质量仍首期，未知如实保留。
- **A07** · 公司渠道与个人邮箱分层：首期；公司渠道可保留，个人邮箱仍缺失，两类分母不混
- **A08** · wire前全部门及真实金额保护：底座；禁联/不足/未启用/无凭据均不wire，验证不超额；拒绝原因可回读
- **A09** · 重复/UNKNOWN不重wire或重扣：底座；响应丢失或wire后写账失败不据未知产生第二wire；不把未知记成功
- **A10** · 本次持久结果及正确分母：底座：本次操作/联系人/点/receipt正确对应，未知与保存恢复可权威冷读，不串写、不伪成功。 首期：完整质量读面：本轮新候选/新有效/存量/未解决/具体skip，唯一联系人与重放分母真实。
- **B01** · 不预选主推/国家/角色：首期；缺证不全组等待，不强迫先选；合法不足与未生成分开
- **B02** · 供给类别不误作制造设备买方：首期；按真实产品/能力与下游关系解释，不把供给误认成其制造设备，不伪造目标买家。
- **B03** · 同国不同应用/采购组织角色分开：首期；同国不同应用/采购组织分别解释，不把组织假设变成同一个已证个人决策者。
- **B04** · 组织假设不编个人：首期；无个人证据不编姓名邮箱/委员会或采购权
- **B05** · 冲突与出处同时保留：首期；参数冲突不取方便一侧；受影响结论有条件待证
- **B06** · 资质缺失不虚构也不全锁：首期；缺认证或服务能力列影响，只限制依赖它的组合
- **B07** · 反证和不推荐有效：首期；能力不支持或有反证允许不推荐，不硬凑正卡
- **B08** · 无外证不冒市场已验证：首期；无研究只假设/不足，不报国家排名、市场规模或有效买家
- **B09** · 反馈/版本/局部影响/不自动执行：首期；B2/B3实际生成展示和用户纠正链仍需验；确认不自动激活/run/send
- **B10** · 项目国/采购国与中标关系边界：首期；两国不合并；中标/通用职位不等已证买方或个人
- **B3-PIN** · SaaS真实code-first合同pin/薄BFF：首期复用既有已闭源码；对应采用与未覆盖产品验收继续，不能借局部完成代全链。
- **B3-CARDS** · 候选列表/详情/比较：首期；真实候选显示建议/依据/日期版本/条件反证；无结果、未生成和失败分开，不用fixture冒READY
- **B3-FEEDBACK** · 四反馈提交与冲突保输入：首期；确认/纠正/待证/否决有权才写；409保未提交内容，同key恢复，失败不伪成功
- **B3-HISTORY** · 历史只读、来源状态与实际体验：首期；旧修订只读、当前来源不可用如实示；原D按真实页面状态/语言/主题/终端适用矩阵独立体验，产品核业务
- **B4-REFERENCE** · 引用set/candidate/revision另起找买家：首期；显式另起受权动作；携真实候选与修订，过期/变更可解释拒绝；确认反馈不自动ICP/plan/run/send
- **SELLER-BASIS** · 供给、主体、版本与未知表达：首期；供给、应用、法人、规划量/现可供量分清；无凭据不伪批准；独立供给不因局部未知全停
- **SELLER-DOC-FACT** · 上传资料到可审阅事实：首期；文档主体/型号/原句定位和版本可核；候选待审、不自动APPROVED；删除/权限适用；人工首片/保底不永久取代默认辅助体验
- **SELLER-REVIEW-CONSUME** · 人工审阅/审批到实际ICP或候选输入：首期；未审不当已准入；本人有权审阅纠正；冷读可定位审批来源和输入版本；不撤Claim门洗源
- **RESEARCH-R1** · 首轮质量与跟进研究：并行；保持先补证/暂缓/排除的有效性，不从工程计数/20对20冒买方或转化 不单独挡启动。
- **RESEARCH-R2** · 第二轮供给与渠道研究：并行；保原研究的补证/暂缓/负结论，不伪造值得跟进、客户回复或成交；研究不冒模型实跑。
- **RESEARCH-ARCHIVE** · 脱敏长期研究同主题docs PR入库：并行；可追溯公开文档PR/合并/path与原专业稿对应；不上传原PDF/整页/个人点/私有身份，不代改专业原件 不单独挡启动。
- **RUN-ADOPTION** · 本系列已合源码的实际采用与安全发布：底座：安全底座及SaaS必要版本的匹配制品、必要迁移/R4与回退，正式采用读回。 首期：候选UI/B4/文档及完整质量新功能的真实采用，按各自产物版本验收，不由旧健康或制品存在推出。
- **REAL-LOOP** · 从合法卖方依据到候选反馈和独立找买家的真实使用：底座：仅有界安全真测：无重复费用/串联系人，原操作可恢复且持久结果真实。 首期：合法卖方依据、候选/反馈、显式画像与后续找买家采用、文档及质量完整产品链。
- **BUSINESS-OUTCOME** · 背调/跟进价值、响应和实际商业结果：首期持续观察；人工接受、回复、机会与订单分别有据，不把工程对象当商业结果，不要求先有订单。
- **NEW-AI-BARRIER** · 当前启动条件与历史总屏障分层：底座启动条件取代历史“全部旧承诺先闭”条件；新硬门未核闭不得实施，排期决定不等已通过。
- **EXCLUSIONS** · 任务范围、权限与非目标约束：贯穿三组；原隐私、租户隔离、单writer及准确Go边界不变，不把未获准历史建议当新scope。

研究公版正式归档、证据整理和交付台账并行推进，不再单独阻挡启动。既有脱敏稿、LF派生和精确权利条件保持冻结，正式入库仍需正常docs PR及当前检查，不把“并行”写成已公开或取消交付。

原“全部必要旧承诺关闭才启动”的总屏障仅作历史依据保留，由本节的必要底座硬门替代；旧原件、DRAFT、专业结果和缺失批准继承不回写。新的启动核闭也不自动授权新模型、渠道或收费调用。每个未交目标必须有具体缺件、原责任角色及对应验收，不以单一总完成率或一项PR通过替代。

This document owns the stable product sequence and gate definitions; it does not own a live phase verdict, branch/PR head, runtime observation or authorization state. Live gate verdicts and time-bound execution facts are maintained only in [current status](../status/current.md).

The stable product spine is `Onboarding → ICP → LeadQualifiedPackage → Opportunity → Human QGO → Feedback`; the parallel Site spine `Quote → Grant → Build → Preview` does not replace QGO.

The first Job is evidence-backed overseas importer/procurement discovery for Chinese B2B manufacturing, trade-integrated and high-ticket exporters. Human QGO is the north star. Dealer recruitment, Campaign, social/publishing, analytics, Agent auto-send, Site Publish/Domain/Inquiry/Analytics and customer Billing/Credits are outside this critical path. Billing/Credits is `DEFERRED / NOT_IMPLEMENTED`; `cap_microusd` is an execution safety envelope, not customer billing.

### Program boundaries

- Program A owns generic Execution Authority, GovernedSubject/Relation primitives, Site Quote/Grant and runtime/release foundations; it does not own Raw/Identity/Provider or Opportunity.
- Program B owns query receipt, Raw/Identity/Canonical, Provider/transport, Discovery workflow and the immutable `LeadQualifiedPackage`; it does not own generic Grant primitives, SaaS Opportunity or runtime deployment.
- Program C owns the server-side package consumer, QualificationSnapshot, Opportunity/QGO/SAO/CLOSED, SalesAcceptance, CommercialOutcome, Conversation linkage and commit-before-ACK; it does not duplicate Buyer Intelligence source-of-record state.
- [ADR-025](../adr/registry.md) and [`DEC-GPP-001`](../governance/conflict-register.md) are authoritative for the detailed seam. Task disposition, exact commits, merge/readback facts and live blockers remain in [current status](current.md) and append-only history.

### Stable G0-G7 definitions

The G0–G7 meanings below are stable. Their current verdicts are intentionally absent from this roadmap and must be read from [current status](current.md).

| Gate                     | Stable proof                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G0 — Truth & Ownership   | Binding plans, current authority, single-writer ownership, schema/migration boundaries and accepted seams are explicit.                                      |
| G1 — Product/UX/Contract | Persona, journey, source of record, state, permission, error, API/event contract and UAT criteria are reviewable.                                            |
| G2 — Source/TDD/Security | RED/GREEN evidence, relevant coverage, negative/mutation checks and independent correctness/security review are bound to the exact source.                   |
| G3 — Integration/Data    | Disposable-database/RLS proof, migration parity, Temporal replay, golden vectors and idempotent producer-consumer integration are verified.                  |
| G4 — Release Candidate   | Clean exact commits, hosted CI, reproducible artifacts/images, SBOM and a tested rollback input form one candidate.                                          |
| G5 — Runtime Observed    | Exact runtime identity, migrations, leases/readiness and fresh RuntimeEvidence prove the candidate running in the named environment.                         |
| G6 — UAT Accepted        | Critical user journeys execute successfully in three consecutive runs, including controlled restart/recovery, and the product owner accepts the user result. |
| G7 — Pilot/GA Authorized | A current Release Bundle, trusted external readback, explicit user authorization, monitoring and rollback are all present.                                   |

### Ordered delivery

1. **Phase 0 — Truth and ownership:** establish current authority, Program A/B/C ownership and accepted interfaces before any product implementation; live completion and merge/readback facts remain in [current status](../status/current.md).
2. **MVP-0:** accept Program A current-main slices, establish formal GrowthOS source/Builder/remote/CI, recover Backend runtime and expose authentic capability availability/onboarding.
3. **MVP-1 — Program C:** establish the service principal, durable package handoff with commit-before-ACK, Opportunity aggregate, Human QGO, SalesAcceptance/Outcome feedback and Conversation linkage.
4. **Pilot 3-A:** after the required gates pass, run one separately authorized internal Germany industrial-pump importer/procurement pilot using TED, GLEIF and exact official sites only; caps are 50 raw / 30 canonical / 10 enrich / 5 review / 3 packages, zero model / paid / send, and 0–3 honest results.
5. **Site 3-B:** complete the parallel SaaS `Session → Quote → Grant → Build → Preview` vertical; Publish, Domain, Inquiry, Analytics and Design Editor remain later scope.
6. **MVP-2:** add Campaign minimum state and one approved email provider only after MVP-0/MVP-1 and separate OAuth/send authorization.
7. **Later:** Site Publish, Buyer R2, Agent Operation Contract, a second mail provider, social/WhatsApp, attribution and multi-industry/agency.

### Concurrency and authorization boundaries

- Pilot 3-A remains one internal Workspace. Restricted providers, Patents, SAM, email guessing and named-person collection are disabled. Each accepted package reaches a unique Opportunity; at least one candidate receives a human QGO judgment (confirmation or structured rejection), with no unauthorized action, duplicate physical call or lost evidence. An honest zero-result run does not itself satisfy the human-review exit.
- MVP-1 requires a local controlled fixture to complete `Package → Opportunity → human QGO decision → feedback`, replay/concurrency ten times without duplicates, and no ACK before confirmed local commit. Real Provider or email dispatch is not a dependency for this local exit.
- Site 3-B must preserve the old Preview after a failed new Build, and correctly expose unknown result, cancellation and recovery. Current-release identity and RuntimeEvidence remain required; unsigned-dev cannot substitute for the product path.
- UAT requires three consecutive critical-journey passes including a controlled restart, no remaining S1/S2, an owner/deadline for each S3, and product-owner acceptance of the user result.

- No more than two implementation programs may run in parallel. Program C contract/spec may proceed after its prerequisites are accepted; cross-repository integration waits for accepted producer-consumer interfaces, while the Site vertical may parallel Program B.
- Discovery implementation, runtime mutation, Pilot and release promotion remain gated by their corresponding G0–G7 evidence.
- Push, PR mutation, merge, deployment/restart, retained migration, provider/model/paid call, OAuth/email send and credential changes each require separate exact authorization.
- Model-candidate visibility is governed by the generated [candidate baseline](../site-builder/model-candidate-baseline.md), machine ID `site-builder-model-candidate-baseline/2026-08-07-v3`; it does not authorize route adoption, dispatch or deployment.
- A passing local or hosted test is not runtime evidence; RuntimeEvidence is not a Release Bundle; neither implies UAT, Pilot or GA authorization.
- **引擎合同 pin 节拍（2026-11-12 审计）**：每次引擎发车若 OpenAPI 或集成事件集变化，gain-saas 的 `packages/engine-client` pin 必须作为独立合同 PR 更新（重跑 `pnpm gen:engine`、审阅 OpenAPI diff、记录引擎 commit/image）；不得把 pin 更新藏进普通功能 PR。
- **迁移只前进（2026-11-12 审计）**：Prisma 无 down migration；回退 = 备份恢复 + 前向修复。破坏性变更按 expand → contract 两步，不写不可逆的一次性迁移。
- **Site Builder 冻结期间的工程约束（2026-11-12 审计）**：不新增 Site Builder 生产代码、不扩大其测试/CI 预算，G9 文件与复杂度基线只降不升；`docs/site-builder/` 与 `docs/design/` 仅作冻结线文档，eval 子系统不扩日常 CI；解除冻结、恢复 Publish/Domain 或重新投入模型评测须 PRD4-D1 单独拍板。本约束不改变现有 Site Builder 运行路径或历史证据。

### Final service acceptance

The original Buyer Intelligence final-service “封版” acceptance remains a capability target, not a current PASS: (1) Company/Offering/ICP produces a controlled Candidate Batch; (2) company/contact facts carry Canonical IDs, source, Evidence, rights, freshness, verification, cost and unknowns; (3) candidates expose decomposed scores and reason codes; (4) accept/reject/correct feedback reaches evaluation without cross-tenant leakage; (5) cancellation/retry/Partial/budget stop/provider degradation/fair scanning are supported; (6) OpenAPI/events/progress, RLS, deletion, audit, tests and SLO are verified; (7) real-company examples pass E2E/UAT; (8) the output contract is genuinely consumed downstream, not merely persisted. Docling/Langfuse are not mandatory gates. Phasing follows the current roadmap: Buyer R2 fair-cursor/Golden Set expansion stays later and is not made a new prerequisite for the bounded Pilot. The former schedule and dated completion annotations remain recoverable from Git commit `8eefba1cff15f2bbe4154451cac958a072803ab5`.

## Historical supersession index

- **HISTORICAL / SUPERSEDED — 2026-07 R0-R3 Campaign/email-first sequence:** the dated proposal ordered Buyer Intelligence closeout → Campaign control plane → controlled email → Inbox/QGO → Outcome/attribution. [PDR-004](../adr/registry.md) supersedes that scheduling order: MVP-1 establishes durable Opportunity and human QGO first; MVP-2 introduces one approved email provider only after MVP-0/MVP-1 and separate OAuth/send authorization.
- Dated Site Builder/model/provider execution records, exact commits, manifests, wire/cost observations and former owner/next-step statements are not duplicated in this CURRENT roadmap. Their provenance remains recoverable through Git history, [changelog](../roadmap/changelog.md) and the [evidence index](../evidence/README.md); their live interpretation always comes from [current status](current.md).
