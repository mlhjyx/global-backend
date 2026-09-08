# Platform revocation target-proof addendum

Status: PROPOSED — USER_CONFIRMATION_REQUIRED. Not implemented, not runtime evidence.

## Problem demonstrated by source review

GrowthOS commits issuance before the Worker can admit it in Backend. Selecting
the latest issuance for an immutable revoke command can therefore select a JTI
that Backend never received. The existing Backend fence correctly rejects that
unknown target. If an older admitted run exists, its schedule is not fenced;
retry cannot change the already-persisted command. Local MySQL tests alone do
not cover this cross-database window.

We will not fix this by accepting an unknown Backend target, inventing an
authority, overwriting a command, or claiming pending disable is effective.

## Proposed narrow extension

Add a read-only, separately authenticated Backend target-existence proof.
This adds a cross-system security interface and requires explicit confirmation
in addition to the existing implementation approval.

### Backend request and identity

POST `/api/v1/platform-authority/target-proofs`, exact JSON object:

```json
{"target_issuer":"<configured GrowthOS issuer>","target_jti":"<uuid>","schedule_id":"<one of four schedules>","workflow_run_id":"<uuid>"}
```

- A dedicated service identity has only `platform-authority.target-proof.read`.
- Service access tokens use a separate keyring/JWKS trust configuration, typ
  `platform-target-proof-reader+jwt`, audience `global-backend:platform-target-proof`.
  Neither ordinary user tokens nor Budget Grants are accepted as this identity.
- Reader JWT algorithm is RS256 only with bounded kid and exact configured
  issuer, `sub=growthos-platform-control-plane`, and the single string scope
  `platform-authority.target-proof.read`. Closed claims also include `jti`,
  `iat`, `nbf`, `exp`, and `target_issuer`; the latter must equal the configured
  GrowthOS Grant issuer and the request target issuer. Require integer
  NumericDates, `iat <= nbf < exp`, TTL <= 300 seconds, at most 60 seconds future
  iat/nbf skew, and strict `now < exp`. Missing/extra scopes, wrong subject,
  expired credentials and tokens not yet valid beyond tolerance are rejected
  before querying authority state. No ordinary role/scope mapping is reused.
- The authenticated service issuer is bound to the requested target issuer;
  only GrowthOS-owned platform authorities can be inspected.
- No tenant/workspace lookup, enumeration, body echo, raw Grant or user data.
- Request max 4 KiB, response max 8 KiB, end-to-end timeout 2 seconds, per-service
  atomic rate limit. No model/provider call, workflow creation or DB mutation.
- DB uses a separately bounded read capability, not app/owner fallback. Only
  committed `scope_key=platform`, `authority_kind=PLATFORM_GRANT` exact matches
  can produce a positive proof. An expired/revoked authority may still exist
  and be a valid locator for the existing schedule fence.
- Missing target is a bounded `NOT_FOUND`; unavailable DB/auth/timeout is
  `UNAVAILABLE`. Neither is a proof of global absence or successful fencing.

### Signed proof

Backend signs through a dedicated proof keyring (not identity, Budget Grant or
fence ACK keys), typ `platform-authority-target-proof+jwt`, audience
`growthos:platform-authority-target-proof`. Claims are closed:

```text
schema_version = platform-authority-target-proof/v1
iss, aud, proof_jti, iat, nbf, exp
target_issuer, target_jti, schedule_id, workflow_run_id
authority_id, observed_at
```

RS256 only, bounded kid, exact issuer/audience, NumericDate integers; lifetime
at most 60 seconds and at most 5 seconds clock tolerance. No negative signed
proof or dispatch authority is inferred. Raw proofs are transient; permanent
audit stores only digest and required validated claims.

### GrowthOS append-only recovery

1. Under the existing policy lock, record immutable disable request and move
   to DISABLE_REQUESTED. This stops new issuance. Do not choose a target merely
   because an issuance exists; NO_TARGET means no *confirmed* target yet.
2. Outside DB locks, query only that request's own issuance candidates. The
   candidate universe cannot grow while the same policy sequence is disabled;
   state/sequence are checked again before adoption. Each round examines at
   most eight candidates within a ten-second total deadline, using a durable
   cursor; an incomplete round never claims global absence. A previously proven
   older target is preferred over an unadmitted latest issuance.
   NOT_FOUND/UNAVAILABLE never permanently removes a candidate: once the cursor
   reaches the end, subsequent rounds revisit unconfirmed candidates with
   bounded exponential backoff (1s, 5s, 30s, then at most one round per minute).
   The original Grant may have been admitted after its first lookup. Retries
   never issue a replacement Grant or start a workflow/model call.
3. Verify the proof independently, then reacquire policy lock and require the
   same DISABLE_REQUESTED sequence and an existing local issuance matching every
   target field. Recheck proof freshness after lock acquisition.
4. Append one immutable adopted-proof row tied to request and issuance. Create
   and encrypt the immutable revoke outbox in that same transaction. Outbox
   references the adopted proof and must carry its exact target.
5. Concurrent recovery returns the first existing outbox without re-signing.
   Failure rolls back proof/outbox but preserves the pending disable request.
   Original request target_state remains its creation-time snapshot; later
   proof/outbox facts are append-only and never rewrite that history.
   This recovery creates a proof-bound outbox only when none exists. An older
   immutable outbox with an unproven target is never rebound or replaced for the
   same sequence: it can only retry its original command/target, and may proceed
   if that exact target later exists. Otherwise it remains pending/parked. A
   target-changing repair of already-issued commands is outside this proposal.
6. Backend still performs its existing target validation and fence transaction.
   Only its existing authenticated, durably stored fence ACK can make GrowthOS
   DISABLED_EFFECTIVE. A target proof is never a fence ACK.

If no confirmed target ever exists, remain pending. A target-free signed fence
would be a different authorization contract and is explicitly excluded here.

## Verification required before enabling

- Exact scope, key/typ/audience substitution and tenant enumeration negatives.
- New issuance committed but not admitted: no outbox from that unproven target.
- Older admitted target plus newer unadmitted target: one valid immutable revoke
  command, then real PostgreSQL schedule fence and GrowthOS ACK completion.
- Lost admission response: recover by read-only proof, never resend a model call
  or create a replacement Grant.
- First lookup NOT_FOUND, then the original Grant is admitted: a later bounded
  rescan obtains proof and creates exactly one outbox, with no replacement Grant.
- An existing immutable outbox targeting an unknown authority cannot be rebound
  to another target or be falsely declared effective by this recovery.
- All lookups fail or are unproven: pending, zero outbox and no effective state.
- Stale proof and sequence/state changes while awaiting proof or locks: reject.
- Two different valid target proofs race: one adopted proof/outbox, no re-sign.
- Real cross-DB tests for issue/admission/disable ordering, rollback and exact ACK
  replay after response loss/expiry. No fake data may enter managed runtime.

## Unchanged boundaries

Customer Billing/Credits stay deferred. Historical UNKNOWN is never redispatched.
Existing signed revocation targets, Budget Grant authority, send-cut semantics,
immutable source/OCI deployment, and independent runtime evidence gates remain.
This proposal does not authorize deployment, credentials installation or new
service access until confirmed and implemented through those existing gates.
