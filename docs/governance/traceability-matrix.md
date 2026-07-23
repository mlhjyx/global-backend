# 端到端追踪矩阵

> 文档 ID：`GOV-FE-007`
> 层级：`L1 / Registry`
> 状态：`CURRENT`
> 关系 Owner：`OWN-DOC-GOV`
> 产品批准基线：Gate 2 + Gate 4 + Gate 5 + Gate 6 + Gate 7 + Gate 8，2026-07-20；Gate 8 为保留独立人工、真实 Release 和全部 blocker 的条件通过
> 工程核验基线：`origin/main@73f08f9f6b474b16a92e139f2c83cffcc8a6fb92`

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
- 用户、旅程和 Page ID 的批准结论已收口到当前 Registry；阶段论证保留在 Git/PR。
- “测试文件存在”只记 `TEST_ANCHOR`；除非有精确运行日期/提交/结果，不标 `TEST_PASSED_NOW`。
- hidden preview controller 是内部输出边界，不进入 public OpenAPI operation 列。
- 当前真实 Release Bundle 数为 0；不存在空索引或占位模板，不能从文档计划推出“用户可用”或“已发布”。

## 2. 全 SaaS 产品地图追踪

| 产品区域 | Capability IDs | 主要 Journey / Jobs | Page IDs | 核心对象 | SoR Owner | 当前深度 | 后续规范归属 |
|---|---|---|---|---|---|---|---|
| 公共 Shell / 今日 | `CAP-SHELL-001`、`CAP-ID-001`、`CAP-ONB-001`、`CAP-TODAY-001` | `JRN-FE-001/007/008`；`JOB-FE-001/005` | `PAGE-FE-001..010` | `OBJ-FE-001/002/025/026` | `OWN-SAAS-PLATFORM` | 产品 IA 已批；Phase 6 map complete；本地 Mock；正式合同/部署未知 | [页面目录](../frontend/04-page-and-capability-catalog.md) |
| 客户开发 | `CAP-BUYER-001`、`CAP-INTENT-001`、`CAP-COMP-001` | `JRN-FE-004/005`；`JOB-FE-006/007` | `PAGE-FE-060..066` | `OBJ-FE-009..011` | `OWN-BUYER-BE` 到 package；SaaS thereafter | 后端真实服务、前端 Mock、新增开发冻结；Phase 6 map complete | [页面目录](../frontend/04-page-and-capability-catalog.md) |
| 独立站管理 | `CAP-SITE-001..005` + Site child IDs | `JRN-FE-001..003/006/007`；`JOB-FE-003..005` | `PAGE-FE-030..057` | `OBJ-FE-003..008/012..017/027` | 企业事实、Site、SaaS 接缝分层 | 当前纵切 UX `SPEC_READY_WITH_BLOCKERS`；正式 FE `NONE`；承诺止于开发预览 | [全局规则](../frontend/README.md) + [Phase 5 Site Pack](../frontend/modules/independent-site-management/README.md) |
| 增长执行 | `CAP-CAMP-001`、`CAP-CONTENT-001`、`CAP-PUBLISH-001` | `JRN-FE-006/008`；`JOB-FE-008/009` | `PAGE-FE-070..079` | `OBJ-FE-018/019/024/025` | `OWN-SAAS-PLATFORM` | Phase 6 map complete；原型 Mock；正式 SoR 未定位 | [页面目录](../frontend/04-page-and-capability-catalog.md) |
| 互动与商机 | `CAP-ENGAGE-001`、`CAP-OPP-001` | `JRN-FE-005/008`；`JOB-FE-010/011` | `PAGE-FE-080..083` | `OBJ-FE-020..022/027` | `OWN-SAAS-PLATFORM` | Phase 6 map complete；外部 ownership；本仓不实现 Opportunity 主状态 | [页面目录](../frontend/04-page-and-capability-catalog.md) |
| 洞察 | `CAP-INSIGHT-001` | `JRN-FE-008`；`JOB-FE-012` | `PAGE-FE-084..086` | `OBJ-FE-023` + read models | `OWN-SAAS-PLATFORM` | Phase 6 map complete；平台目标态；Site 有局部 cost ledger | [页面目录](../frontend/04-page-and-capability-catalog.md) |
| 团队/集成/设置/运营 | `CAP-INTEG-001`、`CAP-TEAM-001`、`CAP-SET-001`、`CAP-ADMIN-001` | 多旅程横切 | `PAGE-FE-090..096` | `OBJ-FE-001/002/024..026` | `OWN-SAAS-PLATFORM` | Phase 6 map complete；本地原型/旧 Spring；正式 ownership 未定 | [页面目录](../frontend/04-page-and-capability-catalog.md) |
| 企业事实横切 | `CAP-TRUTH-001`、`CAP-KNOW-001` + Site Profile/Asset/Claim 子能力 | `JRN-FE-002/006`；`JOB-FE-001/002/004/009` | `PAGE-FE-020..026/034..039` | `OBJ-FE-003..008/017` | `OWN-TRUTH-BE` + `OWN-SITE-BE` | Phase 6 map complete；后端地基存在；审核合同未完成 | [页面目录](../frontend/04-page-and-capability-catalog.md) + [Site 生命周期](../frontend/modules/independent-site-management/lifecycle-permissions-and-state.md) |

