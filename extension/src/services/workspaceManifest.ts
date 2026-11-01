import * as fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";
import { isDefaultExcluded, MAX_MANIFEST_BYTES, MAX_MANIFEST_FILES, normalizeManifestPath, validateWorkspaceManifest, type ManifestFile, type WorkspaceManifest } from "../types/workspaceManifest";

interface IgnoreScope { base: string; rules: Ignore }
export interface PublishedFile { absolutePath: string; stat: BigIntStats }
export interface WorkspacePublication { root: string; manifest: WorkspaceManifest; files: Map<string, PublishedFile> }

export async function buildWorkspacePublication(rootPath: string, workspaceName: string, isActive: () => boolean = () => true): Promise<WorkspacePublication> {
  const root = await fs.realpath(rootPath);
  const files = new Map<string, PublishedFile>();
  const manifest = await buildWorkspaceManifest(root, workspaceName, files, isActive);
  return { root, manifest, files };
}

export async function buildWorkspaceManifest(rootPath: string, workspaceName: string, snapshots?: Map<string, PublishedFile>, isActive: () => boolean = () => true): Promise<WorkspaceManifest> {
  const checkActive = () => { if (!isActive()) throw new Error("Workspace scan cancelled"); };
  checkActive();
  const root = await fs.realpath(rootPath);
  if (!(await fs.lstat(root)).isDirectory()) throw new Error("Select a workspace directory");
  validateWorkspaceManifest({ workspaceName, files: [] });
  const files: ManifestFile[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ workspaceName, files: [] }), "utf8");
  let visited = 0;
  const isInside = (absolute: string) => {
    const relative = path.relative(root, absolute);
    return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
  };
  const readRules = async (base: string): Promise<IgnoreScope | undefined> => {
    const ignorePath = path.join(base, ".gitignore");
    try {
      const stats = await fs.lstat(ignorePath);
      if (stats.isFile() && !stats.isSymbolicLink()) {
        if (stats.size > 64 * 1024) throw new Error("Workspace .gitignore exceeds the 64 KiB scan limit");
        return { base, rules: ignore().add(await fs.readFile(ignorePath, "utf8")) };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return undefined;
  };
  const isIgnored = (absolute: string, directory: boolean, scopes: IgnoreScope[]): boolean => {
    let ignored = false;
    for (const scope of scopes) {
      const candidate = path.relative(scope.base, absolute).replace(/\\/g, "/") + (directory ? "/" : "");
      const match = scope.rules.test(candidate);
      if (match.ignored) ignored = true;
      else if (match.unignored) ignored = false;
    }
    return ignored;
  };
  // When a workspace opens a repository subdirectory, inherit ignore rules up to .git.
  const ancestors: string[] = [];
  let ancestor = root;
  let repositoryFound = false;
  while (true) {
    checkActive();
    try {
      const stats = await fs.lstat(path.join(ancestor, ".git"));
      if (!stats.isSymbolicLink() && (stats.isDirectory() || stats.isFile())) { repositoryFound = true; break; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestors.push(parent);
    ancestor = parent;
  }
  const inherited: IgnoreScope[] = [];
  if (repositoryFound) {
    for (const base of ancestors.reverse()) {
      const scope = await readRules(base);
      if (scope) inherited.push(scope);
    }
    if (inherited.length && isIgnored(root, true, inherited)) return validateWorkspaceManifest({ workspaceName, files });
  }
  const walk = async (relative: string, inherited: IgnoreScope[]): Promise<void> => {
    checkActive();
    const absolute = path.join(root, relative);
    const stats = await fs.lstat(absolute);
    if (stats.isSymbolicLink() || !isInside(await fs.realpath(absolute))) return;
    const scopes = [...inherited];
    const scope = await readRules(absolute);
    if (scope) scopes.push(scope);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      checkActive();
      if (++visited > 20000) throw new Error("Workspace scan exceeds the 20000-entry limit");
      const rawPath = relative ? relative + "/" + entry.name : entry.name;
      if (isDefaultExcluded(rawPath) || entry.isSymbolicLink()) continue;
      if (entry.name.includes("\\")) throw new Error("Workspace filename contains an ambiguous path separator");
      const documentPath = normalizeManifestPath(rawPath);
      const stats = await fs.lstat(path.join(root, rawPath));
      if (stats.isSymbolicLink()) continue;
      if (isIgnored(path.join(root, rawPath), stats.isDirectory(), scopes)) continue;
      if (stats.isDirectory()) await walk(rawPath, scopes);
      else if (stats.isFile() && isInside(await fs.realpath(path.join(root, rawPath)))) {
        if (files.length === MAX_MANIFEST_FILES) throw new Error("Workspace manifest exceeds the 2000-file limit");
        const file = { path: documentPath, size: stats.size };
        if (snapshots) {
          const absolutePath = path.join(root, rawPath);
          const stat = await fs.lstat(absolutePath, { bigint: true });
          if (!stat.isFile() || stat.size !== BigInt(stats.size)) throw new Error("File changed while publishing the workspace; retry sharing");
          snapshots.set(documentPath, { absolutePath, stat });
        }
        bytes += Buffer.byteLength(JSON.stringify(file), "utf8") + (files.length ? 1 : 0);
        if (bytes > MAX_MANIFEST_BYTES - 512) throw new Error("Workspace manifest exceeds the 256 KiB message limit");
        files.push(file);
      }
    }
  };
  await walk("", inherited);
  return validateWorkspaceManifest({ workspaceName, files });
}
