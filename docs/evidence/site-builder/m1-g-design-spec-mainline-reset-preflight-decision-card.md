# M1-g `design_spec` mainline reset preflight decision card

> Status: `BLOCKED_FRESH_PRICE_CREDENTIAL_AND_USER_COST_AUTHORIZATION`; dispatch: `NOT_AUTHORIZED`; this preparation made no network or model calls.

## Binding and purpose

- Preparation head: `origin/main@4c3defd4cf03bd727bb024a4f1aded0f62589a9b`.
- Canonical fixed source: `e493ba1d09fe37feea927f70d12f17aadadc5c6a`, already reachable from `origin/main`.
- Only admissible machine input: [the merged create-only manifest](m1-g-design-spec-evaluation-manifest-v1.json), SHA-256 `15813905892f19db58fd600a11f938a31493fea7d7bf8922e5ecbed37a88003d`.
- Canonical suite: `site-builder.design-spec-evaluation-suite/2026-08-01-v14`; source bundle: `design-spec-evaluation-source-bundle/v14` / `3e95d15837d7ad6ea234a67211b3a7564f92e9c3826911024b767de222df9528`.

This card resets the decision boundary to merged mainline provenance. It is not a
cost authorization, credential attestation, evidence run, ranking, promotion,
or runtime-route decision.

## Exact scope retained

- 12 synthetic sparse/rich fixtures, two repeats, and the three exact target
  alias/protocol pairs: `gpt-5.6-terra / openai-responses`, `gpt-5.5 /
  openai-responses`, and `claude-sonnet-5 / anthropic-messages`.
- One GPT-5.5 capability probe plus 72 target executions: 73 executions and at
  most 146 physical wire calls, with no more than one closed repair per
  execution.
- 24 deterministic catalog comparator cases remain zero-call and zero-cost.
- `legacyComparatorAliases=[]`; MiniMax and Doubao remain excluded, Gemini text
  remains deferred, and image/video/embedding plus the other five text tasks
  stay out of scope.

## Explicit historical exclusion

No branch-only runner, stopped-run output, probe result, matrix result,
authorization, ledger, credential observation, price snapshot, settlement
record, or ranking from #254 or #256 is an input to a future canonical
campaign. In particular, a stopped or later reconciled settlement cannot make a
frozen authorization reusable or reduce the required fresh matrix.

The historical PRs remain audit provenance only. This card neither closes,
deletes, rebases, nor merges them.

## Remaining fee gate

Before a real evidence PR may even request dispatch authorization, a separate
reviewed fee card must bind all of the following to this manifest and current
execution worktree:

1. A fresh OpenOx public-price snapshot with the exact channel, alias,
   protocol, native currency, price group, and input/output unit prices. Native
   USD and CNY amounts remain separate; no implicit FX conversion is allowed.
2. A new purpose-specific `site_builder_model_evaluation` credential with a
   finite cap and exactly the three target alias/protocol pairs. The card must
   record only irreversible evidence; it must never store the bearer token.
3. A current, verifiable quota/balance sample that covers the full 73/146
   matrix and a newly created authorization and durable ledger identity. Prior
   authorization or quota observations cannot be carried forward.
4. A frozen maximum spend, per-wire and execution limits, request-level
   settlement resolver, and the fail-closed response to price, identity,
   protocol, usage, or settlement drift.

The manifest's 2,920 policy-cent ceiling is a mechanical safety limit only. It
is not an OpenOx-priced amount, a balance conversion, an approved budget, or
permission to dispatch.

## Authorization boundary

The product owner has authorized this zero-model reset preflight only. Keep the
following gates separate:

1. Technical review and explicit merge authorization for this decision card.
2. Technical review and explicit merge authorization for a later fresh fee-card
   or evidence-preflight change.
3. A second product-owner approval of the fee card's exact native-currency
   limits before any capability probe or model wire call.
4. Separate review and authorization for evidence acceptance, one-task
   promotion, and any runtime adoption.
