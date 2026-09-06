#!/bin/sh
set -eu

: "${TEMPORAL_PLATFORM_POSTGRES_HOST:?TEMPORAL_PLATFORM_POSTGRES_HOST is required}"
: "${TEMPORAL_PLATFORM_POSTGRES_PASSWORD:?TEMPORAL_PLATFORM_POSTGRES_PASSWORD is required}"

export SQL_PASSWORD="${TEMPORAL_PLATFORM_POSTGRES_PASSWORD}"

stable_checks=0
attempt=0
while [ "${attempt}" -lt 60 ]; do
  attempt=$((attempt + 1))
  if nc -z "${TEMPORAL_PLATFORM_POSTGRES_HOST}" 5432; then
    stable_checks=$((stable_checks + 1))
    if [ "${stable_checks}" -eq 3 ]; then
      break
    fi
  else
    stable_checks=0
  fi
  sleep 1
done
if [ "${stable_checks}" -ne 3 ]; then
  echo "Temporal PostgreSQL did not remain reachable" >&2
  exit 1
fi

apply_schema() {
  database=$1
  schema_dir=$2
  if ! temporal-sql-tool \
    --plugin postgres12_pgx \
    --endpoint "${TEMPORAL_PLATFORM_POSTGRES_HOST}" \
    --port 5432 \
    --user temporal_platform \
    --database "${database}" \
    setup-schema --version 0.0; then
    temporal-sql-tool \
      --plugin postgres12_pgx \
      --endpoint "${TEMPORAL_PLATFORM_POSTGRES_HOST}" \
      --port 5432 \
      --user temporal_platform \
      --database "${database}" \
      update-schema --schema-dir "${schema_dir}"
    return
  fi
  temporal-sql-tool \
    --plugin postgres12_pgx \
    --endpoint "${TEMPORAL_PLATFORM_POSTGRES_HOST}" \
    --port 5432 \
    --user temporal_platform \
    --database "${database}" \
    update-schema --schema-dir "${schema_dir}"
}

apply_schema \
  temporal_platform \
  /etc/temporal/schema/postgresql/v12/temporal/versioned
apply_schema \
  temporal_platform_visibility \
  /etc/temporal/schema/postgresql/v12/visibility/versioned
