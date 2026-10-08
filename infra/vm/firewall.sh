#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --dry-run)
    printf '%s\n' 'iptables -C DOCKER-USER -d 169.254.169.254 -j DROP || iptables -I DOCKER-USER -d 169.254.169.254 -j DROP'
    exit 0 ;;
  '') ;;
  *) exit 1 ;;
esac
if ! iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null; then
  iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
fi
iptables -C DOCKER-USER -d 169.254.169.254 -j DROP
