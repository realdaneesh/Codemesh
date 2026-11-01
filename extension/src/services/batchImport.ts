import { importPreviewText, type ImportOptions } from "./fileImport";
import { MAX_FILE_BYTES, validateFileText } from "../types/fileTransfer";
import { validateWorkspaceManifest, type ManifestFile } from "../types/workspaceManifest";

export const MAX_BATCH_FILES = 50;
export const MAX_BATCH_BYTES = 10 * 1024 * 1024;
export interface ImportResult { path: string; status: "imported" | "declined" | "failed" | "cancelled"; detail: string }
export interface BatchOptions extends ImportOptions {
  review: (files: ManifestFile[], bytes: number) => Promise<boolean>;
  request: (path: string) => Promise<string>;
  isCancelled: () => boolean;
  progress: (completed: number, total: number, path: string) => void;
}

export async function importWorkspaceFiles(root: string, selected: ManifestFile[], options: BatchOptions): Promise<ImportResult[]> {
  const files = validateWorkspaceManifest({ workspaceName: "Import", files: selected }).files;
  const bytes = files.reduce((total, file) => total + file.size, 0);
  if (!files.length || files.length > MAX_BATCH_FILES || bytes > MAX_BATCH_BYTES) throw new Error("Select 1–50 files totaling at most 10 MiB");
  if (files.some((file) => file.size > MAX_FILE_BYTES)) throw new Error("Each file must be at most 256 KiB");
  // The review is the only operation before consent: no requests, mkdirs or writes.
  const approved = await options.review(files, bytes);
  const results: ImportResult[] = [];
  for (const file of files) {
    const active = () => approved && !options.isCancelled() && options.isActive();
    if (!active()) {
      results.push({ path: file.path, status: "cancelled", detail: approved ? "Cancelled or manifest/session changed; no write" : "Review declined; no write" });
      continue;
    }
    options.progress(results.length, files.length, file.path);
    try {
      const text = validateFileText(await options.request(file.path));
      if (Buffer.byteLength(text, "utf8") !== file.size) throw new Error("File size differs from reviewed manifest");
      const destination = await importPreviewText(root, file.path, text, { ...options, isActive: active });
      results.push({ path: file.path, status: destination ? "imported" : "declined", detail: destination ?? "Overwrite declined; unchanged" });
    } catch (error) {
      results.push({ path: file.path, status: active() ? "failed" : "cancelled", detail: error instanceof Error ? error.message : String(error) });
    }
    options.progress(results.length, files.length, file.path);
  }
  return results;
}
