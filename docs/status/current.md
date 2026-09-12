# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[ADR registry](../adr/registry.md)、[发布路线](../roadmap/release-plan.md)、下列 exact Git/GitHub 与 development-runtime 只读观察
> 最后核验：2026-09-12T22:02:14+08:00（本轮刷新 Production Parity 源码、发布与 runtime；其他业务线保留各自证据边界）

## 当前结论

`SOURCE_INTEGRATED_ALPHA / CROSS_REPO_PRODUCT_ASSEMBLY / USER_JOURNEY_NOT_VALIDATED / COMMERCIAL_LOOP_NOT_CLOSED / PRODUCTION_READINESS_BLOCKED`

源码、局部测试、主线 CI、部署、运行证据和用户验收是不同的事实。Browser/ACK/schema 修复、平台 Temporal 基础设施和执行规则更新已合入，不代表用户已经能够完成 `LeadQualifiedPackage → Opportunity → Human QGO → Feedback`。当前仍没有可接纳的完整 MVP 用户闭环。

Program C 保持用户已批准的完整 C1–C5/QGO 范围；company-first 是未选择的可选缩范围，不构成原范围的执行阻塞。Billing/Credits 保持 `DEFERRED / NOT_IMPLEMENTED`；`cap_microusd` 是平台执行安全包络，不是客户余额或模型购买次数。

当前非运行时模型候选合同仍为 `site-builder-model-candidate-baseline/2026-08-07-v3`，不等于 active route、质量证明或真实 dispatch 授权。

2026-09-12 增量核验：#497、#502、#504、#505、#506、#507、#508、#509、#510、#513、#516、#517 与 #498 已合入。浏览器 ESRCH 修复的采用基线为 `b6be49020b28dccf2f67413667c396a893b9ce94`；对应 exact OCI 已采用，但整体仍为 `HOLD_CUTOVER / NOT_READY`，30分钟浏览器观察已通过，整体验收仍未完成。#511、旧 #479 保留为已关闭 provenance；#515 与 #407 仍为 Draft/HOLD。

[Native Temporal disposable proof](../evidence/temporal-platform-native-disposable-closeout-20260911.md) 只证明绑定候选的隔离矩阵。它不是 retained native 服务、GrowthOS producer、机器 service JWT 交付、跨仓 UAT 或 Release Bundle 的完成证明。本轮只推进真实已验证的部分，不重复设计客户 Billing/Credits。

## 1. 源码与正在进行的工作

以下记录是时间绑定快照，不预测本文后续提交或其他任务未来结果。

