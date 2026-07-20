# 前端开放决策与 Gate 4 决策包

> 文档 ID：`FE-GLOBAL-014`
> 层级：`L2 / Decision candidate`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_4_REVIEW`
> Decision Owner：`OWN-PRODUCT`

本文件只集中 Gate 4 需要批准的全局模式与仍需外部输入的 blocker。已批准 Gate 2 决策不重新投票；未到 Phase 5–8 的模块、技术和 OSS 决策不偷跑。

## 1. 建议在 Gate 4 批准的全局决定

| Decision ID | 建议批准内容 | 采用后的约束 | 不代表 |
|---|---|---|---|
| `DEC-FE-P4-001` | `EXP-FE-001..012` 作为统一 SaaS 体验原则 | 所有模块按结果/对象/Evidence/恢复/诚实状态设计 | 任何页面已设计或验证 |
| `DEC-FE-P4-002` | Phase 2 六项 IA 正式迁入 `docs/frontend/02`，Company/Claim/Evidence/Asset 为横切上下文 | 不再用旧 Word 或 Mock 导航作 current 方案 | 最终 route string/菜单视觉已定 |
| `DEC-FE-P4-003` | 采用 capability/entitlement/authorization/data scope/Approval/execution auth 六层模型 | 前端不自建角色/套餐/危险动作真值；未知 fail-closed | SaaS 权限合同已存在 |
| `DEC-FE-P4-004` | 数据社会属性分层；管理员不默认读取个人工作数据 | 例外需目的、政策、告知、范围和审计 | 隐私政策/角色矩阵已最终签署 |
| `DEC-FE-P4-005` | `STATE-FE-001..020` 与“保留旧结果/ACK 不明不猜终态”作为统一状态模型 | 模块不再各造 loading/error/cancel；partial/degraded/unknown 分开 | 所有后端错误已映射 |
| `DEC-FE-P4-006` | 采用 AI task→结构化对象→Evidence→Review→Approval→execution auth 控制链 | Global AI 不绕过对象/权限；Claim 自动批准禁止 | 模型/工具/Prompt 或 AI UI 已选定 |
| `DEC-FE-P4-007` | 采用 semantic token/组件合同/设计资产与 Copy ID 治理 | 无受控 source/version/Owner 不标 `DESIGNED` | 视觉方向、Token 数值、UI 库已定 |
| `DEC-FE-P4-008` | WCAG 2.2 AA 为最低目标，响应式/i18n/性能进入设计和发布门 | 关键场景需自动+人工证据，CWV 方向按当前官方口径校准 | 当前前端已合规或已满足 SLA |
| `DEC-FE-P4-009` | 采用客户端意图/服务端结果的 analytics 分层和 anti-metric | 未有 schema/privacy/Owner 不引 SDK；unknown/managed 分开 | KPI 目标/供应商已定 |
| `DEC-FE-P4-010` | 每个发布使用可追踪 Release Bundle 和发布后学习 | 规范、设计、合同、实现、证据、指南、运营一起收口 | Phase 4 已创建实际发布包 |
| `DEC-FE-P4-011` | 模块以例外机制复用全局模式 | 例外记录原因、风险、Owner、有效期和回收 | 禁止任何合理领域扩展 |

推荐整体批准。只批准部分时，其余保留 `OPEN_DECISION`，Phase 5 不得自行补猜。

## 2. Gate 4 仍无法关闭的 blocker

| Blocker | 当前缺失 | 推荐/安全默认 | 阻止范围 |
|---|---|---|---|
| `BLK-FE-001` | 正式 SaaS 前端 repo/remote/CI/deploy/assignee | 提供真实 repo；此前 `/global/frontend` 只读 Mock | as-built 前端方案、实现、部署 |
| `BLK-FE-002` | 设计 assignee、事实源、Token/组件/资产版本和权利 | 指定受控源；此前只使用书面规范资产 | 视觉定稿、组件复用、视觉回归 |
| `BLK-FE-003` | Workspace/Membership/Role/Entitlement/allowed actions 合同 | 服务端 fail-closed，前端不硬编码 | Shell、权限、入口与危险动作验收 |
| `BLK-FE-004` | Claim public review/impact contract 或正式运营 SOP | 自动批准禁止，显式阻塞 | 首个 Site 纵切完整自助 |
| `BLK-FE-005` | 事件 schema/baseline/privacy/retention/Data Owner | 不接 SDK、不设假 KPI | 指标验收和发布学习 |
| `BLK-FE-006` | QA/运营/安全商业实际 assignee | AI 不代签；帽子保持 `UNASSIGNED` | 独立证据、兜底、License/套餐/Release Gate |
| `BLK-FE-007` | Publish/Domain/Rollback/Inquiry/Analytics 合同/infra/privacy | 不纳入首个承诺 | 这些后置能力的 Dev-Ready/发布 |

Gate 4 可在公开披露这些 blocker 的情况下批准全局规则；但进入实际前端施工、视觉定稿或用户可用声明前，相关 blocker 必须关闭。

## 3. 后续技术/工具决策，不在 Gate 4 拍板

| Open ID | 决策 | 需要的输入 | 最迟 Gate |
|---|---|---|---|
| `OPEN-FE-TECH-001` | frontend framework/runtime/repo strategy | 正式 repo、团队、部署、SSR/SEO/安全/迁移比较 | Phase 5 实施方案前 |
| `OPEN-FE-TECH-002` | BFF/server component/direct API | ownership、auth、aggregation、latency、deploy | Phase 5 |
| `OPEN-FE-TECH-003` | contract generation/runtime validation | OpenAPI/event/version/toolchain/CI | Phase 5 |
| `OPEN-FE-DES-001` | design tool/source/branch/review workflow | Owner、访问、版本、导出/代码映射、权利 | Phase 5 视觉施工前 |
| `OPEN-FE-DES-002` | UI/component/icon/font library | 设计方向、a11y、license、bundle、exit | Phase 5/7 |
| `OPEN-FE-DATA-001` | analytics/observability vendor and consent | schema、privacy、region、retention、cost、exit | 实际埋点前 |
| `OPEN-FE-I18N-001` | i18n library、首发 UI locales、browser support | 客户数据、正式栈、QA 能力 | Phase 5 |
| `OPEN-FE-COMM-001` | packages/quotas/upgrade/downgrade/retention | 商业、财务、法务和数据政策 | 相应功能设计前 |
| `OPEN-FE-SUPPORT-001` | support impersonation/managed service policy | security/privacy/audit/SLA | Operations 实施前 |
| `OPEN-FE-SITE-001` | Publish/Domain/Inquiry 等后置对象/合同 | Product PDR/ADR、infra、privacy、SoR | 各能力 Gate |

## 4. Gate 4 通过后的状态变化

若产品负责人明确批准推荐组合：

- `docs/frontend/` 与 `docs/design/` 的书面规范从 Gate 候选升级为当前目标规范；
- Phase 3 Registry 将上述 Decision 标为 `APPROVED_AT_GATE_4`，并保留 blocker；
- 可进入 Phase 5 的独立站管理 Dev-Ready 文档包，但仍不能修改产品代码或开始前端施工，除非另有授权；
- 不会自动选择工具、关闭 Owner/合同缺口、扩大 Site 用户承诺或授权 Phase 6–8。

## 5. 建议 Gate 4 批准语句

`Gate 4 通过，按 DEC-FE-P4-001..011 批准全局前端规范，并在保留 BLK-FE-001..007 的前提下授权 Phase 5。`

也可以点名条件或拒绝项。收到明确批准前，任务停在 Gate 4。
