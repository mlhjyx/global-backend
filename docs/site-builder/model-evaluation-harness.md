# Site Builder 模型评测 Harness 基线

> 机器合同：`site-builder-model-evaluation-harness/2026-07-28-v3`；成本安全合同：`site-builder-model-evaluation-cost-safety/2026-07-28-v1`；候选来源：`site-builder-model-candidate-baseline/2026-07-27-v1`。本文件由代码计划生成并由 `pnpm docs:verify` 精确校验，不得手抄另一个任务矩阵。

## 范围

- 这是 evaluation-only、依赖注入的协议 executor 与内存 harness；只通过显式 wire client/cost resolver seam 执行，未接生产依赖。
- 本 PR 只使用 fake gateway/fetch 与 fake settlement；没有真实模型/媒体请求、评测 evidence、运行路由、env、公共 API、DB、Temporal 或发布行为。
- 7 个 task 都有候选与生产 envelope 计划；只有具备 canonical task contract、fixture set、重复次数和 evaluator 的 task 才允许 dispatch。
- 当前唯一可 dispatch suite 是 BrandProfile；其余 6 个 task fail-closed 为 `blocked_no_evaluation_suite`。媒体、无 task consumer、preview、deferred 与 legacy-only 候选继续由 candidate baseline 阻断。
- 任何未来真实 dispatch 还必须先提供机器品牌化的成本安全 attestation；本阶段没有读取 `.env`、创建/修改 new-api token 或调用真实 client。

## 协议执行边界

- admission contract：`site-builder-model-evaluation-protocol-admission/v1`；它独立于生产 `VERIFIED_GATEWAY_MODEL_TRANSPORTS`，不能改变 runtime provider/route。
- `openai-responses` 与 `anthropic-messages` 仅接受 candidate baseline 中 task pool 的精确 runnable alias+protocol；`openai-chat-completions` 只保留隔离的 legacy comparator 映射测试，且 alias 必须属于该 task 冻结的 legacy current/rollback route。raw target/legacy execute 都必须消费 harness 在预算 reserve 后签发的一次性 request authorization；本 PR 不提供 legacy comparator 的预算 orchestration，因此生产直调在任何 client 前 fail-closed，其他 task 的 legacy-only alias 也不能混入 comparator 或 target dispatch。
- actualProtocol 来自固定 adapter，不能由 caller 或 wire response 声称；missing/wrong reported model、requested fallback、协议错配均 fail-closed。
- trusted probe/run 只接受 `createModelEvaluationProtocolExecutor` 私有 WeakMap 品牌化并冻结的 target execute；同一 budget campaign 在首次 probe/run 时绑定一个不可伪造 executor identity，后续换 factory 即在 reserve/client 前拒绝。任意 callback、wrapper/Proxy 或 WeakMap prototype monkeypatch 均不能生成 identity；品牌模块不暴露 register 或测试注入入口。
- adapter 不建立生产 240s timeout：harness 独占 runtime deadline、diagnostic window 与 hard stop，且同一个 AbortSignal 原样传到底层 wire client。
- wire/settlement dependencies 在 branding 时固定：factory 一次性捕获并 bind 三个 wire 方法；替换 client 属性或在 repair 间换方法不能漂移 transport。cost settlement 只认显式注入、带 canonical resolverId 的 resolver；factory 冻结真实 resolver receiver，并捕获/bind validated resolverId 与 resolve 函数引用，既保留 class/private-state receiver 语义，也禁止创建后替换公开身份/方法。settled basis 以 `<basis>@<resolverId>` 绑定可审计 resolver/价格快照身份，缺该身份即 invalid/unknown。wire request 与 resolver context 共用 harness 生成的稳定 `executionId`，使 verified billing row 精确绑定 campaign/probe 或 fixture/attempt；resolver 只收到独立深冻结 usage/cost observation，不能改写返回 evidence。token 与聚合值必须是 safe integer。`provider_reported` 必须闭合全部 call cost observation；`frozen_pricing_snapshot` 必须有完整 usage 与 callCount，partial repair usage 不可结算；`verified_billing_export` 表示独立核验且覆盖该 executionId 整个 attempt 的账单依据，可不依赖 usage 完整性。没有上述依据即 `unknown`，绝不记 0。`provider_attested_not_incurred` 只允许首个 dispatch 失败、callCount=1 且唯一 provider cost observation 为 null；任何已有成功/成本观察后的 repair failure 都强制为 unknown。repair 失败时 resolver 仍收到既有 token 合计、完整 callCount 与 `complete=false`，不能把未知部分当 0；成功 repair 的 usage 与 callCount 必须完整合并。

