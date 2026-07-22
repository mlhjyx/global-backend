# Phase 9 全产品体验架构与受控视觉设计

> 文档 ID：`GATE-FE-P9-000`
> 层级：`L3 / Phase working package`
> 状态：`DRAFT`
> 事实 Owner：`OWN-PRODUCT`
> 设计 Owner：`OWN-DESIGN`
> 工程基线：`origin/main@8dcbbcb8254a561f33abc59c49da4cb6a3de30b1`
> 最后核验：2026-07-23

## 1. 本阶段要解决的问题

Phase 1–8 已建立前端来源审计、全产品地图、治理 Registry、全局体验规范、Site Capability Pack、OSS 采用组合和防漂移机制，但仍没有正式视觉方向、Figma 事实源、可点击原型或完整的制造业交互模型。76 个稳定 Page ID 只能证明既有地图没有失踪，不能证明完整 SaaS 的功能、对象、交互和异常闭环已经设计。

Phase 9 在不修改产品代码、不扩大当前 Site Builder 施工承诺、不恢复 Buyer Intelligence 新开发的前提下，完成四件事：

1. 刷新 2026-07-20 后的代码、文档、接口、历史和外部来源事实；
2. 识别被折叠、遗漏、应拆分或应停车的能力、对象和页面族；
3. 冻结制造型企业全产品体验架构、Provider/SoR 边界和跨模块交互语言；
4. 以用户确认的五张界面作为视觉与布局基线，完成全量文档对账后再建立受控 Figma 资产。

## 2. 产品表面

Phase 9 同时覆盖六个表面，但不把它们混成一套导航或视觉模板：

| 表面 | 主要用户 | 设计结果 | 当前产品状态 |
|---|---|---|---|
| 产品公共站 | 潜在客户、合作伙伴、采购与安全评审人员 | 产品、制造业方案、价格、案例、信任、帮助、开发者与状态入口 | `PROPOSED` |
| 身份与激活 | 新用户、受邀成员、管理员 | 注册、验证、恢复、Workspace、Onboarding、导入迁移 | `PROPOSED`；Site intake 只有局部合同 |
| SaaS 工作台 | 老板、海外增长、内容、销售、审批、管理员 | 六项任务域 + 横向控制面 | 地图已批准；正式前端未定位 |
| 客户生成站 | 海外买家、采购、工程、经销商 | 经客户提供并审核的企业、产品、能力、认证、资料、案例和有同意的询盘入口 | Renderer 局部 as-built；公开发布链未闭环 |
| 帮助与开发者 | 用户、管理员、开发者、运营 | Tutorial、How-to、Reference、Explanation、Changelog、Status | `PROPOSED` |
| 平台运营 | 客户成功、数据运营、安全、平台运维 | Provider、Workflow、Model、Incident、DSR、受控 support access | `TARGET_EXTERNAL`；不得与客户 UI 混权 |

## 3. 六项任务域

SaaS 一级导航冻结为用户任务，而不是供应商或技术模块：

1. 今日；
2. 客户开发；
3. 站点管理；
4. 增长执行；
5. 互动与商机；
6. 洞察。

企业真相、全局搜索、任务、审批、通知、长任务、事故、帮助和对象 Inspector 是横向能力；个人设置、Workspace 设置、集成、安全、账单和平台运营使用独立入口。

## 4. 交付物

