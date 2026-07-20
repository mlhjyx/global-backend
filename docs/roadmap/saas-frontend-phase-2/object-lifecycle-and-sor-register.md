# 对象生命周期与 System of Record 登记

> 文档 ID：`BASE-FE-P2-003`
> 状态：`READY_FOR_GATE_2_REVIEW`
> 事实基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 用途：为 IA、页面、权限和跨仓接缝建立对象级基线；不替代 Prisma、OpenAPI 或 ADR

## 1. 登记规则

- `SoR` 指唯一业务真相写入方，不等于页面所在产品域。
- `Current state` 只引用 `main` 或当前权威边界；Word 目标对象标 `PROPOSED`。
- 生命周期只写用户和前端必须理解的业务状态；内部 lease/fence/数据库实现作为恢复语义，不暴露成业务术语。
- 对象归属与页面入口分开。一个对象可以被多域消费，但不能拥有多个互相覆盖的 SoR。

## 2. 核心对象总表

| Object ID | 对象 | 用户名称 | SoR / 写入 Owner | 当前状态 | 主产品域 | 数据属性 |
|---|---|---|---|---|---|---|
| `OBJ-FE-001` | Workspace | 工作空间 | 外部 SaaS 平台 | `EXTERNAL_OWNED`；本仓仅 tenant anchor | Shell | 团队/租户根 |
| `OBJ-FE-002` | Membership / Role / Entitlement | 成员、角色、套餐能力 | 外部 SaaS 平台 | `EXTERNAL_OWNED`；本仓未建用户表 | Shell | 权限/商业敏感 |
| `OBJ-FE-003` | CompanyProfile | 企业资料 | 本仓企业域；未来由 SaaS UI 调用 | `AS_BUILT` | 企业与信任 | Workspace 共享 |
| `OBJ-FE-004` | Offering | 产品/服务 | 本仓企业域 | `AS_BUILT` | 企业与信任 | Workspace 共享 |
| `OBJ-FE-005` | KnowledgeSource / KbDocument | 资料来源/知识文档 | 企业域 + Site Builder | 两套来源对象并存；站点 KB `AS_BUILT` | 企业与信任/Site | 共享，可能受限 |
| `OBJ-FE-006` | Claim | 企业事实声明 | 本仓企业域 | `AS_BUILT`；Site bridge 存在，公开审核入口不完整 | 企业与信任 | 候选公开事实 |
| `OBJ-FE-007` | Evidence | 证据 | 本仓企业/数据域 | `AS_BUILT` | 企业与信任 | 来源/权利敏感 |
| `OBJ-FE-008` | Asset / AssetVariant | 素材/派生版本 | Site Builder 对象存储 + DB | `AS_BUILT` | 企业与信任/Site | 权利/公开范围敏感 |
| `OBJ-FE-009` | ICP | 理想客户画像 | 本仓买家智能域 | `AS_BUILT/FROZEN` | 客户开发 | Workspace 共享 |
| `OBJ-FE-010` | CanonicalCompany / Lead | 买家公司/线索 | 本仓买家智能域 | `AS_BUILT/FROZEN` | 客户开发 | 共享；联系人受限 |
| `OBJ-FE-011` | LeadQualifiedPackage | 合格线索包 | 本仓不可变快照 + Outbox | `AS_BUILT/FROZEN` | 客户开发→SaaS | 交付快照 |
| `OBJ-FE-012` | Site | 独立站 | 本仓 Site Builder | `AS_BUILT` | 独立站管理 | Workspace 共享 |
| `OBJ-FE-013` | SiteVersion | 站点版本 | 本仓 Site Builder | `AS_BUILT` | 独立站管理 | 不可变内容版本意图 |
| `OBJ-FE-014` | SiteRelease | 构建发布单元 | 本仓 Site Builder | `AS_BUILT` 内部地基；无公共管理 API | 独立站管理 | 不可变产物/运维 |
| `OBJ-FE-015` | SiteBuildRun / Step | 生成任务/步骤 | 本仓 DB + Temporal | `AS_BUILT` | 独立站管理 | 团队任务/诊断 |
| `OBJ-FE-016` | SiteBuildBudget / Spend | 构建预算/成本 | 本仓 Site Builder ledger | `AS_BUILT` | Site/洞察 | 商业/运营敏感 |
| `OBJ-FE-017` | BrandProfile / PublishableClaimSnapshot / CopyBundle | 品牌理解/发布事实快照/多语言文案包 | 本仓 Site Builder | `AS_BUILT` 内部；无通用编辑 API | 独立站管理 | 派生/不可变快照 |
| `OBJ-FE-018` | Goal / Initiative / Campaign | 目标/增长计划/战役 | SaaS 业务核心 | `PROPOSED/EXTERNAL_OWNED` | 增长执行 | Workspace 共享 |
| `OBJ-FE-019` | ContentAsset / PublishJob | 内容/发布任务 | SaaS 内容与执行域 | `PROPOSED/EXTERNAL_OWNED` | 增长执行 | 共享/公开候选 |
| `OBJ-FE-020` | Conversation / Message / Intent | 互动/消息/意向 | SaaS 互动域 | `EXTERNAL_OWNED`；当前实现未定位 | 互动与商机 | 个人数据/受限 |
| `OBJ-FE-021` | Opportunity / QGO / SAO | 商机 | SaaS 商机域 | `EXTERNAL_OWNED`；当前实现未定位 | 互动与商机 | 商业敏感 |
| `OBJ-FE-022` | CommercialOutcome | 商业结果 | SaaS 商机域 | `EXTERNAL_OWNED`；本仓只收学习标签 | 商机/洞察 | 商业敏感 |
| `OBJ-FE-023` | Touchpoint / Attribution / Recommendation | 触点/归因/建议 | SaaS 分析读模型 | `PROPOSED/EXTERNAL_OWNED` | 洞察 | 聚合/读模型 |
| `OBJ-FE-024` | Integration / CredentialRef | 集成/凭据引用 | SaaS 控制面/Secret store | `EXTERNAL_OWNED` | Shell/运营 | 高敏感 |
| `OBJ-FE-025` | Approval / Authorization | 审批/执行授权 | SaaS Policy/Control Plane | `PROPOSED/EXTERNAL_OWNED`；Claim 内有局部审批事实 | Shell/跨域 | 审计/不可变决定 |
| `OBJ-FE-026` | Notification / Task / Incident | 通知/任务/异常 | SaaS 聚合读模型 + 各域事件 | `PROPOSED` | Shell/运营 | 个人或团队范围待定 |
| `OBJ-FE-027` | Inquiry | 站点询盘 | Site receiver + SaaS 投影，需 ADR | `DEFERRED/OPEN_DECISION` | Site→互动 | 个人数据 |

