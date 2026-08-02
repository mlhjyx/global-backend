# M1-g design_spec full canonical restart preparation

Status: **READY_FOR_CREDENTIAL_PREFLIGHT**  
Product decision: **FULL_CANONICAL_CAMPAIGN_RESTART**  
Dispatch authorization: **NOT_AUTHORIZED**

## Outcome

- Start one new campaign with **73 executions** and at most **146 wire calls**.
- The canonical runner supports this full campaign; no scoped resume or cross-campaign evidence merge is allowed.
- All 17 prior executions remain historical provenance only. Their probe, matrix outputs, authorization and ledger are not reusable for ranking.
- The new campaign requires a fresh GPT-5.5 probe, all 72 matrix executions, a new authorization id and a new durable ledger directory.

## Cost boundary

- Prior reconciled actual cost: **CNY 0.206539** (20.6539 CNY cents).
- Full-restart mechanical hard ceiling: **$29.20** (2920 policy cents at 20 cents per possible wire call).
- Expected cost remains **not authorizable** until a fresh OpenOx snapshot, exact execution token envelope and full-cap finite credential are frozen.
- Native currencies stay separate; no FX conversion is inferred.

## Historical OpenOx reference only

Captured at: `2026-08-02T11:00:07.348Z`  
Revalidation: **REQUIRED_BEFORE_COST_AUTHORIZATION**

| Alias | Protocol | Input / 1M tokens | Output / 1M tokens |
| --- | --- | ---: | ---: |
| `claude-sonnet-5` | `anthropic-messages` | USD 2.52 | USD 12.6 |
| `gpt-5.5` | `openai-responses` | CNY 5 | CNY 30 |
| `gpt-5.6-terra` | `openai-responses` | CNY 2 | CNY 12 |

## Fresh credential and campaign gate

- Purpose: `site_builder_model_evaluation`
- Exact aliases: `claude-sonnet-5`, `gpt-5.5`, `gpt-5.6-terra`
- Required quota cap and remaining balance: `14600000` points each.
- Campaign id: `design-spec-full-restart-20260802-v1`
- Frozen preflight input: `docs/evidence/site-builder/m1-g-design-spec-full-restart-preflight-v1.json`
- Execution preflight output: `docs/evidence/site-builder/m1-g-design-spec-full-restart-execution-preflight-v1.json`
- Ledger id: `design-spec-real-evidence-ledger/design-spec-full-restart-20260802-v1`

This preparation made **0 network calls**, **0 model wire calls**, and incurred **0 model cost**. It does not create or modify a credential, authorize dispatch, merge evidence, promote a model, or change a runtime route.
