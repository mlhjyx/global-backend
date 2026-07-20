# Phase 1 逐来源明细登记

> 文档 ID：AUD-FE-P1-010
> 状态：`COMPLETE_FOR_GATE_1`
> 核验日期：2026-07-20
> Git 基线：`c3f0cca80e228f08f35c89776f759748dac78ce2`

本表补足来源总账的逐项字段。除另有说明，以下 67 项均为 `format=Markdown`、`read_status=FULL_READ`、`last_verified_at=2026-07-20`、`last_verified_commit=c3f0cca80e228f08f35c89776f759748dac78ce2`。因此每行的“读取/版本”仍重复写出简记 `FULL · 07-20 · c3f0cca`，避免共享默认值被误读为未逐项核验。

权威层口径：`L0` 仓库执行/治理约束；`L1` 产品边界、as-built、ADR、状态等承重真值；`L2` 当前活设计、路线、契约与接入规范；`L3` 实施记录和机器证据；`L4` 研究/提案；`L5` 指南/模板；`L6` 兼容或历史材料。`FULL_READ` 只说明完成阅读，不提升来源权威。

| Source ID | 路径 | 格式 | 权威层 / 事实状态 | 产品/技术范围 | 读取 / 日期 / 提交 | 冲突来源 | 迁移去向 / 备注 |
|---|---|---|---|---|---|---|---|
| `SRC-MD-001` | `.codex/README.md` | Markdown | L0 / 活治理 | Codex 工作区 | FULL · 07-20 · c3f0cca | — | 保留为工具入口，引用 AGENTS |
| `SRC-MD-002` | `.github/pull_request_template.md` | Markdown | L0 / 活治理 | PR/验证 | FULL · 07-20 · c3f0cca | — | 保留；后续 Release Bundle 可链接 |
| `SRC-MD-003` | `AGENTS.md` | Markdown | L0 / 权威 | 全仓边界、环境、流程 | FULL · 07-20 · c3f0cca | `CLAUDE.md` | 保持仓库最高执行入口 |
| `SRC-MD-004` | `CLAUDE.md` | Markdown | L6 / 兼容历史 | 旧模型、环境、阶段 | FULL · 07-20 · c3f0cca | `CON-FE-008` | 只作兼容 provenance，不承重 |
| `SRC-MD-005` | `CONTRIBUTING.md` | Markdown | L0 / 权威 | Git、worktree、PR、恢复 | FULL · 07-20 · c3f0cca | — | 保留工程治理真值 |
| `SRC-MD-006` | `README.md` | Markdown | L5 / 活指南 | 仓库启动与概览 | FULL · 07-20 · c3f0cca | 部分状态随代码漂移 | Phase 3 门户引用，不复制状态 |
| `SRC-MD-007` | `docs/adr/registry.md` | Markdown | L1 / 权威 | 承重架构与产品决策 | FULL · 07-20 · c3f0cca | 旧 Word ADR 作废 | 保持唯一 ADR 注册表 |
| `SRC-MD-008` | `docs/architecture/current.md` | Markdown | L1 / as-built 权威 | 全后端与 Site Builder | FULL · 07-20 · c3f0cca | `CON-FE-012/021` | 后续 truth-sync；OpenAPI 数字机器生成 |
| `SRC-MD-009` | `docs/backend/ci-merge-automation.md` | Markdown | L2 / 活规范 | CI、审查、合并 | FULL · 07-20 · c3f0cca | — | 保留；Phase 3 链接质量门 |
| `SRC-MD-010` | `docs/backend/compose-project-migration.md` | Markdown | L2 / 活 runbook | Ubuntu/Compose 数据迁移 | FULL · 07-20 · c3f0cca | 旧 Mac/WSL 假设 | 保留运维指南 |
| `SRC-MD-011` | `docs/backend/discovery-sources.md` | Markdown | L2 / 活+历史混合 | 获客数据源 | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结能力地图/后端参考 |
| `SRC-MD-012` | `docs/backend/oss-registry.md` | Markdown | L2 / 活注册表（局部） | 获客 OSS 与 Adapter | FULL · 07-20 · c3f0cca | Word 候选范围更广 | Phase 7 扩展为全平台 registry |
| `SRC-MD-013` | `docs/backend/vocab-taxonomy.md` | Markdown | L2 / 活规范 | 词表/分类 | FULL · 07-20 · c3f0cca | — | 保留 Registry/Contract |
| `SRC-MD-014` | `docs/backend/worktree-management.md` | Markdown | L0 / 活治理 | worktree 生命周期 | FULL · 07-20 · c3f0cca | legacy 路径 | 保留；引用 provenance 审计 |
| `SRC-MD-015` | `docs/evidence/model-routing/model1-brand-profile-20260719-v20/README.md` | Markdown | L3 / active evidence index | MODEL-1 BrandProfile | FULL · 07-20 · c3f0cca | 旧 v1–v19 证据 | 保持 active bundle 入口 |
| `SRC-MD-016` | `docs/implementation-records/deletion-art17-residual-window.md` | Markdown | L3 / 实施记录 | 删除/隐私 | FULL · 07-20 · c3f0cca | — | Evidence/Reference，非产品指南 |
| `SRC-MD-017` | `docs/implementation-records/openfda-provider-spec.md` | Markdown | L3 / 实施记录 | openFDA 获客/intent | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结历史与实现证据 |
| `SRC-MD-018` | `docs/implementation-records/patent-cache-codex-p93-fixes.md` | Markdown | L3 / 实施记录 | 专利联系人缓存 | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结实现证据 |
| `SRC-MD-019` | `docs/implementation-records/site-builder-m1d-copy.md` | Markdown | L3 / 实施记录 | M1-d 文案/locale | FULL · 07-20 · c3f0cca | 旧待实现段落 | 保留并由 current status 引用 |
| `SRC-MD-020` | `docs/implementation-records/storage-compliance-spec.md` | Markdown | L3 / 实施记录 | 存储/合规 | FULL · 07-20 · c3f0cca | — | 保留证据参考 |
| `SRC-MD-021` | `docs/implementation-records/ted-provider-spec.md` | Markdown | L3 / 实施记录 | TED 发现/intent | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结实现证据 |
| `SRC-MD-022` | `docs/implementation-records/temporal-workflow-testing.md` | Markdown | L3 / 实施指南 | Temporal 测试 | FULL · 07-20 · c3f0cca | — | Phase 4/6 测试参考 |
| `SRC-MD-023` | `docs/implementation-records/trade-fair-intelligence.md` | Markdown | L3 / 实施记录 | 展会数据/合规 | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结实现证据 |
| `SRC-MD-024` | `docs/product-scope.md` | Markdown | L1 / 权威 | 产品面、ownership、非目标 | FULL · 07-20 · c3f0cca | 旧 Word/原型扩张 | 保持产品边界唯一真值 |
| `SRC-MD-025` | `docs/research/api-management.md` | Markdown | L4 / 研究 | API 管理 | FULL · 07-20 · c3f0cca | — | Phase 6 方案输入，不承重 |
| `SRC-MD-026` | `docs/research/buyer-intelligence-v3.md` | Markdown | L4 / 研究+历史输入 | 买家智能 v3 | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结产品地图/研究证据 |
| `SRC-MD-027` | `docs/research/discovery-architecture.md` | Markdown | L4 / 研究 | 发现 L0–L3 架构 | FULL · 07-20 · c3f0cca | 后续 as-built 已演进 | History/Evidence，引用 current architecture |
| `SRC-MD-028` | `docs/research/discovery-eval-round2.md` | Markdown | L4 / 评测证据 | 发现评测 | FULL · 07-20 · c3f0cca | 环境/模型会漂移 | Evidence，保留日期范围 |
| `SRC-MD-029` | `docs/research/discovery-eval.md` | Markdown | L4 / 评测证据 | 发现评测 | FULL · 07-20 · c3f0cca | 后续 round2 | History/Evidence |
| `SRC-MD-030` | `docs/research/platform-top-level-design-v1.md` | Markdown | L4 / dated proposal | 平台产品/架构/OSS | FULL · 07-20 · c3f0cca | `CON-FE-003/005/006/021` | Phase 2/6/7 输入，不覆盖权威链 |
| `SRC-MD-031` | `docs/research/positioning-and-acquisition-backlog.md` | Markdown | L4 / 研究 backlog | 定位/获客 | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结 backlog |
| `SRC-MD-032` | `docs/roadmap/changelog.md` | Markdown | L3 / 历史日志 | 全仓实施历史 | FULL · 07-20 · c3f0cca | 当前状态不可由此推导 | 保持 History，不承重 current |
| `SRC-MD-033` | `docs/roadmap/decision-maker-cross-source-identity-design.md` | Markdown | L4 / 设计提案 | 决策人身份归并 | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结 roadmap |
| `SRC-MD-034` | `docs/roadmap/decision-maker-multi-source-spec.md` | Markdown | L4 / 设计提案 | 多源决策人 | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结 roadmap |
| `SRC-MD-035` | `docs/roadmap/decision-maker-p0.4-mainchain-wiring-design.md` | Markdown | L4 / 设计提案 | 主链接线 | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结 roadmap |
| `SRC-MD-036` | `docs/roadmap/decision-maker-p1-companies-house-design.md` | Markdown | L4 / 设计提案 | Companies House | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结 roadmap |
| `SRC-MD-037` | `docs/roadmap/decision-maker-p1-google-patents-inventor-design.md` | Markdown | L4 / 设计提案 | Google Patents | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结 roadmap |
| `SRC-MD-038` | `docs/roadmap/decision-maker-p1-inpi-rne-dirigeant-design.md` | Markdown | L4 / 设计提案 | INPI RNE | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结 roadmap |
| `SRC-MD-039` | `docs/roadmap/decision-maker-p1-patent-cache-design.md` | Markdown | L4 / 设计提案 | 专利缓存 | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结 roadmap |
| `SRC-MD-040` | `docs/roadmap/release-plan.md` | Markdown | L1/L2 / 当前路线 | Site Builder 施工序 | FULL · 07-20 · c3f0cca | 未合并 R1-min branch | 保持主线路线真值 |
| `SRC-MD-041` | `docs/roadmap/sam-sources-sought-p4-design.md` | Markdown | L4 / 实施前设计 | SAM.gov | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结 roadmap |
| `SRC-MD-042` | `docs/roadmap/sanctions-screening-design.md` | Markdown | L4 / 实施前设计 | 制裁筛查 | FULL · 07-20 · c3f0cca | 获客侧冻结 | 冻结 roadmap |
| `SRC-MD-043` | `docs/site-builder/00-decisions-and-coordination.md` | Markdown | L1/L2 / 活协调真值 | Site Builder 决策/边界 | FULL · 07-20 · c3f0cca | 历史 owner 标签 | 保持 Site Builder 入口 |
| `SRC-MD-044` | `docs/site-builder/01-prd.md` | Markdown | L2 / 活产品设计 | Site Builder 产品范围 | FULL · 07-20 · c3f0cca | SaaS 原型目标扩张 | Phase 2/5 引用，不复制 |
| `SRC-MD-045` | `docs/site-builder/02-architecture.md` | Markdown | L2 / 活架构 | Site Builder bounded context | FULL · 07-20 · c3f0cca | R1-min 未合并 | 与 current architecture 交叉引用 |
| `SRC-MD-046` | `docs/site-builder/03-agents.md` | Markdown | L2 / 活设计 | 有界 AI Task/工具 | FULL · 07-20 · c3f0cca | 旧状态段落 | Phase 5/6 引用 task contract |
| `SRC-MD-047` | `docs/site-builder/04-sitespec-contract.md` | Markdown | L2 / 活契约说明 | SiteSpec | FULL · 07-20 · c3f0cca | `CON-FE-016/017/021` | 机器契约为最终实现真值 |
| `SRC-MD-048` | `docs/site-builder/05-deployment-hosting.md` | Markdown | L2 / 活设计+目标态 | Preview/Release/hosting | FULL · 07-20 · c3f0cca | `CON-FE-015/021` | R1-min 合入后 truth-sync |
| `SRC-MD-049` | `docs/site-builder/06-security-abuse.md` | Markdown | L2 / 活规范 | 安全、滥用、隐私 | FULL · 07-20 · c3f0cca | — | Phase 4/5 安全规范输入 |
| `SRC-MD-050` | `docs/site-builder/07-api-contract-draft.md` | Markdown | L2 / 活接口说明 | Site Builder API | FULL · 07-20 · c3f0cca | `CON-FE-013/021` | OpenAPI 为机器真值；后续接入指南 |
| `SRC-MD-051` | `docs/site-builder/08-eval-testing.md` | Markdown | L2/L3 / 活评测规范 | 模型/renderer/发布质量 | FULL · 07-20 · c3f0cca | `CON-FE-018/021` | Phase 4/5 质量门输入 |
| `SRC-MD-052` | `docs/site-builder/09-m1-implementation-design.md` | Markdown | L2 / 活施工设计 | M1/R1/R4 全链 | FULL · 07-20 · c3f0cca | 混合时期状态 | 由 release-plan/current status 指向 |
| `SRC-MD-053` | `docs/site-builder/10-model-selection-study.md` | Markdown | L3/L4 / dated study | 模型路由评测 | FULL · 07-20 · c3f0cca | active evidence 已 supersede 部分 | History/Evidence；不作 currentRoute 真值 |
| `SRC-MD-054` | `docs/site-builder/11-readdy-component-source-study.md` | Markdown | L4/L6 / dated research | Readdy 组件来源 | FULL · 07-20 · c3f0cca | `CON-FE-022` | 权利审核前 visual reference only |
| `SRC-MD-055` | `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.1.md` | Markdown | L6 / superseded proposal | Site Builder 总体旧稿 | FULL · 07-20 · c3f0cca | `CON-FE-021` | History；后续显著 banner/归档待授权 |
| `SRC-MD-056` | `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.2.md` | Markdown | L6 / dated proposal | Site Builder 总体旧稿 | FULL · 07-20 · c3f0cca | `CON-FE-021` | History；后续显著 banner/归档待授权 |
| `SRC-MD-057` | `docs/site-builder/13-design-domain-model.md` | Markdown | L2 / 活设计 | Design domain/DI | FULL · 07-20 · c3f0cca | `CON-FE-021` | DI-0 后 truth-sync；不冒充 runtime |
| `SRC-MD-058` | `docs/site-builder/14-media-foundation-mf0.md` | Markdown | L2 / 活设计+实现记录 | Media Foundation | FULL · 07-20 · c3f0cca | `CON-FE-021` | 保留；状态由 current 引用 |
| `SRC-MD-059` | `docs/site-builder/DQ-1-shared-sitespec-contract.md` | Markdown | L3 / 决策实施记录 | shared SiteSpec | FULL · 07-20 · c3f0cca | 后续 contract 已落 | History/Evidence |
| `SRC-MD-060` | `docs/site-builder/handoffs/r1-min-execution-brief.md` | Markdown | L2 / 当前 handoff | R1-min 边界/验收 | FULL · 07-20 · c3f0cca | 未合并 `r1-min-release` | 施工任务入口；main 不继承分支状态 |
| `SRC-MD-061` | `docs/status/current.md` | Markdown | L1 / 当前状态权威 | 全仓主线/完成度 | FULL · 07-20 · c3f0cca | `CON-FE-021` 的下游文档 | 保持状态唯一摘要 |
| `SRC-MD-062` | `docs/status/pilot-readiness-gap-report.md` | Markdown | L3/L4 / dated gap report | Pilot readiness | FULL · 07-20 · c3f0cca | 后续实现已演进 | History/Evidence，不作 current |
| `SRC-MD-063` | `docs/templates/前端技术方案模板.md` | Markdown | L5 / 模板 | 前端方案字段 | FULL · 07-20 · c3f0cca | 主工作区已删除，`CON-FE-007` | 用户现场不恢复；Phase 4/6 后再决定替代 |
| `SRC-MD-064` | `infra/systemd/README.md` | Markdown | L5 / 活 runbook | Temporal systemd | FULL · 07-20 · c3f0cca | — | 保留运维指南 |
| `SRC-MD-065` | `packages/contracts/INTEGRATION.md` | Markdown | L2 / 活接入指南 | OpenAPI/Site Builder integration | FULL · 07-20 · c3f0cca | `CON-FE-013` | Phase 4/6 更新；机器契约优先 |
| `SRC-MD-066` | `packages/contracts/README.md` | Markdown | L2/L5 / 活说明 | contracts package | FULL · 07-20 · c3f0cca | — | 保留开发者 reference |
| `SRC-MD-067` | `packages/contracts/events/WEBHOOK.md` | Markdown | L2 / 活契约指南 | Outbox/webhook | FULL · 07-20 · c3f0cca | SaaS consumer ownership 未定 | Phase 6 接缝规范 |

