# Site Builder 模型候选重基线

> 文档 ID：`SITE-MODEL-CANDIDATES-001`
> 生命周期：`CURRENT`
> 当前事实来源：`apps/api/src/site-builder/agents/model-candidate-baseline.json`。
> 机器基线：`site-builder-model-candidate-baseline/2026-08-04-v2`；本文件由机器基线生成并由 `pnpm docs:verify` 校验。

<!-- BEGIN GENERATED MODEL CANDIDATE BASELINE -->

## 边界

本基线 `site-builder-model-candidate-baseline/2026-08-04-v2` 只登记非运行时候选与后续评测顺序。它本身不路由候选、晋级模型、改变 rollback、环境变量、Temporal、P4、DesignEvaluation、ReleaseManifest、MediaGateway 或公共 API，也不证明模型质量、生产可用性或部署状态。

型号可见、渠道启用或一次最小连通，只能支持进入后续 capability probe；不能跳过逐任务评测、失败门、成本结算、rollback 和用户批准。当前 BrandProfile 的 Terra→Sonnet promotion 及其 DeepSeek→GLM rollback 保持不变；未晋级任务的 active policy 与此候选基线分离，其中 design_spec 已使用确定性安全蓝图，其他任务仍须独立评测后才能路由候选。

## 状态词表

| 状态 | 含义 |
|---|---|
| `runnable` | Admitted to a future capability probe or task-shaped evaluation; not promoted and not production-qualified. |
| `deferred` | Recorded but excluded from the runnable evaluation pool until the stated upstream, consumer, or capability gate is satisfied. |
| `preview` | Preview alias recorded for shadow-only evaluation; it cannot be the sole production dependency. |
| `legacy-only` | Retained only by an unchanged currentRoute or rollback snapshot; excluded from every new target pool. |

## 型号目录

| 精确 alias | 分域 | 状态 | 预期协议 | 边界 |
|---|---|---|---|---|
| `gpt-5.6-terra` | `text` | `runnable` | `openai-responses` | Existing BrandProfile promotion remains unchanged; other tasks require their own evaluation. |
| `claude-sonnet-5` | `text` | `runnable` | `anthropic-messages` | Existing BrandProfile fallback remains unchanged; other tasks require their own evaluation. |
| `gpt-5.5` | `text` | `runnable` | `openai-responses` | Gateway visibility and minimal channel health do not prove structured or task-shaped capability. |
| `gpt-5.6-sol` | `text` | `runnable` | `openai-responses` | High-reasoning Copy and multimodal-review candidate; each task still requires independent evaluation and promotion. |
| `gpt-5.6-luna` | `text` | `runnable` | `openai-responses` | Summary and bulk evaluation candidate only. |
| `gpt-5.4-mini` | `text` | `runnable` | `openai-responses` | Bulk evaluation candidate only. |
| `gpt-5.4` | `text` | `runnable` | `openai-responses` | Bulk evaluation candidate only. |
| `gemini-3.5-flash` | `text` | `deferred` | `google-generate-content` | Upstream channel is disabled until a supported inference path is activated and re-probed. |
| `gpt-image-2` | `image` | `runnable` | `openai-images-generations`<br>`openai-images-edits` | Generation may enter a future probe; edits and mask semantics require a separate capability probe. |
| `gpt-image-2-4k` | `image` | `runnable` | `openai-images-generations` | Premium-image evaluation candidate only; no MediaGateway or runtime consumer exists. |
| `gemini-3.1-flash-image-preview` | `image` | `preview` | `openai-images-generations` | Shadow-only preview candidate; task-shaped image protocol remains unverified. |
| `gemini-3-pro-image-preview` | `image` | `preview` | `openai-images-generations` | Shadow-only preview candidate; task-shaped image protocol remains unverified. |
| `seedance-2-5s` | `video` | `deferred` | `openai-videos` | No current consumer or task-shaped create/query/cancel probe. |
| `seedance-2-10s` | `video` | `deferred` | `openai-videos` | No current consumer or task-shaped create/query/cancel probe. |
| `seedance-2-15s` | `video` | `deferred` | `openai-videos` | No current consumer or task-shaped create/query/cancel probe. |
| `grok-video-1.0` | `video` | `deferred` | `openai-videos` | No current consumer or task-shaped create/query/cancel probe. |
| `grok-video-1.5` | `video` | `deferred` | `openai-videos` | No current consumer or task-shaped create/query/cancel probe. |
| `site-builder-bge-m3-local` | `embedding` | `runnable` | `openai-embeddings` | Unchanged private BGE-M3 route; not part of a model replacement pool. |
| `deepseek-v4-pro` | `text` | `legacy-only` | `openai-chat-completions` | Unchanged currentRoute or rollback only. |
| `deepseek-v4-flash` | `text` | `legacy-only` | `openai-chat-completions` | Unchanged currentRoute only. |
| `glm-5.2` | `text` | `legacy-only` | `openai-chat-completions` | Unchanged currentRoute or rollback only. |
| `minimax-m3` | `text` | `legacy-only` | `openai-chat-completions` | Historical provenance only; pending retirement and forbidden from runtime, comparator, rollback, and new target pools. |
| `doubao-seed-2.0-pro` | `text` | `legacy-only` | `openai-chat-completions` | Historical provenance only; pending retirement and forbidden from runtime, comparator, rollback, and new target pools. |
| `doubao-seed-2.0-lite` | `text` | `legacy-only` | `openai-chat-completions` | Historical provenance only; pending retirement and forbidden from runtime, comparator, rollback, and new target pools. |

