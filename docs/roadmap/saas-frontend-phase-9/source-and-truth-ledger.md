# Phase 9 来源与事实总账

> 文档 ID：`AUD-FE-P9-001`
> 层级：`L3 / Audit evidence`
> 状态：`DRAFT`
> 事实 Owner：`OWN-DOC-GOV`
> 产品裁决 Owner：`OWN-PRODUCT`
> 工程基线：`origin/main@8dcbbcb8254a561f33abc59c49da4cb6a3de30b1`
> 最新增量对账：`origin/main@e0e51075df8ee8bb14dc5141f83365c6a2a4dec1`（2026-07-23）
> 核验日期：2026-07-23
> 关联冲突：[Phase 9 冲突与决策总账](conflict-and-decision-ledger.md)

## 1. 目的与读取规则

本总账是 Phase 9 的增量事实层，不替代 Phase 1 的逐文件冻结审计，也不把新设计提案写成当前实现。它回答四个问题：2026-07-20 的前端治理基线之后发生了什么；当前 `main` 能证明什么；哪些历史、附件和外部资料只能作为输入；这些输入应流向哪个 Capability、对象、页面或后续 Gate。

事实裁决顺序固定为：

1. `AGENTS.md` / `CONTRIBUTING.md` 约束施工方式；
2. product scope、as-built architecture、ADR、current status、release plan 按主题拥有 L1 真值；
3. OpenAPI、共享类型、Prisma/migration 和当前 `main` 代码拥有各自机器真值；
4. current Registry 和活规格只解释、追踪上述真值；
5. 全量 `docs` 活规格、治理 Registry、实施记录和冻结阶段证据按其层级、提交和日期解释；
6. Word、记忆、历史分支、Mock、附件、竞品和外部网页只提供 provenance、假设或候选。

### 1.1 读取状态

| 状态 | 含义 |
|---|---|
| `CROSS_CHECKED_AT_BASELINE` | 已在本基线把内容与更高层真值或机器事实交叉核验 |
| `POST_BASELINE_REFRESH` | 保留原始快照不重写，但已对后续 `origin/main` 变化重读、重算指纹并更新 current 结论 |
| `FULL_READ_RECONCILED` | 文件全文已纳入本轮读取，记录指纹/规模/层级，并按 current truth 处理冲突；不表示低层内容获批 |
| `INHERITED_FROZEN_EVIDENCE` | 继承 Phase 1–8 的精确读取证据；本阶段只核对 successor 与 delta，不重写原审计 |
| `MACHINE_INVENTORIED` | 已机器枚举路径、对象、operation、hash 或 Git 关系，未宣称完整语义验收 |
| `OFFICIAL_DOC_REVIEWED` | 已读取注明日期的官方网页/仓库资料；只证明页面声明 |
| `VISUAL_REVIEW_INPUT` | 已识别图像/界面内容，可用于多来源净室研究，不拥有代码/素材复用权 |
| `LOCAL_UNCONTROLLED` | 无正式 repo、版本、Owner 或发布 provenance；只读输入 |
| `NOT_REPRODUCIBLE` | 曾在会话/浏览器出现，但没有可复现版本、URL、录屏或证据包 |
| `NOT_READ_IN_PHASE_9` | 已知但本阶段尚未取得或未核验，必须保留缺口而非补猜 |

`read_status` 只表示读取深度，不表示内容获批、正确、可商用或已实现。

## 2. 两条时间轴与当前 main 结论

| 基线 | 版本 / 日期 | 权威与读取状态 | 当前解释 | 去向 |
|---|---|---|---|---|
| Phase 1 冻结审计 | `main@c3f0cca80e228f08f35c89776f759748dac78ce2`，2026-07-20 | `L3 / INHERITED_FROZEN_EVIDENCE` | 记录当时 5 份 Word、67 份 Markdown、本地旧原型、代码、外部资料和 24 个冲突；不得回写新事实 | 保留在 `saas-frontend-phase-1/` |
| Phase 2–8 治理基线 | `origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`；Phase 8 checkpoint `d3472c8` | `L3 / INHERITED_FROZEN_EVIDENCE` | 六项 IA、27 个对象、76 个 Page ID、31 张 Adoption Card、Registry 与防漂移方法获批；这些数字只证明当时地图/治理覆盖 | current Registry + Phase 9 delta |
| Phase 9 工程基线 | `origin/main@8dcbbcb8254a561f33abc59c49da4cb6a3de30b1`，2026-07-22 | `L1/L3/machine / CROSS_CHECKED_AT_BASELINE` | `main == origin/main`；#178–#181 已继续推进 M1-e-A，不能继续用 2026-07-20 的 Site 状态 | 本总账 + 当前权威文档 |
| Phase 9 增量刷新 | `origin/main@e0e51075df8ee8bb14dc5141f83365c6a2a4dec1`，2026-07-23 | `L1/L3/machine / POST_BASELINE_REFRESH` | #183–#190 继续推进 M1-e-A；快照文档不重编，current 组件资格和 MapLocation 合同按新 main 对账 | 本总账的 current delta + 指纹刷新 |

