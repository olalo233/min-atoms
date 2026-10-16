# Runtime controller

A plain TypeScript Cloudflare Worker with `fetch` and `scheduled` handlers.
No runtime dependencies. It exchanges an RS256 service-account JWT for a
Compute-scoped OAuth token and caches the token until one minute before expiry.
Only Google OAuth and Compute REST v1 are called. There is no VM service account.

## HTTP contract

Both endpoints require `Authorization: Bearer <WAKE_TOKEN>` (401 otherwise).
Responses use `Cache-Control: no-store`. Other paths/methods return 404.

- `GET /status` → `{ phase, detail? }`, with no side effects.
- `POST /wake` → `{ phase, detail? }`: starts a stopped VM, recreates a retired
  VM from the newest READY `app=min-atoms` snapshot, or returns the current
  running/starting/restoring/stopping/retiring phase without another mutation.
  An insert conflict returns `restoring`. A failed asynchronous wake remains
  visible in status and a later wake retries it.

Phases: `running | starting | stopping | stopped | retiring | retired |
restoring | unavailable | error`. Details are short Chinese messages, never
Google error bodies, resource identifiers, IPs or tokens. Spot stock-out returns
`{"phase":"error","detail":"Spot 资源暂时不足，请稍后重试"}`.

The web backend holds `WAKE_TOKEN`; do not give it to a browser. The matching
web integration is deployed separately from this package.

## Retirement and retention

Cron `*/10 * * * *` acts only on `min-atoms-vm` with `app=min-atoms`, after
`TERMINATED` has lasted 120 minutes since `lastStopTimestamp`. Each tick:

1. Wait for any instance operation still in progress.
2. Create a labeled regional snapshot of this boot disk if none was created
   strictly after this stop. Snapshot names are `min-atoms-vm-yyyymmddthhmmssz`.
3. Wait while the snapshot is CREATING/UPLOADING; log and stop if FAILED.
4. For READY, re-read the instance. Delete only if still TERMINATED with the
   same stop timestamp and the boot disk is `min-atoms-vm`, `autoDelete=true`.
5. After observing instance absence, keep the newest two READY `app=min-atoms`
   snapshots. Never prune a copy while a newer snapshot is not READY; re-read
   ownership/readiness before deleting each old snapshot.

Operations can span ticks. Zone operation history supplies `starting`,
`restoring`, `retiring` and asynchronous Spot errors without an extra database.
Snapshot/operation listings follow pagination. JSON decision logs contain only
the component and a fixed decision string. After an error, inspect operator
logs and Google operation details privately; HTTP never exposes them.

Restore mirrors `infra/vm/up.sh`: t2d-standard-2, SPOT/STOP,
automaticRestart=false, onHostMaintenance=TERMINATE, 50 GB pd-balanced boot disk
with autoDelete, default network/subnetwork, ONE_TO_ONE_NAT/PREMIUM external IP,
integrity monitoring + vTPM, secure boot off, `block-project-ssh-keys=true`, the
tmars SSH public key, and an empty serviceAccounts array. Tunnel/DNS are kept.

## Configuration and deployment (PM only)

Use Node.js 22.18+ with the official `cf` CLI, pinned to `1.0.0-beta.12`.
The pinned Cloudflare Vite plugin builds the standard cf Build Output; neither
deployment nor tests invoke Wrangler. The plain Worker itself has no framework.
`cloudflare.config.ts` enables workers.dev only, disables preview version URLs,
and declares the cron with no custom routes or zone changes.

Plain variables: `GCP_PROJECT`, `GCP_ZONE`, `VM_NAME`, `SSH_PUBLIC_KEY`,
`RETIRE_AFTER_MINUTES` (120), `KEEP_SNAPSHOTS` (2). `SSH_PUBLIC_KEY` comes from
`MA_SSH_PUBLIC_KEY` in the deploy environment (key type and base64 data, e.g.
`MA_SSH_PUBLIC_KEY="$(cut -d' ' -f1,2 ~/.ssh/google_compute_engine.pub)"`);
without it the placeholder is deployed and restore-from-snapshot is refused.
The username is always tmars.

Worker secrets (never store values in this checkout):

- `GCP_SA_KEY`: the dedicated service account's JSON key, including client_email
  and PKCS#8 private_key. Google token URL and scope are fixed in code, rather
  than taken from the JSON key.
- `WAKE_TOKEN`: a random shared bearer token, also set on the web backend.

PM procedure, after the required cloud-operation approval:

