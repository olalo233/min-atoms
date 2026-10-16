#!/usr/bin/env bash
# Shared by bootstrap and deploy so restored older disks also gain the timer.
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
parse_dry_run "$@"
if ! "$DRY_RUN"; then [[ $EUID == 0 ]] || die 'Run as root on the VM.'; fi
for unit in ma-idle.service ma-idle.timer; do
  run install -m 0644 "$MA_ROOT/infra/vm/$unit" "/etc/systemd/system/$unit"
done
run systemctl daemon-reload
run systemctl enable --now ma-idle.timer
