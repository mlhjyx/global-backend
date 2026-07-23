# 核心对象、SoR 与生命周期登记

> 文档 ID：`GOV-FE-004`
> 层级：`L1 / Registry`
> 状态：`CURRENT`
> 事实 Owner：`OWN-PRODUCT`
> 批准来源：Gate 2 推荐组合，2026-07-20
> 工程核验基线：`origin/main@73f08f9f6b474b16a92e139f2c83cffcc8a6fb92`

本表是跨产品域 Object ID、System of Record、社会属性和业务生命周期的唯一登记；Prisma、OpenAPI 和事件仍是机器实现真值。审批论证保留在 Git/PR，不再维护平行对象清单。

## 1. 登记规则

- `SoR` 是唯一业务真相写入方，不等于页面所在产品域，也不等于缓存、投影或外部副本。
- `Object Owner` 对对象定义和 SoR 负责；具体页面、API、数据、质量仍由各责任帽子签发。
- 一个对象可在多个域出现，但只能有一个 canonical object identity；聚合页和读模型不取得对象 ownership。
- 个人数据、个人草稿、公开候选和系统诊断具有不同社会属性，管理员身份不自动等于无限读取。
- 当前没有证据的对象保持 `PROPOSED / EXTERNAL_OWNED / OPEN_DECISION`，不得用原型页面补成 as-built。

## 2. 核心对象总表

