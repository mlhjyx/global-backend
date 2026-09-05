#!/bin/bash
set -euo pipefail
export COMPOSE_IGNORE_ORPHANS=true

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_FILE=${TEMPORAL_PLATFORM_COMPOSE_FILE:-${SCRIPT_DIR}/compose.yml}
ADMIN_SERVICE=${TEMPORAL_PLATFORM_ADMIN_SERVICE:-temporal-platform-admin}
CLIENT_SECRET_DIRECTORY=${TEMPORAL_PLATFORM_CLIENT_SECRET_DIRECTORY:?TEMPORAL_PLATFORM_CLIENT_SECRET_DIRECTORY is required}
READER_TOKEN_FILE=${TEMPORAL_PLATFORM_READER_TOKEN_FILE:-/run/secrets/temporal-platform-client/reader.jwt}
: "${TEMPORAL_PLATFORM_PROOF_SCHEDULE_ID:?TEMPORAL_PLATFORM_PROOF_SCHEDULE_ID is required}"
: "${TEMPORAL_PLATFORM_PROOF_WORKFLOW_ID:?TEMPORAL_PLATFORM_PROOF_WORKFLOW_ID is required}"
: "${TEMPORAL_PLATFORM_PROOF_RUN_ID:?TEMPORAL_PLATFORM_PROOF_RUN_ID is required}"

case "${ADMIN_SERVICE}" in
  *[!A-Za-z0-9_.-]*)
    echo "Temporal admin service name is invalid" >&2
    exit 1
    ;;
esac
case "${READER_TOKEN_FILE}" in
  /run/secrets/temporal-platform-client/*.jwt) ;;
  *)
    echo "Temporal reader token must use the dedicated client secret mount" >&2
    exit 1
    ;;
esac

HOST_READER_TOKEN=${CLIENT_SECRET_DIRECTORY}/${READER_TOKEN_FILE##*/}
if [[ ! -f "${HOST_READER_TOKEN}" || -L "${HOST_READER_TOKEN}" ]]; then
  echo "Temporal reader token file is unavailable" >&2
  exit 1
fi
if [[ $(stat -c '%a' "${HOST_READER_TOKEN}") != 600 ]] ||
  (( $(stat -c '%s' "${HOST_READER_TOKEN}") < 32 )) ||
  (( $(stat -c '%s' "${HOST_READER_TOKEN}") > 16384 )); then
  echo "Temporal reader token file mode or size is invalid" >&2
  exit 1
fi

compose=(docker compose -p global -f "${COMPOSE_FILE}")
"${compose[@]}" --profile platform-temporal-tools run --rm --no-deps \
  --entrypoint /bin/sh "${ADMIN_SERVICE}" -eu -c '
    token_file=$1
    schedule_id=$2
    workflow_id=$3
    run_id=$4
    reader=$(cat "${token_file}")
    case "${reader}" in
      *[!A-Za-z0-9._-]*|*.*.*.*|.*|*.)
        echo "Temporal reader token format is invalid" >&2
        exit 1
        ;;
    esac
    first_segment=${reader%%.*}
    remainder=${reader#*.}
    second_segment=${remainder%%.*}
    third_segment=${remainder#*.}
    if [ "${remainder}" = "${reader}" ] ||
      [ "${third_segment}" = "${remainder}" ] ||
      [ -z "${first_segment}" ] || [ -z "${second_segment}" ] ||
      [ -z "${third_segment}" ]; then
      echo "Temporal reader token format is invalid" >&2
      exit 1
    fi
    base() {
      temporal "$@" \
        --address "${TEMPORAL_PLATFORM_ADDRESS}" \
        --tls \
        --tls-ca-path /run/secrets/temporal-platform-client/ca.crt \
        --tls-server-name "${TEMPORAL_PLATFORM_TLS_SERVER_NAME}" \
        --command-timeout 15s \
        --output none
    }
    reader_cli() {
      temporal "$@" \
        --address "${TEMPORAL_PLATFORM_ADDRESS}" \
        --tls \
        --tls-ca-path /run/secrets/temporal-platform-client/ca.crt \
        --tls-server-name "${TEMPORAL_PLATFORM_TLS_SERVER_NAME}" \
        --api-key "${reader}" \
        --command-timeout 15s \
        --output none
    }
    expect_denied() {
      label=$1
      shift
      error_file="/tmp/${label}.error"
      if "$@" >"${error_file}" 2>&1; then
        echo "authorization probe unexpectedly succeeded: ${label}" >&2
        exit 1
      fi
      if ! grep -Eiq "permission.?denied|not authorized|unauthorized|unauthenticated" "${error_file}"; then
        echo "authorization probe failed without PERMISSION_DENIED: ${label}" >&2
        head -c 2048 "${error_file}" |
          tr "\r\n" "  " |
          sed -E "s/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/[redacted-jws]/g" >&2
        echo >&2
        exit 1
      fi
      echo "PERMISSION_DENIED ${label}"
    }

    expect_denied no-token \
      base schedule describe \
        --namespace "platform-automation" --schedule-id "${schedule_id}"

    reader_cli schedule describe \
      --namespace "platform-automation" --schedule-id "${schedule_id}"
    reader_cli workflow describe \
      --namespace "platform-automation" \
      --workflow-id "${workflow_id}" --run-id "${run_id}"
    reader_cli workflow show \
      --namespace "platform-automation" \
      --workflow-id "${workflow_id}" --run-id "${run_id}"

    expect_denied reader-write-denied \
      reader_cli schedule trigger \
        --namespace "platform-automation" --schedule-id "${schedule_id}"
    expect_denied reader-cross-namespace-denied \
      reader_cli schedule list --namespace "platform-automation-denied"
  ' -- \
  "${READER_TOKEN_FILE}" \
  "${TEMPORAL_PLATFORM_PROOF_SCHEDULE_ID}" \
  "${TEMPORAL_PLATFORM_PROOF_WORKFLOW_ID}" \
  "${TEMPORAL_PLATFORM_PROOF_RUN_ID}"

echo "independent Temporal read-only authorization matrix passed"
