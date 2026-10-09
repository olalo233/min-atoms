import { isIP } from "node:net";
import type { ManagerStore, RuntimeProject } from "./store";
import { ManagerError, previewLabelPattern, validateProjectId } from "./errors";
import { ProjectFiles } from "./project-files";
import { serialLane } from "./serial";

export type ProcessResult = { exitCode: number; stdout: string };
export type Spawn = (argv: string[]) => Promise<ProcessResult>;
export const spawn: Spawn = async argv => {
  // No shell and no application secrets in subprocess environments. In
  // particular, Docker inspection never requests gateway Config.Env.
  const child = Bun.spawn(argv, {
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    stdout: "pipe", stderr: "ignore", stdin: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { exitCode, stdout };
};

export interface RuntimeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const runtimeClock: RuntimeClock = { now: Date.now, sleep: ms => Bun.sleep(ms) };
type Container = {
  name: string; labels: Record<string, string>; running: boolean; startedAt: string;
  mounts: Array<{ Source: string; Destination: string }>; ip: string;
};
const inspectFormat = '{"name":{{json .Name}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},"mounts":{{json .Mounts}},"ip":{{with index .NetworkSettings.Networks "ma-net"}}{{json .IPAddress}}{{else}}""{{end}}}';
const ownershipLabels = { "min-atoms.managed": "true", "min-atoms.role": "project" };

export class ProjectRuntime {
  private readonly mutate = serialLane();
  private readonly lastUsed = new Map<string, number>();
  private readonly process: Spawn;
  private readonly clock: RuntimeClock;
  readonly files: ProjectFiles;
  private readonly ready: (ip: string, timeoutMs: number) => Promise<boolean>;

  constructor(private readonly store: Pick<ManagerStore, "project" | "busy" | "running">, options: {
    spawn?: Spawn; clock?: RuntimeClock; files?: ProjectFiles;
    ready?: (ip: string, timeoutMs: number) => Promise<boolean>;
  } = {}) {
    this.process = options.spawn ?? spawn;
    this.clock = options.clock ?? runtimeClock;
    this.files = options.files ?? new ProjectFiles();
    this.ready = options.ready ?? (async (ip, timeoutMs) => {
      try {
        const response = await fetch(`http://${ip}:5173/`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
        await response.body?.cancel();
        return response.ok;
      } catch { return false; }
    });
  }

  private async command(argv: string[]): Promise<string> {
    const result = await this.process(argv);
    if (result.exitCode !== 0) throw new ManagerError(503, `Runtime command failed: ${argv[0]} ${argv[1]}`);
    return result.stdout.trim();
  }

  private async names(): Promise<string[]> {
    return (await this.command(["docker", "ps", "-a", "--format", "{{.Names}}"])).split("\n").filter(Boolean);
  }

  private async inspect(name: string): Promise<Container> {
    const raw = JSON.parse(await this.command(["docker", "container", "inspect", "--format", inspectFormat, name]));
    return { ...raw, name: raw.name.replace(/^\//, ""), labels: raw.labels ?? {} };
  }

  private owns(container: Container, project: RuntimeProject): boolean {
    return previewLabelPattern.test(project.previewLabel) && container.name === project.previewLabel
      && Object.entries(ownershipLabels).every(([key, value]) => container.labels[key] === value)
      && container.labels["min-atoms.project-id"] === project.id
      && container.labels["min-atoms.preview-label"] === project.previewLabel
      && ["workspace", "data", "state"].every(name => container.mounts.some(mount =>
        mount.Destination === `/${name}` && mount.Source === `${this.files.path(project.id)}/${name}`));
  }

  private async managed(): Promise<Container[]> {
    const result: Container[] = [];
    for (const name of await this.names()) {
      if (!previewLabelPattern.test(name)) continue;
      const container = await this.inspect(name);
      const id = container.labels["min-atoms.project-id"];
      if (!id) continue;
      // A label is evidence only when it agrees with the database and mounts.
      try { validateProjectId(id); } catch { continue; }
      const project = await this.store.project(id);
      if (project && this.owns(container, project)) result.push(container);
    }
    return result;
  }

  async initialize(): Promise<void> {
    await this.mutate(async () => {
      const network = await this.process(["docker", "network", "inspect", "--format", "{{.Driver}}", "ma-net"]);
      if (network.exitCode !== 0) await this.command(["docker", "network", "create", "--driver", "bridge", "ma-net"]);
      else if (network.stdout.trim() !== "bridge") throw new ManagerError(503, "ma-net is not a bridge network");
      const names = await this.names();
      const gateway = names.includes("ma-gateway") ? await this.command([
        "docker", "container", "inspect", "--format", "{{.State.Running}}", "ma-gateway",
      ]) : "false";
      if (gateway !== "true") {
        // systemd owns gateway configuration and secret injection; do not
        // recreate it with a manager-supplied environment or configuration.
        await this.command(["systemctl", "restart", "ma-gateway.service"]);
        if (await this.command(["docker", "container", "inspect", "--format", "{{.State.Running}}", "ma-gateway"]) !== "true") {
          throw new ManagerError(503, "Gateway is not running");
        }
      }
      await this.makeRoom(6);
    });
  }

  async project(id: string, label?: string): Promise<RuntimeProject> {
    validateProjectId(id);
    if (label !== undefined && !previewLabelPattern.test(label)) throw new ManagerError(400, "Invalid preview label");
    const project = await this.store.project(id);
    if (!project) throw new ManagerError(404, "Project not found");
    if (!previewLabelPattern.test(project.previewLabel) || (label !== undefined && label !== project.previewLabel)) {
      throw new ManagerError(409, "Preview label does not match project");
    }
    return project;
  }

  private async firewall(): Promise<void> {
    await this.command(["iptables", "-C", "DOCKER-USER", "-d", "169.254.169.254", "-j", "DROP"]);
  }

  private async makeRoom(limit = 5): Promise<void> {
    const running = (await this.managed()).filter(container => container.running);
    running.sort((a, b) => (this.lastUsed.get(a.name) ?? (Date.parse(a.startedAt) || 0))
      - (this.lastUsed.get(b.name) ?? (Date.parse(b.startedAt) || 0)) || a.name.localeCompare(b.name));
    while (running.length > limit) {
      let idle = -1;
      for (let index = 0; index < running.length; index++) {
        if (!await this.store.running(running[index].labels["min-atoms.project-id"])) { idle = index; break; }
      }
      if (idle < 0) throw new ManagerError(503, "All project containers are busy; no idle capacity");
      const [container] = running.splice(idle, 1);
      await this.command(["docker", "stop", container.name]);
    }
  }

  ensure(id: string, label: string): Promise<void> {
    return this.mutate(async () => {
      const project = await this.project(id, label);
      id = project.id;
      const exists = (await this.names()).includes(label);
      let container = exists ? await this.inspect(label) : undefined;
      if (container && !this.owns(container, project)) throw new ManagerError(409, "Container is not owned by this project");
      if (!container?.running) {
        await this.firewall();
        await this.makeRoom();
        await this.files.prepare(id);
        if (container) {
          // Check immediately before start as well as before capacity changes.
          await this.firewall();
          await this.command(["docker", "start", label]);
        } else {
          await this.firewall();
          await this.command([
            "docker", "create", "--name", label, "--network", "ma-net", "--user", "app",
            "--memory", "2g", "--cpus", "2", "--pids-limit", "512",
            ...Object.entries({ ...ownershipLabels, "min-atoms.project-id": id, "min-atoms.preview-label": label })
              .flatMap(([key, value]) => ["--label", `${key}=${value}`]),
            ...["workspace", "data", "state"].flatMap(name => ["--mount", `type=bind,src=${this.files.path(id)}/${name},dst=/${name}`]),
            "min-atoms/project",
          ]);
          await this.firewall();
          await this.command(["docker", "start", label]);
        }
        container = await this.inspect(label);
      }
      if (!container.running || !this.owns(container, project) || isIP(container.ip) !== 4) {
        throw new ManagerError(503, "Project container has no usable preview address");
      }
      this.lastUsed.set(label, this.clock.now());
      const deadline = this.clock.now() + 60_000;
      while (this.clock.now() < deadline) {
        if (await this.ready(container.ip, Math.min(1000, deadline - this.clock.now()))) return;
        const remaining = deadline - this.clock.now();
        if (remaining > 0) await this.clock.sleep(Math.min(500, remaining));
      }
      throw new ManagerError(504, "Preview readiness timed out after 60 seconds");
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      const project = await this.project(id);
      id = project.id;
      if (await this.store.busy(id)) throw new ManagerError(409, "Project has running or queued work");
      const exists = (await this.names()).includes(project.previewLabel);
      if (exists) {
        const container = await this.inspect(project.previewLabel);
        if (!this.owns(container, project)) throw new ManagerError(409, "Container is not owned by this project");
        if (container.running) await this.command(["docker", "stop", project.previewLabel]);
        await this.command(["docker", "rm", project.previewLabel]);
      }
      await this.files.remove(id);
      this.lastUsed.delete(project.previewLabel);
    });
  }

  async count(): Promise<number> {
    return (await this.managed()).filter(container => container.running).length;
  }
}
