import * as fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { MAX_FILE_BYTES, validateFileText } from "../types/fileTransfer";
import { isDefaultExcluded, normalizeManifestPath } from "../types/workspaceManifest";
import { buildWorkspaceManifest, type WorkspacePublication, type PublishedFile } from "./workspaceManifest";

function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function checkPath(publication: WorkspacePublication, file: PublishedFile): Promise<BigIntStats> {
  const relative = path.relative(publication.root, file.absolutePath);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("File is outside the selected workspace");
  let current = publication.root;
  const root = await fs.lstat(current);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Selected workspace was replaced or became a symlink");
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("File or parent directory was replaced by a symlink");
  }
  const resolved = await fs.realpath(file.absolutePath);
  const inside = path.relative(publication.root, resolved);
  if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) throw new Error("File resolves outside the selected workspace");
  const stat = await fs.lstat(file.absolutePath, { bigint: true });
  if (!stat.isFile()) throw new Error("Listed file was removed or replaced");
  if (stat.size > BigInt(MAX_FILE_BYTES)) throw new Error("File exceeds the 256 KiB UTF-8 text limit");
  if (!unchanged(stat, file.stat)) throw new Error("File changed after publication; re-share the workspace before requesting it");
  return stat;
}

export async function readPublishedText(publication: WorkspacePublication, requestedPath: string, selectedRoot = publication.root, isActive: () => boolean = () => true): Promise<string> {
  const checkActive = () => { if (!isActive()) throw new Error("File request cancelled"); };
  checkActive();
  const documentPath = normalizeManifestPath(requestedPath);
  const file = publication.files.get(documentPath);
  if (!file || !publication.manifest.files.some((entry) => entry.path === documentPath)) throw new Error("File is not listed in the current workspace manifest");
  if (isDefaultExcluded(documentPath)) throw new Error("File is no longer eligible for sharing");
  const checkRoot = async () => {
    if (await fs.realpath(selectedRoot) !== publication.root) throw new Error("Selected workspace changed after publication; re-share it");
  };
  try {
    await checkRoot();
    await checkPath(publication, file);
    const eligible = await buildWorkspaceManifest(publication.root, publication.manifest.workspaceName, undefined, isActive);
    if (!eligible.files.some((entry) => entry.path === documentPath)) throw new Error("File is now ignored or no longer eligible; re-share the workspace");
    await checkRoot();
    await checkPath(publication, file);
    checkActive();
    const handle = await fs.open(file.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new Error("Listed file was replaced by a nonregular file");
      checkActive();
      if (!unchanged(before, file.stat)) throw new Error("File changed after publication; re-share the workspace");
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        checkActive();
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > MAX_FILE_BYTES) throw new Error("File exceeds the 256 KiB UTF-8 text limit");
      if (BigInt(length) !== before.size || !unchanged(await handle.stat({ bigint: true }), before)) throw new Error("File changed while reading; re-share the workspace");
      await checkPath(publication, file);
      await checkRoot();
      checkActive();
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
      catch { throw new Error("File is binary or is not valid UTF-8 text"); }
      return validateFileText(text);
    } finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new Error("File was removed after publication; re-share the workspace");
    if (code === "ELOOP") throw new Error("File was replaced by a symlink");
    if (code) throw new Error("Cannot safely read the shared file; check permissions and re-share");
    throw error;
  }
}
