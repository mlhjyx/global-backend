# design_spec evidence preflight decision card

Date: 2026-08-02T09:25:37.299Z

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

| Alias | Protocol | OpenOx group | Status | Input / output |
| --- | --- | --- | --- | --- |
| `claude-sonnet-5` | anthropic-messages | special | published | USD 2.52 / 12.6 |
| `gpt-5.5` | openai-responses | gpt-unified | published | CNY 5 / 30 |
| `gpt-5.6-terra` | openai-responses | gpt-unified | published | CNY 2 / 12 |

- Catalog response SHA-256: `4ab30fa07e8b5f0e9a824478aca2914899a13a42d652535cc890ec4cf89c0dba`
- Selected pricing SHA-256: `c3c92341151e97be4094157dfb153f192de57c43aff86e1f0e761796eea59696`
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

## Blockers and authorization gate

- None

The finite exact-scope credential attestation passed. This preflight did
not create or install a runtime attestation and did not authorize model
dispatch. Review this fee card and provide separate explicit authorization
before any capability probe or evidence execution.

Report SHA-256: `f9c147fae99802c025457c07d05caddba59d833e603ccc3f89bd5e0caa1ec8d9`