| Object ID | 规范名称 / 用户名称 | 当前 SoR | Object Owner | 事实状态 | 主域 / 社会属性 | 生命周期或边界 |
|---|---|---|---|---|---|---|
| `OBJ-FE-001` | Workspace / 工作空间 | 外部 SaaS 平台 | `OWN-SAAS-PLATFORM` | `EXTERNAL_OWNED`；本仓只消费 tenant anchor | Shell / Workspace 根 | 正式生命周期合同未定位 |
| `OBJ-FE-002` | Membership、Role、Entitlement / 成员、角色、套餐能力 | 外部 SaaS 平台 | `OWN-SAAS-PLATFORM` | `EXTERNAL_OWNED`；本仓无用户表 | Shell / 权限与商业敏感 | allowed actions 必须由服务端决定 |
| `OBJ-FE-003` | CompanyProfile / 企业资料 | 本仓企业事实域 | `OWN-TRUTH-BE` | `AS_BUILT` | 企业与信任 / Workspace 共享 | `LC-COMPANY-001` |
| `OBJ-FE-004` | Offering / 产品或服务 | 本仓企业事实域 | `OWN-TRUTH-BE` | `AS_BUILT` | 企业与信任 / Workspace 共享 | 统一 CRUD/版本/市场适用范围仍不完整 |
| `OBJ-FE-005` | KnowledgeSource、KbDocument / 资料来源、知识文档 | 企业事实域 + Site Builder 局部对象 | `OWN-TRUTH-BE` | 两套来源对象并存；Site 子集 `AS_BUILT` | 企业与信任/Site / 共享或受限 | `LC-KB-001`；跨域统一 identity 待设计 |
| `OBJ-FE-006` | Claim / 企业事实声明 | 本仓企业事实域 | `OWN-TRUTH-BE` | `AS_BUILT`；公开审核入口不完整 | 企业与信任 / 公开候选 | `LC-CLAIM-001` |
| `OBJ-FE-007` | Evidence / 证据 | 本仓企业/数据域 | `OWN-TRUTH-BE` | `AS_BUILT` | 企业与信任 / 来源与权利敏感 | 绑定 Claim、来源、hash、quote、时间和 Asset |
| `OBJ-FE-008` | Asset、AssetVariant / 素材、派生版本 | Site Builder DB + 对象存储 | `OWN-SITE-BE` | `AS_BUILT` | 企业与信任/Site / 权利与公开范围敏感 | `LC-ASSET-001` |
| `OBJ-FE-009` | ICP / 理想客户画像 | 本仓 Buyer Intelligence | `OWN-BUYER-BE` | `AS_BUILT/FROZEN` | 客户开发 / Workspace 共享 | 新增前端施工冻结 |
| `OBJ-FE-010` | CanonicalCompany、Lead / 买家公司、线索 | 本仓 Buyer Intelligence | `OWN-BUYER-BE` | `AS_BUILT/FROZEN` | 客户开发 / 公司共享、联系人受限 | Lead 是 ICP×Company，不回写公司级 fit |
| `OBJ-FE-011` | LeadQualifiedPackage / 合格线索包 | 本仓不可变快照 + Outbox | `OWN-BUYER-BE` | `AS_BUILT/FROZEN` | 客户开发→SaaS / 交付快照 | `LC-LEAD-PACKAGE-001` |
| `OBJ-FE-012` | Site / 独立站 | 本仓 Site Builder | `OWN-SITE-BE` | `AS_BUILT` | 独立站管理 / Workspace 共享 | `LC-SITE-001`；不能代替 Build/Release/Publish 状态 |
| `OBJ-FE-013` | SiteVersion / 站点版本 | 本仓 Site Builder | `OWN-SITE-BE` | `AS_BUILT` | 独立站管理 / 不可变内容版本意图 | Build/manual/demo 来源；不是部署产物 |
| `OBJ-FE-014` | SiteRelease / 构建产物单元 | 本仓 Site Builder | `OWN-SITE-BE` | internal substrate `AS_BUILT`；public management 未建 | 独立站管理 / 不可变产物与运维 | `LC-RELEASE-001` |
| `OBJ-FE-015` | SiteBuildRun、Step / 生成任务、步骤 | 本仓 DB + Temporal | `OWN-SITE-BE` | `AS_BUILT` | 独立站管理 / 团队任务与受控诊断 | `LC-BUILD-001` |
| `OBJ-FE-016` | SiteBuildBudget、Spend / 构建预算、成本 | 本仓 Site Builder ledger | `OWN-SITE-BE` | `AS_BUILT` | Site/洞察 / 商业运营敏感 | reported/calculated/estimated/unknown 分层 |
| `OBJ-FE-017` | BrandProfile、PublishableClaimSnapshot、CopyBundle / 品牌理解、发布事实快照、文案包 | 本仓 Site Builder | `OWN-SITE-BE` | internal `AS_BUILT`；通用编辑 API 未建 | 独立站管理 / 派生与不可变输入 | 不反向覆盖 Company/Claim SoR |
| `OBJ-FE-018` | Goal、Initiative、Campaign / 目标、增长计划、战役 | SaaS 业务域 | `OWN-SAAS-PLATFORM` | `PROPOSED/EXTERNAL_OWNED` | 增长执行 / Workspace 共享 | 正式 SoR/repo/状态机未定位 |
| `OBJ-FE-019` | ContentAsset、PublishJob / 内容、发布任务 | SaaS 内容与执行域 | `OWN-SAAS-PLATFORM` | `PROPOSED/EXTERNAL_OWNED` | 增长执行 / 共享与公开候选 | Content 与发布回执必须分离 |
| `OBJ-FE-020` | Conversation、Message、Intent / 互动、消息、意向 | SaaS 互动域 | `OWN-SAAS-PLATFORM` | `EXTERNAL_OWNED`；当前实现未定位 | 互动与商机 / 个人数据与受限 | 不能由 Site Inquiry 或原型复制主状态 |
| `OBJ-FE-021` | Opportunity、QGO、SAO / 商机 | SaaS 商机域 | `OWN-SAAS-PLATFORM` | `EXTERNAL_OWNED`；当前实现未定位 | 互动与商机 / 商业敏感 | `LC-OPPORTUNITY-001` 仅为目标原则 |
| `OBJ-FE-022` | CommercialOutcome / 商业结果 | SaaS 商机域 | `OWN-SAAS-PLATFORM` | `EXTERNAL_OWNED` | 商机/洞察 / 商业敏感 | 本仓只接收学习标签，不接管主状态 |
| `OBJ-FE-023` | Touchpoint、Attribution、Recommendation / 触点、归因、建议 | SaaS 分析读模型 | `OWN-SAAS-PLATFORM` | `PROPOSED/EXTERNAL_OWNED` | 洞察 / 聚合读模型 | 不成为业务对象写入 SoR |
| `OBJ-FE-024` | Integration、CredentialRef / 集成、凭据引用 | SaaS 控制面 + Secret store | `OWN-SAAS-PLATFORM` | `EXTERNAL_OWNED` | Shell/运营 / 高敏感 | UI 永不持有明文 Secret 真值 |
| `OBJ-FE-025` | Approval、Authorization / 审批、执行授权 | SaaS Policy/Control Plane；域内决定写回对象 | `OWN-SAAS-PLATFORM` | `PROPOSED/EXTERNAL_OWNED`；Claim 有局部事实 | Shell/跨域 / 审计决定 | Phase 4 候选已分 Approval/execution auth；机器合同仍缺，不建万能聚合根 |
| `OBJ-FE-026` | Notification、Task、Incident / 通知、任务、异常 | SaaS 聚合读模型 + 域事件 | `OWN-SAAS-PLATFORM` | `PROPOSED` | Shell/运营 / 个人或团队范围待定 | Phase 4 候选要求数据社会属性和深链；读模型合同仍缺 |
| `OBJ-FE-027` | Inquiry / 站点询盘 | 原始接收边界 + SaaS 投影待 ADR | `OWN-PRODUCT` | `DEFERRED/OPEN_DECISION` | Site→互动 / 个人数据 | `LC-INQUIRY-001` 目标边界，M2 前必须裁决 |

