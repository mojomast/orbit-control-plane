#!/bin/sh
set -eu
mkdir -p "${ORBIT_CP_DATA:-/data}"
if [ "$(id -u)" = 0 ]; then
  chown -R node:node "${ORBIT_CP_DATA:-/data}"
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u node -- node --disable-warning=ExperimentalWarning /opt/orbit-control-plane/src/server.mjs
  fi
  if command -v su >/dev/null 2>&1; then
    exec su -s /bin/sh node -c 'exec node --disable-warning=ExperimentalWarning /opt/orbit-control-plane/src/server.mjs'
  fi
fi
exec node --disable-warning=ExperimentalWarning /opt/orbit-control-plane/src/server.mjs
