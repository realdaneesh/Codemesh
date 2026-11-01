import { normalizeManifestPath } from "./workspaceManifest";

export const MAX_FILE_BYTES = 256 * 1024;
export const FILE_REQUEST_TIMEOUT_MS = 10000;
export const FILE_CLIENT_TIMEOUT_MS = 12000;
export const MAX_ROOM_FILE_REQUESTS = 16;

export interface FileRequestKey {
  requestId: string;
  roomId: string;
  manifestId: string;
  path: string;
}

export class FileTransferError extends Error {
  constructor(message: string, readonly requestId = "", readonly isResponse = false) { super(message); }
}

export function parseFileRequestKey(value: Record<string, unknown>): FileRequestKey {
  if (typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.requestId)) throw new Error("Invalid file request ID");
  if (typeof value.roomId !== "string" || !/^[A-HJ-NP-Z2-9]{6}$/.test(value.roomId)) throw new Error("Invalid file request room");
  if (typeof value.manifestId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.manifestId)) throw new Error("Invalid file manifest ID");
  return { requestId: value.requestId, roomId: value.roomId, manifestId: value.manifestId, path: normalizeManifestPath(value.path) };
}

export function sameFileRequest(a: FileRequestKey, b: FileRequestKey): boolean {
  return a.requestId === b.requestId && a.roomId === b.roomId && a.manifestId === b.manifestId && a.path === b.path;
}

export function validateFileText(value: unknown): string {
  if (typeof value !== "string") throw new Error("File response must contain UTF-8 text");
  if (Buffer.byteLength(value, "utf8") > MAX_FILE_BYTES) throw new Error("File exceeds the 256 KiB UTF-8 text limit");
  if (Buffer.from(value, "utf8").toString("utf8") !== value || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error("File is binary or is not valid UTF-8 text");
  }
  return value;
}
