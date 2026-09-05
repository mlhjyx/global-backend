#!/bin/bash
set -euo pipefail
export COMPOSE_IGNORE_ORPHANS=true

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PLATFORM_DIR=$(cd -- "${SCRIPT_DIR}/.." && pwd)
REPOSITORY_ROOT=$(cd -- "${PLATFORM_DIR}/../.." && pwd)
COMPOSE_FILE=${SCRIPT_DIR}/compose.disposable.yml
AUDIENCE=global-backend:platform-temporal-test
COMMON_GIT_DIRECTORY=$(git -C "${REPOSITORY_ROOT}" rev-parse --path-format=absolute --git-common-dir)
DEFAULT_LOCK_FILE=${COMMON_GIT_DIRECTORY}/codex-task4c-platform-temporal.lock
LOCK_FILE=${TEMPORAL_PLATFORM_TEST_LOCK_FILE:-${DEFAULT_LOCK_FILE}}
case "${LOCK_FILE}" in
  "${DEFAULT_LOCK_FILE}" | /tmp/codex-task4c-platform-temporal-lock-test.*/lifecycle.lock) ;;
  *)
    echo "platform Temporal disposable lock path is invalid" >&2
    exit 1
    ;;
esac
LOCK_DIRECTORY=$(dirname -- "${LOCK_FILE}")
if [[ ! -d ${LOCK_DIRECTORY} || -L ${LOCK_DIRECTORY} ]]; then
  echo "platform Temporal disposable lock directory is invalid" >&2
  exit 1
fi
exec {LIFECYCLE_LOCK_FD}>>"${LOCK_FILE}"
if ! flock -n "${LIFECYCLE_LOCK_FD}"; then
  echo "platform Temporal disposable lifecycle is busy" >&2
  exit 73
fi

RUN_ID=${TEMPORAL_PLATFORM_TEST_RUN_ID:-$(openssl rand -hex 8)}
if [[ ! ${RUN_ID} =~ ^[a-z0-9]{8,32}$ ]]; then
  echo "disposable run id is invalid" >&2
  exit 1
fi