当前 `main` 可确认：

- Buyer Intelligence 后端保留既有能力但新增开发仍 `FROZEN`；本仓边界止于 `LeadQualifiedPackage`，Campaign、触达、Conversation、Opportunity 和归因仍由 SaaS 拥有。
- Site Builder 是唯一施工主线。R1-min 与 DI-0 已落；DI-0 的静态 Design Catalog 仍为空，SiteSpec 仍是 `1.0.0`，真实 Family、Blueprint、StylePreset、DemoVisualPack、受控 assembly 和运行时 DesignEvaluation 尚未形成。
- 组件目标集合为 55 型。截至增量刷新基线，`status/current`、资格目录和截图字节显示 44 型 `m1_e_a_qualified`、11 型 `gallery_only`，无 `transitional_release`；共 308 份七件套证据和 132 张三断点截图。M1-e-A 仍未完成。
- `MapLocation` 已从旧的 Google Maps/Geocoding 目标收口为无外呼地址文本卡；设计不得显示 iframe、坐标推断、地图 key 或已接入交互地图。
- 正式 SaaS 前端 repo、CI/deploy、设计事实源、Workspace allowed-actions 合同和多项 SaaS SoR 仍未定位。附件中的 React 项目不能关闭这些 blocker。
- 当前机器 OpenAPI 是 56 paths / 64 operations；这取代手写数量，但不证明任何正式 SaaS 页面已接入。

相关漂移见 `CON-FE-P9-001..006`。

## 3. L0/L1 与 current Registry

| Source ID | 来源 | 版本/权威 | 读取状态 | 冲突或限制 | 影响 | 迁移/唯一去向 |
|---|---|---|---|---|---|---|
| `SRC-FE-P9-001` | `AGENTS.md`、`CONTRIBUTING.md` | `main@8dcbbcb`；`L0` | `CROSS_CHECKED_AT_BASELINE` | 不定义产品功能；旧 Claude/legacy worktree 不代表当前责任 | 工作边界、worktree、PR、验证 | 原文件；Phase 9 不复制规则 |
| `SRC-FE-P9-002` | [产品边界](../../product-scope.md) | `main@8dcbbcb`；`L1` | `CROSS_CHECKED_AT_BASELINE` | 与旧 Spring 身份、全栈 Word、外部 OSS SoR 主张冲突 | 仓内/跨仓 ownership、冻结边界 | 产品范围唯一入口 |
| `SRC-FE-P9-003` | [as-built 架构](../../architecture/current.md) | `main@8dcbbcb`；`L1` | `CROSS_CHECKED_AT_BASELINE` | 手写 `40 paths` 已漂移到机器 56/64 | 当前实现架构、运行边界 | 架构真值；数量回到机器合同 |
| `SRC-FE-P9-004` | [ADR/PDR](../../adr/registry.md) | ADR-001..020；`L1` | `CROSS_CHECKED_AT_BASELINE` | `ACCEPTED` 不等于 implemented；ADR-015 的 55 型不等于全部 qualified | SoR、SiteSpec、组件、模型、媒体与许可红线 | ADR Registry |
| `SRC-FE-P9-005` | [当前状态](../../status/current.md) | `main@8dcbbcb`；刷新至 `e0e5107`；`L1` | `CROSS_CHECKED_AT_BASELINE + POST_BASELINE_REFRESH` | 正文已记录 44/55 资格、308 份证据和 132 张截图；仍明确 M1-e-A 未完成 | 当前主线与完成度 | 状态唯一入口 |
| `SRC-FE-P9-006` | [Release Plan](../release-plan.md) | `main@8dcbbcb`；`L1` | `CROSS_CHECKED_AT_BASELINE` | “进入 M1-e-A”不承担实时资格计数 | 施工顺序，不定义用户承诺 | 路线唯一入口；进度回 status |
| `SRC-FE-P9-007` | [治理 Registry](../../governance/README.md) | Gate 3–8 current；`L1` | `CROSS_CHECKED_AT_BASELINE` | 27 对象、76 页面是旧覆盖基线，不是 Phase 9 完整性结论 | 稳定 ID、Owner、状态、追踪 | Phase 9 先提案；批准后再更新 current Registry |
| `SRC-FE-P9-008` | [OSS Registry](../../backend/oss-registry.md) 与 [采用政策](../../platform/oss-adoption/adoption-policy.md) | Gate 7；`L2 / CURRENT` | `CROSS_CHECKED_AT_BASELINE` | Aitoearn/Chatwoot 仍 `LEARN/DEFER`；BaoTa/Postiz 尚无 Card | Provider 候选、许可、安全、退出 | Adoption Card 与独立准入 Gate |