| protocol | domain | admission | operations |
|---|---|---|---|
| `openai-responses` | text | `target_text_dispatch` | `structured_text` |
| `anthropic-messages` | text | `target_text_dispatch` | `structured_text` |
| `openai-chat-completions` | text | `legacy_comparator_only` | `structured_text_comparator` |
| `google-generate-content` | text | `blocked_deferred` | `structured_text` |
| `openai-images-generations` | image | `blocked_requires_media_gateway` | `generate` |
| `openai-images-edits` | image | `blocked_requires_media_gateway` | `edit`、`mask` |
| `openai-videos` | video | `blocked_no_consumer` | `create`、`query`、`cancel` |
| `openai-embeddings` | embedding | `blocked_no_evaluation_suite` | `embed` |

## Task 计划

| task | profile | dispatch | canonical suite | candidate / protocol / preflight | max tokens | runtime deadline | diagnostic window | hard stop | per-call cap | reasoning |
|---|---|---|---|---|---:|---:|---:|---:|---:|---|
| `site_builder.brand_profile` | `structured.workspace_materials` | `task_evaluation_ready` | `site-builder.brand-profile-evaluation-suite/2026-07-27-v1` | `gpt-5.6-terra` / `openai-responses` / `none`<br>`claude-sonnet-5` / `anthropic-messages` / `none`<br>`gpt-5.5` / `openai-responses` / `capability_probe` | 12000 | 240s | 240s | 480s | 40¢ | low |
| `site_builder.copy` | `copy.premium` | `blocked_no_evaluation_suite` | — | `claude-sonnet-5` / `anthropic-messages` / `none`<br>`gpt-5.5` / `openai-responses` / `capability_probe`<br>`gpt-5.6-terra` / `openai-responses` / `none` | 4000 | 120s | 120s | 240s | 20¢ | low |
| `site_builder.design_spec` | `structured.default` | `blocked_no_evaluation_suite` | — | `gpt-5.6-terra` / `openai-responses` / `none`<br>`gpt-5.5` / `openai-responses` / `capability_probe`<br>`claude-sonnet-5` / `anthropic-messages` / `none` | 4000 | 120s | 120s | 240s | 20¢ | — |
| `site_builder.assemble` | `structured.default` | `blocked_no_evaluation_suite` | — | `gpt-5.6-terra` / `openai-responses` / `none`<br>`gpt-5.5` / `openai-responses` / `capability_probe`<br>`claude-sonnet-5` / `anthropic-messages` / `none` | 16000 | 180s | 180s | 360s | 20¢ | — |
| `site_builder.assembly_fix` | `structured.default` | `blocked_no_evaluation_suite` | — | `gpt-5.6-terra` / `openai-responses` / `none`<br>`gpt-5.5` / `openai-responses` / `capability_probe`<br>`claude-sonnet-5` / `anthropic-messages` / `none` | 8000 | 180s | 180s | 360s | 20¢ | — |
| `site_builder.qa_summarize` | `text.summary` | `blocked_no_evaluation_suite` | — | `gpt-5.6-luna` / `openai-responses` / `none`<br>`gpt-5.4-mini` / `openai-responses` / `none`<br>`gpt-5.6-terra` / `openai-responses` / `none` | 3000 | 90s | 90s | 180s | 20¢ | — |
| `site_builder.seo_review` | `text.summary` | `blocked_no_evaluation_suite` | — | `gpt-5.6-luna` / `openai-responses` / `none`<br>`gpt-5.4-mini` / `openai-responses` / `none`<br>`gpt-5.6-terra` / `openai-responses` / `none` | 3000 | 90s | 90s | 180s | 20¢ | — |

## Canonical suite