| 交付物 | 主题 | 当前状态 |
|---|---|---|
| [来源与事实总账](source-and-truth-ledger.md) | 当前权威、代码/OpenAPI、历史、记忆、附件和外部来源 | `AUDIT_COMPLETE / DECISIONS_OPEN` |
| [docs 全量阅读总账](docs-reading-ledger.md) | 171 份 Markdown/DOCX 的路径、指纹、层级、读取状态和采用规则 | `SNAPSHOT_COMPLETE` |
| [冲突与决定总账](conflict-and-decision-ledger.md) | 状态漂移、对象折叠、SoR 和产品边界冲突 | `ACTIVE_LEDGER` |
| [功能覆盖总账](feature-coverage-ledger.md) | `Keep / Deepen / Split / New / Park / Reject` | `64/64 OPENAPI + 76/76 PAGE MAPPED` |
| [对象与页面族评审](object-page-family-review.md) | 候选对象分类、现有 76 页加深和新增页面族 | `24 PAGE FAMILIES MAPPED / GATE_PENDING` |
| [Provider 与 SoR 架构](provider-and-sor-architecture.md) | Aitoearn、Chatwoot、BaoTa、new-api 与替代/退出 | `DESIGN CONTRACT DRAFT / RUNTIME_DEFERRED` |
| [交互语言与视觉语义](interaction-language-and-visual-semantics.md) | Shell、对象工作台、状态、模式、Token 和视觉方向 | `DRAFT` |
| [资料与知识引导 Fixture](visual-direction-content-fixture.md) | 动态资料采集、知识库输入、允许数据、禁止硬编码行业字段与旧图处置 | `DRAFT` |
| [旅程与原型目录](journey-and-prototype-catalog.md) | 12 条制造业端到端旅程与异常覆盖 | `DRAFT` |
| [Figma 交付登记](figma-delivery-register.md) | 文件、Frame、Scenario、状态和验证证据 | `FOUNDATIONS / 11 DESKTOP / 5 STATES / 3 MOBILE / 3 PROTOTYPE DRAFTS` |
| [设计系统 v1 范围与差距分析](design-system-v1-scope.md) | Phase 0 来源、差距、Token/组件范围和进入 Phase 1 的批准门 | `PHASE_0_APPROVED / PHASE_1 CORE DRAFT COMPLETE` |
| [Phase 1 设计证据](phase-1-design-evidence.md) | Figma Node、同视口 QA、生成素材、已知限制和剩余门 | `DRAFT EVIDENCE` |
| [Page Manifest 2.0](page-manifest-v2.md) | 76 个稳定页面的任务、对象/SoR、状态、Scenario、动作、异常和 Figma 去向 | `76/76 MAPPED / DRAFT` |
| [Canva 评审交付登记](canva-review-delivery.md) | 评审汇报、旅程报告和管理层路线图 | `NOT_CREATED / WAITING_FOR_FIGMA` |

### 4.1 设计工作强制阅读顺序

任何新设计图、视觉提示词、Figma Frame、组件或页面候选开始前，必须：

1. 完成 [docs 全量阅读总账](docs-reading-ledger.md) 所列 171 份 Markdown/DOCX 的读取和层级判定；
2. 先以产品边界、as-built、ADR、状态和 Release Plan 解决 current truth；
3. 再读 [资料与知识引导 Fixture](visual-direction-content-fixture.md)、[交互语言与视觉语义](interaction-language-and-visual-semantics.md)和 [Figma 交付登记](figma-delivery-register.md)；
4. 对任何文档没有支持的字段、对象、生命周期或页面标 `PROPOSED/BLOCKED`，不得通过视觉稿把它变成既成能力。

旧“买家详情 + RFQ 技术资格化”“固定产品技术规格准备度”或三方向选择要求全部视为 `SUPERSEDED_RESEARCH_PROVENANCE`；不得继续用作页面内容、对象建模或视觉批准依据。

## 5. 不可越过的门

### 5.1 事实门

- 产品边界以 `docs/product-scope.md` 为准；
- as-built 以 `docs/architecture/current.md`、当前代码和当前 OpenAPI 为准；
- 承重决策只认 `docs/adr/registry.md`；
- 进度以 `docs/status/current.md` 与 `docs/roadmap/release-plan.md` 为准；
- 旧 Word、Phase evidence、历史分支、记忆、Mock 和竞品只可发现候选，不覆盖 current truth。

### 5.2 对象与页面门

- 现有 76 个 Page ID 原样保留；
- 新能力先证明对象、生命周期、权限、SoR、深链、Metric、Guide 和退出；
- Phase 9 先使用 `CAND-P9-*` 与 `PFAM-P9-*` 候选 ID，不提前创造正式 `OBJ-FE-*`、`PAGE-FE-*` 或 `CAP-*`；
- 经产品 Gate 批准后才进入正式 Registry。

### 5.3 视觉门

