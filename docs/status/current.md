# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：`origin/main`、本仓机器合同、live worktree 审计与 RuntimeEvidence 状态命令
> 最后核验：2026-08-10

本页只保留当前 main、在途工作、阻塞、最新运行事实和下一次产品决策。完成史、旧验证数字、模型评测流水与 Site Builder 日期化实施细节已经迁到 [追加式 changelog](../roadmap/changelog.md) 和 [evidence 索引](../evidence/README.md)，不再在 current 页重复。

## 1. 当前基线

| 项目                    | 当前事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前远端主线            | 2026-08-10 live fetch 已确认 `origin/main@9c83756f846241a6b665c7990dbf660dcc354596`：#374 运行身份、#375 roles→scopes 以及 #377 Copy fixed-source 影响治理均已用 merge commit 合入。#372 的 v15 manifest 固定源码仍严格是 #361 merge `fcb61e3060dd3289fec93bca11d02584f8080791`；#377 只新增 source eligibility 与 `STALE_HOLD` 治理，未重建固定源、未授权 dispatch。获客接管的原始代码审计基线仍为 `4562eab1bae16cdd424ff90a7d3403b0fb30d535`；其后主线变化不改变获客实现边界。`/global/backend` 根工作区存在用户现场且不是远端主线真值，不得复位或清理。                                                                                                                                                                                                                                   |
| 产品阶段                | Site Builder Copy Sonnet recovery v15 仍是 `NOT_AUTHORIZED`、零调用 create-only 技术输入，不是 capability evidence。获客侧按“治理真值 → 可证明运行身份 → roles/scopes 与合规 → durable ops → 质量标签/identity → backend-only controlled pilot”顺序收口：运行身份已由 #374、服务端 roles→scopes 与 JWKS claim 合同已由 #375、Copy schema 漂移隔离已由 #377 进入 main。当前本地变更集继续收口 Suppression/DataRights、canonical/tenant/signal materialization、逐物理外部调用授权与付费模型 denial 结算；实现 GREEN 为 `2eb830f4880b6985d1e41227b59dc3d5992ffcff`，尚未经过最终 exact-head 独立复审、hosted CI 或合并。上述内容都仍是 source/deterministic evidence；没有部署、fresh RuntimeEvidence、Release Bundle 或真实 pilot。 |
| 当前交付状态            | Buyer/Intent 的机器追踪链均为 `INTERNAL_ONLY`。当前不存在可用于晋级的 RuntimeEvidence，也不存在真实 Release Bundle。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Source-only 质量/安全门 | 当前 main 的仓内 CI 包含 build/typecheck/test、OpenAPI drift/lint/breaking、Gitleaks，以及 #362 新增的 production dependency audit ratchet、Dependency Review 与 CodeQL canary；后两者仍是 non-required canary，container/Compose/IaC、PostgreSQL/Temporal 集成与恢复演练也尚未形成完整 required gate。2026-08-09 对 `pnpm-lock.yaml`（SHA-256 `d98a61553ffa6ea3bca177f47c7c2a82362f774697ffd4c89fa299465072e868`）使用 npm 官方 audit endpoint 的只读生产依赖审计基线为 36 项（18 high、14 moderate、4 low、0 critical）；默认 `npmmirror` audit endpoint 不存在。该结果只绑定记录中的时间、lock digest 与 production 审计口径，不是会自动更新的全量漏洞清单；依赖或 advisory 数据变化后必须重跑。                                                                                          |
| Provider 真值           | 只认 [机器 Provider Registry](../governance/provider-registry.json) 与其[生成页](../backend/provider-registry.md)；实现、默认 enablement、当前 runtime health 与 pilot 授权是不同维度。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 模型候选基线            | 当前非运行时候选合同为 `site-builder-model-candidate-baseline/2026-08-07-v3`；它不证明 active route、质量、dispatch 授权或运行健康。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Copy 技术/运行授权      | 控制面 `source_thread_id=019fc334-a6b1-79a2-bf18-185620410958` 对 #372 exact head `9bc8149bf12cea98fef38bfe5390ad4c8470360e` 的历史授权只属于原 exact head，不能复用。v15 当前 source eligibility 由[机器 receipt](../evidence/site-builder/copy-runtime-eligibility.json)逐文件重算；无漂移才是 `CURRENT`，获客等非 Copy Prisma schema 漂移必须降为 `STALE_HOLD`，且只有 schema path 可进入该例外。两种状态的真实 dispatch、promotion、production route adoption 与 pilot 都保持 `NOT_AUTHORIZED/BLOCKED`；`STALE_HOLD` 必须在任何 Copy dispatch 前重建固定源。历史 dispatch verifier 尚缺中间目录 descriptor anchoring，并且 verified handle 后漂移可能晚于 ledger/claim 打开才被拒绝；这两项必须随下一次 fixed-source rebase 关闭，当前不得宣称 ledger side effect 前的完整 TOCTOU 保证。 |