## 3. 当前对象生命周期

### 3.1 CompanyProfile

- 当前机器状态：`DRAFT → ENRICHING → REVIEW → ACTIVE`。
- 业务含义：`ACTIVE` 必须有人工确认或相应审批，不能把零审批的自动抽取当成可公开事实。
- 创建者：intake/企业理解流程或服务；当前 Site intake 已原子关联 CompanyProfile。
- 用户动作：查看、补充、纠正、提交审核；正式 API/页面覆盖尚不完整。
- 删除/保留：Workspace 级 RLS；与 Claim/Site 有强关系，不能简单前端级联删除。
- 开放决定：是否允许多个 CompanyProfile、谁可激活、字段级审批与历史版本。

### 3.2 Claim / Evidence

```text
INGESTED → EXTRACTED → NEEDS_REVIEW → APPROVED → EXPIRED / REVOKED
                              └──────────────→（拒绝/冲突处理语义待公共合同）
```

- 机器生成的 Site bridge Claim 只进入 `NEEDS_REVIEW`。
- APPROVED 必须绑定精确 Claim/Evidence/bridge；认证还要求同 Site 的 live ready cert Asset。
- Site Build 只将 approved/current/audited Claim 纳入不可变 `PublishableClaimSnapshot`。
- 撤销/过期后不得静默继续用于新发布；当前对已激活版本的用户影响和紧急下线体验尚未定义。
- Evidence 不是独立可编辑文案；它记录来源、hash、quote、时间和素材引用。

### 3.3 Asset / AssetVariant / KbDocument

Asset 当前处理状态：

```text
pending_upload → committing → ready
                         ├→ queued → processing → ready
                         ├→ failed_retryable → committing
                         ├→ rejected
                         ├→ duplicate
                         └→ deleted（软删除 + 异步清理）
```

