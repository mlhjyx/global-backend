# Gate 3 评审包

> 文档 ID：`GATE-FE-P3-001`
> 状态：`READY_FOR_GATE_3_REVIEW`
> 授权：Gate 2 于 2026-07-20 通过，按推荐组合授权 Phase 3
> 工程基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 当前授权终点：Gate 3；未获批准不得进入 Phase 4–8

## 1. 结论

Phase 3 已建立统一文档门户和七类规范 Registry，把 Phase 1 审计、Phase 2 批准决策、当前 main 实现、历史 Word/研究/原型/竞品及未来正式规范分开归位。

本阶段达到的不是“前端文档已经写完”，而是后续写任何正式 PRD、UX、前端方案、测试或 Guide 时都有稳定 ID、唯一责任帽子、状态语义、迁移去向和追踪入口，不再从旧 Word、Mock 页面或单份巨型稿重新发明真值。

## 2. 交付物

| 交付 | 入口 | 解决的问题 |
|---|---|---|
| 人类门户 | [docs/README.md](../../README.md) | 不同角色从哪里开始读、哪些材料不能当 current truth |
| 治理索引 | [governance/README.md](../../governance/README.md) | 七类 Registry 的边界和变更顺序 |
| 文档登记 | [document-register.md](../../governance/document-register.md) | 文档生命周期、唯一 Owner、旧稿 successor/迁移和文件动作门 |
| 术语/状态 | [terminology-and-status.md](../../governance/terminology-and-status.md) | 权威层、事实/文档/交付/场景状态、责任角色和关键术语 |
| 能力登记 | [capability-register.md](../../governance/capability-register.md) | 23 个全 SaaS 能力、16 个 Site 子能力、多轴状态和未来能力包 |
| 对象登记 | [core-object-register.md](../../governance/core-object-register.md) | 27 个核心对象、SoR、社会属性、生命周期和跨域 handoff |
| 场景目录 | [scenario-catalog.md](../../governance/scenario-catalog.md) | 30 个场景、10 个安全 Fixture manifest、失败/恢复和证据状态 |
| 冲突登记 | [conflict-register.md](../../governance/conflict-register.md) | 46 个历史冲突、9 个 Gate 2 决策、7 个当前 blocker |
| 追踪矩阵 | [traceability-matrix.md](../../governance/traceability-matrix.md) | 全产品粗粒度映射和首个 Site 纵切到合同/代码/测试/场景的细粒度映射 |

## 3. Gate 2 决策是否准确迁移

| 已批准面 | Phase 3 唯一落点 | 结果 |
|---|---|---|
| B2B 制造/工贸/传统出口首批客户 | Capability 与 traceability 默认 Segment | `MIGRATED` |
| 海外增长/外贸运营默认操作者 | Capability/Scenario Actor mapping | `MIGRATED` |
| 六项一级 IA | 全 SaaS capability area mapping | `MIGRATED`；正式 IA 仍属 Phase 4 |
| Company/Offering/Claim/Evidence/Asset 共享底座 | core object registry + handoff | `MIGRATED` |
| 首个纵切止于可信开发预览 | Site child capabilities + scenarios + traceability | `MIGRATED` |
| Claim fail-closed | `CAP-SITE-CLAIM-001`、Scenario 009/010、blocker | `MIGRATED_WITH_CONDITION` |
| 不承诺 Publish/Domain/Rollback/Inquiry/Analytics | 后置 Capability + `TARGET_NOT_RUNNABLE` scenarios | `MIGRATED` |
| 指标/反指标方向 | capability cross-cutting trace | `MIGRATED_WITH_CONDITION`；事件/基线/Owner 待定 |
| 正式前端/设计 Owner 未知 | `BLK-FE-001`、`BLK-FE-002` | `PRESERVED_AS_BLOCKER`，未补猜 |

## 4. Gate 3 验收

| Gate 3 条件 | 结果 | 证据 |
|---|---|---|
| 每个事实有唯一 Owner | `READY_FOR_APPROVAL_WITH_DISCLOSED_ASSIGNMENT_GAP` | Registry 按主题只指定一个 Owner ID；产品事实、文档关系、对象 SoR、合同/实现和证据责任已分帽子 |
| 未指派责任不被隐藏 | `PASS` | `OWN-DOC-GOV/SAAS-PLATFORM/SAAS-FE/DESIGN/DATA-PRIVACY/QA/OPS/SEC-COMMERCIAL` 的实际 assignee 明确为未指派或未记录 |
| 旧文档有迁移去向 | `PASS` | 所有受控 Markdown 命中精确登记或一个文档族规则；5 份 Word、Site v3.1/v3.2、本地原型、GoodJob/OSS 均有目标主题 |
| 同一事实不建立第二真值 | `PASS` | 门户只导航，Registry 分别只拥有文档/术语/能力/对象/场景/冲突/关系；Phase 1/2 冻结为 provenance |
| 历史稿在引用映射前不移动 | `PASS` | Phase 3 仅新增/修改 docs-only 治理产物；无移动、删除、归档、重命名或 banner 批量修改 |
| 当前/批准未建/冻结/外部/未知不混写 | `PASS` | 多轴能力状态、Object truth state、Scenario evidence status 和 Conflict status 分开 |
| 首个纵切可追踪 | `PASS` | 9 个关键 Site 子能力追到 Actor/Job/Journey/Page/Object/operationId/main path/TEST_ANCHOR/Scenario |
| 完整产品不丢失 | `PASS` | 23 个顶层 Capability、27 个对象、全部 Page family、8 条 Journey 的关系保留；冻结和外部能力为 map-only |

