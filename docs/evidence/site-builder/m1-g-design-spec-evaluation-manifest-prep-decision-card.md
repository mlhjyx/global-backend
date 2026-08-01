# M1-g `design_spec` zero-cost manifest decision card

> Status: `READY_FOR_TECHNICAL_REVIEW`; dispatch: `NOT_AUTHORIZED`; actual network calls: `0`; actual model cost: `$0.00`.

## Fixed source and immutable output

- Fixed source commit: `origin/main@e493ba1d09fe37feea927f70d12f17aadadc5c6a` (`#251` squash commit).
- Preparation contract: `site-builder-design-spec-evaluation-manifest-prep/2026-08-01-v1`.
- Harness: `site-builder-model-evaluation-harness/2026-08-01-v18`.
- Canonical suite: `site-builder.design-spec-evaluation-suite/2026-08-01-v14`.
- [Create-only machine manifest](m1-g-design-spec-evaluation-manifest-v1.json): file SHA-256 `15813905892f19db58fd600a11f938a31493fea7d7bf8922e5ecbed37a88003d`; semantic manifest SHA-256 `83dedcb2057d4e375114c42b5c03becbc9b057b1bfa1f3fc511bfec600827e72`.
- Source bundle: 47 tracked files; contract `design-spec-evaluation-source-bundle/v14`; SHA-256 `3e95d15837d7ad6ea234a67211b3a7564f92e9c3826911024b767de222df9528`.
- Compiled contracts: 31 tracked source files / 21 loaded JavaScript artifacts; artifact-tree SHA-256 `d65642cc5f9b20001b4a167ec4acbd5cb9a1dac1d5e335b02da0208ffdc9cc01`.

The fixed source commit was already reachable from `origin/main` before this manifest was created and remains an ancestor of the preparation head. The manifest PR may therefore be squash-merged without losing source reachability; a later evidence runner must recheck that reachability before any budget reservation or client creation.

## Frozen zero-cost matrix

- Six approved Families × sparse/rich = 12 synthetic fixtures.
- Three runnable candidates: `gpt-5.6-terra / openai-responses`, `gpt-5.5 / openai-responses`, and `claude-sonnet-5 / anthropic-messages`.
- 72 target executions plus one task-shaped GPT-5.5 capability probe = 73 executions.
- Each execution permits at most one closed schema repair and two physical wire calls, so the manifest ceiling is 146 wire calls.
- Deterministic comparator: 24 `deterministic-catalog-selection/v1` cases, all frozen `PASS`, with zero model calls and zero cost.
- `legacyComparatorAliases=[]`; MiniMax and Doubao are excluded. Gemini text remains deferred.

The existing per-wire 20¢ hard stop yields a purely mechanical ceiling of 2,920¢ (`$29.20`). It is not an expected cost, credential quota, approved budget, or permission to dispatch.

## What this PR cannot do

- It contains no model/network client and does not read `.env`.
- It contains no token, credential snapshot, balance sample, OpenOx price snapshot, response body, customer data, or personal data.
- It does not modify new-api, active routes, rollback routes, consumers, public API, database, P4, Temporal, ReleaseManifest, production deployment, MODEL-2, or M2-PUBLISH.
- The manifest fixes `dispatchAuthorization=NOT_AUTHORIZED`, `actualNetworkCalls=0`, and `actualModelCostCents=0`.

## Next independent gate

After this PR is reviewed and separately authorized for merge, a new evidence-preflight PR may read the frozen manifest and prepare an exact fee decision card. That card must use frozen public prices from [OpenOx](https://openox.tech/models), a purpose-specific limited credential with exact alias/protocol scope, a balance timestamp, expected spend, an absolute cap, and settlement stop conditions.

No real model request may occur until the product owner sees that fee card and explicitly authorizes its exact amount. Evidence execution, evidence review, and `design_spec` promotion remain separate decisions and separate PRs.
