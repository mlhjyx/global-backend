# design_spec evidence preflight decision card

Date: 2026-08-02T11:00:07.348Z

Status: `READY_FOR_PRODUCT_DECISION`

Dispatch authorization: `NOT_AUTHORIZED`

## Scope

- Fixed evidence source commit: `e493ba1d09fe37feea927f70d12f17aadadc5c6a`
- Manifest: `site-builder.design-spec-evaluation-suite/2026-08-01-v14`
- Executions: **73**
- Maximum wire calls: **146**
- Model-generation calls made by this preflight: **0**
- Model fees incurred: **$0.00**
- Read-only control-plane/catalog calls: **3**
- Generative endpoints called: **0**

## OpenOx price snapshot

OpenOx is the sole price authority; new-api prices are not used. Rates below
are native OpenOx units per one million tokens after the selected group
multiplier. Native USD and CNY totals remain separate; this is not FX.

| Alias             | Protocol           | OpenOx group | Status    | Input / output  |
| ----------------- | ------------------ | ------------ | --------- | --------------- |
| `claude-sonnet-5` | anthropic-messages | special      | published | USD 2.52 / 12.6 |
| `gpt-5.5`         | openai-responses   | gpt-unified  | published | CNY 5 / 30      |
| `gpt-5.6-terra`   | openai-responses   | gpt-unified  | published | CNY 2 / 12      |

- Catalog response SHA-256: `2e74edb50488b058820f3d73a836bd2a3d0b2ddfac4c9b28f076b478890abac8`
- Selected pricing SHA-256: `45eb34a532b7f98c7b7712bbbcd0d69c7f21c162bf7fef5a9d350690ec0073cb`
- Conservative token envelope: **USD 3.458428 / CNY 11.276659**
- Expected final cost: **not known before usage settlement**
- Mechanical hard ceiling: **2920¢ ($29.20)**; not approved spend

## Credential attestation

- Purpose: `site_builder_model_evaluation`
- Credential material: not persisted (raw value and derived identifier are excluded)
- Observed quota mode: `limited`
- Model limits enabled: `true`
- Exact scope: `true`
- Observed allowed aliases: `claude-sonnet-5`, `gpt-5.5`, `gpt-5.6-terra`
- Granted quota points: `14600000`; remaining: `14600000`

## Exact channel binding

- Dedicated group: `design-spec-eval`
- Group ratio: `1`
- Cross-group retry: `false`
- Exact one-channel-per-alias binding: `true`
- Credential material: not persisted

| Alias             | Protocol           | Channel    | Reviewed channel name | Enabled |
| ----------------- | ------------------ | ---------- | --------------------- | ------- |
| `claude-sonnet-5` | anthropic-messages | Channel 19 | claude                | true    |
| `gpt-5.5`         | openai-responses   | Channel 17 | OpenOx GPT Portfolio  | true    |
| `gpt-5.6-terra`   | openai-responses   | Channel 17 | OpenOx GPT Portfolio  | true    |

## Blockers and authorization gate

- None

The finite exact-scope credential attestation passed. This preflight did
not create or install a runtime attestation and did not authorize model
dispatch. Review this fee card and provide separate explicit authorization
before any capability probe or evidence execution.

Report SHA-256: `2f9cee8cd1cbf8abf2fb0b4f15c494e7f6a909f545c2b6f99ca10d46d6e18c26`
