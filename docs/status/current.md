# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[ADR registry](../adr/registry.md)、[发布路线](../roadmap/release-plan.md)，以及本页逐项注明的 Git/GitHub 回读、机器验证与 owner 交付
> 最后核验：2026-09-20T07:27:13.869Z（源码、队列与 owner 交付回读；历史 runtime 不重新标记为当前）

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
| Backend source | 本轮整合的上一 main 基线为 `03e8ada02010052bf4220e1063d2c5c987bf1f8a`；当前源码包含五组依赖目标。根 checkout 是否跟随由受控同步回执独立证明 | main checkout 不等于 managed runtime；当前制品、迁移与 API/Worker/Relay 身份须独立绑定 |
| 依赖维护 | #539 Redocly、#540 Langfuse、#541 S3、#543 AI SDK 已逐项合入；最后工具链与本次状态修订属于同一候选，最终 head/CI/merge 从原 #533 的 successor 收口记录回读，见[本轮证据](../evidence/dependency-queue-closeout-20260920.md) | 本地与 hosted 成功不证明 retained 采用；JS production audit 不覆盖所有开发依赖或 Go 告警 |
| 已采用的修复 | Browser/ACK/DeletionCompleted、native Temporal 基础设施、覆盖率与受控 root-sync 修复已有独立已合入来源；#494/#495 实际分别合入，#497 完成后续 native harness 收口；Wikidata country binding 由 #498 合入 | #494/#495 的实际历史不是最初计划的“关闭为 superseded”；country 子项不是完整获客产品；ACK readback 不是 SaaS durable consumer；native disposable 不是保留环境健康 |
| #407 历史综合候选 | CLOSED，原始 head `70885cdb4196ae86db762ae96ca73f4cfa51f89d` 保留，successor 按独立准入条件处理 | 不恢复历史 Identity、迁移、provider、Relay 或 HTTP hook；不把关闭解释为全量语义接纳 |
| #538 身份/质量 | 远端 Draft `576fabeb810e54ae043d4c3a45ed09873c6fc07a`；本地 clean 候选 `c792106791e05dde1178ade88c816813a421eda7`。owner 报告此前 broker primitives/文件 pin/profile/离线 inspect 范围71项测试通过；新 native HTTPS 修订仍是规格 | 有界传输方案确认及完整 loader/library/CA/DNS 证明、执行入口与私有FD、可信 receipt producer、credential scope/controller 物化、实际独立 readback、path/owner/migration 审计与新 admission；`admissionGranted=false`，没有 ADMITTED |
| R4 native 与 Backend | 本地 head `b7b201ea92b48543d85bc946c4a539879e48d33f`；此前 native `8f41617593b55a0c4abb04deaba22f6bc9f52319` 的 matrix K、Go verify/race/vet/build 与完整源码独立审查已获 owner 确认；新 Backend core 局部 63 项测试通过 | 这些是 owner 提交的局部 source/test 证据；完整 R4 联合接纳、最终独立 review、hosted、retained runtime 与 UAT 分开完成；其他接线仍属 owner 施工面 |
| GrowthOS 平台 authority | 本地 head `e8d5941d2535a598a1165edf1f711b9b4b588ef7` 的 release identity tooling 已有 owner 报告的局部验证；产品 patch 仍为107。machine bootstrap Java 冻结源码已有 35 项测试及独立复审，patch108 尚未登记 | durable revocation consumer、真实 producer HTTP 与 Backend receiver、freshness/backlog/lease 集成仍未完成；不能用局部 Java/tooling 成功代签平台能力 |
| #515 capability receiver | 远端 Draft `6a3126b7670661a64c95676574320a3f6992ee66`；后续本地 receiver 及跨语言证据由 R4 owner 接线 | 专用 service token/JWKS/kid、固定 schema/source/policy/schedule digest、nonce/replay、错误清缓存及真实 Temporal/撤销事实仍需同一交付绑定 |
| #542 安全基线刷新 | Draft `4aeb2d5aff7f2df8fe03ad9c936e2d71b3d4d5de`，当前候选绑定 `1aaa1a779bbf716f301e5f08c7f3d0ad37eeaacc` 及其 lockfile；后续依赖更新已改变绑定输入 | 需核实 owner，针对本批最终源码重新 audit/freshness/review；原有效期和零漏洞政策不得放宽。JS production audit 零漏洞不等于旧 baseline 仍为 FRESH |
| Program C | 本地候选 `0eac22e4b7a2fbb16a98561ace31734118041ac7`；已增加完整空库迁移、真实会话判断 HTTP 与 LifecycleController 装配的局部验证 | 这是 GrowthOS archive/patch authority 隔离交付，不是 shared main 或 runtime 接纳；可信 QGO evidence 仍 HOLD，C4 前端完整操作旅程与 C5 facade/会话挂接未完成，retained upgrade/release/runtime/完整浏览器 UAT 仍待完成 |

Program C 的新交付入口为其 worktree 中 `handoffs/program-c/successors/full-schema-verification.json`、`real-session-http.verification.json` 和 `lifecycle-http.verification.json`。完整空库初始化通过生产 Flyway 工厂执行46项迁移、validate及二次 migrate 0；它不证明 retained upgrade。真实会话判断 HTTP 交付由 owner 报告13项测试通过，最新生命周期交付报告22项测试通过；本任务另行核对对应主报告 hash 与零 failure/error/skip，但没有将局部数量相加为全项目 fresh PASS。

真实 QGO 仍因 `EvidenceUnavailable` 返回503且 revision 不变；SAO/CLOSED 路径使用明确的 owner 合成 QGO 前置验证，不能解释为真实 QGO 或商业闭环。此前257项反馈/轮询测试及前端/合成HTTP场景保留为各自源码的局部历史证明，不替代连接真实服务器的浏览器 UAT。Snapshot Key Authority 继续用户明确延期，不用固定 profile key 替代 C1 保护。

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

## 5. 下一顺序与授权边界

1. #538 完成独立 admission/broker/materialization/path/owner/migration 门；R4 完成 machine bootstrap、native Worker、真实 producer/receiver、撤销 consumer 与 lease 联合验证。两条 owner 施工面各自接纳，不互相借用局部成功。
2. Program C 完成浏览器人工判断、冲突恢复和反馈状态接线，以及跨仓产品接纳；已完成的本地候选不重复列为未开发。
3. 根据实际最终制品与保留环境事实生成当前 RuntimeEvidence、可信 Release Bundle，再做完整三次用户旅程和重启/失败/UNKNOWN/隐私删除验收。
4. 历史分支/worktree 按 owner release、完整可恢复证据及精确删除授权逐项退役；不以数量多或工作区干净代替授权。

相同动作、目标和范围的有效授权继续沿用。源码/PR 合入不自动授权生产部署、保留数据库迁移、凭据与端口修改、真实 provider/model/付费调用或 Pilot/GA。正常产品请求的费用权威与开发者 ad-hoc 调用授权保持分离。
