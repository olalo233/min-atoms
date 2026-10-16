import { describe, expect, test } from "bun:test";
import { createController, type Env } from "../src/index";
import { signAssertion } from "../src/auth";

const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
const key = JSON.stringify({ client_email: "dummy@example.invalid",
  private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----` });
const env: Env = { GCP_PROJECT: "test-project", GCP_ZONE: "asia-northeast1-b", VM_NAME: "min-atoms-vm",
  SSH_PUBLIC_KEY: "ssh-ed25519 AAAATEST comment", GCP_SA_KEY: key, WAKE_TOKEN: "test-only-token" };
const project = "/projects/test-project";
const zonal = `${project}/zones/asia-northeast1-b`;
const instancePath = `${zonal}/instances/min-atoms-vm`;
const diskPath = `${zonal}/disks/min-atoms-vm`;
const resource = "https://www.googleapis.com/compute/v1";
const now = Date.parse("2026-10-16T06:00:00Z");
const stopped = () => ({ name: "min-atoms-vm", id: "123", labels: { app: "min-atoms" }, status: "TERMINATED",
  lastStopTimestamp: "2026-10-16T03:00:00Z", disks: [{ boot: true, autoDelete: true, source: resource + diskPath }] });
const snapshot = (name = "new", status = "READY", created = "2026-10-16T05:00:00Z") => ({ name,
  status, creationTimestamp: created, labels: { app: "min-atoms" }, sourceDisk: resource + diskPath });
const operation = (type: string, status = "PENDING", extra = {}) => ({ name: "op", operationType: type, status,
  insertTime: "2026-10-16T05:30:00Z", targetLink: resource + instancePath, targetId: "123", ...extra });

type VM = ReturnType<typeof stopped>;
type Snapshot = ReturnType<typeof snapshot>;
type Op = ReturnType<typeof operation> & { error?: unknown };
function harness() {
  const state = { vm: stopped() as VM | null, snapshots: [] as Snapshot[], operations: [] as Op[],
    calls: [] as { path: string; method: string; body?: any }[], logs: [] as string[], tokens: 0,
    nextVM: undefined as VM | null | undefined, instanceGets: 0, fail: undefined as { status: number; body: unknown } | undefined,
    deleteImmediate: true, secondPage: [] as Snapshot[], clock: now };
  const worker = createController({ now: () => state.clock, log: (line) => state.logs.push(line),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") {
        state.tokens++;
        expect(init?.method).toBe("POST");
        expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
        return Response.json({ access_token: "dummy-access-token", expires_in: 3600 });
      }
      expect(url.origin).toBe("https://compute.googleapis.com");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer dummy-access-token");
      const path = url.pathname.replace("/compute/v1", "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ path, method, body });
      if (method !== "GET" && state.fail) return Response.json(state.fail.body, { status: state.fail.status });
      if (path === instancePath && method === "GET") {
        state.instanceGets++;
        if (state.instanceGets > 1 && state.nextVM !== undefined) state.vm = state.nextVM;
        return state.vm ? Response.json(state.vm) : Response.json({}, { status: 404 });
      }
      if (path === `${zonal}/operations`) {
        expect(url.searchParams.get("filter")).toBe(`targetLink = "${resource}${instancePath}"`);
        return Response.json({ items: state.operations });
      }
      if (path === `${project}/global/snapshots` && method === "GET") {
        expect(url.searchParams.get("filter")).toBe("labels.app = min-atoms");
        return Response.json(url.searchParams.get("pageToken") ? { items: state.secondPage } : {
          items: state.snapshots, ...(state.secondPage.length ? { nextPageToken: "next" } : {}),
        });
      }
      if (path.startsWith(`${project}/global/snapshots/`) && method === "GET") {
        const item = state.snapshots.find((s) => s.name === path.split("/").at(-1));
        if (!item) throw new Error(`Unexpected snapshot read ${path}`);
        return Response.json(item);
      }
      if (path === `${instancePath}/start` && method === "POST") {
        const op = operation("start"); state.operations = [op]; return Response.json(op);
      }
      if (path === `${zonal}/instances` && method === "POST") {
        const op = operation("insert"); state.operations = [op]; return Response.json(op);
      }
      if (path === `${project}/global/snapshots` && method === "POST") {
        state.snapshots.unshift(snapshot(body.name, "CREATING", new Date(state.clock).toISOString()));
        return Response.json({ status: "PENDING", operationType: "insert" });
      }
      if (path === instancePath && method === "DELETE") {
        const op = operation("delete"); state.operations = [op];
        if (state.deleteImmediate) state.vm = null;
        return Response.json(op);
      }
      if (path.startsWith(`${project}/global/snapshots/`) && method === "DELETE") {
        return Response.json({ status: "PENDING", operationType: "delete" });
      }
      throw new Error(`Unexpected ${method} ${path}`);
    } });
  const request = async (path = "/status", method = "GET", token: string | null = env.WAKE_TOKEN, config = env) => {
    const result = await worker.fetch(new Request(`https://controller.invalid${path}`, { method,
      headers: token === null ? {} : { Authorization: `Bearer ${token}` } }), config);
    return { code: result.status, body: result.status === 200 ? await result.json() as { phase: string; detail?: string } : null };
  };
  const tick = (config = env) => worker.scheduled({}, config);
  const mutations = () => state.calls.filter((call) => call.method !== "GET");
  return { state, request, tick, mutations };
}

