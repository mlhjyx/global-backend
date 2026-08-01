# design_spec evidence preflight decision card

Date: 2026-08-01T11:19:41.563Z

Status: `BLOCKED_CREDENTIAL_NOT_FINITE_EXACT`

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

| Alias | Protocol | OpenOx group | Status | Input / output |
| --- | --- | --- | --- | --- |
| `claude-sonnet-5` | anthropic-messages | special | published | USD 2.52 / 12.6 |
| `gpt-5.5` | openai-responses | gpt-unified | published | CNY 5 / 30 |
| `gpt-5.6-terra` | openai-responses | gpt-unified | published | CNY 2.5 / 15 |

- Catalog response SHA-256: `a605f8e66f69c65bc793dd8b22ee7b11d6a0d5bcf017825719085fb48ba96e65`
- Selected pricing SHA-256: `f6658035b9c34442f98da505191b8de52644984995498b6138e08061637a511a`
- Conservative token envelope: **USD 3.458428 / CNY 12.058855**
- Expected final cost: **not known before usage settlement**
- Mechanical hard ceiling: **2920¢ ($29.20)**; not approved spend

## Credential attestation

- Purpose: `site_builder_model_evaluation`
- Credential material: not persisted (raw value and derived identifier are excluded)
- Observed quota mode: `unlimited`
- Model limits enabled: `false`
- Exact scope: `false`
- Observed allowed aliases: （空；当前令牌未启用精确模型限制）
- Granted quota points: `0`; remaining: `-1774747440`

## Blockers and authorization gate

- `CREDENTIAL_NOT_FINITE_EXACT`

The current token is not a finite exact-scope evaluation credential, so no
runtime attestation was created or installed. Create a purpose-specific token
with exactly the three aliases above and a finite cap. Then present a fresh
fee card and request separate explicit authorization before any capability
probe or evidence execution.

Report SHA-256: `00686a9d909eb4c0ef05dad2ff7bab829c102841b1adaafa2bb2966c7b441f78`