## 3. 对象社会属性

| Social class ID | 属性类 | 典型对象 | 默认可见/协作原则 | 必须由谁补合同 |
|---|---|---|---|---|
| `SOC-FE-001` | Workspace 共享业务事实 | Company、Offering、Claim、Evidence、Site、Version、Asset、ICP、Lead、Campaign、Opportunity | 在服务端权限范围内协作，修改和批准可审计 | `OWN-SAAS-PLATFORM` + 各域 Owner |
| `SOC-FE-002` | 公开候选与公开输出 | approved Claim、待发布内容、future published Release | 只有明确批准、权利和适用范围后公开 | `OWN-PRODUCT` + `OWN-DATA-PRIVACY` |
| `SOC-FE-003` | 个人工作草稿 | 私人备注、个人待办、未共享草稿、个人搜索 | 管理员不默认无限可见；转团队和离职移交需政策 | `OWN-SAAS-PLATFORM` |
| `SOC-FE-004` | 受限个人数据 | 联系人、询盘人、业务邮箱/电话、DSR | 用途绑定、最小可见、保留和审计 | `OWN-DATA-PRIVACY` |
| `SOC-FE-005` | 系统控制与诊断 | BuildRun、TaskAttempt、Spend、ProviderHealth、Incident | 普通用户看业务摘要；运营看受控诊断 | `OWN-OPS` + 技术 Owner |
| `SOC-FE-006` | 外部执行副本 | CRM、Chatwoot、渠道发布记录 | 平台业务对象仍为 SoR；外部只保留副本/回执 | `OWN-SAAS-PLATFORM` |

前端隐藏字段或按钮不构成授权。任何对象动作至少需要服务端返回有效权限/allowed actions 和安全拒绝语义。Phase 4 的目标矩阵见 [权限与数据可见性候选](../frontend/06-permissions-and-data-visibility.md)；Gate 4 批准也不会补出尚不存在的服务端合同。

## 4. 当前已建生命周期

### `LC-COMPANY-001` CompanyProfile

```text
DRAFT → ENRICHING → REVIEW → ACTIVE
```

