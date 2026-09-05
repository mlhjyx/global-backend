#!/bin/bash
set -euo pipefail
export COMPOSE_IGNORE_ORPHANS=true

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PLATFORM_DIR=$(cd -- "${SCRIPT_DIR}/.." && pwd)
REPOSITORY_ROOT=$(cd -- "${PLATFORM_DIR}/../.." && pwd)
COMPOSE_FILE=${SCRIPT_DIR}/compose.disposable.yml
AUDIENCE=global-backend:platform-temporal-test
RUN_ID=${TEMPORAL_PLATFORM_TEST_RUN_ID:-$(openssl rand -hex 8)}
if [[ ! ${RUN_ID} =~ ^[a-z0-9]{8,32}$ ]]; then
  echo "disposable run id is invalid" >&2
  exit 1
fi

FIXTURE_DIRECTORY=$(mktemp -d "/tmp/codex-task4c-platform-temporal-${RUN_ID}.XXXXXX")
case "${FIXTURE_DIRECTORY}" in
  /tmp/codex-task4c-platform-temporal-${RUN_ID}.*) ;;
  *)
    echo "disposable fixture directory is invalid" >&2
    exit 1
    ;;
esac
AUTHORITY_DIRECTORY=${FIXTURE_DIRECTORY}/authority
SERVER_SECRET_DIRECTORY=${FIXTURE_DIRECTORY}/server
JWKS_DIRECTORY=${FIXTURE_DIRECTORY}/jwks
JWKS_TLS_DIRECTORY=${FIXTURE_DIRECTORY}/jwks-tls
CLIENT_SECRET_DIRECTORY=${FIXTURE_DIRECTORY}/client
NODE_OVERLAY_DIRECTORY=${FIXTURE_DIRECTORY}/node-overlay
mkdir -m 0700 \
  "${AUTHORITY_DIRECTORY}" \
  "${SERVER_SECRET_DIRECTORY}" \
  "${JWKS_DIRECTORY}" \
  "${JWKS_TLS_DIRECTORY}" \
  "${CLIENT_SECRET_DIRECTORY}" \
  "${NODE_OVERLAY_DIRECTORY}"

if [[ $(id -u) -eq 0 ]]; then
  TEST_UID=1000
  TEST_GID=1000
else
  TEST_UID=$(id -u)
  TEST_GID=$(id -g)
fi

export TEMPORAL_PLATFORM_TEST_RUN_ID=${RUN_ID}
export TEMPORAL_PLATFORM_TEST_SERVER_SECRET_DIRECTORY=${SERVER_SECRET_DIRECTORY}
export TEMPORAL_PLATFORM_TEST_JWKS_DIRECTORY=${JWKS_DIRECTORY}
export TEMPORAL_PLATFORM_TEST_JWKS_TLS_DIRECTORY=${JWKS_TLS_DIRECTORY}
export TEMPORAL_PLATFORM_TEST_CLIENT_SECRET_DIRECTORY=${CLIENT_SECRET_DIRECTORY}
export TEMPORAL_PLATFORM_TEST_NODE_OVERLAY_DIRECTORY=${NODE_OVERLAY_DIRECTORY}
export TEMPORAL_PLATFORM_TEST_REPOSITORY_ROOT=${REPOSITORY_ROOT}
export TEMPORAL_PLATFORM_TEST_UID=${TEST_UID}
export TEMPORAL_PLATFORM_TEST_GID=${TEST_GID}
export TEMPORAL_PLATFORM_POSTGRES_PASSWORD
TEMPORAL_PLATFORM_POSTGRES_PASSWORD=$(openssl rand -hex 24)
export TEMPORAL_PLATFORM_JWT_AUDIENCE=${AUDIENCE}
export TEMPORAL_PLATFORM_CLIENT_SECRET_DIRECTORY=${CLIENT_SECRET_DIRECTORY}
export TEMPORAL_PLATFORM_ADMIN_SERVICE=codex-task4c-platform-temporal-admin
export TEMPORAL_PLATFORM_SERVER_SERVICE=codex-task4c-platform-temporal-server
export TEMPORAL_PLATFORM_COMPOSE_FILE=${COMPOSE_FILE}

