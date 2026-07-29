# Site Builder paid-model settlement preflight

Status: implementation contract; runtime authorization remains blocked

Version: `site-builder-model-settlement-attestation/2026-07-29-v2`

## Purpose and boundary

Durable Site Builder model calls must not infer actual cost from new-api's
local/default pricing table. OpenOx is the upstream vendor, so the only model
price authority is its public model marketplace at
`https://openox.tech/api/public/pricing-catalog`. new-api remains the transport,
credential-scope, channel-identity, and request-log authority only.

Before the ledger reserves money, the runtime must prove that the exact current
task dispatch is covered by a current, finite-scope new-api credential, a
frozen channel snapshot, and the live byte-identical selected OpenOx pricing
rows. After each physical wire call, the runtime resolves the gateway request
identity to one consume-log row for alias/channel/token truth, then calculates
cost from the frozen OpenOx input/output rates. That result is `token_pricing`,
never `provider_reported`.

This contract does not:

- call a model while preparing or validating an attestation;
- change `task-routes.ts`, promote a model, or repair an unhealthy channel;
- authorize model evaluation, images, video, media consumers, MODEL-2, or
  M2-PUBLISH;
- store a bearer token, prompt, response body, or reversible credential in Git
  or in paid-operation metadata.

## Runtime sequence

1. Load the attestation from
   `SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_PATH` and verify the exact file
   digest from `SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_SHA256`.
2. Verify a maximum 24-hour lifetime, gateway origin, irreversible bearer-token
   SHA-256, and an exact dispatch matrix generated from all seven current
   `site_builder.*` task routes.
3. Before ledger reserve, use read-only endpoints to verify:
   - the exact gateway alias exists;
   - the new-api token is finite, has model limits enabled, and exposes exactly
     the frozen allowlist;
   - granted and remaining new-api quota points match the frozen cap; these
     points are a supplemental kill switch, not price truth;
   - the public OpenOx catalog still matches the frozen selected model rows,
     product line, price group, native currency, input/output/cache rates, and
     pricing digest;
   - the conservative two-wire structured-output maximum fits the ledger
     reservation when calculated from OpenOx rates.
4. Reserve the durable operation using a logical operation key that remains
   stable across attestation rotation. Retain the attestation snapshot digest
   as operation metadata so a worker retry cannot bypass an existing
   settled/unknown operation merely because the maximum-24-hour attestation
   was refreshed.
5. Execute at most one initial call and one closed structured repair.
6. For each response, capture `x-oneapi-request-id`, query the token-scoped
   new-api consume log, and require exactly one row with the frozen alias,
   channel, token counts, and gateway quota observation. Gateway quota is
   retained for audit but is not converted into money.
7. Settle only if the number of matching observations equals the physical call
   count. Each accepted observation is priced from the frozen OpenOx
   input/output token rates. Missing, ambiguous, stale, model-mismatched,
   channel-mismatched, or price-mismatched evidence is `unknown`: charge the
   conservative reservation, mark the operation failed, disable further paid
   calls for the BuildRun, and return `PaidOperationUnknownError`.

The preflight itself is fail-closed. No attestation, an unlimited token, a
broader/narrower model list, exhausted quota points, a changed/missing OpenOx
price, an unattested alias/protocol, or an unsupported paid operation produces
`PaidCallDeniedError` before reserve and before a generative endpoint.

## Attestation inputs

The reviewed attestation is a secret-adjacent operational artifact and remains
outside Git. It contains only:

- capture/expiry timestamps and a stable attestation ID;
- gateway origin and channel snapshot digest;
- OpenOx pricing authority/origin/catalog endpoint, selected-row digest, and
  explicit 1:1 OpenOx balance-credit-to-ledger conversion policy;
- irreversible bearer-token SHA-256, finite new-api quota-point cap, exact
  allowlist, and purpose `site_builder_runtime`;
- one row per current `task + alias + protocol`, with exact channel ID and
  exact OpenOx upstream model/product line/group/native currency/rates;
- token-scoped resolver identity and the fixed unknown policy
  `freeze_campaign`.

The file must be mode-restricted at runtime. The bearer token remains in the
ordinary secret store and is never embedded in the attestation. Rotating the
token, route, channel, OpenOx price/group, or gateway invalidates the
attestation and requires a new reviewed snapshot.

The OpenOx marketplace currently labels Claude prices in USD and GPT-family
prices in CNY. The attestation preserves that native currency. Its
`openox_1_to_1_balance_credit` conversion records OpenOx's documented 1:1
recharge/balance-credit semantics; it is not a foreign-exchange claim.

## Authorization gate

This code makes paid execution accountable; it does not authorize it. Before
installing an attestation, the operator must present:

- exact current route/channel health for every dispatch;
- the finite credential cap and remaining balance timestamp;
- the frozen OpenOx pricing rows, native currencies, price groups, and balance
  conversion policy;
- expected execution/wire-call counts and an absolute BuildRun maximum;
- separate approval for product verification or fixed-commit evidence.

Until that card is explicitly approved, leave both attestation environment
variables unset. The resulting preflight denial is the expected safe state.

As of the 2026-07-29 read-only catalog capture, OpenOx does not publish
`minimax-m3`, `deepseek-v4-flash`, `doubao-seed-2.0-pro`, or
`doubao-seed-2.0-lite`. Because those aliases remain in current routes, a
complete seven-task attestation cannot be installed and dispatch remains
fail-closed. Missing prices must not be synthesized from new-api defaults.
