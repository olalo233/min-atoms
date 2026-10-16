# VM operations

These scripts are run by the PM after authorization. `--dry-run` only prints
commands: it never invokes gcloud/cf, opens private files, or changes the host.
Use Bash, gcloud, jq, curl and the official Node.js `cf` CLI (1.0.0-beta.12).
If `cf` is shadowed, use `CF_BIN=cloudflare` for the Cloudflare scripts.
The GCP project, VM, zone and Cloudflare zone are fixed in `common.sh`.
New VMs (including `--from-snapshot`) use Spot `t2d-standard-2` with a
50 GB pd-balanced boot disk and no service account. Spot preemption stops
the VM instead of deleting it; restart with `up.sh`. An in-flight run is
marked failed on the next manager start by the existing recovery path.
Ownership checks also accept the previous `e2-standard-4` VM shape.

SSH prerequisite: the existing IAP firewall must allow this VM, and the PM must
authorize the public key for `tmars` on this VM only, with
`block-project-ssh-keys=true`. The local identity must already exist at
`~/.ssh/google_compute_engine`; scripts never create keys or touch project SSH
metadata. `up.sh` sets instance SSH metadata only when it creates the VM
(including `--from-snapshot`, since metadata is not part of a disk snapshot):
`block-project-ssh-keys=true` and that public key for `tmars`. All remote commands use the following connection flags
(`--plain` bypasses SDK key/metadata management):

```sh
gcloud compute ssh tmars@min-atoms-vm \
  --project=hy2-seoul-relay-20260728 --zone=asia-northeast1-b \
  --plain --tunnel-through-iap \
  --ssh-flag=-i --ssh-flag="$HOME/.ssh/google_compute_engine" \
  --ssh-flag=-oIdentitiesOnly=yes --ssh-flag=-oBatchMode=yes \
  --ssh-flag=-oConnectTimeout=60 --ssh-flag=-oStrictHostKeyChecking=accept-new \
  --ssh-flag=-T --command='true'
```

First setup:

1. Run `infra/vm/cloudflare.sh`. It creates/reuses the remote `min-atoms` tunnel,
   reads ingress first, skips updates when it matches, otherwise updates and
   verifies readback. It verifies DNS and saves 30 full preview hostnames in
   `~/.config/min-atoms/preview-hosts.txt` (0600). Keep this file private. An
   interrupted run reuses the persisted pool. Existing mismatched DNS records
   cause failure rather than being overwritten. Authenticate/select the intended
   Cloudflare account in the PM session first; the script checks `cf auth whoami`.
2. In the PM session, obtain the connector token with
   `cf tunnels token get <dedicated-tunnel-id>` and place its JSON string value in
   `~/.config/min-atoms/env` as `TUNNEL_TOKEN=...`. This file uses systemd
   EnvironmentFile syntax, contains no executable shell, and later also holds
   `DATABASE_URL` (5432 session pool), `MA_SHARED_SECRET` and `WEB_ORIGIN`.
   It must **not** contain `DEEPSEEK_API_KEY`.
3. Store just the DeepSeek key in `~/.config/min-atoms/deepseek.key`.
   Set both private files to 0600. No key is passed as a command argument or put
   in instance metadata. Bootstrap/deploy combine this dedicated local key with
   the local env on SSH stdin and store it **only** in `/etc/min-atoms/env` (0600)
   as `DEEPSEEK_API_KEY`; no separate VM key file is created, and the local env
   remains key-free. The gateway unit reads the VM env and `gateway.sh` passes
   only `DEEPSEEK_API_KEY` to its container. The manager and cloudflared units
   explicitly remove `DEEPSEEK_API_KEY` with systemd `UnsetEnvironment`.
4. Run `infra/vm/up.sh --skip-health` on first creation, then
   `infra/vm/bootstrap.sh`. Subsequent `up.sh` calls wait for `.ok == true` at
   `https://ma-vm.expii.top/health` for up to five minutes.

Bootstrap installs Debian Docker/iptables, cloudflared from its signed official
apt repository, and Bun 1.4.2 from the official release archive. It installs the
four runtime systemd units and starts the firewall before gateway and manager,
then installs and enables `ma-idle.timer` and its oneshot service.
It preserves other `/etc/docker/daemon.json` fields and sets exactly
`"dns": ["8.8.8.8"]`: containers cannot use the host's metadata resolver while
metadata DROP remains enforced. Changed config restarts active Docker through
the existing firewall/gateway/manager lifecycle; inactive Docker starts with the
new config. Matching config is not rewritten and does not restart Docker.
Dry-run prints this intent without reading or writing daemon config.
Cloudflared uses `TUNNEL_TOKEN` from the private environment file (the supported
environment equivalent of `tunnel run --token`). Gateway publishes only
`127.0.0.1:8080:80`; its model listener at 8081 is accessible on `ma-net` only.
The manager initially runs the ten-line loopback health stub. Once
`apps/manager/src/index.ts` exists, `manager.sh` starts that entrypoint with
`HOST=127.0.0.1 PORT=8090`. The manager must honor this binding and recheck the
metadata rule before creating project containers.

After the manager, packages, scaffold and image inputs exist, `deploy.sh`
transfers all architecture §12 inputs, installs manager dependencies using the
root frozen lockfile, builds `min-atoms/project`, and restarts the gateway and
manager. The scaffold's runtime AGENTS.md and docs are included; dependencies,
Git/Jujutsu metadata and .env files are excluded. Private env/key updates travel
as one env payload on SSH stdin. Deployment does not build or transfer the web app.
Deployment also installs/enables the idle units, including on older restored disks.