- suite：`site-builder.brand-profile-evaluation-suite/2026-07-27-v1`
- adapter：`site-builder.brand-profile-evaluation-adapter/v2`
- task contract：`site_builder.brand_profile` / prompt `brand-profile/14` / route validation `brand-profile-route-validation/14`；dispatch 同时绑定冻结 output schema 与 `repairTaskOutput=true`
- fixture set：`site-builder.brand-profile-golden/2026-07-18-v1`；schema `brand-profile-eval-fixture/v1`；6 fixtures × 2 repeats = 12 runs/model
- fixtures：`auto-parts-rich`、`auto-parts-sparse`、`industrial-pump-rich`、`industrial-pump-sparse`、`lab-instrument-rich`、`lab-instrument-sparse`
- source bundle contract：`brand-profile-evaluation-source-bundle/v5`；固定 34 份仓库内源码/合同文件，路径条目深度冻结且禁止绝对/逃逸路径，同一比较组必须固定为一个 source bundle SHA-256，且每次调用完成后必须重新指纹
- dispatch payload：fixture、prepared task input、prompt 与 source fingerprints 全部由 canonical case builder 构造、冻结并纳入 case SHA-256；executor 不能替换为未绑定内容。
- capability probe：machine baseline 的 closed `preflight=capability_probe` 是唯一 admission 真值，不解析 `gate` prose。该候选只能由 harness-owned campaign 发起 canonical task-shaped probe；probe 与矩阵共享预算，绑定 harness/baseline/task/candidate/protocol/source scope，只有协议、requested/reported/resolved identity、完整输出、schema/生产 PII gate、usage、成本结算和调用后 source re-fingerprint 全部闭合才生成 attestation。同一 campaign/candidate 的重复请求复用既有 canonical attestation，不重复 dispatch、reserve 或擦除有效证明。run/summary/ranker 只信模块私有 WeakSet/WeakMap、私有 campaign 状态与捕获的原型读取器，裸 observation、duck-typed object、不同预算 campaign 或公开字段 self-hash 均不能解锁。本 PR 仅保证同进程内存信任；后续持久 evidence 必须另建 create-only/signed trust anchor，不能复用 self-hash 冒充验真。
- evaluator：`brand-profile-evaluator/10`；rubric SHA-256 `c94e11eff737b0ac9459bde0fe14ad848e35bb0b288c24ff0ac756e2620e1e3c`；harness 内部依次执行 output schema、生产 `validateOutput` 与 canonical task rubric，不接受 caller 自带 grader。

## 闭合结果与排序

- 结果类：`quality_valid_runtime_on_time`、`quality_valid_runtime_late`、`content_invalid`、`protocol_or_identity_invalid`、`provenance_invalid`、`capability_unavailable`、`diagnostic_window_exhausted`、`budget_stop`。
- 单次 runtime deadline 只把结果标记为 late 并保留质量观察；候选 accepted-artifact P95 超过生产 deadline 时不得 rankable/晋级。hard stop 才中止，使用 monotonic clock 记录实际耗时，异常时钟 fail-closed，且 hard-stop 后观测到的完成不能回写成质量有效。
- 先按 quality → structure → factuality → fixture 内 stability；任一 `content_invalid` 都是 hard failure，完整矩阵必须每次通过结构、质量与事实门才可 rankable。通过生产 P95 硬门后，再按 accepted-artifact P95 latency → canonical capability probe 与矩阵全部已结算尝试成本/accepted artifact 排序。
- matrix 必须精确等于 suite 的 fixtureIds × repeats；缺失、意外或重复 key 均不可排名；超出 repeats 的尝试在 dispatch 前拒绝；ranker 只接受 plan + raw runs 并在内部重新生成 summary。

## 预算与 provenance

