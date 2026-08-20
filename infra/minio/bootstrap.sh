#!/bin/sh
set -eu

: "${MINIO_ENDPOINT:?MINIO_ENDPOINT is required}"
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"

case "$S3_BUCKET" in
  ''|*[!a-z0-9.-]*)
    echo "S3_BUCKET must be a canonical lowercase bucket name" >&2
    exit 2
    ;;
esac

mc alias set deployment "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "deployment/$S3_BUCKET"
mc ilm rule import "deployment/$S3_BUCKET" < /config/site-builder-lifecycle.json

actual=/tmp/site-builder-lifecycle.actual.json
compact=/tmp/site-builder-lifecycle.compact.json
mc ilm rule export "deployment/$S3_BUCKET" > "$actual"
tr -d '[:space:]' < "$actual" > "$compact"

grep -Fq '"ID":"global-variant-attempt-ttl"' "$compact"
grep -Fq '"Status":"Enabled"' "$compact"
grep -Fq '"Expiration":{"Days":1}' "$compact"
grep -Fq '"Tag":{"Key":"global-lifecycle","Value":"variant-attempt"}' "$compact"

echo '{"status":"SITE_BUILDER_STORAGE_PROVISIONED"}'
