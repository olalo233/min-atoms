# min-atoms

A short-lived showcase demo: describe a small app in natural language, an AI
agent builds a real full-stack app inside a per-project container, and you
watch it appear live in the browser, try it, and keep iterating through
numbered versions.

It is a demo, not a product: one built-in account, a small invited audience,
development servers, and a manually operated VM. See
[Demo boundaries](#demo-boundaries).

Status: delivered. The core loop — sign-in, project creation, build/chat
runs, persistence, live preview, versions, and restore — has been verified end
to end against the production deployment with a real model. See
[Completion and trade-offs](#completion-and-trade-offs).

Live demo: <https://project-delta-seven-23.vercel.app> (the demo account is
shared with the invitation; the VM is started on demand, see
[Demo boundaries](#demo-boundaries)).

## How it works

1. The user signs in to a Next.js control plane (deployed on Vercel) with the
   seeded demo account, creates a project, and sends messages in **Build**
   mode (may change the app) or **Chat** mode (discussion only).
2. Each user message creates a **run**. Runs execute one at a time per
   project: `queued → running → succeeded | failed | cancelled`.
3. The web API hands work to the **manager**, a Bun + Hono service on a single
   GCP VM that the control plane reaches through a dedicated Cloudflare
   tunnel with a shared bearer secret.
4. The manager starts (or reuses) the project's Docker container on a private
   bridge network. The container is named after the project's preview label
   (`ma-<8 chars>`) and runs the scaffold's dev servers plus the `omp`
   coding agent.
5. Build runs drive `omp` inside the container. The agent's model calls go to
   a **gateway** container (Caddy) on the same network, which reverse-proxies
   the model API and injects the provider key — project containers never hold
   it.
6. Ordered **run events** (status, text, thinking, tool steps, version,
   error) are persisted in Postgres and streamed to the browser over SSE
   authorized by a short-lived token.
7. After a successful build, the workspace is verified (`bun run check`, with
   bounded repair attempts) and committed: a numbered **version** that is
   never rewritten. The app's dev server is already live at its preview host
   `ma-<random>.expii.top`, which the gateway routes straight to the
   container's Vite port; the UI shows it in an iframe.
8. **Restore** creates a new version whose code equals an older version.
   History stays linear and app data is untouched.

Two data stores, deliberately separate:

- **Postgres** holds control-plane data — users, sessions, projects,
  messages, runs, run events, versions, and the preview-host pool
  (`packages/db`, Drizzle schema and migrations).
- **SQLite** is the generated app's own database at `/data/app.db` inside its
  container, bind-mounted outside the git workspace, so it survives code
  changes and restores.

## Repository layout

- `apps/web/` — Next.js control plane (auth, projects, messages, versions,
  SSE token issuing, manager client).
- `apps/manager/` — Bun + Hono host service: containers, run queue, omp
  driver, event stream. Binds `127.0.0.1:8090`.
- `packages/protocol/` — shared zod schemas (manager API, run events, web
  DTOs, SSE token).
- `packages/db/` — Drizzle schema, client, migrations, seed.
- `templates/fullstack/` — scaffold copied into every generated app
  (Vite + React + Hono + SQLite; its `AGENTS.md` is a runtime asset shipped
  with the image, not a workspace member).
- `infra/image/` — Dockerfile for `min-atoms/project`: Bun, Node, `omp`,
  Chromium, the scaffold, and agent config pointed at the gateway.
- `infra/gateway/` — Caddy config: routes `ma-*.expii.top` to project
  containers and proxies the model API on a network-internal listener with
  key injection.
- `infra/vm/` — operator scripts for the demo VM (see below).
- `fixtures/` — recorded `omp` NDJSON and sample run events for
  deterministic, credential-free tests.

## Local development

Prerequisites: Bun, Node.js, and Docker (for a local Postgres).

```sh
bun install
docker compose up -d postgres          # Postgres 17 on 127.0.0.1:5432

# Replace the placeholder values.
export DATABASE_URL='postgres://min_atoms:min_atoms@127.0.0.1:5432/min_atoms'
export SESSION_SECRET='<random-string>'
export DEMO_PASSWORD='<choose-a-password>'

# The seed requires a nonempty file of valid preview-host labels.
export PREVIEW_HOSTS_FILE="$(mktemp)"
printf '%s\n' 'ma-local001' > "$PREVIEW_HOSTS_FILE"

bun run db:migrate
bun run db:seed
bun run dev                            # http://localhost:3000
```

`bun run db:seed` creates the demo user (`DEMO_USERNAME`, default `demo`) and
loads the preview-host pool from `PREVIEW_HOSTS_FILE`
(default `~/.config/min-atoms/preview-hosts.txt`): one `ma-<8 lowercase
letters or digits>` label per line. The file is private runtime input — the
seed does not create it — so keep real hostnames out of the repository. For
local development a synthetic label like `ma-local001` is enough; labels only
become real hostnames on the deployed VM.

The login page renders without a database, but signing in requires the
migrated and seeded Postgres above.

### Configuration names

Set these as environment variables; values are deployment-specific and none
belong in the repository.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | web, db scripts, manager | Postgres connection string (manager requires the session pool on port 5432). |
| `SESSION_SECRET` | web | HMAC-hashes the opaque session tokens stored in Postgres; browsers hold an opaque cookie, not a signed value. |
| `MANAGER_URL` | web | Manager base URL, e.g. its tunnel hostname. |
| `MA_SHARED_SECRET` | web + manager | Shared bearer secret on manager API calls and SSE tokens. |
| `WEB_ORIGIN` | manager | Exact web origin allowed on the browser event stream. |
| `CRON_SECRET` | web | Bearer check on `/api/cron/keepalive`. |
| `DEMO_USERNAME` / `DEMO_PASSWORD` | db seed | Credentials for the single demo account. |
| `PREVIEW_HOSTS_FILE` | db seed | File of preview-host labels (see above). |
| `NEXT_PUBLIC_MOCK_STREAM` | web (dev only) | `1` renders the UI with a mocked run stream, no manager needed. |

The manager additionally accepts `HOST`/`PORT` but refuses anything other
than `127.0.0.1:8090`.

### The manager service

On the VM the `ma-manager.service` unit runs the entrypoint via
`infra/vm/manager.sh` (`bun apps/manager/src/index.ts`, the same code as
`bun run --cwd apps/manager start`). Before binding, that entrypoint
initializes the runtime — it ensures the `ma-net` Docker network exists and
starts `ma-gateway` through systemctl if absent — so it only comes up on the
provisioned Linux VM or an equivalently prepared Docker host, not on an
ordinary checkout with just its three variables. For local control-plane
work, use `NEXT_PUBLIC_MOCK_STREAM=1` for UI development, or point
`MANAGER_URL`/`MA_SHARED_SECRET` at a deployed manager for real builds.
For real builds, the web and manager must use the same configured Postgres
database and provisioned preview-host pool; the synthetic local setup above
is for UI development.

### Checks

```sh
bun test          # workspace tests (Vitest + Bun tests, PGlite — no external services)
bun run lint      # eslint + tsc --noEmit across workspaces
bun run build     # per-workspace checks plus the Next.js production build
```

## Deploying the demo VM

`infra/vm/` contains operator runbooks for the demo's own fixed environment —
the GCP project, zone, VM name, and `expii.top` DNS zone are constants in
`infra/vm/common.sh`, not parameters. The scripts refuse to operate on a VM
whose ownership labels differ, manage only `ma-*.expii.top` DNS records
carrying the `min-atoms` comment plus one dedicated tunnel, and every script
accepts `--dry-run`. They are a scoped deployment for this demo, not a
portable installer.

Prerequisites on the operator machine: bash, `gcloud`, `jq`, `curl`, the
Cloudflare `cf` CLI, an authorized SSH identity, and two private files that
are never committed — `~/.config/min-atoms/env` (systemd-style
`TUNNEL_TOKEN`, `DATABASE_URL`, `MA_SHARED_SECRET`, `WEB_ORIGIN`) and
`~/.config/min-atoms/deepseek.key`.

Standard flow:

1. `infra/vm/cloudflare.sh` — creates/reuses the dedicated tunnel, sets
   ingress (`ma-vm.expii.top` → manager, wildcard → gateway), verifies the
   scoped DNS records, and saves a private pool of preview hostnames for
   seeding.
2. `infra/vm/up.sh --skip-health` — creates the `e2-standard-4` VM (no
   service account, no scopes) or starts it if stopped. Later runs wait for
   manager health instead.
3. `infra/vm/bootstrap.sh` — installs Docker, cloudflared, and Bun on the VM,
   installs the four systemd units (firewall, cloudflared, gateway, manager),
   and starts them.
4. `infra/vm/deploy.sh` — ships the source archive to `/opt/min-atoms`,
   installs manager dependencies from the frozen lockfile, builds the
   `min-atoms/project` image, restarts the services, and waits for health.
5. `infra/vm/down.sh` stops the VM and keeps its disk (workspaces and app
   data persist). `infra/vm/destroy.sh --confirm-destroy` is the final
   teardown: it deletes only the owned VM, the scoped DNS records, and the
   dedicated tunnel, each confirmed by readback.

For long idle periods, `infra/vm/archive.sh` copies only the data a rebuild
cannot recreate (each project's Git workspace, app SQLite data and agent
state; no dependencies, build output, image or OS) to a dedicated Cloudflare
R2 bucket, verifies it, and stops the VM. `infra/vm/destroy.sh --vm-only
--confirm-destroy` then snapshots the stopped disk and deletes just the VM and
its disk, keeping the tunnel and preview hostnames. `infra/vm/up.sh
--from-snapshot` brings the VM back as it was; steps 2–4 plus
`infra/vm/restore.sh` rebuild it from the R2 copy instead. Details are in
`infra/vm/README.md`.

The web app deploys separately to Vercel (`apps/web/vercel.json`: `hnd1`
region, plus a daily `SELECT 1` keepalive cron guarded by `CRON_SECRET`).
`deploy.sh` does not build or transfer it.

## Completion and trade-offs

Done:

- Test-account sign-in (salted password hashes, no registration), project
  list, create/reopen/delete.
- Real agent builds of tools and browser games (calculator, todo list, snake
  with Canvas/keyboard/timers) inside isolated per-project containers, with
  live run events, a resumable SSE stream, stop, and failure feedback.
- Build vs. Chat modes with the full multi-turn conversation as context.
- Two kinds of persistence: control-plane data in Postgres, each generated
  app's own SQLite data on the VM disk across code changes and restores.
- Numbered versions with linear restore; failed runs never replace the last
  good version.
- Responsive UI from 360px to 1600px+: chat/preview tabs below 1024px, a
  split workbench above, and a preview iframe that never reloads on events.

Trade-offs:

- A real container per project (Docker on one VM) instead of in-browser
  sandboxes, so generated apps can use a real backend, database, and any
  browser API. The cost is a manually operated VM and a small capacity.
- The agent runtime is an off-the-shelf coding agent (`omp`) driven through
  its RPC mode instead of a hand-rolled tool loop; the platform focuses on
  isolation, run orchestration, events, and versions.
- Generated apps run as dev servers behind a gateway for instant HMR, not as
  production builds; the model key is injected by the gateway and never
  enters a project container.

Known limitations:

- Agent self-tests can create test records in the generated app's database.
  Platform instructions require self-tests to be read-only and to never
  modify existing records; in the last targeted check the agent created one
  test record and removed it by id while existing rows stayed unchanged, but
  an earlier rehearsal also edited one existing row. This is an
  instruction-level boundary, not enforced isolation.
- One shared demo account and serial runs per project; see below.

## Demo boundaries

- **One account.** Sign-in is a single seeded demo account shared with a
  small group of invited users who reach it over their VPN. There is no
  registration and no per-user isolation beyond per-owner project checks.
- **Development previews.** Generated apps run their dev servers (Vite on
  5173 plus a Hono API) behind the gateway — live demos, not production
  hosting or public publishing.
- **Linear, code-only restore.** Restoring creates a new version equal to an
  older commit; nothing is rewritten. App data lives outside the workspace
  and is preserved across versions and restores by design.
- **Trusted-agent data protection.** The image-level platform instructions
  (`infra/image/omp-platform-AGENTS.md`, installed into the agent's context
  and persisting across restores) tell the agent that during self-tests it
  must not change or delete existing records; new, identifiable test records
  may be removed only by their ids. This is a trusted-agent instruction
  boundary, not enforced isolation.
- **Small capacity, serial runs.** One run at a time per project; a handful
  of project containers run concurrently and the least-recently-used idle
  ones are stopped. Files persist on the VM disk.
- **Manual lifecycle.** The operator runs `up.sh`/`down.sh`/`destroy.sh`
  explicitly. There is no autoscaling, failover, or unattended recovery.
- **Key handling.** The model provider key exists only in the VM environment
  and the gateway container; the manager unit explicitly unsets
  `DEEPSEEK_API_KEY` (`UnsetEnvironment`), so neither the manager nor project
  containers ever hold it. Containers also cannot reach the cloud metadata
  endpoint — an `iptables` DROP rule the manager verifies before container
  create/start/restart operations.
