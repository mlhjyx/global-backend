# GrowthOS managed release restoration

This records restoration of an existing published baseline, not adoption of the
latest GrowthOS source candidate or completion of platform capability/UAT. No
new image, signing key, commercial billing function or model call was created.

## Cause and selected release

The `growthos-full-stack/current` selector still pointed to the August23 demo
release, and actual Compose labels matched that release and local mutable image
names. A later published managed release existed but was not selected. This
establishes the stale entrypoint; it does not identify who invoked it.

Restored release: `20260901T024414Z-production-parity-final`, authority source
`541bcc63c3486296ab4e2461d4d005e6cd43710b`. Its product receipt SHA256 is
`e6b3a4ea6e13245be77ba345a31459793efbb5bfb441ce98434cbbf10d874170`.
This is earlier than authority `51d74203…` and the local0099–0102 candidates.

| Role | Exact image |
| --- | --- |
| Backend | `ghcr.io/mlhjyx/growthos-backend@sha256:1535bb01c410e3ffa4b2ec469dbbe94a0e6128eb77eaed31dd03a676fa78f10c` |
| Tenant Web | `ghcr.io/mlhjyx/growthos-tenant-web@sha256:d60a13201ab0116127268870d75f8f133269b2cfa4362683b14d97920d96cf01` |
| Platform Admin Web | `ghcr.io/mlhjyx/growthos-platform-admin-web@sha256:202e56429d00a4f6e14e0f6cb0f10d8ec6ed83b389da733bddf41592c0a38083` |

All three local image source/artifact labels matched the release receipt and
used UID/GID10001. The backend JAR SHA256 matched its recorded artifact:
`2f8c7ea635d69cf25e7ed182ed8888e89db8c2eaf98dd752546f98565eb39f4f`.

## Data and configuration safeguards

- The exact packaged Flyway12.8.1 checksum implementation was run offline over
  all27 JAR migrations. Its sorted script/checksum list matched all27 successful
  database rows, with zero failures. Both lists hash to
  `1ed720aba6d8f161ab35ebdd44b74409eb2a033f05a85bd17ccae3f630bfc388`.
- A fresh restricted backup passed `gzip -t`, mode0600,62223bytes; SHA256
  `82cbd09c160da04f3b4b8086f08afac8b05b48383dc0dc50865b46d01a5d925f`.
  It remains in the deployment-owned private backup directory, not in Git.
- Existing GrowthOS project/volume names were retained; no empty replacement
  database or volume migration was introduced. Infrastructure image bytes,
  MySQL root credential and Valkey command inputs were unchanged. The configured
  application database identity passed a read-only login check.
- Existing keyring files were present, UID/GID10001 and mode0600. No key content
  was logged or changed. The Unix relay's group19991 matched the host socket.
- Compose rendering used both existing runtime environment files and the
  infrastructure/apps/generated-managed overlays, with no product build and
  exact image references. Rendered secret-bearing JSON was restricted0700/0600,
  not printed or added to evidence.

## Restoration and readback

Applications were stopped before the managed `up --no-build --pull never`.
The backend started at `2026-09-12T15:13:52.304Z`; all three product containers
became healthy with exact references above and Compose labels pointing to the
managed release. The selector was then atomically changed from the old symlink
to that release. Old releases, database volumes and historical records remain.

The correct mode0644 MySQL config was mounted from the managed release; the old
world-writable-config warning disappeared. Flyway remained27/27 successful,
zero failures; server character set/collation/timezone matched the configured
UTF8/UTC contract. No new migration or manual business-data update was performed.

- Tenant and Platform Web returned HTTP200. Ports3002,3003,18081 were verified
  bound only to127.0.0.1. This is HTTP availability, not logged-in browser UAT.
- All three JWKS endpoints returned HTTP200, one RSA key each and public-only
  fields. Key-set digests: identity
  `ae6f23fc07cb9c365ce8c2ac884029363654691c5abeeb640859d4606bfdab8e`,
  Site Build `c41723aface8e1f95e8d71d9db6a512a752310ecdc45d7752e89cc37eab72476`,
  Execution `63e8b341de1d805cb84b994d97bda67f13b09179aa7ce58e9d00462377beddaf`.
- Backend readback at `2026-09-12T15:21:15.025Z` showed auth, Site Build and
  Execution JWKS, workspace budget authority and platform quote authentication
  `ok`. Browser remained `ok`. Aggregate readiness remained503 because platform
  schedules still reported `TEMPORAL_PROOF_UNAVAILABLE` and Worker was not ready.

This does not deliver the dedicated capability service JWT, producer/consumer,
native retained Temporal, Worker isolation/lease contract, fresh RuntimeEvidence,
Release Bundle or customer build journey. Customer Billing/Credits stays deferred.
