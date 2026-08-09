# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：`origin/main`、本仓机器合同、live worktree 审计与 RuntimeEvidence 状态命令
> 最后核验：2026-08-10

本页只保留当前 main、在途工作、阻塞、最新运行事实和下一次产品决策。完成史、旧验证数字、模型评测流水与 Site Builder 日期化实施细节已经迁到 [追加式 changelog](../roadmap/changelog.md) 和 [evidence 索引](../evidence/README.md)，不再在 current 页重复。

## 1. 当前基线

| 项目                    | 当前事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前远端主线            | 2026-08-10 live fetch 已确认 `origin/main` 包含 #372 merge commit `ef603762359fa20c2fbbef93a62e523ed5b312c7`，该提交是本轮 Copy 技术收口基线；精确远端 tip 属易漂移外部状态，必须实时 fetch，不由本文档冻结。#360 已以 merge commit 合入 v14 create-only manifest/runtime binding，#361 又合入 Anthropic Messages 动态 object schema 语义与 dispatch 前 64 KiB UTF-8 schema 上限；#362 随后合入独立的供应链 canary/audit ratchet，未改 Copy/runtime 源码；#372 最后以 merge commit 合入 v15 create-only contract、manifest/runtime binding、CI fixed-source 双重重建与权威文档。v15 manifest 的固定源码仍严格是 #361 merge `fcb61e3060dd3289fec93bca11d02584f8080791`，不能随无关主线或 #372 merge 提交漂移。获客接管的原始代码审计基线仍为 `4562eab1bae16cdd424ff90a7d3403b0fb30d535`；其后主线变化不改变获客实现边界。`/global/backend` 根工作区存在用户现场且不是远端主线真值，不得复位或清理。                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 产品阶段                | Site Builder Copy Sonnet recovery v15 仍是 #372 合入的 `NOT_AUTHORIZED`、零调用 create-only 技术输入，不是 capability evidence。获客侧按“治理真值 → 可证明运行身份 → roles/scopes 与合规 → durable ops → 质量标签/identity → backend-only controlled pilot”顺序收口：API build attestation、controlled mode 安全收敛与 layered health 已由 #374 进入 main；服务端 roles→scopes、JWKS claim 合同、控制器最小权限和 OpenAPI scope 元数据已由 #375 以 merge commit `5b588353fba6cdbda3a7e0f5f171a3e2fabbc786` 进入 main并通过 main push canary。当前变更集只继续收口 Suppression append-only release/correction decision 与 DataRights DENY 审计。上述内容都仍是 source/deterministic evidence；没有部署、fresh RuntimeEvidence、Release Bundle 或真实 pilot。 |
| 当前交付状态            | Buyer/Intent 的机器追踪链均为 `INTERNAL_ONLY`。当前不存在可用于晋级的 RuntimeEvidence，也不存在真实 Release Bundle。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Source-only 质量/安全门 | 当前 main 的仓内 CI 包含 build/typecheck/test、OpenAPI drift/lint/breaking、Gitleaks，以及 #362 新增的 production dependency audit ratchet、Dependency Review 与 CodeQL canary；后两者仍是 non-required canary，container/Compose/IaC、PostgreSQL/Temporal 集成与恢复演练也尚未形成完整 required gate。2026-08-09 对 `pnpm-lock.yaml`（SHA-256 `d98a61553ffa6ea3bca177f47c7c2a82362f774697ffd4c89fa299465072e868`）使用 npm 官方 audit endpoint 的只读生产依赖审计基线为 36 项（18 high、14 moderate、4 low、0 critical）；默认 `npmmirror` audit endpoint 不存在。该结果只绑定记录中的时间、lock digest 与 production 审计口径，不是会自动更新的全量漏洞清单；依赖或 advisory 数据变化后必须重跑。                                                                                                                                                                                                                                                                                                                        |
| Provider 真值           | 只认 [机器 Provider Registry](../governance/provider-registry.json) 与其[生成页](../backend/provider-registry.md)；实现、默认 enablement、当前 runtime health 与 pilot 授权是不同维度。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 模型候选基线            | 当前非运行时候选合同为 `site-builder-model-candidate-baseline/2026-08-07-v3`；它不证明 active route、质量、dispatch 授权或运行健康。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Copy 技术/运行授权      | 控制面 `source_thread_id=019fc334-a6b1-79a2-bf18-185620410958` 对 #372 exact head `9bc8149bf12cea98fef38bfe5390ad4c8470360e` 的技术 push、Ready PR 与 merge-commit 授权已在全部机器检查、独立 code/security review、GitHub Codex review 与决策卡 freshness 通过后消费；结果为双亲 merge commit `ef603762359fa20c2fbbef93a62e523ed5b312c7`。仓库没有可信外部 readback，因此该控制面声明继续只记为 `EXTERNAL_UNVERIFIED`，且已消费的技术授权不得由未来会话、其他 PR 或新 head 推断或复用。v15 真实 dispatch、promotion 与 production route adoption 均为 `NOT_AUTHORIZED`；技术合并不得推导任何运行或发布授权。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 2. 在途工作

