# 工作流可调常量输入化 · 剩余清单（L01 后续）

> 生命周期：`APPROVED`
> 生命周期依据：交接总纲 `/home/xin/.claude/plans/handoff-acq-remediation-2026-11-08.md` WP B1（产品负责人 2026-11-08 批准 Phase 1 顺序 B1→B5）与协调计划 §0.7-H 架构审计 L01；B1 PR 完成 discovery 与 raw-retention 两处，本文登记其余待输入化的 workflow 常量与验收口径。

## 背景

Temporal 重放要求工作流按记录的历史命令序列重新调度。参与分支/循环的模块级数值常量被修改后，在飞历史重放会得到不同的命令序列（NDE）。B1（PR #839）确立的模式：

1. 数值随**启动输入**写入历史（relay / schedule 注入，缺省=冻结现值）；
2. workflow 重放只读录制值，不引用可变区间；
3. `scripts/governance-workflow-constants.mjs` 扫描 `apps/**/*.workflow.ts` 与 `*.workflow-knobs.ts`，未登记的数值常量直接失败，冻结值另由 spec 逐值 pin。

## 待输入化清单（allowlist 中标注 pending input-ization 的条目）

| 文件 | 常量 | 现值 | 用途 | 验收 |
| --- | --- | --- | --- | --- |
| `apps/api/src/temporal/external-intent.workflow.ts` | `LIVE_REFRESH_EVERY` | 25 | 每 N 次循环插一次实时刷新 | 改为可选输入字段（缺省 25，冻结）+ replay 测试（录制值被重放尊重；缺省历史重放不变） |
| `apps/api/src/temporal/kb-recovery.workflow.ts` | `MAX_CANDIDATES` / `MAX_CONCURRENCY` | 10 / 5 | 恢复扫描的候选上限与并发 | 同上；两个值都要有 replay 用例 |
| `apps/api/src/temporal/personal-artifact-cleanup.workflow.ts` | `COMMANDS_PER_HISTORY` | 50 | continueAsNew 前每段命令数 | 同上；注意 continueAsNew 需随输入传递 |
| `apps/api/src/temporal/refurbish.workflow.ts` | `MAX_IMAGE_BATCHES_PER_BUILD` | 256 | 单次构建的图片批次上限 | 同上 |
| `apps/api/src/temporal/domain-resolution.workflow.ts` | `DOMAIN_RESOLUTION_MAX_COMPANIES` | 50 | 启动输入的规模守卫（任何活动之前校验；调低会让已记录的大输入重放失败） | 改为可选输入字段（缺省 50，冻结）+ replay 测试 |

`apps/api/scripts/workflows/asset-cleanup-verifier.workflow.ts` 的两个计时常量属于本地验证 workflow（不进生产 worker），只登记原因、不排期。

## 统一验收口径（每个文件）

- 常量成为启动输入的可选字段，缺省=现值（冻结，注册进 governance 白名单的 frozen-default 理由）；
- 注入点（relay / schedule args）写显式值；workflow 重放不引用可变边界；
- 新增 replay 测试：旧历史（无字段）按冻结默认重放 + 录制值被尊重（忽略输入时用例转红）；
- 移除 allowlist 的 pending 条目，冻结默认仍保留 allowlist 条目。

## 状态

- 2026-11-08：B1 完成 discovery（池阈值/深挖并发/查询批）与 raw-retention（三个循环上界 + 三个夹取上限）；本清单四项待开工，不阻塞 Phase 1。
- 2026-11-10：登记 `domain-resolution.workflow.ts` 的 `DOMAIN_RESOLUTION_MAX_COMPANIES`（ch03 执行面 3b 引入），同样不阻塞本阶段。
