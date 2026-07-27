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
- task contract：`site_builder.brand_profile` / prompt `brand-profile/14` / route validation `brand-profile-route-validation/14`；dispatch 同时绑定冻结 output schema 与 `repairTaskOutput=true`
- fixture set：`site-builder.brand-profile-golden/2026-07-18-v1`；schema `brand-profile-eval-fixture/v1`；6 fixtures × 2 repeats = 12 runs/model
- fixtures：`auto-parts-rich`、`auto-parts-sparse`、`industrial-pump-rich`、`industrial-pump-sparse`、`lab-instrument-rich`、`lab-instrument-sparse`
- source bundle contract：`brand-profile-evaluation-source-bundle/v2`；固定 31 份仓库内源码/合同文件，路径条目深度冻结且禁止绝对/逃逸路径，同一比较组必须固定为一个 source bundle SHA-256，且每次调用完成后必须重新指纹
- dispatch payload：fixture、prepared task input、prompt 与 source fingerprints 全部由 canonical case builder 构造、冻结并纳入 case SHA-256；executor 不能替换为未绑定内容。
- capability probe：baseline 标记为 probe-required 的候选只能由 harness-owned campaign 发起 canonical task-shaped probe；probe 与矩阵共享预算，绑定 harness/baseline/task/candidate/protocol/source scope，只有协议、requested/reported/resolved identity、完整输出、schema/生产 PII gate、usage、成本结算和调用后 source re-fingerprint 全部闭合才生成 attestation。run/summary/ranker 只信模块私有 WeakSet、私有 campaign 状态与捕获的原型读取器，裸 observation、duck-typed object、不同预算 campaign 或公开字段 self-hash 均不能解锁。本 PR 仅保证同进程内存信任；后续持久 evidence 必须另建 create-only/signed trust anchor，不能复用 self-hash 冒充验真。
- evaluator：`brand-profile-evaluator/10`；rubric SHA-256 `c94e11eff737b0ac9459bde0fe14ad848e35bb0b288c24ff0ac756e2620e1e3c`；harness 内部依次执行 output schema、生产 `validateOutput` 与 canonical task rubric，不接受 caller 自带 grader。

## 闭合结果与排序

- 结果类：`quality_valid_runtime_on_time`、`quality_valid_runtime_late`、`content_invalid`、`protocol_or_identity_invalid`、`provenance_invalid`、`capability_unavailable`、`diagnostic_window_exhausted`、`budget_stop`。
- 单次 runtime deadline 只把结果标记为 late 并保留质量观察；候选 accepted-artifact P95 超过生产 deadline 时不得 rankable/晋级。hard stop 才中止，使用 monotonic clock 记录实际耗时，异常时钟 fail-closed，且 hard-stop 后观测到的完成不能回写成质量有效。
- 先按 quality → structure → factuality → fixture 内 stability；通过生产 P95 硬门后，再按 accepted-artifact P95 latency → 全部已结算尝试成本/accepted artifact 排序。
- matrix 必须精确等于 suite 的 fixtureIds × repeats；缺失、意外或重复 key 均不可排名；超出 repeats 的尝试在 dispatch 前拒绝；ranker 只接受 plan + raw runs 并在内部重新生成 summary。

## 预算与 provenance

- 每次调用先 reserve campaign/per-call 上界；budget guard 使用模块私有 WeakSet 品牌、JavaScript 私有状态与捕获的 reserve/settle 原型方法，duck/Proxy budget 或实例/prototype monkeypatch 都不能绕过。unknown 或 malformed settlement 保留上界并冻结后续 dispatch。`rejected_before_dispatch` 只允许本地 reserve 拒绝路径，probe/matrix 在 executor 进入后声称该 reason 一律归 unknown 并冻结；当前调用超过 per-call cap 时保留质量观察，但标记预算硬失败并不可排名。
- 每个 run 固定保存 expected/actual protocol、requested/reported/resolved model、resolution source、usage source/call count、cost basis，以及 task contract、fixture、prompt、source bundle contract/source bundle、evaluator rubric 和所需 capability-probe attestation。原始 artifact 只有先通过 output schema 与生产 PII/route gate 才可保留；被拒绝输出只留 SHA-256 digest 与拒绝原因，不把 PII/schema-invalid 原文写入 evidence。汇总时重新执行 canonical evaluator，不信任记录中的通过标志。
- 可用性、协议、身份、probe attestation、usage、artifact fingerprint、matrix、生产 P95、预算和成本任一未闭合，都不能生成可晋级排名。
