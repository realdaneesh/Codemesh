export type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected";

import type { WorkspaceManifest, WorkspaceChanges } from "./workspaceManifest";
import type { FileRequestKey } from "./fileTransfer";

export interface Member {
  role?: "host" | "guest";
  memberId: string;
  displayName: string;
}

export interface CreateRoomMessage {
  type: "CREATE_ROOM";
  member: Member;
}

export interface RoomCreatedMessage {
  type: "ROOM_CREATED";
  roomId: string;
  member: Member;
  members: Member[];
  presenceSessionId: string;
}

export interface JoinRoomMessage {
  type: "JOIN_ROOM";
  roomId: string;
  member: Member;
}

export interface RoomJoinedMessage {
  type: "ROOM_JOINED";
  roomId: string;
  member: Member;
  members: Member[];
  presenceSessionId: string;
}

export interface LeaveRoomMessage {
  type: "LEAVE_ROOM";
}

export interface OpenDocumentMessage {
  type: "OPEN_DOCUMENT";
  roomId: string;
  documentPath: string;
  text: string;
  shareSessionId?: string;
}

export interface CloseDocumentMessage {
  type: "CLOSE_DOCUMENT";
  roomId: string;
  documentPath: string;
  shareSessionId?: string;
}

export interface SetSharedFileMessage {
  type: "SET_SHARED_FILE";
  roomId: string;
  presenceSessionId: string;
  sequence: number;
  documentPath: string | null;
}

export interface SharedFilesMessage {
  type: "SHARED_FILES";
  roomId: string;
  presenceSessionId: string;
  revision: number;
  files: { memberId: string; documentPath: string; shareId: string }[];
  openDocuments?: { memberId: string; documentPath: string; shareSessionId: string }[];
  openShares?: { memberId: string; documentPath: string; shareSessionId: string; shareId: string }[];
}

export interface CursorPosition { line: number; character: number }
export interface SelectionRange { start: CursorPosition; end: CursorPosition }
export const MAX_SELECTION_RANGES = 16;

export interface CursorUpdateMessage {
  type: "CURSOR_UPDATE";
  roomId: string;
  documentPath: string;
  presenceSessionId: string;
  shareId: string;
  sequence: number;
  position: CursorPosition;
}

export interface RemoteCursorMessage extends CursorUpdateMessage { memberId: string; recipientShareSessionId?: string }

export interface SelectionUpdateMessage {
  type: "SELECTION_UPDATE";
  roomId: string;
  documentPath: string;
  presenceSessionId: string;
  shareId: string;
  sequence: number;
  documentRevision: number;
  ranges: SelectionRange[];
}

export interface RemoteSelectionMessage extends SelectionUpdateMessage { memberId: string; recipientShareSessionId?: string }

export const TYPING_LEASE_MS = 1800;

export interface TypingActivityMessage {
  type: "TYPING_ACTIVITY";
  roomId: string;
  documentPath: string;
  presenceSessionId: string;
  shareId: string;
  sequence: number;
  active: boolean;
}

export interface RemoteTypingActivityMessage extends TypingActivityMessage {
  memberId: string;
  leaseMs: number;
  recipientShareSessionId?: string;
}

export interface TypingRejectedMessage { type: "TYPING_REJECTED"; message: string }

export interface DocumentEditMessage {
  type: "DOCUMENT_EDIT";
  roomId: string;
  documentPath: string;
  baseRevision: number;
  text: string;
  shareSessionId?: string;
}

export interface MembersUpdatedMessage {
  type: "MEMBERS_UPDATED";
  roomId: string;
  members: Member[];
}

export interface DocumentSyncMessage {
  type: "DOCUMENT_SYNC";
  roomId: string;
  documentPath: string;
  revision: number;
  text: string;
  shareSessionId?: string;
}

export interface DocumentAckMessage {
  type: "DOCUMENT_ACK";
  roomId: string;
  documentPath: string;
  revision: number;
  shareSessionId?: string;
}

export interface DocumentConflictMessage {
  type: "DOCUMENT_CONFLICT";
  roomId: string;
  documentPath: string;
  revision: number;
  text: string;
  shareSessionId?: string;
}

export interface DocumentEditBroadcastMessage {
  type: "DOCUMENT_EDIT";
  roomId: string;
  documentPath: string;
  revision: number;
  text: string;
  shareSessionId?: string;
}

export interface ErrorMessage {
  type: "ERROR";
  message: string;
  roomId?: string;
  documentPath?: string;
  shareSessionId?: string;
}

export interface ShareWorkspaceMessage {
  type: "SHARE_WORKSPACE";
  roomId: string;
  manifest: WorkspaceManifest;
  publicationId?: string;
  baseManifestId?: string;
  changedPaths?: string[];
}

export interface EndWorkspaceMessage {
  type: "END_WORKSPACE";
  roomId: string;
}

export interface WorkspaceManifestMessage {
  type: "WORKSPACE_MANIFEST";
  roomId: string;
  manifest: WorkspaceManifest | null;
  ownedByYou: boolean;
  manifestId: string | null;
  publicationId: string | null;
}

export interface FileRequestMessage extends FileRequestKey { type: "FILE_REQUEST" }
export interface WorkspaceChangesMessage { type: "WORKSPACE_CHANGES"; roomId: string; manifestId: string; changes: WorkspaceChanges }
export interface FileResponseMessage extends FileRequestKey { type: "FILE_RESPONSE"; text: string }
export interface FileFailureMessage extends FileRequestKey { type: "FILE_FAILURE"; message: string }
export interface FileCancelMessage extends FileRequestKey { type: "FILE_CANCEL" }
export interface FileErrorMessage { type: "FILE_ERROR"; requestId: string; message: string }

export interface WorkspaceErrorMessage {
  type: "WORKSPACE_ERROR";
  message: string;
}

export type ClientMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | LeaveRoomMessage
  | OpenDocumentMessage
  | CloseDocumentMessage
  | SetSharedFileMessage
  | CursorUpdateMessage
  | SelectionUpdateMessage
  | TypingActivityMessage
  | ShareWorkspaceMessage
  | EndWorkspaceMessage
  | FileRequestMessage
  | FileResponseMessage
  | FileFailureMessage
  | FileCancelMessage
  | DocumentEditMessage;

export type ServerMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | MembersUpdatedMessage
  | SharedFilesMessage
  | RemoteCursorMessage
  | RemoteSelectionMessage
  | RemoteTypingActivityMessage
  | TypingRejectedMessage
  | DocumentSyncMessage
  | DocumentAckMessage
  | DocumentConflictMessage
  | DocumentEditBroadcastMessage
  | WorkspaceManifestMessage
  | WorkspaceChangesMessage
  | WorkspaceErrorMessage
  | FileRequestMessage
  | FileResponseMessage
  | FileCancelMessage
  | FileErrorMessage
  | ErrorMessage;
