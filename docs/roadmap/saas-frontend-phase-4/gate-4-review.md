# Gate 4 评审包

> 文档 ID：`GATE-FE-P4-001`
> 状态：`APPROVED_AT_GATE_4 / FROZEN_GATE_EVIDENCE`
> 授权：Gate 3 于 2026-07-20 通过并授权 Phase 4
> 工程基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 批准记录：2026-07-20，`DEC-FE-P4-001..011` 全部批准，保留 `BLK-FE-001..007`，授权 Phase 5

## 1. 结论

Phase 4 形成的统一 SaaS 全局前端规范已在 Gate 4 获批。所有模块使用同一套范围/权威、体验原则、用户/旅程、IA/Shell、权限、状态恢复、AI/Evidence/Approval、设计系统/内容、响应式/a11y/性能/i18n、合同接入、分析/测试/发布证据规则，不再各自发明 loading、403、审批卡、长任务、AI 结果或 Release 证明。

本阶段交付的是可批准的目标规范和可追踪设计资产，不是视觉定稿或实现。最重要的安全结论是：正式 repo/设计源/权限合同缺失不会被文档补猜；管理员不默认读个人工作数据；Claim 自动批准禁止；ACK 不明不猜终态；新任务失败保留旧结果；Preview 不冒充 Publish；没有隐私/Owner 时不引 tracking SDK。

## 2. 交付规模与入口

| 交付 | 数量/入口 | 解决的问题 |
|---|---|---|
| 全局前端文档 | 15 份，[入口](../../frontend/README.md) | 整个 SaaS 的跨模块体验与交付规范 |
| 设计治理文档 | 3 份，[入口](../../design/README.md) | 设计资产和微文案可版本化、可追踪 |
| 全局状态 | `STATE-FE-001..020` | 页面、长任务、部分成功、取消、ACK/冲突/恢复统一语义 |
| 设计资产记录 | 15 个 `DSA-FE-*` | 8 个书面规范资产 + 7 个待创建视觉/组件资产 |
| 微文案记录 | 16 个 `COPY-FE-*` | 状态、权限、AI、审批、成本、Preview 和支持文案意图 |
| Gate 4 决策 | 11 个 `DEC-FE-P4-*` | 产品负责人可以逐项批准/修改/拒绝 |
| 追踪更新 | Registry、Portal、Program plan | Phase 4 不成为第二套能力/对象/状态真值 |

## 3. Gate 4 推荐决定

建议整体批准 [开放决策包](../../frontend/13-open-decisions.md)中的：

1. `DEC-FE-P4-001`：12 条统一体验原则；
2. `DEC-FE-P4-002`：六项 IA 正式迁入全局规范和共享事实上下文；
3. `DEC-FE-P4-003`：六层能力/权限/批准/执行模型；
4. `DEC-FE-P4-004`：数据社会属性与管理员个人数据默认边界；
5. `DEC-FE-P4-005`：20 个全局状态和恢复原则；
6. `DEC-FE-P4-006`：AI→结构化对象→Evidence→Approval→execution auth 控制链；
7. `DEC-FE-P4-007`：Token/组件/设计资产/Copy ID 治理；
8. `DEC-FE-P4-008`：WCAG 2.2 AA、响应式/i18n/性能进入发布门；
9. `DEC-FE-P4-009`：客户端意图/服务端结果的 analytics 与隐私门；
10. `DEC-FE-P4-010`：Release Bundle 与发布后学习；
11. `DEC-FE-P4-011`：模块复用全局模式，例外须登记和到期。

这些决定批准规范方向，不批准具体工具、视觉值、KPI 目标或实现状态。

## 4. Gate 4 验收

| Gate 4 条件 | 结果 | 证据 |
|---|---|---|
| 所有模块可复用统一 loading/error/permission/approval 模式 | `READY_FOR_APPROVAL` | [状态](../../frontend/07-state-error-degradation-and-recovery.md)、[权限](../../frontend/06-permissions-and-data-visibility.md)、[AI/Approval](../../frontend/08-ai-approval-evidence-and-human-control.md) |
| IA/Shell 不再从各模块或 Mock 页面扩张 | `READY_FOR_APPROVAL` | [IA](../../frontend/02-information-architecture.md)、[Shell](../../frontend/05-navigation-and-workspace-shell.md)、[页面目录](../../frontend/04-page-and-capability-catalog.md) |
| 设计系统不是仅列“需要组件” | `PASS_WITH_DISCLOSED_SOURCE_BLOCKER` | [Token/组件合同](../../frontend/09-design-system-and-content-guidelines.md)定义层级、状态、a11y、版本和 review；实际设计源仍缺 |
| 设计资产有稳定 ID、Owner、版本和 Capability/Scenario 追踪 | `PASS` | [资产登记](../../design/design-asset-register.md)有 15 项；不存在的视觉资产明确 `REQUIRED_NOT_CREATED/NONE` |
| 微文案可治理和本地化 | `PASS` | [文案目录](../../design/content-and-microcopy-catalog.md)有 16 个 Copy ID、意图、变量、场景和 translation status |
| a11y/响应式/性能/i18n 不是发布后附录 | `READY_FOR_APPROVAL` | [非功能规范](../../frontend/10-responsive-accessibility-and-performance.md)以 WCAG 2.2 AA、当前 CWV 方向和明确证据门为基线 |
| 合同、埋点、测试与发布证据可追踪 | `READY_FOR_APPROVAL_WITH_BLOCKERS` | [接入](../../frontend/11-frontend-contracts-and-integration.md)、[分析/测试/发布](../../frontend/12-analytics-testing-and-release-evidence.md)；正式 schema/repo/Owner 仍缺 |
| 当前、目标、Mock、后置和 external-owned 不混写 | `PASS` | 所有文档声明 `ACTIVE_INPUT/Normative candidate`；Page/Capability 与 blocker 继续引用 Registry |
| 未越过 Phase 5 | `PASS` | 未创建 modules/Site Dev-Ready/实施方案/视觉稿/Fixture/Release Bundle/代码 |

