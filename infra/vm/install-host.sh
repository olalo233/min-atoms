#!/usr/bin/env bash
# Executed only on the VM by bootstrap.sh. --dry-run is safe on any host.
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
parse_dry_run "$@"
if ! "$DRY_RUN"; then [[ $EUID == 0 ]] || die 'Run as root on the VM.'; fi
run apt-get update
run apt-get install -y docker.io curl ca-certificates unzip iptables
run install -d -m 0755 /usr/share/keyrings
run curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
if "$DRY_RUN"; then
  printf 'Write signed cloudflared apt source: https://pkg.cloudflare.com/cloudflared any main\n'
else
  printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
fi
run apt-get update
run apt-get install -y cloudflared
run curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip -o /tmp/ma-bun.zip
run unzip -o /tmp/ma-bun.zip -d /tmp/ma-bun
run install -m 0755 /tmp/ma-bun/bun-linux-x64/bun /usr/local/bin/bun
run rm -rf /tmp/ma-bun.zip /tmp/ma-bun
for unit in ma-firewall ma-gateway ma-manager ma-cloudflared; do
  run install -m 0644 "$MA_ROOT/infra/vm/$unit.service" "/etc/systemd/system/$unit.service"
done
run systemctl daemon-reload
run systemctl enable --now docker.service
run systemctl enable ma-firewall.service ma-gateway.service ma-manager.service ma-cloudflared.service
run systemctl restart ma-firewall.service ma-gateway.service ma-manager.service ma-cloudflared.service
