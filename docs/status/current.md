# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[ADR registry](../adr/registry.md)、[发布路线](../roadmap/release-plan.md)，以及本页逐项注明的 Git/GitHub 回读、机器验证与 owner 交付
> 最后核验：2026-09-20T08:51:58.634Z（源码、队列与 owner 交付回读；历史 runtime 不重新标记为当前）

## 当前结论

`SOURCE_INTEGRATED_ALPHA / CROSS_REPO_PRODUCT_ASSEMBLY / USER_JOURNEY_NOT_VALIDATED / COMMERCIAL_LOOP_NOT_CLOSED / PRODUCTION_READINESS_BLOCKED`

源码、局部与联合测试、hosted CI、合入、运行采用、发布和用户验收分别判定。当前没有证据证明完整 `Onboarding → ICP → LeadQualifiedPackage → Opportunity → Human QGO → Feedback` 用户旅程已经接纳，也没有 Pilot/GA 授权。

Program C 保持已批准的完整 C1–C5/QGO 范围；company-first 是未选择的可选缩范围，不是原范围的执行阻塞。Billing/Credits 保持 `DEFERRED / NOT_IMPLEMENTED`，`cap_microusd` 是平台执行安全包络，不是客户余额或模型购买次数。并行 Site 验收路径仍是 `Quote → Grant → Build → Preview`，不替代商业链及 Human QGO；范围以[发布路线](../roadmap/release-plan.md)为准。

当前非运行时模型候选合同仍为 `site-builder-model-candidate-baseline/2026-08-07-v3`，详见[生成页](../site-builder/model-candidate-baseline.md)；它不等于 active route、质量证明或真实 dispatch 授权。本轮 SDK 依赖升级没有改变这一边界。

本轮依赖队列状态见最终收口证据。历史 #407 已关闭，原始分支与逐项语义处置继续保留；关闭不代表整个历史综合候选已被替代或取得准入。#515 与 #538 仍按各自真实外部门保持 Draft/HOLD。

## 1. 源码与候选

以下是带观察时间的快照，不预测本文之后的提交、其他 writer 的结果或未来部署。

Owner 行中的局部测试和独立 review 统计来自其2026-09-20交付回执；本任务另行回读对应 Git head，但没有重跑其他 owner 的测试或将其结果升级为运行接纳。具体消息身份和回读命令保留于本轮收口证据。

