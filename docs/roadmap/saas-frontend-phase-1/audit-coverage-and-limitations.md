# Phase 1 审计覆盖率与限制

> 文档 ID：AUD-FE-P1-011
> 状态：`COMPLETE_FOR_GATE_1`
> 审计基线：`main@c3f0cca80e228f08f35c89776f759748dac78ce2`
> 最后核验：2026-07-20
> 解释规则：100% 只代表已声明集合的读取或清点覆盖，不代表产品完成、生产部署或法律批准

## 1. 覆盖率总览

| 来源/证据面 | 已知集合 | 已覆盖 | 覆盖方式 | 仍有限制 |
|---|---:|---:|---|---|
| Git 基线 Markdown | 67 份 / 13,810 行 | 67 / 67（100%） | NUL-safe 清单重算；全文语义阅读；逐文件 `SRC-MD-001..067` | 本阶段新增文档不计入冻结基线；阅读不提升权威层 |
| Word 产品/架构/治理材料 | 5 份 | 5 / 5（100%） | 全文、表格、附录、字段、关系、媒体、脚注/尾注/批注和超链接清点；SHA-256 固定 | 图像原始 alt 仅为文件名，正式迁移时要补文字等价物 |
| 用户本地 HTML | 1 份 / 412 行 | 1 / 1（100%） | 全文读取并与现行质量流程交叉核验 | 未跟踪用户材料，仅作输入，未修改 |
| SaaS/管理端/Spring 本地代码源 | 3 个项目 | 3 / 3（100% 项目级） | 路由、页面、Mock、API、认证、配置、构建脚本和主要实现链审计 | 不是 Git 仓库；无可信部署 provenance；Spring 未编译 |
| Readdy 导出模板 | 10 个项目 | 10 / 10（100% 机器清点） | 逐项目文件、依赖、环境、外链、页面结构清点；代表样本语义审读 | 未逐行语义审读约 39,423 行生成代码；全部仍是 `VISUAL_REFERENCE_ONLY` |
| 设计事实源 | 扫描约定范围 | 100% 搜索执行 | 工作区、文档链接、配置、原型与历史现场检索 | Figma/Sketch/XD/Penpot、Token 包、Storybook、设计评审、正式部署 URL 均 `NOT_FOUND_IN_SCANNED_SCOPE` |
| Site Builder main 实现链 | 10 个链路层级 | 10 / 10 层级有结论 | 页面需求→契约→Controller→Service→Prisma→Temporal→Tool/Model→Renderer→测试/运行证据 | 这是抽样到能力链的语义审计，不声称逐行读完全仓全部业务代码 |
| OpenAPI/共享契约 | 56 paths / 64 operations | 100% 机器统计；关键 Site Builder 契约全文核验 | 直接读取导出 JSON、类型、DTO 和接入说明 | 手写文档数字已漂移；机器契约优先 |
| 模型路由 JSON | 92 份 | 92 / 92（100% 文件清点） | 全目录机器清点；active bundle 做语义核验 | 历史 bundle 未逐条重跑模型调用，不能证明今日模型行为 |
| worktree | 41 个 | 41 / 41（100% 列表登记） | `git worktree list --porcelain`；前端/Site Builder 相关现场做 commit/diff/status 深审 | 非相关历史现场未逐文件解释；未移动、清理或归档 |
| 开放 PR/远端分支 | 实时 GitHub/Git | 100% 查询执行 | `gh pr list`、`gh pr view`、远端 heads 和相对提交核验 | 审计过程中远端 main 发生一次合并，作为 post-baseline 事件单列 |
| GoodJob | 精确快照 1 个；13 MD + 2 txt | 15 / 15 文档读取；代码/测试定向核验 | 固定 commit、普通自测、47 项 Playwright | Gitee 远端刷新需认证，不能证明该快照仍是最新 HEAD |
| Word/研究列出的其余 OSS | 10 项 | 10 / 10（100% 初审） | 官方仓库 HEAD、不可变 commit、根 LICENSE、本地关系 | 不是安全/法务/商业/模型资产深审，不构成采用批准 |

