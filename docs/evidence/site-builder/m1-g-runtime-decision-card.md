# M1-g runtime decision card

Date: 2026-07-29  
Branch: `codex/m1-g-stage-closeout`  
Status: `BLOCKED_CURRENT_ROUTE_SETTLEMENT`

The immutable source commit, verifier digest, and tracked source-bundle digest
are recorded in
`docs/evidence/site-builder/m1-g-stage-closeout-baseline.json`. The evidence
writer refuses a dirty source tree; the evidence JSON itself is excluded from
the source-bundle digest to avoid a recursive self-hash.

## Verified without product-model dispatch

- Unified entrypoint: `apps/api/scripts/verify-site-builder-m1.mts`.
- Six BrandProfile bootstrap fixtures: 3 sparse + 3 rich.
- Six approved Families: 12 sparse/rich visual fixtures.
- 36 byte-pinned screenshots: 375 / 768 / 1440.
- Empty-Claim fact safety: no fixture-only certification, client name, metric,
  service promise, or badge survives controlled assembly.
- Ten-site genericness sample: 9 home structures, maximum exact repeat 2/10,
  maximum card-section ratio 20%.
- Development PostgreSQL/FORCE RLS, MinIO, image variants/metadata stripping,
  en/de-DE neutral copy, ReleaseManifest v1 activation, local new-api
  `/models`, Astro, and the Temporal ACK-loss/round-3/cancel/pointer/restart
  matrix.
- Redis and SearXNG live containers were recreated from the existing Compose
  definition and now bind only to `127.0.0.1`.

The reproducible baseline is
`docs/evidence/site-builder/m1-g-stage-closeout-baseline.json`.

## Current-route P1-P5 result

The product verifier is separate from model-evaluation PR #245. It uses the
existing production task registry and does not create model evidence or change
routes.

Three bounded development attempts were made while repairing verifier drift:

1. The first reached BrandProfile and then exposed a missing M1-f
   `QualityCandidateService` dependency in the old verifier.
2. The second proved that a $2 BuildRun reservation cap is too small for four
   structured tasks reserving primary/fallback plus one repair.
3. The final attempt used a $5 absolute BuildRun stop, reached P4, then
   correctly failed closed with
   `QUALITY_GATE_FAILED: paid execution gate is closed`.

Observed successful upstream charges from new-api logs:

| Attempt | Model | Charge |
| --- | --- | ---: |
| 1 | `claude-sonnet-5` | $0.292800 |
| 2 | `claude-sonnet-5` | $0.400500 |
| 3 | `claude-sonnet-5` | $0.347100 |
| 3 repair | `claude-sonnet-5` | $0.405300 |
| 3 later task | `deepseek-v4-pro` | $0.171526 |
| **Total** |  | **$1.617226** |

Failed calls were not charged. The evaluation campaign remained at zero calls
and zero cost.

## Blocking evidence

- `gpt-5.6-terra` Responses returned upstream 403/502.
- `minimax-m3` and `doubao-seed-2.0-pro` had no available channel.
- One current Chat route returned an upstream 401 for an invalid channel
  credential.
- `deepseek-v4-pro` did return successfully, but a preceding provider failure
  had unknown settlement. R4-B-min therefore disabled paid execution before
  P4. This is the intended fail-closed behavior.

## Decision

Do not run another paid M1-g attempt and do not mark M1-g complete yet.
Restore the current task-route channel health and known settlement first, then
rerun the same fixed verifier. Changing model routes or promoting candidates is
outside this PR and requires the separate evidence and promotion decisions.

The 30+ mature system set, MODEL-2, independent aesthetic Gold, production
deployment, M2-PUBLISH, and all model promotions remain incomplete.