## 4. Phase 1–8 冻结前端基线

| Source ID | 阶段 | 固定版本/日期 | 读取状态 | Phase 9 使用方式 | 禁止推出 | 去向 |
|---|---|---|---|---|---|---|
| `SRC-FE-P9-010` | Phase 1 来源/实现审计 | `c3f0cca`，2026-07-20 | `INHERITED_FROZEN_EVIDENCE` | 复用逐来源 manifest、Word hash、本地原型、代码和冲突 provenance | 不以旧 operation/component 数量表示当前 main | [Phase 1](../saas-frontend-phase-1/README.md)原样冻结 |
| `SRC-FE-P9-011` | Phase 2 产品/IA 基线 | `676c6cd`，2026-07-20 | `INHERITED_FROZEN_EVIDENCE` | 保留制造业首客群、默认操作者、六项 IA、对象/页面基础 | 不能把地图升级为 UX 或实现 | [Phase 2](../saas-frontend-phase-2/README.md)原样冻结 |
| `SRC-FE-P9-012` | Phase 3 Registry | `676c6cd`，2026-07-20 | `INHERITED_FROZEN_EVIDENCE` | 继续使用稳定 ID、Owner 和唯一事实规则 | 不能由 Phase 9 新对象直接改库 | [Phase 3](../saas-frontend-phase-3/README.md) + current Registry |
| `SRC-FE-P9-013` | Phase 4 全局前端规范 | `676c6cd`，2026-07-20 | `INHERITED_FROZEN_EVIDENCE` | 作为 Shell、权限、状态、AI/Evidence、a11y、接入和发布基础 | 书面规范不等于 designed/validated | [Phase 4](../saas-frontend-phase-4/README.md)原样冻结 |
| `SRC-FE-P9-014` | Phase 5 Site Capability Pack | `676c6cd`，2026-07-20 | `INHERITED_FROZEN_EVIDENCE` | 复用 Site 页面/状态/恢复规格；用新 main 修正实现轴 | 不把 Preview 写成 Publish/Domain | [Phase 5](../saas-frontend-phase-5/README.md)原样冻结 |
| `SRC-FE-P9-015` | Phase 6 非 Site 产品地图 | `676c6cd`，2026-07-20 | `INHERITED_FROZEN_EVIDENCE` | 作为跨域 gap 起点，继续识别制造业/公共站/指南遗漏 | `MAP_COMPLETE` 不等于功能完整或 Dev-Ready | [Phase 6](../saas-frontend-phase-6/README.md)原样冻结 |
| `SRC-FE-P9-016` | Phase 7 OSS/外部能力 | `676c6cd`，2026-07-20 | `INHERITED_FROZEN_EVIDENCE` | 保留 31 Card 的准入/退出方法；对新 Provider 建 delta | 不因新官方 API 文档自动升级采用决定 | [Phase 7](../saas-frontend-phase-7/README.md)原样冻结 |
| `SRC-FE-P9-017` | Phase 8 防漂移/收口 | checkpoint `d3472c8`，2026-07-20 | `INHERITED_FROZEN_EVIDENCE` | 延续文档验证、history banner、阅读路线和 Release Bundle 门 | 当时 156 份 Markdown、101 份受控文档等计数不能复用为当前值 | [Phase 8](../saas-frontend-phase-8/README.md)原样冻结 |

Phase 9 不修改 Phase 1–8 正文。任何新事实使用新 ID 和 delta 载体；批准后只更新 current Registry/successor，不重写旧 Gate 证据。

## 5. 当前前端、设计与产品规格