## 2. 运行与质量证据覆盖

| 检查 | 本次结果 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| Prisma generate | PASS | 基线 Schema 可生成 client | 未执行迁移、未证明生产数据库状态 |
| Contracts build | PASS | 共享契约可编译 | 未证明 SaaS 前端已消费 |
| Spectral | 0 error / 15 warning | OpenAPI 无当前 error 级规则失败 | warning 仍需治理；不等于 API 行为正确 |
| API build | PASS | TypeScript 编译通过 | 不等于真实依赖/生产部署健康 |
| API Vitest | 193 files / 3,307 tests PASS | 当前单元/契约/完整性回归通过 | 未重跑会改变真实业务数据的 verify 脚本 |
| Renderer tests | 3 / 3 PASS | 当前 renderer 覆盖的 smoke 行为通过 | 未覆盖生产发布、全部坏输入和浏览器视觉回归 |
| SaaS 原型临时副本 | Vite build PASS；type-check FAIL 4；lint FAIL 1 error + 1 warning | 可构建且暴露真实静态质量缺口 | 不是部署/E2E/真实 API 证据；原目录未改 |
| 管理端临时副本 | Vite build PASS | 最小原型可打包 | 无 typecheck/lint/test scripts，不能升级质量状态 |
| Spring 原型 | `NOT_RUN` | 源码/配置事实已审 | 无 Maven Wrapper 且环境无 Maven；历史 `target/` 不作本次证据 |
| GoodJob | 普通 self-test PASS；Playwright 38 pass / 9 fail | 设计文档与真实 E2E 状态存在漂移 | 不代表其当前远端或生产状态 |

所有前端构建均在临时副本执行；没有写入 `/global/frontend`。未登录旧 Spring、未使用源码默认凭据、未连接其数据库，也未运行可能修改业务数据的真服务脚本。

## 3. 阶段 1 要求追踪

| 要求 | 证据 | 结论 |
|---|---|---|
| A. 全量来源登记 | [来源总账](source-register.md) + [逐来源明细](source-detail-register.md) + 各专项报告 | `SATISFIED_FOR_KNOWN_SCOPE` |
| B. 本地实现事实审计 | [实现证据矩阵](implementation-evidence-matrix.md) | `SATISFIED_AT_FROZEN_BASELINE` |
| C. SaaS 前端和设计源定位 | [前端与设计源审计](frontend-design-source-audit.md) | `SATISFIED_WITH_MISSING_INPUTS` |
| D1. 全量来源登记表 | `AUD-FE-P1-001/010` | `DELIVERED` |
| D2. 本地实现证据清单 | `AUD-FE-P1-002` | `DELIVERED` |
| D3. 产品能力多轴状态 | `AUD-FE-P1-003` | `DELIVERED` |
| D4. 冲突台账 | `AUD-FE-P1-004` | `DELIVERED` |
| D5. 前端/设计/组件/运行定位 | `AUD-FE-P1-005` | `DELIVERED` |
| D6. 缺失输入、风险、待决策 | `AUD-FE-P1-008` | `DELIVERED` |
| D7. 覆盖率和未完成项 | 本文 `AUD-FE-P1-011` | `DELIVERED` |
| D8. Phase 2 建议输入 | [Gate 1 评审](gate-1-review.md) §5；未实施 | `DELIVERED_NOT_EXECUTED` |

## 4. Gate 1 十二项验收追踪

