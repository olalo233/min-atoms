import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "min-atoms-controller",
    compatibilityDate: "2026-10-16",
    entrypoint,
    workersDev: true,
    previewUrls: false,
    triggers: [triggers.scheduled({ schedule: "*/10 * * * *" })],
    env: {
      GCP_PROJECT: bindings.text("hy2-seoul-relay-20260728"),
      GCP_ZONE: bindings.text("asia-northeast1-b"),
      VM_NAME: bindings.text("min-atoms-vm"),
      // Supplied at deploy time (MA_SSH_PUBLIC_KEY); the Worker refuses to restore with the placeholder.
      SSH_PUBLIC_KEY: bindings.text(process.env.MA_SSH_PUBLIC_KEY ?? "ssh-ed25519 REPLACE_WITH_TMARS_PUBLIC_KEY"),
      RETIRE_AFTER_MINUTES: bindings.text("120"),
      KEEP_SNAPSHOTS: bindings.text("2"),
    },
  },
});
