#!/usr/bin/env bash
# PM-only execution. Dry-run prints dummy requests without calling cf or reading secrets.
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
parse_dry_run "$@"
CF_BIN=${CF_BIN:-cf}
ingress='{"config":{"ingress":[{"hostname":"ma-vm.expii.top","service":"http://localhost:8090"},{"hostname":"*.expii.top","service":"http://localhost:8080"},{"service":"http_status:404"}]}}'
if "$DRY_RUN"; then
  print_command "$CF_BIN" auth whoami
  print_command "$CF_BIN" tunnels list --name min-atoms --is-deleted=false
  print_command "$CF_BIN" tunnels create --name min-atoms --config-src cloudflare
  print_command "$CF_BIN" tunnels get DUMMY-TUNNEL-ID
  print_command "$CF_BIN" tunnels config update DUMMY-TUNNEL-ID --body "$ingress"
  print_command "$CF_BIN" tunnels config get DUMMY-TUNNEL-ID
  for ((i=0; i<=30; i++)); do
    if ((i == 0)); then name=ma-vm.expii.top; else printf -v name 'ma-test%04d.expii.top' "$i"; fi
    print_command "$CF_BIN" dns records list --zone "$MA_DOMAIN" --name "$name"
    print_command "$CF_BIN" dns records create --zone "$MA_DOMAIN" --body \
      "{\"type\":\"CNAME\",\"name\":\"$name\",\"content\":\"DUMMY-TUNNEL-ID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1,\"comment\":\"min-atoms\"}"
    print_command "$CF_BIN" dns records get DUMMY-RECORD-ID --zone "$MA_DOMAIN"
  done
  printf 'Persist 30 real random hosts only to ~/.config/min-atoms/preview-hosts.txt (0600); dry-run writes nothing.\n'
  exit 0
fi
command -v jq >/dev/null || die 'jq is required.'
"$CF_BIN" auth whoami >/dev/null
tunnels=$("$CF_BIN" tunnels list --name min-atoms --is-deleted=false)
tunnels=$(jq '[.[] | select(.name == "min-atoms" and .deleted_at == null)]' <<< "$tunnels")
case $(jq length <<< "$tunnels") in
  0)
    created=$("$CF_BIN" tunnels create --name min-atoms --config-src cloudflare)
    tunnel_id=$(jq -er '.id' <<< "$created") ;;
  1) tunnel_id=$(jq -er '.[0].id' <<< "$tunnels") ;;
  *) die 'Multiple dedicated tunnels found; refusing to guess.' ;;
esac
tunnel=$("$CF_BIN" tunnels get "$tunnel_id")
jq -e --arg id "$tunnel_id" '.id == $id and .name == "min-atoms" and .config_src == "cloudflare" and .deleted_at == null' <<< "$tunnel" >/dev/null \
  || die 'Tunnel readback failed or existing tunnel is locally managed.'
# Replacing the same dedicated configuration is idempotent, including recovery
# after creation was interrupted before the first configuration was installed.
"$CF_BIN" tunnels config update "$tunnel_id" --body "$ingress" >/dev/null
config=$("$CF_BIN" tunnels config get "$tunnel_id")
jq -e --argjson desired "$ingress" '.config.ingress == $desired.config.ingress' <<< "$config" >/dev/null || die 'Ingress readback differs.'
target=$tunnel_id.cfargotunnel.com
ensure_record() {
  local name=$1 records record_id body readback
  [[ "$name" == ma-vm.expii.top || "$name" =~ ^ma-[a-z0-9]{8}\.expii\.top$ ]] || die 'Invalid project hostname.'
  records=$("$CF_BIN" dns records list --zone "$MA_DOMAIN" --name "$name")
  case $(jq length <<< "$records") in
    0)
      body=$(jq -nc --arg name "$name" --arg target "$target" '{type:"CNAME",name:$name,content:$target,proxied:true,ttl:1,comment:"min-atoms"}')
      readback=$("$CF_BIN" dns records create --zone "$MA_DOMAIN" --body "$body")
      record_id=$(jq -er '.id' <<< "$readback") ;;
    1) record_id=$(jq -er '.[0].id' <<< "$records") ;;
    *) die 'Multiple records at a requested hostname; refusing to modify.' ;;
  esac
  readback=$("$CF_BIN" dns records get "$record_id" --zone "$MA_DOMAIN")
  jq -e --arg name "$name" --arg target "$target" \
    '.name == $name and .type == "CNAME" and .content == $target and .proxied == true and .comment == "min-atoms"' <<< "$readback" >/dev/null \
    || die 'DNS readback or ownership mismatch; no existing records were changed.'
}
ensure_record ma-vm.expii.top
umask 077
mkdir -p "$MA_CONFIG"
chmod 700 "$MA_CONFIG"
hosts_file=$MA_CONFIG/preview-hosts.txt
# Persist the entire pool before DNS writes, so an interrupted run reuses the same hosts.
if [[ ! -f "$hosts_file" ]]; then
  existing=$("$CF_BIN" dns records list --zone "$MA_DOMAIN" --comment min-atoms --name-startswith ma- --per-page 100 --page 1)
  jq -r --arg target "$target" '.[] | select(.comment == "min-atoms" and .type == "CNAME" and .content == $target and (.name | test("^ma-[a-z0-9]{8}\\.expii\\.top$"))) | .name' <<< "$existing" > "$hosts_file"
fi
chmod 600 "$hosts_file"
hosts=$(cat "$hosts_file")
while IFS= read -r host; do
  [[ -z "$host" || "$host" =~ ^ma-[a-z0-9]{8}\.expii\.top$ ]] || die 'Invalid private preview pool file.'
done <<< "$hosts"
count=$(awk 'NF {n++} END {print n+0}' "$hosts_file")
unique=$(sort -u "$hosts_file" | awk 'NF {n++} END {print n+0}')
[[ "$count" == "$unique" && "$count" -le 30 ]] || die 'Pool must contain at most 30 unique hosts.'
while ((count < 30)); do
  # 36^8 random possibilities; rejection by tr avoids modulo bias.
  host="ma-$(LC_ALL=C tr -dc a-z0-9 < /dev/urandom | head -c 8 || true).expii.top"
  [[ "$host" =~ ^ma-[a-z0-9]{8}\.expii\.top$ ]] || die 'Random hostname generation failed.'
  if ! grep -Fxq "$host" "$hosts_file"; then
    printf '%s\n' "$host" >> "$hosts_file"
    count=$((count + 1))
  fi
done
while IFS= read -r host; do [[ -z "$host" ]] || ensure_record "$host"; done < "$hosts_file"
printf 'Dedicated tunnel, ingress and 31 scoped records verified; private pool saved.\n'
