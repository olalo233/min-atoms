# min-atoms

min-atoms turns one Build Request into a small interactive web application. A
signed-in user creates a Project, watches a persisted generation job, tries the
sandboxed Preview, and evolves the result through immutable artifact versions.
Generated app data belongs to the Project, so it survives preview reloads and
version changes.

## Demo account

Registration is intentionally disabled. After seeding, sign in with:

- Username: `demo`
- Password: `min-atoms-demo`

## Run locally

Prerequisites: a current Node.js LTS release, npm, and Docker or Podman with
Compose support.

1. Copy `.env.example` to `.env` and provide the variables listed below.
2. Start PostgreSQL: `docker compose up -d postgres`
3. Install packages from the lockfile: `npm ci`
4. Apply migrations: `npm run db:migrate`
5. Seed the Demo User: `npm run db:seed`
6. Start the app: `npm run dev`

Open `http://localhost:3000`. Use `npm run build` and `npm start` to exercise
the production build locally.

Required configuration names are `DATABASE_URL`, `SESSION_SECRET`,
`DEMO_USERNAME`, and `DEMO_PASSWORD`. `GENERATION_PROVIDER=deterministic`
makes local acceptance reproducible; set it to `deepseek` only when
`DEEPSEEK_API_KEY` is present. `DEEPSEEK_MODEL` defaults to
`deepseek-v4-flash`. Do not commit `.env`. The checked-in Compose service uses
local development-only credentials and exposes PostgreSQL on `127.0.0.1:5432`.

## Quality checks

```sh
npm run lint          # ESLint
npm test              # deterministic unit and component tests
npm run build         # production build
npm run test:e2e      # local PostgreSQL browser journey (migrates and seeds)
npm run db:generate   # regenerate Drizzle migration files when schema changes
env DOTENV_CONFIG_PATH=.env NODE_OPTIONS='-r dotenv/config' npm run smoke:deepseek
```

`npm run test:e2e` does not start, stop, or remove Docker resources. It expects
`docker compose up -d postgres` to be healthy, targets only local PostgreSQL,
and uses the public Demo User defaults. Before the first browser run, install
the test runtime with `npx playwright install chromium`. Set `E2E_DATABASE_URL`,
`E2E_DEMO_USERNAME`, `E2E_DEMO_PASSWORD`, or `E2E_SESSION_SECRET` only for a
separate local test database or account.

The DeepSeek smoke check is opt-in: it skips when no API key is configured and
never belongs in a credential-free test run.

## Architecture and safety boundaries

Next.js/React serves the workspace and API; PostgreSQL with Drizzle stores
users, Projects, Build Requests, jobs, events, artifact versions, and generated
data. The generation provider is replaceable: deterministic output supports
tests, while the server-side DeepSeek provider returns a constrained four-file
artifact (`index.html`, `styles.css`, `app.js`, `manifest.json`). A validator
limits shape and size and checks the manifest and JavaScript syntax.
QuickJS/WASM then runs the manifest-declared click with strict time and memory
limits as one repair signal inside a bounded loop of up to ten total attempts.

Passwords are bcrypt-hashed with a salt. Sessions are opaque, HMAC-hashed,
HttpOnly, SameSite cookies; login failures are generic and rate-limited. The
Preview runs in a script-only sandbox with a restrictive CSP: generated code
has no network access, while the platform may load one approved CSS preset.
Its narrow `postMessage` bridge validates source, project, artifact version,
operation, keys, and values before accessing Project-scoped data.

## Scope, trade-offs, and next steps

The completed local slice covers login, Project creation, visible job progress,
validated interactive previews, persistent generated data, follow-up Build
Requests, immutable version history, and explicit restore of a successful
version. It deliberately does not offer public registration, source editing,
arbitrary dependencies, external network access from generated apps, or cloud
deployment outside the configured Vercel and Supabase production stack.

The constrained artifact format makes safety and repeatable evaluation more
important than general-purpose code generation. The browser acceptance command
covers login, v1, persisted counter data, v2, non-mutating version inspection,
explicit restore, and reopening. Next priorities are a durable background
worker for multi-process operation and production deployment configuration with
managed secrets.

### Generated UI presets

The generation harness combines the runtime contract with versioned frontend
design guidance. It asks the model to ground each interface in its subject,
choose a distinctive visual direction, critique generic defaults, and preserve
responsive, keyboard, and reduced-motion quality floors.

Artifacts select one platform-controlled CSS preset in `manifest.json`:
`min-atoms-base`, `pico-2`, or `bootstrap-5`. The Preview resolves that ID from
an internal catalog and injects its fixed CDN stylesheet under a narrowly
generated CSP. Generated artifacts may use semantic HTML and ordinary browser
APIs, while the CSP and iframe sandbox block external network access,
top-level navigation, submissions, popups, and downloads. CSS presets improve
the baseline without granting third-party JavaScript access to generated app
data.