| Source ID | 来源组 | 版本/权威 | 读取状态 | 已证明 | 缺口/冲突 | 去向 |
|---|---|---|---|---|---|---|
| `SRC-FE-P9-020` | `docs/frontend/00..13` | Gate 4 current；`L2` | `CROSS_CHECKED_AT_BASELINE` | 六项 IA、Shell、角色、状态、权限、AI、design contract、a11y、接入和测试原则 | 没有 Token 数值、正式组件、可点击原型或用户验证 | Phase 9 interaction/design/Figma |
| `SRC-FE-P9-021` | `docs/frontend/modules/*` | Gate 5/6；`L2` | `CROSS_CHECKED_AT_BASELINE` | Site 深规格 + 七个非 Site 地图；跨域 gaps 已显式登记 | 公共站、完整身份、导入迁移、公开互动、资料动态引导和私密会话等深度不足 | Phase 9 capability/page/object ledgers |
| `SRC-FE-P9-022` | `docs/design/*` | Gate 4/5；`L2` | `CROSS_CHECKED_AT_BASELINE + POST_BASELINE_REFRESH` | 设计资产登记、微文案、Site 书面线框，以及六个 Figma 文件的受控 locator | Figma 仍是草稿；Library、全页面、全断点和真实用户验证未完成 | [Figma 交付登记](figma-delivery-register.md) |
| `SRC-FE-P9-023` | governance capability/object/page/scenario/traceability | Gate 3–8；`L1 Registry` | `CROSS_CHECKED_AT_BASELINE` | 既有 76 Page ID、27 Object、Capability/Scenario/Handoff 关系 | 新页面/对象未过裁决；指标与 Guide 关系不够完整 | Phase 9 audit → 后续 Registry Gate |
| `SRC-FE-P9-024` | current Phase 9 package | `main@8dcbbcb` 后新增；`L2/L3 proposal` | `CROSS_CHECKED_AT_BASELINE + POST_BASELINE_REFRESH` | 设计范围、交互语言、Figma 交付 schema，以及 12 张 SaaS 桌面代表页、4 张公共表面、1 张生成站、5 个高风险状态、3 张移动端和 6 条原型骨架 | 全部仍 `DRAFT`；不得表示为全量设计、用户验证或前端实现 | 本阶段评审包 |
| `SRC-FE-P9-025` | [docs 全量阅读总账](docs-reading-ledger.md) | 2026-07-23 读取快照；`L3` | `FULL_READ_RECONCILED` | 快照中 171 份 Markdown/DOCX 的路径、SHA-256、行/段落数、权威层级和采用规则 | 总账本身为本轮新增文件，不纳入自身快照；文件变更后须重算指纹 | 每轮设计前的来源完整性门 |

## 6. Site Builder 00–14、DQ-1 与交接记录

| Source ID | 文档 | 权威/读取状态 | 当前可用事实 | 漂移/限制 | 去向 |
|---|---|---|---|---|---|
| `SRC-FE-P9-SB00` | [00 决策与协调](../../site-builder/00-decisions-and-coordination.md) | `L2 / CROSS_CHECKED_AT_BASELINE` | ADR 映射、55 型目标、DI-0/M1-e 边界 | 仍写“下一门 26 型”，与 ADR/current code 冲突 | `CON-FE-P9-002`；当前进度回 status |
| `SRC-FE-P9-SB01` | [01 PRD](../../site-builder/01-prd.md) | `L2 / CROSS_CHECKED_AT_BASELINE` | 用户问题、事实红线、Site 目标 | 目标态不能替代 current capability | Site Pack/旅程 |
| `SRC-FE-P9-SB02` | [02 架构](../../site-builder/02-architecture.md) | `L2 / CROSS_CHECKED_AT_BASELINE + POST_BASELINE_REFRESH` | 固定 DAG、bounded task、Release/媒体/模型边界；D16 现为无外呼 MapLocation 文本卡 | 生产部署与目标 provider 不等于 as-built；旧 Maps/Geocoding 描述已失效 | integration/interface proposals；`CON-FE-P9-033` |
| `SRC-FE-P9-SB03` | [03 Agents](../../site-builder/03-agents.md) | `L2 / CROSS_CHECKED_AT_BASELINE` | 有界 task 与 allowed tools | 不支持自由 Planner/聊天主导产品 | AI interaction language |
| `SRC-FE-P9-SB04` | [04 SiteSpec](../../site-builder/04-sitespec-contract.md) | `L2 + machine-linked / CROSS_CHECKED_AT_BASELINE + POST_BASELINE_REFRESH` | SiteSpec 1.0、55 型集合、七件套门、MapLocation 文本卡合同和 1.1 目标 | 文档保留分批合并时点的资格摘要；current 总数必须回到机器 Registry/status 的 44/11；1.1 字段未实现 | `CON-FE-P9-002/003/033`；机器 Registry 为资格真值 |
| `SRC-FE-P9-SB05` | [05 Hosting](../../site-builder/05-deployment-hosting.md) | `L2 / CROSS_CHECKED_AT_BASELINE + POST_BASELINE_REFRESH` | 不可变 Release/发布目标与 DNS/TLS 风险；MapLocation 不再增加第三方地图 key/CSP 白名单 | 当前仅开发预览，未有 Publish/Domain 公开合同 | HostingTarget/Deployment 提案 |
| `SRC-FE-P9-SB06` | [06 Security](../../site-builder/06-security-abuse.md) | `L2 / CROSS_CHECKED_AT_BASELINE + POST_BASELINE_REFRESH` | 权利、abuse、网络和发布安全门；MapLocation 禁 iframe/Geocoding/坐标/位置推断 | 不构成 BaoTa/渠道法务批准 | Provider准入/发布 Gate |
| `SRC-FE-P9-SB07` | [07 API draft](../../site-builder/07-api-contract-draft.md) | `L2 / CROSS_CHECKED_AT_BASELINE` | 目标 API 语义输入 | 与 as-built 不同处不能当 endpoint | operation mapping 只认 OpenAPI |
| `SRC-FE-P9-SB08` | [08 Eval](../../site-builder/08-eval-testing.md) | `L2 / CROSS_CHECKED_AT_BASELINE` | 质量 rubric、Golden fixture、发布门 | 仍有 26 组件历史数字；运行时 DesignEvaluation 未产出 | `CON-FE-P9-003`；质量设计 |
| `SRC-FE-P9-SB09` | [09 M1 实施](../../site-builder/09-m1-implementation-design.md) | `L2 / CROSS_CHECKED_AT_BASELINE` | M1-e-A/B、M1-f/g 分层和风险 | 顶部状态未逐批反映 #178–#181；历史 26 数字残留 | release plan/status + M1 实施 successor |
| `SRC-FE-P9-SB10` | 10 模型研究 | `L6 / INHERITED_FROZEN_EVIDENCE` | 模型评测 provenance | 现役路由只认代码；不得给普通用户暴露 gateway | Model operations 设计输入 |
| `SRC-FE-P9-SB11` | 11 Readdy 研究 | `L6 / INHERITED_FROZEN_EVIDENCE` | 净室视觉研究问题 | ADR-019 已取代；代码/素材/蒸馏复用禁止 | DesignObservation，多来源净室 |
| `SRC-FE-P9-SB12A` | 12 v3.1 | `L6 / INHERITED_FROZEN_EVIDENCE` | 历史方案 provenance | `SUPERSEDED`，不能恢复为主设计 | 原位 history |
| `SRC-FE-P9-SB12B` | 12 v3.2 | `L6 / INHERITED_FROZEN_EVIDENCE` | 历史完整设计输入 | dated、混合多个时点并保留已知表格 warning | 原位 history；successor 为 00–14/ADR/status |
| `SRC-FE-P9-SB13` | [13 设计域模型](../../site-builder/13-design-domain-model.md) | `L2 / CROSS_CHECKED_AT_BASELINE` | DI-0 合同、Catalog 空、Family/Brief/Eval ownership | 不证明真实 Family、Brief 实例或运行时 Evaluation | Design object/interface proposal |
| `SRC-FE-P9-SB14` | [14 媒体地基](../../site-builder/14-media-foundation-mf0.md) | `L2 / CROSS_CHECKED_AT_BASELINE` | AssetVariant/MF-0/M1-c 边界 | MediaJob、生成式图/视频、公开 process/select 仍未建 | Media Studio 目标态，诚实标注 |
| `SRC-FE-P9-SBDQ` | [DQ-1](../../site-builder/DQ-1-shared-sitespec-contract.md) | `L3 / INHERITED_FROZEN_EVIDENCE` | SiteSpec 1.0 共享类型来源 | 固定证据，不用来证明 1.1/M1-e | 保留 history |
| `SRC-FE-P9-SBH` | [R1-min 交接](../../site-builder/handoffs/r1-min-execution-brief.md) | `L3 / INHERITED_FROZEN_EVIDENCE` | 当时任务边界与验证入口 | R1-min 已合并；不代表当前施工状态 | 原位 provenance |

