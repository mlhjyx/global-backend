#!/bin/sh
set -eu

: "${MINIO_ENDPOINT:?MINIO_ENDPOINT is required}"
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${GENERIC_OPERATION_ARTIFACT_S3_BUCKET:?GENERIC_OPERATION_ARTIFACT_S3_BUCKET is required}"
: "${GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY:?GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY is required}"
: "${GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY:?GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY is required}"
: "${GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY:?GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY is required}"
: "${GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY:?GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY is required}"

validate_bucket() {
  variable_name=$1
  bucket=$2
  case "$bucket" in
    ''|*[!a-z0-9.-]*)
      echo "$variable_name must be a canonical lowercase bucket name" >&2
      exit 2
      ;;
  esac
}

assert_contains() {
  content=$1
  expected=$2
  label=$3
  case "$content" in
    *"$expected"*) ;;
    *)
      echo "$label readback mismatch" >&2
      exit 1
      ;;
  esac
}

assert_not_contains() {
  content=$1
  forbidden=$2
  label=$3
  case "$content" in
    *"$forbidden"*)
      echo "$label readback mismatch" >&2
      exit 1
      ;;
    *) ;;
  esac
}

validate_secret() {
  variable_name=$1
  secret=$2
  if [ "${#secret}" -lt 8 ]; then
    echo "$variable_name must contain at least 8 characters" >&2
    exit 2
  fi
}

validate_bucket S3_BUCKET "$S3_BUCKET"
validate_bucket GENERIC_OPERATION_ARTIFACT_S3_BUCKET "$GENERIC_OPERATION_ARTIFACT_S3_BUCKET"

if [ "$S3_BUCKET" = "$GENERIC_OPERATION_ARTIFACT_S3_BUCKET" ]; then
  echo "generic operation artifacts require a dedicated bucket" >&2
  exit 2
fi

if [ "$MINIO_ROOT_USER" = "$GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY" ] ||
   [ "$MINIO_ROOT_USER" = "$GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY" ] ||
   [ "$GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY" = "$GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY" ]; then
  echo "artifact storage principals must be distinct" >&2
  exit 2
fi

validate_secret MINIO_ROOT_PASSWORD "$MINIO_ROOT_PASSWORD"
validate_secret GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY "$GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY"
validate_secret GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY "$GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY"
if [ "$MINIO_ROOT_PASSWORD" = "$GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY" ] ||
   [ "$MINIO_ROOT_PASSWORD" = "$GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY" ] ||
   [ "$GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY" = "$GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY" ]; then
  echo "artifact storage secrets must be distinct" >&2
  exit 2
fi

mc alias set deployment "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "deployment/$S3_BUCKET"
mc ilm rule import "deployment/$S3_BUCKET" < /config/site-builder-lifecycle.json

mc mb --ignore-existing "deployment/$GENERIC_OPERATION_ARTIFACT_S3_BUCKET"
mc version enable "deployment/$GENERIC_OPERATION_ARTIFACT_S3_BUCKET"
mc encrypt set SSE-S3 "deployment/$GENERIC_OPERATION_ARTIFACT_S3_BUCKET"
mc ilm rule import "deployment/$GENERIC_OPERATION_ARTIFACT_S3_BUCKET" < /config/generic-operation-artifact-lifecycle.json

actual=/tmp/site-builder-lifecycle.actual.json
compact=/tmp/site-builder-lifecycle.compact.json
mc ilm rule export "deployment/$S3_BUCKET" > "$actual"
tr -d '[:space:]' < "$actual" > "$compact"
compact_content=$(cat "$compact")

assert_contains "$compact_content" '"ID":"global-variant-attempt-ttl"' site-builder-lifecycle
assert_contains "$compact_content" '"Status":"Enabled"' site-builder-lifecycle
assert_contains "$compact_content" '"Expiration":{"Days":1}' site-builder-lifecycle
assert_contains "$compact_content" '"Tag":{"Key":"global-lifecycle","Value":"variant-attempt"}' site-builder-lifecycle

artifact_actual=/tmp/generic-operation-artifact-lifecycle.actual.json
artifact_compact=/tmp/generic-operation-artifact-lifecycle.compact.json
mc ilm rule export "deployment/$GENERIC_OPERATION_ARTIFACT_S3_BUCKET" > "$artifact_actual"
tr -d '[:space:]' < "$artifact_actual" > "$artifact_compact"
artifact_compact_content=$(cat "$artifact_compact")