CONTAINER_INVENTORY=$(docker container ls -a --format '{{.Names}}') || {
  echo "disposable container inventory is unavailable" >&2
  exit 1
}
VOLUME_INVENTORY=$(docker volume ls --format '{{.Name}}') || {
  echo "disposable volume inventory is unavailable" >&2
  exit 1
}
NETWORK_INVENTORY=$(docker network ls --format '{{.Name}}') || {
  echo "disposable network inventory is unavailable" >&2
  exit 1
}
if printf '%s\n%s\n%s\n' \
  "${CONTAINER_INVENTORY}" "${VOLUME_INVENTORY}" "${NETWORK_INVENTORY}" |
  grep -Eq '(^|-)codex-task4c-platform-temporal-'; then
  echo "stale platform Temporal disposable resources require manual review" >&2
  exit 74
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
  trap - EXIT
  set +e
  cleanup_status=0
  scope_label=io.growthos.task4c.scope
  run_label=io.growthos.task4c.run-id
  scope_value=platform-temporal-disposable

  container_owned() {
    metadata=$(docker container inspect --format \
      '{{index .Config.Labels "io.growthos.task4c.scope"}} {{index .Config.Labels "io.growthos.task4c.run-id"}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}' \
      "$1" 2>/dev/null) || return 1
    case "${metadata}" in
      "${scope_value} ${RUN_ID} global codex-task4c-platform-temporal-postgres" | \
        "${scope_value} ${RUN_ID} global codex-task4c-platform-temporal-schema" | \
        "${scope_value} ${RUN_ID} global codex-task4c-platform-temporal-jwks" | \
        "${scope_value} ${RUN_ID} global codex-task4c-platform-temporal-server" | \
        "${scope_value} ${RUN_ID} global codex-task4c-platform-temporal-admin" | \
        "${scope_value} ${RUN_ID} global codex-task4c-platform-temporal-worker-probe") return 0 ;;
      *) return 2 ;;
    esac
  }

  diagnose_owned_container() {
    name=$1
    lines=$2
    label=$3
    if container_owned "${name}"; then
      echo "bounded disposable ${label} diagnostics:" >&2
      docker logs --tail "${lines}" "${name}" >&2
    fi
  }

  if (( exit_status != 0 )); then
    diagnose_owned_container \
      "codex-task4c-platform-temporal-${RUN_ID}-jwks" 80 JWKS
    diagnose_owned_container \
      "codex-task4c-platform-temporal-${RUN_ID}-schema" 120 schema
    diagnose_owned_container \
      "codex-task4c-platform-temporal-${RUN_ID}-server" 200 "Temporal server"
  fi

  container_ids=$(docker container ls -aq \
    --filter "label=${scope_label}=${scope_value}" \
    --filter "label=${run_label}=${RUN_ID}") || cleanup_status=1
  for container_id in ${container_ids}; do
    if container_owned "${container_id}"; then
      docker container rm -f "${container_id}" >/dev/null 2>&1 || cleanup_status=1
    else
      echo "refusing to remove disposable container with mismatched labels" >&2
      cleanup_status=1
    fi
  done

  remaining_containers=$(docker container ls -aq \
    --filter "label=${scope_label}=${scope_value}" \
    --filter "label=${run_label}=${RUN_ID}") || cleanup_status=1
  if [[ -n ${remaining_containers} ]]; then
    echo "disposable containers remain after bounded cleanup" >&2
    cleanup_status=1
  fi
  for container_suffix in postgres schema jwks server admin worker-probe; do
    expected_name=codex-task4c-platform-temporal-${RUN_ID}-${container_suffix}
    if docker container inspect "${expected_name}" >/dev/null 2>&1; then
      echo "refusing mismatched disposable container left at expected name" >&2
      cleanup_status=1
    fi
  done

  volume_name=codex-task4c-platform-temporal-${RUN_ID}-postgres-data
  if volume_metadata=$(docker volume inspect --format \
    '{{index .Labels "io.growthos.task4c.scope"}} {{index .Labels "io.growthos.task4c.run-id"}} {{index .Labels "com.docker.compose.project"}}' \
    "${volume_name}" 2>/dev/null); then
    if [[ ${volume_metadata} == "${scope_value} ${RUN_ID} global" ]]; then
      docker volume rm "${volume_name}" >/dev/null 2>&1 || cleanup_status=1
    else
      echo "refusing to remove disposable volume with mismatched labels" >&2
      cleanup_status=1
    fi
  fi

  network_name=codex-task4c-platform-temporal-${RUN_ID}-network
  if network_metadata=$(docker network inspect --format \
    '{{index .Labels "io.growthos.task4c.scope"}} {{index .Labels "io.growthos.task4c.run-id"}} {{index .Labels "com.docker.compose.project"}}' \
    "${network_name}" 2>/dev/null); then
    if [[ ${network_metadata} == "${scope_value} ${RUN_ID} global" ]]; then
      docker network rm "${network_name}" >/dev/null 2>&1 || cleanup_status=1
    else
      echo "refusing to remove disposable network with mismatched labels" >&2
      cleanup_status=1
    fi
  fi

  rm -rf -- "${FIXTURE_DIRECTORY}"
  if (( exit_status != 0 )); then
    exit "${exit_status}"
  fi
  exit "${cleanup_status}"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj "/CN=Task4C Disposable Frontend CA" \
  -keyout "${AUTHORITY_DIRECTORY}/frontend-ca.key" \
  -out "${AUTHORITY_DIRECTORY}/frontend-ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -sha256 -nodes \
  -subj "/CN=task4c-temporal" \
  -addext "subjectAltName=DNS:task4c-temporal,DNS:temporal-platform" \
  -addext "extendedKeyUsage=serverAuth" \
  -keyout "${AUTHORITY_DIRECTORY}/frontend.key" \
  -out "${AUTHORITY_DIRECTORY}/frontend.csr" >/dev/null 2>&1
openssl x509 -req -sha256 -days 1 \
  -in "${AUTHORITY_DIRECTORY}/frontend.csr" \
  -CA "${AUTHORITY_DIRECTORY}/frontend-ca.crt" \
  -CAkey "${AUTHORITY_DIRECTORY}/frontend-ca.key" \
  -CAcreateserial -copy_extensions copy \
  -out "${AUTHORITY_DIRECTORY}/frontend.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -sha256 -nodes \
  -subj "/CN=task4c-jwks" \
  -addext "subjectAltName=DNS:task4c-jwks" \
  -addext "extendedKeyUsage=serverAuth" \
  -keyout "${AUTHORITY_DIRECTORY}/jwks.key" \
  -out "${AUTHORITY_DIRECTORY}/jwks.csr" >/dev/null 2>&1
openssl x509 -req -sha256 -days 1 \
  -in "${AUTHORITY_DIRECTORY}/jwks.csr" \
  -CA "${AUTHORITY_DIRECTORY}/frontend-ca.crt" \
  -CAkey "${AUTHORITY_DIRECTORY}/frontend-ca.key" \
  -CAserial "${AUTHORITY_DIRECTORY}/frontend-ca.srl" -copy_extensions copy \
  -out "${AUTHORITY_DIRECTORY}/jwks.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj "/CN=Task4C Disposable Internode CA" \
  -keyout "${AUTHORITY_DIRECTORY}/internode-ca.key" \
  -out "${AUTHORITY_DIRECTORY}/internode-ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -sha256 -nodes \
  -subj "/CN=task4c-temporal-internode" \
  -addext "subjectAltName=DNS:task4c-temporal,DNS:temporal-platform" \
  -addext "extendedKeyUsage=serverAuth,clientAuth" \
  -keyout "${AUTHORITY_DIRECTORY}/internode.key" \
  -out "${AUTHORITY_DIRECTORY}/internode.csr" >/dev/null 2>&1
