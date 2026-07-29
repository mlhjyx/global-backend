# M1-g current-route recovery decision card

Date: 2026-07-29
Route baseline: `e727bb141ad2c8c5fdd4379308ed85cfc7aefb86`
Status: `BLOCKED_CURRENT_ROUTE_RECOVERY`
Model dispatch authorization: `NOT_AUTHORIZED`

> **Superseded action guidance (2026-07-29):** 本卡保留当时只读快照与
> 价格 provenance，但“恢复 MiniMax/Doubao 渠道、补其价格、纳入八型号
> runtime token”的行动项已被
> [text-route retirement governance card](m1-g-text-route-retirement-decision-card.md)
> 取代，不得继续执行。

This zero-model preparation derives all 15 primary/fallback dispatches for the
seven Site Builder tasks from the frozen registry. It does not read an
environment route override, create or install a runtime attestation, change a
channel, replace an alias, or call a model.

Model-generation calls made: **0**

Model fees incurred: **$0.00**

## Frozen read-only evidence

- The local new-api SQLite database was opened read-only and only non-secret
  channel fields were retained.
- The existing application credential returned HTTP 200, but it is unlimited,
  has model limits disabled, and has no exact allowlist. It is therefore not an
  admissible M1-g runtime credential.
- The application Node runtime fetched the official OpenOx public catalog with
  HTTP 200. The response contained 37 model rows and 15 price groups. The
  restricted public source bundle is byte-bound at SHA-256
  `6e3eceb33f69a6011eeb185cea378a13f2af5a1893adfb67f4d4dc5e0a2d451e`;
  its fixed source commit is
  `e91b184741a10b83459a8041e3ecd9701fdf3b5b`;
  the runner recomputes selected group/model multipliers through the runtime
  settlement price resolver instead of accepting effective prices from the
  safe snapshot.
- The safe input and deterministic output are
  `m1-g-current-route-recovery-safe-snapshot.json` and
  `m1-g-current-route-recovery-report.json`; canonical safe-snapshot SHA-256:
  `f26d146cad4b16d74287949cd9aeef34a4e9ee5b736012b57b5240de8e32e160`.
- The route baseline is fixed to
  `e727bb141ad2c8c5fdd4379308ed85cfc7aefb86`; the canonical 15-dispatch
  digest is
  `f0cb1473cb025621a3f9e6df7dec6045bb7e5df2a3586c6d3e93716913733184`.
  The CLI rejects route-source drift from that commit.

The snapshot contains no gateway key, bearer token, authorization header,
base URL, prompt, model response, customer data, or reversible credential
material.
Input, source-bundle and create-only output paths are resolved against the real
repository root; any intermediate symbolic-link traversal is rejected.

## Exact matrix result

| Alias                  | Protocol  | Enabled channel selection | OpenOx pricing | Result                               |
| ---------------------- | --------- | ------------------------- | -------------- | ------------------------------------ |
| `gpt-5.6-terra`        | Responses | unique: 17                | published      | credential blocked                   |
| `claude-sonnet-5`      | Messages  | ambiguous: 8, 19          | published      | channel + credential blocked         |
| `deepseek-v4-pro`      | Chat      | unique: 1                 | published      | credential blocked                   |
| `glm-5.2`              | Chat      | unique: 11                | published      | credential blocked                   |
| `minimax-m3`           | Chat      | none; disabled: 3         | absent         | channel + price + credential blocked |
| `deepseek-v4-flash`    | Chat      | unique: 1                 | absent         | price + credential blocked           |
| `doubao-seed-2.0-pro`  | Chat      | none; disabled: 3         | absent         | channel + price + credential blocked |
| `doubao-seed-2.0-lite` | Chat      | none; disabled: 3         | absent         | channel + price + credential blocked |

An enabled configuration is not a health claim. The previous bounded M1-g
evidence remains the runtime truth for 401/403/502/503 failures; this PR does
not use a paid generic channel test to overwrite it.

## OpenOx price basis

These are upstream OpenOx prices, not new-api defaults. Units are native
currency per one million tokens after the selected public group/model
multiplier.

| Alias             | Group                      | Currency | Input | Output | Cache read | Cache write |
| ----------------- | -------------------------- | -------- | ----: | -----: | ---------: | ----------: |
| `gpt-5.6-terra`   | `gpt-unified`              | CNY      |  2.50 |  15.00 |       0.25 |       3.125 |
| `claude-sonnet-5` | `special` 1.26x            | USD      |  2.52 |  12.60 |      0.252 |        3.15 |
| `deepseek-v4-pro` | `deepseek`                 | CNY      | 1.827 |  3.654 |   0.015225 |           0 |
| `glm-5.2`         | `glm`, model billing 0.70x | CNY      |  5.60 |  19.60 |       1.40 |           0 |

`minimax-m3`, `deepseek-v4-flash`, `doubao-seed-2.0-pro`, and
`doubao-seed-2.0-lite` have no row in the captured OpenOx catalog. Their exact
cost, the complete M1-g estimate, and a defensible absolute ceiling therefore
cannot be calculated. The old `$24.40` value belongs to a separate
BrandProfile evaluation planning bound and is not an M1-g budget.

## Required next decisions

1. 对 `deepseek-v4-flash` 仍可要求精确 OpenOx 价格或通过逐任务 promotion
   移出 active route；不得为 pending-retirement alias 请求价格。
2. 不恢复 MiniMax/Doubao 渠道；通过逐任务 fixed-commit
   evidence/promotion 将其移出 active route。Sonnet 仍须固定唯一已审查渠道。
3. 只在逐任务 promotion 完成后创建有限额度 runtime token，其 allowlist
   必须是最终 active alias 精确并集，不含 pending-retirement alias。
4. Generate a short-lived digest-bound runtime attestation and present the
   exact M1-g estimate, credential cap, and absolute BuildRun ceiling.
5. Obtain separate user authorization before installing that attestation or
   rerunning the paid M1-g verifier.

Until all five gates are complete, M1-g remains incomplete and M2-PUBLISH,
model promotion, images, video, and production routing remain blocked.
