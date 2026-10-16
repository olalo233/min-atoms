import { authorized, type Fetch, tokenProvider } from "./auth";

export interface Env {
  GCP_PROJECT: string;
  GCP_ZONE: string;
  VM_NAME: string;
  SSH_PUBLIC_KEY: string;
  RETIRE_AFTER_MINUTES?: string;
  KEEP_SNAPSHOTS?: string;
  GCP_SA_KEY: string;
  WAKE_TOKEN: string;
}

type Phase = "running" | "starting" | "stopping" | "stopped" | "retiring" |
  "retired" | "restoring" | "unavailable" | "error";
type Status = { phase: Phase; detail?: string };
type Instance = {
  name: string; id?: string; labels?: Record<string, string>; status: string;
  lastStopTimestamp?: string; lastStartTimestamp?: string;
  disks?: { boot?: boolean; autoDelete?: boolean; source: string }[];
};
type Snapshot = {
  name: string; status: string; creationTimestamp: string;
  sourceDisk?: string; labels?: Record<string, string>;
};
type Operation = {
  name?: string; status: string; operationType: string; targetLink?: string;
  targetId?: string; insertTime?: string; error?: unknown;
};

const apiRoot = "https://compute.googleapis.com/compute/v1";
const resourceRoot = "https://www.googleapis.com/compute/v1";
const stockout = "Spot 资源暂时不足，请稍后重试";
const failed = "运行环境操作失败，请稍后重试";
const pendingSnapshot = (s: Snapshot) => ["CREATING", "UPLOADING"].includes(s.status);
const time = (value?: string) => Date.parse(value ?? "");
const newest = <T extends { creationTimestamp: string }>(items: T[]) =>
  items.sort((a, b) => time(b.creationTimestamp) - time(a.creationTimestamp));

class ComputeError extends Error {
  constructor(readonly status: number, readonly stockout: boolean) { super("compute_failed"); }
}
function errorStatus(error: unknown): Status {
  return { phase: "error", detail: error instanceof ComputeError && error.stockout ? stockout : failed };
}
function checkOperation(operation: Operation) {
  if (operation.error) throw new ComputeError(502, /ZONE_RESOURCE_POOL_EXHAUSTED|stockout/i.test(JSON.stringify(operation.error)));
}
function positive(value: string | undefined, fallback: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("invalid_configuration");
  return number;
}
function configured(env: Env) {
  return Boolean(env.GCP_PROJECT && env.GCP_ZONE && env.VM_NAME === "min-atoms-vm" && env.GCP_SA_KEY);
}