## Profile 候选池

候选是相互独立的评测对象，不是 primary/fallback 运行链。排序只是首轮评测顺序。

| ModelProfile | activation | 候选（状态 · 预期协议 · preflight） | 进入下一门的前提 |
|---|---|---|---|
| `structured.workspace_materials` | `requires_task_evaluation` | `gpt-5.6-terra` (`runnable` · `openai-responses` · `none`)<br>`claude-sonnet-5` (`runnable` · `anthropic-messages` · `none`)<br>`gpt-5.5` (`runnable` · `openai-responses` · `capability_probe`) | task-shaped structure, evidence, factuality, stability, latency, and cost<br>task-shaped structure, evidence, factuality, stability, latency, and cost<br>capability probe before the task-shaped matrix |
| `structured.default` | `requires_task_evaluation` | `gpt-5.6-terra` (`runnable` · `openai-responses` · `none`)<br>`gpt-5.5` (`runnable` · `openai-responses` · `capability_probe`)<br>`claude-sonnet-5` (`runnable` · `anthropic-messages` · `none`) | per-task structured-output and closed-catalog evaluation<br>capability probe before the per-task matrix<br>per-task structured-output and closed-catalog evaluation |
| `structured.assembly` | `requires_task_evaluation` | `gpt-5.6-terra` (`runnable` · `openai-responses` · `none`)<br>`claude-sonnet-5` (`runnable` · `anthropic-messages` · `none`) | closed assembly selection and repair evaluation within the native per-wire cost cap<br>closed assembly selection and repair evaluation within the native per-wire cost cap |
| `reasoning.high` | `requires_task_evaluation` | `gpt-5.6-sol` (`runnable` · `openai-responses` · `none`)<br>`gpt-5.5` (`runnable` · `openai-responses` · `capability_probe`)<br>`claude-sonnet-5` (`runnable` · `anthropic-messages` · `none`) | complex-repair task envelope and deterministic safety fallback<br>complex-repair capability probe before evaluation<br>complex-repair task envelope and deterministic safety fallback |
| `copy.premium` | `requires_task_evaluation` | `gpt-5.6-terra` (`runnable` · `openai-responses` · `capability_probe`)<br>`gpt-5.6-sol` (`runnable` · `openai-responses` · `capability_probe`)<br>`claude-sonnet-5` (`runnable` · `anthropic-messages` · `capability_probe`) | capability pilot before claim-bound multilingual copy evaluation<br>capability pilot before claim-bound multilingual copy evaluation<br>capability pilot before claim-bound multilingual copy evaluation |
| `text.summary` | `requires_task_evaluation` | `gpt-5.6-luna` (`runnable` · `openai-responses` · `none`)<br>`claude-sonnet-5` (`runnable` · `anthropic-messages` · `none`)<br>`gpt-5.6-terra` (`runnable` · `openai-responses` · `none`) | task-shaped summary validity and omission evaluation<br>task-shaped summary validity and omission evaluation<br>task-shaped summary validity and omission evaluation |
| `text.bulk` | `requires_task_evaluation` | `gpt-5.4-mini` (`runnable` · `openai-responses` · `none`)<br>`gpt-5.6-luna` (`runnable` · `openai-responses` · `none`)<br>`gpt-5.4` (`runnable` · `openai-responses` · `none`) | bounded batch quality, stability, and absolute spend stop<br>bounded batch quality, stability, and absolute spend stop<br>bounded batch quality, stability, and absolute spend stop |
| `multimodal.review` | `requires_task_evaluation` | `gpt-5.6-sol` (`runnable` · `openai-responses` · `none`)<br>`claude-sonnet-5` (`runnable` · `anthropic-messages` · `none`)<br>`gpt-5.6-terra` (`runnable` · `openai-responses` · `none`) | vision-input, closed-output, provenance, and task-shaped review evaluation<br>vision-input, closed-output, provenance, and task-shaped review evaluation<br>vision-input, closed-output, provenance, and task-shaped review evaluation |
| `image.bulk.creative` | `requires_media_gateway` | `gemini-3.1-flash-image-preview` (`preview` · `openai-images-generations` · `none`)<br>`gpt-image-2` (`runnable` · `openai-images-generations` · `none`) | shadow-only preview plus task-shaped generation and rights evaluation<br>MediaGateway, task-shaped generation, rights, identity, and cost evaluation |
| `image.premium.design` | `requires_media_gateway` | `gpt-image-2-4k` (`runnable` · `openai-images-generations` · `none`)<br>`gemini-3-pro-image-preview` (`preview` · `openai-images-generations` · `none`) | MediaGateway plus premium composition, text, identity, rights, and cost evaluation<br>shadow-only preview plus premium task-shaped evaluation |
| `image.precise_edit` | `requires_media_gateway` | `gpt-image-2` (`runnable` · `openai-images-edits` · `none`) | edits endpoint, mask semantics, subject preservation, and original-Sharp fallback probe |
| `video.primary` | `requires_media_gateway` | `seedance-2-5s` (`deferred` · `openai-videos` · `none`)<br>`seedance-2-10s` (`deferred` · `openai-videos` · `none`)<br>`seedance-2-15s` (`deferred` · `openai-videos` · `none`)<br>`grok-video-1.0` (`deferred` · `openai-videos` · `none`)<br>`grok-video-1.5` (`deferred` · `openai-videos` · `none`) | consumer, MediaGateway, create/query/cancel, identity, rights, timeout, and settlement probes<br>consumer, MediaGateway, create/query/cancel, identity, rights, timeout, and settlement probes<br>consumer, MediaGateway, create/query/cancel, identity, rights, timeout, and settlement probes<br>consumer, MediaGateway, create/query/cancel, identity, rights, timeout, and settlement probes<br>consumer, MediaGateway, create/query/cancel, identity, rights, timeout, and settlement probes |

