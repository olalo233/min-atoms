#!/usr/bin/env bash
# Deep archive for long idle periods: copy only non-rebuildable project data to
# R2 (and a private local copy), then stop the VM. See README "Deep archive".
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
parse_dry_run "$@"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
prefix="archives/$stamp"
max_bytes=$((300 * 1024 * 1024)) # cf r2 objects put request limit
if "$DRY_RUN"; then
  print_command "$CF_BIN" r2 buckets list
  printf 'If %s is absent: ' "$MA_ARCHIVE_BUCKET"
  print_command "$CF_BIN" r2 buckets create --name "$MA_ARCHIVE_BUCKET" --location-hint apac
  printf 'Require VM RUNNING; then stop manager and project containers:\n'
  archive_host freeze
  archive_host list
  archive_host pack
  printf '  archive saved to %s/archives/%s/ (0700), verified with gzip -t\n' "${MA_CONFIG:-~/.config/min-atoms}" "$stamp"
  archive_host verify
  printf '  stdin: the saved archive, compared with the frozen disk\n'
  for key in "$prefix/projects.tar.gz" "$prefix/manifest.json" latest.json; do
    print_command "$CF_BIN" r2 objects put "$key" --bucket-name "$MA_ARCHIVE_BUCKET" --file "<local $key>"
    print_command "$CF_BIN" r2 objects get "$key" --bucket-name "$MA_ARCHIVE_BUCKET"
  done
  printf 'latest.json is written last, after the archive and manifest read back intact.\n'
  print_command gcloud compute instances stop "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE"
  exit 0
fi

"$CF_BIN" auth whoami >/dev/null
require_owned_vm
[[ $(vm_field status) == RUNNING ]] || die 'Start the VM with up.sh before archiving.'
if ! "$CF_BIN" r2 buckets list | jq -e --arg name "$MA_ARCHIVE_BUCKET" '.buckets | any(.name == $name)' >/dev/null; then
  "$CF_BIN" r2 buckets create --name "$MA_ARCHIVE_BUCKET" --location-hint apac >/dev/null
fi
out="$MA_CONFIG/archives/$stamp"
(umask 077 && mkdir -p "$out")
archive="$out/projects.tar.gz"

completed=false
trap '"$completed" || printf "Archive incomplete: manager and project containers stay stopped and latest.json is unchanged. Rerun archive.sh, or down.sh then up.sh to resume service.\n" >&2' EXIT
archive_host freeze
archive_host list > "$out/projects.txt"
archive_host pack > "$archive"
gzip -t "$archive"
archive_host verify < "$archive"
bytes=$(wc -c < "$archive" | tr -d ' ')
((bytes <= max_bytes)) || die "Archive is $bytes bytes, above the single-upload limit; nothing uploaded."
jq -n --arg createdAt "$(sed -E 's/^(....)(..)(..)T(..)(..)(..)Z$/\1-\2-\3T\4:\5:\6Z/' <<< "$stamp")" \
  --arg vm "$MA_VM" --arg project "$MA_PROJECT" --arg zone "$MA_ZONE" \
  --arg key "$prefix/projects.tar.gz" --argjson bytes "$bytes" --arg sha256 "$(sha256_of "$archive")" \
  --rawfile projects "$out/projects.txt" \
  '{format: 1, createdAt: $createdAt, vm: {name: $vm, project: $project, zone: $zone},
    root: "/srv/min-atoms/projects",
    excluded: ["node_modules", "projects/*/workspace/dist", "projects/*/workspace/.ma"],
    projects: ($projects | split("\n") | map(select(length > 0))),
    archive: {key: $key, bytes: $bytes, sha256: $sha256}}' > "$out/manifest.json"
jq -n --arg manifest "$prefix/manifest.json" '{manifest: $manifest}' > "$out/latest.json"

r2_put_verified "$prefix/projects.tar.gz" "$archive" application/gzip
r2_put_verified "$prefix/manifest.json" "$out/manifest.json" application/json
# Only a complete, verified archive becomes the restore source.
r2_put_verified latest.json "$out/latest.json" application/json
completed=true
gcloud compute instances stop "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE"
printf 'Archived %s projects (%s bytes) to r2://%s/%s; local copy %s. VM stopped.\n' \
  "$(jq '.projects | length' "$out/manifest.json")" "$bytes" "$MA_ARCHIVE_BUCKET" "$prefix" "$out"
printf 'To stop paying for the disk: infra/vm/destroy.sh --vm-only --confirm-destroy\n'
