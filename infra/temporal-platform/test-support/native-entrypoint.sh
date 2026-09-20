#!/bin/sh
set -eu

# Disposable-only selector. The managed production image has one native binary;
# this harness keeps the stock image available for baseline tests while allowing
# a separately built, digest-recorded binary to be mounted for the real server
# authorization probe. An absent binary always uses the baseline path.
if [ -x /run/native-server/temporal-server ]; then
  exec /run/native-server/temporal-server start
fi
exec /etc/temporal/entrypoint.sh
