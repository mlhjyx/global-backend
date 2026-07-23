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
| `CONTROLLED_FILE_EMPTY` | 已创建并登记受控设计文件，但尚无 Variables、组件或业务 Frame |
| `FOUNDATIONS_DRAFT` | 受控 Figma 已有 Variables、Styles、组件、模式或 State Lab；尚未完成发布与验证 |
| `HIGH_FIDELITY_DRAFT` | 受控 Figma 已有页面高保真和作者视觉 QA；尚未完成全状态、原型和目标用户验证 |
| `VISUAL_REFERENCE_ONLY` | 可人工参考，provenance/权利/批准不足 |
| `RESEARCH_MAPPED` | 已在受控设计源中形成可编辑研究/架构节点；不等于视觉方向、页面或组件已设计 |
| `DIRECTION_CANDIDATE` | 已有可比较的视觉方向稿；尚未完成用户选择、反向场景验证和设计评审 |
| `SUPERSEDED_RESEARCH_PROVENANCE` | 已被 successor 取代，只保留来源和废弃理由；不得进入选择、组件、页面规格或批准链 |
| `USER_SELECTED_VISUAL_BASELINE` | 用户确认其布局、密度和视觉语言可作为后续设计依据；示例业务内容、对象和 API 不随之获批 |
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
| `DSA-FE-VISUAL-001` | 品牌/视觉方向与 semantic token values | 用户选定视觉基线、对比、密度、图表、a11y、权利和 Token 验证 | `OWN-DESIGN` | 全 SaaS | `NONE` | `REQUIRED_NOT_CREATED` |
| `DSA-FE-COMPONENT-001` | 正式组件库/Storybook 映射 | component contract、versions、visual/a11y tests | `OWN-SAAS-FE` | 全 SaaS | `NONE` | `REQUIRED_NOT_CREATED` |

### 4.1 Phase 9 DRAFT 设计资产

以下使用候选键，不占正式 `DSA-FE-*` ID。五张用户基线已完成方向家族选择，但只有完成 current 内容替换、跨页面验证、受控 Figma、Token/a11y 和设计评审后，才申请迁入正式 Registry。

