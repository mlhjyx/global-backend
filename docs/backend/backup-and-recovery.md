# Global development backup and recovery runbook

This runbook covers the Ubuntu `global-dev` development environment only. Its
commands and objectives are a controlled procedure, not evidence that any
backup or restore has run. The current rehearsal manifest is `NOT_RUN`.

## Objectives and current evidence

The values below are initial development objectives. They are not measured
SLOs, production commitments, or achieved results.

| Asset                   | Authoritative data location                                   | RPO objective | RTO objective | Rehearsal evidence |
| ----------------------- | ------------------------------------------------------------- | ------------: | ------------: | ------------------ |
| PostgreSQL              | Compose volume `global_pgdata`, database `global_dev`         |          24 h |           4 h | `NOT_RUN`          |
| new-api                 | Compose volume `global_newapi-data`, mounted at `/data`       |          24 h |           4 h | `NOT_RUN`          |
| MinIO                   | Compose volume `global_miniodata`, mounted at `/data`         |          24 h |           8 h | `NOT_RUN`          |
| Temporal dev SQLite     | `/data/temporal/temporal.db` from host `temporal-dev.service` |           4 h |           4 h | `NOT_RUN`          |
| Versioned configuration | accepted Git commit, Compose/infra/systemd config, migrations |          24 h |           2 h | `NOT_RUN`          |

Redis and the Ollama model cache are rebuildable caches and are not in the
minimum recovery set. AI-observability data is outside this runbook while its
image profile remains `UNVERIFIED`.

## Hard admission gate

Before touching a service, the operator must create a new rehearsal manifest
from the checked-in template and obtain explicit user authorization. The
authorization must bind:

- a unique rehearsal and authorization ID;
- the exact source commit and image-lock digest;
- the five assets above and the destination backup directory/bucket;
- a maintenance window, maximum outage, and named operator;
- restore destinations that are disposable and cannot resolve to live service
  names, ports, databases, volumes, or buckets.

Stop if the authorization is absent/expired, a destination already exists,
free space is unknown, a source location differs from this runbook, a checksum
cannot be produced, or any required secret would have to be read from `.env`.
Credentials must be supplied through the approved secret manager or an
ephemeral operator session and must never enter the manifest, terminal log, or
repository.

Every backup destination must enforce encryption at rest, least-privilege
access, an approved retention period, and access logging. new-api state can
contain provider/channel credentials, and MinIO contains tenant data; their
artifacts must be treated as sensitive even when the evidence manifest is
redacted.

`pnpm recovery:verify` is deliberately create-only: it accepts only the
checked-in `NOT_RUN` state. It rejects `AUTHORIZED`, `RUNNING`, `FAILED`, and
`PASSED` even when their JSON fields look complete, because repository source
cannot prove an external authorization or a restore. A future executed-evidence
verifier must bind independently authenticated authorization and immutable
receipt artifacts before any non-`NOT_RUN` state can become admissible. The
current command does not authorize or execute a rehearsal.

## Backup procedure

All examples below are templates to run only after the admission gate. Replace
angle-bracket values with the authorized, validated values. Never use
`docker compose down -v`, delete a source volume, or write into a live backup.

### 1. Read-only inventory

Record the source commit, `config/container-image-lock.json` digest, service
state, volume identities, database migration status, object counts, source
sizes, and free capacity. Confirm the Compose project is exactly `global`.
Inventory output must be redacted and must not include environment variables,
tokens, passwords, connection strings, or object contents.

### 2. PostgreSQL logical backup

Use an owner connection supplied explicitly for the authorized maintenance
window. Produce a custom-format logical dump with no ownership or ACL replay:

```bash
pg_dump --format=custom --no-owner --no-acl \
  --file=<authorized-backup-dir>/postgresql-global_dev.dump \
  --dbname=<authorized-owner-pg-service-name>
sha256sum <authorized-backup-dir>/postgresql-global_dev.dump
pg_restore --list <authorized-backup-dir>/postgresql-global_dev.dump \
  > <authorized-backup-dir>/postgresql-global_dev.catalog.txt
```

The named PostgreSQL service must come from an ephemeral, permission-restricted
service file supplied by the secret manager; do not place a password-bearing
URL in arguments or shell history. The catalog and checksum prove only
readability, not restorability. Do not use the shared development database as
a restore target.

