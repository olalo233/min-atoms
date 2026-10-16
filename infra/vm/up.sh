#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
skip_health=false
from_snapshot=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-health) skip_health=true ;;
    --from-snapshot) from_snapshot=true ;;
    *) die "Unknown option: $arg" ;;
  esac
done
# A retired VM comes back from its newest snapshot fully configured: same disk
# contents, services, private env and project data; only the external IP changes.
boot_source=(--image-family=debian-12 --image-project=debian-cloud)
# SSH access is instance metadata, not disk content, so every create restores it:
# only the operator's public key for tmars, with project-wide keys blocked.
ssh_pub=${HOME:-}/.ssh/google_compute_engine.pub
create_vm() {
  local keys=SSH-KEYS-FILE
  if ! "$DRY_RUN"; then
    [[ -f $ssh_pub ]] || die "Missing $ssh_pub for the tmars SSH key."
    keys=$(mktemp)
    printf 'tmars:%s\n' "$(cut -d' ' -f1,2 "$ssh_pub")" > "$keys"
  fi
  run gcloud compute instances create "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" \
    --machine-type=t2d-standard-2 --provisioning-model=SPOT --instance-termination-action=STOP "${boot_source[@]}" \
    --boot-disk-size=50GB --boot-disk-type=pd-balanced --labels=app=min-atoms \
    --metadata=block-project-ssh-keys=true --metadata-from-file=ssh-keys="$keys" \
    --no-service-account --no-scopes
  if ! "$DRY_RUN"; then rm -f "$keys"; fi
}
latest_snapshot_args=(--project="$MA_PROJECT" --filter='labels.app=min-atoms AND status=READY'
  --sort-by=~creationTimestamp --limit=1 --format='value(name)')
if "$DRY_RUN"; then
  print_command gcloud compute instances list --project="$MA_PROJECT" --filter="name=$MA_VM" --format=json
  if "$from_snapshot"; then
    printf 'Require the VM to be absent, then create it from the newest ready snapshot:\n'
    print_command gcloud compute snapshots list "${latest_snapshot_args[@]}"
    boot_source=(--source-snapshot=NEWEST-SNAPSHOT)
    create_vm
  else
    printf 'If absent: create; if TERMINATED: start; if RUNNING: reuse.\n'
    create_vm
    run gcloud compute instances start "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE"
  fi
else
  instances=$(gcloud compute instances list --project="$MA_PROJECT" --filter="name=$MA_VM" --format=json)
  count=$(jq --arg name "$MA_VM" '[.[] | select(.name == $name)] | length' <<< "$instances")
  if "$from_snapshot"; then
    [[ "$count" == 0 ]] || die 'VM already exists; --from-snapshot only recreates a retired VM.'
    snapshot=$(gcloud compute snapshots list "${latest_snapshot_args[@]}")
    [[ -n $snapshot ]] || die 'No ready min-atoms snapshot.'
    boot_source=(--source-snapshot="$snapshot")
    create_vm
    require_owned_vm
  elif [[ "$count" == 0 ]]; then
    create_vm
    require_owned_vm
  else
    [[ "$count" == 1 ]] || die 'Ambiguous VM name across zones.'
    require_owned_vm
    state=$(jq -r --arg name "$MA_VM" '.[] | select(.name == $name) | .status' <<< "$instances")
    case "$state" in
      TERMINATED) run gcloud compute instances start "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" ;;
      RUNNING) ;;
      *) die "VM state $state is not ready for up." ;;
    esac
  fi
fi
if ! "$skip_health"; then wait_health; fi