## 7. OpenAPI、代码、数据、测试与运行证据

| Source ID | 机器来源 | 版本/读取 | 当前证明 | 不能证明 | 影响/去向 |
|---|---|---|---|---|---|
| `SRC-FE-P9-030` | `packages/contracts/openapi/openapi.json` | `8dcbbcb / MACHINE_INVENTORIED` | 56 paths / 64 operations；Company/Claim/ICP/Discovery/Lead/Events/Deletion/Site intake/profile/asset/KB/build/cancel | 页面、SaaS SoR、部署、用户可用 | Feature Coverage 按 operationId 全映射；`CON-FE-P9-006/013` |
| `SRC-FE-P9-031` | `packages/contracts/src/site-builder/*` | `8dcbbcb / CROSS_CHECKED_AT_BASELINE`；刷新至 `e0e5107` | SiteSpec 1.0、DI-0 合同、55 型集合、44 型七件套资格注册；MapLocation 无外呼文本合同 | SiteSpec 1.1、真实 Catalog/Family、余下 11 型资格 | Site设计事实与组件状态只读机器值 |
| `SRC-FE-P9-032` | `apps/api/src/**` | `8dcbbcb / MACHINE_INVENTORIED` | 当前 REST、服务、Temporal、ToolBroker、Outbox、成本、合规、Buyer/Site as-built | SaaS Identity/Campaign/Conversation/Opportunity 或正式 UI | backend-owned action 与 internal-ops mapping |
| `SRC-FE-P9-033` | `apps/site-renderer/**` | `8dcbbcb / MACHINE_INVENTORIED` | Astro、55 注册组件、开发 gallery、不可变 Release 消费基础 | 55 型全 qualified、Puck 编辑器、公网发布、生产 CDN | Site Editor/Public Site target distinction |
| `SRC-FE-P9-034` | `packages/db/prisma/**` | `8dcbbcb / MACHINE_INVENTORIED` | 当前对象、RLS、migration 与后台 SoR | Phase 9 候选对象已获准落库 | 对象评审先分类，不直接迁移 |
| `SRC-FE-P9-035` | `*.spec.ts`、renderer tests、`docs/evidence/**`、verify scripts | `8dcbbcb / MACHINE_INVENTORIED`；刷新至 `e0e5107` | 当前代码已有不同强度测试；44 型共 308 份七件套与 132 张三断点截图 | 本阶段未重跑全 API/DB/真实服务；不证明正式前端 E2E | QA scenario/fixture/release evidence 入口 |
| `SRC-FE-P9-036` | current dev runtime / production | `NOT_READ_IN_PHASE_9` | 本轮未改变服务或运行 probe | 不能声称生产部署、用户流量、SLO、Provider 接入 | 每项 Pilot/Release 另建精确证据 |

