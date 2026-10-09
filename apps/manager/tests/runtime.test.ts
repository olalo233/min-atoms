import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ManagerEnsureResponseSchema } from "@min-atoms/protocol";
import { auth, ensureRequest, harness, id, label } from "./helpers";
import { readManagerConfig } from "../src/index";

const mutations = (commands: string[][]) => commands.filter(argv => ["create", "start", "stop", "rm"].includes(argv[1]));

test("ensure/delete/shots require exact Bearer authentication before touching runtime", async () => {
  const h = await harness();
  try {
    for (const [path, method] of [[`/projects/${id(1)}/ensure`, "POST"], [`/projects/${id(1)}`, "DELETE"],
      [`/projects/${id(1)}/shots/${"a".repeat(40)}.png`, "GET"], [`/projects/${id(1)}/shots/stream`, "GET"]]) {
      for (const Authorization of ["", "Bearer wrong", "bearer test-shared-secret"]) {
        expect((await h.app.request(path, { method, headers: { Authorization } })).status).toBe(401);
      }
    }
    expect(h.docker.commands).toEqual([]);
  } finally { await h.cleanup(); }
});

test("UUID, preview label and database ownership are validated before paths or processes", async () => {
  const h = await harness();
  try {
    h.store.add(1);
    for (const [projectId, previewLabel, status] of [
      ["invalid", label(1), 400], [id(1), "ma-../../oops", 400], [id(1), "ma-ABCDEFGH", 400],
      [id(1), label(2), 409], [id(2), label(2), 404],
    ] as const) {
      const request = ensureRequest(projectId, previewLabel);
      expect((await h.app.request(request.path, request.init)).status).toBe(status);
    }
    expect((await h.app.request(`/projects/${id(1)}/ensure`, { method: "POST", headers: auth, body: "{" })).status).toBe(400);
    expect(h.docker.commands).toEqual([]);
    expect(await Bun.file(join(h.root, id(1), "workspace", "untouched")).exists()).toBe(false);
  } finally { await h.cleanup(); }
});