## 数量校正

逐项核对后，Git 基线实际为 **67** 份 Markdown / **13,810** 行，而非前一版来源总账和 Gate 1 报告中的 66 / 13,758。原因是早期统计命令使用了 `git ls-tree ... | rg`，对 Git 默认转义的中文路径末尾引号处理不完整，漏计了 `docs/templates/前端技术方案模板.md`。本表改用 NUL-safe 的 `git ls-tree -r -z --name-only` 重算并显式列出，后续文档已同步修正。

## 非 Markdown 关键来源的完整字段补表

| Source ID | 路径/URL | 格式 | 权威层 / 事实状态 | 产品/技术范围 | 读取 / 日期 / 版本 | 冲突来源 | 迁移去向 / 备注 |
|---|---|---|---|---|---|---|---|
| `SRC-WORD-001` | `docs/出海企业AI全球客户开发与增长执行平台_产品总体PRD_v3.0_完整评审稿.docx` | DOCX | L4 / dated proposal | 全产品 PRD、页面、旅程、状态 | FULL · 07-20 · SHA `b3759d9…` | `CON-FE-005/014/019/021` | Phase 2/4/5 输入；不覆盖活边界 |
| `SRC-WORD-002` | `docs/出海企业AI全球客户开发与增长执行平台_产品总纲与产品手册_v3.0_完整评审稿.docx` | DOCX | L4/L5 / dated proposal | 产品叙事、角色、指南 | FULL · 07-20 · SHA `5fcf59f…` | `CON-FE-005/014/021` | 产品门户/Guide 输入；重复事实不迁移 |
| `SRC-WORD-003` | `docs/出海企业AI增长平台_总产品手册与PRD_v2.0_完整产品母本.docx` | DOCX | L6 / superseded history | v2 产品母本 | FULL · 07-20 · SHA `7c174c5…` | v3 Word、current scope | History/provenance；不复活旧边界 |
| `SRC-WORD-004` | `docs/platform/全球客户开发与增长执行平台_顶层产品与系统架构设计_v1.0.docx` | DOCX | L4 / dated proposal | 平台分层、SaaS/能力服务 | FULL · 07-20 · SHA `e3e2674…` | `CON-FE-003/005/006` | Phase 2/6 方案输入；8 图需语义 alt |
| `SRC-WORD-005` | `docs/platform/全球客户开发与增长执行平台_v3.0文档体系重构与实施治理方案_v1.0.docx` | DOCX | L4 / governance input | 文档架构、RACI、Gate | FULL · 07-20 · SHA `68e66a8…` | 计划已吸收但未照搬 | Evidence/History；治理原则进入本计划 |
| `SRC-FE-001` | `/global/frontend/project-12080666` | React/Vite source | 外部本地输入 / Mock 原型 | 统一 SaaS 工作台 | CODE_AUDITED · 07-20 · no Git | `CON-FE-001/002/004/006/009/011/014` | 正式仓库/Owner 决策前只读原型 |
| `SRC-FE-002` | `/global/frontend/admin-frontend` | React/Vite source | 外部本地输入 / Mock 原型 | 管理端登录、用户列表 | CODE_AUDITED · 07-20 · no Git | ownership/identity 未决 | 管理端边界与仓库待 Gate 2 裁决 |
| `SRC-FE-003` | `/global/frontend/backend` | Spring source | 外部本地输入 / 冲突原型 | 身份、用户、admin API | CODE_AUDITED · 07-20 · no Git | `CON-FE-003/010/011` | 隔离；唯一身份 SoR 裁决前不接入 |
| `SRC-DES-001` | `/global/backend/template/project-12160144` | React/Vite export | L6 / visual reference | 页面/组件参考 | MACHINE_INVENTORIED · 07-20 · no Git | `CON-FE-022` | 权利审核前不复用/蒸馏 |
| `SRC-DES-002` | `/global/backend/template/project-12160157` | React/Vite export | L6 / visual reference | 页面/组件参考 | MACHINE_INVENTORIED · 07-20 · no Git | `CON-FE-022` | 同上 |
| `SRC-DES-003` | `/global/backend/template/project-12160179` | React/Vite export | L6 / visual reference | 页面/组件参考 | MACHINE_INVENTORIED · 07-20 · no Git | `CON-FE-022` | 同上 |
| `SRC-DES-004` | `/global/backend/template/project-12160196` | React/Vite export | L6 / visual reference | 页面/组件参考 | MACHINE_INVENTORIED · 07-20 · no Git | `CON-FE-022` | 同上 |
| `SRC-DES-005` | `/global/backend/template/project-12160207` | React/Vite export | L6 / visual reference | 页面/组件参考 | MACHINE_INVENTORIED · 07-20 · no Git | `CON-FE-022` | 同上 |
| `SRC-DES-006` | `/global/backend/template/project-12160221` | React/Vite export | L6 / visual reference | 页面/组件参考 | MACHINE_INVENTORIED · 07-20 · no Git | `CON-FE-022` | 同上 |
| `SRC-DES-007` | `/global/backend/template/project-12160238` | React/Vite export | L6 / visual reference | 页面/组件参考 | MACHINE_INVENTORIED · 07-20 · no Git | `CON-FE-022` | 同上 |
| `SRC-DES-008` | `/global/backend/template/project-12160249` | React/Vite export | L6 / visual reference | 页面/组件参考 | MACHINE_INVENTORIED · 07-20 · no Git | `CON-FE-022` | 同上 |
| `SRC-DES-009` | `/global/backend/template/project-12160304` | React/Vite export | L6 / visual reference | 页面/组件参考 | MACHINE_INVENTORIED · 07-20 · no Git | `CON-FE-022` | 同上 |
| `SRC-DES-010` | `/global/backend/template/project-12160415` | React/Vite export | L6 / visual reference | 页面/组件参考 | MACHINE_INVENTORIED · 07-20 · no Git | `CON-FE-022` | 同上 |
| `SRC-DES-011` | `/global/backend/docs/agile-iteration-flowchart.html` | HTML | 用户输入 / process proposal | 研发与质量流程 | FULL · 07-20 · SHA `690db875…` | `CON-FE-020` | Phase 3/4 流程裁决输入；不修改原件 |
| `SRC-DES-012` | `/global/backend/.playwright-cli/` | YAML/runtime artifact | 用户现场 / local evidence | 浏览器运行痕迹 | EXISTENCE_ONLY · 07-20 · untracked | provenance/正式基线未知 | 不作为受控视觉证据，不修改 |
| `SRC-EXT-GOODJOB-001` | `https://gitee.com/sendoh-huang/GoodJob/` | Git/Markdown/code | 外部竞品 / benchmark | CRM/获客/权限/文档方法 | FULL_DOCS+TESTED · 07-20 · `5732e20…` | 自述 vs E2E | 方法输入；不复制真值/页面 |

