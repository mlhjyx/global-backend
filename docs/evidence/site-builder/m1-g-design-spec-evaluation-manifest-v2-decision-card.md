# M1-g `design_spec` v2 zero-cost manifest decision card

> Status: `READY_FOR_TECHNICAL_REVIEW`; dispatch: `NOT_AUTHORIZED`; actual network calls: `0`; actual model cost: `$0.00`.

## Fixed source and immutable output

- Fixed source commit: `origin/main@295038d323b4bd09ed16ab73ea981d24e1f010df` (the merge commit for #266).
- Preparation contract: `site-builder-design-spec-evaluation-manifest-prep/2026-08-03-v2`.
- Harness: `site-builder-model-evaluation-harness/2026-08-01-v18`.
- Canonical suite: `site-builder.design-spec-evaluation-suite/2026-08-03-v15`.
- [Create-only machine manifest](m1-g-design-spec-evaluation-manifest-v2.json): file SHA-256 `bbd310d3179c48f8b1c13e1192d2459016549e6bc3239184809cf837f164d0bb`; semantic manifest SHA-256 `aeb50d9f6cfb631b3a4fc20d94a0f42e11f4478fe02c181c408d589fe9280164`.
- Source bundle: 47 tracked files; contract `design-spec-evaluation-source-bundle/v15`; SHA-256 `9419952c08330c7dc4eafc2bf2d54c8804a9f3ca36fc5ba9d85d0458118d654f`.
- Compiled contracts: 31 tracked source files / 21 loaded JavaScript artifacts; artifact-tree SHA-256 `d65642cc5f9b20001b4a167ec4acbd5cb9a1dac1d5e335b02da0208ffdc9cc01`.

The runner required the fixed source to be reachable from both the clean prep HEAD and `origin/main`, rebuilt the ignored contracts runtime locally, compared every source-bundle file with its fixed Git blob, and wrote the JSON with create-only semantics. A later evidence runner must recheck source reachability before any budget reservation or client creation.

## Frozen zero-cost matrix

- Six approved Families x sparse/rich = 12 synthetic fixtures.
- Three runnable candidates: `gpt-5.6-terra / openai-responses`, `gpt-5.5 / openai-responses`, and `claude-sonnet-5 / anthropic-messages`.
- 72 target executions plus one task-shaped GPT-5.5 capability probe = 73 executions.
- Each execution permits at most one closed schema repair and two physical wire calls, so the manifest ceiling is 146 wire calls.
- Deterministic comparator: 24 `deterministic-catalog-selection/v1` cases, all frozen `PASS`, with zero model calls and zero cost.
- `legacyComparatorAliases=[]`; MiniMax and Doubao are excluded. Gemini text remains deferred.

The existing per-wire 20¢ hard stop yields a purely mechanical ceiling of 2,920¢ (`$29.20`). It is not an expected cost, credential quota, approved budget, or permission to dispatch.

## What this PR cannot do

- It contains no model or network client and does not read `.env`.
- It contains no token, credential snapshot, balance sample, OpenOx price snapshot, response body, customer data, or personal data.
- It does not modify new-api, active routes, rollback routes, consumers, public API, database, P4, Temporal, ReleaseManifest, production deployment, MODEL-2, or M2-PUBLISH.
- The manifest fixes `dispatchAuthorization=NOT_AUTHORIZED`, `actualNetworkCalls=0`, and `actualModelCostCents=0`.

## Next independent gate

After this PR is reviewed and separately authorized for merge, a new evidence-preflight PR may prepare an exact native-currency fee decision card. That card must use frozen public prices from [OpenOx](https://openox.tech/models), a purpose-specific limited credential with exact alias/protocol scope, a balance timestamp, expected spend, absolute CNY and USD caps, and settlement stop conditions.

No real model request may occur until the product owner sees that fee card and explicitly authorizes its exact amount. Evidence execution, evidence review, and `design_spec` promotion remain separate decisions and separate PRs.
