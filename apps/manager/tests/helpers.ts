import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectFiles } from "../src/project-files";
import { ProjectRuntime, type Spawn } from "../src/runtime";
import type { ManagerStore, RuntimeProject, StoredEvent } from "../src/store";
import type { RunEvent } from "@min-atoms/protocol";
import type { HeartbeatTimers } from "../src/events";
import { createManager } from "../src/manager";

export const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
export const label = (number: number) => `ma-${String(number).padStart(8, "0")}`;
export const secret = "test-shared-secret";
export const origin = "https://web.example";
export const at = "2026-10-09T00:00:00.000Z";
export const textEvent = (seq: number, runId = id(101)): RunEvent => ({ runId, seq, at, kind: "text", delta: `完整正文 ${seq}\n` });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class MemoryStore implements ManagerStore {
  projects = new Map<string, RuntimeProject>();
  runningProjects = new Set<string>();
  rows: Array<StoredEvent & { projectId: string }> = [];
  queued: string[] = [];
  async project(projectId: string) { return this.projects.get(projectId); }
  async busy(projectId: string) { return this.runningProjects.has(projectId) || this.queued.includes(projectId); }
  async running(projectId: string) { return this.runningProjects.has(projectId); }
  async backlog(projectId: string, after: number) {
    return this.rows.filter(row => row.projectId === projectId && row.id > after).map(({ id, event }) => ({ id, event }));
  }
  async appendEvents(projectId: string, events: RunEvent[]) {
    const rows = events.map(event => ({ id: this.rows.length + 1, projectId, event }));
    // Allocate IDs sequentially within the simulated durable write.
    for (const row of rows) { row.id = this.rows.length + 1; this.rows.push(row); }
    return rows.map(({ id, event }) => ({ id, event }));
  }
  async recover() { return []; }
  async queuedProjects() { return [...new Set(this.queued)]; }
  add(number: number) {
    const project = { id: id(number), previewLabel: label(number) };
    this.projects.set(project.id, project);
    return project;
  }
}

export class ControlledTimers implements HeartbeatTimers {
  callbacks = new Set<() => void>();
  intervals: number[] = [];
  every(callback: () => void, ms: number) {
    this.intervals.push(ms); this.callbacks.add(callback);
    return () => { this.callbacks.delete(callback); };
  }
  tick() { for (const callback of this.callbacks) callback(); }
}

type FakeContainer = {
  name: string; labels: Record<string, string>; running: boolean; startedAt: string;
  mounts: Array<{ Source: string; Destination: string }>; ip: string;
};

// Fake ONLY at the subprocess seam. All HTTP, runtime orchestration, ownership,
// capacity, filesystem, readiness, and stream code remains production code.
export class DockerProcess {
  commands: string[][] = [];
  containers = new Map<string, FakeContainer>();
  firewall = true;
  network: string | undefined = "bridge";
  gatewayRunning = true;
  unavailable = false;
  spawn: Spawn = async argv => {
    this.commands.push([...argv]);
    if (this.unavailable) return { exitCode: 1, stdout: "" };
    const ok = (stdout = "") => ({ exitCode: 0, stdout });
    if (argv[0] === "iptables") return { exitCode: this.firewall ? 0 : 1, stdout: "" };
    if (argv[0] === "systemctl") { this.gatewayRunning = true; return ok(); }
    if (argv[1] === "network") {
      if (argv[2] === "inspect") return { exitCode: this.network ? 0 : 1, stdout: this.network ?? "" };
      this.network = "bridge"; return ok("fake-network");
    }
    if (argv[1] === "ps") return ok([...this.containers.keys(), "ma-gateway", "unrelated"].join("\n"));
    if (argv[1] === "container" && argv[2] === "inspect") {
      const name = argv.at(-1)!;
      if (name === "ma-gateway") return ok(String(this.gatewayRunning));
      const container = this.containers.get(name);
      return container ? ok(JSON.stringify({ ...container, name: `/${name}` })) : { exitCode: 1, stdout: "" };
    }
    const name = argv[2];
    if (argv[1] === "create") {
      const values = (flag: string) => argv.flatMap((value, index) => value === flag ? [argv[index + 1]] : []);
      const container: FakeContainer = {
        name: values("--name")[0], running: false, startedAt: at, ip: "172.20.0.2",
        labels: Object.fromEntries(values("--label").map(value => value.split("="))),
        mounts: values("--mount").map(value => {
          const parts = Object.fromEntries(value.split(",").map(part => part.split("=")));
          return { Source: parts.src, Destination: parts.dst };
        }),
      };
      this.containers.set(container.name, container); return ok("fake-container-id");
    }
    const container = this.containers.get(name);
    if (!container) throw new Error(`Unexpected fake process command: ${argv.slice(0, 3).join(" ")}`);
    if (argv[1] === "start") container.running = true;
    else if (argv[1] === "stop") container.running = false;
    else if (argv[1] === "rm") this.containers.delete(name);
    else throw new Error("Unexpected process command");
    return ok();
  };

  add(project: RuntimeProject, root: string, running = true, startedAt = at) {
    const container: FakeContainer = {
      name: project.previewLabel, running, startedAt, ip: "172.20.0.2",
      labels: { "min-atoms.managed": "true", "min-atoms.role": "project",
        "min-atoms.project-id": project.id, "min-atoms.preview-label": project.previewLabel },
      mounts: ["workspace", "data", "state"].map(name => ({ Source: `${root}/${project.id}/${name}`, Destination: `/${name}` })),
    };
    this.containers.set(container.name, container);
    return container;
  }
}

export async function harness() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "t11-manager-"));
  const store = new MemoryStore();
  const docker = new DockerProcess();
  const timers = new ControlledTimers();
  let now = Date.parse(at);
  let readiness = true;
  const probes: Array<{ ip: string; timeout: number }> = [];
  const files = new ProjectFiles(root, { uid: process.getuid!(), gid: process.getgid!() });
  const runtime = new ProjectRuntime(store, {
    files, spawn: docker.spawn, clock: { now: () => now, async sleep(ms) { now += ms; } },
    async ready(ip, timeout) { probes.push({ ip, timeout }); return readiness; },
  });
  const manager = createManager({ secret, webOrigin: origin, store, runtime, timers, now: () => now });
  return { ...manager, docker, store, files, root, timers, probes,
    setReady(value: boolean) { readiness = value; }, now: () => now,
    advance(ms: number) { now += ms; }, cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export const auth = { Authorization: `Bearer ${secret}` };
export const ensureRequest = (projectId: string, previewLabel: string) => ({
  path: `/projects/${projectId}/ensure`,
  init: { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ previewLabel }) },
});