- 成本安全合同 `site-builder-model-evaluation-cost-safety/2026-07-28-v1` 在 executor branding 时强制绑定：独立 spend authorization 的批准金额/execution 数必须与 campaign limits 精确一致且 authorizationId 在同一进程只能被一个 executor factory 认领；凭据 purpose 必须是 `site_builder_model_evaluation`、quota 必须 limited，wire client 必须先由同一模块私有 WeakMap 品牌化且其不可变 credential attestation/snapshot identity 必须相符，target 与 canonical legacy comparator 的完整 alias+protocol scope、冻结价格表必须精确覆盖且禁止默认/未配置倍率；resolverId 必须匹配价格快照，resolver 以 frozen pricing 结算的金额必须与 attested unit price 和完整 usage 重新计算结果一致。仓库绝对止损为 credential 25000¢、campaign 10000¢、500 executions、1000 wire calls、单次 prompt 1048576 bytes 与 output 100000 tokens；具体 campaign 只能更低。
- attestation branding 只证明同进程输入满足机器合同，不冒充 new-api 管理面真值。后续真实 evidence runner 必须从固定提交读取并保存脱敏凭据管理快照及其 SHA-256、价格快照和 resolver 实现，先核验真实 token quota/scope 再构造 attestation；本 PR 不提供绕过该步骤的默认值、环境变量读取或 live introspection。
- harness 在任何 budget reserve/client dispatch 前重新核对 target + canonical legacy comparator 完整 scope 与 canonical plan，并确认完整矩阵所需的 execution/wire-call headroom；executor 在每个请求和每次实际 wire call 前重新核对 alias、协议、实际 prompt bytes、output 上限与冻结价格的最坏费用，repair 扩展 prompt 不能沿用首调字节数，并保守占用 repair 最坏调用数。executor 的 authorization 级 execution/wire/费用账本不因换一个 budget guard 而重置；`executionId` 是唯一 request billing identity。缺 request 级可核验结算、冻结价格金额漂移或出现 unknown 时继续沿用 `freeze_campaign`，不得记零或继续下一调用。媒体 generic channel test 固定 forbidden。
- 每次 task/probe 在任何 wire dispatch 前，按 `repairTaskOutput` 的最坏调用数（当前最多 2 次）一次性 reserve campaign 全部上界，因此 repair 不能在只预留首调预算时超发；结算释放未用 headroom，但不会把既有 envelope attempt cap 乘以实际 callCount，repair 聚合成本超过原 `perCallCostCapCents` 仍是预算硬失败且不可排名。budget guard 使用模块私有 WeakMap 品牌、JavaScript 私有状态与捕获的 reserve/settle 原型方法，duck/Proxy budget 或实例/prototype monkeypatch 都不能绕过。每个返回 run 先整棵 deep-freeze，再由模块私有 WeakMap 绑定实际 guard；summary/ranker 必须显式收到同一个 genuine guard，并逐 run 核验对象身份与 campaignId，因此逐次新建 genuine guard、混用 guard、原地改写已绑定 run、clone/JSON reload 或只改公开 campaignId 都 fail-closed。unknown 或 malformed settlement 保留完整最坏上界并冻结后续 dispatch。`rejected_before_dispatch` 只允许本地 reserve 拒绝路径，probe/matrix 在 executor 进入后声称该 reason 一律归 unknown 并冻结；当前 attempt 超过原 cap 时保留质量观察，但标记预算硬失败并不可排名。
- 每个 run（schema v3）固定保存 campaignId、expected/actual protocol、requested/reported/resolved model、resolution source、usage source/call count、cost basis，以及 task contract、fixture、prompt、source bundle contract/source bundle、evaluator rubric、成本安全合同/attestation/凭据快照/价格快照 SHA-256 和所需 capability-probe attestation；probe attestation v2 绑定同一组成本安全摘要，矩阵内漂移即拒绝。终态原始 artifact 只有先通过 output schema 与生产 PII/route gate 才可保留；终态被拒输出只留 SHA-256 digest 与 failureCode，不把 PII/schema-invalid 原文写入 evidence。v2 adapter 对 repair 中间输出只聚合 usage/callCount，不保存其中间 digest 或 rejection reason，也不得把它称为已持久化 evidence；后续 fixed-commit evidence 若要求中间 repair provenance，必须先在独立 PR 显式升级 run schema/source contract。汇总时重新执行 canonical evaluator，不信任记录中的通过标志。
- 可用性、协议、身份、probe attestation、usage、artifact fingerprint、matrix、生产 P95、预算和成本任一未闭合，都不能生成可晋级排名。