test("concurrent ensure creates one isolated app runtime and repeated ensure preserves all mounts", async () => {
  const h = await harness();
  try {
    const project = h.store.add(1);
    const request = ensureRequest(project.id, project.previewLabel);
    const responses = await Promise.all([h.app.request(request.path, request.init), h.app.request(request.path, request.init)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(ManagerEnsureResponseSchema.parse(await response.json())).toEqual({ ready: true });
    }
    const create = h.docker.commands.filter(argv => argv[1] === "create");
    expect(create).toHaveLength(1);
    expect(create[0]).toEqual([
      "docker", "create", "--name", project.previewLabel, "--network", "ma-net", "--user", "app",
      "--memory", "2g", "--cpus", "2", "--pids-limit", "512",
      "--label", "min-atoms.managed=true", "--label", "min-atoms.role=project",
      "--label", `min-atoms.project-id=${project.id}`, "--label", `min-atoms.preview-label=${project.previewLabel}`,
      ...["workspace", "data", "state"].flatMap(name => ["--mount", `type=bind,src=${h.root}/${project.id}/${name},dst=/${name}`]),
      "min-atoms/project",
    ]);
    expect(create[0].some(arg => ["--env", "-e", "-p", "--publish", "--privileged"].includes(arg))).toBe(false);
    for (const command of h.docker.commands.filter(argv => ["create", "start"].includes(argv[1]))) {
      const index = h.docker.commands.indexOf(command);
      expect(h.docker.commands[index - 1]).toEqual(["iptables", "-C", "DOCKER-USER", "-d", "169.254.169.254", "-j", "DROP"]);
    }
    for (const name of ["workspace", "data", "state"]) {
      const directory = join(h.root, project.id, name);
      expect((await lstat(directory)).uid).toBe(process.getuid!());
      await writeFile(join(directory, "retained"), name);
    }
    expect(h.probes).toHaveLength(2);
    expect(h.probes.every(probe => probe.ip === "172.20.0.2" && probe.timeout <= 1000)).toBe(true);
    expect((await h.app.request(request.path, request.init)).status).toBe(200);
    expect(h.docker.commands.filter(argv => argv[1] === "create")).toHaveLength(1);
    for (const name of ["workspace", "data", "state"]) expect(await readFile(join(h.root, project.id, name, "retained"), "utf8")).toBe(name);
  } finally { await h.cleanup(); }
});

test("missing exact metadata rule refuses creation and stopped-container restart", async () => {
  for (const existing of [false, true]) {
    const h = await harness();
    try {
      const project = h.store.add(1);
      if (existing) h.docker.add(project, h.root, false);
      h.docker.firewall = false;
      const request = ensureRequest(project.id, project.previewLabel);
      expect((await h.app.request(request.path, request.init)).status).toBe(503);
      expect(mutations(h.docker.commands)).toEqual([]);
      expect(await Bun.file(join(h.root, project.id, "data", "app.db")).exists()).toBe(false);
    } finally { await h.cleanup(); }
  }
});

test("stopped owned container restarts without recreating; unrelated same-name container is refused", async () => {
  const h = await harness();
  try {
    const project = h.store.add(1);
    const container = h.docker.add(project, h.root, false);
    const request = ensureRequest(project.id, project.previewLabel);
    expect((await h.app.request(request.path, request.init)).status).toBe(200);
    expect(mutations(h.docker.commands)).toEqual([["docker", "start", project.previewLabel]]);
    h.docker.commands.length = 0;
    container.labels["min-atoms.project-id"] = id(2);
    expect((await h.app.request(request.path, request.init)).status).toBe(409);
    expect((await h.app.request(`/projects/${id(1)}`, { method: "DELETE", headers: auth })).status).toBe(409);
    expect(mutations(h.docker.commands)).toEqual([]);
  } finally { await h.cleanup(); }
});

test("cancellation restart validates project ownership, preserves mounts/data and waits for preview", async () => {
  const h = await harness();
  try {
    const project = h.store.add(1);
    await h.runtime.ensure(project.id, project.previewLabel);
    for (const name of ["workspace", "data", "state"]) {
      await writeFile(join(h.root, project.id, name, "retained"), name);
    }
    const container = h.docker.containers.get(project.previewLabel)!;
    const mounts = structuredClone(container.mounts);
    h.docker.commands.length = 0;
    expect(await h.runtime.restart(project.id, project.previewLabel)).toBe(true);
    expect(h.docker.commands.filter(argv => argv[1] === "restart")).toEqual([["docker", "restart", "-t", "2", project.previewLabel]]);
    expect(h.docker.commands.filter(argv => ["create", "start", "stop", "rm"].includes(argv[1]))).toEqual([]);
    expect(container.mounts).toEqual(mounts);
    expect(h.probes).toHaveLength(2);
    for (const name of ["workspace", "data", "state"]) expect(await readFile(join(h.root, project.id, name, "retained"), "utf8")).toBe(name);
    for (const mismatch of ["project", "mount", "label", "firewall"]) {
      container.labels["min-atoms.project-id"] = mismatch === "project" ? id(2) : project.id;
      container.labels["min-atoms.preview-label"] = mismatch === "label" ? label(2) : project.previewLabel;
      container.mounts = mismatch === "mount" ? [] : mounts;
      h.docker.firewall = mismatch !== "firewall";
      h.docker.commands.length = 0;
      expect(await h.runtime.restart(project.id, project.previewLabel)).toBe(false);
      expect(h.docker.commands.some(argv => argv[1] === "restart")).toBe(false);
    }
    expect(await h.runtime.restart(id(2), label(2))).toBe(false);
    expect(await h.runtime.restart(project.id, label(2))).toBe(false);
  } finally { await h.cleanup(); }
});

test("readiness failure returns 504 at 60 seconds with bounded probes", async () => {
  const h = await harness();
  try {
    h.setReady(false);
    const project = h.store.add(1);
    const request = ensureRequest(project.id, project.previewLabel);
    const start = h.now();
    expect((await h.app.request(request.path, request.init)).status).toBe(504);
    expect(h.now() - start).toBe(60_000);
    expect(h.probes).toHaveLength(120);
    expect(h.docker.containers.get(project.previewLabel)?.running).toBe(true);
    h.setReady(true);
    expect((await h.app.request(request.path, request.init)).status).toBe(200);
    expect(h.docker.commands.filter(argv => argv[1] === "create")).toHaveLength(1);
  } finally { await h.cleanup(); }
});

test("LRU stops only the oldest idle managed project, keeps busy projects and unrelated containers", async () => {
  const h = await harness();
  try {
    for (let n = 1; n <= 6; n++) h.docker.add(h.store.add(n), h.root, true, new Date(n * 1000).toISOString());
    h.store.runningProjects.add(id(1));
    const touched = ensureRequest(id(2), label(2));
    expect((await h.app.request(touched.path, touched.init)).status).toBe(200);
    const foreign = h.docker.add({ id: id(8), previewLabel: label(8) }, h.root);
    foreign.labels = {};
    await mkdir(join(h.root, id(3), "data"), { recursive: true });
    await writeFile(join(h.root, id(3), "data", "app.db"), "retained data");
    const project = h.store.add(7);
    const request = ensureRequest(project.id, project.previewLabel);
    expect((await h.app.request(request.path, request.init)).status).toBe(200);
    expect(h.docker.commands.filter(argv => argv[1] === "stop")).toEqual([["docker", "stop", label(3)]]);
    expect(await h.runtime.count()).toBe(6);
    expect(foreign.running).toBe(true);
    expect(await readFile(join(h.root, id(3), "data", "app.db"), "utf8")).toBe("retained data");
    expect(h.docker.commands.some(argv => argv[1] === "rm")).toBe(false);
  } finally { await h.cleanup(); }
});

test("seventh ensure evicts the oldest queued-only project while queued DELETE still returns 409", async () => {
  const h = await harness();
  try {
    for (let n = 1; n <= 6; n++) h.docker.add(h.store.add(n), h.root, true, new Date(n * 1000).toISOString());
    h.store.queued.push(id(1));
    expect((await h.app.request(`/projects/${id(1)}`, { method: "DELETE", headers: auth })).status).toBe(409);
    expect(mutations(h.docker.commands)).toEqual([]);
    const project = h.store.add(7);
    const request = ensureRequest(project.id, project.previewLabel);
    expect((await h.app.request(request.path, request.init)).status).toBe(200);
    expect(h.docker.commands.filter(argv => argv[1] === "stop")).toEqual([["docker", "stop", label(1)]]);
    expect(await h.runtime.count()).toBe(6);
    expect(h.docker.containers.has(label(1))).toBe(true);
    expect(h.store.queued).toEqual([id(1)]);
    expect((await h.app.request(`/projects/${id(1)}`, { method: "DELETE", headers: auth })).status).toBe(409);
    expect(h.docker.commands.some(argv => argv[1] === "rm")).toBe(false);
  } finally { await h.cleanup(); }
});

test("full busy capacity fails without stopping work or creating another project", async () => {
  const h = await harness();
  try {
    for (let n = 1; n <= 6; n++) { h.docker.add(h.store.add(n), h.root); h.store.runningProjects.add(id(n)); }
    const project = h.store.add(7);
    const request = ensureRequest(project.id, project.previewLabel);
    const response = await h.app.request(request.path, request.init);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("busy");
    expect(mutations(h.docker.commands)).toEqual([]);
    expect(await h.runtime.count()).toBe(6);
  } finally { await h.cleanup(); }
});

test("DELETE protects queued/running work, removes only UUID runtime and leaves web-owned rows", async () => {
  const h = await harness();
  try {
    const project = h.store.add(1);
    h.docker.add(project, h.root);
    h.docker.add(h.store.add(2), h.root);
    await h.files.prepare(project.id);
    await h.files.prepare(id(2));
    await writeFile(join(h.root, id(2), "data", "retained"), "other project");
    h.store.runningProjects.add(project.id);
    expect((await h.app.request(`/projects/${project.id}`, { method: "DELETE", headers: auth })).status).toBe(409);
    expect(mutations(h.docker.commands)).toEqual([]);
    h.store.runningProjects.delete(project.id);
    const response = await h.app.request(`/projects/${project.id}`, { method: "DELETE", headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(mutations(h.docker.commands)).toEqual([["docker", "stop", label(1)], ["docker", "rm", label(1)]]);
    await expect(lstat(join(h.root, id(1)))).rejects.toThrow();
    expect(await readFile(join(h.root, id(2), "data", "retained"), "utf8")).toBe("other project");
    expect(h.store.projects.has(project.id)).toBe(true);
    expect((await h.app.request(`/projects/${project.id}`, { method: "DELETE", headers: auth })).status).toBe(200);
  } finally { await h.cleanup(); }
});

test("shots are authenticated, exact project SHA files; symlinked files/directories never escape", async () => {
  const h = await harness();
  try {
    h.store.add(1); h.store.add(2);
    const sha = "a".repeat(40);
    const shots = join(h.root, id(1), "state", "shots");
    const otherShots = join(h.root, id(2), "state", "shots");
    await mkdir(shots, { recursive: true }); await mkdir(otherShots, { recursive: true });
    await writeFile(join(shots, `${sha}.png`), new Uint8Array([137, 80, 78, 71]));
    await writeFile(join(otherShots, `${sha}.png`), "other image");
    const request = (projectId: string, filename: string) => h.app.request(`/projects/${projectId}/shots/${filename}`, { headers: auth });
    const response = await request(id(1), `${sha}.png`);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect((await request(id(1), `${"b".repeat(40)}.png`)).status).toBe(404);
    expect((await request(id(1), "abcd.png")).status).toBe(400);
    expect((await request(id(1), `${sha}.png%2F..%2F..%2Fdata%2Fapp.db`)).status).toBe(400);
    expect((await request(id(3), `${sha}.png`)).status).toBe(404);
    await symlink(join(otherShots, `${sha}.png`), join(shots, `${"b".repeat(40)}.png`));
    expect((await request(id(1), `${"b".repeat(40)}.png`)).status).toBe(404);
    await symlink(otherShots, join(h.root, id(1), "state", "linked"));
    // Removing a project containing a nested symlink must retain its target.
    expect((await h.app.request(`/projects/${id(1)}`, { method: "DELETE", headers: auth })).status).toBe(200);
    expect(await readFile(join(otherShots, `${sha}.png`), "utf8")).toBe("other image");
    await mkdir(join(h.root, id(1), "state"), { recursive: true });
    await symlink(otherShots, shots);
    expect((await request(id(1), `${sha}.png`)).status).toBe(404);
  } finally { await h.cleanup(); }
});

test("UUID and mount directory symlinks are refused without following targets", async () => {
  const h = await harness();
  try {
    h.store.add(1); h.store.add(2);
    await h.files.prepare(id(2));
    await writeFile(join(h.root, id(2), "data", "retained"), "private");
    await symlink(join(h.root, id(2)), join(h.root, id(1)));
    const request = ensureRequest(id(1), label(1));
    expect((await h.app.request(request.path, request.init)).status).toBe(409);
    expect((await h.app.request(`/projects/${id(1)}`, { method: "DELETE", headers: auth })).status).toBe(409);
    expect(await readFile(join(h.root, id(2), "data", "retained"), "utf8")).toBe("private");
    expect(mutations(h.docker.commands)).toEqual([]);
  } finally { await h.cleanup(); }
});

test("startup ensures the bridge and uses gateway's existing systemd secret/config owner", async () => {
  const h = await harness();
  try {
    await h.initialize();
    expect(h.docker.commands.some(argv => argv[0] === "systemctl" || argv[1] === "create")).toBe(false);
    h.docker.commands.length = 0;
    h.docker.network = undefined; h.docker.gatewayRunning = false;
    await h.initialize();
    expect(h.docker.commands).toContainEqual(["docker", "network", "create", "--driver", "bridge", "ma-net"]);
    expect(h.docker.commands).toContainEqual(["systemctl", "restart", "ma-gateway.service"]);
    expect(h.docker.commands.some(argv => argv.some(arg => arg.includes("Config.Env")) || argv.includes("--env"))).toBe(false);
    h.docker.network = "host";
    await expect(h.initialize()).rejects.toThrow("not a bridge");
  } finally { await h.cleanup(); }
});

test("entrypoint imports are inert and production configuration keeps the fixed bind/session pool", () => {
  const valid = { DATABASE_URL: "postgres://test:test@db.invalid:5432/test", MA_SHARED_SECRET: "fake", WEB_ORIGIN: "https://web.example" };
  expect(readManagerConfig(valid)).toEqual({ databaseUrl: valid.DATABASE_URL, secret: "fake", webOrigin: valid.WEB_ORIGIN });
  for (const config of [{}, { ...valid, HOST: "0.0.0.0" }, { ...valid, PORT: "8080" },
    { ...valid, DATABASE_URL: "postgres://test:test@db.invalid:6543/test" }, { ...valid, WEB_ORIGIN: "https://web.example/path" },
    { ...valid, MA_SHARED_SECRET: "" }]) expect(() => readManagerConfig(config)).toThrow();
});
