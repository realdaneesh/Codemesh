// Full-text sync keeps one edit in flight; cap text separately from JSON escaping.
export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_PATH_BYTES = 1024;
export const DOCUMENT_SIZE_ERROR = "Shared text exceeds the 256 KiB UTF-8 limit";
export const MESSAGE_SIZE_ERROR = "CodeMesh message exceeds the 2 MiB limit";

export function normalizeDocumentText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
