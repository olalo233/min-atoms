# min-atoms

A short-lived showcase for building small full-stack applications with an AI agent.

## Repository

- `apps/web`: Next.js control plane; authentication is available.
- `apps/manager`: Bun + Hono host service; currently serves only `/health`.
- `packages/db`: PostgreSQL schema, client factory, migrations, message sequencing, and seed.
- `packages/protocol`: shared contract skeleton.

## Local development

Use Bun and Node.js (the web production runtime). Run `bun install`, then
`bun run dev` and open `http://localhost:3000/login`. The login page opens without
credentials; signing in requires a seeded PostgreSQL database.

For a local database, run `docker compose up -d postgres`. Export the variables
from `.env.example`, set `DEMO_PASSWORD`, and provide a private preview-host list
at `PREVIEW_HOSTS_FILE` (default `~/.config/min-atoms/preview-hosts.txt`). The file
accepts one `ma-<8 lowercase letters or digits>` label or full `expii.top` hostname
per line. Then run `bun run db:migrate` and `bun run db:seed`. The seed is repeatable
and never assigns or clears existing project bindings.

`DATABASE_URL` is supplied explicitly to each process. The web connection factory
disables prepared statements for Supabase's transaction pooler. No secrets or
preview hosts belong in the repository.

## Checks

```sh
bun install
bun run build
bun test
bun run lint
```

The root test entry point runs each workspace's test script. Web retains its
existing Vitest authentication suite; manager and database use Bun tests.
Protocol has no behavior or tests yet. Database contract tests use an embedded
PostgreSQL engine and require no external credentials.

Start manager with `bun run --cwd apps/manager start`; it listens on
`127.0.0.1:8090`. Database operations and later business capabilities are separate
from this skeleton.
