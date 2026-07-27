# Site Builder 模型评测 Harness 基线

> 机器合同：`site-builder-model-evaluation-harness/2026-07-27-v1`；候选来源：`site-builder-model-candidate-baseline/2026-07-27-v1`。本文件由代码计划生成并由 `pnpm docs:verify` 精确校验，不得手抄另一个任务矩阵。

## 范围

- 这是离线、未接生产依赖的内存合同；没有真实模型请求、评测 evidence、运行路由或发布行为。
- 7 个 task 都有候选与生产 envelope 计划；只有具备 canonical task contract、fixture set、重复次数和 evaluator 的 task 才允许 dispatch。
- 当前唯一可 dispatch suite 是 BrandProfile；其余 6 个 task fail-closed 为 `blocked_no_evaluation_suite`。媒体、无 task consumer、preview、deferred 与 legacy-only 候选继续由 candidate baseline 阻断。

## Task 计划

| task | profile | dispatch | canonical suite | candidate / protocol | max tokens | runtime deadline | diagnostic window | hard stop | per-call cap | reasoning |
|---|---|---|---|---|---:|---:|---:|---:|---:|---|
| `site_builder.brand_profile` | `structured.workspace_materials` | `task_evaluation_ready` | `site-builder.brand-profile-evaluation-suite/2026-07-27-v1` | `gpt-5.6-terra` / `openai-responses`<br>`claude-sonnet-5` / `anthropic-messages`<br>`gpt-5.5` / `openai-responses` | 12000 | 240s | 240s | 480s | 40¢ | low |
| `site_builder.copy` | `copy.premium` | `blocked_no_evaluation_suite` | — | `claude-sonnet-5` / `anthropic-messages`<br>`gpt-5.5` / `openai-responses`<br>`gpt-5.6-terra` / `openai-responses` | 4000 | 120s | 120s | 240s | 20¢ | low |
| `site_builder.design_spec` | `structured.default` | `blocked_no_evaluation_suite` | — | `gpt-5.6-terra` / `openai-responses`<br>`gpt-5.5` / `openai-responses`<br>`claude-sonnet-5` / `anthropic-messages` | 4000 | 120s | 120s | 240s | 20¢ | — |
| `site_builder.assemble` | `structured.default` | `blocked_no_evaluation_suite` | — | `gpt-5.6-terra` / `openai-responses`<br>`gpt-5.5` / `openai-responses`<br>`claude-sonnet-5` / `anthropic-messages` | 16000 | 180s | 180s | 360s | 20¢ | — |
| `site_builder.assembly_fix` | `structured.default` | `blocked_no_evaluation_suite` | — | `gpt-5.6-terra` / `openai-responses`<br>`gpt-5.5` / `openai-responses`<br>`claude-sonnet-5` / `anthropic-messages` | 8000 | 180s | 180s | 360s | 20¢ | — |
| `site_builder.qa_summarize` | `text.summary` | `blocked_no_evaluation_suite` | — | `gpt-5.6-luna` / `openai-responses`<br>`gpt-5.4-mini` / `openai-responses`<br>`gpt-5.6-terra` / `openai-responses` | 3000 | 90s | 90s | 180s | 20¢ | — |
| `site_builder.seo_review` | `text.summary` | `blocked_no_evaluation_suite` | — | `gpt-5.6-luna` / `openai-responses`<br>`gpt-5.4-mini` / `openai-responses`<br>`gpt-5.6-terra` / `openai-responses` | 3000 | 90s | 90s | 180s | 20¢ | — |

## Canonical suite

- suite：`site-builder.brand-profile-evaluation-suite/2026-07-27-v1`
- adapter：`site-builder.brand-profile-evaluation-adapter/v1`
- task contract：`site_builder.brand_profile` / prompt `brand-profile/14` / route validation `brand-profile-route-validation/14`
- fixture set：`site-builder.brand-profile-golden/2026-07-18-v1`；schema `brand-profile-eval-fixture/v1`；6 fixtures × 2 repeats = 12 runs/model
- fixtures：`auto-parts-rich`、`auto-parts-sparse`、`industrial-pump-rich`、`industrial-pump-sparse`、`lab-instrument-rich`、`lab-instrument-sparse`
- source bundle contract：`brand-profile-evaluation-source-bundle/v2`；同一比较组必须固定为一个 source bundle SHA-256
- evaluator：`brand-profile-evaluator/10`；rubric SHA-256 `c94e11eff737b0ac9459bde0fe14ad848e35bb0b288c24ff0ac756e2620e1e3c`

## 闭合结果与排序

- 结果类：`quality_valid_runtime_on_time`、`quality_valid_runtime_late`、`content_invalid`、`protocol_or_identity_invalid`、`provenance_invalid`、`capability_unavailable`、`diagnostic_window_exhausted`、`budget_stop`。
- runtime deadline 只标记 late；hard stop 才中止，且 hard-stop 后观测到的完成不能回写成质量有效。
- 先按 quality → structure → factuality → fixture 内 stability，再按 accepted-artifact P95 latency → 全部已结算尝试成本/accepted artifact 排序。
- matrix 必须精确等于 suite 的 fixtureIds × repeats；缺失、意外或重复 key 均不可排名；超出 repeats 的尝试在 dispatch 前拒绝。

## 预算与 provenance

- 每次调用先 reserve campaign/per-call 上界；unknown 或 malformed settlement 保留上界并冻结后续 dispatch。当前调用超过 per-call cap 时保留质量观察，但标记预算硬失败并不可排名。
- 每个 run 固定保存 expected/actual protocol、requested/reported/resolved model、resolution source、usage source/call count、cost basis，以及 task contract、fixture、prompt、source bundle contract/source bundle、evaluator rubric 和 artifact SHA-256；汇总时重新校验，不信任记录中的通过标志。
- 可用性、协议、身份、usage、artifact fingerprint、matrix、预算和成本任一未闭合，都不能生成可晋级排名。
