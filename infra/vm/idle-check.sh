#!/usr/bin/env bash
# Invoked by ma-idle.timer on the VM; uncertainty always leaves it running.
set -euo pipefail
[[ $EUID == 0 ]] || { printf 'Run as root on the VM.\n' >&2; exit 1; }
threshold=${MA_IDLE_SHUTDOWN_SECONDS:-1800}
[[ $threshold != 0 ]] || exit 0
body=$(curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8090/health) || exit 0
if bun -e '
  const threshold = Number(Bun.argv[1]);
  const health = await Bun.stdin.json();
  process.exit(Number.isSafeInteger(threshold) && threshold > 0 && health?.ok === true &&
    Number.isSafeInteger(health.idleSeconds) && health.idleSeconds >= threshold ? 0 : 1);
' "$threshold" <<< "$body" 2>/dev/null; then
  printf 'min-atoms idle for at least %s seconds; powering off.\n' "$threshold"
  systemctl poweroff
fi
