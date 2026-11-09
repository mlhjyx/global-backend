# 存量重判批次（J21）操作手册

> 生命周期：`DRAFT`
> 生命周期依据：规划器与操作手册已入库；真实重判执行待发车后补跑并落证据（2026-11-09）。

## 1. 它能做什么

`apps/api/scripts/judgment/rejudge-batch.mts` 是**只读规划器**：从 ACTIVE ICP 与 `canonical_company` 中找出「尚未用当前 `prompt_hash` + `rubric_version`（fit-v2）判过」的候选，按「有域名优先」排序，切批并给出成本估算。它不调用模型、不写库。

真实重判由发车后的 worker 执行（`JUDGE_CONTRACT_MODE` 与预算帽就绪后），本手册预留执行步骤与验收口径。

## 2. 规划

```bash
pnpm --filter @global/api exec tsx scripts/judgment/rejudge-batch.mts --workspace <uuid> \
  --max-companies 100 --batch-size 25 --cost-cap-usd 5 [--json plan.json]
```

- 成本口径：每家公司一次 L2 判定 ≈ **$0.0099（9900 micros，k=1）**，来自设计 §4.3.3.7 的实测均值；pro 档目录价浮动时以网关实际账为准。
- **超帽拒绝规划**（`REJUDGE_COST_CAP_EXCEEDED`），不静默截断——截断会让「完成率」变成假指标。要少判就显式调低 `--max-companies`。
- `--execute` 当前**显式拒绝**（退出码 3），防止在未发车环境误跑模型。

## 3. 发车后的执行（待补）

1. 确认新镜像已发车、`/health/ready` 与 Worker 就绪门通过。
2. 以 ops 身份分批触发：按 planner 输出的批次（≤25 家/批、每批 ≤$0.25 估算）逐批执行；
   首批建议 1 批（25 家）观察 24h 的失败码分布与成本对账。
3. 每批记录：完成率、失败率（按 `failure-codes` 分组）、实际成本（`judgment_record.cost_micros` 汇总）、
   overturn（与旧判定不一致比例）。
4. 异常即停：失败率 >15%、成本 >估算 3×、或出现 `PROMPT_INJECTION_DETECTED` 集中命中。

## 4. 验收口径（J21）

- 每批完成率/失败率/成本报表各一份（`docs/evidence/` 或 PR 评论）。
- 5,013 家全量重判不在一次执行内完成：按批推进，`judge_record` 的 replay 键保证重跑不翻行。

## 5. 回滚

重判只**追加** `judgment_record` 与更新 Lead 投影；回滚 = 把 `JUDGE_CONTRACT_MODE` 置回 `off` 并重启 worker（<5 分钟），旧判定路径恢复，历史记录保留可审计。
