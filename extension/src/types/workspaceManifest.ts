export const MAX_MANIFEST_FILES = 2000;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_MANIFEST_PATH_BYTES = 1024;

export interface ManifestFile {
  path: string;
  size: number;
}

export interface WorkspaceManifest {
  workspaceName: string;
  files: ManifestFile[];
}

export class WorkspaceRequestError extends Error {}

export interface WorkspaceChanges { added: string[]; changed: string[]; removed: string[] }

export function validateWorkspaceChanges(value: unknown): WorkspaceChanges {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace change summary");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["added", "changed", "removed"].includes(key))) throw new Error("Unsupported workspace change fields");
  const seen = new Set<string>();
  const paths = (key: string): string[] => {
    const list = record[key];
    if (!Array.isArray(list) || list.length > MAX_MANIFEST_FILES) throw new Error("Workspace change summary exceeds the file limit");
    return list.map((value) => {
      const path = normalizeManifestPath(value);
      if (seen.has(path)) throw new Error("Duplicate workspace change path");
      seen.add(path);
      return path;
    });
  };
  const result = { added: paths("added"), changed: paths("changed"), removed: paths("removed") };
  if (seen.size > 2 * MAX_MANIFEST_FILES) throw new Error("Workspace change summary exceeds the file limit");
  return result;
}

export function normalizeManifestPath(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > MAX_MANIFEST_PATH_BYTES) {
    throw new Error("Manifest path must be a nonempty relative path of at most 1024 UTF-8 bytes");
  }
  const normalized = value.replace(/\\/g, "/").normalize("NFC");
  if (Buffer.byteLength(normalized, "utf8") > MAX_MANIFEST_PATH_BYTES) throw new Error("Normalized manifest path exceeds the 1024-byte UTF-8 limit");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[<>:"|?*\x00-\x1f\x7f]/.test(segment) || /[. ]$/.test(segment)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error("Manifest paths must be portable workspace-relative paths without traversal");
  }
  return normalized;
}

export function isDefaultExcluded(manifestPath: string): boolean {
  return manifestPath.split("/").some((segment) => {
    const name = segment.toLowerCase();
    return [".git", "node_modules", "bower_components", "vendor", ".venv", "venv", "__pycache__",
      "dist", "build", "out", "target", "bin", "obj", "coverage", ".next", ".nuxt", ".cache", ".turbo", ".ssh",
      ".yarn", ".pnpm-store", ".gradle", ".svelte-kit", ".angular", ".parcel-cache"].includes(name)
      || /^\.env(?:$|\.)/.test(name) || name === ".envrc" || name.endsWith(".env")
      || /\.(pem|key|p12|pfx|ppk|priv|keystore)$/.test(name)
      || /^id_(rsa|dsa|ecdsa|ed25519)(?:$|\.)/.test(name)
      || /^private[-_]key(?:$|\.)/.test(name);
  });
}

export function validateWorkspaceManifest(value: unknown): WorkspaceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workspace manifest is required");
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).some((key) => key !== "workspaceName" && key !== "files")) {
    throw new Error("Manifest contains unsupported fields; only names, paths and sizes are allowed");
  }
  if (typeof manifest.workspaceName !== "string" || !manifest.workspaceName.trim()
    || Buffer.byteLength(manifest.workspaceName, "utf8") > 128
    || /[\\/:\x00-\x1f\x7f]/.test(manifest.workspaceName) || [".", ".."].includes(manifest.workspaceName)) {
    throw new Error("Workspace name must be a label of at most 128 UTF-8 bytes, not a path");
  }
  if (!Array.isArray(manifest.files)) throw new Error("Manifest files must be an array");
  if (manifest.files.length > MAX_MANIFEST_FILES) throw new Error("Workspace manifest exceeds the 2000-file limit");
  const paths = new Set<string>();
  const files = manifest.files.map((value: unknown): ManifestFile => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid manifest file");
    const file = value as Record<string, unknown>;
    if (Object.keys(file).some((key) => key !== "path" && key !== "size")) throw new Error("Manifest files may contain only path and size");
    const path = normalizeManifestPath(file.path);
    if (isDefaultExcluded(path)) throw new Error("Manifest includes a default-excluded file or directory");
    // Case-fold as well as normalize separators to avoid collisions on Windows receivers.
    const key = path.toLowerCase();
    if (paths.has(key)) throw new Error("Manifest contains duplicate normalized paths");
    paths.add(key);
    if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Manifest sizes must be nonnegative safe integers");
    return { path, size: file.size };
  });
  const result = { workspaceName: manifest.workspaceName, files };
  // Reserve space for the room and protocol envelope in both directions.
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_MANIFEST_BYTES - 512) {
    throw new Error("Workspace manifest exceeds the 256 KiB message limit");
  }
  return result;
}
