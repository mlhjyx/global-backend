# 设计资产登记

> 文档 ID：`DESIGN-FE-001`
> 层级：`L2 / Design registry`
> 生命周期：`CURRENT`
> 评审状态：`CURRENT / GATE_4_AND_5_APPROVED`
> Registry Owner：`OWN-DESIGN`

## 1. 资产状态

| 状态 | 含义 |
|---|---|
| `SPEC_REVIEW_CANDIDATE` | Git 中已有可评审的文字规范资产；不代表视觉/代码实现 |
| `SPEC_APPROVED` | Git 中的文字规范已通过对应产品 Gate；不代表受控视觉稿、代码实现或发布 |
| `REQUIRED_NOT_CREATED` | 已定义必要交付物和追踪，尚无受控设计源 |
| `VISUAL_REFERENCE_ONLY` | 可人工参考，provenance/权利/批准不足 |
| `DESIGNED` | 受控设计源中覆盖必要状态并经设计评审 |
| `VALIDATED` | 设计评审外还有用户/a11y/可用性证据 |
| `IMPLEMENTED` | 正式前端 repo 有映射实现；仍不代表部署 |
| `RELEASED` | Release Bundle 记录部署与验证 |
| `SUPERSEDED` | 有 successor、引用映射和迁移说明 |

## 2. 必填字段

每项资产必须具备：`asset_id`、名称、类型、source locator、source/version、status、Owner、rights/provenance、Capability/Page/Scenario、responsive/a11y coverage、last verified、successor。不存在时写 `NONE`，不得用空白表示已知。

## 3. Gate 4 已批准书面规范资产

| Asset ID | 资产 | Source / version | Owner | Capability / Scenario | Rights | 状态 |
|---|---|---|---|---|---|---|
| `DSA-FE-SYSTEM-001` | Semantic Token 与组件交付合同 | `docs/frontend/09-*` / `0.2-gate4-approved` | `OWN-DESIGN` | 全部 Capability | 仓内原创规范 | `SPEC_APPROVED` |
| `DSA-FE-IA-001` | 六项 IA 与对象层级图 | `docs/frontend/02-*` / `0.2-gate4-approved` | `OWN-PRODUCT` | `CAP-SHELL-001`；全域 map | 仓内原创规范 | `SPEC_APPROVED` |
| `DSA-FE-SHELL-001` | Workspace Shell 行为规格 | `docs/frontend/05-*` / `0.2-gate4-approved` | `OWN-DESIGN` | `CAP-SHELL-001`；`SCN-FE-SHELL-001..004` | 仓内原创规范 | `SPEC_APPROVED` |
| `DSA-FE-PERM-001` | 权限/数据可见性模式 | `docs/frontend/06-*` / `0.2-gate4-approved` | `OWN-SAAS-PLATFORM` | 全部；Shell 001..003 | 仓内原创规范 | `SPEC_APPROVED` |
| `DSA-FE-STATE-001` | 状态/长任务/恢复模式 | `docs/frontend/07-*` / `0.2-gate4-approved` | `OWN-DESIGN` | 全部；Site 002..018 | 仓内原创规范 | `SPEC_APPROVED` |
| `DSA-FE-AI-001` | AI/Evidence/Approval 控制模式 | `docs/frontend/08-*` / `0.2-gate4-approved` | `OWN-PRODUCT` | `CAP-SITE-CLAIM-001` 等；Site 009/010 | 仓内原创规范 | `SPEC_APPROVED` |
| `DSA-FE-A11Y-001` | 响应式/a11y/性能交付合同 | `docs/frontend/10-*` / `0.2-gate4-approved` | `OWN-DESIGN` | 全部 Capability/Scenario | 仓内原创规范 + 官方标准引用 | `SPEC_APPROVED` |
| `DSA-FE-COPY-001` | 跨模块微文案目录 | `docs/design/content-*` / `0.2-gate4-approved` | `OWN-DESIGN` | Shell/状态/AI/首个 Site 纵切 | 仓内原创文案 | `SPEC_APPROVED` |

## 4. 模块设计与待建立视觉资产

| Asset ID | 交付物 | 最低覆盖 | Owner | Capability / Scenario | Asset version | 状态 |
|---|---|---|---|---|---|---|
| `DSA-FE-SHELL-WF-001` | Shell + Today 低保真/交互原型 | Workspace switch、desktop/mobile、denied/offline/aggregate failure | `OWN-DESIGN` | `CAP-SHELL-001`；Shell 001..004 | `NONE` | `REQUIRED_NOT_CREATED` |
| `DSA-FE-PATTERN-STATE-001` | 状态与长任务 pattern board | `STATE-FE-001..020`、取消/ACK/旧结果 | `OWN-DESIGN` | `JRN-FE-007`；Site 002/013..017 | `NONE` | `REQUIRED_NOT_CREATED` |
| `DSA-FE-PATTERN-PERM-001` | permission/entitlement/approval pattern board | read/action denial、request/upgrade、redaction | `OWN-DESIGN` | Shell 001..003 | `NONE` | `REQUIRED_NOT_CREATED` |
| `DSA-FE-PATTERN-AI-001` | AI/Evidence/Approval pattern board | fact/inference/recommendation/draft、diff、bulk、fallback | `OWN-DESIGN` | Site 009/010；跨域 AI | `NONE` | `REQUIRED_NOT_CREATED` |
| `DSA-FE-SITE-WF-001` | Site 首个纵切页面流和关键线框 | `PAGE-FE-030..043` 合同相称范围、全状态/响应式/a11y | `OWN-DESIGN` | `JRN-FE-002/006/007`；Site 001..018 | `docs/design/independent-site-management-wireframes.md` / `0.2-gate5-approved` | `SPEC_APPROVED` |
| `DSA-FE-VISUAL-001` | 品牌/视觉方向与 semantic token values | 2–3 方向、对比、密度、图表、a11y、权利 | `OWN-DESIGN` | 全 SaaS | `NONE` | `REQUIRED_NOT_CREATED` |
| `DSA-FE-COMPONENT-001` | 正式组件库/Storybook 映射 | component contract、versions、visual/a11y tests | `OWN-SAAS-FE` | 全 SaaS | `NONE` | `REQUIRED_NOT_CREATED` |

## 5. 外部/本地参考

`/global/frontend`、`template/project-*`、Readdy、GoodJob 和竞品资产继续由 [文档登记](../governance/document-register.md)管理；本表不复制其文件，也不赋予商用权。若决定 Learn/Adapt，先完成来源、License、相似性、安全和退出评审，并创建新的内部 Asset ID，而不是复用外部名称。

## 6. 变更门

- Asset 版本变化必须列受影响 Component/Page/Scenario/visual baseline 和迁移窗口。
- `SPEC_APPROVED` 只承认书面产品规格；`DESIGNED` 需要真实设计 reviewer；`IMPLEMENTED` 需要正式 repo commit；`RELEASED` 需要 Release Bundle。AI 自评不能升级状态。
- 删除/重命名 ID 前先建立 successor 和引用映射；视觉稿过期不允许静默覆盖同一链接。