openssl x509 -req -sha256 -days 1 \
  -in "${AUTHORITY_DIRECTORY}/internode.csr" \
  -CA "${AUTHORITY_DIRECTORY}/internode-ca.crt" \
  -CAkey "${AUTHORITY_DIRECTORY}/internode-ca.key" \
  -CAcreateserial -copy_extensions copy \
  -out "${AUTHORITY_DIRECTORY}/internode.crt" >/dev/null 2>&1
cp "${AUTHORITY_DIRECTORY}/frontend.crt" \
  "${AUTHORITY_DIRECTORY}/frontend.key" \
  "${AUTHORITY_DIRECTORY}/internode.crt" \
  "${AUTHORITY_DIRECTORY}/internode.key" \
  "${SERVER_SECRET_DIRECTORY}/"
cp "${AUTHORITY_DIRECTORY}/frontend-ca.crt" \
  "${SERVER_SECRET_DIRECTORY}/frontend-ca.crt"
cp "${AUTHORITY_DIRECTORY}/internode-ca.crt" \
  "${SERVER_SECRET_DIRECTORY}/internode-ca.crt"
cp "${AUTHORITY_DIRECTORY}/frontend-ca.crt" \
  "${SERVER_SECRET_DIRECTORY}/jwks-ca-bundle.crt"
cp "${AUTHORITY_DIRECTORY}/jwks.crt" \
  "${JWKS_TLS_DIRECTORY}/server.crt"
cp "${AUTHORITY_DIRECTORY}/jwks.key" \
  "${JWKS_TLS_DIRECTORY}/server.key"
cp "${AUTHORITY_DIRECTORY}/frontend-ca.crt" \
  "${CLIENT_SECRET_DIRECTORY}/ca.crt"
cp "${AUTHORITY_DIRECTORY}/internode-ca.crt" \
  "${CLIENT_SECRET_DIRECTORY}/internode-ca.crt"
node "${SCRIPT_DIR}/generate-fixtures.mjs" \
  "${JWKS_DIRECTORY}" "${CLIENT_SECRET_DIRECTORY}" "${AUDIENCE}" >/dev/null
if find "${CLIENT_SECRET_DIRECTORY}" -maxdepth 1 -type f \
  \( -name '*.key' -o -name 'internode.crt' \) -print -quit |
  grep -q .; then
  echo "ordinary client fixture contains an internode client credential" >&2
  exit 1
fi
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
  "${CLIENT_SECRET_DIRECTORY}"/*.crt
if [[ $(id -u) -eq 0 ]]; then
  chown -R "${TEST_UID}:${TEST_GID}" "${FIXTURE_DIRECTORY}"
fi

"${compose[@]}" config --quiet
"${PLATFORM_DIR}/provision.sh"
"${PLATFORM_DIR}/provision.sh"

change_namespace_fixture() {
  "${compose[@]}" run --rm --no-deps --entrypoint /bin/sh \
    codex-task4c-platform-temporal-admin -eu -c '
      token=$(cat /run/secrets/temporal-platform-client/admin.jwt)
      temporal operator namespace update --namespace platform-automation "$@" \
        --address "${TEMPORAL_PLATFORM_ADDRESS}" --tls \
        --tls-ca-path /run/secrets/temporal-platform-client/ca.crt \
        --tls-server-name "${TEMPORAL_PLATFORM_TLS_SERVER_NAME}" \
        --api-key "${token}" --command-timeout 15s --output none
    ' -- "$@"
}
assert_namespace_drift_rejected() {
  if "${PLATFORM_DIR}/provision.sh" >"${FIXTURE_DIRECTORY}/namespace-drift.log" 2>&1; then
    echo "namespace drift was accepted" >&2
    exit 1
  fi
  if ! grep -Fxq PLATFORM_TEMPORAL_NAMESPACE_DRIFT "${FIXTURE_DIRECTORY}/namespace-drift.log"; then
    echo "namespace drift did not fail with the expected contract reason" >&2
    exit 1
  fi
}
change_namespace_fixture --retention 1d
assert_namespace_drift_rejected
change_namespace_fixture --retention 7d
"${PLATFORM_DIR}/provision.sh"
change_namespace_fixture --data platform_non_tenant=false
assert_namespace_drift_rejected
change_namespace_fixture --data platform_non_tenant=true
"${PLATFORM_DIR}/provision.sh"
echo "namespace retention and ownership drift rejected"

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
  /repo/infra/temporal-platform/test-support/internal-mtls-probe.mjs \
  /run/secrets/temporal-platform-client/internode-ca.crt \
  task4c-temporal:7236 task4c-temporal

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