| Subject | 已核实的状态 | 尚不能据此判定完成的门 |
| --- | --- | --- |
| Backend source | 本轮整合的上一 main 基线为 `cca0d0e546ab649fcdfd22132c96fa44c4b4c1cd`；当前源码包含五组依赖目标。根 checkout 是否跟随由受控同步回执独立证明 | main checkout 不等于 managed runtime；当前制品、迁移与 API/Worker/Relay 身份须独立绑定 |
| 依赖维护 | #539 Redocly、#540 Langfuse、#541 S3、#543 AI SDK 已逐项合入；最后工具链与本次状态修订属于同一候选，最终 head/CI/merge 从原 #533 的 successor 收口记录回读，见[本轮证据](../evidence/dependency-queue-closeout-20260920.md) | 本地与 hosted 成功不证明 retained 采用；JS production audit 不覆盖所有开发依赖或 Go 告警 |
| 已采用的修复 | Browser/ACK/DeletionCompleted、native Temporal 基础设施、覆盖率与受控 root-sync 修复已有独立已合入来源；#494/#495 实际分别合入，#497 完成后续 native harness 收口；Wikidata country binding 由 #498 合入 | #494/#495 的实际历史不是最初计划的“关闭为 superseded”；country 子项不是完整获客产品；ACK readback 不是 SaaS durable consumer；native disposable 不是保留环境健康 |
| #407 历史综合候选 | CLOSED，原始 head `70885cdb4196ae86db762ae96ca73f4cfa51f89d` 保留，successor 按独立准入条件处理 | 不恢复历史 Identity、迁移、provider、Relay 或 HTTP hook；不把关闭解释为全量语义接纳 |
| #538 身份/质量 | 远端 Draft `576fabeb810e54ae043d4c3a45ed09873c6fc07a`；最新已收受并回读的本地交付 `2f5d4313849bc4c2332be64ec2f428e123a3337a` 已在方向确认后实现 native HTTPS reader，owner 报告54项相关测试通过 | v3 request/receipt/descriptor及消费者迁移、完整 transport/source/tool/CA/DNS 闭包、controller/FD/journal/可信receipt接线、精确外部物化/凭据与独立readback仍缺；旧v2未切换，Task0A/0B没有ADMITTED |
| R4 native 与 Backend | 本地 `41a59788d72d44b728ceff98dbf88bb1049cc93f` 已接入cca0d0e5；split-worker、namespace lease、capability正式装配已有本地实现。owner 报告当前main依赖下API/Worker编译、22files/257相关测试、gov220，以及native真实矩阵、PG lease7项和独立review通过 | 当前head hosted CI、最终制品、retained migrations/principals/TLS/storage/lease/readiness、RuntimeEvidence和三轮UAT仍未完成；不把此前不同源码的全API结果合并为当前fresh全量PASS |
| GrowthOS 平台 authority | 已确认产品patch108/99paths基线 `f9699f0f42a050a69294bb4ae679de520ba50e91`，随后构建资源修复head `6125b6da8da974dde8ff8399f46940cf73b2b511`。owner 报告真实producer/consumer lease/recovery/clock/ACK等本地接线、51整合和Bootstrap hermetic591项通过 | 最新JAR/3OCI仍待重新构建；该local authority无remote，hosted CI/私有仓库授权待解决；源码/本地矩阵不等于保留环境采用 |
| #515 capability receiver | 远端旧Draft `6a3126b7670661a64c95676574320a3f6992ee66`保留；其后续receiver及真实producer合同已进入R4本地装配范围 | 待R4最终候选的hosted/独立接纳与实际合入后再处置旧PR；专用identity/JWKS、nonce/digest、freshness/backlog与Temporal事实仍须在被采用制品和环境中共同成立 |
| #542 安全基线刷新 | 迁移任务已合入为 `cca0d0e546ab649fcdfd22132c96fa44c4b4c1cd` 并明确释放依赖窗口；本工具链候选又以精确源码 `728fbf8eaab86f24182cffe1cccdfb5fbaa7e16c` 重审，872个生产依赖、0 advisories，freshness从HOLD转为FRESH | 本地精确审计不等于全部开发依赖或Go告警清零；零漏洞政策、原有效期和验证器保持不变，源码接纳与后续运行发布仍分开 |
| Program C | 最新 owner 交付 `a6debdf4271920b5658e66e05e481c5e922a1adb` 已增加 C4 durable action-intent 与前端挂载，状态为 `LOCAL_CANDIDATE_VERIFIED / NOT_ADOPTED` | 可信 QGO evidence 仍 HOLD；新增 human action-intent 表尚未被既有 DSR 覆盖，保持 `HOLD_PRIVACY`、不可激活真实数据。C1 restricted envelope、C5 facade/会话接线、shared main、retained upgrade/release/runtime/真实全栈 UAT 仍未接纳 |

Program C 的新交付入口为其 worktree 中 `handoffs/program-c/successors/full-schema-verification.json`、`real-session-http.verification.json` 和 `lifecycle-http.verification.json`。完整空库初始化通过生产 Flyway 工厂执行46项迁移、validate及二次 migrate 0；它不证明 retained upgrade。真实会话判断 HTTP 交付由 owner 报告13项测试通过，最新生命周期交付报告22项测试通过；本任务另行核对对应主报告 hash 与零 failure/error/skip，但没有将局部数量相加为全项目 fresh PASS。

真实 QGO 仍因 `EvidenceUnavailable` 返回503且 revision 不变；SAO/CLOSED 路径使用明确的 owner 合成 QGO 前置验证，不能解释为真实 QGO 或商业闭环。此前257项反馈/轮询测试及前端/合成HTTP场景保留为各自源码的局部历史证明，不替代连接真实服务器的浏览器 UAT。Snapshot Key Authority 继续用户明确延期，不用固定 profile key 替代 C1 保护。

后续 C4 交付入口为该 worktree 的 `handoffs/program-c/successors/c4-action-intent.md` 和 `c4-frontend-verification.md`。owner 报告前端55files/428tests及真实 Chromium+合成HTTP恢复场景通过；后端70项测试有实际runner成功与独立报告回读，但原外层wrapper因SIGTERM不能称PASS。新增race helper后的受影响HTTP/DB复验取得完整wrapper PASS，涵盖47项fresh迁移、合成46→47、并发及恢复；这些均不证明retained升级、真实QGO或全栈UAT。Outcome outbox事实不代表下游Learning consumer完成；`HOLD_PRIVACY`也不是重新启动已延期Key Authority的授权。

### Program 所有权

| Program | 当前层级 | 边界 |
| --- | --- | --- |
| A — authority/runtime primitives | PARTIAL | 通用 Authority、GovernedSubject/Relation、Site Quote/Grant、runtime/release；不拥有 Raw/Identity/Provider 或 Opportunity |
| B — Buyer Intelligence discovery | CURRENT_CANDIDATE_ACCEPTANCE_NOT_VERIFIED | QueryReceipt、Raw/Identity/Canonical、Provider/transport、Discovery、LeadQualifiedPackage；不拥有 SaaS Opportunity 或 runtime deploy |
| C — SaaS handoff/commercial loop | LOCAL_SOURCE_AND_INTEGRATION / PRODUCT_ACCEPTANCE_PENDING | consumer、receipt、QualificationSnapshot、Opportunity、QGO/SAO、Outcome、Conversation linkage；局部实现和联合测试不等于最终产品接纳 |

