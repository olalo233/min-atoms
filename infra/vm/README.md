# VM operations

These scripts are run by the PM after authorization. `--dry-run` only prints
commands: it never invokes gcloud/cf, opens private files, or changes the host.
Use Bash, gcloud, jq, curl and the official Node.js `cf` CLI (1.0.0-beta.12).
If `cf` is shadowed, use `CF_BIN=cloudflare` for the Cloudflare scripts.
The GCP project, VM, zone and Cloudflare zone are fixed in `common.sh`.

SSH prerequisite: the existing IAP firewall must allow this VM, and the PM must
authorize the public key for `tmars` on this VM only, with
`block-project-ssh-keys=true`. The local identity must already exist at
`~/.ssh/google_compute_engine`; scripts never create keys or manage project or
instance SSH metadata. All remote commands use the following connection flags
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
four systemd units and starts the firewall before gateway and manager.
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

`down.sh` stops the VM and retains its disk. `destroy.sh --confirm-destroy` is
only for a user-requested final teardown: it deletes the owned VM, scoped DNS
CNAMEs with the exact `min-atoms` comment and dedicated tunnel target, then the
dedicated tunnel, confirming each deletion by readback. It retains local private
files for PM disposal and does not alter other DNS, Access or zone settings.

Local checks:

```sh
shellcheck infra/vm/*.sh
python3 infra/vm/tests/private-env.py
python3 infra/vm/tests/cloudflare-ingress.py
infra/vm/up.sh --dry-run
infra/vm/bootstrap.sh --dry-run
infra/vm/cloudflare.sh --dry-run
infra/vm/deploy.sh --dry-run
infra/vm/destroy.sh --dry-run
git diff --check
```

Real health, preview HTTP/WebSocket, model-key injection, metadata blocking and
reboot acceptance are performed by the PM on the target VM.
The credential regression check uses dummy private files, a local gcloud stub
that captures SSH stdin, and a health-response stub; it never contacts the VM.
The ingress regression check uses a local cf stub and dummy records only.

References: [cloudflared apt repository](https://pkg.cloudflare.com/),
[Caddy reverse proxy placeholders and headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
