import { MAX_SELECTION_RANGES, type ClientMessage, type Member, type CursorPosition, type SelectionRange } from "../types/protocol";
import { FileTransferError, parseFileRequestKey, validateFileText } from "../types/fileTransfer";
import { MAX_MANIFEST_BYTES, validateWorkspaceManifest, validateWorkspaceChanges, WorkspaceRequestError } from "../types/workspaceManifest";
import { DOCUMENT_SIZE_ERROR, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PATH_BYTES, MAX_MESSAGE_BYTES, MESSAGE_SIZE_ERROR, normalizeDocumentText } from "../types/syncLimits";

export function parseClientMessage(raw: string): ClientMessage {
  if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) throw new Error(MESSAGE_SIZE_ERROR);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Message must be valid JSON");
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("Message must include a type");
  }

  switch (parsed.type) {
    case "FILE_REQUEST":
    case "FILE_RESPONSE":
    case "FILE_FAILURE":
    case "FILE_CANCEL":
      try {
        const key = parseFileRequestKey(parsed);
        const extra = parsed.type === "FILE_RESPONSE" ? ["text"] : parsed.type === "FILE_FAILURE" ? ["message"] : [];
        if (Object.keys(parsed).some((name) => !["type", "requestId", "roomId", "manifestId", "path", ...extra].includes(name))) throw new Error("Unsupported file-transfer fields");
        if (parsed.type === "FILE_RESPONSE") return { type: "FILE_RESPONSE", ...key, text: validateFileText(parsed.text) };
        if (parsed.type === "FILE_FAILURE") {
          if (typeof parsed.message !== "string" || !parsed.message || Buffer.byteLength(parsed.message, "utf8") > 512) throw new Error("Invalid file-transfer error");
          return { type: "FILE_FAILURE", ...key, message: parsed.message };
        }
        return { type: parsed.type, ...key };
      } catch (error) {
        throw new FileTransferError(error instanceof Error ? error.message : String(error), typeof parsed.requestId === "string" ? parsed.requestId.slice(0, 64) : "", parsed.type === "FILE_RESPONSE" || parsed.type === "FILE_FAILURE");
      }
    case "SHARE_WORKSPACE":
    case "END_WORKSPACE":
      try {
        if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) throw new Error("Workspace manifest exceeds the 256 KiB message limit");
        const keys = parsed.type === "SHARE_WORKSPACE" ? ["type", "roomId", "manifest", "publicationId", "baseManifestId", "changedPaths"] : ["type", "roomId"];
        if (Object.keys(parsed).some((key) => !keys.includes(key))) throw new Error("Workspace messages contain unsupported fields");
        const roomId = parseRoomId(parsed.roomId, parsed.type);
        if (parsed.publicationId !== undefined && (typeof parsed.publicationId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.publicationId))) throw new Error("Invalid workspace publication ID");
        let refresh: { baseManifestId: string; changedPaths: string[] } | undefined;
        if (parsed.baseManifestId !== undefined || parsed.changedPaths !== undefined) {
          if (typeof parsed.baseManifestId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.baseManifestId)) throw new Error("Invalid refresh manifest ID");
          refresh = { baseManifestId: parsed.baseManifestId, changedPaths: validateWorkspaceChanges({ added: [], changed: parsed.changedPaths, removed: [] }).changed };
        }
        return parsed.type === "END_WORKSPACE" ? { type: "END_WORKSPACE", roomId } : {
          type: "SHARE_WORKSPACE", roomId, manifest: validateWorkspaceManifest(parsed.manifest), publicationId: parsed.publicationId as string | undefined, ...refresh
        };
      } catch (error) {
        throw new WorkspaceRequestError(error instanceof Error ? error.message : String(error));
      }
    case "CREATE_ROOM":
      return {
        type: "CREATE_ROOM",
        member: parseMember(parsed.member)
      };
    case "JOIN_ROOM":
      if (typeof parsed.roomId !== "string" || parsed.roomId.trim().length === 0) {
        throw new Error("JOIN_ROOM requires a roomId");
      }

      if (!/^[A-HJ-NP-Z2-9]{6}$/.test(parsed.roomId.trim().toUpperCase())) {
        throw new Error("JOIN_ROOM requires a valid six-character roomId");
      }

      return {
        type: "JOIN_ROOM",
        roomId: parsed.roomId.trim().toUpperCase(),
        member: parseMember(parsed.member)
      };
    case "LEAVE_ROOM":
      return { type: "LEAVE_ROOM" };
    case "OPEN_DOCUMENT":
      return {
        type: "OPEN_DOCUMENT",
        roomId: parseRoomId(parsed.roomId, "OPEN_DOCUMENT"),
        documentPath: parseDocumentPath(parsed.documentPath),
        text: parseText(parsed.text, "OPEN_DOCUMENT"),
        shareSessionId: parseOptionalShareSessionId(parsed.shareSessionId)
      };
    case "CLOSE_DOCUMENT":
      return {
        type: "CLOSE_DOCUMENT",
        roomId: parseRoomId(parsed.roomId, "CLOSE_DOCUMENT"),
        documentPath: parseDocumentPath(parsed.documentPath),
        shareSessionId: parseOptionalShareSessionId(parsed.shareSessionId)
      };
    case "SET_SHARED_FILE":
      if (Object.keys(parsed).some((key) => !["type", "roomId", "presenceSessionId", "sequence", "documentPath"].includes(key))) {
        throw new Error("Shared-file presence contains unsupported fields");
      }
      if (typeof parsed.presenceSessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.presenceSessionId)) {
        throw new Error("Shared-file presence requires a valid session ID");
      }
      if (typeof parsed.sequence !== "number" || !Number.isSafeInteger(parsed.sequence) || parsed.sequence < 1) {
        throw new Error("Shared-file presence requires a positive sequence");
      }
      return {
        type: "SET_SHARED_FILE",
        roomId: parseRoomId(parsed.roomId, "SET_SHARED_FILE"),
        presenceSessionId: parsed.presenceSessionId,
        sequence: parsed.sequence,
        documentPath: parsed.documentPath === null ? null : parseDocumentPath(parsed.documentPath)
      };
    case "CURSOR_UPDATE":
      if (Object.keys(parsed).some((key) => !["type", "roomId", "documentPath", "presenceSessionId", "shareId", "sequence", "position"].includes(key))) {
        throw new Error("Cursor update contains unsupported fields");
      }
      if (typeof parsed.presenceSessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.presenceSessionId)
        || typeof parsed.shareId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.shareId)) {
        throw new Error("Cursor update requires valid session IDs");
      }
      const sequence = parsed.sequence;
      if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Cursor update requires a positive sequence");
      const position = parsed.position;
      if (!position || typeof position !== "object" || Array.isArray(position)
        || Object.keys(position).sort().join() !== "character,line") {
        throw new Error("Cursor position must be bounded non-negative line and character integers");
      }
      const coordinates = position as Record<string, unknown>;
      const line = coordinates.line;
      const character = coordinates.character;
      if (typeof line !== "number" || typeof character !== "number"
        || !Number.isSafeInteger(line) || !Number.isSafeInteger(character)
        || line < 0 || line > 1000000 || character < 0 || character > 1000000) {
        throw new Error("Cursor position must be bounded non-negative line and character integers");
      }
      return {
        type: "CURSOR_UPDATE", roomId: parseRoomId(parsed.roomId, "CURSOR_UPDATE"),
        documentPath: parseDocumentPath(parsed.documentPath), presenceSessionId: parsed.presenceSessionId,
        shareId: parsed.shareId, sequence,
        position: { line, character }
      };
    case "SELECTION_UPDATE": {
      if (Object.keys(parsed).some((key) => !["type", "roomId", "documentPath", "presenceSessionId", "shareId", "sequence", "documentRevision", "ranges"].includes(key))) {
        throw new Error("Selection update contains unsupported fields");
      }
      if (typeof parsed.presenceSessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.presenceSessionId)
        || typeof parsed.shareId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.shareId)) {
        throw new Error("Selection update requires valid session IDs");
      }
      if (typeof parsed.sequence !== "number" || !Number.isSafeInteger(parsed.sequence) || parsed.sequence < 1) {
        throw new Error("Selection update requires a positive sequence");
      }
      if (typeof parsed.documentRevision !== "number" || !Number.isSafeInteger(parsed.documentRevision) || parsed.documentRevision < 0) {
        throw new Error("Selection update requires a non-negative document revision");
      }
      return {
        type: "SELECTION_UPDATE", roomId: parseRoomId(parsed.roomId, "SELECTION_UPDATE"),
        documentPath: parseDocumentPath(parsed.documentPath), presenceSessionId: parsed.presenceSessionId,
        shareId: parsed.shareId, sequence: parsed.sequence, documentRevision: parsed.documentRevision,
        ranges: parseSelectionRanges(parsed.ranges)
      };
    }
    case "TYPING_ACTIVITY": {
      if (Object.keys(parsed).some((key) => !["type", "roomId", "documentPath", "presenceSessionId", "shareId", "sequence", "active"].includes(key))) {
        throw new Error("Typing activity contains unsupported fields");
      }
      if (typeof parsed.presenceSessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.presenceSessionId)
        || typeof parsed.shareId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.shareId)) {
        throw new Error("Typing activity requires valid session IDs");
      }
      if (typeof parsed.sequence !== "number" || !Number.isSafeInteger(parsed.sequence) || parsed.sequence < 1
        || typeof parsed.active !== "boolean") throw new Error("Typing activity requires a positive sequence and boolean state");
      return { type: "TYPING_ACTIVITY", roomId: parseRoomId(parsed.roomId, "TYPING_ACTIVITY"),
        documentPath: parseDocumentPath(parsed.documentPath), presenceSessionId: parsed.presenceSessionId,
        shareId: parsed.shareId, sequence: parsed.sequence, active: parsed.active };
    }
    case "DOCUMENT_EDIT":
      return {
        type: "DOCUMENT_EDIT",
        roomId: parseRoomId(parsed.roomId, "DOCUMENT_EDIT"),
        documentPath: parseDocumentPath(parsed.documentPath),
        baseRevision: parseRevision(parsed.baseRevision),
        text: parseText(parsed.text, "DOCUMENT_EDIT"),
        shareSessionId: parseOptionalShareSessionId(parsed.shareSessionId)
      };
    default:
      throw new Error(`Unsupported message type: ${parsed.type}`);
  }
}

function parseOptionalShareSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("Document share session ID must be a UUID");
  return value;
}

function parseSelectionRanges(value: unknown): SelectionRange[] {
  if (!Array.isArray(value) || value.length > MAX_SELECTION_RANGES) {
    throw new Error(`Selection update supports at most ${MAX_SELECTION_RANGES} ranges`);
  }
  return value.map((range) => {
    if (!isRecord(range) || Object.keys(range).sort().join() !== "end,start") {
      throw new Error("Selection range must contain start and end positions only");
    }
    const start = parseSelectionPosition(range.start);
    const end = parseSelectionPosition(range.end);
    if (start.line > end.line || (start.line === end.line && start.character >= end.character)) {
      throw new Error("Selection range must be non-empty and ordered");
    }
    return { start, end };
  });
}

function parseSelectionPosition(value: unknown): CursorPosition {
  if (!isRecord(value) || Object.keys(value).sort().join() !== "character,line"
    || typeof value.line !== "number" || typeof value.character !== "number"
    || !Number.isSafeInteger(value.line) || !Number.isSafeInteger(value.character)
    || value.line < 0 || value.line > 1000000 || value.character < 0 || value.character > 1000000) {
    throw new Error("Selection position must be bounded non-negative line and character integers");
  }
  return { line: value.line, character: value.character };
}

