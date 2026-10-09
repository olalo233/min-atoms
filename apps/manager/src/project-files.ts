import { chown, lstat, mkdir, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { ManagerError, validateProjectId } from "./errors";

export const PROJECT_ROOT = "/srv/min-atoms/projects";

// Refuse symlinked ancestors, including pre-existing UUID and mount directories.
async function checkDirectories(path: string, allowMissing = false): Promise<void> {
  let current = parse(path).root;
  for (const segment of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ManagerError(409, "Unsafe runtime directory");
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export class ProjectFiles {
  readonly root: string;
  constructor(root = PROJECT_ROOT, private readonly owner = { uid: 1000, gid: 1000 }) {
    if (!isAbsolute(root)) throw new Error("Project root must be absolute");
    this.root = resolve(root);
  }

  path(id: string): string {
    validateProjectId(id);
    return join(this.root, id.toLowerCase());
  }

  async prepare(id: string): Promise<void> {
    const project = this.path(id);
    await checkDirectories(project, true);
    await mkdir(project, { recursive: true });
    for (const directory of [project, ...["workspace", "data", "state"].map(name => join(project, name))]) {
      await checkDirectories(directory, true);
      await mkdir(directory, { recursive: true });
      await checkDirectories(directory);
      await chown(directory, this.owner.uid, this.owner.gid);
    }
  }

  async remove(id: string): Promise<void> {
    const path = this.path(id);
    await checkDirectories(path, true);
    // node rm unlinks nested symlinks; it does not recurse into their targets.
    await rm(path, { recursive: true, force: true });
  }

  async shot(id: string, sha: string): Promise<Uint8Array | undefined> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new ManagerError(400, "Invalid commit SHA");
    const shots = join(this.path(id), "state", "shots");
    try {
      await checkDirectories(shots);
      // On the VM, pin every directory descriptor before descending. A project
      // process replacing shots with a symlink cannot redirect this host read.
      if (process.platform === "linux") {
        const handles = [];
        try {
          let path = "/";
          for (const segment of shots.split("/").filter(Boolean)) {
            const directory = await open(join(path, segment), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            handles.push(directory);
            path = `/proc/self/fd/${directory.fd}`;
          }
          const file = await open(join(path, `${sha}.png`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try { return (await file.stat()).isFile() ? await file.readFile() : undefined; }
          finally { await file.close(); }
        } finally { await Promise.all(handles.map(handle => handle.close())); }
      }
      const file = await open(join(shots, `${sha}.png`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { return (await file.stat()).isFile() ? await file.readFile() : undefined; }
      finally { await file.close(); }
    } catch (error) {
      if (error instanceof ManagerError || ["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      throw error;
    }
  }
}