### 3. new-api data

The durable boundary is the complete `global_newapi-data` volume, not a guessed
SQLite filename. Choose one authorized application-consistent mechanism:

- a storage snapshot taken while `new-api` is stopped; or
- a documented new-api export/SQLite online-backup procedure whose exact data
  file has first been identified without exposing tokens.

Raw copying of a mounted live database is forbidden. Record volume identity,
source size, backup artifact SHA-256, consistency mechanism, stop/start times,
and the exact pinned new-api image. If the internal database layout is unknown,
stop the rehearsal and leave the receipt incomplete.

### 4. MinIO objects

Mirror every required bucket, including object versions and metadata, to a
dedicated versioned backup destination using an ephemeral least-privilege
credential. Record per-bucket object/version counts, total bytes, and an
inventory digest. The destination must not share the live MinIO volume or
credentials. A volume-level snapshot is admissible only when it is
application-consistent and the snapshot mechanism is bound in authorization.

### 5. Temporal development SQLite

Confirm the systemd unit still points to
`/data/temporal/temporal.db`. During the authorized maintenance window, stop
`temporal-dev.service`, create a SQLite backup using the SQLite backup API or
`.backup` command, checksum it, and restart the service. Do not copy only the
main database while ignoring a live WAL. Record the unit definition digest,
SQLite integrity-check result, file size, checksum, and outage duration.

### 6. Configuration bundle

The configuration receipt is a Git archive of the authorized commit plus the
digests of:

- `docker-compose.yml` and `infra/ai-observability.compose.yml`;
- `config/container-image-lock.json`;
- `packages/db/prisma/schema.prisma` and every tracked migration;
- `infra/searxng/` and `infra/systemd/`;
- this runbook and the rehearsal manifest.

Secrets are deliberately excluded. Record only the secret-manager object names
and rotation/recovery owner in an access-controlled external inventory, never
their values or fingerprints in this repository.

## Restore rehearsal

Restore into new, disposable destinations only. The authorization must name
them exactly before the first write.

1. Create a unique PostgreSQL database prefixed `global_restore_` and a unique
   non-superuser restore role. Reject any URL whose database name is
   `global_dev` or whose host/port points to the shared development service.
   Restore the dump, apply no new migrations, then compare migration rows,
   schema, RLS/FORCE RLS policies, required grants, and approved aggregate row
   counts. Test cross-workspace denial with the disposable role.
2. Restore the new-api artifact into a new volume and start the exact pinned
   image on an isolated loopback port. Verify schema/readability, model/channel
   counts, and that no credential value appears in evidence. Do not send model
   requests or enable channels.
3. Restore MinIO into a new volume/bucket namespace on isolated loopback ports.
   Compare bucket names, object/version counts, metadata, and sampled content
   digests. Do not overwrite the live bucket or publish objects.
4. Restore Temporal SQLite to a new filesystem path and start an isolated
   development server on non-live ports, or use immutable history replay.
   Verify SQLite integrity and a reviewed history allowlist without connecting
   the production worker or the live namespace.
5. Recreate configuration from the authorized Git commit and compare every
   recorded digest. Supply only disposable test credentials.

Any mismatch makes the rehearsal `FAILED`; it must never be rounded into a
partial `PASSED` result. Preserve the failed artifacts and redacted diagnostics
for analysis, then stop the isolated services without deleting the source
backup.

## Acceptance receipts and closeout

A future `PASSED` evidence contract requires one `RESTORE_VERIFIED` receipt for each asset:
`postgresql`, `new-api`, `minio`, `temporal-sqlite`, and `configuration`. Every
receipt must bind the artifact SHA-256, isolated restore destination, verifier
version/commit, start/end time, observed RPO/RTO, and redacted acceptance
summary. The manifest itself must carry the explicit authorization record. The
current source-only verifier does not accept this state; those requirements are
the minimum design input for a separately reviewed evidence verifier, not a
claim that receipt authenticity can be established today.

After closeout, revoke ephemeral credentials and record whether each RPO/RTO
objective was met. Promotion of these objectives to production SLOs is a
separate user decision. Deleting backup artifacts, restore volumes, or old
source volumes requires a separate explicit authorization and is not part of
this runbook.