compose=(docker compose -p global -f "${COMPOSE_FILE}")
cleanup() {
  exit_status=$?
  set +e
  if (( exit_status != 0 )) &&
    docker container inspect \
      "codex-task4c-platform-temporal-${RUN_ID}-jwks" >/dev/null 2>&1; then
    echo "bounded disposable JWKS diagnostics:" >&2
    docker container inspect \
      --format '{{json .State.Health}}' \
      "codex-task4c-platform-temporal-${RUN_ID}-jwks" >&2
    docker logs --tail 80 \
      "codex-task4c-platform-temporal-${RUN_ID}-jwks" >&2
  fi
  if (( exit_status != 0 )) &&
    docker container inspect \
      "codex-task4c-platform-temporal-${RUN_ID}-schema" >/dev/null 2>&1; then
    echo "bounded disposable schema diagnostics:" >&2
    docker logs --tail 120 \
      "codex-task4c-platform-temporal-${RUN_ID}-schema" >&2
  fi
  if (( exit_status != 0 )) &&
    docker container inspect \
      "codex-task4c-platform-temporal-${RUN_ID}-server" >/dev/null 2>&1; then
    echo "bounded disposable Temporal server diagnostics:" >&2
    docker logs --tail 200 \
      "codex-task4c-platform-temporal-${RUN_ID}-server" >&2
  fi
  "${compose[@]}" rm -sf \
    codex-task4c-platform-temporal-worker-probe \
    codex-task4c-platform-temporal-admin \
    codex-task4c-platform-temporal-server \
    codex-task4c-platform-temporal-jwks \
    codex-task4c-platform-temporal-schema \
    codex-task4c-platform-temporal-postgres >/dev/null 2>&1
  docker volume rm \
    "codex-task4c-platform-temporal-${RUN_ID}-postgres-data" >/dev/null 2>&1
  docker network rm \
    "codex-task4c-platform-temporal-${RUN_ID}-network" >/dev/null 2>&1
  rm -rf -- "${FIXTURE_DIRECTORY}"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj "/CN=Task4C Disposable Temporal CA" \
  -keyout "${AUTHORITY_DIRECTORY}/ca.key" \
  -out "${AUTHORITY_DIRECTORY}/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -sha256 -nodes \
  -subj "/CN=task4c-temporal" \
  -addext "subjectAltName=DNS:task4c-temporal,DNS:task4c-jwks,DNS:temporal-platform" \
  -keyout "${AUTHORITY_DIRECTORY}/server.key" \
  -out "${AUTHORITY_DIRECTORY}/server.csr" >/dev/null 2>&1
openssl x509 -req -sha256 -days 1 \
  -in "${AUTHORITY_DIRECTORY}/server.csr" \
  -CA "${AUTHORITY_DIRECTORY}/ca.crt" \
  -CAkey "${AUTHORITY_DIRECTORY}/ca.key" \
  -CAcreateserial -copy_extensions copy \
  -out "${AUTHORITY_DIRECTORY}/server.crt" >/dev/null 2>&1
cp "${AUTHORITY_DIRECTORY}/server.crt" \
  "${AUTHORITY_DIRECTORY}/server.key" \
  "${SERVER_SECRET_DIRECTORY}/"
cp "${AUTHORITY_DIRECTORY}/ca.crt" \
  "${SERVER_SECRET_DIRECTORY}/ca.crt"
cp "${AUTHORITY_DIRECTORY}/ca.crt" \
  "${SERVER_SECRET_DIRECTORY}/jwks-ca-bundle.crt"
cp "${AUTHORITY_DIRECTORY}/server.crt" \
  "${AUTHORITY_DIRECTORY}/server.key" \
  "${JWKS_TLS_DIRECTORY}/"
cp "${AUTHORITY_DIRECTORY}/ca.crt" \
  "${CLIENT_SECRET_DIRECTORY}/ca.crt"
node "${SCRIPT_DIR}/generate-fixtures.mjs" \
  "${JWKS_DIRECTORY}" "${CLIENT_SECRET_DIRECTORY}" "${AUDIENCE}" >/dev/null
for package_name in client common proto; do
  package_source=${REPOSITORY_ROOT}/node_modules/.pnpm/@temporalio+${package_name}@1.20.3/node_modules/@temporalio/${package_name}
  if [[ ! -d ${package_source} || -L ${package_source} ]] ||
    ! jq -e --arg name "@temporalio/${package_name}" \
      '.name == $name and .version == "1.20.3"' \
      "${package_source}/package.json" >/dev/null; then
    echo "Temporal SDK package does not match the frozen 1.20.3 install" >&2
    exit 1
  fi
  mkdir -m 0700 "${NODE_OVERLAY_DIRECTORY}/${package_name}"
  cp -R --no-preserve=mode,ownership \
    "${package_source}/." "${NODE_OVERLAY_DIRECTORY}/${package_name}/"
done
find "${NODE_OVERLAY_DIRECTORY}" -type d -exec chmod 0755 {} +
find "${NODE_OVERLAY_DIRECTORY}" -type f -exec chmod 0644 {} +
chmod 0700 \
  "${FIXTURE_DIRECTORY}" \
  "${AUTHORITY_DIRECTORY}" \
  "${SERVER_SECRET_DIRECTORY}" \
  "${JWKS_DIRECTORY}" \
  "${JWKS_TLS_DIRECTORY}" \
  "${CLIENT_SECRET_DIRECTORY}"
chmod 0600 \
  "${AUTHORITY_DIRECTORY}"/*.key \
  "${SERVER_SECRET_DIRECTORY}"/*.key \
  "${JWKS_TLS_DIRECTORY}"/*.key \
  "${CLIENT_SECRET_DIRECTORY}"/*.jwt
chmod 0644 \
  "${SERVER_SECRET_DIRECTORY}"/*.crt \
  "${JWKS_TLS_DIRECTORY}"/*.crt \
  "${JWKS_DIRECTORY}/jwks.json" \
  "${CLIENT_SECRET_DIRECTORY}/ca.crt"
if [[ $(id -u) -eq 0 ]]; then
  chown -R "${TEST_UID}:${TEST_GID}" "${FIXTURE_DIRECTORY}"
fi

"${compose[@]}" config --quiet
"${PLATFORM_DIR}/provision.sh"
"${PLATFORM_DIR}/provision.sh"

SCHEDULE_ID=task4c-proof-${RUN_ID}
WORKFLOW_ID=task4c-proof-workflow-${RUN_ID}
TASK_QUEUE=task4c-proof-queue
ACTION_INPUT=$(printf \
  '{"executionContractVersion":1,"executionScope":{"purpose":"platform.acquisition","requestSha256":"%064d","scheduleId":"%s","subjectId":"%s","subjectType":"schedule"}}' \
  0 "${SCHEDULE_ID}" "${SCHEDULE_ID}")
if (( ${#ACTION_INPUT} > 4096 )); then
  echo "disposable Schedule input exceeds 4 KiB" >&2
  exit 1
fi

"${compose[@]}" run --rm --no-deps --entrypoint /bin/sh \
  codex-task4c-platform-temporal-admin -eu -c '
    token=$(cat "$1")
    shift
    temporal schedule create \
      --namespace "platform-automation" \
      --schedule-id "$1" \
      --interval 24h \
      --paused \
      --workflow-id "$2" \
      --task-queue "$3" \
      --type "PlatformAutomationProofWorkflow" \
      --input "$4" \
      --address "${TEMPORAL_PLATFORM_ADDRESS}" \
      --tls \
      --tls-ca-path /run/secrets/temporal-platform-client/ca.crt \
      --tls-server-name "${TEMPORAL_PLATFORM_TLS_SERVER_NAME}" \
      --api-key "${token}" \
      --command-timeout 15s \
      --output none
    temporal schedule trigger \
      --namespace "platform-automation" \
      --schedule-id "$1" \
      --address "${TEMPORAL_PLATFORM_ADDRESS}" \
      --tls \
      --tls-ca-path /run/secrets/temporal-platform-client/ca.crt \
      --tls-server-name "${TEMPORAL_PLATFORM_TLS_SERVER_NAME}" \
      --api-key "${token}" \
      --command-timeout 15s \
      --output none
  ' -- \
  /run/secrets/temporal-platform-client/writer.jwt \
  "${SCHEDULE_ID}" "${WORKFLOW_ID}" "${TASK_QUEUE}" "${ACTION_INPUT}"

SCHEDULE_JSON=$(
  "${compose[@]}" run --rm --no-deps --entrypoint /bin/sh \
    codex-task4c-platform-temporal-admin -eu -c '
      token=$(cat "$1")
      attempt=0
      while [ "${attempt}" -lt 30 ]; do
        attempt=$((attempt + 1))
        if temporal schedule describe \
          --namespace "platform-automation" --schedule-id "$2" \
          --address "${TEMPORAL_PLATFORM_ADDRESS}" \
          --tls \
          --tls-ca-path /run/secrets/temporal-platform-client/ca.crt \
          --tls-server-name "${TEMPORAL_PLATFORM_TLS_SERVER_NAME}" \
          --api-key "${token}" \
          --command-timeout 15s \
          --output json > /tmp/schedule.json 2>/tmp/schedule.error &&
          grep -q '"runId"' /tmp/schedule.json; then
          cat /tmp/schedule.json
          exit 0
        fi
        sleep 1
      done
      echo "triggered Schedule did not expose a recent action" >&2
      exit 1
    ' -- /run/secrets/temporal-platform-client/writer.jwt "${SCHEDULE_ID}"
)
ACTION_WORKFLOW_ID=$(printf '%s' "${SCHEDULE_JSON}" |
  jq -er 'first(.. | objects | select((.workflowId? | type) == "string" and (.runId? | type) == "string")) | .workflowId')
WORKFLOW_RUN_ID=$(printf '%s' "${SCHEDULE_JSON}" |
  jq -er 'first(.. | objects | select((.workflowId? | type) == "string" and (.runId? | type) == "string")) | .runId')
case "${ACTION_WORKFLOW_ID}" in
  ${WORKFLOW_ID}*) ;;
  *)
    echo "Schedule action Workflow id is not derived from the admitted base id" >&2
    exit 1
    ;;
esac
if [[ ! ${WORKFLOW_RUN_ID} =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "disposable Workflow run id is invalid" >&2
  exit 1
fi

export TEMPORAL_PLATFORM_READER_TOKEN_FILE=/run/secrets/temporal-platform-client/reader.jwt
export TEMPORAL_PLATFORM_PROOF_SCHEDULE_ID=${SCHEDULE_ID}
export TEMPORAL_PLATFORM_PROOF_WORKFLOW_ID=${ACTION_WORKFLOW_ID}
export TEMPORAL_PLATFORM_PROOF_RUN_ID=${WORKFLOW_RUN_ID}
"${PLATFORM_DIR}/verify.sh"

"${compose[@]}" run --rm --no-deps --entrypoint node \
  codex-task4c-platform-temporal-worker-probe \
  /repo/infra/temporal-platform/test-support/worker-poll-probe.mjs \
  /repo \
  /run/secrets/temporal-platform-client/worker.jwt \
  /run/secrets/temporal-platform-client/ca.crt \
  task4c-temporal:7233 task4c-temporal \
  platform-automation "${TASK_QUEUE}"

"${compose[@]}" run --rm --no-deps --entrypoint /bin/sh \
  codex-task4c-platform-temporal-admin -eu -c '
    expect_denied() {
      token_file=$1
      label=$2
      shift 2
      token=$(cat "${token_file}")
      error_file="/tmp/${label}.error"
      if temporal "$@" \
        --address "${TEMPORAL_PLATFORM_ADDRESS}" \
        --tls \
        --tls-ca-path /run/secrets/temporal-platform-client/ca.crt \
        --tls-server-name "${TEMPORAL_PLATFORM_TLS_SERVER_NAME}" \
        --api-key "${token}" \
        --command-timeout 15s \
        --output none >"${error_file}" 2>&1; then
        echo "role separation probe unexpectedly succeeded: ${label}" >&2
        exit 1
      fi
      grep -Eiq "permission.?denied|not authorized|unauthorized|unauthenticated|audience mismatch" "${error_file}" || {
        echo "role separation probe did not fail by authorization: ${label}" >&2
        exit 1
      }
      echo "PERMISSION_DENIED ${label}"
    }
    expect_denied \
      /run/secrets/temporal-platform-client/worker.jwt worker-cross-namespace-denied \
      workflow start \
        --namespace "platform-automation-denied" \
        --workflow-id "task4c-worker-cross-namespace-$2" \
        --task-queue "task4c-worker-cross-namespace" \
        --type "PlatformAutomationProofWorkflow"
    expect_denied \
      /run/secrets/temporal-platform-client/worker.jwt worker-admin-denied \
      operator namespace create \
        --namespace "task4c-worker-must-not-admin-$2" --retention 1d
    expect_denied \
      /run/secrets/temporal-platform-client/wrong-audience.jwt wrong-audience \
      schedule describe --namespace platform-automation --schedule-id "$1"
    expect_denied \
      /run/secrets/temporal-platform-client/writer.jwt writer-admin-denied \
      operator namespace create \
        --namespace "task4c-writer-must-not-admin-$2" --retention 1d
  ' -- "${SCHEDULE_ID}" "${RUN_ID}"

echo "disposable platform Temporal TLS/JWT/native-authorizer proof passed"
