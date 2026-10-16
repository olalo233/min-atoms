#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
confirmed=false
vm_only=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --confirm-destroy) confirmed=true ;;
    --vm-only) vm_only=true ;;
    *) die "Unknown option: $arg" ;;
  esac
done
if ! "$DRY_RUN" && ! "$confirmed"; then die 'User must explicitly request teardown; then pass --confirm-destroy.'; fi
delete_vm() {
  gcloud compute instances delete "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" --quiet
  instances=$(gcloud compute instances list --project="$MA_PROJECT" --filter="name=$MA_VM" --format=json)
  jq -e --arg name "$MA_VM" '[.[] | select(.name == $name)] | length == 0' <<< "$instances" >/dev/null || die 'VM deletion not confirmed.'
}
# Retirement for long idle periods: snapshot the stopped disk, then delete only
# the VM and its disk. Tunnel, DNS and preview hostnames stay for
# up.sh --from-snapshot, or for restore.sh from the portable R2 data archive.
if "$vm_only"; then
  snapshot="$MA_VM-$(date -u +%Y%m%dt%H%M%Sz)"
  snapshot_args=(--project="$MA_PROJECT" --source-disk="$MA_VM" --source-disk-zone="$MA_ZONE"
    --storage-location="${MA_ZONE%-*}" --labels=app=min-atoms)
  if "$DRY_RUN"; then
    printf 'Require VM TERMINATED; warn if the R2 data archive predates its last start.\n'
    print_command gcloud compute snapshots create "$snapshot" "${snapshot_args[@]}"
    printf 'Read back the snapshot: READY, from this disk, labeled app=min-atoms.\n'
    print_command gcloud compute instances delete "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" --quiet
    printf 'Read back instance and disk lists; tunnel and DNS are kept.\n'
    exit 0
  fi
  require_owned_vm
  [[ $(vm_field status) == TERMINATED ]] || die 'VM is not stopped; run archive.sh or down.sh first.'
  started=$(vm_last_start_utc)
  archived=$(r2_latest_manifest 2>/dev/null | jq -r '.createdAt // empty' || true)
  if [[ -z $archived || ! $started < $archived ]]; then
    printf 'Warning: the R2 data archive predates the last VM start (%s); only the snapshot is current.\n' "$started" >&2
  fi
  gcloud compute snapshots create "$snapshot" "${snapshot_args[@]}"
  for _ in $(seq 120); do
    status=$(gcloud compute snapshots describe "$snapshot" --project="$MA_PROJECT" --format='value(status)')
    [[ $status == READY || $status == FAILED ]] && break
    sleep 5
  done
  gcloud compute snapshots describe "$snapshot" --project="$MA_PROJECT" --format=json |
    jq -e --arg disk "/zones/$MA_ZONE/disks/$MA_VM" \
      '.status == "READY" and .labels.app == "min-atoms" and (.sourceDisk | endswith($disk))' >/dev/null ||
    die "Snapshot $snapshot is not ready; the VM and disk were kept."
  delete_vm
  disks=$(gcloud compute disks list --project="$MA_PROJECT" --filter="name=$MA_VM" --format=json)
  jq -e 'length == 0' <<< "$disks" >/dev/null || die 'Boot disk still exists; check it before deleting manually.'
  printf 'Snapshot %s kept; VM and disk deleted; tunnel and DNS kept. Revive: infra/vm/up.sh --from-snapshot\n' "$snapshot"
  exit 0
fi
if "$DRY_RUN"; then
  print_command gcloud compute instances delete "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" --quiet
  print_command "$CF_BIN" tunnels list --name min-atoms --is-deleted=false
  print_command "$CF_BIN" dns records list --zone "$MA_DOMAIN" --comment min-atoms --name-startswith ma- --per-page 100 --page 1
  printf 'Delete only first-level ma-* CNAMEs with exact comment min-atoms and dedicated tunnel target; verify absence after each deletion.\n'
  print_command "$CF_BIN" dns records delete DUMMY-RECORD-ID --zone "$MA_DOMAIN" --force
  print_command "$CF_BIN" tunnels delete DUMMY-TUNNEL-ID --force
  printf 'Read back DNS lists and tunnel list to verify deletions.\n'
  exit 0
fi
"$CF_BIN" auth whoami >/dev/null
instances=$(gcloud compute instances list --project="$MA_PROJECT" --filter="name=$MA_VM" --format=json)
if [[ $(jq --arg name "$MA_VM" '[.[] | select(.name == $name)] | length' <<< "$instances") != 0 ]]; then
  require_owned_vm
  delete_vm
fi
tunnels=$("$CF_BIN" tunnels list --name min-atoms --is-deleted=false)
tunnels=$(jq '[.[] | select(.name == "min-atoms" and .deleted_at == null)]' <<< "$tunnels")
[[ $(jq length <<< "$tunnels") -le 1 ]] || die 'Ambiguous dedicated tunnel.'
[[ $(jq length <<< "$tunnels") == 1 ]] || exit 0
tunnel_id=$(jq -er '.[0].id' <<< "$tunnels")
tunnel=$("$CF_BIN" tunnels get "$tunnel_id")
jq -e --arg id "$tunnel_id" '.id == $id and .name == "min-atoms"' <<< "$tunnel" >/dev/null || die 'Tunnel ownership changed.'
# Take all pages before deleting, otherwise page offsets change during deletion.
records='[]'
page=1
while :; do
  batch=$("$CF_BIN" dns records list --zone "$MA_DOMAIN" --comment min-atoms --name-startswith ma- --per-page 100 --page "$page")
  records=$(jq -nc --argjson a "$records" --argjson b "$batch" '$a + $b')
  (($(jq length <<< "$batch") < 100)) && break
  page=$((page + 1))
done
ids=$(jq -r --arg target "$tunnel_id.cfargotunnel.com" '.[] | select(.comment == "min-atoms" and .type == "CNAME" and .content == $target and (.name | test("^ma-[a-z0-9-]+\\.expii\\.top$"))) | .id' <<< "$records")
while IFS= read -r id; do
  [[ -n "$id" ]] || continue
  record=$("$CF_BIN" dns records get "$id" --zone "$MA_DOMAIN")
  jq -e --arg target "$tunnel_id.cfargotunnel.com" '.comment == "min-atoms" and .type == "CNAME" and .content == $target and (.name | test("^ma-[a-z0-9-]+\\.expii\\.top$"))' <<< "$record" >/dev/null || die 'Record ownership changed.'
  name=$(jq -er '.name' <<< "$record")
  "$CF_BIN" dns records delete "$id" --zone "$MA_DOMAIN" --force >/dev/null
  remaining=$("$CF_BIN" dns records list --zone "$MA_DOMAIN" --name "$name")
  jq -e --arg id "$id" 'all(.[]; .id != $id)' <<< "$remaining" >/dev/null || die 'DNS deletion not confirmed.'
done <<< "$ids"
"$CF_BIN" tunnels delete "$tunnel_id" --force >/dev/null
remaining=$("$CF_BIN" tunnels list --name min-atoms --is-deleted=false)
jq -e --arg id "$tunnel_id" 'all(.[]; .id != $id)' <<< "$remaining" >/dev/null || die 'Tunnel deletion not confirmed.'
printf 'Project infrastructure deletion verified. Local private files retained for PM disposal.\n'