A/B ownership seam 维持既有 ADR 的固定边界：`ExecutionAuthority → ToolOperationSubject → B-owned QueryReceipt → RawSourceRecord → IdentityLink/CanonicalCompany → A-owned append primitive → Domain ACK`。该边界不自动关闭来源、迁移、运行与验收门。

## 2. 全局阶段门

| Gate | 当前裁决 | 所缺证据 |
| --- | --- | --- |
| G0 — Truth & Ownership | PARTIAL | 当前 writer 与尚未释放的历史 owner 分开；剩余 path/migration/patch 权威交付 |
| G1 — Product/UX/Contract | PARTIAL | 跨仓可执行隐私、不可变 Evidence、UI 和用户旅程合同接纳 |
| G2 — Source/TDD/Security | PARTIAL / MERGED_FIXES_VERIFIED | #538/R4/Program C 的最终当前候选与各自安全准入；已有修复不推广到所有模块 |
| G3 — Integration/Data | PARTIAL / PRODUCT_E2E_NOT_RUN | 完整跨仓消费、重启、UNKNOWN 与隐私删除用户闭环 |
| G4 — Release Candidate | DEVELOPMENT_CANDIDATE_ONLY | 同一精确 source/image/artifact/migration/identity 与可信外部 provenance readback |
| G5-Site — Runtime Observed | HISTORICAL_ONLY | 当前 PASS RuntimeEvidence；历史 Browser/镜像观察不可晋级 |
| G5-Acquisition — Runtime Observed | NOT_VERIFIED | 平台权限、Discovery 到 Opportunity 的当前完整运行证据 |
| G6 — UAT Accepted | NOT_RUN | 商业链与并行 Site `Quote → Grant → Build → Preview` 的完整验收；关键旅程连续三次、至少一次受控重启、失败恢复/UNKNOWN/隐私删除及产品 owner 验收 |
| G7 — Pilot/GA Authorized | NOT_AUTHORIZED | 有效跨仓 Release Bundle、运行证据、独立 readback 和单独的产品授权 |

## 3. 运行与发布证据

本轮不宣称新的保留环境部署、迁移、凭据变更或服务重启。2026-09-12 的 Browser 30 分钟观察、API/Worker/Relay image `sha256:175ae53c6500456f1121d006fd4add694231d15e20d26fbd77ef795d3f9f90d5`、source `b6be49020b28dccf2f67413667c396a893b9ce94` 均为其原观察时间的历史事实，详见[采用观察](../evidence/browser-readiness-runtime-adoption-20260912.md)和[ESRCH 因果证据](../evidence/browser-readiness-proc-exit-race-20260912.md)。本页不把旧 health/readiness、端口或 `.playwright-cli/` 观察重新称为当前状态。

GrowthOS 历史 managed runtime 恢复见[原恢复记录](../evidence/growthos-managed-runtime-restoration-20260912.md)；native Temporal 发布与制品 inspect 见[发布证据](../evidence/temporal-native-publication-20260913.md)。它们不能替代最新 R4/producer/receiver/Worker 的保留环境接纳。

本轮相同证据文件集合的治理验证为 RuntimeEvidence `6 total / 0 current / 6 historical`、Release Bundle 3 个，均为 development `CANDIDATE / EXTERNAL_UNVERIFIED`。没有生成新的 RuntimeEvidence，也没有通过可信 external provenance readback 晋级。

历史费用记录保持 UNKNOWN/unknown：attempts 1–5 为 UNRESOLVED，attempt 6 为 EXPIRED，reservation/conservative charge 均为 `800000`；EXPIRED 不产生有效输出或精确费用，继续不重发。完整脱敏字段见 [2026-09-04 platform-writer successor runtime readback](../evidence/site-builder/production-parity-platform-writer-runtime-readback-20260904.json)；20260901 predecessor 保持 historical provenance。GrowthOS 2026-09-01 historical provenance 也不能代替当前 authority source。

源码修复、disposable 测试或当前文档不能改写历史物理调用和 ACK 事实。

## 4. PR、分支与工作区处置

#407、#479、#514、#527/#529 以及被本批 successor 替代的原 PR 保留 provenance；关闭状态不授权删除历史分支。216 个结构退役候选已完成 committed history 的独立恢复回读，其中195个仍有 ignored 材料、21个未见 ignored 条目，均未取得 owner release 或删除授权。全量本地分支、远端分支与 worktree 的精确分类在批末回执 `/var/tmp/backend-dependency-queue-20260920/final-all-dispositions.json` 中记录，不把未检查的材料或独有历史当作已清理。