## 2. 在途工作

Site Builder Copy 的 v15 create-only 技术 PR 已完成收口；#377 又把 current/stale source 判定接入 required build。当前获客 schema 变更必须得到 `STALE_HOLD`、只允许 `packages/db/prisma/schema.prisma` 单一路径漂移，并跳过双 fixed-source rebuild；状态仍为 `NOT_AUTHORIZED/BLOCKED`。这仍只是零调用技术输入，不是 capability evidence。历史 dispatch verifier 的中间目录 descriptor anchoring 与 ledger/claim 前时序残余仍须在下一次 fixed-source rebase 关闭，当前不得创建 client 或发出 wire。

当前获客恢复计划在独立本地集成分支中收敛，范围包括：

- 治理入口、Provider Registry、RuntimeEvidence/Release Bundle、追踪与 CI 门；
- 身份/JWKS 与细粒度授权；
- 数据权利、质量标签、运行身份、worker/schedule/receipt 与运维证据；
- 首个获客 pilot 的范围、验收与退出条件准备。

运行身份 source slice 已由 #374 合入；roles→scopes slice 也已由 #375 合入，以九个闭合 scope、服务端 role map、未知 role 零权限、控制器双 guard、PII/合规复合门和 `x-required-scopes` OpenAPI 元数据为边界。当前合规变更集把 suppression 事实保留为不可物理删除、只可从 PREFERENCE 单向提升到 LEGAL；类型化 canonicalizer 在新写入和旧值读取边界共享 email/domain/company-name 规范键，非法新值在 DB 前拒绝，历史非规范事实仍可见且能继续命中。现有公司按 canonical key 分块即时更新；fit/enrich/signal/watch/contact/guess 六个 backlog/forward-run 阶段在每家外部处理前使用同一原始匹配闸，命中 legacy 事实时修复公司 `SUPPRESSED` 派生状态。ToolBroker、模型 Router、guarded HTTP redirect、provider retry/page/fallback、robots、DNS→SMTP 与 DNS→Crawl4AI dispatch 在每个应用可观察的物理动作前继续复核；denial/authorization error terminal，不得作为网络抖动重试或模型 fallback。workspace-specific robots denial 不进入共享 TTL cache。suppression 创建、canonicalize、TenantProjection、TED/openFDA/SAM signal 与 website-intent materialization、联系人/猜测提交、邮箱验证回写、Art.17 freeze/erase 与 Lead accept 共享 workspace 级事务 advisory lock；跨路径只固定 **advisory 必须先于任何 company/contact row lock**，取得 advisory 后必须在业务写入或外部动作授权前完成当前 row 与 authoritative fact 判定，禁止 row-lock→advisory 反向获取。canonicalize、Tenant、TED/FDA/SAM 与 website-intent 均同时检查 incoming 与 existing canonical identity；命中只修复 `SUPPRESSED` 派生状态并停止 link/intent/evidence 写。backlog watch 也把 company-scoped callback 传入 sitemap/probe/redirect。付费模型在首个 wire 前被拒时以 `RELEASED/not_incurred/callCount=0` 收口且不冻结；repair 前拒绝仍结算已发生首调。新禁 email/domain/contact_key 的联系人不进 `LeadQualifiedPackage`；如果剩余可达点为零，accept 以 `SUPPRESSED_CONTACT_UNREACHABLE` 拒绝，不写 LeadDecision/Outbox。`GET /events` 因可能返回 RESTRICTED `LeadQualified.contact_refs`，现同时要求 `acquisition:read` 与 `personal-data:read`；ACK 仍独立要求 `acquisition:event:ack`。普通 release/identity-correction 操作同时保留原始 command 和裁决 outcome 的 append-only decision，幂等键不再折叠不同原始 reason；DB 约束语义组合，含审计/PII 的列表有 cursor page envelope/100 行响应硬上限，生成 OpenAPI 显式列出 Lead accept/reject 与 suppression 操作实际可达的 400/404/409 统一 error envelope 与 UUID path。Lead accept 的 DataRights DENY 在 sanctions 等后续异常门前提交公司禁联派生状态和 append-only policy log，再返回 409。DevTokenVerifier 仍只允许显式 development、显式 `AUTH_ALLOW_DEV_TOKENS=true` 与 loopback bind；这些 source 状态不能替代 SaaS 真 token、live startup admission、跨 workspace 负例或部署回读。