assert_contains "$artifact_compact_content" '"ID":"generic-operation-artifact-staging-ttl"' artifact-lifecycle
assert_contains "$artifact_compact_content" '"Prefix":"generic-operation-results/v1/staging/"' artifact-lifecycle
assert_contains "$artifact_compact_content" '"ID":"generic-operation-artifact-public-organization-ttl"' artifact-lifecycle
assert_contains "$artifact_compact_content" '"Tag":{"Key":"artifact-privacy","Value":"PUBLIC_ORGANIZATION"}' artifact-lifecycle
assert_contains "$artifact_compact_content" '"Expiration":{"Days":30,"ExpiredObjectAllVersions":true}' artifact-lifecycle
assert_contains "$artifact_compact_content" '"ID":"generic-operation-artifact-confidential-tenant-ttl"' artifact-lifecycle
assert_contains "$artifact_compact_content" '"Tag":{"Key":"artifact-privacy","Value":"CONFIDENTIAL_TENANT"}' artifact-lifecycle
assert_contains "$artifact_compact_content" '"Expiration":{"Days":7,"ExpiredObjectAllVersions":true}' artifact-lifecycle
assert_contains "$artifact_compact_content" '"ID":"generic-operation-artifact-personal-data-ttl"' artifact-lifecycle
assert_contains "$artifact_compact_content" '"Tag":{"Key":"artifact-privacy","Value":"PERSONAL_DATA"}' artifact-lifecycle
assert_contains "$artifact_compact_content" '"Expiration":{"Days":1,"ExpiredObjectAllVersions":true}' artifact-lifecycle
assert_contains "$artifact_compact_content" '"NoncurrentVersionExpiration":{"NoncurrentDays":1}' artifact-lifecycle
assert_contains "$artifact_compact_content" '"ExpiredObjectAllVersions":true' artifact-lifecycle
assert_contains "$artifact_compact_content" '"ID":"generic-operation-artifact-staging-delete-markers"' artifact-lifecycle
assert_contains "$artifact_compact_content" '"ID":"generic-operation-artifact-final-delete-markers"' artifact-lifecycle
assert_contains "$artifact_compact_content" '"ID":"generic-operation-artifact-readiness-cleanup"' artifact-lifecycle
assert_contains "$artifact_compact_content" '"ExpiredObjectDeleteMarker":true' artifact-lifecycle

version_info=$(mc version info "deployment/$GENERIC_OPERATION_ARTIFACT_S3_BUCKET" | tr '[:upper:]' '[:lower:]')
encryption_info=$(mc encrypt info "deployment/$GENERIC_OPERATION_ARTIFACT_S3_BUCKET" | tr '[:upper:]' '[:lower:]')
assert_contains "$version_info" enabled artifact-versioning
assert_contains "$encryption_info" sse-s3 artifact-encryption

runtime_policy=/tmp/generic-operation-artifact-runtime-policy.json
personal_policy=/tmp/generic-operation-artifact-personal-read-policy.json

cat > "$runtime_policy" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:GetLifecycleConfiguration"
      ],
      "Resource": ["arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucketVersions"],
      "Resource": ["arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET"],
      "Condition": {
        "StringLike": {
          "s3:prefix": "generic-operation-results/v1/readiness/*"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/staging/*",
        "arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/readiness/*",
        "arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/sha256/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObjectTagging"],
      "Resource": ["arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/sha256/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": ["arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/staging/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/readiness/*",
        "arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/sha256/*"
      ],
      "Condition": {
        "ForAllValues:StringEquals": {
          "s3:RequestObjectTagKeys": ["artifact-privacy"]
        },
        "StringEquals": {
          "s3:RequestObjectTag/artifact-privacy": [
            "PUBLIC_ORGANIZATION",
            "CONFIDENTIAL_TENANT",
            "PERSONAL_DATA"
          ]
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObjectTagging"],
      "Resource": [
        "arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/readiness/*",
        "arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/sha256/*"
      ],
      "Condition": {
        "ForAllValues:StringEquals": {
          "s3:RequestObjectTagKeys": ["artifact-privacy"]
        },
        "StringEquals": {
          "s3:RequestObjectTag/artifact-privacy": [
            "PUBLIC_ORGANIZATION",
            "CONFIDENTIAL_TENANT",
            "PERSONAL_DATA"
          ]
        },
        "Null": {
          "s3:ExistingObjectTag/artifact-privacy": "true"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:AbortMultipartUpload"],
      "Resource": ["arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/staging/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/staging/*",
        "arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/readiness/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:DeleteObjectVersion"],
      "Resource": ["arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/readiness/*"]
    }
  ]
}
EOF

cat > "$personal_policy" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::$GENERIC_OPERATION_ARTIFACT_S3_BUCKET/generic-operation-results/v1/sha256/*"],
      "Condition": {
        "StringEquals": {
          "s3:ExistingObjectTag/artifact-privacy": "PERSONAL_DATA"
        }
      }
    }
  ]
}
EOF

mc admin policy create deployment generic-operation-artifact-runtime "$runtime_policy"
mc admin policy create deployment generic-operation-artifact-personal-read "$personal_policy"
mc admin user add deployment "$GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY" "$GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY"
mc admin user add deployment "$GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY" "$GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY"
mc admin policy attach deployment generic-operation-artifact-runtime --user "$GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY"
mc admin policy attach deployment generic-operation-artifact-personal-read --user "$GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY"

runtime_user_info=$(mc admin user info deployment "$GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY" --json)
personal_user_info=$(mc admin user info deployment "$GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY" --json)
assert_contains "$runtime_user_info" "\"accessKey\":\"$GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY\"" artifact-runtime-user
assert_contains "$runtime_user_info" '"policyName":"generic-operation-artifact-runtime"' artifact-runtime-user
assert_contains "$runtime_user_info" '"userStatus":"enabled"' artifact-runtime-user
assert_not_contains "$runtime_user_info" '"memberOf"' artifact-runtime-user
assert_contains "$personal_user_info" "\"accessKey\":\"$GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY\"" artifact-personal-user
assert_contains "$personal_user_info" '"policyName":"generic-operation-artifact-personal-read"' artifact-personal-user
assert_contains "$personal_user_info" '"userStatus":"enabled"' artifact-personal-user
assert_not_contains "$personal_user_info" '"memberOf"' artifact-personal-user

echo '{"status":"OBJECT_STORAGE_PROVISIONED"}'
