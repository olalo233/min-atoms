#!/usr/bin/env bash
set -euo pipefail
cd /opt/min-atoms
# Manager must bind 127.0.0.1:8090; use the health stub until T01 is deployed.
export HOST=127.0.0.1 PORT=8090
if [[ -f apps/manager/src/index.ts ]]; then
  exec /usr/local/bin/bun apps/manager/src/index.ts
fi
exec /usr/local/bin/bun infra/vm/health-stub.ts
