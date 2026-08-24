# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：`origin/main`、本仓机器合同、live worktree 审计与 RuntimeEvidence 状态命令
> 最后核验：2026-08-24

本页只保留当前 main、在途工作、阻塞、最新运行事实和下一次产品决策。完成史、旧验证数字、模型评测流水与 Site Builder 日期化实施细节已经迁到 [追加式 changelog](../roadmap/changelog.md) 和 [evidence 索引](../evidence/README.md)，不再在 current 页重复。

> **2026-08-24 PR #413 合并与 main advisory baseline 后继门**：[PR #413](https://github.com/mlhjyx/global-backend/pull/413) 已在全部 PR checks（required CI、Contracts、Governance、Gitleaks、Dependency Review、production dependency delta 与 CodeQL）通过后，以普通 merge commit `866ede782579815dd3cd46bcaffb0c1d9626cf46` 合入 main；合并前 4 个 inline review threads 均已按当前源码/测试回复并 resolve，未使用 admin bypass。main push 的 Supply Chain freshness 随后以 `BASELINE_SOURCE_LOCK_MISMATCH` 正确 HOLD：依赖 audit 仍为 10 条、26 条已解决，但旧 baseline 绑定的是前一 lock digest。后继分支 `codex/production-dependency-baseline-refresh` 从 exact merge commit 重建 10-advisory / 10-exposure canonical baseline，保留剩余 Site Renderer/Astro remediation owner、due date 与 validity，不延后、不新增例外；该后继变更通过并合入前，main post-merge Supply Chain 仍是 HOLD。根 main 工作区因两处用户 tracked 修改与入站路径冲突而保持旧 HEAD，治理同步脚本未 stash、未覆盖、未更新；任何构建/部署必须使用 exact clean merge commit，而不能使用该脏根目录。

> **2026-08-12 Copy Sonnet native capability（当前）**：在用户对精确范围的明确授权下，New API channel #20 的 `special` 组已启用；新建的一次性有限 token 仅向 `claude-sonnet-5 × Anthropic Messages` 发出 2 条物理 wire（首调与一次 closed repair），随后已禁用。首调因 Markdown 代码围栏被当前 Copy 合同拒绝；repair 的 3 个事实槽位通过 `COPY_TASK.validateOutput` 与 `evaluateCopyAssemblyOutput`。脱敏、无 prompt/output/secret 的 [native capability evidence](../evidence/site-builder/m1-g-copy-sonnet-native-capability-2026-08-12.json) 已由 [Git-review acceptance](../evidence/site-builder/m1-g-copy-sonnet-native-capability-git-review-acceptance-2026-08-12.json) 绑定 #394 merge commit。此事实仅证明一个 factual Copy fixture 的 native gateway capability；不证明全量质量矩阵、模型晋级或生产路由采用，三者仍为 `NOT_AUTHORIZED`。v20 stopped evidence 和 credential security hold 保留为不可改写历史；其中 credential hygiene 待办须独立处置，不能被本次有界授权运行改写为已完成。

> **2026-08-12 Copy Sonnet native route adoption（已 Git review）**：用户已单独授权能力、质量、晋级与路由四门。Sonnet-only matrix 以 `claude-sonnet-5 × Anthropic Messages × special` 对六个 Copy production fixtures 各运行两次：12/12 通过当前生产 validator 与事实槽位硬门，13 条 matrix wire（含同 execution key 的一次恢复）形成 12 个 accepted outputs；独立盲审均值为 4、4、3.8、4，唯一 minor CTA finding 未低于阈值。质量 artifact 由 [quality Git-review acceptance](../evidence/site-builder/m1-g-copy-sonnet-native-quality-git-review-acceptance-2026-08-12.json) 绑定 #396，promotion artifact 由 [promotion Git-review acceptance](../evidence/site-builder/m1-g-copy-sonnet-native-promotion-git-review-acceptance-2026-08-12.json) 绑定 #397，source-level route adoption 由 [route Git-review acceptance](../evidence/site-builder/m1-g-copy-sonnet-native-route-adoption-git-review-acceptance-2026-08-12.json) 绑定 #398。active Copy route 精确为 Sonnet/Messages/medium/no-fallback；不新增模型调用、token、费用结算、部署或 RuntimeEvidence，DeepSeek Pro→GLM 仍是显式 rollback。

## 1. 当前基线