The VM powers itself off after 20 minutes without manager activity, checked
every five minutes starting 15 minutes after boot (so shutdown normally occurs
20–25 minutes after last use). Manager start, authenticated `/projects/*`
requests, SSE open/close and run completion reset the idle clock. Any queued
or running run or open SSE stream keeps `/health`'s `idleSeconds` at zero.
Health polling does not reset it. A failed health check, invalid JSON or missing
idle field leaves the VM running. This measures manager use; direct preview
traffic and SSH sessions do not count as activity.
To override the default, set `MA_IDLE_SHUTDOWN_SECONDS=<seconds>` in the
optional `/etc/min-atoms/idle.conf` (systemd EnvironmentFile syntax); `0`
disables idle shutdown. The idle service reads no private manager environment.
Automatic poweroff keeps the disk and project data. Once the
[runtime controller](../../apps/controller/README.md) and web integration are
deployed, the web app requests wake automatically; `up.sh` remains the operator
fallback for a stopped VM.

The controller checks every ten minutes. After the VM has been stopped for two
hours, it takes an `app=min-atoms` snapshot in `asia-northeast1`, waits for
`READY` across cron ticks, and rechecks the VM's stopped state, stop timestamp,
boot disk name and `autoDelete=true` before deleting the VM and disk. It keeps
the newest two READY snapshots and waits to prune if a newer copy is incomplete.
A later web wake starts a stopped VM or recreates a retired one from the newest
READY snapshot, with the same Spot settings, SSH metadata and no service account.
Tunnel, DNS and preview URLs stay intact. Snapshots still incur storage cost;
idle shutdown removes compute cost, retirement removes the persistent disk cost.

`down.sh` stops the VM and retains its disk. `destroy.sh --confirm-destroy` is
only for a user-requested final teardown: it deletes the owned VM, scoped DNS
CNAMEs with the exact `min-atoms` comment and dedicated tunnel target, then the
dedicated tunnel, confirming each deletion by readback. It retains local private
files for PM disposal and does not alter other DNS, Access or zone settings.
It never touches R2 archives or snapshots.

Long idle periods: a stopped VM still pays for its 50 GB disk. Two copies
replace it, each verified before anything is deleted:

- `archive.sh` (portable data copy) keeps only what a rebuild cannot
  recreate: each project's Git workspace (all versions and the working tree),
  its app `/data` (SQLite) and agent `/state` (omp sessions, version
  screenshots). Dependencies (`node_modules`), the workspace `dist` build and
  `.ma` dev-server logs, the OS, Docker image, deployed source and private env
  are left out. On a running VM it stops the manager and project containers,
  streams `archive-host.sh` over SSH (independent of the deployed revision),
  packs `/srv/min-atoms/projects` with numeric owners, checks the archive
  against the frozen disk with `tar --diff`, saves a private copy under
  `~/.config/min-atoms/archives/`, uploads the archive and `manifest.json` to
  the dedicated R2 bucket `min-atoms-archive` with the operator's `cf` login,
  reads each object back by sha256, writes `latest.json` last, and stops the
  VM. The VM never holds R2 credentials.
- `destroy.sh --vm-only --confirm-destroy` (fast GCP copy) requires a stopped
  VM, warns if the R2 archive predates its last start, creates a regional
  snapshot labeled `app=min-atoms` from the disk, waits for `READY`, and only
  then deletes the VM and its disk, confirming both by readback. The tunnel,
  DNS records and preview-host pool are kept, so projects return at the same
  URLs. After confirming VM and disk deletion it keeps the newest two READY
  `app=min-atoms` snapshots, pruning older READY copies with deletion readback;
  a newer incomplete snapshot prevents pruning.

To revive on GCP, `up.sh --from-snapshot` recreates the VM from the newest
ready snapshot, fully configured, and waits for manager health. To rebuild
elsewhere or from scratch, run `up.sh --skip-health`, `bootstrap.sh`,
`deploy.sh`, then `restore.sh` (or `restore.sh --archive <stamp>`) before
sharing the link: it verifies the archive's sha256 locally and again on the
VM, refuses a non-empty `/srv/min-atoms/projects`, unpacks, re-checks with
`tar --diff`, reinstalls each workspace's dependencies from its own lockfile
inside `min-atoms/project` as the app user, and waits for manager health.
Containers are recreated on first project open. Control-plane data stays in
Supabase, which the daily keepalive keeps active.

Local checks:

```sh
shellcheck infra/vm/*.sh
python3 infra/vm/tests/private-env.py
python3 infra/vm/tests/cloudflare-ingress.py
python3 infra/vm/tests/docker-dns.py
python3 infra/vm/tests/deep-archive.py
python3 infra/vm/tests/spot-idle.py
infra/vm/up.sh --dry-run
infra/vm/bootstrap.sh --dry-run
infra/vm/cloudflare.sh --dry-run
infra/vm/deploy.sh --dry-run
infra/vm/destroy.sh --dry-run
infra/vm/archive.sh --dry-run
infra/vm/restore.sh --dry-run
infra/vm/destroy.sh --vm-only --dry-run
infra/vm/up.sh --from-snapshot --dry-run
git diff --check
```

Real health, preview HTTP/WebSocket, model-key injection, metadata blocking and
reboot acceptance are performed by the PM on the target VM.
The credential regression check uses dummy private files, a local gcloud stub
that captures SSH stdin, and a health-response stub; it never contacts the VM.
The ingress regression check uses a local cf stub and dummy records only.
The DNS check uses fake host files and command stubs; it never invokes real
Docker, systemd or cloud commands. The deep archive check uses gcloud/cf stubs
and a fake bucket directory to cover ordering, readback, snapshot-before-delete
and revive guards.

References: [cloudflared apt repository](https://pkg.cloudflare.com/),
[Caddy reverse proxy placeholders and headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
