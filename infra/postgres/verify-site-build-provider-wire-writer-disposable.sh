#!/usr/bin/env bash
set -euo pipefail

if [[ "${SITE_BUILD_PROVIDER_WIRE_DISPOSABLE_TEST:-}" != "1" ]]; then
  echo "provider-wire disposable verification requires SITE_BUILD_PROVIDER_WIRE_DISPOSABLE_TEST=1" >&2
  exit 1
fi

bash infra/postgres/provision-site-build-provider-wire-writer.sh >/dev/null
bash infra/postgres/provision-site-build-provider-wire-writer.sh >/dev/null
bash infra/postgres/verify-site-build-provider-wire-writer.sh >/dev/null

admin_connection="$(VALUE="${SITE_BUILD_PROVIDER_WIRE_PROVISION_DATABASE_URL}" node - <<'NODE'
let url;
try { url = new URL(process.env.VALUE); } catch { process.exit(1); }
if (!url.hostname || !url.username || !url.password || !/^\/[A-Za-z0-9_.-]+$/.test(url.pathname) || url.search || url.hash) process.exit(1);
for (const [name, value] of Object.entries({ PGHOST:url.hostname, PGPORT:url.port||'5432', PGDATABASE:decodeURIComponent(url.pathname.slice(1)), PGUSER:decodeURIComponent(url.username), PGPASSWORD:decodeURIComponent(url.password) })) {
  if (!value || /[\0\r\n]/.test(value)) process.exit(1);
  process.stdout.write(`${name}=${value}\n`);
}
NODE
)" || { echo "provider-wire disposable admin URL invalid" >&2; exit 1; }
while IFS= read -r setting; do export "${setting}"; done <<< "${admin_connection}"

restore() {
  psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet \
    --set provider_wire_login="${SITE_BUILD_PROVIDER_WIRE_LOGIN}" <<'SQL' >/dev/null
SELECT format('REVOKE runtime_api FROM %I', :'provider_wire_login') \gexec
SELECT format('REVOKE ADMIN OPTION FOR app_user FROM %I', :'provider_wire_login') \gexec
SELECT format('GRANT runtime_worker TO %I WITH INHERIT TRUE', :'provider_wire_login') \gexec
SQL
}
trap restore EXIT

psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet \
  --set provider_wire_login="${SITE_BUILD_PROVIDER_WIRE_LOGIN}" <<'SQL' >/dev/null
SELECT format('GRANT runtime_api TO %I', :'provider_wire_login') \gexec
SQL
if bash infra/postgres/verify-site-build-provider-wire-writer.sh >/dev/null 2>&1; then
  echo "DRIFT_NOT_REJECTED" >&2
  exit 1
fi
restore
bash infra/postgres/verify-site-build-provider-wire-writer.sh >/dev/null

psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet \
  --set provider_wire_login="${SITE_BUILD_PROVIDER_WIRE_LOGIN}" <<'SQL' >/dev/null
SELECT format('GRANT app_user TO %I WITH ADMIN OPTION', :'provider_wire_login') \gexec
SQL
if bash infra/postgres/verify-site-build-provider-wire-writer.sh >/dev/null 2>&1; then
  echo "ADMIN_OPTION_DRIFT_NOT_REJECTED" >&2
  exit 1
fi
restore
bash infra/postgres/verify-site-build-provider-wire-writer.sh >/dev/null

psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet \
  --set provider_wire_login="${SITE_BUILD_PROVIDER_WIRE_LOGIN}" <<'SQL' >/dev/null
SELECT format('GRANT runtime_worker TO %I WITH INHERIT FALSE', :'provider_wire_login') \gexec
SQL
if bash infra/postgres/verify-site-build-provider-wire-writer.sh >/dev/null 2>&1; then
  echo "INHERIT_OPTION_DRIFT_NOT_REJECTED" >&2
  exit 1
fi
restore
trap - EXIT
bash infra/postgres/verify-site-build-provider-wire-writer.sh >/dev/null

echo "provider-wire writer disposable drift and idempotence verified"
