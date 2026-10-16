#!/usr/bin/env bash
# Rebuilds project data from a deep archive on a freshly deployed VM: run after
# up.sh, bootstrap.sh and deploy.sh, before sharing the demo link again.
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
stamp=
while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --archive) [[ ${2:-} =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die 'Usage: --archive YYYYMMDDTHHMMSSZ'; stamp=$2; shift ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done
if "$DRY_RUN"; then
  if [[ -n $stamp ]]; then
    print_command "$CF_BIN" r2 objects get "archives/$stamp/manifest.json" --bucket-name "$MA_ARCHIVE_BUCKET"
  else
    print_command "$CF_BIN" r2 objects get latest.json --bucket-name "$MA_ARCHIVE_BUCKET"
    printf 'Then get the manifest it names.\n'
  fi
  printf 'Get the archive named by the manifest; require its sha256 before any VM change.\n'
  printf 'Require VM RUNNING and an empty /srv/min-atoms/projects:\n'
  archive_host empty
  archive_host stage '<sha256>'
  printf '  stdin: the verified archive, checked again on the VM\n'
  archive_host unpack
  archive_host deps
  printf 'Wait for manager health.\n'
  exit 0
fi

"$CF_BIN" auth whoami >/dev/null
require_owned_vm
[[ $(vm_field status) == RUNNING ]] || die 'Run up.sh, bootstrap.sh and deploy.sh before restoring.'
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [[ -n $stamp ]]; then
  r2_get "archives/$stamp/manifest.json" "$work/manifest.json" || die "No archive $stamp."
else
  r2_latest_manifest > "$work/manifest.json" || die 'No complete archive in R2.'
fi
jq -e '.format == 1 and (.archive.sha256 | test("^[0-9a-f]{64}$"))' "$work/manifest.json" >/dev/null ||
  die 'Unsupported archive manifest.'
key=$(jq -er '.archive.key' "$work/manifest.json")
sha256=$(jq -er '.archive.sha256' "$work/manifest.json")
r2_get "$key" "$work/projects.tar.gz" || die "Missing archive object: $key"
[[ $(sha256_of "$work/projects.tar.gz") == "$sha256" ]] || die 'Archive checksum mismatch; nothing was changed.'

archive_host empty
archive_host stage "$sha256" < "$work/projects.tar.gz"
archive_host unpack
archive_host deps
wait_health
printf 'Restored %s projects from %s (created %s).\n' \
  "$(jq '.projects | length' "$work/manifest.json")" "$key" "$(jq -r '.createdAt' "$work/manifest.json")"