## Task 与 Profile 评测映射

同一 Profile 的候选池可以复用 harness，但 promotion 仍逐 task 独立。

| taskId | ModelProfile |
|---|---|
| `site_builder.brand_profile` | `structured.workspace_materials` |
| `site_builder.copy` | `copy.premium` |
| `site_builder.design_spec` | `structured.default` |
| `site_builder.assemble` | `structured.assembly` |
| `site_builder.assembly_fix` | `structured.assembly` |
| `site_builder.qa_summarize` | `text.summary` |
| `site_builder.seo_review` | `text.summary` |

## 评测判定顺序

先按 `quality` → `structure` → `factuality` → `stability` → `p95_latency` → `accepted_artifact_cost` 判定。真实评测使用每个 task 的生产 envelope，并在超出运行时限后进入扩展诊断观察窗；`quality_valid_runtime_late` 与 `content_invalid` 必须分开记录。绝对止损为 `pre_dispatch_campaign_budget_plus_per_call_cap`，未知结算不写成零。

## 后续 PR 顺序

| 顺序 | PR | 只允许产出 |
|---|---|---|
| 2 | `capability-and-task-evaluation-harness` | Protocol, capability, task-envelope, diagnostic-window, and closed-result harness only. |
| 3 | `fixed-commit-real-evidence` | Create-only evidence from a fixed commit with complete provenance and conservative cost settlement. |
| 4 | `per-task-promotion` | One task at a time, with explicit owner approval, failure gates, rollback, and no automatic merge. |

每个 PR 独立审查、跑相关测试与完整 CI 等比例门、创建 ready PR 后等待用户合并授权。候选基线、真实证据与运行时 promotion 不得合并成 mega switch。

<!-- END GENERATED MODEL CANDIDATE BASELINE -->
