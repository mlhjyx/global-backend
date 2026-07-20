# 前端批准决策、开放技术项与 Blocker

> 文档 ID：`FE-GLOBAL-014`
> 层级：`L2 / Decision record`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_4`
> Decision Owner：`OWN-PRODUCT`

本文件记录 Gate 4 已批准的全局模式、仍需外部输入的 blocker，以及后续技术/工具开放项。产品负责人于 2026-07-20 按推荐组合批准 `DEC-FE-P4-001..011`；该批准不关闭 `BLK-FE-001..007`，也不构成实现或工具选择。

## 1. Gate 4 已批准的全局决定

| Decision ID | 批准内容 | 采用后的约束 | 状态 / 不代表 |
|---|---|---|---|
| `DEC-FE-P4-001` | `EXP-FE-001..012` 作为统一 SaaS 体验原则 | 所有模块按结果/对象/Evidence/恢复/诚实状态设计 | `APPROVED_AT_GATE_4`；不代表页面已设计/验证 |
| `DEC-FE-P4-002` | 六项 IA 迁入当前规范，Company/Claim/Evidence/Asset 为横切上下文 | 不用旧 Word 或 Mock 导航作 current 方案 | `APPROVED_AT_GATE_4`；不代表 route/视觉已定 |
| `DEC-FE-P4-003` | capability/entitlement/authorization/data scope/Approval/execution auth 六层模型 | 前端不自建角色/套餐/危险动作真值 | `APPROVED_AT_GATE_4`；权限合同仍缺 |
| `DEC-FE-P4-004` | 数据社会属性分层；管理员不默认读取个人工作数据 | 例外需目的、政策、告知、范围和审计 | `APPROVED_AT_GATE_4`；政策/角色矩阵未签署 |
| `DEC-FE-P4-005` | `STATE-FE-001..020` 和保留旧结果/ACK unknown 原则 | 模块不各造 loading/error/cancel | `APPROVED_AT_GATE_4`；错误映射未全实现 |
| `DEC-FE-P4-006` | AI task→对象→Evidence→Review→Approval→execution auth | AI 不绕过对象/权限；Claim 自动批准禁止 | `APPROVED_AT_GATE_4`；模型/Prompt/UI 未选择 |
| `DEC-FE-P4-007` | semantic token/组件合同/设计资产/Copy ID 治理 | 无受控 source/version/Owner 不标 `DESIGNED` | `APPROVED_AT_GATE_4`；视觉/UI 库未定 |
| `DEC-FE-P4-008` | WCAG 2.2 AA，响应式/i18n/性能进入发布门 | 关键场景需自动+人工证据 | `APPROVED_AT_GATE_4`；不声称当前合规 |
| `DEC-FE-P4-009` | 客户端意图/服务端结果 analytics 分层和 anti-metric | 无 schema/privacy/Owner 不引 SDK | `APPROVED_AT_GATE_4`；KPI/供应商未定 |
| `DEC-FE-P4-010` | Release Bundle 与发布后学习 | 规范/设计/合同/实现/证据/运营一起收口 | `APPROVED_AT_GATE_4`；尚无实际发布包 |
| `DEC-FE-P4-011` | 模块复用全局模式，例外需登记/到期 | 领域扩展要说明差异和回收 | `APPROVED_AT_GATE_4`；不禁止合理扩展 |

## 2. Gate 4 批准后仍保留的 blocker

| Blocker | 当前缺失 | 推荐/安全默认 | 阻止范围 |
|---|---|---|---|
| `BLK-FE-001` | 正式 SaaS 前端 repo/remote/CI/deploy/assignee | 提供真实 repo；此前 `/global/frontend` 只读 Mock | as-built 前端方案、实现、部署 |
| `BLK-FE-002` | 设计 assignee、事实源、Token/组件/资产版本和权利 | 指定受控源；此前只使用书面规范资产 | 视觉定稿、组件复用、视觉回归 |
| `BLK-FE-003` | Workspace/Membership/Role/Entitlement/allowed actions 合同 | 服务端 fail-closed，前端不硬编码 | Shell、权限、入口与危险动作验收 |
| `BLK-FE-004` | Claim public review/impact contract 或正式运营 SOP | 自动批准禁止，显式阻塞 | 首个 Site 纵切完整自助 |
| `BLK-FE-005` | 事件 schema/baseline/privacy/retention/Data Owner | 不接 SDK、不设假 KPI | 指标验收和发布学习 |
| `BLK-FE-006` | QA/运营/安全商业实际 assignee | AI 不代签；帽子保持 `UNASSIGNED` | 独立证据、兜底、License/套餐/Release Gate |
| `BLK-FE-007` | Publish/Domain/Rollback/Inquiry/Analytics 合同/infra/privacy | 不纳入首个承诺 | 这些后置能力的 Dev-Ready/发布 |

Gate 4 已在公开披露这些 blocker 的情况下批准全局规则；Phase 5 继续保留全部 blocker。进入实际前端施工、视觉定稿或用户可用声明前，相关 blocker 必须关闭。

## 3. 后续技术/工具决策，不在 Gate 4 拍板

| Open ID | 决策 | 需要的输入 | 最迟 Gate |
|---|---|---|---|
| `OPEN-FE-TECH-001` | frontend framework/runtime/repo strategy | 正式 repo、团队、部署、SSR/SEO/安全/迁移比较 | 实施 W0 前 |
| `OPEN-FE-TECH-002` | BFF/server component/direct API | ownership、auth、aggregation、latency、deploy | 实施 W0 |
| `OPEN-FE-TECH-003` | contract generation/runtime validation | OpenAPI/event/version/toolchain/CI | 实施 W0 |
| `OPEN-FE-DES-001` | design tool/source/branch/review workflow | Owner、访问、版本、导出/代码映射、权利 | 视觉施工前 |
| `OPEN-FE-DES-002` | UI/component/icon/font library | 设计方向、a11y、license、bundle、exit | 视觉施工/Phase 7 |
| `OPEN-FE-DATA-001` | analytics/observability vendor and consent | schema、privacy、region、retention、cost、exit | 实际埋点前 |
| `OPEN-FE-I18N-001` | i18n library、首发 UI locales、browser support | 客户数据、正式栈、QA 能力 | 实施 W0/W1 |
| `OPEN-FE-COMM-001` | packages/quotas/upgrade/downgrade/retention | 商业、财务、法务和数据政策 | 相应功能设计前 |
| `OPEN-FE-SUPPORT-001` | support impersonation/managed service policy | security/privacy/audit/SLA | Operations 实施前 |
| `OPEN-FE-SITE-001` | Publish/Domain/Inquiry 等后置对象/合同 | Product PDR/ADR、infra、privacy、SoR | 各能力 Gate |

## 4. Gate 4 已执行的状态变化

- `docs/frontend/` 与 Gate 4 书面设计规范已升级为当前目标规范；
- Phase 3 Registry 把上述 Decision 标为 `APPROVED_AT_GATE_4`，并保留 blocker；
- Phase 5 已建立[独立站管理 Capability Pack](modules/independent-site-management/README.md)，但没有修改产品代码或开始前端施工；
- 未选择工具、关闭 Owner/合同缺口、扩大 Site 用户承诺或授权 Phase 6–8。

## 5. Gate 4 批准记录

`Gate 4 通过，按 DEC-FE-P4-001..011 批准全局前端规范，并在保留 BLK-FE-001..007 的前提下授权 Phase 5。`

该语句已由产品负责人确认。当前 Gate 请求见 [Gate 5 评审包](../roadmap/saas-frontend-phase-5/gate-5-review.md)。