KB 文档内部状态：`queued → parsing → chunking → embedding → ready | failed`；公共列表目前只通过 Asset 状态和 KB 汇总暴露，未提供文档级完整管理 API。

前端规则：

- presign 成功不等于上传完成；PUT 完成也不等于 commit/处理完成。
- `duplicate` 是可解释结果，不应显示为普通失败。
- 删除前必须检查 Profile/active SiteSpec/Claim Evidence/worker 引用；409 需要跳转到引用解除或等待处理。
- 删除为 tombstone + 异步清理；不能立即承诺物理对象已经清除。
- AssetVariant 是派生物，普通用户默认操作逻辑 Asset，而非直接管理内部 recipe 行。

### 3.4 Site

当前字段状态：`draft | building | ready | published`，DTO 还声明 `setup_failed`。该差异本身需要后续 truth-sync；Phase 2 不发明转移。

建议用户语义分层：

- 站点业务状态：草稿、正在生成、可预览、已发布、需处理；
- Build 任务状态：queued/running/succeeded/failed/cancelled；
- Release 产物状态：candidate/ready/failed/deleting/deleted；
- 公开服务状态：未发布/发布中/在线/异常/下线（目标态）。

不能把这四层压成一个 badge，否则会出现“Build 成功但未发布”“站点在线但最新 Build 失败”等无法表达的场景。

### 3.5 SiteBuildRun / Step / Budget

- BuildRun：`queued → running → succeeded | failed | cancelled`。
- Step：`queued | running | done | degraded | failed | skipped | aborted`。
- 一个 Site 同时只允许一个 active Build；重复请求返回 409。
- Build create 支持整站/单页/单板块，冻结 active baseVersion，避免并发人工编辑被覆盖。
- 默认公开支持 locale 仅 `en/de-DE`，style preset 仅两种；未知选项 422 fail-closed。
- 取消只有在 active 且 Temporal 确认后才终态；ACK 不可用时 Build 保持 active，用户可按同 buildId 重试取消。
- 成本摘要区分 reported/calculated/estimated/unknown/not-incurred；estimate 不能冒充真实成本。
- 预算耗尽、取消或终态会关闭 paid calls；用户需看业务摘要，不看 microusd/lease/fence 内部细节。

### 3.6 SiteVersion / SiteRelease / Preview

- SiteVersion 记录 spec、source、buildStatus 和递增 version。
- SiteRelease：`candidate → ready | failed → deleting → deleted`，以 manifest/digest 和 producer fencing 保证不可变产物完整性。
- 只有 READY Release 才能被 `Site.activeVersionId` 指向；切换失败保留旧 active。
- 预览读取 active READY Release 并逐对象验证 digest；unknown component/unsupported spec fail-closed。
- GC 默认关闭；显式启用也保留 active、30 天内 READY 和每站最新两个回滚点。
- 当前没有公共 Release history/activate/rollback/publish API。前端不得把内部状态机直接包装成可用版本管理。

### 3.7 ICP / Lead / LeadQualifiedPackage（冻结）

- ICP：当前有 Draft/Active/Archived 等实现状态（以代码契约为真），应通过样例回测后激活。
- Lead 是 `ICP × CanonicalCompany` 的资格对象，不把 fit 写回公司级。
- 推荐队列必须满足六维总分门和 Reachability；不可只显示高分。
- LeadQualifiedPackage 是不可变交付快照；通过 Outbox delivery + ACK 交给 SaaS。
- 当前产品面冻结，生命周期仅用于完整 IA 和未来 SaaS 接入，不启动新的前端实现。

## 4. 目标态对象生命周期（等待 SaaS Owner）

### 4.1 Opportunity

建议沿现有权威边界采用单一聚合：

```text
CANDIDATE → QGO → SAO → CLOSED
```

- QGO 是有需求/互动/时机证据且有合法下一步的资格状态；高 fit Lead 不自动等于 QGO。
- SAO 需要销售正式接受并填写 Owner、阶段、下一步、截止时间和原因。
- CLOSED 需要结构化 outcome；Won/Lost/失效均不能只靠自由文本。
- 具体状态、恢复、合并/拆分和 CRM ownership 需 SaaS Owner 形成机器合同。

### 4.2 Campaign / Content / Publish / Conversation

这些对象在 Word 中有较完整目标状态，但当前没有权威 SaaS 实现。Phase 2 只锁定边界：

