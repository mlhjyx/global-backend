# 标准场景与 Fixture 目录

> 文档 ID：`GOV-FE-005`
> 层级：`L1/L3 / Registry`
> 状态：`CURRENT`
> 事实 Owner：`OWN-QA-EVIDENCE`
> 产品批准范围：Gate 2 首个纵切及完整产品地图
> 工程核验基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`

本目录为产品评审、设计、前端、后端、E2E、演示和指南提供同一组稳定场景 ID。它只登记 Fixture 语义和验收关系；Phase 5 已建立 Site 页面/运营规格，但没有创建可执行测试数据或浏览器 E2E，也不把后置能力冒充可运行。

## 1. Fixture 安全规则

- 所有公司、域名、人员、邮箱、认证、询盘和商业结果必须明确合成；禁止复制真实客户、联系人或生产数据。
- 二进制/视觉资产必须自产、公共领域或有可证明许可；Readdy、竞品截图和未知权利素材只可人工参考，不能进入共享 Fixture。
- Fixture ID 表示可复用数据意图，不表示文件已经落盘。`manifest_status=CATALOG_ONLY` 时，测试不得假设路径存在。
- 时间、locale、外部依赖、预算和错误注入必须可固定；不得依赖“今天”“随机网络失败”或不可复现模型输出。
- 生产事件或运行证据必须脱敏并进入独立 Evidence/Release Bundle，不能反向污染标准 Fixture。

## 2. 初始 Fixture manifest

| Fixture ID | 内容 | 默认值 | 数据/权利等级 | Manifest status | Owner |
|---|---|---|---|---|---|
| `FX-FE-WS-001` | 合成 Workspace 与角色 | `Northstar Export Lab`；operator/approver/admin 三个合成账号 | 无真实 PII；内部测试 | `CATALOG_ONLY` | `OWN-QA-EVIDENCE` |
| `FX-FE-COMPANY-001` | B2B 精密零部件企业 | `Northstar Precision Components Co., Ltd.`；中国；泵阀/机加工；明确“虚构” | 合成企业事实 | `CATALOG_ONLY` | `OWN-QA-EVIDENCE` |
| `FX-FE-OFFERING-001` | 合成产品目录 | 两个产品、参数、目标市场；含一个缺失字段 | 合成 | `CATALOG_ONLY` | `OWN-QA-EVIDENCE` |
| `FX-FE-ASSET-001` | 合成 logo/工厂图/产品图 | 自产占位图、固定 hash、明确用途和许可 | 需生成并附 CC0/自产声明 | `CATALOG_ONLY` | `OWN-QA-EVIDENCE` |
| `FX-FE-DOC-001` | 合成企业 PDF | 产品手册、认证声明、一个故意冲突字段 | 自产文本/无第三方版权 | `CATALOG_ONLY` | `OWN-QA-EVIDENCE` |
| `FX-FE-CLAIM-001` | Claim/Evidence 组合 | approved、needs_review、conflict、expired、revoked 各一条 | 合成事实/证据 | `CATALOG_ONLY` | `OWN-QA-EVIDENCE` |
| `FX-FE-SITE-001` | Site/Version/Release 图 | draft Site、旧 READY active、新 candidate/failed/ready | 合成 UUID/slug；无公网域名 | `CATALOG_ONLY` | `OWN-QA-EVIDENCE` |
| `FX-FE-BUILD-001` | Build/Step/Cost 图 | queued/running/degraded/failed/cancelled；reported/estimated/unknown | 合成时间与金额 | `CATALOG_ONLY` | `OWN-QA-EVIDENCE` |
| `FX-FE-BUYER-001` | 冻结客户开发样例 | ICP、两个公司、一个不可达 Lead、一个 qualified package | 合成公司/联系人 | `CATALOG_ONLY` | `OWN-QA-EVIDENCE` |
| `FX-FE-INQUIRY-001` | 未来询盘样例 | 同意/重复/垃圾/合法询盘；合成访客 | 合成个人数据；保留策略待定 | `CATALOG_ONLY_BLOCKED` | `OWN-DATA-PRIVACY` |
| `FX-FE-CAMPAIGN-001` | 目标增长计划 | Goal、Audience snapshot、Draft/Approved Content、渠道与预算 | 合成业务数据 | `CATALOG_ONLY_TARGET` | `OWN-QA-EVIDENCE` |
| `FX-FE-CONTENT-001` | 内容与事实引用 | 两语言三版本；approved/unsupported/revoked Claim refs | 合成文本；资产权利另证 | `CATALOG_ONLY_TARGET` | `OWN-QA-EVIDENCE` |
| `FX-FE-CONVERSATION-001` | 入站会话 | reply/duplicate/spam/opt-out/identity ambiguity/ACK unknown | 合成个人数据；用途/保留待定 | `CATALOG_ONLY_BLOCKED` | `OWN-DATA-PRIVACY` |
| `FX-FE-OPPORTUNITY-001` | 商机生命周期 | candidate/QGO/SAO/rejected/closed + verified/unverified outcome | 合成商业数据 | `CATALOG_ONLY_TARGET` | `OWN-QA-EVIDENCE` |
| `FX-FE-INSIGHT-001` | 指标与成本读模型 | current/stale/partial/no-data；reported/estimated/unknown cost | 合成指标；口径待定 | `CATALOG_ONLY_BLOCKED` | `OWN-DATA-PRIVACY` |
| `FX-FE-CONTROL-001` | 团队/集成/套餐/事故 | pending invite、last admin、expiring OAuth、quota、break-glass request | 合成控制面数据 | `CATALOG_ONLY_BLOCKED` | `OWN-QA-EVIDENCE` |

Gate 4 [分析、测试与发布证据规范](../frontend/12-analytics-testing-and-release-evidence.md#4-标准场景与-fixture)和 Phase 5 [Site 运营验收](../frontend/modules/independent-site-management/operations-and-acceptance.md#4-标准-fixture-manifest)已定义 manifest 字段；实际版本、文件路径/schema、seed/reset 命令、预期 hash、适用环境、清理策略和 License evidence 均未创建，因此继续 `CATALOG_ONLY`。

### 2.1 Phase 5 Site Fixture 组合

| 组合 | Fixture | 覆盖 Scenario | 规格入口 | 可执行状态 |
|---|---|---|---|---|
| Intake/Profile | WS + COMPANY + OFFERING | Site 001..003 | `PAGE-FE-030..034` | `SPEC_ONLY_NOT_CREATED` |
| Asset/KB/Claim | WS + ASSET + DOC + CLAIM | Site 004..010 | `PAGE-FE-035..039` | `SPEC_ONLY_NOT_CREATED`；Claim blocked |
| Build/Preview | WS + SITE + BUILD + CLAIM + ASSET | Site 011..018 | `PAGE-FE-040..043` | `SPEC_ONLY_NOT_CREATED` |
| Publish/Inquiry | SITE + CLAIM + INQUIRY | Site 019..023 | `PAGE-FE-048..057` | `TARGET_NOT_RUNNABLE` |

## 3. Shell 与跨域场景

| Scenario ID | Actor / goal | Preconditions + Fixture | 关键步骤与预期 | Recovery / fallback | 状态 | Owner |
|---|---|---|---|---|---|---|
| `SCN-FE-SHELL-001` | ACT-002 进入正确 Workspace | `FX-FE-WS-001`；有效/过期 token、两个 Workspace | 登录后选择 Workspace；深链先校验 tenant/permission；403/404 不泄漏对象存在性 | 会话失效可重新登录并恢复安全目标；无权限不展示数据 | `TARGET_NOT_RUNNABLE`；正式 SaaS 合同缺 | `OWN-SAAS-PLATFORM` |
| `SCN-FE-SHELL-002` | ACT-002 切换 Workspace 不串线 | 两个 Workspace、各有 Site/Run | 切换后清空对象缓存、搜索、订阅和返回路径；旧深链重新鉴权 | 离线或切换失败保留原 Workspace 并明确状态 | `TARGET_NOT_RUNNABLE` | `OWN-SAAS-PLATFORM` |
| `SCN-FE-SHELL-003` | ACT-005 从审批聚合进入 Claim | pending Claim + 无权/有权 approver | 聚合页只读；决定写回 Claim/Approval；显示 Evidence 和影响范围 | 合同缺时显示运营兜底，不提供自动批准 | `BLOCKED`：Claim public review + SaaS Approval 缺 | `OWN-SAAS-PLATFORM` |
| `SCN-FE-SHELL-004` | ACT-002 从异常/长任务恢复工作 | Site Build running/failed + old preview | 聚合卡显示影响、保留结果、下一步，深链具体 Build/Site | 聚合服务失败不阻断直接进入 Site | `TARGET_NOT_RUNNABLE`；Site 局部合同可用 | `OWN-SAAS-PLATFORM` |

## 4. 独立站管理首个纵切场景

| Scenario ID | Capability / Actor | Preconditions + Fixture | 关键步骤与期望状态 | Recovery / acceptance | Evidence status | Owner |
|---|---|---|---|---|---|---|
| `SCN-FE-SITE-001` | `CAP-SITE-INTAKE-001` / ACT-002 首次建站 | `FX-FE-COMPANY-001`；有效 Workspace token；固定 Idempotency-Key | 提交最少字段，原子创建 CompanyProfile+Site+demo Build，返回同一业务结果 | 明确 `generating_demo`；不能虚构身份或公开承诺 | `CODE_BACKED`：intake controller/service/DTO/launcher tests；无正式前端 E2E | `OWN-SITE-BE` |
| `SCN-FE-SITE-002` | Intake ACK 不明安全重放 | 同上；响应在服务端提交后丢失 | 使用同一 Idempotency-Key 重放，得到同一 Site/Build；不同 payload 冲突 | 禁止用户重复点出第二站；展示“正在确认”而非失败重建 | `CODE_BACKED`；前端恢复未建 | `OWN-SITE-BE` |
| `SCN-FE-SITE-003` | `CAP-SITE-PROFILE-001` / ACT-002 分组保存 | `FX-FE-COMPANY-001` + Offering；当前 ETag | GET→编辑一组→PATCH；未改组保持；返回新 ETag | 旧 ETag 产生可解释冲突；允许刷新、比较和重试，不静默覆盖 | `CONTRACT_BACKED/CODE_BACKED`：profile contract/controller/merge tests | `OWN-SITE-BE` |
| `SCN-FE-SITE-004` | `CAP-SITE-ASSET-001` / ACT-003 上传成功 | `FX-FE-ASSET-001`；允许类型/大小 | presign→客户端 PUT→commit→queued/processing→ready；列表可观察 | 每一步独立显示；PUT 完成不冒充 ready | `CODE_BACKED`：asset controller/R2/storage/workflow tests | `OWN-SITE-BE` |
| `SCN-FE-SITE-005` | 上传 URL 过期或 commit ACK 不明 | 合成过期 presign、已写对象但响应丢失 | URL 过期重新 presign；commit 以稳定 Asset 身份安全重试 | 不重复对象/计费；解释已保留上传和下一步 | `CODE_BACKED` 后端恢复语义；客户端网络 E2E 未建 | `OWN-SITE-BE` |
| `SCN-FE-SITE-006` | 重复、拒绝和可重试失败 | 同 hash 重传、坏类型、扫描/处理 retryable | `duplicate`、`rejected`、`failed_retryable` 分开表达 | duplicate 指向现有对象；rejected 不提供无效重试；retryable 保留身份 | `CODE_BACKED`：assets service/contract tests | `OWN-SITE-BE` |
| `SCN-FE-SITE-007` | 被引用 Asset 删除 | active SiteSpec/Claim 引用 `FX-FE-ASSET-001` | DELETE 返回引用阻塞，不产生“已删除”假象 | 深链引用或等待处理；解除后 tombstone，异步 cleanup 状态可解释 | `CODE_BACKED`：reference gate/delete/cleanup tests；引用解除 UI 未建 | `OWN-SITE-BE` |
| `SCN-FE-SITE-008` | `CAP-SITE-KB-001` / ACT-002 KB 部分成功 | `FX-FE-DOC-001` 两文档，一 ready 一 failed | 汇总显示 queued/parsing/chunking/embedding/ready/failed 和 gaps | 保留 ready 结果；失败文档可重试/补资料，不把汇总成功冒充全成功 | `CODE_BACKED`：kb service/clients/Temporal recovery tests；文档级 UI 合同缺 | `OWN-SITE-BE` |
| `SCN-FE-SITE-009` | `CAP-SITE-CLAIM-001` / ACT-005 审核 | `FX-FE-CLAIM-001`；needs_review/conflict | 查看来源、适用范围、认证 Asset；批准/拒绝/冲突处理写审计决定 | 无 public contract 时 fail-closed，并显示受控运营兜底和阻塞原因 | `BLOCKED`：internal bridge/snapshot code-backed，用户合同缺 | `OWN-TRUTH-BE` |
| `SCN-FE-SITE-010` | Claim 过期/撤销影响新 Build | approved Claim 后变 expired/revoked | 新 Build 不再纳入该事实；显示受影响页面/内容 | 已激活 preview/public output 的紧急处理需后续合同；不得静默复用 | `CONTRACT_BACKED` internal snapshot；影响面 UX `BLOCKED` | `OWN-TRUTH-BE` |
| `SCN-FE-SITE-011` | `CAP-SITE-BUILD-001` / ACT-002 启动整站/单页/单板块 | `FX-FE-SITE-001` + `FX-FE-BUILD-001`；合法 scope/style/locale | 冻结 active baseVersion；创建唯一 active Build；返回稳定 ID | 可刷新/跨设备继续轮询；不依赖页面内存 | `CODE_BACKED`：build request/scope/controller/service/workflow tests | `OWN-SITE-BE` |
| `SCN-FE-SITE-012` | 不支持枚举、并发 Build、预算不足 | 非法 locale/style、已有 active run、hard cap 已满 | 分别 422/409/预算错误；不启动 paid call 或新 workflow | 显示允许选项、现有任务和恢复/升级路径；客户端不自行猜 entitlement | `CODE_BACKED`：request/paid execution/cost tests；商业升级路径未定 | `OWN-SITE-BE` |
| `SCN-FE-SITE-013` | `CAP-SITE-RUN-001` / degraded Build | Step 含 done/degraded/skipped，cost reported/unknown | 任务详情区分业务结果、降级、未执行和成本来源 | 用户可继续预览已完成结果、补资料或重建；不把 degraded 显示为全绿 | `CODE_BACKED`：build progress/cost/refurbish tests；正式 UX 未建 | `OWN-SITE-BE` |
| `SCN-FE-SITE-014` | Build 失败但旧预览保留 | 旧 active READY + 新 candidate fail | 新 Build failed，Site 仍指向旧 active；显示影响仅限新候选 | 推荐重试/补资料/运营升级；绝不切换坏产物 | `CODE_BACKED`：release service/preview promotion tests | `OWN-SITE-BE` |
| `SCN-FE-SITE-015` | 取消成功和 ACK 不明 | running Build；Temporal 可用/不可确认两变体 | 确认取消才 `cancelled`；ACK 不明保持 active | 同 buildId 安全重试；禁止显示假终态或启动新并发 Build | `CODE_BACKED`：build controller/service/workflow tests | `OWN-SITE-BE` |
| `SCN-FE-SITE-016` | `CAP-SITE-PREVIEW-001` / 打开可信开发预览 | active READY Release，manifest/digest 正确 | Site 返回 preview URL；resolver 返回完整静态对象 | 显示开发预览/noindex 边界；不称公网发布 | `CODE_BACKED`：preview artifact/routing/release tests | `OWN-SITE-BE` |
| `SCN-FE-SITE-017` | Preview digest、对象或 component 异常 | hash 错、对象缺、unknown component/unsupported spec | resolver/renderer fail-closed，不返回残缺成功页；旧 active 保留 | 显示业务可理解的完整性失败和运营路径，不泄漏存储 key/trace | `CODE_BACKED`：artifact/spec/release/renderer tests | `OWN-SITE-BE` |
| `SCN-FE-SITE-018` | 多语言不完整或降级 | en 完整、de-DE 某段缺失、ar 仅 renderer smoke | 选择器只提供服务端生成 capability；显示 locale fallback/degraded | 不把 RTL smoke 冒充可生成语言；允许返回原语言/补审 | `CONTRACT_BACKED/CODE_BACKED` 局部；正式内容 UX 未建 | `OWN-SITE-BE` |

## 5. 后置 Site 场景，必须保持不可运行标记

| Scenario ID | 目标能力 | 必须覆盖的变体 | 当前缺失 | 状态 / Owner |
|---|---|---|---|---|
| `SCN-FE-SITE-019` | Release history/compare/activate/rollback | 选版、diff、CAS 失败、回滚保留、保留策略 | public Release API、权限、UX、运行证据 | `TARGET_NOT_RUNNABLE` / `OWN-PRODUCT` |
| `SCN-FE-SITE-020` | PublishReview 与公开发布 | Claim/Asset/locale/form/legal gate，发布失败保留旧站，紧急下线 | Publish/Authorization/public service 合同 | `TARGET_NOT_RUNNABLE` / `OWN-PRODUCT` |
| `SCN-FE-SITE-021` | Domain/DNS/SSL | ownership 验证、DNS 传播、证书失败、切换/回滚、域名争议 | Domain object、infra、SLA、区域/安全 Owner | `TARGET_NOT_RUNNABLE` / `OWN-PRODUCT` |
| `SCN-FE-SITE-022` | Inquiry→Conversation | 同意、spam、duplicate、投递失败、DSR、保留和 SaaS projection | receiver、consent、anti-abuse、outbox、ADR | `TARGET_NOT_RUNNABLE/BLOCKED` / `OWN-DATA-PRIVACY` |
| `SCN-FE-SITE-023` | 站点分析与诊断 | 无数据、bot、时区、采样、隐私拒绝、指标 drill-down、旧站诊断 | event/metric SoR、tracking、隐私/保留合同 | `TARGET_NOT_RUNNABLE` / `OWN-DATA-PRIVACY` |

这些场景进入目录是为了阻止遗漏，不表示已批准进入当前施工或首个用户承诺。

## 6. 冻结与外部接缝场景

| Scenario ID | Actor / goal | Preconditions | 关键预期 | 状态 | Owner |
|---|---|---|---|---|---|
| `SCN-FE-BUYER-001` | ACT-002 查看可解释客户池 | `FX-FE-BUYER-001` | 显示来源、资格、Reachability、拒绝原因；不可达高 Fit 不进入推荐 | `FROZEN_MAP_ONLY`；后端有真实服务证据，前端未接 | `OWN-BUYER-BE` |
| `SCN-FE-HANDOFF-001` | ACT-004 接收 qualified package | immutable package + Outbox/ACK | SaaS 创建 Opportunity candidate；本仓不创建 QGO/SAO | `EXTERNAL_OWNED`；本仓 side code-backed | `OWN-SAAS-PLATFORM` |
| `SCN-FE-HANDOFF-002` | ACT-004 回写 Outcome | SaaS Opportunity closed | 只回传结构化学习标签，不覆盖 Lead/Company 主状态 | `EXTERNAL_OWNED` | `OWN-SAAS-PLATFORM` |

## 7. Phase 6 地图级跨域场景

这些场景保证非 Site 域没有丢失关键成功、失败和下一动作，但均未创建 Fixture 文件、正式合同、前端或测试。`MAP_ONLY/TARGET_NOT_RUNNABLE` 不能用于 Release 验收。

| Scenario ID | Capability / actor result | Preconditions + Fixture | 关键验收与恢复 | 当前状态 / Owner |
|---|---|---|---|---|
| `SCN-FE-TRUTH-001` | 企业事实审查 | `FX-FE-COMPANY-001`、`FX-FE-DOC-001`、`FX-FE-CLAIM-001`；operator+approver | 提案→Evidence→冲突/审核→限范围批准；无 allowed action 时只读阻塞 | `MAP_ONLY/PARTIAL_BACKEND` / `OWN-TRUTH-BE` |
| `SCN-FE-TRUTH-002` | Claim 撤销影响消费者 | approved Claim 已被 Site/Content 引用 | 撤销阻止新消费并产生影响任务；不静默改历史快照 | `MAP_ONLY/BLOCKED` / `OWN-TRUTH-BE` |
| `SCN-FE-TRUTH-003` | 知识/素材部分成功与删除 | `FX-FE-DOC-001`、`FX-FE-ASSET-001`；一 ready、一 failed、一 referenced | 保留 ready、解释 failed；referenced 删除失败并给解除路径 | `MAP_ONLY/PARTIAL_BACKEND` / `OWN-TRUTH-BE` |
| `SCN-FE-BUYER-002` | ICP 到可解释推荐 | `FX-FE-BUYER-001` | 规则/回测→发现/部分失败→四队列；不可达高 Fit 不推荐 | `FROZEN_MAP_ONLY/BACKEND_CODE_BACKED` / `OWN-BUYER-BE` |
| `SCN-FE-GROWTH-001` | Campaign 从目标到 Dry Run | `FX-FE-CAMPAIGN-001` + `FX-FE-CONTENT-001` | 固化 Audience/Claim/content/channel/cost 风险；差异后重新批准 | `TARGET_NOT_RUNNABLE` / `OWN-SAAS-PLATFORM` |
| `SCN-FE-GROWTH-002` | 未批准事实阻止执行 | `FX-FE-CONTENT-001` 引用 revoked/unsupported Claim | 深链 Evidence/审核；不允许生成内容绕过事实门 | `TARGET_NOT_RUNNABLE` / `OWN-SAAS-PLATFORM` |
| `SCN-FE-GROWTH-003` | 渠道部分成功与 ACK unknown | `FX-FE-CAMPAIGN-001`；两渠道/三目标，一成功/失败/未知 | 逐目标回执；只重试可重试失败，未知先对账 | `TARGET_NOT_RUNNABLE` / `OWN-SAAS-PLATFORM` |
| `SCN-FE-GROWTH-004` | Suppression/授权/预算 fail-closed | `FX-FE-CAMPAIGN-001`；受众含禁联、授权过期、额度变化 | Dry Run 阻止越权目标，要求新授权；不扩大名单 | `TARGET_NOT_RUNNABLE` / `OWN-SAAS-PLATFORM` |
| `SCN-FE-ENGAGE-001` | 入站回复到会话分派 | `FX-FE-CONVERSATION-001` | 去重/身份关联/opt-out→分派；不确定身份进入待确认 | `TARGET_NOT_RUNNABLE` / `OWN-SAAS-PLATFORM` |
| `SCN-FE-ENGAGE-002` | Lead package 到 Opportunity candidate/QGO | `FX-FE-BUYER-001` + `FX-FE-OPPORTUNITY-001` | ACK 后建 candidate；Evidence 完整才人工 QGO；本仓不建主状态 | `TARGET_NOT_RUNNABLE` / `OWN-SAAS-PLATFORM` |
| `SCN-FE-ENGAGE-003` | QGO→SAO→Outcome | `FX-FE-OPPORTUNITY-001` | 销售接受带 Owner/next step；Outcome provisional→verified；追加审计 | `TARGET_NOT_RUNNABLE` / `OWN-SAAS-PLATFORM` |
| `SCN-FE-INSIGHT-001` | 指标下钻和数据缺口 | `FX-FE-INSIGHT-001` | 显示口径/时区/权限/新鲜度；partial 不补 0；下钻 canonical object | `TARGET_NOT_RUNNABLE` / `OWN-SAAS-PLATFORM` |
| `SCN-FE-INSIGHT-002` | 成本和归因不确定性 | reported/estimated/unknown；样本不足 | 保持来源和未知；归因不充分显示 inconclusive | `TARGET_NOT_RUNNABLE` / `OWN-DATA-PRIVACY` |
| `SCN-FE-CONTROL-001` | 成员邀请/移交/停用 | `FX-FE-CONTROL-001` | last-admin 保护、任务/审批移交、有效权限预览和审计 | `TARGET_NOT_RUNNABLE` / `OWN-SAAS-PLATFORM` |
| `SCN-FE-CONTROL-002` | 集成授权、过期和退出 | expiring OAuth、partial scope、provider outage | secret 不回显；受控重授权/移除/导出；业务对象不丢 | `TARGET_NOT_RUNNABLE` / `OWN-SAAS-PLATFORM` |
| `SCN-FE-CONTROL-003` | 套餐降级和运营事故 | quota exceed + break-glass request | 展示影响/生效时间；运营最小权限、审批、限时、全审计 | `TARGET_NOT_RUNNABLE` / `OWN-SEC-COMMERCIAL` |

## 8. 失败类别覆盖

| 失败/边界类别 | 必须覆盖的 Scenario |
|---|---|
| 无会话、无 Workspace、无权 | `SCN-FE-SHELL-001/002/003` |
| 空、缺资料、待审核 | `SCN-FE-SITE-003/008/009` |
| ACK 不明、幂等与重复 | `SCN-FE-SITE-002/005/006/015` |
| 并发、冲突与 stale | `SCN-FE-SITE-003/012/019` |
| 部分成功与 degraded | `SCN-FE-SITE-008/013/018/020/022` |
| 预算、配额与成本未知 | `SCN-FE-SITE-012/013` |
| 取消、失败恢复和旧结果保留 | `SCN-FE-SITE-014/015/019/020` |
| 权利、批准、撤销与个人数据 | `SCN-FE-SITE-009/010/020/022` |
| 产物完整性和 fail-closed | `SCN-FE-SITE-016/017` |
| 外部依赖、域名和投递 | `SCN-FE-SITE-021/022/023` |
| 冻结能力与跨仓 ownership | `SCN-FE-BUYER-001`、`SCN-FE-HANDOFF-001/002` |
| 外部执行、回执和未知 ACK | `SCN-FE-GROWTH-001..004` |
| 会话、商机与 Outcome | `SCN-FE-ENGAGE-001..003` |
| 指标缺口、成本与归因不确定性 | `SCN-FE-INSIGHT-001/002` |
| 成员、集成、套餐和平台运营 | `SCN-FE-CONTROL-001..003` |

## 9. 场景升级门

场景从 `CATALOGED` 升级时必须同时记录：

1. Fixture manifest 版本、生成/seed/reset 方法和 License/PII 检查；
2. 关联 Capability、Journey、Page、Object、Contract 和 Decision ID；
3. 正常、等待、空、冲突、失败、取消、恢复和人工兜底中的适用变体；
4. 自动测试文件、运行环境、提交、时间和实际结果；
5. 产品、设计、前端、后端、QA、运营各自验收范围；
6. 任何不可执行依赖和不得声称的用户承诺。

AI 生成场景或自评不能成为唯一 Evidence Owner。Phase 5 只创建了 Site UI/运营规格，Phase 6 只补了非 Site 地图级 Scenario/Fixture 目录；测试代码、Fixture 文件、seed/reset 和真实数据仍未创建，必须由后续明确授权和真实 QA/数据 Owner 承接。