### 7.1 OpenAPI 产品面分组

| 分组 | 当前 operation | Phase 9 表达 |
|---|---:|---|
| 健康与身份投影 | 3 | `health` 多为运营；`whoami` 支撑 Shell，不成为身份系统 |
| 企业与 Claim/Evidence | 13 | 用户/审核动作；需 allowed actions、冲突与影响 UX |
| ICP、Discovery、Contact、Suppression | 24 | Buyer 后端 `AS_BUILT/FROZEN`；页面地图保留，不恢复施工 |
| Lead、sanctions、event handoff、deletion | 11 | 用户审核 + 运营对账 + 数据权利三类分开 |
| Site intake/profile/asset/KB/build/cancel | 13 | 当前 Site 纵切；Preview/Publish/Domain 不从 endpoint 数推导 |

operation 总数按 controller 分组可能跨上述业务边界；唯一精确列表仍是机器 OpenAPI，不复制第二份长期清单。

## 8. Git、worktree、历史与项目记忆

| Source ID | 来源 | 版本/读取 | 可证明 | 冲突/限制 | 去向 |
|---|---|---|---|---|---|
| `SRC-FE-P9-040` | `git log` / main / origin | `8dcbbcb / CROSS_CHECKED_AT_BASELINE`；`e0e5107 / POST_BASELINE_REFRESH` | #178–#190 已进入 main；Phase 9 工作分支已重放到 `e0e5107` | commit 存在不等于用户发布 | current status + evidence |
| `SRC-FE-P9-041` | `git worktree list --porcelain` | 2026-07-22 machine snapshot | 多个 Codex/legacy/locked worktree 仍存在 | 历史 worktree、独有 commit、dirty 状态不得升为 main 或被清理 | worktree runbook；只读 provenance |
| `SRC-FE-P9-042` | Phase 1 worktree provenance | `c3f0cca / INHERITED_FROZEN_EVIDENCE` | 当时各分支与用户现场关系 | 不能反推当前 merge/disposition | 保留 Phase 1 证据 |
| `SRC-FE-P9-043` | `/root/.codex/memories/MEMORY.md` | rolling memory，2026-07-22 读取 | 提醒 DI-0、M1-e、template-distillation 隔离和治理入口 | 仍含 #165 失败/26 型的旧时点；低于 main/current docs | `CON-FE-P9-004`；只作搜索索引 |
| `SRC-FE-P9-044` | `template-distillation` 历史实验 | memory/Git provenance | 曾提供 visual-research-only 候选 | 当前 worktree 清单无该正式主线；用户 no-adopt 记忆不得被新设计反向采用 | 不进入 main truth；净室多来源抽象需重新证明 |

## 9. 用户附件、旧前端与浏览器现场

附件保存在会话级目录，不是仓库资产。下列 hash 只用于本次审计对账，不授予复制、训练、商业分发或作为 Figma source-of-truth 的权利。

