import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { isDefaultExcluded, normalizeManifestPath } from "../types/workspaceManifest";
import ignore from "ignore";
import { validateFileText } from "../types/fileTransfer";

export interface ImportOptions {
  isActive: () => boolean;
  isDirty: (destination: string) => boolean;
  confirm: (destination: string, exists: boolean) => Promise<boolean>;
}

function sameFile(a: BigIntStats | undefined, b: BigIntStats | undefined): boolean {
  return a === undefined || b === undefined ? a === b
    : a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function statOrMissing(destination: string): Promise<BigIntStats | undefined> {
  try { return await fs.lstat(destination, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

// Reject links in the entire destination chain, including the selected root.
async function checkDestination(root: string, destination: string): Promise<BigIntStats | undefined> {
  const relative = path.relative(root, destination);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Import destination must be inside the selected workspace");
  let current = path.parse(destination).root;
  const parts = destination.slice(current.length).split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await statOrMissing(current);
    if (!stat) {
      if (current.length <= root.length) throw new Error("Selected workspace no longer exists");
      return undefined;
    }
    if (stat.isSymbolicLink()) throw new Error("Import destination contains a symlink or junction");
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Import parent is not a directory");
    if (index === parts.length - 1) {
      if (!stat.isFile()) throw new Error("Import destination is not a regular file");
      return stat;
    }
  }
  return undefined;
}

async function checkIgnored(root: string, destination: string): Promise<void> {
  if (isDefaultExcluded(path.relative(root, destination).replace(/\\/g, "/"))) throw new Error("Import destination is excluded");
  const bases = [root];
  let ancestor = root;
  while (!await statOrMissing(path.join(ancestor, ".git"))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    bases.unshift(parent);
    ancestor = parent;
  }
  // Inherit ancestor rules only when this workspace belongs to a repository.
  if (!await statOrMissing(path.join(ancestor, ".git"))) bases.splice(0, bases.length, root);
  let current = root;
  for (const part of path.relative(root, path.dirname(destination)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); bases.push(current);
  }
  const scopes = [];
  for (const base of bases) {
    const rulesPath = path.join(base, ".gitignore");
    const stat = await statOrMissing(rulesPath);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65536n) throw new Error("Cannot safely read destination ignore rules");
    scopes.push({ base, rules: ignore().add(await fs.readFile(rulesPath, "utf8")) });
  }
  // Check directories too: a negated file cannot reinclude an excluded parent.
  const targets = [destination];
  for (let parent = path.dirname(destination); parent.length >= root.length; parent = path.dirname(parent)) {
    targets.unshift(parent);
    if (parent === root) break;
  }
  for (const target of targets) {
    let ignored = false;
    for (const scope of scopes) {
      const relative = path.relative(scope.base, target).replace(/\\/g, "/");
      if (!relative || relative.startsWith("../")) continue;
      const match = scope.rules.test(relative + (target === destination ? "" : "/"));
      if (match.ignored) ignored = true;
      else if (match.unignored) ignored = false;
    }
    if (ignored) throw new Error("Import destination is ignored");
  }
}

export async function importPreviewText(workspaceRoot: string, relativePath: string, text: string, options: ImportOptions): Promise<string | undefined> {
  const root = path.resolve(workspaceRoot);
  const destination = path.join(root, ...normalizeManifestPath(relativePath).split("/"));
  validateFileText(text);
  const rootStat = await fs.lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Select a local workspace directory without symlinks");
  const guard = () => {
    if (!options.isActive()) throw new Error("Preview is stale or the destination workspace is no longer open; request the file again");
    if (options.isDirty(destination)) throw new Error("Destination has unsaved changes. Save or discard them before importing; your draft is unchanged");
  };
  guard();
  const original = await checkDestination(root, destination);
  await checkIgnored(root, destination);
  if (!await options.confirm(destination, Boolean(original))) return undefined;
  guard();
  const revalidate = async () => {
    const nowRoot = await fs.lstat(root, { bigint: true });
    if (nowRoot.dev !== rootStat.dev || nowRoot.ino !== rootStat.ino) throw new Error("Selected workspace changed during import");
    if (!sameFile(original, await checkDestination(root, destination))) throw new Error("Destination changed during import; try again");
    await checkIgnored(root, destination);
    guard();
  };
  await revalidate();
  const created: string[] = [];
  let temporary: string | undefined;
  try {
    let parent = root;
    for (const component of path.relative(root, path.dirname(destination)).split(path.sep).filter(Boolean)) {
      parent = path.join(parent, component);
      await revalidate();
      try { await fs.mkdir(parent); created.push(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await revalidate();
    }
    await revalidate();
    temporary = path.join(path.dirname(destination), ".codemesh-import-" + randomUUID() + ".tmp");
    const handle = await fs.open(temporary, "wx", original ? Number(original.mode & 0o777n) : 0o600);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await revalidate();
    // Stage first: failures cannot truncate the destination. New files use no-clobber linking.
    if (original) { await fs.rename(temporary, destination); temporary = undefined; }
    else { await fs.link(temporary, destination); }
    return destination;
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
    for (const directory of created.reverse()) await fs.rmdir(directory).catch(() => undefined);
  }
}