| 项目                    | 当前事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前远端主线            | 2026-08-24 `origin/main@866ede782579815dd3cd46bcaffb0c1d9626cf46` 是 [PR #413](https://github.com/mlhjyx/global-backend/pull/413) 的普通 merge commit；PR checks 全部通过，4 个 inline review threads 已回复并 resolve，未使用 admin bypass。main push 仅 Supply Chain baseline freshness 因旧 lock provenance HOLD，后继 [PR #415](https://github.com/mlhjyx/global-backend/pull/415) 正在收口。`/global/backend` 根工作区因两处用户 tracked 冲突仍停在旧 HEAD，治理脚本未覆盖现场；构建/部署不得使用该脏根目录。 |
| 产品阶段                | Site Builder Copy Sonnet 为 `NATIVE_CAPABILITY_PASS / GIT_REVIEWED`、`NATIVE_QUALITY_PASS / GIT_REVIEWED`、`MODEL_PROMOTION_APPROVED / GIT_REVIEWED` 与 `PRODUCTION_ROUTE_ADOPTION / GIT_REVIEWED`：Sonnet-only 六 fixtures × 两次的 12/12 accepted outputs 均通过生产硬门；本矩阵为 13 条物理 wire（包含一次失败后的有界补发），另有 1 条先前诊断 wire 被排除。purpose-specific token 均已禁用。代码级 route 为 Sonnet Messages/medium/no-fallback，DeepSeek Pro→GLM 是显式 rollback；尚无部署、fresh RuntimeEvidence 或 Release Bundle。v16 #24、v17 #25、v19 #26、v20 #27 与先前失败 token 均为不可复用历史审计。 |
| 当前交付状态            | Buyer/Intent 的机器追踪链均为 `INTERNAL_ONLY`。当前不存在可用于晋级的 RuntimeEvidence，也不存在真实 Release Bundle。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Source-only 质量/安全门 | 当前 main 的仓内 CI 包含 build/typecheck/test、OpenAPI drift/lint/breaking、Gitleaks、production dependency audit ratchet、Dependency Review 与 CodeQL canary；Supply Chain/Dependency Review/CodeQL 仍未全部进入 live required ruleset，container/Compose/IaC、目标 PostgreSQL/Temporal 集成与恢复演练也尚未形成完整 required gate。2026-08-24 对 `pnpm-lock.yaml`（SHA-256 `ce3b20115af81ad419abb71fe6817cac7fb8bccece9881caf5940cdf36b2f0ea`）使用 npm 官方 registry 的 production audit 为 10 项（3 high、4 moderate、3 low、0 critical）与 10 条 canonical path exposure；该事实只绑定 baseline 的 capture time、exact main、lock digest 与审计口径，依赖或 advisory 数据变化后必须重跑。 |
| Provider 真值           | 只认 [机器 Provider Registry](../governance/provider-registry.json) 与其[生成页](../backend/provider-registry.md)；实现、默认 enablement、当前 runtime health 与 pilot 授权是不同维度。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 模型候选基线            | 当前非运行时候选合同为 `site-builder-model-candidate-baseline/2026-08-07-v3`；它不证明 active route、质量、dispatch 授权或运行健康。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Copy 技术/运行授权      | 本次明确授权已消费：新 token 仅允许 `claude-sonnet-5 × Anthropic Messages × special`、最多 2 wires；运行后已禁用。没有新的 dispatch 授权时不得继续调用模型。v16 #24、v17 #25、v19 #26、v20 #27 与后续失败 token 必须保持 disabled 审计记录且绝不复用；v18 stopped authorization 不可重放。credential security hold 仍是独立 hygiene 待办，不得借本次运行声称已轮换或已处置。 |

## 2. 在途工作

Site Builder Copy 的 v16 fixed-source rebase、v17/v18/v19/v20 stopped records及其历史 token 均已保留。2026-08-12 的最小 native capability、Sonnet-only native quality、promotion approval 与 source-level route adoption 决策集均已完成 Git review/CI/merge；active Copy route 保持受批准 Sonnet 与 legacy rollback。历史 credential security hold 仍须独立、安全地处置，不能通过改写或删除历史 artifact 回避。

当前获客恢复计划在独立本地集成分支中收敛，范围包括：

- 治理入口、Provider Registry、RuntimeEvidence/Release Bundle、追踪与 CI 门；
- 身份/JWKS 与细粒度授权；
- 数据权利、质量标签、运行身份、worker/schedule/receipt 与运维证据；
- 首个获客 pilot 的范围、验收与退出条件准备。

运行身份 source slice 已由 #374 合入；roles→scopes slice 也已由 #375 合入，以九个闭合 scope、服务端 role map、未知 role 零权限、控制器双 guard、PII/合规复合门和 `x-required-scopes` OpenAPI 元数据为边界。当前合规变更集把 suppression 事实保留为不可物理删除、只可从 PREFERENCE 单向提升到 LEGAL；类型化 canonicalizer 在新写入和旧值读取边界共享 email/domain/company-name 规范键，非法新值在 DB 前拒绝，历史非规范事实仍可见且能继续命中。现有公司按 canonical key 分块即时更新；fit/enrich/signal/watch/contact/guess 六个 backlog/forward-run 阶段在每家外部处理前使用同一原始匹配闸，命中 legacy 事实时修复公司 `SUPPRESSED` 派生状态。ToolBroker、模型 Router、guarded HTTP redirect、provider retry/page/fallback、robots、DNS→SMTP 与 DNS→Crawl4AI dispatch 在每个应用可观察的物理动作前继续复核；denial/authorization error terminal，不得作为网络抖动重试或模型 fallback。workspace-specific robots denial 不进入共享 TTL cache。suppression 创建、canonicalize、TenantProjection、TED/openFDA/SAM signal 与 website-intent materialization、联系人/猜测提交、邮箱验证回写、Art.17 freeze/erase 与 Lead accept 共享 workspace 级事务 advisory lock；跨路径只固定 **advisory 必须先于任何 company/contact row lock**，取得 advisory 后必须在业务写入或外部动作授权前完成当前 row 与 authoritative fact 判定，禁止 row-lock→advisory 反向获取。canonicalize、Tenant、TED/FDA/SAM 与 website-intent 均同时检查 incoming 与 existing canonical identity；命中只修复 `SUPPRESSED` 派生状态并停止 link/intent/evidence 写。backlog watch 也把 company-scoped callback 传入 sitemap/probe/redirect。付费模型在首个 wire 前被拒时以 `RELEASED/not_incurred/callCount=0` 收口且不冻结；repair 前拒绝仍结算已发生首调。新禁 email/domain/contact_key 的联系人不进 `LeadQualifiedPackage`；如果剩余可达点为零，accept 以 `SUPPRESSED_CONTACT_UNREACHABLE` 拒绝，不写 LeadDecision/Outbox。`GET /events` 因可能返回 RESTRICTED `LeadQualified.contact_refs`，现同时要求 `acquisition:read` 与 `personal-data:read`；ACK 仍独立要求 `acquisition:event:ack`。普通 release/identity-correction 操作同时保留原始 command 和裁决 outcome 的 append-only decision，幂等键不再折叠不同原始 reason；DB 约束语义组合，含审计/PII 的列表有 cursor page envelope/100 行响应硬上限，生成 OpenAPI 显式列出 Lead accept/reject 与 suppression 操作实际可达的 400/404/409 统一 error envelope 与 UUID path。Lead accept 的 DataRights DENY 在 sanctions 等后续异常门前提交公司禁联派生状态和 append-only policy log，再返回 409。`codex/production-parity` 已从产品 runtime 删除 DevTokenVerifier 与内建 development role map；所有 managed environment 统一使用 JWKS verifier 和相同 roles→scopes 合同，仅允许信任根配置不同。该 source 状态仍不能替代 live SaaS token、跨 workspace 负例、目标环境 admission 或部署回读。

watch/sitemap 的 suppression denial 与 branded ToolBroker source-policy denial 现按机器 decision/reason/type 识别并立即越过 root/child retry、普通网络降级和 homepage monitor fallback；denial 后不创建 monitor、不计 registered success。authority reconciliation：company domain/name 命中时修复 `SUPPRESSED` 并移除 role mailbox，exact email 或 mailbox 自身 domain 命中时只移除 mailbox，不错误禁用无关公司；已经 `SUPPRESSED` 或并发 status repair 先完成也会按当前 attributes 再清理。derived scan 每 50 行在独立最多 5 秒的事务中取得/释放 workspace lock，不再单事务持锁扫描到 EOF；它仍是同步 derived projection，durable cursor/receipt 与后台恢复尚未实现。Intent recompute 以及 forward/backlog enrich/signal 结果提交都在最终短事务复核 append-only authority，基于锁内当前 attributes 只合并自有 namespace；最终拒绝不写 attributes/evidence/matched success，避免任何 pre-wire 快照复活已清理字段。

当前应用 callback 能证明的是应用可观察的调用边界；BigQuery 等第三方 SDK 内部透明重试尚不可逐 socket 复核，平台级未绑定 workspace/company subject 的 ingest 也不能伪造租户 suppression 身份。同步 reconciliation 虽已限制单批锁持有时间，但没有 durable receipt/cursor，进程中断后的主动续扫仍属于下一 durable-ops 切片；权威 suppression 与所有已治理 writer 的 fail-closed 不依赖该续扫。真实 PostgreSQL 本轮新增锁路径并发、Temporal replay、hosted Actions 与 live runtime readback 尚未证明。

这些是工作主题，不是可自动清理的分支清单。实际 owner、worktree、dirty 状态与独有提交必须通过 `pnpm worktree:inventory` 和 live task 审计确认；不得从本页推断可以接管或删除其他 worktree。

## 3. 最近一次运行观测（历史，非 current evidence）

2026-08-08 在治理隔离 worktree 的干净实现提交上运行：

```bash
pnpm code-intelligence:runtime:status
```

命令因 `.code-intelligence/runtime-evidence-v1.json` 不存在而非零退出。该带提交和日期的观测结论是 `UNKNOWN / NO_CURRENT_EVIDENCE`，不是会自动更新的实时状态，也不是运行失败、运行健康或生产状态的证明。后续代码变化不会自动升级这一事实；只有符合 [RuntimeEvidence schema](../governance/runtime-evidence.schema.json) 且仍在 `valid_until` 内的记录才可标为 current，到期记录只能保留为 historical。

## 4. 当前阻塞

1. **证据门**：当前 fresh RuntimeEvidence 数为零；历史开发验证和 TEST_ANCHOR 不可替代。
2. **发布门**：当前真实 Release Bundle 数为零，且独立外部 readback verifier 尚未实现。Bundle 中的 `CHECK_RUN / GITHUB_REVIEW / SIGNED_AUTHORIZATION`、merge 形状和 URL 都只是 documentary declaration；即使自报 `VERIFIED`，`governance:verify` 仍会以 `RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED` 阻断任何 `PILOT`/`GA` 晋级。
3. **集成门**：运行身份、roles→scopes、Suppression/DataRights、逐 wire 与 PERSONAL_DATA cleanup source 已随 #413 合入；cleanup migration/RLS/受控函数已在 disposable PostgreSQL 16 上通过 exact-head readback，但仍须在批准的 release checkout/目标环境上用真实 JWKS token、受限 role map、MinIO/S3 exact-version 删除、Temporal/Worker/Relay admission 和跨 workspace 负例形成运行证据。`APP_DATABASE_URL` 非 owner/non-superuser/non-BYPASSRLS 启动 admission 仍属于下一独立切片。
4. **仓库设置门**：仓内已声明 required contexts 与 review 规则，但 GitHub ruleset/branch protection 是外部状态，必须由有权限的人实际配置并回读验证。
5. **供应链安全门**：Dependency Review、production audit ratchet 与 CodeQL 已有 canary，但尚未全部进入 live required ruleset；当前剩余 10 项 Site Renderer/Astro advisory（含 3 high）继续绑定 `site-renderer-dependency-migration`、`OWN-SITE-BE` 与 2026-09-08 到期日。Container/Compose/IaC 门仍缺失，不能用 ratchet 或 Gitleaks 替代。
6. **产品门**：首个 pilot 的 capability、租户/数据范围、允许 provider、成功指标、退出条件、运行 Owner 与用户授权尚未形成有效 Release Bundle。

## 5. 下一决策

待恢复切片进入最新 `origin/main`、required checks 真实通过、独立 review 完成，并在该合入提交与目标环境上取得 fresh PASS RuntimeEvidence 后，由产品负责人二选一：

1. 在实现并验证独立外部 readback、得到可信 verification receipt 后，明确授权一个有界获客 capability 进入首个 pilot，并签署完整 Release Bundle；或
2. 保持 `INTERNAL_ONLY / NOT_AUTHORIZED`，指定剩余 blocker 与下一验证任务。

在此之前，不启用默认 `DISABLED` provider，不发真实模型/付费调用，不宣称生产就绪，也不从 v16/v17 create-only 技术完成或零调用 preflight 推导 capability、质量、晋级、生产路由采用或发布授权。

## 6. 追溯入口

- 当前边界：[product-scope.md](../product-scope.md)
- 当前架构：[architecture/current.md](../architecture/current.md)
- 承重决策：[ADR registry](../adr/registry.md)
- 施工路线：[release-plan.md](../roadmap/release-plan.md)
- 历史实施：[changelog.md](../roadmap/changelog.md)
- 冻结与机器证据：[evidence/README.md](../evidence/README.md)
- 交付链：[delivery-traceability.json](../governance/delivery-traceability.json)
