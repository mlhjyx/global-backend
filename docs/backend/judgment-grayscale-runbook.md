# 判定灰度与回滚手册（J22）

> 生命周期：`DRAFT`
> 生命周期依据：矩阵/回滚计划已入库且演练脚本可跑；线上开启与首次真实演练待发车后执行（2026-11-09）。

## 1. 两个开关

| 开关 | 取值 | 作用 |
| --- | --- | --- |
| `JUDGE_CONTRACT_MODE` | `off`（默认）/ `shadow` / `enforce` | off=旧 v1 路径逐字不变；shadow=双跑（Lead 仍由 v1 决定，v2 写 `judgment_record` 容错）；enforce=Lead 改用 v2 聚合 verdict |
| `JUDGE_PANEL_MODE` | `off`（默认）/ `shadow` / `enforce` | borderline（聚合 UNKNOWN 且加权分 3.5–7.0、非证据门/注入/拒答）时三模型面板；仅在 v2 路径内生效 |

非法值一律按 `off` 处理（拼写错误不改变生产判定），但演练脚本会报警并退出 1。
注意：设计 §4.3.3.6 旧文写的 `off|borderline` 已被 `off|shadow|enforce` 取代（J12 实现口径）。

## 2. 灰度阶段（每阶段至少观察 48h 再进下一档）

1. **基线**（off/off）→ 2. **contract=shadow**（看 `judgment_record` 覆盖率与 v1/v2 verdict 分歧率）→
3. **contract=enforce / panel=shadow**（Lead 切 v2；看 overturn 与失败码分布）→
4. **contract=enforce / panel=enforce**（borderline 面板定 verdict；看弃权率/成本）。

进入 enforcement 的前置条件：J11 金标 15 例 CI 绿（已满足）；J13 标注集 kappa ≥0.6（未满足前，enforce 只允许在 dev 观察）。

## 3. 每阶段看什么（值班第一屏）

- `judgment_record` 新增速率与 `judge_level` 分布；`failure_code` Top-5（`stage/cause` 分组）。
- v1/v2 分歧：shadow 期同一 (company,icp) 新旧 verdict 不一致率（目标 <10%，超标回 shadow）。
- `hard_gate_result`：G1 四态分布（yellow/red 占比）、G5 UNKNOWN 与补数队列积压。
- 成本：`judgment_record.cost_micros` 按日汇总；enforce+panel 期约为单模型的 3×。
- overturn：`/api/v1/judgments/stats`（J17）周报表。

## 4. 演练（任何环境）

```bash
pnpm --filter @global/api exec tsx scripts/judgment/mode-drill.mts
JUDGE_CONTRACT_MODE=enforce JUDGE_PANEL_MODE=shadow pnpm --filter @global/api exec tsx scripts/judgment/mode-drill.mts
```

输出：四阶段清单、当前环境解析出的矩阵条目（Lead 由谁决定、写哪些记录）、非法值警告、回滚计划。退出码 1 = 环境值非法。

## 5. 回滚（目标 <5 分钟）

1. 运行 env 置 `JUDGE_CONTRACT_MODE=off`、`JUDGE_PANEL_MODE=off`（删键等价）。
2. `sudo bash local-config/global/runtime.sh restart api worker`（worker 是判定活动执行者，必须一起重启）。
3. `gctl health` 就绪；`mode-drill` 显示 contract=off；新一轮 run 不再新增 `judgment_record`。
4. 把 drill 输出与 `/api/v1/health/build` 的 build_sha 贴进事故记录或 `_archive/` 切换记录。

回滚不影响历史：`judgment_record`/`hard_gate_result` 均 append-only，旧判定保留可审计；Lead 投影回到 v1 由下一次判定自然刷新。

## 6. 已知边界

- shadow 期 `judgment_record` 与 v1 Lead 可能不一致——这是设计上的观察信号，不是故障。
- v2 调用当前非 durable（无网关 replay 保护），重试成本由 24h LLM 缓存兜底。
- `judgment_record.run_id` 暂为空（调用点只有预算 accountKey）。
