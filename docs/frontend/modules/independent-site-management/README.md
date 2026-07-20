# 独立站管理 Capability Pack

> 文档 ID：`FE-SITE-000`
> 层级：`L2 / Capability Pack index`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`APPROVED_AT_GATE_5`
> Capability Owner：`OWN-PRODUCT`
> 设计 Owner：`OWN-DESIGN`（责任帽子；实际人员未指派）
> 工程基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 关联：`CAP-SITE-001..005`、`PAGE-FE-030..057`、`BLK-FE-001..007`

本包把“独立站管理”定义为统一 SaaS 内的一级能力。它不是另一个管理前端；Astro 站是该能力产生的版本化输出。本文档包同时写清当前合同能支撑的纵切、完整目标旅程和不可运行部分，防止从内部地基推导出公网发布已经存在。

## 1. 用户承诺与状态分层

默认用户是 B2B 制造、工贸和传统出口企业的海外增长/外贸运营。当前可设计到实施交接级的用户结果是：

```text
建立站点与安全 Demo
→ 补企业资料、素材和知识
→ 只使用可追溯且获准的事实
→ 启动、观察、取消或恢复 Build
→ 打开完整性校验后的可信开发预览
```

| Lane | 能力/Page | Phase 5 结论 | 能声称什么 | 不能声称什么 |
|---|---|---|---|---|
| 当前纵切 | `CAP-SITE-002/003`；`PAGE-FE-030..043` | `SPEC_READY_WITH_BLOCKERS` | 页面、状态、文案、合同消费、恢复和验收已形成规格 | 正式前端已实现、Claim 已自助闭环、用户可用 |
| 当前摘要 | `PAGE-FE-039/044` | `SPECIFIED_CONTROLLED_FALLBACK` | 引用删除影响和成本摘要有安全表达 | 完整引用管理、成本账单或套餐升级已建 |
| 后续编辑 | `PAGE-FE-045..047/052` | `APPROVED_NOT_BUILT` | 保留目标信息架构和依赖 | 编辑器、runtime write contract、主题系统已建 |
| 发布链 | `CAP-SITE-004`；`PAGE-FE-048..051` | `TARGET_NOT_RUNNABLE` | 目标状态、门和所需合同已列出 | 版本管理、公开发布、回滚、域名/SSL 可用 |
| 转化与洞察 | `CAP-SITE-005`；`PAGE-FE-053..056` | `TARGET_NOT_RUNNABLE` | 询盘/分析/诊断边界和隐私依赖已列出 | receiver、Conversation 投影、tracking、诊断已建 |
| 公开输出 | `CAP-SITE-PUBLIC-OUTPUT-001`；`PAGE-FE-057` | `PARTIAL_AS_BUILT_TARGET_SPECIFIED` | SiteSpec/Astro/10 组件和开发预览地基存在；目标输出规则已定义 | 公网服务、SEO 生产闭环、表单接收、正式域名存在 |

“规格就绪”只评价文档轴。正式前端仓库、设计源、权限/Claim 合同和真实验收责任人仍缺，因此当前纵切也没有升级为 `IMPLEMENTATION_READY` 或 `USER_READY`。

## 2. 文档地图

| 文档 | 唯一职责 |
|---|---|
| [用户旅程与页面规格](journeys-and-page-spec.md) | 首次建站、资料/信任、Build/恢复/预览和目标发布旅程；`PAGE-FE-030..057` manifest |
| [对象生命周期、权限与状态](lifecycle-permissions-and-state.md) | 对象关系、服务端状态、allowed action、安全默认、错误和恢复 |
| [公开站输出规范](public-site-output-spec.md) | SiteSpec/Astro 输出、内容、SEO、locale、a11y、性能、安全和 Preview/Publish 边界 |
| [运营与验收](operations-and-acceptance.md) | 运行手册、人工兜底、Scenario/Fixture、指标、证据和 Release readiness |
| [低保真线框](../../../design/independent-site-management-wireframes.md) | 页面流、宽/窄/移动布局和关键状态；不是视觉定稿 |
| [前端实施蓝图](../../implementation/independent-site-management-blueprint.md) | 技术栈中立的前端架构、接入顺序、测试与依赖门 |
| [Gate 5 批准证据](../../../roadmap/saas-frontend-phase-5/gate-5-review.md) | Phase 5 决定、验收、blocker 和批准记录 |

全局 Shell、权限、状态、AI 控制、设计系统、a11y、合同和 Release evidence 不在本包复制，仍以 [统一前端规范](../../README.md)为准。本包只补 Site 特有差异。

## 3. Capability Manifest