| # | 验收项 | 结果 | 证据/保留意见 |
|---:|---|---|---|
| 1 | 所有已知相关材料有登记和阅读状态 | 满足 | 总账、逐 Markdown 明细及专项来源表；未知外部账号不冒充已扫描 |
| 2 | 五份 Word 覆盖正文/表格/附注/链接/图示/附录 | 满足 | 5/5 `FULL_READ`，结构和媒体统计见来源总账 |
| 3 | GoodJob/外部输入有日期和版本 | 满足 | GoodJob 精确 commit；20 项 OSS 固定上游 HEAD；滚动官方页带核验日期 |
| 4 | main/PR/分支/worktree 不混写 | 满足，有 post-baseline 事件 | 冻结基线与 #157 后续合并明确分栏；不把 branch presence 当 main |
| 5 | 每项 `AS_BUILT` 有相称证据 | 满足 | 能力矩阵和实现证据矩阵；没有用户入口/部署证据的均未标用户可用 |
| 6 | SaaS 前端/设计源定位，缺失显式标注 | 满足 | 三个本地项目已定位；正式设计事实源等为 `NOT_FOUND_IN_SCANNED_SCOPE` |
| 7 | 七类状态分开记录 | 满足 | 产品、UX、前端、API、数据/工作流、质量、用户可用性独立列 |
| 8 | 冲突/缺口/风险/待决策入账 | 满足 | 24 条冲突、14 项决策、9 项输入、15 项风险；post-baseline 事件补充登记 |
| 9 | 未改代码/基础设施/权威文档 | 满足 | diff 仅计划和 Phase 1 docs-only 文件 |
| 10 | 链接/Markdown/ID/状态/相对路径检查 | 满足 | `git diff --check` 通过；67 Markdown、20 OSS、10 template ID/路径机器对账；相对链接 0 错误；标题层级 0 跳级；87 个外部 URL 中 86 个公开可达，私有仓 PR #157 通过 `gh` 核验 |
| 11 | 主工作区用户现场不变 | 满足 | 全部施工在隔离 worktree；临时构建不写原目录 |
| 12 | checkpoint 只含计划和 Phase 1 文档 | 满足 | 提交候选共 12 个路径，仅计划文档和 `saas-frontend-phase-1/`；产品代码/配置/权威文档为 0 |

## 5. 审计期间发生的远端变化

冻结基线创建后，`origin/main` 于 2026-07-20 推进到 `676c6cdc175326927ec341a2d585168aa0a1a374`，GitHub PR [#157](https://github.com/mlhjyx/global-backend/pull/157) 已合并 R1-min，CI、contracts 和 gitleaks 均为成功；实时查询开放 PR 为 0。Phase 1 没有重写既有基线，也没有把 #157 的 3,159 行变更混入已经跑过的 `c3f0cca` 测试数字。

因此本文区分两类事实：

- `FROZEN_BASELINE_VERIFIED`：本审计矩阵、测试和能力结论对 `c3f0cca` 负责；
- `POST_BASELINE_EVENT_VERIFIED`：只确认 PR 元数据、合并提交和检查结论，尚未在本 worktree 对新 main 做同等深度重跑。

Gate 1 可以评审“审计方法、来源体系、重大产品/前端缺口和后续决策”；进入 Phase 2 前应从最新 main 新建/更新受控施工基线，并把 R1-min 对 Release、Preview、unknown component、恢复/回收和相关状态的变化纳入 delta truth-sync。该动作属于 Gate 1 之后的新阶段准备，本阶段不执行。

## 6. 明确未完成或不在本阶段执行的事项

- 没有进入 Phase 2–8，没有创建正式 `docs/frontend/`、PRD、UX Spec、设计系统或前端技术方案。
- 没有对正式前端仓库、导航、身份 SoR、商业套餐、权限模型、设计工具、数据权利或 OSS 采用作决定。
- 没有生产环境、真实 SaaS 部署入口、Figma/设计版本、埋点基线或用户研究原始证据。
- 没有重跑有副作用的真库/真服务 verify、迁移、发布、域名、SSL、询盘或分析链。
- 没有对所有 OSS 的依赖树、CVE、SBOM、模型权重、资产、连接器、云服务条款和商用情形给出法律结论。
- 没有刷新需要 Gitee 认证的 GoodJob 远端 HEAD；所有竞品结论固定到已登记快照。
- 没有 push、PR、merge、归档、删除、移动或清理用户/历史现场。

这些事项不是被隐藏的“完成项”，而分别属于 `MISSING_INPUT`、`OPEN_DECISION`、`POST_BASELINE_DELTA`、`NOT_RUN_WITHIN_NON_DESTRUCTIVE_BOUNDARY` 或后续 Phase/Gate。