| Subject              | Exact observed state                                                                                                                                                                                                                   | 证据边界                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Backend source | 浏览器修复已由 #517 合入，采用基线 `b6be49020b28dccf2f67413667c396a893b9ce94`；根 main 通过受控同步跟随，未跟踪 `.playwright-cli/` 保留 | source、运行镜像和其他候选提交分别绑定，不把根 checkout 当 managed runtime |
| 已完成修复           | #448 安全基线、#449 结算源码已合入；#452 浏览器接线合入 `490bed749823248a4dad9508ef0b86dd36454cc7`；#453 ACK 回读合入 `e09ff17f1f2b417ee99c2d3b3ea34e34ed25277a`；#454 删除事件 schema 合入 `63b4af94b662d7e2b6a40823a1872daf0fc9b993` | 不再列为未开发或待合入；部署、运行采用另行核验                                                               |
| 主线 CI | #517 当前合并前 head `0a7d2259466c144291f1e6abede51360c02eb1ac` 的 [required CI](https://github.com/mlhjyx/global-backend/actions/runs/34694058234) 与独立 delta review 通过；包含 API 全量测试、native Go、镜像200次探针及 Renderer visual regression；[exact-main publication](https://github.com/mlhjyx/global-backend/actions/runs/34695996341) 通过 | 对应提交/制品的检查，不等于整体 runtime 或用户 UAT |
| Browser readiness | `175ae53…` 镜像采用后 browser=`ok`，30分钟60次采样已通过；旧 `137f881…`/`4246f660…` 的短暂恢复不能证明稳定。实际修复是 Linux `/proc` 消失竞态的 ESRCH 处理 | [因果证据](../evidence/browser-readiness-proc-exit-race-20260912.md) 与 [运行观察](../evidence/browser-readiness-runtime-adoption-20260912.md) 分开；只确认该镜像的有界浏览器观察，不外推整体验收 |
| Backend ACK readback | `EventsController_ackStatus_v1` 已进入 code-first OpenAPI；权限为 `acquisition:event:ack`，固定 saas sink、Workspace RLS、closed response、no-store                                                                                    | 只回读 ACK 状态；不是 SaaS consumer，也未授予浏览器后台权限                                                  |
| DeletionCompleted    | v1 schema 已兼容 producer 的可选非负整数 `patent_cache_erased`，历史缺字段仍合法                                                                                                                                                       | 没有增加删除执行或 Patents 调用；不是跨仓 DSR 完成证明                                                       |
| GrowthOS source | authority `/global/frontend/growthos-source` 为 `51d7420373e31ba5c2a696513d8d6b5e77ed3fe0`；本任务隔离 writer 中0099/0100历史候选保留，0101 codec和0102专用签名/JWKS已完成本地验证与patch登记，未作为正式新制品采用 | 0102相关35 tests、四新类96.55% lines/90.91% branches；service JWT交付、真实producer/consumer与全产品接纳未完成 |
| Program B source     | `pr407-organization-identity-caller-cutover-v2` clean `944ce580ae91f5bb2238e63f94726b5789dd63f5`                                                                                                                                       | 旧 `f3e5bc19… C6/H5` 不自动迁移到新版本；本次没有核得新版本全链路接纳/Pilot 完成证据                         |
| Program C spec       | 独占 `program-c-c1-contract-20260904` 本地提交 `4b116f10bc3d7efca6f15611f900923f2ea73d1f`；同一 C1 文档的分页/隐私/digest finding 已独立复审关闭 C0/H0/M0                                                                              | 文档未进入 main；GrowthOS 文件所有权交接与源码实施仍未完成，不再把“合同尚未复审”作为阻塞                     |
| 平台基础设施 | 已合入的 native reader、Worker admission、持久预算与浏览器修复继续保留；native retained compose仍未采用自定义server制品，专用发布/overlay正在隔离施工；现有混合Worker不能只改namespace便迁往平台服务 | 不替换 legacy SQLite/namespace，不用配置布尔值或 disposable结果冒充权限/运行证明 |
| 运行时采用 | API/Worker/Relay均回读 image `sha256:175ae53c6500456f1121d006fd4add694231d15e20d26fbd77ef795d3f9f90d5`、source `b6be49020b28dccf2f67413667c396a893b9ce94`、artifact `sha256:74ac61098764370c00562152dc83a49876a7d9b363d6415fd82a72c510183c56`；migration `20260908130000_platform_egress_budget_policy_v2`，完整manifest/SBOM等见[采用观察](../evidence/browser-readiness-runtime-adoption-20260912.md) | API/Relay过程lease READY、Worker STARTING；匹配身份不等于可接新工作 |
| Wikidata country successor | #498 已合入，merge `b07090011de652385aa53b17f6fd73c0e2e466d5`；country绑定修复不再列为在途候选 | 只闭环其 country-binding 子项，不关闭 #407 综合任务或 Program B 接纳 |
| 安全治理候选 | #509 trusted verifier、#506 依赖修复、#510 post-remediation baseline 已合入；主线 advisory=`FRESH`、current=0，#511 关闭/保留为 superseded provenance | 不把安全收口当作平台 authority、RuntimeEvidence、Release Bundle 或用户验收 |
| 文档候选 | 本页以#517实际采用与持续观察修正旧browser稳定结论；#515本地新增真实Java签名golden vectors，receiver候选仍未接完整producer | [本地验签及独立审查记录](../evidence/platform-capability-java-local-20260912.md)：111/111，不等于跨仓hosted或runtime整体通过 |

### Program 所有权与产品缺口

| Program                          | 状态                                           | 所有权与当前缺口                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — authority/runtime primitives | PARTIAL                                        | 通用 Authority、GovernedSubject/Relation、Site Quote/Grant、runtime/release；不拥有 Raw/Identity/Provider 或 Opportunity。历史 mega branch 仍为 NON_DEPLOYABLE / PROVENANCE_ONLY；当前平台候选及运行采用分别接纳 |
| B — Buyer Intelligence discovery | CURRENT_CANDIDATE_ACCEPTANCE_NOT_VERIFIED      | QueryReceipt、Raw/Identity/Canonical、Provider/transport、Discovery、LeadQualifiedPackage；不拥有 SaaS Opportunity 或 runtime deploy。已接纳 main slices 与当前候选分开，完成当前版本验收后再进入受控 Pilot      |
| C — SaaS handoff/commercial loop | SPEC_REVIEWED / IMPLEMENTATION_HANDOFF_PENDING | 服务端 consumer、receipt、QualificationSnapshot、Opportunity、QGO/SAO/CLOSED、SalesAcceptance、CommercialOutcome、Conversation linkage；完整原范围保持有效                                                       |

