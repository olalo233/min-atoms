#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
skip_health=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-health) skip_health=true ;;
    *) die "Unknown option: $arg" ;;
  esac
done
create_vm() {
  run gcloud compute instances create "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" \
    --machine-type=e2-standard-4 --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=50GB --boot-disk-type=pd-balanced --labels=app=min-atoms \
    --no-service-account --no-scopes
}
if "$DRY_RUN"; then
  print_command gcloud compute instances list --project="$MA_PROJECT" --filter="name=$MA_VM" --format=json
  printf 'If absent: create; if TERMINATED: start; if RUNNING: reuse.\n'
  create_vm
  run gcloud compute instances start "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE"
else
  instances=$(gcloud compute instances list --project="$MA_PROJECT" --filter="name=$MA_VM" --format=json)
  count=$(jq --arg name "$MA_VM" '[.[] | select(.name == $name)] | length' <<< "$instances")
  if [[ "$count" == 0 ]]; then
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