- `ACTIVE` 必须有人工确认或相称审批，不能把自动抽取直接当可公开事实。
- 创建可来自 intake/企业理解流程；编辑、激活、字段历史和多 Profile 策略尚未形成完整 SaaS 合同。
- 与 Offering、Claim、Evidence、Asset、Site 强关联，删除不能由前端简单级联。

### `LC-CLAIM-001` Claim / Evidence

```text
INGESTED → EXTRACTED → NEEDS_REVIEW → APPROVED → EXPIRED | REVOKED
                              └──────→ conflict/reject 语义待公共合同
```

- Site bridge 生成的 Claim 只进入 `NEEDS_REVIEW`；禁止自动升级为 `APPROVED`。
- APPROVED 必须绑定精确 Claim/Evidence/bridge；认证还需同 Site 的 live ready cert Asset。
- 新 Build 只使用 approved/current/audited Claim 形成不可变 snapshot。
- 撤销/过期后的影响面、紧急下线和已发布版本处理仍需正式体验/合同。

### `LC-ASSET-001` Asset / Variant

```text
pending_upload → committing → queued/processing → ready
                          ├→ failed_retryable
                          ├→ rejected
                          ├→ duplicate
                          └→ deleted (tombstone + async cleanup)
```

- presign、客户端 PUT、commit、processing 和 ready 是不同事实。
- `duplicate` 是可解释结果，不是普通系统失败。
- 删除前要检查 Profile、active SiteSpec、Claim/Evidence 和 worker 引用；409 必须提供解除/等待路径。
- tombstone 不等于对象存储已物理清除；Variant 是派生物，不成为原始权利记录。

### `LC-KB-001` KbDocument

```text
queued → parsing → chunking → embedding → ready | failed
```

公共合同目前只提供 Asset 处理状态和 KB 汇总；不得在 UI 冒充已存在文档级完整管理。

### `LC-SITE-001` Site

当前字段包含 `draft | building | ready | published`，DTO 另有 `setup_failed` 声明。该差异保持已登记冲突；正式 UI 必须把以下四层分开：

1. Site 业务状态；
2. BuildRun 任务状态；
3. SiteRelease 产物状态；
4. future public service 状态。

一个 badge 不能表达“旧站仍可预览，但最新 Build 失败”或“Build 成功但尚未公开发布”。

### `LC-BUILD-001` BuildRun / Step / Spend

```text
BuildRun: queued → running → succeeded | failed | cancelled
Step:     queued | running | done | degraded | failed | skipped | aborted
```

- 一个 Site 同时只允许一个 active Build；并发请求 409。
- 支持 site/page/section，active baseVersion 在创建时冻结。
- cancel 只有在 active 且 Temporal 确认后才终态；ACK 不明时保留 active 并按 buildId 安全重试。
- cost summary 区分 reported/calculated/estimated/unknown/not-incurred；estimate 不能冒充真实成本。

### `LC-RELEASE-001` SiteVersion / SiteRelease / Preview

```text
candidate → ready | failed → deleting → deleted
```

- manifest/digest 和 producer fencing 保证不可变产物完整性。
- 只有 READY Release 可被 `Site.activeVersionId` 指向；切换失败保留旧 active。
- hidden preview resolver 读取 active READY Release 并逐对象校验 digest；坏产物、unknown component 或 unsupported spec fail-closed。
- GC/reconciliation 默认 operator-disabled；即使启用也保护 active、30 天内 READY 和每站最近回滚候选。
- 当前没有 public Release list/activate/rollback/publish/domain API。

### `LC-LEAD-PACKAGE-001` LeadQualifiedPackage

```text
ICP × CanonicalCompany → qualification → immutable package → outbox delivery → SaaS ACK
```

- 推荐必须满足总分门和 Reachability；不可只用高 Fit。
- 本仓交付不可变快照后停止，不在本仓创建 Opportunity。
- 后端能力保持维护态，新增产品/前端开发冻结。