A/B ownership seam 已关闭，固定边界为 `ExecutionAuthority → ToolOperationSubject → B-owned QueryReceipt → B-owned RawSourceRecord UUID → B-owned IdentityLink/CanonicalCompany UUID → A-owned append governed child/relation primitive → Domain ACK`。历史来源见 ADR-025、冲突注册表与原计划；这不自动关闭所有 Program 的来源、迁移、运行和验收门。

Program C 的 durable server consumer、handoff receipt、QualificationSnapshot、Opportunity aggregate、commit-before-ACK、ACK_PENDING 与 QGO/SAO/Outcome 尚未完成产品接纳；browser ACK 和 Conversation shell 不能替代 Opportunity。C1-A 的本地 parser/client 不依赖真实 Provider 或邮件，但必须先取得现有 GrowthOS writer 的明确文件交接；C1-B 的持久化、KMS/DSR/suppression 与迁移有独立依赖。

## 2. 全局阶段门

| Gate                              | 当前裁决                        | 仍需证明                                                                                                                                 |
| --------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| G0 — Truth & Ownership            | PARTIAL                         | 已关闭 A/B 重叠不代表全部 owner 已交接；Program C writer/migration/patch manifest 交接未完成；其他 Program 的新候选按当前 owner 证据接纳 |
| G1 — Product/UX/Contract          | PARTIAL                         | 完整 C1 合同已复审；跨仓可执行隐私、不可变 Evidence、UI 和 UAT 合同仍有缺口                                                              |
| G2 — Source/TDD/Security          | PARTIAL / MERGED_FIXES_VERIFIED | #452/#453/#454 源码及其必需 PR CI 已通过；不能把这一批成功推广到所有产品模块                                                             |
| G3 — Integration/Data             | PARTIAL / PRODUCT_E2E_NOT_RUN   | 本地组合测试和一次性数据库测试通过；当前用户旅程、跨仓消费、重启、DSR/隐私闭环未验收                                                     |
| G4 — Release Candidate            | DEVELOPMENT_CANDIDATE_ONLY      | 当前源码尚需匹配的跨仓 images/SBOM/migrations/rollback 与可信外部 readback                                                               |
| G5-Site — Runtime Observed        | HISTORICAL_ONLY                 | 当前有效 RuntimeEvidence=0；#517已有development镜像采用观察，30分钟浏览器观察通过，但current RuntimeEvidence/UAT仍未完成；旧Site记录已到期，不能用于G5/G7晋级 |
| G5-Acquisition — Runtime Observed | NOT_VERIFIED                    | 当前有效获客 RuntimeEvidence=0；平台权限、Discovery 到 Opportunity 的当前运行链未证明                                                    |
| G6 — UAT Accepted                 | NOT_RUN                         | 关键用户旅程连续三次、其中一次受控重启，以及产品 Owner 验收                                                                              |
| G7 — Pilot/GA Authorized          | NOT_AUTHORIZED                  | 有效跨仓 Release Bundle、运行证据、独立 readback 和精确 Pilot/GA 授权                                                                    |

## 3. Development runtime 观察

本次已采用 #517 的 exact OCI 修复，来源与全部制品摘要见上表及[运行观察](../evidence/browser-readiness-runtime-adoption-20260912.md)。切换前没有 queued/running Site BuildRun；先拉取并离线校验镜像，再停止并启动 API/Worker。数据库只读回读为135条成功、2条历史rolled-back、0条未完成且未回滚；本次没有执行迁移或手工业务数据更新。30分钟观察60次采样通过；整体服务与用户旅程仍待验收。

| 观察              | 当前可确认的事实                                                                                                         | 不得外推                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 运行版本 | `/api/v1/health/build`返回attested=true；API/Worker/Relay的source、image、artifact及migration逐字匹配上表 | running和身份匹配不证明readiness、消费、模型或用户旅程成功 |
| Browser 历史事故 | 保留2026-09-05容量事故及#513/#516的历史短暂恢复；之后捕获成功退出Chromium后的proc stat ESRCH，#517补齐该竞态并保留EACCES/EIO/live-group拒绝语义 | 不再用重启后的5次短观察作为已稳定修复结论 |
| Listener exposure | 本次 `ss` 仍见 `0.0.0.0:3001`、`[::]:3001` 和 legacy Java `*:8080`                                                       | 未执行端口收敛或旧服务退役                                                               |
| Readiness | `/api/v1/health/ready`=503；database/migration/Temporal连接/storage/Redis/Gateway/renderer/browser/API/Relay当前ok；identity与Budget/Execution JWKS验证失败，平台acq/intent/sanctions当前首先报`QUOTE_UNAVAILABLE`，Worker=`MATCHING_WORKER_NOT_READY` | GrowthOS仍为旧demo运行版本、JWKS404；连接ok不证明native身份权限或平台proof，不能接新BuildRun |
| Historical Spend  | 旧 UNKNOWN/unknown 及 unresolved/expired 记录按原证据保留                                                                | 不通过重发制造结果，也不由源修改自动改写历史费用                                         |