已合入或关闭不自动授权删除分支/worktree。历史综合候选、独有提交、脏文件、ignored/untracked 材料和锁定旧路径继续保留。当前主线包含的提交可恢复，不代表 owner 已释放其工作区或其 ignored 材料已归档。

## 4.1 开发宿主迁移（2026-09-20 增补、2026-09-21 更新，边界限于本节）

> 本节只记录宿主迁移这一件事，**不刷新**本页 `最后核验` 时间戳，也不改动 §2 阶段门、§3 runtime 观察或 §4 证据裁决 —— 那些仍绑定其各自的原核验时刻。

开发宿主已从旧 Ubuntu 机器迁至 **WSL2（Ubuntu 26.04）**。完整缺口盘点与证据见本机只读归档 `/global/_archive/migration-20260920/audit/MIGRATION-TRIAGE-20260920.md`、同目录 `legacy-worktree-audit-20260920.tsv`（420 个 worktree 逐项 git 状态）与 `BRANCH-TRIAGE-20260921.md`（旧机分支归属）。

| 观察 | 当前可确认的事实 | 不得外推 |
| --- | --- | --- |
| 源码完整性 | 旧机 181 个"领先 origin/main"的 head 已全部存在于新宿主；交叉核对已合并 PR 后，其中 77 个实为 squash 合入、104 个未进主线；1 个从未推送的分支（6 commits）已直取并推送为 `codex/pr407-identity-test-closeout-20260913`（#538）；全量 git bundle 另存本机归档 | 取回不等于已裁决或已合入；104 个未进主线分支按 `BRANCH-TRIAGE-20260921.md` 默认归档、零操作，不代表放弃或采纳 |
| 运行配置 | 旧机 `.secrets/`、`apps/api/.env`、`packages/db/.env` 及 `GOOGLE_PATENTS_SA_JSON` 指向的 service account 文件已取回并 sha256 逐项校验；可移植三方凭据已接入 `local-config`，主机相关值刻意不继承 | 配置就位不等于服务已启动或已验证 |
| 运行时 | 2026-09-21 起新宿主以已发布镜像（`ghcr.io/mlhjyx/global-backend`，按 digest 钉住，源提交 `cca0d0e5`）经 `infra/backend-runtime.compose.yml` 启动 API/Worker：`/health/build` 为 `attested: true`；Worker 就绪链停在 `PLATFORM_AUTOMATION_ACQ_SWEEP_TEMPORAL_PROOF_UNAVAILABLE`，与旧宿主 2026-09-12 的 `TEMPORAL_PROOF_UNAVAILABLE` 同一既有缺口（见[原恢复记录](../evidence/growthos-managed-runtime-restoration-20260912.md)）。参考数据由代码 seed，未从旧库导入 | 这是本机运行观察，不是 RuntimeEvidence，也不产生可信 Release Bundle；源码 `pnpm worker` 停在 `BUILD_ATTESTATION_REQUIRED` 属设计；§3 的 runtime 观察仍绑定其原宿主与时刻 |
| 主线一致性 | `origin/main` 为最新真相；旧机与新宿主的本地 `main` 均落后 | 本地 checkout 不是权威 |
| 旧机器 | 迁移快照（2026-09-20T04:30Z）后旧机仍有写入与新分支推送；尚未停写退役 | 快照不是最终 writer 交接 |

**本节不改变任何阶段门裁决。** G5-Site / G5-Acquisition / G6 / G7 维持 §2 的现有裁决；宿主迁移不产生、也不替代 RuntimeEvidence。

## 5. 下一顺序与授权边界

1. #538 完成v3消费者、完整闭包及独立controller/materialization/readback/admission门；R4将已接线的本地候选推进到最终hosted、制品和运行接纳。两条owner施工面各自接纳，不互相借用局部成功。
2. Program C 保留已验证的C4本地候选，补齐action-intent隐私/DSR、C1 restricted envelope、C5产品接线与跨仓接纳；已完成的本地候选不重复列为未开发。
3. 根据实际最终制品与保留环境事实生成当前 RuntimeEvidence、可信 Release Bundle，再做完整三次用户旅程和重启/失败/UNKNOWN/隐私删除验收。
4. 历史分支/worktree 按 owner release、完整可恢复证据及精确删除授权逐项退役；不以数量多或工作区干净代替授权。

相同动作、目标和范围的有效授权继续沿用。源码/PR 合入不自动授权生产部署、保留数据库迁移、凭据与端口修改、真实 provider/model/付费调用或 Pilot/GA。正常产品请求的费用权威与开发者 ad-hoc 调用授权保持分离。