1. Create the dedicated service account and custom role below; bind it only in
   `hy2-seoul-relay-20260728`. Enable Compute API if not already enabled. Keep
   the key in private operator storage. Do not attach the account to the VM.
2. From `apps/controller`, use the locally installed CLI through Node (not Bun):

   ```sh
   ./node_modules/.bin/cf cli search "deploy worker"
   ./node_modules/.bin/cf deploy --help
   ./node_modules/.bin/cf auth whoami
   ./node_modules/.bin/cf deploy --dry-run
   ```

3. Deploy the Worker with `cf deploy` (the first deployment without secrets
   rejects HTTP auth and cron does nothing), then set its secrets. The config
   declares only plain variables, so initial deployment does not require
   secrets to exist already; cf preserves separately stored secrets on later
   deploys. Discover
   and inspect the current commands before using the generated API CLI:

   ```sh
   ./node_modules/.bin/cf cli search "worker secrets"
   ./node_modules/.bin/cf workers secrets update --help
   ./node_modules/.bin/cf schema workers secrets update
   ```

   In cf beta.12, `cf workers secrets update GCP_SA_KEY --worker
   min-atoms-controller --type secret_text --body @/PRIVATE/request.json`
   accepts a private JSON body shaped `{ "name": "GCP_SA_KEY", "type":
   "secret_text", "text": "<service-account JSON string>" }`. Repeat for
   WAKE_TOKEN using its own private body file. Do not pass the secret itself
   with `--text`, which would expose it in shell history/process arguments.
   These API calls create versions; run `cf deploy` again to activate this
   package with both existing secrets and apply its cron triggers. Verify
   secret names with `cf workers secrets list --worker min-atoms-controller`.
4. Read back workers.dev/cron configuration. Using a private HTTP client, verify
   401 without a token, status with a token, stopped→starting→running, then
   retired→restoring→running and the preserved project data/SSH access. Verify
   snapshot READY precedes VM/disk deletion and only two READY snapshots remain.
   Configure the web backend's controller URL and matching wake secret there.

No executor live acceptance is implied by the local checks below. Never use
real secrets for local tests. `.dev.vars*`, `.env*`, build output and generated
Cloudflare files are ignored.

## Minimal custom IAM role

For the exact REST requests and explicit insert fields used here:

```text
compute.instances.get
compute.instances.start
compute.instances.create
compute.instances.delete
compute.instances.setMetadata
compute.instances.setLabels
compute.disks.create
compute.disks.use
compute.disks.delete
compute.disks.createSnapshot
compute.snapshots.create
compute.snapshots.get
compute.snapshots.list
compute.snapshots.delete
compute.snapshots.useReadOnly
compute.snapshots.setLabels
compute.zoneOperations.list
compute.networks.use
compute.subnetworks.use
compute.subnetworks.useExternalIp
```

`instances.insert` needs create/metadata/labels, boot disk creation/use,
snapshot useReadOnly, and the explicit network/subnetwork + external IP
permissions. Instance deletion also deletes its autoDelete boot disk.
`snapshots.insert` needs snapshots.create/setLabels and
disks.createSnapshot on the source disk. Snapshot get/list/delete support
readback, restore selection and retention. Zone operation list supplies status
and async errors. The Worker does not call disk get/setLabels, operation get
or global/region operation APIs, so those permissions are not included. It
does not set disk labels, IAM, service accounts, DNS, tunnels, routes or secrets.
No serviceAccountUser/actAs or project-wide Compute Admin role is needed.

Sources: [instances.insert and its field-level permissions](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/insert),
[snapshots.insert](https://docs.cloud.google.com/compute/docs/reference/rest/v1/snapshots/insert),
[zoneOperations.list](https://docs.cloud.google.com/compute/docs/reference/rest/v1/zoneOperations/list).
This is a request-derived role list; PM verifies the actual IAM grant during
the authorized live wake/retire acceptance.

## Local checks

From the repository root:

```sh
bun test ./apps/controller
bun run --filter @min-atoms/controller check
for t in infra/vm/tests/*.py; do python3 "$t" || exit 1; done
shellcheck infra/vm/*.sh
git diff --check
```

Tests inject a clock and fake Google fetch endpoints, and generate a throwaway
RSA key to verify JWT signatures. They require no credentials or cloud access.
Dev dependencies added for the official cf build path: cf 1.0.0-beta.12,
@cloudflare/vite-plugin 2.0.0-beta.v.0 and Vite 8.3.0 (MIT or MIT/Apache-2.0).
