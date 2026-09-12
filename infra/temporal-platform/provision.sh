#!/bin/bash
set -euo pipefail
umask 077
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPOSITORY_ROOT=$(cd -- "${SCRIPT_DIR}/../.." && pwd)
: "${TEMPORAL_PLATFORM_NATIVE_IMAGE:?TEMPORAL_PLATFORM_NATIVE_IMAGE is required}"
: "${TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA:?TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA is required}"
: "${TEMPORAL_PLATFORM_READER_SUBJECT:?TEMPORAL_PLATFORM_READER_SUBJECT is required}"
if [[ -n ${TEMPORAL_PLATFORM_COMPOSE_FILE:-} ||
      ${TEMPORAL_PLATFORM_ADMIN_SERVICE:-temporal-platform-admin} != temporal-platform-admin ||
      ${TEMPORAL_PLATFORM_SERVER_SERVICE:-temporal-platform} != temporal-platform ]]; then
  echo "TEMPORAL_NATIVE_RETAINED_INPUT_INVALID" >&2
  exit 1
fi
node "${REPOSITORY_ROOT}/scripts/temporal-native-publication.mjs" identity \
  "${TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA}" "${TEMPORAL_PLATFORM_NATIVE_IMAGE}" "${TEMPORAL_PLATFORM_READER_SUBJECT}"
native_tmp=$(mktemp -d "${TMPDIR:-/var/tmp}/temporal-native-preflight.XXXXXX")
cleanup() {
  result=$?
  trap - EXIT
  case "${native_tmp##*/}" in temporal-native-preflight.*) ;; *) exit 1 ;; esac
  [[ -d "${native_tmp}" && ! -L "${native_tmp}" ]] || exit 1
  rm -rf -- "${native_tmp}"
  exit "${result}"
}
trap cleanup EXIT
# Rendered JSON contains deployment secrets: private temporary path, never stdout.
if ! docker compose -p global -f "${SCRIPT_DIR}/compose.yml" -f "${SCRIPT_DIR}/compose.native.yml" \
  --profile platform-temporal config --format json > "${native_tmp}/compose.json" 2> "${native_tmp}/render.error"; then
  echo "TEMPORAL_NATIVE_COMPOSE_UNAVAILABLE" >&2
  exit 1
fi
node "${REPOSITORY_ROOT}/scripts/temporal-native-publication.mjs" compose "${native_tmp}/compose.json" \
  "${REPOSITORY_ROOT}" "${TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA}" "${TEMPORAL_PLATFORM_NATIVE_IMAGE}" "${TEMPORAL_PLATFORM_READER_SUBJECT}"
# Local-only immutable image capture: no pull and the temporary container is never started.
node "${REPOSITORY_ROOT}/scripts/temporal-native-publication.mjs" capture "${REPOSITORY_ROOT}" \
  "${TEMPORAL_PLATFORM_NATIVE_SOURCE_SHA}" "${TEMPORAL_PLATFORM_NATIVE_IMAGE}" "${native_tmp}/image"
source "${SCRIPT_DIR}/provision-core.sh"
provision_platform_namespace temporal-platform-admin temporal-platform \
  -f "${SCRIPT_DIR}/compose.yml" -f "${SCRIPT_DIR}/compose.native.yml"
