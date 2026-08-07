# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：`origin/main`、本仓机器合同、live worktree 审计与 RuntimeEvidence 状态命令
> 最后核验：2026-08-07

本页只保留当前 main、在途工作、阻塞、最新运行事实和下一次产品决策。完成史、旧验证数字、模型评测流水与 Site Builder 日期化实施细节已经迁到 [追加式 changelog](../roadmap/changelog.md) 和 [evidence 索引](../evidence/README.md)，不再在 current 页重复。

## 1. 当前基线

| 项目 | 当前事实 |
|---|---|
| 本次主线审计快照 | `origin/main@4562eab1bae16cdd424ff90a7d3403b0fb30d535`；2026-08-07 在治理隔离 worktree 中核验。这个 SHA 是带日期的审计快照，不是会自动前移的 current 指针；每个新任务仍须 live 读取远端。`/global/backend` 本地主工作区存在用户现场且不是远端主线真值，不得复位或清理。 |
| 产品阶段 | Site Builder M1 收口属于已完成历史；获客侧新增开发冻结已解除，当前处于“恢复前治理、授权、运行身份与可观测性补齐”，尚未进入首个受控 pilot。 |
| 当前交付状态 | Buyer/Intent 的机器追踪链均为 `INTERNAL_ONLY`。当前不存在可用于晋级的 RuntimeEvidence，也不存在真实 Release Bundle。 |
| Provider 真值 | 只认 [机器 Provider Registry](../governance/provider-registry.json) 与其[生成页](../backend/provider-registry.md)；实现、默认 enablement、当前 runtime health 与 pilot 授权是不同维度。 |
| 模型候选基线 | 当前非运行时候选合同为 `site-builder-model-candidate-baseline/2026-08-04-v2`；它不证明 active route、质量、dispatch 授权或运行健康。 |
| 合并/发布授权 | `NOT_AUTHORIZED`。机器检查、独立 reviewer、用户授权和 merge-method provenance 必须分别取证。 |

## 2. 在途工作

当前恢复计划由多个隔离 writer 并行收敛，范围包括：

- 治理入口、Provider Registry、RuntimeEvidence/Release Bundle、追踪与 CI 门；
- 身份/JWKS 与细粒度授权；
- 数据权利、质量标签、运行身份、worker/schedule/receipt 与运维证据；
- 首个获客 pilot 的范围、验收与退出条件准备。

这些是工作主题，不是持久分支清单。实际 owner、worktree、dirty 状态与独有提交必须通过 `pnpm worktree:inventory` 和 live agent/task 审计确认；不得从本页推断可以接管或清理其他 worktree。

## 3. 最近一次运行观测（历史，非 current evidence）

2026-08-07 在 `/global/backend/.codex/worktrees/acquisition-governance-foundation` 的干净提交 `35145699db63fc8aef2350a0ca331fef9724f617` 上运行：

```bash
pnpm code-intelligence:runtime:status
```

命令因 `.code-intelligence/runtime-evidence-v1.json` 不存在而非零退出。该带提交和日期的观测结论是 `UNKNOWN / NO_CURRENT_EVIDENCE`，不是会自动更新的实时状态，也不是运行失败、运行健康或生产状态的证明。后续代码变化不会自动升级这一事实；只有符合 [RuntimeEvidence schema](../governance/runtime-evidence.schema.json) 且仍在 `valid_until` 内的记录才可标为 current，到期记录只能保留为 historical。

## 4. 当前阻塞

1. **证据门**：当前 fresh RuntimeEvidence 数为零；历史开发验证和 TEST_ANCHOR 不可替代。
2. **发布门**：当前真实 Release Bundle 数为零；任何 `PILOT`/`GA` 声明都会被 `governance:verify` 阻断。
3. **集成门**：并行恢复切片尚需逐项确认 ownership、合入 main、检查 review/CI，并在合入提交上重新生成运行证据。
4. **仓库设置门**：仓内已声明 required contexts 与 review 规则，但 GitHub ruleset/branch protection 是外部状态，必须由有权限的人实际配置并回读验证。
5. **产品门**：首个 pilot 的 capability、租户/数据范围、允许 provider、成功指标、退出条件、运行 Owner 与用户授权尚未形成有效 Release Bundle。

## 5. 下一决策

待恢复切片进入最新 `origin/main`、required checks 真实通过、独立 review 完成，并在该合入提交与目标环境上取得 fresh PASS RuntimeEvidence 后，由产品负责人二选一：

1. 明确授权一个有界获客 capability 进入首个 pilot，并签署完整 Release Bundle；或
2. 保持 `INTERNAL_ONLY / NOT_AUTHORIZED`，指定剩余 blocker 与下一验证任务。

在此之前，不启用默认 `DISABLED` provider，不发真实模型/付费调用，不宣称生产就绪，也不从技术完成推导合并或发布授权。

## 6. 追溯入口

- 当前边界：[product-scope.md](../product-scope.md)
- 当前架构：[architecture/current.md](../architecture/current.md)
- 承重决策：[ADR registry](../adr/registry.md)
- 施工路线：[release-plan.md](../roadmap/release-plan.md)
- 历史实施：[changelog.md](../roadmap/changelog.md)
- 冻结与机器证据：[evidence/README.md](../evidence/README.md)
- 交付链：[delivery-traceability.json](../governance/delivery-traceability.json)
