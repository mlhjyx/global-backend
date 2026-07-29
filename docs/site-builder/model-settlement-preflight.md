# Site Builder paid-model settlement preflight

Status: implementation contract; runtime authorization remains blocked

Version: `site-builder-model-settlement-attestation/2026-07-29-v1`

## Purpose and boundary

Durable Site Builder model calls must not infer actual cost from a stale
model-only price table. Before the ledger reserves money, the runtime must prove
that the exact current task dispatch is covered by a current, finite-scope
new-api credential and a frozen price/channel snapshot. After each physical
wire call, the runtime must resolve the gateway request identity to one exact
consume-log row before it can call the cost provider-reported.

This contract does not:

- call a model while preparing or validating an attestation;
- change `task-routes.ts`, promote a model, or repair an unhealthy channel;
- authorize model evaluation, images, video, media consumers, MODEL-2, or
  M2-PUBLISH;
- store a bearer token, prompt, response body, or reversible credential in Git
  or in the paid-operation metadata.

## Runtime sequence

1. Load the attestation from
   `SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_PATH` and verify the exact file
   digest from `SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_SHA256`.
2. Verify a maximum 24-hour lifetime, gateway origin, irreversible bearer-token
   SHA-256, and an exact dispatch matrix generated from all seven current
   `site_builder.*` task routes.
3. Before ledger reserve, use read-only gateway endpoints to verify:
   - the exact alias exists;
   - the token is finite, has model limits enabled, and exposes exactly the
     frozen allowlist;
   - granted and remaining quota match the frozen cap and cover the
     reservation;
   - `quota_per_unit` and the complete allowlisted pricing snapshot still match;
   - the conservative two-wire structured-output maximum fits the ledger
     reservation.
4. Reserve the durable operation using an operation key that includes the
   attestation snapshot digest.
5. Execute at most one initial call and one closed structured repair.
6. For each response, capture `x-oneapi-request-id`, query the token-scoped
   consume log, and require exactly one row with the frozen alias, channel,
   token counts, quota, and quota conversion.
7. Settle only if the number of matching observations equals the physical call
   count. Missing, ambiguous, stale, model-mismatched, or channel-mismatched
   evidence is `unknown`: charge the conservative reservation, mark the
   operation failed, disable further paid calls for the BuildRun, and return
   `PaidOperationUnknownError`.

The preflight itself is fail-closed. No attestation, an unlimited token, a
broader/narrower model list, insufficient remaining quota, a price change, an
unattested alias/protocol, or an unsupported paid operation produces
`PaidCallDeniedError` before reserve and before a generative endpoint.

## Attestation inputs

The reviewed attestation is an operational secret-adjacent artifact and must
remain outside Git. It contains only:

- capture/expiry timestamps and a stable attestation ID;
- gateway origin, `quota_per_unit`, pricing snapshot digest, and channel
  snapshot digest;
- irreversible bearer-token SHA-256, finite quota cap, exact allowlist, and
  purpose `site_builder_runtime`;
- one row per current `task + alias + protocol`, with exact channel ID and
  frozen pricing fields;
- token-scoped resolver identity and the fixed unknown policy
  `freeze_campaign`.

The file must be mode-restricted at runtime. The bearer token remains in the
ordinary secret store and is never embedded in the attestation. Rotating the
token, route, channel, price, or gateway invalidates the attestation and
requires a new reviewed snapshot.

## Authorization gate

This code makes paid execution technically accountable; it does not authorize
it. Before installing an attestation, the operator must present:

- exact current route/channel health for every dispatch;
- the finite credential cap and remaining balance timestamp;
- the frozen pricing rows and conversion unit;
- expected execution/wire-call counts and an absolute BuildRun maximum;
- separate approval for product verification or fixed-commit evidence.

Until that card is explicitly approved, leave both attestation environment
variables unset. The resulting preflight denial is the expected safe state.
