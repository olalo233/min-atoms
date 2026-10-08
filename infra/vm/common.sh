#!/usr/bin/env bash
# Shared by the local PM scripts; never consult the active gcloud project.
set -euo pipefail
MA_PROJECT=hy2-seoul-relay-20260728
MA_ZONE=asia-northeast1-b
MA_VM=min-atoms-vm
export MA_DOMAIN=expii.top
export MA_ROOT
MA_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export MA_CONFIG=${HOME}/.config/min-atoms
DRY_RUN=false

die() { printf '%s\n' "$*" >&2; exit 1; }
print_command() { printf '+ '; printf '%q ' "$@"; printf '\n'; }
run() {
  if "$DRY_RUN"; then print_command "$@"; else "$@"; fi
}
remote() {
  run gcloud compute ssh "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" \
    --ssh-flag=-T --command="$1"
}
parse_dry_run() {
  for arg in "$@"; do
    case "$arg" in --dry-run) DRY_RUN=true ;; *) die "Unknown option: $arg" ;; esac
  done
}
require_private_inputs() {
  [[ -f "$MA_CONFIG/env" && -f "$MA_CONFIG/deepseek.key" ]] || die 'PM must prepare private env and deepseek.key files.'
  if grep -Eq '^[[:space:]]*DEEPSEEK_API_KEY[[:space:]]*=' "$MA_CONFIG/env"; then
    die 'Keep DEEPSEEK_API_KEY out of the local env; use local deepseek.key only.'
  fi
  local key
  key=$(cat "$MA_CONFIG/deepseek.key")
  [[ -n "$key" && "$key" != *$'\n'* && "$key" != *$'\r'* ]] || die 'Invalid local DeepSeek key file.'
}
upload_private_env() {
  local command="sudo sh -c 'install -m 0600 /dev/null /etc/min-atoms/env && cat > /etc/min-atoms/env'"
  if "$DRY_RUN"; then
    remote "$command"
    printf '  stdin: local env + local deepseek.key as DEEPSEEK_API_KEY; VM env only (0600, values hidden)\n'
    return
  fi
  # Quote for systemd EnvironmentFile syntax, without copying the key locally.
  local key
  key=$(cat "$MA_CONFIG/deepseek.key")
  key=${key//\\/\\\\}
  key=${key//\"/\\\"}
  { cat "$MA_CONFIG/env"; printf '\nDEEPSEEK_API_KEY="%s"\n' "$key"; } | remote "$command"
}
require_owned_vm() {
  local json
  json=$(gcloud compute instances describe "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" --format=json)
  jq -e --arg name "$MA_VM" --arg zone "$MA_ZONE" \
    '.name == $name and .labels.app == "min-atoms" and
     (.zone | endswith("/" + $zone)) and
     (.machineType | endswith("/e2-standard-4")) and
     ((.serviceAccounts // []) | length == 0)' <<< "$json" >/dev/null \
    || die 'VM ownership or security configuration differs; refusing to operate.'
}
wait_health() {
  if "$DRY_RUN"; then
    print_command curl --fail --silent --show-error --max-time 10 https://ma-vm.expii.top/health
    printf 'Wait up to 300 seconds for JSON .ok == true (requires bootstrap and tunnel).\n'
    return
  fi
  local deadline=$((SECONDS + 300)) body
  while ((SECONDS < deadline)); do
    if body=$(curl --fail --silent --max-time 10 https://ma-vm.expii.top/health) &&
      jq -e '.ok == true' <<< "$body" >/dev/null; then
      printf 'Manager healthy.\n'; return
    fi
    sleep 3
  done
  die 'Manager health timed out; check bootstrap, credentials and tunnel.'
}