function parseRoomId(value: unknown, type: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${type} requires a roomId`);
  }

  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(value.trim().toUpperCase())) {
    throw new Error(`${type} requires a valid six-character roomId`);
  }

  return value.trim().toUpperCase();
}

function parseDocumentPath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Document message requires a documentPath");
  }

  const documentPath = value.trim().replace(/\\/g, "/");
  if (Buffer.byteLength(documentPath, "utf8") > MAX_DOCUMENT_PATH_BYTES) {
    throw new Error("Document path exceeds the 1024-byte UTF-8 limit");
  }
  const segments = documentPath.split("/");
  if (
    documentPath.startsWith("/")
    || /^[A-Za-z]:\//.test(documentPath)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Document path must be workspace-relative");
  }

  return documentPath;
}

function parseText(value: unknown, type: string): string {
  if (typeof value !== "string") {
    throw new Error(`${type} requires text`);
  }

  const text = normalizeDocumentText(value);
  if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) throw new Error(DOCUMENT_SIZE_ERROR);
  return text;
}

function parseRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("DOCUMENT_EDIT requires a non-negative baseRevision");
  }

  return value;
}

function parseMember(value: unknown): Member {
  if (!isRecord(value)) {
    throw new Error("Message requires member information");
  }

  if (typeof value.memberId !== "string" || value.memberId.trim().length === 0) {
    throw new Error("Member requires a memberId");
  }

  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0) {
    throw new Error("Member requires a displayName");
  }

  return {
    memberId: value.memberId,
    displayName: value.displayName
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