当前应用 callback 能证明的是应用可观察的调用边界；BigQuery 等第三方 SDK 内部透明重试尚不可逐 socket 复核，平台级未绑定 workspace/company subject 的 ingest 也不能伪造租户 suppression 身份。真实 PostgreSQL 本轮新增锁路径并发、Temporal replay、hosted Actions 与 live runtime readback 尚未证明。

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
3. **集成门**：运行身份与 roles→scopes source slice 已合入，但仍须在批准的 release checkout/目标环境上用真实 JWKS token、受限 role map 和跨 workspace 负例形成运行证据。当前 Suppression/DataRights/逐 wire 变更虽已通过本地全量测试，仍须完成 exact-head 独立 review、真实 PostgreSQL 新锁路径并发、hosted CI 与主线合并；`APP_DATABASE_URL` 非 owner/non-superuser/non-BYPASSRLS 启动 admission 仍属于下一独立切片。
4. **仓库设置门**：仓内已声明 required contexts 与 review 规则，但 GitHub ruleset/branch protection 是外部状态，必须由有权限的人实际配置并回读验证。
5. **供应链安全门**：Dependency Review、production audit ratchet 与 CodeQL 已有 canary，但尚未进入 live required ruleset；遗留 36 项 advisory（含 18 high）仍须按到期日完成可达性分流和有界升级。Container/Compose/IaC 门仍缺失，不能用 ratchet 或 Gitleaks 替代。
6. **产品门**：首个 pilot 的 capability、租户/数据范围、允许 provider、成功指标、退出条件、运行 Owner 与用户授权尚未形成有效 Release Bundle。

## 5. 下一决策

待恢复切片进入最新 `origin/main`、required checks 真实通过、独立 review 完成，并在该合入提交与目标环境上取得 fresh PASS RuntimeEvidence 后，由产品负责人二选一：

1. 在实现并验证独立外部 readback、得到可信 verification receipt 后，明确授权一个有界获客 capability 进入首个 pilot，并签署完整 Release Bundle；或
2. 保持 `INTERNAL_ONLY / NOT_AUTHORIZED`，指定剩余 blocker 与下一验证任务。

在此之前，不启用默认 `DISABLED` provider，不发真实模型/付费调用，不宣称生产就绪，也不从 v15 create-only 技术完成推导 capability、质量、晋级、生产路由采用或发布授权。

## 6. 追溯入口

- 当前边界：[product-scope.md](../product-scope.md)
- 当前架构：[architecture/current.md](../architecture/current.md)
- 承重决策：[ADR registry](../adr/registry.md)
- 施工路线：[release-plan.md](../roadmap/release-plan.md)
- 历史实施：[changelog.md](../roadmap/changelog.md)
- 冻结与机器证据：[evidence/README.md](../evidence/README.md)
- 交付链：[delivery-traceability.json](../governance/delivery-traceability.json)
