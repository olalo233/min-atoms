#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
parse_dry_run "$@"
inputs=(apps/manager packages templates/fullstack infra/image infra/gateway infra/vm package.json bun.lock)
if ! "$DRY_RUN"; then
  require_owned_vm
  for input in "${inputs[@]}"; do [[ -e "$MA_ROOT/$input" ]] || die "Missing deploy input: $input"; done
  require_private_inputs
fi
# No credentials or local engineering material belong in the source archive.
tar_args=(-C "$MA_ROOT" --exclude=node_modules --exclude=.git --exclude=.jj --exclude=.env --exclude='.env.*' --exclude=AGENTS.md --exclude=.agents --exclude=.codex --exclude=CONTEXT.md -czf -)
# templates/fullstack/AGENTS.md is explicitly included as a runtime asset below.
if "$DRY_RUN"; then
  print_command tar "${tar_args[@]}" "${inputs[@]}"
  print_command tar -C "$MA_ROOT" -czf - templates/fullstack/AGENTS.md
  remote 'sudo tar -xzf - -C /opt/min-atoms'
  printf 'Source archive and runtime AGENTS.md archive piped separately to SSH stdin.\n'
else
  tar "${tar_args[@]}" "${inputs[@]}" | remote 'sudo tar -xzf - -C /opt/min-atoms'
  tar -C "$MA_ROOT" -czf - templates/fullstack/AGENTS.md | remote 'sudo tar -xzf - -C /opt/min-atoms'
fi
upload_private_env
remote "sudo bash -c 'cd /opt/min-atoms && bun install --frozen-lockfile --filter ./apps/manager && docker build -f infra/image/Dockerfile -t min-atoms/project . && systemctl restart ma-firewall.service ma-gateway.service ma-manager.service'"
wait_health