| Source ID | 文件 / 版本 | 读取状态 | 内容与可学信息 | 限制/冲突 | 去向 |
|---|---|---|---|---|---|
| `SRC-FE-P9-050` | `90705d3d2ff6d55fbe7a4e9464854c37.jpg`；SHA-256 `b337...06a7` | `VISUAL_REVIEW_INPUT` | 宝塔 AI 建站区域截图 | 厂商 UI、商标和素材不属于我方；不能决定 IA | Provider/建站交互比较板 |
| `SRC-FE-P9-051` | `codex-clipboard-384adbd2-c366-466a-9551-de3bd173ec1d.png`；SHA-256 `1a64...11a2` | `VISUAL_REVIEW_INPUT` | 宝塔整体 Shell 与 AI 建站页面 | 服务器面板结构不适合我方任务域 | 只记录观察，不复刻 |
| `SRC-FE-P9-052` | `codex-clipboard-7bbb...png` + `a76a...png`；SHA-256 `733c...51cc` / `df57...f63f` | `VISUAL_REVIEW_INPUT` | 模板选择、需求文档和聊天输入交互 | 聊天空白页/创作者式工作台不能替代对象工作台 | 交互反例/局部模式输入 |
| `SRC-FE-P9-053` | `codex-clipboard-775c...png`；SHA-256 `e70e...6928` | `VISUAL_REVIEW_INPUT` | 本地 Chrome 的证书错误现场 | 只证明当时 URL/证书失败，不证明宝塔不可用或现行部署状态 | TLS/错误状态 Fixture 输入 |
| `SRC-FE-P9-054` | `project-12268797.zip`；SHA-256 `4992...2399`；183 entries / 1,105,501 bytes | `LOCAL_UNCONTROLLED / MACHINE_INVENTORIED` | Vite/React 19、47 页自述、auth/Shell/Site/Buyer/Growth/Inbox/Admin/Help 路由、Mock 与 UI 参考 | 无 Git/Owner/CI/deploy；`.env` 含 Supabase 公共配置；Mock 与“全部完成”自述不能证明真实接入 | 逐页面 `Learn/Discard`，不得作为正式 repo 或代码基线 |
| `SRC-FE-P9-055` | `/global/frontend/project-12080666`、admin/frontend/backend | Phase 1 `LOCAL_UNCONTROLLED` | 旧 Readdy/Mock 页面和旧 identity/admin provenance | 用户明确它是 v1/过时模板；旧 Spring 与 JWKS 边界冲突 | 历史视觉/问题输入，不继承实现 |
| `SRC-FE-P9-056` | 用户在本地 Chrome 展示的 Aitoearn/宝塔登录态 | `NOT_REPRODUCIBLE` | 曾用于口头/视觉观察 | 本轮没有受控录屏、URL 清单、账号版本或交互证据包 | 若影响高风险决策，另做带日期/路径/截图的研究记录 |
| `SRC-FE-P9-057` | 未命名“其他产品” | `NOT_READ_IN_PHASE_9` | 用户说明后续还会提供 | 不补猜产品、功能或许可 | 到达后分配新 Source ID |

附件的完整路径、凭据和值不进入文档；`.env` 仅登记键存在，未复制值。

## 10. 外部官方来源与采用边界