class Compute {
  readonly project: string;
  readonly zonal: string;
  readonly instancePath: string;
  readonly diskPath: string;
  constructor(readonly env: Env, readonly fetch: Fetch, readonly accessToken: (key: string) => Promise<string>) {
    this.project = `/projects/${env.GCP_PROJECT}`;
    this.zonal = `${this.project}/zones/${env.GCP_ZONE}`;
    this.instancePath = `${this.zonal}/instances/${env.VM_NAME}`;
    this.diskPath = `${this.zonal}/disks/${env.VM_NAME}`;
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const token = await this.accessToken(this.env.GCP_SA_KEY);
    const response = await this.fetch(`${apiRoot}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ComputeError(response.status, /ZONE_RESOURCE_POOL_EXHAUSTED|stockout/i.test(text));
    }
    return await response.json() as T;
  }
  async list<T>(path: string, filter: string): Promise<T[]> {
    const result: T[] = [];
    let page: string | undefined;
    do {
      const query = new URLSearchParams({ filter, maxResults: "500" });
      if (page) query.set("pageToken", page);
      const body = await this.request<{ items?: T[]; nextPageToken?: string }>(`${path}?${query}`);
      result.push(...body.items ?? []);
      page = body.nextPageToken;
    } while (page);
    return result;
  }
  async instance(): Promise<Instance | null> {
    let vm: Instance;
    try { vm = await this.request<Instance>(this.instancePath); }
    catch (error) { if (error instanceof ComputeError && error.status === 404) return null; throw error; }
    if (vm.name !== this.env.VM_NAME || vm.labels?.app !== "min-atoms") throw new Error("unowned_instance");
    return vm;
  }
  async snapshots(): Promise<Snapshot[]> {
    const snapshots = await this.list<Snapshot>(`${this.project}/global/snapshots`, "labels.app = min-atoms");
    // Do not trust filtering alone when deciding what may be deleted or restored.
    return newest(snapshots.filter((s) => s.labels?.app === "min-atoms"));
  }
  sameDisk(snapshot: Snapshot) { return snapshot.sourceDisk?.endsWith(this.diskPath) === true; }
  sinceStop(snapshots: Snapshot[], vm: Instance) {
    return snapshots.filter((s) => this.sameDisk(s) && time(s.creationTimestamp) > time(vm.lastStopTimestamp));
  }
  safeBoot(vm: Instance) {
    const boot = vm.disks?.filter((d) => d.boot);
    return boot?.length === 1 && boot[0].autoDelete === true && boot[0].source.endsWith(this.diskPath);
  }
  async latestOperation(vm: Instance | null): Promise<Operation | undefined> {
    const operations = await this.list<Operation>(`${this.zonal}/operations`, `targetLink = "${resourceRoot}${this.instancePath}"`);
    return operations.filter((o) => o.targetLink?.endsWith(this.instancePath) &&
      (!vm?.id || !o.targetId || vm.id === o.targetId))
      .sort((a, b) => time(b.insertTime) - time(a.insertTime))[0];
  }
  async mutate(path: string, method: string, body?: unknown) {
    const operation = await this.request<Operation>(path, method, body);
    checkOperation(operation);
  }
  restoreBody(snapshot: Snapshot) {
    const key = this.env.SSH_PUBLIC_KEY?.trim().split(/\s+/);
    if (!key || !/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-\S+)$/.test(key[0]) || !key[1] ||
      /PLACEHOLDER|REPLACE/i.test(key[1])) throw new Error("missing_public_key");
    const region = this.env.GCP_ZONE.replace(/-[^-]+$/, "");
    return {
      name: this.env.VM_NAME,
      machineType: `${this.zonal.slice(1)}/machineTypes/t2d-standard-2`,
      labels: { app: "min-atoms" },
      disks: [{ boot: true, autoDelete: true, type: "PERSISTENT", initializeParams: {
        diskName: this.env.VM_NAME, diskSizeGb: "50", diskType: `${this.zonal.slice(1)}/diskTypes/pd-balanced`,
        sourceSnapshot: `${this.project.slice(1)}/global/snapshots/${snapshot.name}`,
      } }],
      networkInterfaces: [{ network: `${this.project.slice(1)}/global/networks/default`,
        subnetwork: `${this.project.slice(1)}/regions/${region}/subnetworks/default`,
        accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT", networkTier: "PREMIUM" }],
      }],
      metadata: { items: [
        { key: "block-project-ssh-keys", value: "true" },
        { key: "ssh-keys", value: `tmars:${key[0]} ${key[1]}\n` },
      ] },
      serviceAccounts: [],
      scheduling: { provisioningModel: "SPOT", instanceTerminationAction: "STOP",
        automaticRestart: false, onHostMaintenance: "TERMINATE" },
      shieldedInstanceConfig: { enableIntegrityMonitoring: true, enableVtpm: true, enableSecureBoot: false },
    };
  }
}

async function inspect(compute: Compute): Promise<{ status: Status; vm: Instance | null; snapshots: Snapshot[] }> {
  const vm = await compute.instance();
  if (vm?.status === "RUNNING") return { vm, snapshots: [], status: { phase: "running" } };
  const operation = await compute.latestOperation(vm);
  if (operation?.status !== "DONE" && operation?.operationType === "delete") {
    return { vm, snapshots: [], status: { phase: "retiring" } };
  }
  if (operation?.error) checkOperation(operation);
  if (!vm && operation?.status !== "DONE" && operation?.operationType === "insert") {
    return { vm, snapshots: [], status: { phase: "restoring" } };
  }
  if (vm && operation?.status !== "DONE" && operation?.operationType === "start") {
    return { vm, snapshots: [], status: { phase: "starting" } };
  }
  if (vm && ["STAGING", "PROVISIONING"].includes(vm.status)) {
    return { vm, snapshots: [], status: { phase: operation?.operationType === "insert" ? "restoring" : "starting" } };
  }
  if (vm && ["STOPPING", "SUSPENDING"].includes(vm.status)) {
    return { vm, snapshots: [], status: { phase: "stopping" } };
  }
  const snapshots = await compute.snapshots();
  if (!vm) return { vm, snapshots, status: { phase: snapshots.some((s) => s.status === "READY") ? "retired" : "unavailable" } };
  if (vm.status === "TERMINATED") {
    const snapshot = compute.sinceStop(snapshots, vm)[0];
    // A failed retire snapshot only blocks deletion (cron); the intact VM stays wakeable.
    return { vm, snapshots, status: { phase: snapshot && snapshot.status !== "FAILED" && pendingSnapshot(snapshot) ? "retiring" : "stopped" } };
  }
  return { vm, snapshots, status: { phase: "unavailable", detail: "运行环境暂不可用" } };
}

export function createController(deps: { fetch?: Fetch; now?: () => number; log?: (line: string) => void } = {}) {
  const fetchGoogle = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? Date.now;
  const accessToken = tokenProvider(fetchGoogle, now);
  const log = (decision: string) => (deps.log ?? console.log)(JSON.stringify({ component: "runtime-controller", decision }));

  async function prune(compute: Compute) {
    const snapshots = await compute.snapshots();
    const ready = snapshots.filter((s) => s.status === "READY");
    const keep = positive(compute.env.KEEP_SNAPSHOTS, 2);
    // A newer incomplete/failed snapshot must never displace a usable copy.
    const cutoff = ready[Math.min(keep, ready.length) - 1];
    if (!cutoff || snapshots.some((s) => s.status !== "READY" && time(s.creationTimestamp) >= time(cutoff.creationTimestamp))) {
      log("prune_wait"); return;
    }
    for (const snapshot of ready.slice(keep)) {
      if (snapshots.some((s) => s.status !== "READY" && time(s.creationTimestamp) >= time(snapshot.creationTimestamp))) {
        log("prune_wait"); return;
      }
      // Re-read ownership and readiness before an irreversible deletion.
      const current = await compute.request<Snapshot>(`${compute.project}/global/snapshots/${snapshot.name}`);
      if (current.labels?.app !== "min-atoms" || current.status !== "READY") { log("prune_guard"); return; }
      await compute.mutate(`${compute.project}/global/snapshots/${snapshot.name}`, "DELETE");
      log("snapshot_pruned");
    }
    log("prune_complete");
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (!(request.method === "GET" && path === "/status") && !(request.method === "POST" && path === "/wake")) {
        return new Response(null, { status: 404 });
      }
      const json = (status: Status, code = 200) => Response.json(status, { status: code, headers: { "Cache-Control": "no-store" } });
      if (!await authorized(request.headers.get("Authorization"), env.WAKE_TOKEN ?? "")) {
        return new Response(null, { status: 401 });
      }
      if (!configured(env)) return json({ phase: "unavailable", detail: "运行环境控制器尚未配置" });
      const compute = new Compute(env, fetchGoogle, accessToken);
      try {
        let state;
        try { state = await inspect(compute); }
        catch (error) {
          if (request.method !== "POST" || !(error instanceof ComputeError)) throw error;
          // A failed async start/insert remains visible to status; a wake may retry it.
          if (error.status !== 502) throw error;
          const vm = await compute.instance();
          state = { vm, snapshots: await compute.snapshots(), status: { phase: vm?.status === "TERMINATED" ? "stopped" : !vm ? "retired" : "error" } as Status };
        }
        if (request.method === "GET") return json(state.status);
        if (state.status.phase === "stopped") {
          try { await compute.mutate(`${compute.instancePath}/start`, "POST"); }
          catch (error) { if (!(error instanceof ComputeError && error.status === 409)) throw error; }
          return json({ phase: "starting" });
        }
        if (state.status.phase === "retired") {
          const snapshot = state.snapshots.find((s) => s.status === "READY");
          if (!snapshot) return json({ phase: "unavailable" });
          try { await compute.mutate(`${compute.zonal}/instances`, "POST", compute.restoreBody(snapshot)); }
          catch (error) { if (!(error instanceof ComputeError && error.status === 409)) throw error; }
          return json({ phase: "restoring" });
        }
        return json(state.status);
      } catch (error) { return json(errorStatus(error)); }
    },
    async scheduled(_event: unknown, env: Env): Promise<void> {
      if (!configured(env)) { log("unconfigured"); return; }
      const compute = new Compute(env, fetchGoogle, accessToken);
      try {
        const vm = await compute.instance();
        const operation = await compute.latestOperation(vm);
        if (operation && operation.status !== "DONE") { log("operation_pending"); return; }
        if (!vm) { await prune(compute); return; }
        const age = now() - time(vm.lastStopTimestamp);
        if (vm.status !== "TERMINATED" || !Number.isFinite(age) || age < positive(env.RETIRE_AFTER_MINUTES, 120) * 60_000) {
          log("not_idle_long_enough"); return;
        }
        if (!compute.safeBoot(vm)) { log("boot_disk_guard"); return; }
        const snapshots = await compute.snapshots();
        const snapshot = compute.sinceStop(snapshots, vm)[0];
        if (!snapshot) {
          const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").replace("T", "t");
          try {
            await compute.mutate(`${compute.project}/global/snapshots`, "POST", {
              name: `${env.VM_NAME}-${stamp}`, sourceDisk: `${resourceRoot}${compute.diskPath}`,
              labels: { app: "min-atoms" }, storageLocations: [env.GCP_ZONE.replace(/-[^-]+$/, "")],
            });
          } catch (error) { if (!(error instanceof ComputeError && error.status === 409)) throw error; }
          log("snapshot_requested"); return;
        }
        if (snapshot.status === "FAILED") { log("snapshot_failed"); return; }
        if (snapshot.status !== "READY") { log("snapshot_pending"); return; }
        const current = await compute.instance();
        if (!current || current.status !== "TERMINATED" || current.lastStopTimestamp !== vm.lastStopTimestamp || !compute.safeBoot(current)) {
          log("instance_changed"); return;
        }
        await compute.mutate(compute.instancePath, "DELETE");
        log("instance_delete_requested");
        // Delete is asynchronous: prune only after absence is observed, possibly next tick.
        if (!await compute.instance()) await prune(compute);
      } catch (error) {
        log(error instanceof ComputeError && error.stockout ? "stockout" : "operation_failed");
        throw new Error("runtime_controller_failed");
      }
    },
  };
}

export default createController();
