#!/bin/bash
set -euo pipefail
export COMPOSE_IGNORE_ORPHANS=true
command -v node >/dev/null || { echo "Node is required for namespace contract validation" >&2; exit 1; }

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_FILE=${TEMPORAL_PLATFORM_COMPOSE_FILE:-${SCRIPT_DIR}/compose.yml}
ADMIN_SERVICE=${TEMPORAL_PLATFORM_ADMIN_SERVICE:-temporal-platform-admin}
SERVER_SERVICE=${TEMPORAL_PLATFORM_SERVER_SERVICE:-temporal-platform}
CLIENT_SECRET_DIRECTORY=${TEMPORAL_PLATFORM_CLIENT_SECRET_DIRECTORY:?TEMPORAL_PLATFORM_CLIENT_SECRET_DIRECTORY is required}
ADMIN_TOKEN_FILE=${TEMPORAL_PLATFORM_ADMIN_TOKEN_FILE:-/run/secrets/temporal-platform-client/admin.jwt}

case "${ADMIN_SERVICE}:${SERVER_SERVICE}" in
  *[!A-Za-z0-9_.:-]*)
    echo "Temporal Compose service name is invalid" >&2
    exit 1
    ;;
esac
case "${ADMIN_TOKEN_FILE}" in
  /run/secrets/temporal-platform-client/*.jwt) ;;
  *)
    echo "Temporal admin token must use the dedicated client secret mount" >&2
    exit 1
    ;;
esac

HOST_ADMIN_TOKEN=${CLIENT_SECRET_DIRECTORY}/${ADMIN_TOKEN_FILE##*/}
if [[ ! -f "${HOST_ADMIN_TOKEN}" || -L "${HOST_ADMIN_TOKEN}" ]]; then
  echo "Temporal admin token file is unavailable" >&2
  exit 1
fi
if [[ $(stat -c '%a' "${HOST_ADMIN_TOKEN}") != 600 ]] ||
  (( $(stat -c '%s' "${HOST_ADMIN_TOKEN}") < 32 )) ||
  (( $(stat -c '%s' "${HOST_ADMIN_TOKEN}") > 16384 )); then
  echo "Temporal admin token file mode or size is invalid" >&2
  exit 1
fi

compose=(docker compose -p global -f "${COMPOSE_FILE}")
"${compose[@]}" --profile platform-temporal up -d --wait --wait-timeout 180 "${SERVER_SERVICE}"

"${compose[@]}" --profile platform-temporal-tools run --rm --no-deps \
  --entrypoint /bin/sh "${ADMIN_SERVICE}" -eu -c '
    token_file=$1
    token=$(cat "${token_file}")
    case "${token}" in
      *[!A-Za-z0-9._-]*|*.*.*.*|.*|*.)
        echo "Temporal admin token format is invalid" >&2
        exit 1
        ;;
    esac
    first_segment=${token%%.*}
    remainder=${token#*.}
    second_segment=${remainder%%.*}
    third_segment=${remainder#*.}
    if [ "${remainder}" = "${token}" ] ||
      [ "${third_segment}" = "${remainder}" ] ||
      [ -z "${first_segment}" ] || [ -z "${second_segment}" ] ||
      [ -z "${third_segment}" ]; then
      echo "Temporal admin token format is invalid" >&2
      exit 1
    fi
    cli() {
      temporal "$@" \
        --address "${TEMPORAL_PLATFORM_ADDRESS}" \
        --tls \
        --tls-ca-path /run/secrets/temporal-platform-client/ca.crt \
        --tls-server-name "${TEMPORAL_PLATFORM_TLS_SERVER_NAME}" \
        --api-key "${token}" \
        --command-timeout 15s \
        --output json
    }
    error_file=/tmp/namespace-describe.error
    if cli operator namespace describe --namespace "platform-automation" >/tmp/namespace-describe.json 2>"${error_file}"; then
      cat /tmp/namespace-describe.json
      exit 0
    fi
    if ! grep -Eiq "namespace.*not found|not found.*namespace" "${error_file}"; then
      echo "Temporal namespace admission could not prove absence" >&2
      head -c 2048 "${error_file}" |
        tr "\r\n" "  " |
        sed -E "s/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/[redacted-jws]/g" >&2
      echo >&2
      exit 1
    fi
    cli operator namespace create \
      --namespace "platform-automation" \
      --retention 7d \
      --data platform_non_tenant=true \
      --data platform_contract=1 \
      --description "Dedicated non-tenant platform automation workflows"
    cli operator namespace describe --namespace "platform-automation"
  ' -- "${ADMIN_TOKEN_FILE}" | node "${SCRIPT_DIR}/namespace-contract.mjs"

echo "platform-automation namespace is provisioned; authorization verification remains a separate gate"
