# 端到端追踪矩阵

> 文档 ID：`GOV-FE-007`
> 层级：`L1 / Registry`
> 状态：`CURRENT`
> 关系 Owner：`OWN-DOC-GOV`
> 产品批准基线：Gate 2 + Gate 4 + Gate 5，2026-07-20；Phase 6 非 Site 关系待 Gate 6
> 工程核验基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`

本表回答“一个用户结果如何追到页面、对象、机器合同、main 代码、测试和场景”。它不复制规范或测试内容；链接只证明关系存在，是否通过/部署仍看精确 Evidence/Release Bundle。

## 1. 追踪规则

每个进入交付的 Capability 至少具备：

```text
Segment/Actor/Problem/Job
→ Journey
→ Capability
→ Page/State
→ Object/SoR
→ Contract/Event
→ main Implementation
→ Scenario/Fixture
→ Test/Runtime/Release Evidence
→ Guide/Learning
```

- 未存在的环节明确写 `NONE / FUTURE / BLOCKED`，不能留空让读者猜测。
- Phase 2 的用户、旅程和 Page ID 是 Gate 2 决策 provenance；Gate 4 全局规则和 Gate 5 Site 规格已批准，Phase 6 非 Site Pack 等待 Gate 6。
- “测试文件存在”只记 `TEST_ANCHOR`；除非有精确运行日期/提交/结果，不标 `TEST_PASSED_NOW`。
- hidden preview controller 是内部输出边界，不进入 public OpenAPI operation 列。
- Release Bundle 当前不存在；任何行都不得由此推出“用户可用”或“已发布”。

## 2. 全 SaaS 产品地图追踪

| 产品区域 | Capability IDs | 主要 Journey / Jobs | Page IDs | 核心对象 | SoR Owner | 当前深度 | 后续规范归属 |
|---|---|---|---|---|---|---|---|
| 公共 Shell / 今日 | `CAP-SHELL-001`、`CAP-ID-001`、`CAP-ONB-001`、`CAP-TODAY-001` | `JRN-FE-001/007/008`；`JOB-FE-001/005` | `PAGE-FE-001..010` | `OBJ-FE-001/002/025/026` | `OWN-SAAS-PLATFORM` | 产品 IA 已批；Phase 6 map complete；本地 Mock；正式合同/部署未知 | [Phase 6 Shell/Today](../frontend/modules/workspace-shell-and-today/README.md) |
| 客户开发 | `CAP-BUYER-001`、`CAP-INTENT-001`、`CAP-COMP-001` | `JRN-FE-004/005`；`JOB-FE-006/007` | `PAGE-FE-060..066` | `OBJ-FE-009..011` | `OWN-BUYER-BE` 到 package；SaaS thereafter | 后端真实服务、前端 Mock、新增开发冻结；Phase 6 map complete | [Phase 6 客户开发](../frontend/modules/buyer-development/README.md) |
| 独立站管理 | `CAP-SITE-001..005` + Site child IDs | `JRN-FE-001..003/006/007`；`JOB-FE-003..005` | `PAGE-FE-030..057` | `OBJ-FE-003..008/012..017/027` | 企业事实、Site、SaaS 接缝分层 | 当前纵切 UX `SPEC_READY_WITH_BLOCKERS`；正式 FE `NONE`；承诺止于开发预览 | [全局规则](../frontend/README.md) + [Phase 5 Site Pack](../frontend/modules/independent-site-management/README.md) |
| 增长执行 | `CAP-CAMP-001`、`CAP-CONTENT-001`、`CAP-PUBLISH-001` | `JRN-FE-006/008`；`JOB-FE-008/009` | `PAGE-FE-070..079` | `OBJ-FE-018/019/024/025` | `OWN-SAAS-PLATFORM` | Phase 6 map complete；原型 Mock；正式 SoR 未定位 | [Phase 6 增长执行](../frontend/modules/growth-execution/README.md) |
| 互动与商机 | `CAP-ENGAGE-001`、`CAP-OPP-001` | `JRN-FE-005/008`；`JOB-FE-010/011` | `PAGE-FE-080..083` | `OBJ-FE-020..022/027` | `OWN-SAAS-PLATFORM` | Phase 6 map complete；外部 ownership；本仓不实现 Opportunity 主状态 | [Phase 6 互动与商机](../frontend/modules/engagement-and-opportunity/README.md) |
| 洞察 | `CAP-INSIGHT-001` | `JRN-FE-008`；`JOB-FE-012` | `PAGE-FE-084..086` | `OBJ-FE-023` + read models | `OWN-SAAS-PLATFORM` | Phase 6 map complete；平台目标态；Site 有局部 cost ledger | [Phase 6 洞察与学习](../frontend/modules/insights-and-learning/README.md) |
| 团队/集成/设置/运营 | `CAP-INTEG-001`、`CAP-TEAM-001`、`CAP-SET-001`、`CAP-ADMIN-001` | 多旅程横切 | `PAGE-FE-090..096` | `OBJ-FE-001/002/024..026` | `OWN-SAAS-PLATFORM` | Phase 6 map complete；本地原型/旧 Spring；正式 ownership 未定 | [Phase 6 控制面](../frontend/modules/team-integrations-settings-and-operations/README.md) |
| 企业事实横切 | `CAP-TRUTH-001`、`CAP-KNOW-001` + Site Profile/Asset/Claim 子能力 | `JRN-FE-002/006`；`JOB-FE-001/002/004/009` | `PAGE-FE-020..026/034..039` | `OBJ-FE-003..008/017` | `OWN-TRUTH-BE` + `OWN-SITE-BE` | Phase 6 map complete；后端地基存在；审核合同未完成 | [Phase 6 企业事实](../frontend/modules/enterprise-trust-and-knowledge/README.md) + [Site 生命周期](../frontend/modules/independent-site-management/lifecycle-permissions-and-state.md) |

完整 Page 名称和 Gate 2 论证见 [页面与能力目录](../roadmap/saas-frontend-phase-2/page-and-capability-catalog.md)。该目录不证明页面已接入。

## 3. 首个纵切：产品到页面/对象/合同

默认 Segment=`SEG-FE-001`，主 Actor=`ACT-FE-002`，协作 Actor=`ACT-FE-003/005/007`，Journey=`JRN-FE-002/006/007`。这些关系由 `DEC-FE-P2-001..007` 批准。

| Capability | Problem / Job | Pages | Objects | Public contract | Contract state | Scenario |
|---|---|---|---|---|---|---|
| `CAP-SITE-001` | `PRB-FE-004` / `JOB-FE-003/004` | `PAGE-FE-030/031` | `OBJ-FE-012..016` | `SitesController_list_v1`、`SitesController_get_v1` | `VERIFIED` OpenAPI；正式 frontend `NONE` | `SCN-FE-SITE-014/016` |
| `CAP-SITE-INTAKE-001` | `PRB-FE-003/004` / `JOB-FE-001/003` | `PAGE-FE-032/033` | `OBJ-FE-003/012/015` | `IntakeController_create_v1` | `VERIFIED` | `SCN-FE-SITE-001/002` |
| `CAP-SITE-PROFILE-001` | `PRB-FE-003` / `JOB-FE-002/004` | `PAGE-FE-020/034` | `OBJ-FE-003/004` | `SitesController_getProfile_v1`、`SitesController_patchProfile_v1` | `VERIFIED` | `SCN-FE-SITE-003` |
| `CAP-SITE-ASSET-001` | `PRB-FE-003` / `JOB-FE-002/004` | `PAGE-FE-035/036/039` | `OBJ-FE-008` + refs | `AssetsController_presign_v1`、`commit_v1`、`list_v1`、`remove_v1` | `VERIFIED` | `SCN-FE-SITE-004..007` |
| `CAP-SITE-KB-001` | `PRB-FE-003` / `JOB-FE-002/004` | `PAGE-FE-024/037` | `OBJ-FE-005/008` | `KbController_status_v1` | `VERIFIED` 汇总；文档级管理 `NONE` | `SCN-FE-SITE-008` |
| `CAP-SITE-CLAIM-001` | `PRB-FE-003` / `JOB-FE-002/004` | `PAGE-FE-022/023/038` | `OBJ-FE-006/007/008/017` | `NONE` Site public review | `CONTRACT_BLOCKED`；internal bridge/snapshot only | `SCN-FE-SITE-009/010` |
| `CAP-SITE-BUILD-001` | `PRB-FE-004/008` / `JOB-FE-004/005` | `PAGE-FE-040` | `OBJ-FE-012/013/015/016/017` | `BuildsController_create_v1` | `VERIFIED` | `SCN-FE-SITE-011/012` |
| `CAP-SITE-RUN-001` | `PRB-FE-008` / `JOB-FE-005` | `PAGE-FE-041/042/044` | `OBJ-FE-015/016` | `BuildsController_get_v1`、`BuildsController_cancel_v1` | `VERIFIED` | `SCN-FE-SITE-013..015` |
| `CAP-SITE-PREVIEW-001` | `PRB-FE-004/008` / `JOB-FE-004/005` | `PAGE-FE-043` | `OBJ-FE-012..014` | Site GET 返回 `previewUrl`；hidden `/preview/:slug/*` resolver | public management `NONE`；internal resolver `AS_BUILT` | `SCN-FE-SITE-014/016/017/018` |

## 4. 首个纵切：合同到 main 实现与测试锚点

所有路径均相对仓库根。这里列的是追踪锚点，不表示 Phase 3 重新执行了测试。

| Capability | Controller/DTO | Service/Data/Workflow | Renderer/Release | TEST_ANCHOR | Evidence 结论 |
|---|---|---|---|---|---|
| `CAP-SITE-INTAKE-001` | `apps/api/src/site-builder/intake.controller.ts`、`dto/intake.dto.ts` | `intake.service.ts`、`temporal-demo-launcher.ts`、Site/Profile/Build Prisma models | demo SiteSpec/build chain | `intake.controller.spec.ts`、`intake.service.spec.ts`、`temporal-demo-launcher.spec.ts`、`dto/intake.dto.spec.ts` | main code-backed；正式 SaaS E2E/部署缺 |
| `CAP-SITE-PROFILE-001` | `sites.controller.ts` + profile DTO | `sites.service.ts`、profile merge/DB CAS/migrations | Build consumes frozen profile/claim inputs | `profile-contract.spec.ts`、`profile-controller.spec.ts`、`profile-merge.spec.ts`、`profile-openapi.spec.ts`、migration integrity | contract/code-backed；UX 未建 |
| `CAP-SITE-ASSET-001` | `assets.controller.ts` | `assets.service.ts`、`assets-r2.service.ts`、`storage.service.ts`、asset cleanup workflows、reference scanner | Asset/Variant consumed by SiteSpec/media | asset controller/service/R2/reference/delete/cleanup/storage tests | code-backed；客户端 PUT/断网 E2E 未建 |
| `CAP-SITE-KB-001` | `kb.controller.ts` | `kb.service.ts`、KB clients、`temporal/kb-ingest.workflow.ts`、`kb-recovery.workflow.ts` | KB feeds BrandProfile/claims/copy | `kb.service.spec.ts`、`kb-clients.spec.ts`、KB migration + Temporal tests | code-backed；公开文档级 UX/合同缺 |
| `CAP-SITE-CLAIM-001` | no Site public controller | claim/evidence bridge、persistence gate、publishable snapshot services/migrations | snapshot freezes approved facts for Build | claim bridge/evidence/snapshot classification/persistence tests | internal evidence chain code-backed；self-service contract blocked |
| `CAP-SITE-BUILD-001` | `builds.controller.ts`、`dto/build.dto.ts` | `builds.service.ts`、build request/scope、Temporal refurbish/site activities、budget/spend ledger | renderer build + Release candidate | build request/scope/controller/service、paid gates、workflow tests | code-backed；INTEGRATION prose contains stale R3-B1 scope |
| `CAP-SITE-RUN-001` | `builds.controller.ts` + build DTO | progress repository、cancel/Temporal、cost ledger/reconciliation | terminal Release promotion or old preview preservation | build progress/cost/ledger/controller/service/refurbish tests | code-backed；统一 long-task UX/运营证据缺 |
| `CAP-SITE-PREVIEW-001` | `sites.controller.ts` + `site-preview.controller.ts` (hidden) | preview resolver migration、artifact service、Release/GC/maintenance | `apps/site-renderer/`、manifest/digest/unknown component precheck | preview artifact/routing/promotion、release artifact/service/GC、renderer/spec tests | internal object-backed preview code-backed；public Publish/Release UI/production deploy缺 |

代码级更完整证据与 Phase 1 时点说明见 [实现证据矩阵](../roadmap/saas-frontend-phase-1/implementation-evidence-matrix.md)。R1-min 是 Phase 1 之后的 main delta，其产品解释见 Phase 2 [Gate 2](../roadmap/saas-frontend-phase-2/gate-2-review.md)，不能回写进冻结的 Phase 1 数字。

## 5. 后置 Site 能力的缺口追踪

| Capability | Pages | Objects | 必须新增的机器合同/实现 | 场景 | 当前状态 |
|---|---|---|---|---|---|
| `CAP-SITE-EDIT-001` | `PAGE-FE-045..047` | SiteSpec/Copy/Theme/Claim refs | runtime schema/version、read/write API、concurrency、design component catalog | `SCN-FE-SITE-018` + future edit conflicts | `APPROVED_NOT_BUILT` |
| `CAP-SITE-RELEASE-001` | `PAGE-FE-048` | `OBJ-FE-013/014` | public list/detail/diff/activate/rollback、permission/audit | `SCN-FE-SITE-019` | `TARGET_NOT_RUNNABLE` |
| `CAP-SITE-PUBLISH-001` | `PAGE-FE-049/050` | Release/PublishReview/Approval/Authorization | publish review、public service activation、rollback/kill switch | `SCN-FE-SITE-020` | `TARGET_NOT_RUNNABLE` |
| `CAP-SITE-DOMAIN-001` | `PAGE-FE-051` | future Domain/Certificate | DNS ownership、certificate、region/SLA、switch/recovery | `SCN-FE-SITE-021` | `TARGET_NOT_RUNNABLE` |
| `CAP-SITE-INQUIRY-001` | `PAGE-FE-053/054` | `OBJ-FE-027/020/021` | receiver/consent/anti-abuse/outbox/SaaS projection/retention | `SCN-FE-SITE-022` | `DEFERRED/BLOCKED` |
| `CAP-SITE-ANALYTICS-001` | `PAGE-FE-055` | events/read models | event schema、metric definitions、privacy/retention、bot/timezone | `SCN-FE-SITE-023` | `DEFERRED` |
| `CAP-SITE-DIAGNOSIS-001` | `PAGE-FE-056` | future diagnosis run/findings | crawl/audit contract、ownership、remediation/evidence | `SCN-FE-SITE-023` future variant | `DEFERRED M3+` |
| `CAP-SITE-PUBLIC-OUTPUT-001` | `PAGE-FE-057` | SiteVersion/Release/public output | [Phase 5 output spec](../frontend/modules/independent-site-management/public-site-output-spec.md)已建；仍缺 production publish evidence | `SCN-FE-SITE-016..023` | renderer partial as-built；production chain not built |

## 6. 权限、状态、指标与运营横切

| Concern ID | Applies to | 当前事实源 | 缺口 | Future owner/spec |
|---|---|---|---|---|
| `TRC-FE-PERM-001` | 所有 Capability/Page/Object | Workspace RLS、JWKS、本表社会属性 | [当前权限规范](../frontend/06-permissions-and-data-visibility.md) + [Site 矩阵](../frontend/modules/independent-site-management/lifecycle-permissions-and-state.md)已定义；allowed actions 合同仍缺 | `OWN-SAAS-PLATFORM` / `BLK-FE-003` |
| `TRC-FE-STATE-001` | Site/Build/Release/Public service | Object lifecycle + OpenAPI/code | [当前状态规范](../frontend/07-state-error-degradation-and-recovery.md) + Site 四层映射已建；正式设计/E2E 仍缺 | `OWN-DESIGN` / `BLK-FE-001/002/006` |
| `TRC-FE-AI-001` | Claim/Brand/Copy/Recommendation | bounded AI tasks、EvidenceRef、Claim/Evidence | [AI/Evidence](../frontend/08-ai-approval-evidence-and-human-control.md)和 Site fail-closed 已定义；Site review/impact 合同仍缺 | `OWN-PRODUCT` / `BLK-FE-004` |
| `TRC-FE-METRIC-001` | `MET-SITE-001..014` + anti-metrics | Phase 2 指标 provenance、Build cost facts | [分析规范](../frontend/12-analytics-testing-and-release-evidence.md) + [Site 验收](../frontend/modules/independent-site-management/operations-and-acceptance.md)已映射；schema/baseline/target/privacy 仍缺 | `OWN-DATA-PRIVACY` / `BLK-FE-005` |
| `TRC-FE-QA-001` | 所有 Site scenarios | tests + scenario catalog | [Site 验收矩阵](../frontend/modules/independent-site-management/operations-and-acceptance.md)已建；executable fixtures/frontend E2E/a11y/visual/perf/security/release evidence 仍缺 | `OWN-QA-EVIDENCE` / `BLK-FE-001/002/006` |
| `TRC-FE-OPS-001` | failure/cancel/cleanup/provider issues | stable errors、Temporal、operator-disabled maintenance | [Site runbook/兜底](../frontend/modules/independent-site-management/operations-and-acceptance.md)已建；SLA、实际 assignee、redrive permissions 仍缺 | `OWN-OPS` / `BLK-FE-006` |
| `TRC-FE-COMM-001` | entitlement/budget/publish/license | cost ledger/OSS audit/decision inputs |套餐、额度、升级/降级、License approval、exit plan | `OWN-SEC-COMMERCIAL` / Phase 4/7 |

## 7. 来源到规范的迁移追踪

| Source family | 已迁入的稳定关系 | 仍需迁入 | 不得做什么 |
|---|---|---|---|
| Phase 1 audit | source/evidence/conflict IDs、implementation truth caveats | Phase 8 自动覆盖和 banner/归档提案 | 用当前 main 重写冻结审计 |
| Phase 2 product baseline | Segment/Actor/Problem/Job/Journey/Page/Decision IDs | Gate 4 current 规范、Gate 5 Site 和 Phase 6 非 Site Pack 已承接；后续用户研究/实现仍待 | 把评审包或规格当已实现页面 |
| 五份 Word | 用户/对象/场景/治理方法输入已进入 Phase 2/4/5/6 | OSS/技术候选留 Phase 7；自动治理留 Phase 8 | 整份复制为 current PRD |
| Site v3.1/v3.2 | 已映射到 Site 00–14、Capability/Object/Scenario/Traceability 和 Phase 5 Pack | Phase 8 文件动作 | 因篇幅或位置认定为现行施工真值 |
| 本地 React/Readdy/HTML | 原型、视觉和流程冲突已登记 | Phase 4/7 逐资产/页面采用决定 | 当作正式 repo、设计系统、License 或部署证明 |
| GoodJob/竞品/OSS | 功能生命周期表达、权限社会属性、Guide/FAQ、采用方法 | Phase 7 adoption cards、后续 Guide 模板 | 从竞品功能反推我们的范围或“测试全绿” |

详细文件动作仍只在 [文档登记](document-register.md)维护。

## 8. Gate 3 追踪完整性结论

### 已闭合的关系

- Gate 3 时点的 23 个顶层 Capability 已映射到产品区域、Page family、核心对象和 Owner；当时企业事实横切域只有 Domain/Object 与 `CAP-KNOW-001`/Site 子能力，尚无独立顶层 Capability。
- 16 个 Site child Capability 已建立稳定 ID；首个纵切 9 个关键子能力已追到 public operation/internal resolver、main 代码、TEST_ANCHOR 和 Scenario。
- 27 个核心对象均有 SoR、唯一 Object Owner、事实状态和社会属性/生命周期边界。
- 8 条 Journey 和完整 Page ID 集未丢失；冻结/外部/后置能力在地图中保留但没有被点亮为可用。
- 旧 Word、Site v3.1/v3.2、本地原型、GoodJob 和 Phase 1/2 均有规范迁移去向。

### 仍是后续硬门

- `OWN-SAAS-FE`、`OWN-DESIGN`、`OWN-SAAS-PLATFORM` 等实际人员/团队未指派；角色责任唯一但 operational assignee 缺失。
- Claim public review、Workspace/Entitlement、Publish/Domain/Inquiry、指标事件等机器合同未建。
- Fixture 仍为 `CATALOG_ONLY`；正式 frontend、E2E、设计资产、Guide、Release Bundle 和发布学习不存在。
- `architecture/current.md` 的手写 OpenAPI 数字和 `INTEGRATION.md` 的 R3-B1 文案仍有漂移，已登记冲突但未在 Phase 3 修改权威/接入文档。

因此 Gate 3 可以审“事实归属和迁移覆盖”，不能被解释为 Gate 4/5、Dev-Ready 或用户可用完成。

## 9. Phase 4–6 规范追踪结论

Gate 4 已把全产品 Capability/Page family 连接到当前 IA/Shell、权限、状态、AI/Evidence/Approval、设计系统/内容、a11y/性能/i18n、合同接入和发布证据规范。Gate 5 又把 Site 当前纵切连到 Page manifest、四层状态、29 条 Site Copy、`DSA-FE-SITE-WF-001`、13 个 operation、Scenario/Fixture、指标和实施蓝图。Phase 6 为其余 Page family 建立七个地图级 Pack，新增 `CAP-TRUTH-001` 把当前顶层 Capability 补至 24 个，并补十条跨域 Handoff、十二项 Gap、六组 target Fixture 和 16 条地图级 Scenario。

全局规则为 `APPROVED_AT_GATE_4`；Site 文档轴为 `APPROVED_AT_GATE_5`；非 Site Pack 为 `READY_FOR_GATE_6_REVIEW / MAP_COMPLETE`。正式 repo、受控视觉设计、权限/Claim/跨域业务/指标合同、可执行 Fixture、前端实现和 Release Bundle 仍为 `NONE/BLOCKED`，因此 Phase 6 只关闭“产品地图失踪”风险，没有升级前端、质量和用户可用性轴；Site 发布链继续 `TARGET_NOT_RUNNABLE`。
