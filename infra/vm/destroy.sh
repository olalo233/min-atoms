#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
confirmed=false
for arg in "$@"; do
  case "$arg" in --dry-run) DRY_RUN=true ;; --confirm-destroy) confirmed=true ;; *) die "Unknown option: $arg" ;; esac
done
if ! "$DRY_RUN" && ! "$confirmed"; then die 'User must explicitly request teardown; then pass --confirm-destroy.'; fi
CF_BIN=${CF_BIN:-cf}
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
  gcloud compute instances delete "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE" --quiet
  instances=$(gcloud compute instances list --project="$MA_PROJECT" --filter="name=$MA_VM" --format=json)
  jq -e --arg name "$MA_VM" '[.[] | select(.name == $name)] | length == 0' <<< "$instances" >/dev/null || die 'VM deletion not confirmed.'
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
