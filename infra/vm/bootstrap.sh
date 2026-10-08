#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
parse_dry_run "$@"
if ! "$DRY_RUN"; then
  require_owned_vm
  require_private_inputs
fi
remote 'sudo install -d -m 0755 /opt/min-atoms /etc/min-atoms /srv/min-atoms/projects'
# Send secrets on SSH stdin, never in command arguments, metadata or source archives.
upload_private_env
if "$DRY_RUN"; then
  print_command tar -C "$MA_ROOT" -czf - infra/vm infra/gateway
  remote 'sudo tar -xzf - -C /opt/min-atoms'
  printf '  archive piped to SSH stdin\n'
else
  tar -C "$MA_ROOT" -czf - infra/vm infra/gateway | remote 'sudo tar -xzf - -C /opt/min-atoms'
fi
remote 'sudo bash /opt/min-atoms/infra/vm/install-host.sh'
if "$DRY_RUN"; then bash "$MA_ROOT/infra/vm/install-host.sh" --dry-run; fi
wait_health