- Campaign 是协调上下文，不拥有 Company、Content、Conversation 或 Opportunity。
- ContentAsset 保持独立版本和 Claim 引用；发布记录不覆盖内容主版本。
- PublishJob/OutboundSequence 只在有效 Approval/Authorization 下执行。
- Conversation 聚合多渠道线程，Message/Intent 可追溯；外部 Chatwoot 只能是副本或执行内核。
- 任何目标状态机进入正式规范前必须由 SaaS Owner、产品和契约 Owner 共同批准。

### 4.3 Inquiry 接缝

建议但未批准的 ownership：

1. Site 侧负责表单 schema、consent、anti-abuse、原始接收和不可丢 Outbox 事件；
2. SaaS 互动域负责联系人匹配、Conversation、Intent、Owner/SLA 和 Opportunity；
3. Site 页面只显示投递状态和最小统计，不建立第二套客户/商机 SoR；
4. 数据删除、保留和抑制跨两域编排。

## 5. 页面、深链和操作归属

| 对象 | Canonical 页面建议 | 其他页面如何使用 | 不允许 |
|---|---|---|---|
| CompanyProfile | 企业资料主页 | Site/Campaign/Content 引用摘要和跳转 | 在各模块复制可编辑公司字段 |
| Claim/Evidence | 企业事实审查工作台/Drawer | 内容、站点、销售材料显示引用 | AI 文案直接覆盖 Claim |
| Asset | 统一资产对象页或 Site 资料中心的 canonical detail | 编辑器选择器、Evidence 引用 | 按页面复制上传对象 |
| Site | `/sites/:siteId` 工作台 | Today/搜索/任务深链 | 用公司名/slug 作为主键 |
| BuildRun | `/sites/:siteId/builds/:buildId` 或任务抽屉 | 全局长任务中心引用 | 只用 Toast 告知长任务 |
| SiteVersion/Release | 版本历史和对比页（目标态） | 预览/发布对话框引用 | 将 Build 记录等同 Release |
| ICP | 客户开发/ICP 对象页 | Campaign 引用 snapshot | Campaign 内复制并静默改写 |
| Lead | Account/Lead 对象页 | Campaign Audience 引用 | 把 Lead 和 Opportunity 混为一条记录 |
| Opportunity | SaaS 商机对象页 | Inbox/Insights 深链 | 本仓复制销售主状态 |

## 6. Owner 与开放决策

| Decision ID | 要决定的归属 | 推荐 | Gate |
|---|---|---|---|
| `SOR-FE-001` | 正式 SaaS Workspace/Membership/Entitlement 合同和仓库 | 保持外部 SaaS 单一 SoR；本仓只消费 token claims | Gate 2/4 |
| `SOR-FE-002` | 企业事实 UI 与跨域写入 Owner | 一个企业事实域服务/页面；Site/Content 只引用 | Gate 2 |
| `SOR-FE-003` | Site Release/Publish/Domain 对象 Owner | 本仓拥有 Release/发布基础对象；SaaS 拥有 UI/control plane，接口 code-first | Gate 2/5 |
| `SOR-FE-004` | Campaign/Conversation/Opportunity 当前实现仓库 | 明确新建或现有 SaaS repo，不把旧 Spring 原型默认为目标 | Gate 2 |
| `SOR-FE-005` | Inquiry 原始接收与 SaaS 投影 | 采用 §4.3 建议并另立 ADR | M2 前 |
| `SOR-FE-006` | Approval 是统一对象还是各域状态 | 建议统一审计信封 + 域内决定，不建万能审批聚合根 | Gate 4 |
| `SOR-FE-007` | 个人草稿/待办的隐私属性 | 默认不因管理员身份自动可读，除非明确政策与审计 | Gate 4 |

## 7. Gate 2 推荐

1. 批准对象总表作为后续页面与权限设计的 SoR 基线。
2. 批准 Company/Offering/Claim/Evidence/Asset 的共享事实底座原则。
3. 批准 Site、BuildRun、SiteVersion、SiteRelease 四层状态分离，禁止用一个“站点状态”遮蔽差异。
4. 维持 Opportunity/Conversation/Campaign 归 SaaS，不以本仓 Schema 或本地 Spring 原型代替。
5. 对 `SOR-FE-001`–`005` 指定 Owner；未指定前相应页面继续为 `CONTRACT_BLOCKED`。
