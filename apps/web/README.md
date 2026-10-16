# Web runtime wake-up

In addition to the web environment variables in the root README, configure these
server-only variables on the web host. Never prefix them with `NEXT_PUBLIC_`.

| Variable | Purpose |
| --- | --- |
| `CONTROLLER_URL` | Runtime controller base URL. The web server calls `GET /status` and `POST /wake` with a 5-second deadline. |
| `CONTROLLER_TOKEN` | Bearer token matching the controller's `WAKE_TOKEN`. |

When either is absent the web still probes the manager as before. A healthy
manager always reports running; otherwise runtime status is unavailable. Signed-in
users can retry without exposing controller configuration to the browser.

For local visual review, run `NEXT_PUBLIC_MOCK_STREAM=1 bun run dev` in this directory.
Open `/p/mock?scenario=env-<phase>` with `checking`, `starting`, `restoring`,
`stopping`, `retiring`, `retired`, `running`, `error`, or `unavailable`.
`env-down` remains an alias for a stopped environment and automatically moves to
starting. `env-retired` moves to restoring. Error/unavailable retry moves to starting.
These mock phases stay in place for inspection; they do not simulate live cloud
completion. On narrow screens use the “预览” tab to inspect the waiting panel;
the queued run also reports runtime status in the conversation.