完整 Page 名称和当前归属见[页面与能力目录](../frontend/04-page-and-capability-catalog.md)。该目录不证明页面已接入。

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

代码级当前事实以 [as-built 架构](../architecture/current.md)、[当前状态](../status/current.md)、机器合同和本表锚点为准；历史时点差异由 Git/PR provenance 解释，不能反向覆盖当前真值。

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
| Phase 1 audit | source/evidence/conflict IDs、implementation truth caveats | 稳定结论已收口，原过程可由 Git/PR 恢复 | 用当前 main 重写历史审计 |
| Phase 2 product baseline | Segment/Actor/Problem/Job/Journey/Page/Decision IDs | 当前 Registry、前端规范和 Site Pack 已承接；后续用户研究/实现仍待 | 把评审过程或规格当已实现页面 |
| 五份 Word | 用户/对象/场景/治理方法输入已进入 Phase 2/4/5/6；OSS/技术候选已进入 `ADP-FE-001..031` | Gate 7 已批采用决定；Phase 8 建自动治理；实现门保留 | 整份复制为 current PRD，或把候选写成已实现 |
| Site v3.1/v3.2 | 已映射到 Site 00–14、Capability/Object/Scenario/Traceability 和 Phase 5 Pack | Phase 8 建议原位保留强 banner；移动另授权 | 因篇幅或位置认定为现行施工真值 |
| 本地 React/Readdy/HTML | 原型、视觉和流程冲突已登记 | Phase 4/7 逐资产/页面采用决定 | 当作正式 repo、设计系统、License 或部署证明 |
| GoodJob/竞品/OSS | 功能生命周期表达、权限社会属性、Guide/FAQ、采用方法已映入 `ADP-FE-031` 与采用政策 | 后续真实 Guide/用户验证 | 从竞品功能反推我们的范围或“测试全绿” |

当前文件入口由[项目文档门户](../README.md)维护；历史动作和审批 provenance 由 Git/PR 保留。

## 8. 当前追踪完整性

### 已闭合的关系

- 24 个顶层 Capability 已映射到产品区域、Page family、核心对象和 Owner。
- 16 个 Site child Capability 已建立稳定 ID；首个纵切 9 个关键子能力已追到 public operation/internal resolver、main 代码、TEST_ANCHOR 和 Scenario。
- 27 个核心对象均有 SoR、唯一 Object Owner、事实状态和社会属性/生命周期边界。
- 8 条 Journey 和完整 Page ID 集未丢失；冻结/外部/后置能力在地图中保留但没有被点亮为可用。
- 旧 Word、Site v3.1/v3.2、本地原型和外部项目均有明确输入边界，不覆盖当前规范。

### 仍是后续硬门

- `OWN-SAAS-FE`、`OWN-DESIGN`、`OWN-SAAS-PLATFORM` 等实际人员/团队未指派；角色责任唯一但 operational assignee 缺失。
- Claim public review、Workspace/Entitlement、Publish/Domain/Inquiry、指标事件等机器合同未建。
- Fixture 仍为 `CATALOG_ONLY`；正式 frontend、E2E、受控视觉设计资产、面向真实用户的 Guide、真实 Release Bundle 和发布学习记录不存在。
- `architecture/current.md` 的手写 OpenAPI 数字和 `INTEGRATION.md` 的 R3-B1 文案仍有已登记漂移。

因此，本表证明“关系已登记”，不证明 Dev-Ready、实现、部署或用户可用。全局前端规则为 `APPROVED_AT_GATE_4`，Site 文档轴为 `APPROVED_AT_GATE_5 / SPEC_READY_WITH_BLOCKERS`，非 Site 域为 `APPROVED_AT_GATE_6 / MAP_COMPLETE / NOT_DEV_READY`；31 项外部候选保留已批准决定，但八项现用能力也仍只标 `*_HARDEN`。独立人工仍 `NOT_RUN / BLK-FE-006`，真实 Release Bundle 数仍为 0，Site 发布链继续 `TARGET_NOT_RUNNABLE`。
