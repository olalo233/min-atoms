#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
parse_dry_run "$@"
if "$DRY_RUN"; then
  printf 'Use DEEPSEEK_API_KEY from systemd /etc/min-atoms/env; pass only this key to the gateway container.\n'
  print_command iptables -C DOCKER-USER -d 169.254.169.254 -j DROP
  print_command docker network inspect ma-net
  print_command docker network create --driver bridge ma-net
  print_command docker rm -f ma-gateway
else
  iptables -C DOCKER-USER -d 169.254.169.254 -j DROP
  [[ -n "${DEEPSEEK_API_KEY:-}" && "$DEEPSEEK_API_KEY" != *$'\n'* && "$DEEPSEEK_API_KEY" != *$'\r'* ]] || die 'Missing or invalid DEEPSEEK_API_KEY in gateway service environment.'
  export DEEPSEEK_API_KEY
  if ! docker network inspect ma-net >/dev/null 2>&1; then docker network create --driver bridge ma-net >/dev/null; fi
  if docker container inspect ma-gateway >/dev/null 2>&1; then docker rm -f ma-gateway >/dev/null; fi
fi
run docker run -d --name ma-gateway --network ma-net --restart unless-stopped \
  --publish 127.0.0.1:8080:80 --env DEEPSEEK_API_KEY \
  --volume /opt/min-atoms/infra/gateway/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2.10.2