test("RS256 JWT verifies with a throwaway RSA key and has the exact OAuth claims", async () => {
  const jwt = await signAssertion(key, now);
  const [header, payload, signature] = jwt.split(".");
  const decode = (part: string) => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ alg: "RS256", typ: "JWT" });
  expect(JSON.parse(new TextDecoder().decode(decode(payload)))).toEqual({ iss: "dummy@example.invalid",
    scope: "https://www.googleapis.com/auth/compute", aud: "https://oauth2.googleapis.com/token",
    iat: now / 1000, exp: now / 1000 + 3600 });
  expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, decode(signature),
    new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
});

describe("HTTP contract", () => {
  test("both routes require bearer authentication, unknown method/path is 404", async () => {
    const h = harness();
    for (const token of [null, "wrong", ""]) {
      expect((await h.request("/status", "GET", token)).code).toBe(401);
      expect((await h.request("/wake", "POST", token)).code).toBe(401);
    }
    expect((await h.request("/wake")).code).toBe(404);
    expect((await h.request("/other")).code).toBe(404);
    expect(h.state.calls).toEqual([]);
  });
  test("unconfigured controller is unavailable without contacting Google", async () => {
    const h = harness();
    expect((await h.request("/status", "GET", env.WAKE_TOKEN, { ...env, GCP_SA_KEY: "" })).body?.phase).toBe("unavailable");
    expect(h.state.tokens).toBe(0);
  });
  test.each([
    ["RUNNING", "running"], ["TERMINATED", "stopped"], ["STAGING", "starting"],
    ["PROVISIONING", "starting"], ["STOPPING", "stopping"], ["SUSPENDING", "stopping"], ["SUSPENDED", "unavailable"],
  ])("status maps %s to %s with no mutation", async (status, phase) => {
    const h = harness(); h.state.vm!.status = status;
    expect((await h.request()).body?.phase).toBe(phase);
    expect(h.mutations()).toEqual([]);
  });
  test("status reports retired/unavailable from available snapshots", async () => {
    const h = harness(); h.state.vm = null;
    expect((await h.request()).body?.phase).toBe("unavailable");
    h.state.snapshots = [snapshot()];
    expect((await h.request()).body?.phase).toBe("retired");
    expect(h.mutations()).toEqual([]);
  });
  test("status distinguishes restoring, retiring snapshot and deleting instance", async () => {
    const h = harness(); h.state.vm!.status = "PROVISIONING"; h.state.operations = [operation("insert")];
    expect((await h.request()).body?.phase).toBe("restoring");
    h.state.vm = null;
    expect((await h.request()).body?.phase).toBe("restoring");
    h.state.vm = stopped(); h.state.operations = []; h.state.snapshots = [snapshot("new", "UPLOADING")];
    expect((await h.request()).body?.phase).toBe("retiring");
    h.state.snapshots = []; h.state.operations = [operation("delete")];
    expect((await h.request()).body?.phase).toBe("retiring");
    h.state.vm = null;
    expect((await h.request()).body?.phase).toBe("retiring");
  });
  test("wake starts a stopped VM once, including while status still says TERMINATED", async () => {
    const h = harness();
    expect((await h.request("/wake", "POST")).body).toEqual({ phase: "starting" });
    expect((await h.request("/wake", "POST")).body?.phase).toBe("starting");
    expect(h.mutations()).toEqual([{ path: `${instancePath}/start`, method: "POST", body: undefined }]);
  });
  test("failed retire snapshot keeps the stopped VM wakeable and never deletes it", async () => {
    const h = harness(); h.state.snapshots = [snapshot("new", "FAILED")];
    expect((await h.request()).body?.phase).toBe("stopped");
    expect((await h.request("/wake", "POST")).body).toEqual({ phase: "starting" });
    expect(h.mutations()).toEqual([{ path: `${instancePath}/start`, method: "POST", body: undefined }]);
    const c = harness(); c.state.snapshots = [snapshot("new", "FAILED")]; await c.tick();
    expect(c.mutations()).toEqual([]);
  });
  test("retired wake uses newest READY snapshot with exactly the approved VM parameters", async () => {
    const h = harness(); h.state.vm = null;
    h.state.snapshots = [snapshot("older", "READY", "2026-10-15T00:00:00Z"), snapshot("unfinished", "CREATING", "2026-10-16T05:55:00Z")];
    h.state.secondPage = [snapshot("latest")];
    expect((await h.request("/wake", "POST")).body).toEqual({ phase: "restoring" });
    expect(h.mutations()).toEqual([{ path: `${zonal}/instances`, method: "POST", body: {
      name: "min-atoms-vm", machineType: "projects/test-project/zones/asia-northeast1-b/machineTypes/t2d-standard-2",
      labels: { app: "min-atoms" }, disks: [{ boot: true, autoDelete: true, type: "PERSISTENT", initializeParams: {
        diskName: "min-atoms-vm", diskSizeGb: "50", diskType: "projects/test-project/zones/asia-northeast1-b/diskTypes/pd-balanced",
        sourceSnapshot: "projects/test-project/global/snapshots/latest",
      } }], networkInterfaces: [{ network: "projects/test-project/global/networks/default",
        subnetwork: "projects/test-project/regions/asia-northeast1/subnetworks/default",
        accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT", networkTier: "PREMIUM" }] }],
      metadata: { items: [{ key: "block-project-ssh-keys", value: "true" }, { key: "ssh-keys", value: "tmars:ssh-ed25519 AAAATEST\n" }] },
      serviceAccounts: [], scheduling: { provisioningModel: "SPOT", instanceTerminationAction: "STOP", automaticRestart: false, onHostMaintenance: "TERMINATE" },
      shieldedInstanceConfig: { enableIntegrityMonitoring: true, enableVtpm: true, enableSecureBoot: false },
    } }]);
    expect((await h.request("/wake", "POST")).body?.phase).toBe("restoring");
    expect(h.mutations()).toHaveLength(1);
  });
  test.each(["RUNNING", "STAGING", "STOPPING"])("wake leaves %s unchanged", async (status) => {
    const h = harness(); h.state.vm!.status = status;
    await h.request("/wake", "POST"); expect(h.mutations()).toEqual([]);
  });
  test("wake does not interrupt retirement", async () => {
    const h = harness(); h.state.snapshots = [snapshot("new", "CREATING")];
    expect((await h.request("/wake", "POST")).body?.phase).toBe("retiring");
    expect(h.mutations()).toEqual([]);
  });
  test("insert 409 means already restoring", async () => {
    const h = harness(); h.state.vm = null; h.state.snapshots = [snapshot()];
    h.state.fail = { status: 409, body: {} };
    expect((await h.request("/wake", "POST")).body?.phase).toBe("restoring");
  });
  test("direct and asynchronous stock-out errors expose only the Chinese detail; wake retries", async () => {
    const h = harness(); h.state.fail = { status: 503, body: { error: { message: "ZONE_RESOURCE_POOL_EXHAUSTED secret-resource-ip" } } };
    expect((await h.request("/wake", "POST")).body).toEqual({ phase: "error", detail: "Spot 资源暂时不足，请稍后重试" });
    h.state.fail = undefined;
    h.state.operations = [operation("start", "DONE", { error: { errors: [{ code: "stockout", message: "secret" }] } })];
    expect((await h.request()).body).toEqual({ phase: "error", detail: "Spot 资源暂时不足，请稍后重试" });
    expect((await h.request("/wake", "POST")).body?.phase).toBe("starting");
  });
  test("refuses unowned VM and placeholder SSH key without mutation", async () => {
    const h = harness(); h.state.vm!.labels.app = "another-app";
    expect((await h.request("/wake", "POST")).body?.phase).toBe("error");
    h.state.vm = null; h.state.snapshots = [snapshot()];
    expect((await h.request("/wake", "POST", env.WAKE_TOKEN, { ...env, SSH_PUBLIC_KEY: "ssh-ed25519 REPLACE_WITH_PUBLIC_KEY" })).body?.phase).toBe("error");
    expect(h.mutations()).toEqual([]);
  });
  test("OAuth tokens are cached and refreshed near expiry", async () => {
    const h = harness(); await h.request(); await h.request(); expect(h.state.tokens).toBe(1);
    h.state.clock += 3541_000; await h.request(); expect(h.state.tokens).toBe(2);
  });
});

describe("scheduled retirement", () => {
  test("leaves running, recently stopped and missing stop timestamp untouched", async () => {
    for (const vm of [{ ...stopped(), status: "RUNNING" }, { ...stopped(), lastStopTimestamp: "2026-10-16T04:01:00Z" },
      { ...stopped(), lastStopTimestamp: "invalid" }]) {
      const h = harness(); h.state.vm = vm; await h.tick(); expect(h.mutations()).toEqual([]);
    }
  });
  test("snapshot request has the owned disk, regional storage, name and label; next tick waits", async () => {
    const h = harness(); await h.tick();
    expect(h.mutations()).toEqual([{ path: `${project}/global/snapshots`, method: "POST", body: {
      name: "min-atoms-vm-20261016t060000z", sourceDisk: resource + diskPath,
      labels: { app: "min-atoms" }, storageLocations: ["asia-northeast1"],
    } }]);
    await h.tick(); expect(h.mutations()).toHaveLength(1);
    expect(JSON.parse(h.state.logs.at(-1)!).decision).toBe("snapshot_pending");
  });
  test.each(["CREATING", "UPLOADING", "FAILED"])("%s snapshot never permits instance deletion", async (status) => {
    const h = harness(); h.state.snapshots = [snapshot("new", status)]; await h.tick();
    expect(h.mutations()).toEqual([]);
    expect(JSON.parse(h.state.logs[0]).decision).toBe(status === "FAILED" ? "snapshot_failed" : "snapshot_pending");
  });
  test("old or different-disk snapshot is insufficient: takes a fresh one", async () => {
    for (const s of [snapshot("old", "READY", "2026-10-16T02:59:59Z"), { ...snapshot(), sourceDisk: resource + diskPath + "-other" },
      snapshot("equal", "READY", "2026-10-16T03:00:00Z")]) {
      const h = harness(); h.state.snapshots = [s]; await h.tick();
      expect(h.mutations().map((m) => m.method)).toEqual(["POST"]);
    }
  });
  test("only a newer READY snapshot permits deletion, then prunes after confirmed absence", async () => {
    const h = harness(); h.state.snapshots = [snapshot("one"), snapshot("two", "READY", "2026-10-16T02:00:00Z"), snapshot("three", "READY", "2026-10-16T01:00:00Z")];
    await h.tick();
    expect(h.mutations()).toEqual([{ path: instancePath, method: "DELETE", body: undefined },
      { path: `${project}/global/snapshots/three`, method: "DELETE", body: undefined }]);
    expect(h.state.vm).toBe(null);
  });
  test("async deletion reports retiring and defers pruning to a later tick", async () => {
    const h = harness(); h.state.snapshots = [snapshot()]; h.state.deleteImmediate = false;
    await h.tick(); expect((await h.request()).body?.phase).toBe("retiring");
    await h.tick(); expect(h.mutations()).toHaveLength(1);
    h.state.vm = null; h.state.operations = [operation("delete", "DONE")]; await h.tick();
    expect(JSON.parse(h.state.logs.at(-1)!).decision).toBe("prune_complete");
  });
  test("boot disk name and autoDelete are hard guards", async () => {
    for (const disk of [{ boot: true, autoDelete: false, source: resource + diskPath },
      { boot: true, autoDelete: true, source: resource + diskPath + "-other" }]) {
      const h = harness(); h.state.vm!.disks = [disk]; h.state.snapshots = [snapshot()]; await h.tick();
      expect(h.mutations()).toEqual([]);
    }
  });
  test("re-read catches restart, changed stop timestamp and changed autoDelete", async () => {
    for (const vm of [{ ...stopped(), status: "RUNNING" }, { ...stopped(), lastStopTimestamp: "2026-10-16T03:01:00Z" },
      { ...stopped(), disks: [{ boot: true, autoDelete: false, source: resource + diskPath }] }]) {
      const h = harness(); h.state.snapshots = [snapshot()]; h.state.nextVM = vm; await h.tick();
      expect(h.mutations()).toEqual([]);
      expect(JSON.parse(h.state.logs.at(-1)!).decision).toBe("instance_changed");
    }
  });
  test("pruning keeps newest two, never the only READY copy, waits for newer non-READY", async () => {
    for (const snapshots of [[snapshot()], [snapshot(), snapshot("pending", "CREATING", "2026-10-16T05:55:00Z")],
      [snapshot(), snapshot("two", "READY", "2026-10-16T02:00:00Z"), snapshot("three", "READY", "2026-10-16T01:00:00Z"), snapshot("newer", "UPLOADING", "2026-10-16T05:55:00Z")]]) {
      const h = harness(); h.state.vm = null; h.state.snapshots = snapshots; await h.tick(); expect(h.mutations()).toEqual([]);
    }
    const h = harness(); h.state.vm = null; h.state.snapshots = [snapshot("old", "READY", "2026-10-15T00:00:00Z"), snapshot("one"), snapshot("two", "READY", "2026-10-16T04:00:00Z")];
    await h.tick(); expect(h.mutations().map((m) => m.path)).toEqual([`${project}/global/snapshots/old`]);
  });
  test("does not touch snapshots lacking the app label", async () => {
    const h = harness(); h.state.vm = null;
    h.state.snapshots = [snapshot(), { ...snapshot("foreign", "READY", "2026-10-15T00:00:00Z"), labels: { app: "foreign" } }];
    await h.tick({ ...env, KEEP_SNAPSHOTS: "1" }); expect(h.mutations()).toEqual([]);
  });
  test("configured age and retention apply and structured logs contain no secrets", async () => {
    const h = harness(); h.state.vm!.lastStopTimestamp = "2026-10-16T05:00:00Z";
    await h.tick({ ...env, RETIRE_AFTER_MINUTES: "60" }); expect(h.mutations()).toHaveLength(1);
    for (const line of h.state.logs) expect(Object.keys(JSON.parse(line))).toEqual(["component", "decision"]);
    expect(h.state.logs.join()).not.toContain("dummy-access-token");
  });
});