十项 Readdy 导出项目共享同一读取状态，是因为本阶段对全部文件做机器清点、对代表性实现做语义审读，而不是虚报 39,423 行全部 `FULL_READ`。具体规模、外链和风险见 [frontend-design-source-audit.md](frontend-design-source-audit.md)。二十项 OSS 的稳定 `SRC-OSS-001..020`、不可变上游提交、根许可证、本地关系和去向见 [external-benchmark-and-oss-audit.md](external-benchmark-and-oss-audit.md#8-oss-官方版本与许可证索引)。

## 其他非 Markdown 来源明细入口

- 5 份 Word：SHA-256、段落/表格/单元格、媒体、脚注/尾注/批注、超链接、状态和迁移去向见 [source-register.md](source-register.md)。
- 本地 SaaS、管理端、Spring、10 个模板和 HTML：逐路径规模、事实状态和缺口见 [frontend-design-source-audit.md](frontend-design-source-audit.md)。
- main 代码/契约/Prisma/Workflow/Renderer/测试：逐链路见 [implementation-evidence-matrix.md](implementation-evidence-matrix.md)。
- 分支、PR、worktree：见 [worktree-provenance.md](worktree-provenance.md)。
- GoodJob 与外部候选：见 [external-benchmark-and-oss-audit.md](external-benchmark-and-oss-audit.md)。
