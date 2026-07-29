# Site Builder settlement/preflight decision card

Date: 2026-07-29

Branch: `codex/m1-g-settlement-preflight`

Status: `BLOCKED_RUNTIME_ATTESTATION_AND_CHANNEL_HEALTH`

Model dispatch authorization: `NOT_AUTHORIZED`

## Delivered without model dispatch

- Exact seven-task current-route coverage is derived from
  `task-routes.ts`; an emergency override or rollback changes the required
  matrix and invalidates the old attestation.
- A maximum-24-hour, digest-bound runtime attestation binds credential
  fingerprint, finite quota, exact model allowlist, protocol, expected channel,
  price snapshot, and quota conversion.
- The preflight runs before durable reserve and before a generative client.
- One initial structured request plus at most one closed repair is priced
  conservatively before execution.
- Every physical response must bind `x-oneapi-request-id` to exactly one
  token-scoped consume-log row. Multi-call usage is accepted only when all
  observations match.
- Unknown settlement charges the conservative reservation, records a failed
  operation, freezes later paid calls for the BuildRun, and cannot fall through
  to another paid provider.
- Tests use fake HTTP responses and fake ledgers only.

Model-generation calls made by this PR: **0**

Model fees incurred by this PR: **$0.00**

## Live read-only blockers observed before implementation

- The currently wired application token reports unlimited quota and does not
  provide the required exact finite model scope.
- The existing text-scoped token is also not a finite application budget and
  its model list does not cover every current MiniMax/Doubao alias.
- The M1-g decision card already records unhealthy or missing current-route
  channels. This PR deliberately does not replace aliases or change routes.
- No reviewed channel snapshot, exact finite quota cap, or short-lived runtime
  attestation is installed.

Therefore the safe runtime state after this PR remains denial before model
dispatch.

## Next decision, still zero-model

An operator may prepare a new application credential and attestation only after
choosing the finite cap. The next card must show, in one frozen snapshot:

1. exact allowlist for all current primary/fallback aliases;
2. exact expected channel ID and healthy non-generative configuration for each
   alias/protocol;
3. `quota_per_unit`, frozen price rows, pricing/channel digests, capture time,
   expiry, granted quota, and remaining quota;
4. the intended M1-g execution count, maximum two wire calls per structured
   execution, priced estimate, and absolute BuildRun ceiling.

Creating that credential/attestation is not model dispatch, but installing it
and rerunning M1-g still requires a separate explicit cost authorization.
Fixed-commit model evidence and every task promotion remain different
decisions and PRs.