| 字段 | 当前值 |
|---|---|
| Primary actors | `ACT-FE-002` 海外增长/外贸运营；`ACT-FE-003` 资料协作者；`ACT-FE-005` 事实审批帽子 |
| Jobs | `JOB-FE-003..005`：准备可信资料、生成并恢复、判断预览是否可继续 |
| Capabilities | `CAP-SITE-001..005` 及 child IDs；当前纵切以 `002/003` 为中心 |
| Pages | 当前 `PAGE-FE-030..043`；摘要 `039/044`；目标 `045..057` |
| Objects | `OBJ-FE-003..008`、`OBJ-FE-012..017`、目标 `OBJ-FE-027` |
| Machine contract | `packages/contracts/openapi/openapi.json` 中 13 个 `SiteBuilder` operation；hidden preview resolver 另按代码证据 |
| Scenarios | `SCN-FE-SITE-001..018` 当前/合同场景；`019..023` 目标不可运行 |
| Fixtures | `FX-FE-WS-001`、`FX-FE-COMPANY-001`、`FX-FE-OFFERING-001`、`FX-FE-ASSET-001`、`FX-FE-DOC-001`、`FX-FE-CLAIM-001`、`FX-FE-SITE-001`、`FX-FE-BUILD-001`，当前均 `CATALOG_ONLY` |
| Metrics | 当前方向 `MET-SITE-001..014`；发布/询盘 `020..034` 未激活；`ANTI-FE-001..010` |
| Design | `DSA-FE-SITE-WF-001` 书面低保真；视觉/组件源仍受 `BLK-FE-002` 阻塞 |
| Copy | `COPY-FE-SITE-001..029`，均为未验证的 `DRAFT_SOURCE_COPY` |
| Evidence | main 代码、OpenAPI、Site Builder 活文档和场景目录；无正式前端 E2E/部署 evidence |

## 4. 当前机器合同边界

当前公开管理合同覆盖 13 个操作：intake；Site list/detail；profile get/patch；Asset presign/commit/list/delete；KB aggregate status；Build create/get/cancel。它们足以支撑受限纵切，但仍有以下边界：

- `Idempotency-Key`、`ETag/If-Match`、稳定错误码和 ACK unknown 必须作为交互合同，不得退化成按钮 Toast。
- Claim 有通用企业事实 API 和内部 Site bridge/snapshot，但缺少 Site 级 public review/impact/allowed-actions 闭环；`BLK-FE-004` 保留。
- Preview 是 active `READY` Release 的受完整性校验开发视图；hidden resolver 不是生产公开发布 API。
- internal `SiteRelease` 不等于用户可见版本历史、激活、回滚、Publish 或 Domain。
- `InquiryForm` 当前 `disabled_until_m2`；没有 receiver、持久化或投递。
- renderer 支持 `en`、`de-DE`、`ar` 渲染地基，但生成只支持 `en/de-DE`；`ar` 不能呈现为可生成语言。

## 5. 明确非目标

- 不在本包选择 React/Next/Vite、BFF、状态库、UI 库、i18n/analytics SDK 或部署平台。
- 不把本地 Mock、Markdown 线框或 Astro renderer token 当正式 SaaS 设计系统。
- 不创建产品代码、API、Schema、迁移、Fixture、测试数据或 Release Bundle。
- 不以客户端角色表补齐 SaaS allowed-actions，不以自动批准补齐 Claim，不以预览 URL 补齐发布。
- 不承诺公网 SLA、域名、回滚、询盘、分析、诊断、任意语言、任意组件或生产就绪。

## 6. Blocker 与交接结论

| Blocker | 本包采取的安全默认 | 关闭前阻止 |
|---|---|---|
| `BLK-FE-001` | 蓝图保持 stack-neutral，只写接口和边界 | 施工、as-built 架构、CI/部署 |
| `BLK-FE-002` | 只交付书面低保真，不设视觉值 | 视觉定稿、组件映射、视觉回归 |
| `BLK-FE-003` | 只消费服务端 allowed actions；未知即隐藏/禁用并解释 | 权限与入口 E2E |
| `BLK-FE-004` | Site Claim 自动批准禁止；审核入口显式阻塞 | 当前纵切完整自助 |
| `BLK-FE-005` | 事件只作 schema hypothesis；不接 SDK、不设目标值 | KPI 验收和学习闭环 |
| `BLK-FE-006` | QA/Ops/Security/Commercial 只保留责任帽子 | 独立签发、运营兜底、Release Gate |
| `BLK-FE-007` | 后置页面保留目标规格且不可操作 | Publish/Domain/Rollback/Inquiry/Analytics Dev-Ready |

Gate 5 已批准本 Capability Pack 的产品/UX/接入规格：当前开发预览纵切为 `SPEC_READY_WITH_BLOCKERS`，后置链保持 `TARGET_NOT_RUNNABLE`；该批准没有启动实现或关闭任何 blocker。