## 5. 目标态生命周期，不得冒充 as-built

### `LC-OPPORTUNITY-001`

```text
CANDIDATE → QGO → SAO → CLOSED
```

QGO 需要需求/互动/时机证据和合法下一步；SAO 需要销售接受、Owner、阶段、下一步和截止时间；CLOSED 需要结构化 Outcome。具体状态、合并/拆分、CRM 同步和恢复必须由 `OWN-SAAS-PLATFORM` 提供机器合同。

### `LC-INQUIRY-001`

建议边界仍是：Site 负责最小接收、consent/anti-abuse 和 outbox；SaaS 负责 identity matching、Conversation、Opportunity 和 retention policy。该建议在 M2 前需 ADR/PDR，不是当前实现。

## 6. 跨域 SoR 接缝

| Handoff ID | 上游 SoR | 交付形态 | 下游 SoR | 不变边界 | 当前状态 |
|---|---|---|---|---|---|
| `HND-FE-001` | Company/Offering/Claim/Evidence | approved/current snapshot | Site Build/Copy/Version | 派生 snapshot 不回写原事实 | internal `AS_BUILT` |
| `HND-FE-002` | Buyer Intelligence | `LeadQualifiedPackage` + Outbox/ACK | SaaS Opportunity | Outcome 只回作学习标签 | backend `AS_BUILT/FROZEN`；SaaS side unknown |
| `HND-FE-003` | SiteVersion/Release | future PublishReview + Authorization | public service | Build/Release/Preview 不等于 Publish | `APPROVED_NOT_BUILT` |
| `HND-FE-004` | Site receiver | Inquiry event | SaaS Conversation/Opportunity | Site 不内建第二套 CRM/Inbox | `DEFERRED/OPEN_DECISION` |
| `HND-FE-005` | SaaS Workspace/Entitlement | token + allowed actions/capability manifest | 本仓 API 与 SaaS UI | 本仓不签发身份、不存用户表 | backend verifier exists；完整 SaaS contract unknown |

## 7. canonical route 与页面规则

- Workspace、Company、Site、Lead、Campaign、Conversation 和 Opportunity 必须使用稳定业务 ID 建 canonical URL；名称/slug 只作显示或公开站路径。
- Today、Search、Approvals、Tasks、Incidents、Insights 是读模型，不拥有业务对象。
- 同一对象在其他域只用卡片、抽屉或深链；不得复制可编辑字段形成第二 SoR。
- Workspace 切换必须清空对象上下文、缓存、搜索和长任务订阅。
- 外部 Provider 原始 JSON、模型 trace、Secret 和内部错误不能直接穿透给普通用户。

## 8. 未关闭的 ownership 硬门

| Blocker | 缺失 Owner/合同 | 阻止什么 |
|---|---|---|
| `OBJ-BLK-001` | 正式 SaaS repo、`OWN-SAAS-PLATFORM` 和 `OWN-SAAS-FE` 实际指派 | 正式 Shell、身份、Workspace、跨域页面施工 |
| `OBJ-BLK-002` | `OWN-DESIGN` 与设计事实源 | 设计资产定稿和视觉验收 |
| `OBJ-BLK-003` | Claim public review/impact contract | 首个纵切自助审核；只能受控运营兜底并显式阻塞 |
| `OBJ-BLK-004` | Inquiry ADR + 隐私/同意/保留 Owner | 表单、Inbox、Conversation/Opportunity 投影 |
| `OBJ-BLK-005` | Membership/Role/Entitlement/allowed actions 合同 | 权限矩阵、入口可见性和发布授权验收 |
| `OBJ-BLK-006` | 数据、QA、运营和安全/商业实际责任人 | 指标、场景、发布证据、人工恢复和套餐上线 |

这些 blocker 不能由执行者补猜；它们进入[冲突登记](conflict-register.md)，只有相应 Owner、合同和证据到位后才能关闭。
