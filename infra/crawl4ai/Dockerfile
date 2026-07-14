# Dev wrapper over the vendored Crawl4AI image.
#
# WHY: the bundled image ships a supervisord-managed Redis (an internal
# cache/queue — NOT our global-redis on :6379) started with compiled defaults,
# so its working dir is /app. /app is owned by root and read-only (mode 555) for
# the appuser (uid 999) the process runs as, so Redis's default RDB snapshot
# fails every few seconds with:
#   Failed opening the temp RDB file temp-*.rdb (in server root dir /app) ...
#   Permission denied / Background saving error
# Pure log noise — Redis serves from memory and /health stays 200 — but it
# floods the container log.
#
# FIX: this Redis is a cache/queue; dev does not need persistence. Append
# `--save "" --appendonly no` to ONLY the redis line in supervisord.conf so RDB
# and AOF are both off and nothing tries to write to the read-only /app.
#
# We patch a single line (not bind-mount the whole file) so gunicorn's
# security-relevant bind/auth config keeps inheriting from upstream :latest.
#
# DEV ONLY: prod runs Crawl4AI with its own persistence/ops posture — do not
# reuse this wrapper there.
FROM unclecode/crawl4ai:latest

# Build stage runs as root; patch the root-owned, read-only supervisord.conf.
# The trailing grep fails the build loudly if upstream ever renames the redis
# line so the patch can't silently become a no-op.
USER root
RUN sed -i 's|command=/usr/bin/redis-server |command=/usr/bin/redis-server --save "" --appendonly no |' /app/supervisord.conf \
    && grep -q 'redis-server --save "" --appendonly no ' /app/supervisord.conf

# Restore the non-root runtime user the base image expects.
USER appuser

# Fix (2026-07-15): upstream :latest 的 playwright 与内置 chromium 版本不匹配、缺 chromium-headless-shell。
# 显式装匹配浏览器到 appuser cache，一劳永逸修 unhealthy。
RUN python -m playwright install chromium chromium-headless-shell
