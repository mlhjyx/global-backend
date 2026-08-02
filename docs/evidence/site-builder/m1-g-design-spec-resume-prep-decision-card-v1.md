# M1-g design_spec resume preparation decision card

Status: **READY_FOR_PRODUCT_DECISION**  
Dispatch authorization: **NOT_AUTHORIZED**

## Outcome

- The stopped campaign consumed 1 GPT-5.5 probe and 16 Terra matrix executions.
- The original authorization ledger is frozen and non-reusable.
- 56 matrix executions remain. A new process also requires a new GPT-5.5 capability probe, so the minimum continuation is **57 executions** and at most **114 wire calls**.
- The current canonical runner is fixed at 73 executions / 146 wire calls and cannot safely represent this subset as-is.
- The next implementation decision is either a scoped resume-run plus evidence-merge contract, or a complete canonical campaign restart. This card authorizes neither.

## Cost boundary

- Previous reconciled actual cost: **CNY 0.206539** (20.6539 CNY cents).
- Continuation mechanical hard ceiling: **$22.80** (2280 policy cents at 20 cents per possible wire call).
- Expected continuation cost: **not yet calculable as an authorization amount**. A scoped executable runner, fresh OpenOx snapshot, finite credential quota, and exact execution-level token envelope are still required.
- No currency conversion is inferred; OpenOx native currencies remain separate.

## Frozen OpenOx price reference

Captured at: `2026-08-02T11:00:07.348Z`  
Revalidation: **REQUIRED_BEFORE_COST_AUTHORIZATION**

| Alias | Protocol | Input / 1M tokens | Output / 1M tokens |
| --- | --- | ---: | ---: |
| `claude-sonnet-5` | `anthropic-messages` | USD 2.52 | USD 12.6 |
| `gpt-5.5` | `openai-responses` | CNY 5 | CNY 30 |
| `gpt-5.6-terra` | `openai-responses` | CNY 2 | CNY 12 |

## Settlement correction

- Old maximum wait: 2,000 ms.
- New bounded schedule: 250 + 500 + 1000 + 2000 + 4000 + 8000 + 12000 ms = 27,750 ms maximum.
- If an exact log row is still absent, settlement remains unknown and the campaign freezes.

## Credential and authorization gate

Before any future model call, create a new purpose-specific, finite credential limited to exactly `gpt-5.6-terra`, `gpt-5.5`, and `claude-sonnet-5`, their reviewed protocols/channels, and the newly approved monetary/quota ceiling. Credential material and recoverable identifiers must not enter Git evidence.

This preparation made **0 network calls**, **0 model wire calls**, and incurred **0 model cost**. A separate implementation PR and a later exact cost authorization are required before dispatch. Promotion remains **NOT_AUTHORIZED**.