- 2026-07-23 用户已确认五张界面足以作为当前视觉基线：今日工作队列、Site Editor、客户开发、Unified Inbox、AI 工作策略；不再生成三套方向让用户重复选择。
- 五张图只批准布局、密度、层级和视觉语言，不批准图中的示例业务事实、对象、接口或后端能力。
- 视觉基线为：瓷白工作面、深墨文字、克制品牌蓝、细边框、低阴影；稳定一级 Shell 与顶栏；按任务使用一至三栏，而不是每页强制右侧 Inspector。
- 客户资料通过引导填写、文件/图片上传、网站或店铺导入进入 Profile、Asset、KB/KnowledgeSource；问题和缺口按行业、市场、建站目标及已有资料动态产生，可以跳过并稍后补充。
- 当前合同只支持通用 Profile 五组、Asset、KB 文档/分块/动态 gaps 与 Offering/Claim/Evidence 等通用对象。行业字段可以是表单元数据、KB 抽取结果或 Offering attributes；没有合同前不得画成固定 `ProductFamily/Variant/TechnicalSpecification` 对象或全行业统一规格库。
- 不建立独立“资料准备度工作台”；Today 或 Site Onboarding 只显示可追溯的缺口、解析/审核状态和下一动作，不显示伪精确总分。
- Unified Inbox 当前只按目标产品设计为私密会话、分派、上下文和 AI 草稿面；在 SaaS SoR/合同未确定前，不新增 `RFQ Lite` 聚合或工程评审生命周期。
- 原 RFQ 技术资格化、固定 CNC 技术规格准备度和旧三方向图片只保留为 `SUPERSEDED_RESEARCH_PROVENANCE`，不得作为组件、Fixture 或工程事实。
- 全量文档快照、对象/SoR 校正和六个 Figma locator 已完成；用户已批准 Phase 0 范围，Foundations、State Lab 和五张核心高保真已进入草稿。正式组件库、全量页面、响应式、a11y 和用户验证仍未完成。

本纠偏优先于本阶段其他工作稿中关于旧 RFQ 视觉基准、旧三张图或完整工程评审的描述；相关 successor 未同步前，一律按上述边界解释，不得继续使用旧稿推进设计。

### 5.4 实现与采用门

- 本阶段不修改 TypeScript、Prisma、OpenAPI、Renderer、依赖、Compose、systemd 或生产配置；
- 不创建供应商生产账号、不接受新商业条款、不上传客户数据；
- API Adapter 研究不等于采用、生产或 License 批准；
- 不 iframe 拼接供应商后台，不让外部数据库成为核心业务 SoR。

## 6. Phase 9 完成定义

Phase 9 只有在以下证据齐全后才可请求 Gate：

1. `docs` 快照中的 171 份 Markdown/DOCX 均有路径、指纹、权威层级、读取状态、冲突和去向；
2. 每个能力能追到用户问题、对象、SoR、页面、API、状态、Scenario、Metric、Guide 和 Figma；
3. 当前 OpenAPI 操作全部标记为用户动作、内部运营动作或 backend-only；
4. Provider 有授权、scope、健康、回执、成本、安全、删除、导出和退出设计；
5. 所有稳定 Page ID 有 Manifest 2.0 和至少一张注释线框；
6. 独特交互模式和 12 条核心旅程有高保真代表与可点击原型；
7. 状态实验室覆盖 normal、empty、loading、partial、degraded、stale、denied、conflict、offline、ACK unknown、cancel-confirming 和 late result；
8. 真实目标角色完成两轮任务验证；AI 自评和作者走查不冒充用户验收。

当前包仍为工作稿；五张视觉基线已经选定，Phase 0 已获确认，Foundations、九张 SaaS 桌面代表页、产品官网首页和客户生成站首页完成第一轮 Figma 草稿与作者视觉 QA，76/76 Page Manifest 2.0 已完成第一轮登记；另已补五个关键状态、三张 390 宽移动端代表页、三条可点击原型骨架和一条桌面接力。其余状态/断点、12 条完整 Journey、逐页 Node、独立人工验证和任何实现/发布均未完成。
