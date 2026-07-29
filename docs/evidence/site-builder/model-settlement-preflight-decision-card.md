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
  OpenOx price snapshot, native pricing currency, and balance-credit
  conversion.
- The preflight runs before durable reserve and before a generative client.
- A stale, unreadable, or invalid installed attestation keeps the API and
  worker online while leaving every paid call denied before reserve.
- The public OpenOx catalog is rejected before JSON parsing above a 1 MiB
  declared or accumulated response limit.
- One initial structured request plus at most one closed repair is priced
  conservatively before execution. Repair is suppressed when the initial
  physical call has an unknown settlement.
- Every physical response must bind `x-oneapi-request-id` to exactly one
  token-scoped consume-log row. Multi-call usage is accepted only when all
  observations match. new-api supplies request/channel/token evidence only;
  cost is calculated from the frozen OpenOx catalog and labelled
  `token_pricing`. A consume-log row whose output tokens exceed the immutable
  per-call request cap is invalid and freezes the paid operation.
- Unknown settlement charges the conservative reservation, records a failed
  operation and freezes later paid calls for the BuildRun in one workspace
  transaction, and cannot fall through to another paid provider. Once response
  headers exist, bounded settlement polling can finish independently of the
  expired generation deadline.
- Tests use fake HTTP responses and fake ledgers only.

Model-generation calls made by this PR: **0**

Model fees incurred by this PR: **$0.00**

## Live zero-model refresh

Read-only capture time: `2026-07-29T11:15:53Z`

- The existing application credential returned HTTP 200 from both
  `/v1/models` and `/api/usage/token`, but reported `unlimited_quota=true`,
  `model_limits_enabled=false`, and no exact allowlist. It therefore has no
  admissible finite cap or remaining-balance snapshot for this contract.
- The public OpenOx catalog returned HTTP 200 with 37 model rows and 15 price
  groups. Coverage remains 4 of the 8 unique aliases required by the seven
  current task routes.
- The local new-api database was opened read-only. No channel, token, route, or
  price setting was changed.

| Current alias | Required protocol | Read-only gateway state | OpenOx price |
| --- | --- | --- | --- |
| `gpt-5.6-terra` | Responses | enabled channel 17 | published |
| `claude-sonnet-5` | Messages | enabled channels 8 and 19; expected channel is ambiguous | published |
| `deepseek-v4-pro` | Chat | enabled channel 1 | published |
| `glm-5.2` | Chat | enabled channel 11 | published |
| `minimax-m3` | Chat | only disabled channel 3 | absent |
| `doubao-seed-2.0-pro` | Chat | only disabled channel 3 | absent |
| `deepseek-v4-flash` | Chat | enabled channel 1 | absent |
| `doubao-seed-2.0-lite` | Chat | only disabled channel 3 | absent |

Because the exact route matrix cannot currently bind one healthy channel and
one published upstream price for every dispatch, no replacement credential or
runtime attestation was created. Enabling a disabled channel would not repair
the missing OpenOx price evidence and could expose the historical broad token
to an unapproved paid route.

## Live read-only blockers observed before implementation

- The currently wired application token reports unlimited quota and does not
  provide the required exact finite model scope.
- The existing text-scoped token is also not a finite application budget and
  its model list does not cover every current MiniMax/Doubao alias.
- The M1-g decision card already records unhealthy or missing current-route
  channels. This PR deliberately does not replace aliases or change routes.
- new-api has no user-configured authoritative price table. Its `/api/pricing`
  and quota conversion are explicitly excluded from model-cost truth.
- OpenOx's public catalog capture at `2026-07-29T09:21:17Z` contains only four
  of the aliases needed by current routes:

| Alias | OpenOx group | Native unit / 1M tokens | Input | Output | Cache read | Cache write |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `gpt-5.6-terra` | `gpt-unified` | CNY | 2.50 | 15.00 | 0.25 | 3.125 |
| `claude-sonnet-5` | `special` 1.26x | USD | 2.52 | 12.60 | 0.252 | 3.15 |
| `deepseek-v4-pro` | `deepseek` | CNY | 1.827 | 3.654 | 0.015225 | 0 |
| `glm-5.2` | `glm`, model billing 0.70x | CNY | 5.60 | 19.60 | 1.40 | 0 |

  Selected public-source snapshot SHA-256:
  `10ff60010717ea86a1e9a0feb0c0d5480e7e37c5a9faf7e7432f080e43b9c8f3`.
- `minimax-m3`, `deepseek-v4-flash`, `doubao-seed-2.0-pro`, and
  `doubao-seed-2.0-lite` are absent from that OpenOx catalog. Their prices are
  unknown and must remain blocked; new-api defaults are not a substitute.
- The catalog was captured successfully through the Ubuntu host's configured
  proxy with `curl`, but the application runtime's direct Node `fetch` timed
  out in the same environment. A reviewed runtime proxy/egress path or an
  equivalent digest-bound catalog delivery must be proven before installing
  the attestation; this PR does not weaken TLS or bypass the egress policy.
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
3. frozen OpenOx price rows/groups/native currencies, pricing/channel digests,
   capture time, expiry, granted gateway quota points, and remaining points;
4. the intended M1-g execution count, maximum two wire calls per structured
   execution, priced estimate, and absolute BuildRun ceiling.

The current route matrix cannot satisfy that card until the four missing
OpenOx aliases are restored with published prices or the affected route changes
through a separately approved evidence/promotion decision. Creating a
credential/attestation is not model dispatch, but installing it and rerunning
M1-g still requires a separate explicit cost authorization.
Fixed-commit model evidence and every task promotion remain different
decisions and PRs.