Site Builder Copy 的 v15 create-only 技术 PR 已完成收口：#372 的 RED → GREEN → clean manifest → clean tracked-manifest runtime binding 提交链、exact-head CI、独立 code/security review、GitHub Codex review、merge-commit 形状与 post-merge ancestry/artifact/compiled-runtime/docs 重验均已通过；post-merge 重建继续得到 v14 manifest/runtime binding file SHA-256 `e86f5d17…` / `1ad6088a…` 与 v15 manifest/runtime binding file SHA-256 `0ce90bf7…` / `838121cc…`。这仍只是零调用技术输入，不是 capability evidence。当前 Copy 下一门是另行准备全新的 purpose-specific Sonnet-only finite credential、known settlement/ledger 与 v15 exact dispatch 决策卡；没有新的明确 v15 dispatch 授权不得创建 client 或发出任何 wire。Terra/Sol v11 成功 wire，以及 v12/v13/v14 authorization/wire 均不得重放，MiniMax/Doubao 保持 retired。Capability 成功后，真实 36/72 quality、promotion 与 production route adoption 仍须按四道独立门分别取证、审查与授权。

当前获客恢复计划在独立本地集成分支中收敛，范围包括：

- 治理入口、Provider Registry、RuntimeEvidence/Release Bundle、追踪与 CI 门；
- 身份/JWKS 与细粒度授权；
- 数据权利、质量标签、运行身份、worker/schedule/receipt 与运维证据；
- 首个获客 pilot 的范围、验收与退出条件准备。

运行身份 source slice 已由 #374 合入；roles→scopes slice 也已由 #375 合入，以九个闭合 scope、服务端 role map、未知 role 零权限、控制器双 guard、PII/合规复合门和 `x-required-scopes` OpenAPI 元数据为边界。当前合规变更集把 suppression 事实保留为不可物理删除、只可从 PREFERENCE 单向提升到 LEGAL，并把普通 release/identity-correction 操作改为带 request/actor/reason/time 的 append-only decision；法定 suppression 的 release 只写拒绝审计。Lead accept 的 DataRights DENY 同样先提交 append-only policy log，再返回 409，且不更新 Lead、不写 LeadDecision/Outbox。DevTokenVerifier 仍只允许显式 development、显式 `AUTH_ALLOW_DEV_TOKENS=true` 与 loopback bind；这些 source 状态不能替代 SaaS 真 token、live startup admission、跨 workspace 负例或部署回读。

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
3. **集成门**：运行身份与 roles→scopes source slice 已合入，但仍须在批准的 release checkout/目标环境上用真实 JWKS token、受限 role map 和跨 workspace 负例形成运行证据。当前 Suppression/DataRights 变更仍须完成 exact-head hosted CI、独立 review 与主线合并；`APP_DATABASE_URL` 非 owner/non-superuser/non-BYPASSRLS 启动 admission 仍属于下一独立切片。
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
