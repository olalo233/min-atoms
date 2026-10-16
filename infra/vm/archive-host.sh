#!/usr/bin/env bash
# Runs on the VM as root, streamed by archive.sh/restore.sh (not deployed), so
# an archive never depends on which source revision the VM happens to run.
# The archive keeps only what a rebuild cannot recreate: each project's Git
# workspace (history and working tree), its app /data and agent /state.
set -euo pipefail
parent=/srv/min-atoms
projects=$parent/projects
stage=/var/tmp/ma-restore.tar.gz
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || die 'Run as root on the VM.'
# Regenerable: dependencies (bun install), build output and dev-server logs.
select_args=(--anchored --exclude='projects/*/workspace/dist' --exclude='projects/*/workspace/.ma'
  --no-anchored --exclude=node_modules)
project_containers() {
  # A failed query must never read as "no containers": callers capture first.
  local out
  out=$(docker ps -q --filter label=min-atoms.managed=true --filter label=min-atoms.role=project) ||
    die 'Cannot list project containers; nothing was archived.'
  printf '%s' "$out"
}
require_empty() {
  [[ ! -e $projects || -z $(find "$projects" -mindepth 1 -maxdepth 1 -print -quit) ]] ||
    die "Refusing to restore over existing $projects; nothing was changed."
}

case "${1:-}" in
  freeze)
    # Stop every writer so SQLite files and Git objects are copied at rest.
    systemctl stop ma-manager.service
    ids=$(project_containers)
    mapfile -t running <<< "$ids"
    if [[ -n $ids ]]; then docker stop -t 10 "${running[@]}" >/dev/null; fi
    ids=$(project_containers)
    [[ -z $ids ]] || die 'Project containers are still running.'
    ;;
  list)
    find "$projects" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
    ;;
  pack)
    tar -C "$parent" --numeric-owner "${select_args[@]}" -czf - projects
    ;;
  verify)
    # Compares the archive on stdin with the disk: contents, modes, owners, links.
    tar -C "$parent" --numeric-owner -dzf -
    ;;
  empty)
    require_empty
    ;;
  stage)
    [[ ${2:-} =~ ^[0-9a-f]{64}$ ]] || die 'Usage: archive-host.sh stage <sha256>'
    install -m 0600 /dev/null "$stage"
    cat > "$stage"
    if [[ $(sha256sum "$stage" | cut -d' ' -f1) != "$2" ]]; then
      rm -f "$stage"
      die 'Staged archive checksum mismatch.'
    fi
    ;;
  unpack)
    [[ -f $stage ]] || die 'No staged archive.'
    systemctl stop ma-manager.service
    require_empty
    tar -C "$parent" --numeric-owner -xpzf "$stage"
    tar -C "$parent" --numeric-owner -dzf "$stage"
    rm -f "$stage"
    ;;
  deps)
    # Reinstall from each workspace's own lockfile inside the project image, as
    # the app user, on the same metadata-blocked network the agent uses.
    docker image inspect min-atoms/project >/dev/null || die 'Image min-atoms/project is missing; run deploy.sh first.'
    cache=$(mktemp -d /var/tmp/ma-bun-cache.XXXXXX)
    trap 'rm -rf "$cache"' EXIT
    chown 1000:1000 "$cache"
    for workspace in "$projects"/*/workspace; do
      [[ -f $workspace/package.json ]] || continue
      install_deps() {
        docker run --rm --network ma-net --user app --memory 2g --cpus 2 --pids-limit 512 \
          --entrypoint bun --env BUN_INSTALL_CACHE_DIR=/bun-cache \
          --mount "type=bind,src=$workspace,dst=/workspace" --mount "type=bind,src=$cache,dst=/bun-cache" \
          --workdir /workspace min-atoms/project install "$@"
      }
      # A drifted lockfile still gets dependencies, without rewriting tracked files.
      install_deps --frozen-lockfile || install_deps --no-save
    done
    systemctl start ma-manager.service
    ;;
  *)
    die 'Usage: archive-host.sh freeze|list|pack|verify|empty|stage <sha256>|unpack|deps'
    ;;
esac