| Source ID | 官方来源/版本 | 读取状态 | 官方资料可证明 | 内部当前决定/冲突 | 去向 |
|---|---|---|---|---|---|
| `SRC-FE-P9-060` | [Aitoearn 使用简介](https://docs.aitoearn.ai/zh/use/introduction)，页面最后修改 2026-07-09 | `OFFICIAL_DOC_REVIEWED` | API key、账号授权、素材上传、多平台发布；图片/视频/LLM 生成教程 | Gate 7 仍 `LEARN/NO_RUNTIME + DEFER`；新 Pilot 是提案，不是已集成 | `CON-FE-P9-007`；Provider capability/Spike |
| `SRC-FE-P9-061` | [Aitoearn API](https://docs.aitoearn.ai/zh/api)，页面最后修改 2026-07-07 | `OFFICIAL_DOC_REVIEWED` | 视频/图像/LLM、账号、授权、发布任务、重试/取消/改期、作品统计、上传签名 | API 索引不证明渠道实际权限、回执质量、评论/私信覆盖、SLA 或数据退出 | capability probe + contract/exit test |
| `SRC-FE-P9-062` | [Chatwoot API](https://developers.chatwoot.com/api-reference/introduction) + [signed webhook](https://developers.chatwoot.com/api-reference/webhooks/add-a-webhook) | `OFFICIAL_DOC_REVIEWED`，rolling docs@2026-07-22 | Application/Client/Platform API 分层；conversation/message；account webhook HMAC/timestamp/delivery ID | Gate 7 仍 `LEARN/NO_RUNTIME + DEFER`；不同 webhook 类型/版本能力必须探针验证 | `CON-FE-P9-008`；Private Conversation Adapter |
| `SRC-FE-P9-063` | [BaoTa 开源协议](https://www.bt.cn/new/agreement_open.html) + [GitHub license](https://github.com/aaPanel/BaoTa/blob/main/license.txt) | `OFFICIAL_DOC_REVIEWED`，rolling@2026-07-22 | 官网协议允许基于 API 开发应用；集成/发布与源码修改有不同限制 | 自定义协议而非宽松 OSS；repo license 与官网开源协议适用范围需书面确认 | `CON-FE-P9-009`；可选 Hosting Adapter Card |
| `SRC-FE-P9-064` | [Postiz Public API](https://docs.postiz.com/public-api/introduction) | `OFFICIAL_DOC_REVIEWED`，rolling@2026-07-22 | API key/OAuth、账号 integration、素材、草稿/排程/立即发布、平台特定设置、限流/错误 | 只作为 Aitoearn 退出/替代合同对照；未有 Adoption Card 或运行授权 | `CON-FE-P9-010`；contingency comparison |
| `SRC-FE-P9-065` | GoodJob snapshot `5732e2092b48837929e7bf1f3588f3940dccd7be` | `INHERITED_FROZEN_EVIDENCE`，2026-07-20 | 功能工作簿、权限/协作、下一动作、文档分流方法 | 远端刷新当时需认证；页面/实现/数据不复制 | `ADP-FE-031 / LEARN` |
| `SRC-FE-P9-066` | 31 项 Gate 7 OSS/外部官方快照 | `INHERITED_FROZEN_EVIDENCE` | 当时身份、上游 commit/root license、本地关系 | 许可/条款/HEAD 会漂移；不自动满足生产门 | OSS Registry/Card |

### 10.1 外部能力不构成的证明

- Aitoearn 有生成模型 API，不允许绕过我方 new-api 目标路由、Evidence、预算和任务晋级门；二者职责须拆分。
- Aitoearn/Postiz 能发布内容，不代表拥有我方 Content、Campaign、Approval 或 DeliveryReceipt 真值。
- Chatwoot 能存 Conversation/Message，不代表拥有我方 Company、Opportunity/QGO/SAO 或 Outcome；当前也没有我方 RFQ 聚合合同。
- BaoTa 能管服务器、域名和证书，不代表拥有我方 Site、Release、Deployment、DomainBinding 或 Certificate 状态。
- 任一官方 API、MIT/AGPL/自定义许可、开发环境运行或截图都不等于 `APPROVED_FOR_PRODUCTION`。

## 11. 跨源影响摘要

| 事实主题 | 当前真值 | Phase 9 设计影响 | 不得做的事 |
|---|---|---|---|
| 产品表面 | 统一 SaaS + 公开输出；本仓只拥有明确 bounded context | 同时设计公共站、身份、SaaS、生成站、帮助/开发者、平台运营，但分 IA/权限 | 把厂商 UI 或本仓 API 拼成第二套 SaaS |
| 页面完整性 | 76 Page ID 是 2026-07-20 地图基线 | 先做 Capability/Object/SoR/Scenario 证明，再提出新 Page Family | 以“页面多”或 47 页附件自述判完成 |
| Site | 开发预览 substrate as-built；增量基线上 M1-e-A 44/55 qualified | 诚实区分 Build/Version/Release/Preview/Publish/Domain；MapLocation 只用无外呼地址文本合同 | 把 Build success、Preview、文本地址卡或 BaoTa 部署写成 Publish/交互地图 |
| Buyer | 后端 as-built/frozen | 保留地图、解释现有 operation；不恢复新增开发 | 用完整前端设计授权扩大后端施工 |
| Growth/Engagement | SaaS external-owned，运行实现未知 | 设计我方 SoR/Adapter/Projection 和失败/退出 | 让 Aitoearn/Chatwoot 私有状态成为业务真值 |
| Model | new-api 是后台唯一目标网关；只有逐 task 晋级才有效 | 普通用户只见服务端批准档位/别名；运营看策略与证据 | 前端暴露 base URL、密钥或任意模型字符串 |
| 正式前端/Figma | 两张 FigJam 已完成指定越界节点纠偏；Foundations、12 张 SaaS 桌面代表页、4 张公共表面、1 张生成站、5 个关键状态、3 张移动端和 6 条原型骨架已有受控 Node；76/76 Page Manifest 已登记 | 五张用户确认界面作为视觉基线；继续完成 Library、逐页 Node、其余状态/断点、a11y、剩余 6 条 Journey 和用户验证 | 把代表页、部分状态/原型、草稿、截图/导出代码或示例业务内容当全文件已完成或已验证 Design System/能力合同 |

## 12. Phase 9 事实关闭门

只有以下条件同时满足，才能把本总账从 `DRAFT` 提交评审：

1. `CON-FE-P9-001..` 每条有 evidence、裁决、Owner、状态和关闭门；
2. `docs` 读取快照中的 171 份 Markdown/DOCX 已全部登记并按权威层级对账；2026-07-20 后 main delta 已按代码、合同、测试和当前状态核对，未把历史记忆升级为真值；
3. 当前 OpenAPI 每个 operation 在 Feature Coverage Ledger 中归类为用户动作、运营动作或 backend-only；
4. 76 个既有 Page ID 与所有新增候选页面保持 stable-ID/successor 关系；
5. 附件/浏览器/外部网页均带读取与权利限制，未复制秘密、PII、代码或素材；
6. Aitoearn、Chatwoot、BaoTa、Postiz 的产品提案与 Gate 7 当前采用状态并列呈现；
7. `pnpm docs:verify`、重复 ID、链接和 Git diff 边界检查通过；
8. 产品、设计、SaaS 平台、安全/商业和 QA 的未指派责任没有被 Codex 代签。