“唯一 Owner”在本 Gate 的含义是责任帽子唯一，避免一项事实多人/无人负责；它不伪造实际人员已经到岗。实际 assignee 未指派会阻止 Phase 4 设计定稿和实际前端施工，见 §6。

## 5. 机器与人工校验

Phase 3 收口时执行的非破坏性检查：

- 受控 Markdown：100 份，100% 命中文档登记的精确行或文档族规则；0 未覆盖。
- Document ID：33 个，0 重复。
- Registry ID：39 个 Capability（23 顶层 + 16 Site 子能力）、27 个 Object、30 个 Scenario、10 个 Fixture、46 个 Conflict、9 个 Gate 2 Decision、7 个 Blocker；各表 0 重复主键。
- 相对文件链接：过滤代码示例中的伪 Markdown 形状后，受控 Markdown 的真实相对链接 0 失效；新/修改文档的链接 0 失效。
- 新/修改 Markdown：每份恰好一个 H1，代码围栏成对，结尾换行合法，无待补占位标记。
- `git diff --check`：通过。
- 最新远端核验：`origin/main=676c6cd`，本分支基于同一提交仅含 docs-only checkpoints，开放 PR 列表为空。
- 主工作区核验：已删除前端模板和未跟踪 `.playwright-cli/`、HTML、`template/` 仍保持原样。

这些检查证明文档结构和关系完整，不证明产品代码、正式前端、E2E 或生产部署。

## 6. 明确保留的 blocker

| Blocker | 影响 | 安全默认 |
|---|---|---|
| 正式 SaaS 前端 repo/remote/CI/deploy/Owner 未指定 | 无法写可信的 as-built 前端技术方案或开始实现 | `/global/frontend` 继续只读 Mock 原型 |
| 设计 Owner、设计事实源、Token/组件/资产版本和权利未指定 | 无法定稿 UI、设计系统或做视觉验收 | 不把代码截图/Readdy 资产当规范 |
| Workspace/Role/Entitlement/allowed actions 合同缺 | 无法验收 Shell、权限和入口可见性 | 服务端 fail-closed，客户端不自建角色表 |
| Claim public review/impact contract 或正式运营 SOP 缺 | 首个纵切不能自助越过事实 Gate | 自动批准禁止；显式阻塞 |
| 指标事件、基线、目标、隐私/保留和 Data Owner 缺 | 不能把指标方向变成发布 KPI | 不接 tracking SDK，不用 Mock 数字 |
| QA、运营、安全/商业实际责任人未指定 | 不能签发独立证据、人工恢复、License/套餐和 Release Gate | AI 不代签 |
| Publish/Domain/Rollback/Inquiry/Analytics 合同缺 | 不能扩大首个用户承诺 | 保持 `TARGET_NOT_RUNNABLE/DEFERRED` |

## 7. 已发现但本阶段不修改的漂移

1. `docs/architecture/current.md` 仍手写 OpenAPI `40 paths`，机器契约当前为 56 paths / 64 operations / 13 Site operations；已登记 `CON-FE-012`，Phase 8 应删除或生成统计。
2. `packages/contracts/INTEGRATION.md` 的 R3-B1 段仍称 page/section、pages 和 de-DE 不可用，与当前代码/OpenAPI 的后续实现不一致；已登记 `CON-FE-013`，Phase 4/5 应按 operationId/生成类型修正接入视图。
3. `apps/site-renderer/src/lib/spec.ts` 仍是 JSON parse + TypeScript cast；R1-min 发布预检能 fail-closed unknown component，但不等于通用 runtime schema 已完成；`CON-FE-017` 保持合同硬门。
4. quality loop 仍有 `skipped_m1f` 语义；UI/Guide 必须诚实显示，M1-f 另 Gate。
5. Phase 1/2 的状态文本保持冻结时点，没有被 Phase 3 改写为“已批准/current”；批准结果只迁入 Registry。

这五项若在 Phase 3 顺手改写，会越过“只建设治理底座”的授权或破坏冻结 provenance，因此只登记、不施工。

## 8. 本阶段边界证明

- 只有 `docs/README.md`、`docs/governance/`、本 Phase 3 评审包和计划状态回写发生变化。
- 没有修改产品代码、测试、Schema、migration、OpenAPI、基础设施、依赖或配置。
- 没有进入 `docs/frontend/` 或编写独立站 Dev-Ready 文档。
- 没有移动/删除/归档 Word、研究稿、v3.1/v3.2、原型、分支或 worktree。
- 没有 push、创建 PR 或合并。

## 9. 请求 Gate 3 决定

请确认：

1. 是否接受“一类事实一个 Registry/Owner”的目标治理模式；
2. 是否接受旧 Word、Site v3.1/v3.2、Phase 1/2、本地原型、竞品和 OSS 的迁移去向；
3. 是否接受角色责任已唯一、但实际 SaaS/前端/设计/数据/QA/运营/安全 assignee 继续作为后续硬 blocker；
4. 是否接受 Phase 4 只建设全局前端规范，不提前进入独立站 Dev-Ready（Phase 5）或代码实现。

可用批准语句：`Gate 3 通过，授权 Phase 4`。也可有条件通过并点名需先修的 Registry、Owner 或追踪 finding。

收到明确批准前，当前任务停在 Gate 3；不会进入 Phase 4–8。
