# Browser readiness: exact-image adoption observation

This is a bounded development observation, not a PASS RuntimeEvidence, Release
Bundle, product UAT or Pilot/GA approval. The bounded browser observation passed.

## Source and publication

- PR [#517](https://github.com/mlhjyx/global-backend/pull/517), reviewed head `0a7d2259466c144291f1e6abede51360c02eb1ac`, merged as `b6be49020b28dccf2f67413667c396a893b9ce94`.
- Required [CI run 34694058234](https://github.com/mlhjyx/global-backend/actions/runs/34694058234) passed, including real compiled OCI browser probes and Renderer visual regression.
- Exact-main [publication 34695996341](https://github.com/mlhjyx/global-backend/actions/runs/34695996341) passed its registry attestation verification. The server then pulled that digest and the offline image verifier returned `RUNTIME_IMAGE_VERIFIED`.
- The diagnosed failure and regression evidence are in [the proc exit-race receipt](browser-readiness-proc-exit-race-20260912.md). Increasing a timeout or restarting alone did not establish a fix.

## Exact runtime readback

| Field | Observed value |
| --- | --- |
| Source | `b6be49020b28dccf2f67413667c396a893b9ce94` |
| Image | `ghcr.io/mlhjyx/global-backend@sha256:175ae53c6500456f1121d006fd4add694231d15e20d26fbd77ef795d3f9f90d5` |
| Artifact | `sha256:74ac61098764370c00562152dc83a49876a7d9b363d6415fd82a72c510183c56` |
| Manifest | `sha256:8c424a7e7715bc1995a6b42689a4c45d1eacab5382c967246e2b26081b5d3cf6` |
| SBOM | `sha256:fcbbcff770de35dc412bbb98d83bb6905e134f6d3f750a34afaf66fe394861b1` |
| Source tree | `sha256:bdb8a9c71961f0e8cbc38ad548767f5ed85a5ecaca96d9f1604b612b99a18731` |
| Renderer | `sha256:63a746f47b55a67063bb80a48bcccfb295b89409eda1878cdaab8153cafded5c` |
| Prisma schema | `sha256:ed90b02876d89e251e11749a2fa4b1ef1f172b65be9dc0c71af924b8e45832ff` |
| Migration | `20260908130000_platform_egress_budget_policy_v2` |
| API started | `2026-09-12T13:28:54.019Z` |
| Worker started | `2026-09-12T13:28:53.948Z` |

No queued or running Site BuildRun existed at the pre-cutover query. Only three
image references were edited; no credentials, manual database updates or migrations
were performed. Normal process lease registration resumed on startup.
API, Worker and Outbox Relay leases matched the source/image/artifact/migration
above. Worker remained `STARTING` on queue `understanding`; API and Relay process
leases were `READY`, which does not imply aggregate capability readiness.

## Sustained observation

The 30-minute observation started at `2026-09-12T13:29:51.823Z`. Image identity is
checked at the beginning and end. Each sample checks the browser component,
advancing fresh health snapshot and absence of retained probe directories. A transient in-flight directory is permitted; a
directory older than 20 seconds fails the observation. Final result: `PASS`,
60 samples, `1800028 ms`, observer exit0. All samples had browser=`ok` and
aggregate=`not_ready`; no retained directory was found. The original observation
log SHA256 is `6486b76fab53cc8be9bebcace927f62b81aa850d4eb93ff79aa2a1e27a6444a8`.

The initial browser component was `ok`, while aggregate readiness remained HTTP
503. `AUTH_JWKS_UNAVAILABLE`, `BUDGET_GRANT_VERIFICATION_UNAVAILABLE`,
`EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE`, platform acq/intent/sanctions
`QUOTE_UNAVAILABLE`, and `MATCHING_WORKER_NOT_READY` remain open; no new BuildRun
or paid call was enabled.
GrowthOS at port18081 still used the older demo image and returned JWKS404. This
receipt does not establish GrowthOS, native retained Temporal or user-journey
adoption. Historical evidence remains historical; customer Billing/Credits
remains deferred.

Subsequent milestone: [GrowthOS managed release restoration](growthos-managed-runtime-restoration-20260912.md)
records the later recovery of the JWKS/quote authentication dependencies. The
failure states above remain the observations from this browser-only window;
they have not been rewritten as successes.
