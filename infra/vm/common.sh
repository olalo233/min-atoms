#!/usr/bin/env bash
# Shared by the local PM scripts; never consult the active gcloud project.
set -euo pipefail
MA_PROJECT=hy2-seoul-relay-20260728
MA_ZONE=asia-northeast1-b
MA_VM=min-atoms-vm
export MA_DOMAIN=expii.top
export MA_ROOT
MA_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# Local PM paths are unused by host services, which may run without HOME.
if [[ -n "${HOME:-}" ]]; then
  export MA_CONFIG=${HOME}/.config/min-atoms
fi
DRY_RUN=false
# Dedicated R2 bucket for deep archives; only the operator's cf login can write it.
MA_ARCHIVE_BUCKET=min-atoms-archive
CF_BIN=${CF_BIN:-cf}

die() { printf '%s\n' "$*" >&2; exit 1; }
print_command() { printf '+ '; printf '%q ' "$@"; printf '\n'; }
run() {
  if "$DRY_RUN"; then print_command "$@"; else "$@"; fi
}
remote() {
  # --plain bypasses SDK key creation and SSH metadata management.
  run gcloud compute ssh "tmars@$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" \
    --plain --tunnel-through-iap \
    --ssh-flag=-i --ssh-flag="${HOME}/.ssh/google_compute_engine" \
    --ssh-flag=-oIdentitiesOnly=yes --ssh-flag=-oBatchMode=yes \
    --ssh-flag=-oConnectTimeout=60 --ssh-flag=-oStrictHostKeyChecking=accept-new \
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
     (.machineType | endswith("/t2d-standard-2") or endswith("/e2-standard-4")) and
     ((.serviceAccounts // []) | length == 0) and
     ([.metadata.items[]? | select(.key == "block-project-ssh-keys") | .value] == ["true"])' <<< "$json" >/dev/null \
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
vm_field() {
  gcloud compute instances describe "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" --format="value($1)"
}
vm_last_start_utc() { vm_field 'lastStartTimestamp.date("%Y-%m-%dT%H:%M:%SZ", tz=UTC)'; }
# Runs one archive-host.sh subcommand on the VM as root, streaming the script itself.
archive_host() {
  if "$DRY_RUN"; then printf '+ remote: sudo archive-host.sh %s\n' "$*"; return; fi
  local command arg
  command="sudo bash -c $(printf '%q' "$(cat "$MA_ROOT/infra/vm/archive-host.sh")") archive-host.sh"
  for arg in "$@"; do command+=" $(printf '%q' "$arg")"; done
  remote "$command"
}
sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
r2_get() { "$CF_BIN" r2 objects get "$1" --bucket-name "$MA_ARCHIVE_BUCKET" > "$2"; }
# Upload, then read the object back: a zero exit status is not proof of storage.
r2_put_verified() {
  local key=$1 file=$2 type=$3 back
  "$CF_BIN" r2 objects put "$key" --bucket-name "$MA_ARCHIVE_BUCKET" --file "$file" --content-type "$type" >/dev/null
  back=$(mktemp)
  if ! r2_get "$key" "$back" || [[ $(sha256_of "$back") != "$(sha256_of "$file")" ]]; then
    rm -f "$back"
    die "R2 readback did not match: $key"
  fi
  rm -f "$back"
}
# Prints the manifest of the newest complete archive; fails when none exists.
r2_latest_manifest() {
  local pointer manifest
  pointer=$(mktemp); manifest=$(mktemp)
  if r2_get latest.json "$pointer" 2>/dev/null &&
    r2_get "$(jq -er '.manifest' "$pointer")" "$manifest"; then
    cat "$manifest"; rm -f "$pointer" "$manifest"
  else
    rm -f "$pointer" "$manifest"
    return 1
  fi
}
