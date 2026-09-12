#!/bin/bash
set -euo pipefail
PLATFORM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ${TEMPORAL_PLATFORM_COMPOSE_FILE:-} != "${PLATFORM_DIR}/test-support/compose.disposable.yml" ||
      ${TEMPORAL_PLATFORM_ADMIN_SERVICE:-} != codex-task4c-platform-temporal-admin ||
      ${TEMPORAL_PLATFORM_SERVER_SERVICE:-} != codex-task4c-platform-temporal-server ||
      ! ${TEMPORAL_PLATFORM_TEST_RUN_ID:-} =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; then
  echo "TEMPORAL_DISPOSABLE_PROVISION_INPUT_INVALID" >&2
  exit 1
fi
source "${PLATFORM_DIR}/provision-core.sh"
provision_platform_namespace codex-task4c-platform-temporal-admin codex-task4c-platform-temporal-server \
  -f "${PLATFORM_DIR}/test-support/compose.disposable.yml"