## 5. 关键可复用模式

```text
Workspace/Object context
→ capability + entitlement + allowed action
→ page/task state
→ evidence + diff + human decision
→ explicit execution authorization
→ durable result/incident/recovery
→ analytics + release evidence + learning
```

模块只补对象特有状态、字段和业务动作。若要例外，必须给 Capability/Scenario、风险、替代 a11y/安全/恢复方案、Owner、有效期和回收条件。

## 6. 明确保留的 blocker

| Blocker | 影响 | 安全默认 |
|---|---|---|
| `BLK-FE-001` 正式 SaaS frontend repo/CI/deploy/assignee 缺 | 无法写 as-built 技术方案或施工 | `/global/frontend` 只读 Mock |
| `BLK-FE-002` 设计 assignee/事实源/Token values/组件/权利缺 | 无法视觉定稿和组件验收 | 书面规范可审；视觉资产保持未创建 |
| `BLK-FE-003` Workspace/Role/Entitlement/allowed actions 合同缺 | 权限/Shell 不能执行验收 | 服务端 fail-closed；客户端不建角色表 |
| `BLK-FE-004` Claim public review 或正式运营 SOP 缺 | Site 首个纵切不能完整自助 | 自动批准禁止；显式阻塞 |
| `BLK-FE-005` event/baseline/privacy/retention/Data Owner 缺 | 无法设 KPI 或引 tracking | 不用 Mock 数字，不引 SDK |
| `BLK-FE-006` QA/Ops/Security/Commercial assignee 缺 | 无人签发独立证据、兜底和商业/权利门 | AI 不代签 |
| `BLK-FE-007` Publish/Domain/Rollback/Inquiry/Analytics 合同缺 | 不能扩大首个承诺 | 保持后置/不可运行 |

Gate 4 可以在披露这些 blocker 的条件下批准“全局规范方向”；但 Phase 5 若要达到完整 Dev-Ready 和 Gate 5，必须关闭与 Site 纵切相关的 repo、设计、权限、Claim、QA/运营等输入。

## 7. 外部标准与设计判断

- a11y 最低目标来自 W3C [WCAG 2.2](https://www.w3.org/TR/WCAG22/) AA；WAI-ARIA APG 只作为组件行为实践，不冒充合规证明。
- 当前 Core Web Vitals 方向使用 web.dev 官方的 LCP/INP/CLS 和第 75 百分位口径；具体产品 SLO 待真实前端和数据 Owner 批准。
- 由于设计事实源缺失，本阶段没有按任何竞品风格生成视觉 Token；GoodJob 的可学习点只转成用户闭环、权限社会属性、状态/兜底、指南和治理方法。

## 8. 质量与边界声明

2026-07-20 最终收口检查的实际结果：

- 受控 Markdown 118 份，118 份均命中文档登记的精确入口或一个文档族规则；0 未登记。
- Document ID 53 个，0 重复；全仓真实相对文件链接 594 个，0 失效；本次 30 份 Markdown 中有 252 个相对链接。
- 本次 30 份 Markdown 均只有一个 H1、代码围栏成对、表格列结构一致、结尾换行合法；Phase 4 新文档无 `TODO/TBD/FIXME` 占位。
- 76 个正式 Page ID 与 Gate 2 来源集合完全相同，0 缺失、0 额外；15 个 Design Asset、16 个 Copy、20 个 State、11 个 Gate 4 Decision 均数量正确且定义内无重复。
- `git diff --check` 通过；diff 只在 `docs/`，没有产品代码、测试、Schema、migration、OpenAPI、基础设施、依赖或配置变化。
- 重新 fetch 后 `origin/main` 仍为 `676c6cd`，开放 PR 列表为空；本计划 worktree 未把其他分支/worktree 当成 main。
- 主工作区已删除前端模板和未跟踪 `.playwright-cli/`、流程图 HTML、`template/` 仍保持原状。

本阶段没有移动/删除/归档历史材料；没有 push、建 PR 或合并。上述检查证明文档结构、登记和追踪完整，不证明正式前端、设计、E2E 或生产部署。

## 9. Gate 4 决定记录

产品负责人确认：

`Gate 4 通过，按 DEC-FE-P4-001..011 批准全局前端规范，并在保留 BLK-FE-001..007 的前提下授权 Phase 5。`

因此本包冻结为批准证据；当前工作只进入 Phase 5，未自动授权前端/后端实现或 Phase 6–8。
