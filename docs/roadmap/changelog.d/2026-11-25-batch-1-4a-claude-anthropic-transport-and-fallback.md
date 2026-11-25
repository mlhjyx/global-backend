---
date: 2026-11-25
pr: 1097
title: Bind Claude 5.5 and Fable models to native Anthropic Messages transport with D13-safe cross-channel fallback
---

- 起因：生产中转 `4router.ai` 的 `ClaudeApiMix` 分组在 `/v1/chat/completions` 上拒绝 `system` 角色导致 `claude-sonnet-5-5` 报 HTTP 400，而在原生 Anthropic `/v1/messages` + `tools` 契约下实测 HTTP 200；同时单一上游线路波动时缺少不违背 D13 计费安全边界的跨通道自动降级能力。
- 改动：
  - `apps/api/src/model-gateway/model-transports.ts`：在 `VERIFIED_GATEWAY_MODEL_TRANSPORTS` 中将 `claude-sonnet-5-5`、`claude-sonnet-4-6`、`claude-fable-5`、`claude-fable-5-1` 显式绑定为 `'anthropic-messages'`，并扩展 `model-providers.config.spec.ts` 覆盖上述模型。
  - `apps/api/src/model-gateway/model-fallback.ts` 与 `apps/api/src/model-runtime/structured-task-runtime-bridge.ts`：新增跨通道降级解析与 D13 安全重试（不改动受保护的 `router-model-gateway.ts` 围栏）。仅在显式开启 `MODEL_CROSS_CHANNEL_FALLBACK_ENABLED=on`、非 `paidCost`、非 `platformEgress` 且命中 D13 确定未计费上游失败（`definiteModelFailureCode(err) !== undefined`，排除 504/524 超时）时，以独立 `correlationId` 切换跨通道备选模型；`discovery.qualify_fit` 终判任务严格遵守 `JUDGE_MODEL_ALLOWLIST`。
- 测试：`node scripts/governance-verify.mjs verify`、`node scripts/governance-workflow-constants.mjs verify`、`node scripts/governance-module-boundaries.mjs verify`、`verifyExecutionAuthorityPolicy`、`pnpm docs:verify`、`vitest run src/model-gateway/ src/model-runtime/`、`pnpm --filter @global/api build`、`pnpm --filter @global/api lint` 全部通过。
- 未做：宿主机 `backend-runtime.env` 开启 `MODEL_CROSS_CHANNEL_FALLBACK_ENABLED=on` 及 `Batch 1.4-B` 找客/决策委员会/D3/作战 CSV 主链路接线留待后续 PR 与发版切换。