历史费用记录保持 UNKNOWN/unknown：attempts 1–5 为 UNRESOLVED，attempt 6 为 EXPIRED，reservation/conservative charge 均为 `800000`；EXPIRED 不产生有效输出或精确费用，继续不重发。完整脱敏字段见 [2026-09-04 platform-writer successor runtime readback](../evidence/site-builder/production-parity-platform-writer-runtime-readback-20260904.json)；20260901 predecessor 保持 historical provenance。GrowthOS 2026-09-01 historical provenance 也不能代替当前 authority source。

旧权限缺失码与健康响应仅对其原观察时间有效；当前 runtime acceptance 仍须 fresh readback，不能由本页或静态 CI 代签。

## 4. 验证、证据与发布

- 已合入组合源码 `63b4af94…` 的 tree 为 `8e7ecd528d4190bfbfb17d93cce054d1923438cc`，与隔离组合逐字节一致。11 个测试文件 134/134、一次性 PostgreSQL16/RLS 4/4、API/contracts build、OpenAPI 零漂移、governance 147/147 通过。测试容器只清理自己的临时数据。
- 浏览器本地范围的行/分支覆盖率为 94.06%/86.36%；独立五文件审查 C0/H0/M0。额外全目录测试源码 tsc 未通过，未修改测试中的类型/声明问题没有被此局部成功掩盖。
- 本次治理只读验证报告 RuntimeEvidence `6 total / 0 current / 6 historical`，Release Bundles=3。前两条 Site 证据到期点为 `2026-09-05T03:49:25.000Z`；到期不删除历史，但不能用于 G5/G7 晋级。
- 3 个 Release Bundles 仍是 development `CANDIDATE` / `EXTERNAL_UNVERIFIED`，不是可信发布结果。具体字段以机器文件及 verifier 为准；路径存在或结构通过不是 runtime proof。
- PR #461 的 privilege-hardening successor 已应用并 read back：`fence_platform_schedule_v1(text,text)` 对 `PUBLIC`、`app_user`、`runtime_api`、`runtime_worker`、`runtime_outbox_relay` 为无 EXECUTE，仅 dedicated `execution_budget_platform_writer` 可执行；这不等于平台 Temporal proof 或跨系统撤销链已就绪。
- #448/#506/#509/#510的历史安全基线保留；#517的exact-source检查与镜像发布已通过，新增持续观察不解除GrowthOS/platform/Worker/UAT/Pilot门。

## 5. 下一顺序与授权边界

商业主路径是 `Onboarding → ICP → LeadQualifiedPackage → Opportunity → Human QGO → Feedback`；并行信任资产路径是 `Quote → Grant → Build → Preview`。

1. 运行主线：已完成#517持续浏览器观察；继续native制品发布/overlay、GrowthOS专用service JWT交付、producer事实与独立撤销consumer，随后才做完整运行切换与fresh RuntimeEvidence。新发现的撤销恢复安全差额须明确确认，不以绕过或伪造ACK收口。
2. 产品主线：GrowthOS 单 writer 文件交接 → C1-A → C1-B/C1-C → C2 Opportunity → C3 Human QGO → C4 Outcome/C5 Conversation；不另起 R7 文档循环。
3. 文档：本页维护当前事实，roadmap 保持稳定顺序；历史入 changelog/evidence。#451 按已批准的 GitHub 队列完成最终修订、验证、独立审查与远端收口。
4. 验收：当前跨仓 Release Bundle、关键 UAT 三次与重启恢复通过后，才评估德国工业泵零模型/零付费/零发送 Pilot 的精确授权卡。

既有明确授权在相同动作、目标、范围和成本/数据边界内继续有效，普通本地开发/验证不重复请示。#452/#453/#454 更新与合入授权已执行完成，不自动授权部署、保留数据库迁移、缓存删除、端口变更、真实 Provider/模型调用、OAuth/邮件或 Pilot。当前工作保留单 writer、费用、权限、RLS 与发布门；未知结果不被静态检查升级。