| Candidate asset | 交付物 | Source / node | Owner | 当前范围 | 状态 |
|---|---|---|---|---|---|
| `CAND-P9-DSA-001` | 研究、来源与决策板 | [Figma board](https://www.figma.com/board/vWBA5KkOtB56ECRGj2PXb4) · node `1:2` | `OWN-DESIGN` | 6 个中文研究区；不包含最终页面 | `RESEARCH_MAPPED` |
| `CAND-P9-DSA-002` | 信息架构、对象接力与集成旅程 | [Figma board](https://www.figma.com/board/8crRdLFh46S3V3z5vU8pLA) · root `0:1` | `OWN-DESIGN` | 中文架构/流程；不关闭 12 条逐屏原型 | `RESEARCH_MAPPED` |
| `CAND-P9-DSA-003` | Precision Console 旧方向 | [precision-console.png](../roadmap/saas-frontend-phase-9/assets/visual-directions/precision-console.png) | `OWN-DESIGN` | 旧 RFQ 技术资格化 Fixture；仅保留错误边界与 provenance | `SUPERSEDED_RESEARCH_PROVENANCE` |
| `CAND-P9-DSA-004` | Global Ops Cockpit 旧方向 | [global-ops-cockpit.png](../roadmap/saas-frontend-phase-9/assets/visual-directions/global-ops-cockpit.png) | `OWN-DESIGN` | 旧 RFQ 技术资格化 Fixture；仅保留错误边界与 provenance | `SUPERSEDED_RESEARCH_PROVENANCE` |
| `CAND-P9-DSA-005` | Industrial Dossier 旧方向 | [industrial-dossier.png](../roadmap/saas-frontend-phase-9/assets/visual-directions/industrial-dossier.png) | `OWN-DESIGN` | 旧 RFQ 技术资格化 Fixture；仅保留错误边界与 provenance | `SUPERSEDED_RESEARCH_PROVENANCE` |
| `CAND-P9-DSA-006` | Today 工作队列视觉基线 | [today-work-queue.png](../roadmap/saas-frontend-phase-9/assets/selected-ui-baseline/today-work-queue.png) | `OWN-DESIGN` | 任务优先、运行/活动、辅助建议与风险；示例内容不获批 | `USER_SELECTED_VISUAL_BASELINE` |
| `CAND-P9-DSA-007` | Site Editor 视觉基线 | [site-editor.png](../roadmap/saas-frontend-phase-9/assets/selected-ui-baseline/site-editor.png) | `OWN-DESIGN` | 结构—预览—设置；CNC/ISO/发布示例不获批 | `USER_SELECTED_VISUAL_BASELINE` |
| `CAND-P9-DSA-008` | Buyer Development 视觉基线 | [buyer-development.png](../roadmap/saas-frontend-phase-9/assets/selected-ui-baseline/buyer-development.png) | `OWN-DESIGN` | 高密度列表—详情—Evidence/动作；示例评分/联系人不获批 | `USER_SELECTED_VISUAL_BASELINE` |
| `CAND-P9-DSA-009` | Unified Inbox 视觉基线 | [unified-inbox.png](../roadmap/saas-frontend-phase-9/assets/selected-ui-baseline/unified-inbox.png) | `OWN-DESIGN` | 队列—会话—上下文与 AI 草稿；RFQ/金额/技术结论不获批 | `USER_SELECTED_VISUAL_BASELINE` |
| `CAND-P9-DSA-010` | AI Task Strategy 视觉基线 | [ai-task-strategy.png](../roadmap/saas-frontend-phase-9/assets/selected-ui-baseline/ai-task-strategy.png) | `OWN-DESIGN` | 管理员任务档位、策略和用量；具体模型/积分/API 不获批 | `USER_SELECTED_VISUAL_BASELINE` |
| `CAND-P9-DSA-011` | Foundations, Components & Patterns Figma 文件 | [Figma Design](https://www.figma.com/design/Ujjt9lNj0YibvXJjALyc0c) · State Lab `16:2` · Product Patterns `18:2` | `OWN-DESIGN` | 70 Variables、11 Text Styles、9 组组件、12 状态和五类模式；Library/属性/a11y 未冻结 | `FOUNDATIONS_DRAFT` |
| `CAND-P9-DSA-012` | SaaS App & Platform Ops Figma 文件 | [Figma Design](https://www.figma.com/design/RSZk3Xgg814cDmmqtaxZZw) · Core `6:2/9:2/10:2/11:2/12:2` · Cross-domain `23:*/29:119/30:2/31:2` · 状态 `18:*` · Mobile `20:*` · Prototype `22:*/24:*/32:*` | `OWN-DESIGN` | 十二张桌面代表页、五个关键状态、三张移动端代表页和五条 SaaS 原型骨架；全页面/状态/断点和用户验证未完成 | `HIGH_FIDELITY_DRAFT` |
| `CAND-P9-DSA-013` | Product Public Web, Help & Developer Figma 文件 | [Figma Design](https://www.figma.com/design/IMLSUMTQViEEauwBdzbczr) · 产品官网 `3:10` · 身份 `8:2` · 帮助 `6:2` · 开发者 `6:45` · Prototype `9:*` | `OWN-DESIGN` | 四张公共表面代表页和一条产品官网→安全激活原型；价格/信任/状态全页面与用户验证未完成 | `HIGH_FIDELITY_DRAFT` |
| `CAND-P9-DSA-014` | Generated Manufacturing Sites Figma 文件 | [Figma Design](https://www.figma.com/design/XlpWnitQlAodiF18wxPbDp) · 生成站首页 `3:10` | `OWN-DESIGN` | 动态资料驱动的生成站代表页；仍服从 TemplateFamily/DesignDNA，其余页面未完成 | `HIGH_FIDELITY_DRAFT` |
| `CAND-P9-DSA-015` | Site Editor 工业横幅生成素材 | [industrial-hero-v1.png](../roadmap/saas-frontend-phase-9/assets/generated/industrial-hero-v1.png) · SHA-256 `252261158dc7ecb0dc4140d9841110fff4e59f1e2a91d865cce74540f769fad3` | `OWN-DESIGN` | 无品牌/文字/人脸/技术声明的演示 Fixture；生产前仍需权利与相似性审核 | `VISUAL_REFERENCE_ONLY` |

## 5. 外部/本地参考

`/global/frontend`、`template/project-*`、Readdy、GoodJob 和竞品资产继续由 [文档登记](../governance/document-register.md)管理；本表不复制其文件，也不赋予商用权。若决定 Learn/Adapt，先完成来源、License、相似性、安全和退出评审，并创建新的内部 Asset ID，而不是复用外部名称。

## 6. 变更门

- Asset 版本变化必须列受影响 Component/Page/Scenario/visual baseline 和迁移窗口。
- `SPEC_APPROVED` 只承认书面产品规格；`DESIGNED` 需要真实设计 reviewer；`IMPLEMENTED` 需要正式 repo commit；`RELEASED` 需要 Release Bundle。AI 自评不能升级状态。
- 删除/重命名 ID 前先建立 successor 和引用映射；视觉稿过期不允许静默覆盖同一链接。
