import { createInviteLink, parseInviteLink } from "./invitations";
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { MAX_SELECTION_RANGES, TYPING_LEASE_MS, type ClientMessage, type ConnectionState, type CursorPosition, type Member, type SelectionRange, type ServerMessage } from "../types/protocol";
import { DOCUMENT_SIZE_ERROR, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PATH_BYTES, MAX_MESSAGE_BYTES, MESSAGE_SIZE_ERROR, normalizeDocumentText } from "../types/syncLimits";
import { MAX_MANIFEST_BYTES, normalizeManifestPath, validateWorkspaceManifest, validateWorkspaceChanges, type WorkspaceManifest, type WorkspaceChanges } from "../types/workspaceManifest";
import { buildWorkspacePublication, type WorkspacePublication } from "./workspaceManifest";
import { readPublishedText } from "./fileContent";
import { importPreviewText } from "./fileImport";
import { importWorkspaceFiles, type ImportResult } from "./batchImport";
import { proposeCombinedText } from "./conflictProposal";
import { DEFAULT_SERVER_URL, validateServerUrl } from "./serverConnection";
import { DocumentSyncSession, type SessionConflict, type SessionRecovery, type SessionSnapshot } from "./DocumentSyncSession";
import { DocumentPresenceSession } from "./DocumentPresenceSession";
import { FILE_CLIENT_TIMEOUT_MS, MAX_FILE_BYTES, MAX_ROOM_FILE_REQUESTS, parseFileRequestKey, sameFileRequest, validateFileText, type FileRequestKey } from "../types/fileTransfer";

export interface CodeMeshState {
  connectionState: ConnectionState;
  roomId: string | undefined;
  members: Member[];
  sharedFiles: { memberId: string; documentPath: string }[];
  openSharedFiles: { memberId: string; documentPath: string; shareSessionId: string }[];
  recentEditFiles: { memberId: string; documentPath: string; shareSessionId: string }[];
  typingMemberIds: string[];
  self: Member;
  sharedDocumentPath?: string;
  documentStatus?: "opening" | "shared" | "conflict" | "paused";
  documentError?: string;
  workspaceManifest?: WorkspaceManifest;
  ownsWorkspaceManifest?: boolean;
  workspaceManifestId?: string;
  workspaceChanges?: WorkspaceChanges;
}

export interface CodeMeshClientOptions {
  connectionTimeoutMs?: number;
  serverUrl?: string;
  reconnectDelayMs?: number;
  self?: Member;
  fileRequestTimeoutMs?: number;
  documentAckTimeoutMs?: number;
}

interface PendingFilePreview {
  key: FileRequestKey;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface LocalPublication {
  folder: vscode.WorkspaceFolder;
  publication: WorkspacePublication;
  publicationId: string;
}

type PendingRoomRequest = "create" | "join" | "restore" | undefined;

interface DocumentConflict {
  roomId: string;
  path: string;
  session: number;
  revision: number;
  text: string;
  base: string | undefined;
  requiresInspection: boolean;
  comparison?: { draft: string; stale: boolean; mine: vscode.Uri; room: vscode.Uri };
  proposal?: { draft: string; text: string; stale: boolean; mine: vscode.Uri; room: vscode.Uri };
  recovery?: CombinedRecovery;
}

interface CombinedRecovery {
  path: string;
  revision: number;
  original: vscode.Uri;
  proposed: vscode.Uri;
  room: vscode.Uri;
  reviewed: boolean;
}

const UNSHARED_COMBINATION = "An approved proposed combination was applied to your unsaved editor, but was NOT shared with the room. Sharing is paused. No file was saved or restored.";

export class CodeMeshClient implements vscode.Disposable {
  private socket: WebSocket | undefined;
  private cloudCredential?: string;
  private invitation?: { token: string; expires: number };
  private invitationServer?: string;
  private activeServer?: string;
  private get configuredServer(): string {
    return validateServerUrl(this.invitationServer ?? this.options.serverUrl ?? vscode.workspace.getConfiguration("codemesh").get<string>("serverUrl", DEFAULT_SERVER_URL));
  }
  private get cloudMode(): boolean {
    return this.invitationServer !== undefined || vscode.workspace.getConfiguration("codemesh").get<string>("connectionMode", "lan") === "cloud";
  }
  private sendCloud(value: object): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Connect to a cloud room first");
    this.socket.send(JSON.stringify(value));
  }
  async copyInviteLink(): Promise<void> {
    if (!this.cloudMode || !this.state.roomId) throw new Error("Create a cloud room first");
    this.sendCloud({ type: "CREATE_INVITE" });
  }
  revokeInvitations(): void { this.invitation = undefined; this.sendCloud({ type: "REVOKE_INVITES" }); }
  async joinInvitation(value: string): Promise<void> {
    const invite = parseInviteLink(value);
    const accepted = await vscode.window.showWarningMessage(
      `Join a CodeMesh session at ${invite.server}? The relay can read shared content. Files are shared and imported only through explicit commands.`,
      { modal: true }, "Join");
    if (accepted !== "Join") return;
    this.leaveRoom();
    this.socket?.terminate(); this.socket = undefined; this.connectionPromise = undefined;
    this.cloudCredential = undefined; this.invitationServer = invite.server;
    await this.ensureConnected(); this.pendingRoomRequest = "join";
    this.sendCloud({ type: "AUTH_JOIN", token: invite.token, displayName: this.state.self.displayName });
  }
  private connectionPromise: Promise<void> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private restoreRoomId: string | undefined;
  private pendingRoomRequest: PendingRoomRequest;
  private readonly primaryDocument = {
    documentListener: undefined as vscode.Disposable | undefined,
    documentCloseListener: undefined as vscode.Disposable | undefined,
    path: undefined as string | undefined,
    shareSessionId: undefined as string | undefined,
    revision: 0,
    confirmed: undefined as { text: string; revision: number } | undefined,
    sent: undefined as { text: string; baseRevision: number } | undefined,
    receivedRevision: 0,
    inFlight: false,
    ackTimer: undefined as NodeJS.Timeout | undefined,
    pending: undefined as string | undefined,
    conflicted: false,
    conflict: undefined as DocumentConflict | undefined,
    approvedProposal: undefined as { conflict: DocumentConflict } | undefined,
    recovery: undefined as CombinedRecovery | undefined,
    snapshots: new Map<string, { text: string; stale: boolean }>(),
    awaitingSync: false,
    generation: 0,
    document: undefined as vscode.TextDocument | undefined,
    applyingPath: undefined as string | undefined,
    applyingText: undefined as string | undefined,
    remoteQueue: Promise.resolve() as Promise<void>
  };
  private get documentListener() { return this.primaryDocument.documentListener; }
  private set documentListener(value: vscode.Disposable | undefined) { this.primaryDocument.documentListener = value; }
  private get documentCloseListener() { return this.primaryDocument.documentCloseListener; }
  private set documentCloseListener(value: vscode.Disposable | undefined) { this.primaryDocument.documentCloseListener = value; }
  private get sharedDocumentPath() { return this.primaryDocument.path; }
  private set sharedDocumentPath(value: string | undefined) { this.primaryDocument.path = value; }
  private get sharedDocumentSessionId() { return this.primaryDocument.shareSessionId; }
  private set sharedDocumentSessionId(value: string | undefined) { this.primaryDocument.shareSessionId = value; }
  private readonly additionalDocuments = new Map<string, DocumentSyncSession>();
  private readonly additionalPresence = new Map<string, DocumentPresenceSession>();
  private readonly additionalRecoveryArchive = new Map<string, SessionRecovery>();
  private presenceSessionId: string | undefined;
  private presenceSequence = 0;
  private presenceRevision = -1;
  private get sharedDocumentRevision() { return this.primaryDocument.revision; }
  private set sharedDocumentRevision(value: number) { this.primaryDocument.revision = value; }
  private get confirmedDocument() { return this.primaryDocument.confirmed; }
  private set confirmedDocument(value: { text: string; revision: number } | undefined) { this.primaryDocument.confirmed = value; }
  private get sentDocument() { return this.primaryDocument.sent; }
  private set sentDocument(value: { text: string; baseRevision: number } | undefined) { this.primaryDocument.sent = value; }
  private get receivedDocumentRevision() { return this.primaryDocument.receivedRevision; }
  private set receivedDocumentRevision(value: number) { this.primaryDocument.receivedRevision = value; }
  private get documentEditInFlight() { return this.primaryDocument.inFlight; }
  private set documentEditInFlight(value: boolean) { this.primaryDocument.inFlight = value; }
  private get documentAckTimer() { return this.primaryDocument.ackTimer; }
  private set documentAckTimer(value: NodeJS.Timeout | undefined) { this.primaryDocument.ackTimer = value; }
  private get pendingDocumentText() { return this.primaryDocument.pending; }
  private set pendingDocumentText(value: string | undefined) { this.primaryDocument.pending = value; }
  private get documentConflict() { return this.primaryDocument.conflicted; }
  private set documentConflict(value: boolean) { this.primaryDocument.conflicted = value; }
  private get conflict() { return this.primaryDocument.conflict; }
  private set conflict(value: DocumentConflict | undefined) { this.primaryDocument.conflict = value; }
  private get approvedProposalApplication() { return this.primaryDocument.approvedProposal; }
  private set approvedProposalApplication(value: { conflict: DocumentConflict } | undefined) { this.primaryDocument.approvedProposal = value; }
  private get recoveryArchive() { return this.primaryDocument.recovery; }
  private set recoveryArchive(value: CombinedRecovery | undefined) { this.primaryDocument.recovery = value; }
  private conflictProvider: vscode.Disposable | undefined;
  private readonly conflictChanges = new vscode.EventEmitter<vscode.Uri>();
  private additionalConflictProvider: vscode.Disposable | undefined;
  private readonly additionalConflictTexts = new Map<string, string>();
  private readonly promptedAdditionalConflicts = new WeakSet<SessionConflict>();
  private readonly promptedAdditionalRecoveries = new WeakSet<SessionRecovery>();
  private get conflictSnapshots() { return this.primaryDocument.snapshots; }
  private get awaitingDocumentSync() { return this.primaryDocument.awaitingSync; }
  private set awaitingDocumentSync(value: boolean) { this.primaryDocument.awaitingSync = value; }
  private get documentSession() { return this.primaryDocument.generation; }
  private set documentSession(value: number) { this.primaryDocument.generation = value; }
  private get sharedDocument() { return this.primaryDocument.document; }
  private set sharedDocument(value: vscode.TextDocument | undefined) { this.primaryDocument.document = value; }
  private get applyingRemoteDocumentPath() { return this.primaryDocument.applyingPath; }
  private set applyingRemoteDocumentPath(value: string | undefined) { this.primaryDocument.applyingPath = value; }
  private get applyingRemoteDocumentText() { return this.primaryDocument.applyingText; }
  private set applyingRemoteDocumentText(value: string | undefined) { this.primaryDocument.applyingText = value; }
  private get remoteDocumentQueue() { return this.primaryDocument.remoteQueue; }
  private set remoteDocumentQueue(value: Promise<void>) { this.primaryDocument.remoteQueue = value; }
  private disposed = false;
  private workspaceSession = 0;
  private workspaceSharePending = false;
  private workspaceRefreshing = false;
  private pendingPublication: LocalPublication | undefined;
  private ownedPublication: (LocalPublication & { manifestId: string }) | undefined;
  private readonly filePreviews = new Map<string, PendingFilePreview>();
  private readonly fileReads = new Map<string, FileRequestKey>();
  private previewProvider: vscode.Disposable | undefined;
  private latestPreview: { uri: string; text: string } | undefined;
  private completedPreview: { uri: string; text: string; key: FileRequestKey; session: number } | undefined;
  private fileSession = 0;
  private filePreviewRequest: string | undefined;
  private batchImportRunning = false;
  private importResults: vscode.OutputChannel | undefined;
  private readonly output = vscode.window.createOutputChannel("CodeMesh");
  private readonly changeEmitter = new vscode.EventEmitter<CodeMeshState>();
  private readonly sharedFileSessions = new Map<string, string>();
  private readonly openPresenceShares = new Map<string, string>();
  private readonly remoteCursors = new Map<string, { shareId: string; sequence: number; position: CursorPosition }>();
  private readonly remoteSelections = new Map<string, { shareId: string; sequence: number; ranges: SelectionRange[] }>();
  private readonly remoteTyping = new Map<string, { shareId: string; sequence: number; active: boolean; timer?: NodeJS.Timeout }>();
  private typingIdleTimer: NodeJS.Timeout | undefined;
  private typingInput: vscode.Disposable | undefined;
  private typingProbe: { document: vscode.TextDocument; session: number; version: number; changes: number; ambiguous: boolean } | undefined;
  private localTypingActive = false;
  private lastTypingSentAt = 0;
  private typingSequence = 0;
  private readonly cursorDecorations = new Map<string, vscode.TextEditorDecorationType>();
  private readonly selectionDecorations = new Map<string, vscode.TextEditorDecorationType>();
  private readonly cursorColors = new Map<string, string>();
  private nextCursorColor = 0;
  private selectionListener: vscode.Disposable | undefined;
  private visibleEditorListener: vscode.Disposable | undefined;
  private cursorTimer: NodeJS.Timeout | undefined;
  private selectionTimer: NodeJS.Timeout | undefined;
  private cursorSequence = 0;
  private selectionSequence = 0;
  private localSelectionActive = false;
  private lastSelectionKey = "";
  private selectionLimitWarned = false;
  private localCursorShareId: string | undefined;
  private state: CodeMeshState;

  readonly onDidChangeState = this.changeEmitter.event;

  constructor(private readonly options: CodeMeshClientOptions = {}) {
    this.state = {
      connectionState: "disconnected",
      roomId: undefined,
      members: [],
      sharedFiles: [],
      openSharedFiles: [],
      recentEditFiles: [],
      typingMemberIds: [],
      self: options.self ?? this.getOrCreateMember()
    };
  }

  getState(): CodeMeshState {
    return {
      ...this.state,
      workspaceChanges: this.state.workspaceChanges ? {
        added: [...this.state.workspaceChanges.added], changed: [...this.state.workspaceChanges.changed], removed: [...this.state.workspaceChanges.removed]
      } : undefined,
      workspaceManifest: this.state.workspaceManifest ? {
        ...this.state.workspaceManifest, files: this.state.workspaceManifest.files.map((file) => ({ ...file }))
      } : undefined,
      members: [...this.state.members],
      sharedFiles: this.state.sharedFiles.map((file) => ({ ...file })),
      openSharedFiles: this.state.openSharedFiles.map((file) => ({ ...file })),
      recentEditFiles: this.state.recentEditFiles.map((file) => ({ ...file })),
      typingMemberIds: [...this.state.typingMemberIds]
    };
  }

  async createRoom(): Promise<void> {
    if (this.cloudMode) {
      const key = await vscode.window.showInputBox({ title: "Cloud room host key", prompt: "Operator-provided host key (kept only for this request)", password: true, ignoreFocusOut: true });
      if (!key) return;
      this.leaveRoom();
      this.cloudCredential = undefined; this.invitation = undefined;
      await this.ensureConnected(); this.pendingRoomRequest = "create";
      this.sendCloud({ type: "AUTH_CREATE", key, displayName: this.state.self.displayName });
      return;
    }
    this.stopWorkspaceSharing();
    this.stopAllDocumentCollaboration();
    this.additionalRecoveryArchive.clear();
    this.clearPresence();
    this.cancelRestore();
    await this.ensureConnected();
    this.pendingRoomRequest = "create";
    this.send({ type: "CREATE_ROOM", member: this.state.self });
  }

  async joinRoom(roomId: string): Promise<void> {
    if (roomId.includes("://")) return this.joinInvitation(roomId);
    if (this.cloudMode) throw new Error("Cloud rooms require an invitation link; room codes cannot authorize access");
    const normalizedRoomId = roomId.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(normalizedRoomId)) {
      throw new Error("Enter a valid six-character room ID");
    }

    this.cancelRestore();
    await this.ensureConnected();
    this.stopAllDocumentCollaboration();
    this.additionalRecoveryArchive.clear();
    this.clearPresence();
    this.stopWorkspaceSharing();
    this.pendingRoomRequest = "join";
    this.send({
      type: "JOIN_ROOM",
      roomId: normalizedRoomId,
      member: this.state.self
    });
  }

  leaveRoom(): void {
    this.cloudCredential = undefined; this.invitation = undefined;
    this.stopWorkspaceSharing();
    this.cancelRestore();
    this.pendingRoomRequest = undefined;
    this.stopAllDocumentCollaboration();
    this.additionalRecoveryArchive.clear();
    this.clearPresence();
    if (this.state.roomId && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "LEAVE_ROOM" });
    }

    this.updateState({ roomId: undefined, members: [] });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWorkspaceSharing();
    this.cancelRestore();
    this.pendingRoomRequest = undefined;
    this.stopAllDocumentCollaboration();
    this.additionalRecoveryArchive.clear();
    this.clearPresence();

    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.close(1000, "CodeMesh extension deactivated");
    }

    this.output.dispose();
    this.importResults?.dispose();
    this.previewProvider?.dispose();
    this.conflictProvider?.dispose();
    this.additionalConflictProvider?.dispose();
    this.additionalConflictTexts.clear();
    this.conflictChanges.dispose();
    this.conflictSnapshots.clear();
    this.latestPreview = undefined;
    this.changeEmitter.dispose();
  }

  async collaborateDocument(document: vscode.TextDocument, preserveAdditional = false): Promise<void> {
    if (!preserveAdditional) this.stopAdditionalDocuments();
    if (!this.state.roomId) {
      throw new Error("Create or join a room before sharing a document");
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      throw new Error("Document must be inside the current workspace");
    }

    await this.ensureConnected();
    const documentPath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/");
    if (!this.isValidDocumentPath(documentPath)) {
      throw new Error("Document path must be workspace-relative");
    }
    if (this.sharedDocument === document && this.state.documentStatus !== "paused") return;
    const text = normalizeDocumentText(document.getText());
    const shareSessionId = randomUUID();
    const openMessage: ClientMessage = { type: "OPEN_DOCUMENT", roomId: this.state.roomId!, documentPath, text, shareSessionId };
    this.validateDocumentText(text);
    this.serializeMessage(openMessage);

    this.stopDocumentCollaboration();
    this.sharedDocumentPath = documentPath;
    this.sharedDocumentSessionId = shareSessionId;
    this.sharedDocument = document;
    this.awaitingDocumentSync = true;
    this.updateState({ sharedDocumentPath: documentPath, documentStatus: "opening", documentError: undefined });
    this.sharedDocumentRevision = 0;
    this.documentListener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length === 0) return;
      if (event.document.uri.toString() !== document.uri.toString()) return;
      if (this.typingProbe?.document === event.document) {
        this.typingProbe.changes += 1;
        if (event.reason !== undefined || this.applyingRemoteDocumentPath !== undefined) this.typingProbe.ambiguous = true;
      }
      for (const memberId of [...this.remoteCursors.keys()]) this.removeRemoteCursor(memberId);
      this.hideAllRemoteSelections();
      this.clearPublishedSelection();
      this.queueCursorPosition();
      if (this.applyingRemoteDocumentPath === documentPath
        && normalizeDocumentText(event.document.getText()) === this.applyingRemoteDocumentText) return;
      if (!this.state.roomId || this.sharedDocumentPath !== documentPath) return;

      this.queueDocumentText(normalizeDocumentText(event.document.getText()));
    });
    this.documentCloseListener = vscode.workspace.onDidCloseTextDocument((closed) => {
      if (closed === document && this.sharedDocumentSessionId === shareSessionId) this.stopDocumentCollaboration();
    });
    if (vscode.window.onDidChangeTextEditorSelection) {
      this.selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor.document === this.sharedDocument) {
          this.queueCursorPosition();
          this.queueSelectionRanges();
        }
      });
    }
    if (vscode.window.onDidChangeVisibleTextEditors) {
      this.visibleEditorListener = vscode.window.onDidChangeVisibleTextEditors(() => {
        this.renderRemoteCursors();
        this.renderRemoteSelections();
      });
    }

    this.installTypingInput();

    this.send(openMessage);
    this.sendSharedFile(documentPath);
  }

  /** Explicitly share one editor without disturbing another open session. */
  async shareDocumentForService(document: vscode.TextDocument): Promise<SessionSnapshot> {
    const path = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/");
    const existing = this.getDocumentSessions().find(session => session.path === path);
    if (existing && existing.status !== "paused") return existing;
    if (!this.sharedDocumentPath || this.sharedDocumentPath === path) {
      await this.collaborateDocument(document, true);
      return this.getDocumentSessions().find(session => session.path === path)!;
    }
    return this.shareAdditionalDocument(document);
  }

  /** Add a second explicitly selected file. */
  async shareAdditionalDocument(document: vscode.TextDocument): Promise<SessionSnapshot> {
    if (!this.state.roomId || !this.sharedDocumentPath) throw new Error("Share the first file explicitly before adding a second");
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) throw new Error("Document must be inside the current workspace");
    const documentPath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/");
    if (!this.isValidDocumentPath(documentPath)) throw new Error("Document path must be workspace-relative");
    if (documentPath === this.sharedDocumentPath) throw new Error("This file is already shared");
    const existing = this.additionalDocuments.get(documentPath);
    if (existing && existing.status !== "paused") return existing.snapshot();
    if (existing) this.stopDocumentSession(documentPath);
    if (this.additionalDocuments.size >= 1) throw new Error("At most two files may be shared. End sharing for one named file first.");
    const text = normalizeDocumentText(document.getText());
    this.validateDocumentText(text);
    const shareSessionId = randomUUID();
    const opening: ClientMessage = { type: "OPEN_DOCUMENT", roomId: this.state.roomId, documentPath, text, shareSessionId };
    this.serializeMessage(opening);
    const session = new DocumentSyncSession(this.state.roomId, documentPath, shareSessionId, document, vscode,
      message => this.send(message), () => {
        if (this.additionalDocuments.get(documentPath) === session) this.onAdditionalSessionChanged(documentPath);
      },
      path => { if (this.additionalDocuments.get(path) === session) this.stopDocumentSession(path); },
      this.options.documentAckTimeoutMs ?? 15000);
    const savedRecovery = this.additionalRecoveryArchive.get(`${this.state.roomId}\0${documentPath}`);
    if (savedRecovery) session.restoreRecovery(savedRecovery);
    this.additionalDocuments.set(documentPath, session);
    if (this.presenceSessionId) this.additionalPresence.set(documentPath, new DocumentPresenceSession(session, vscode,
      this.state.self.memberId, () => this.presenceSessionId, message => this.send(message),
      () => this.refreshAdditionalTyping(), id => this.state.members.find(member => member.memberId === id)?.displayName));
    this.installTypingInput();
    try { this.send(opening); }
    catch (error) { this.stopDocumentSession(documentPath); throw error; }
    return session.snapshot();
  }

  getDocumentSessions(): SessionSnapshot[] {
    const primary = this.sharedDocumentPath && this.sharedDocumentSessionId && this.state.roomId && this.state.documentStatus
      ? [{ roomId: this.state.roomId, path: this.sharedDocumentPath, shareSessionId: this.sharedDocumentSessionId,
        status: this.state.documentStatus, revision: this.sharedDocumentRevision, error: this.state.documentError }] : [];
    return [...primary, ...[...this.additionalDocuments.values()].map(session => session.snapshot())];
  }

  stopDocumentSession(path: string): void {
    if (path === this.sharedDocumentPath) { this.stopDocumentCollaboration(); return; }
    const session = this.additionalDocuments.get(path);
    if (!session) return;
    if (session.recovery) this.additionalRecoveryArchive.set(`${session.roomId}\0${path}`, session.recovery);
    this.additionalDocuments.delete(path);
    this.additionalPresence.get(path)?.dispose();
    this.additionalPresence.delete(path);
    session.dispose();
    if (!this.sharedDocumentPath && !this.additionalDocuments.size) { this.typingInput?.dispose(); this.typingInput = undefined; }
    this.changeEmitter.fire(this.getState());
  }

  private onAdditionalSessionChanged(path: string): void {
    const session = this.additionalDocuments.get(path);
    this.additionalPresence.get(path)?.onDocumentChanged();
    this.changeEmitter.fire(this.getState());
    const conflict = session?.conflict;
    const recovery = conflict?.recovery;
    if (session && conflict && recovery && !recovery.reviewed && !this.promptedAdditionalRecoveries.has(recovery)) {
      this.promptedAdditionalRecoveries.add(recovery);
      void this.promptAdditionalRecovery(session, conflict, recovery);
      return;
    }
    if (session && conflict && !this.promptedAdditionalConflicts.has(conflict)) {
      this.promptedAdditionalConflicts.add(conflict);
      void this.promptAdditionalConflict(session, conflict);
    }
  }

  private refreshAdditionalTyping(): void {
    const additional = [...this.additionalPresence].flatMap(([path, presence]) => {
      const session = this.additionalDocuments.get(path);
      return session ? presence.typingMemberIds.flatMap(memberId => {
        const peer = this.state.openSharedFiles.find(file => file.memberId === memberId && file.documentPath === path);
        return peer ? [{ memberId, documentPath: path, shareSessionId: peer.shareSessionId }] : [];
      }) : [];
    });
    const primary = this.sharedDocumentPath ? [...this.remoteTyping].filter(([, activity]) => activity.active).flatMap(([memberId]) => {
      const peer = this.state.openSharedFiles.find(file => file.memberId === memberId && file.documentPath === this.sharedDocumentPath);
      return peer ? [{ memberId, documentPath: peer.documentPath, shareSessionId: peer.shareSessionId }] : [];
    }) : [];
    this.updateState({ recentEditFiles: [...primary, ...additional] });
  }

  private stopAdditionalDocuments(): void {
    for (const path of [...this.additionalDocuments.keys()]) this.stopDocumentSession(path);
  }

  stopAllDocumentCollaboration(): void {
    this.stopAdditionalDocuments();
    this.stopDocumentCollaboration();
  }

  async shareWorkspace(folder: vscode.WorkspaceFolder): Promise<void> {
    if (this.disposed || !this.state.roomId || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Create or join a room before sharing a workspace");
    }
    if (folder.uri.scheme !== "file" || !vscode.workspace.workspaceFolders?.some((candidate) => candidate.uri.toString() === folder.uri.toString())) {
      throw new Error("Select a local folder from the open VS Code workspace");
    }
    const session = ++this.workspaceSession;
    const socket = this.socket;
    const roomId = this.state.roomId;
    const publication = await buildWorkspacePublication(folder.uri.fsPath, folder.name);
    if (this.disposed || session !== this.workspaceSession || socket !== this.socket || roomId !== this.state.roomId
      || !vscode.workspace.workspaceFolders?.some((candidate) => candidate.uri.toString() === folder.uri.toString())) {
      throw new Error("Workspace sharing was cancelled because the room or sharing session changed");
    }
    const publicationId = randomUUID();
    this.pendingPublication = { folder, publication, publicationId };
    try { this.publishWorkspaceManifest(publication.manifest, publicationId); }
    catch (error) { this.pendingPublication = undefined; throw error; }
  }

  async refreshWorkspace(): Promise<void> {
    const owned = this.ownedPublication;
    if (this.disposed || !owned || !this.state.ownsWorkspaceManifest || owned.manifestId !== this.state.workspaceManifestId || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Only the current workspace owner can refresh its publication");
    }
    if (this.workspaceRefreshing || this.workspaceSharePending) throw new Error("A workspace publication is already in progress");
    const session = ++this.workspaceSession;
    const socket = this.socket;
    const roomId = this.state.roomId;
    const active = () => !this.disposed && session === this.workspaceSession && socket === this.socket
      && socket.readyState === WebSocket.OPEN && roomId === this.state.roomId && this.ownedPublication === owned
      && Boolean(vscode.workspace.workspaceFolders?.some((folder) => folder.uri.toString() === owned.folder.uri.toString()));
    this.workspaceRefreshing = true;
    try {
      if (!active()) throw new Error("Selected workspace is no longer open");
      const publication = await buildWorkspacePublication(owned.folder.uri.fsPath, owned.folder.name, active);
      if (!active()) throw new Error("Workspace refresh cancelled");
      if (publication.root !== owned.publication.root) throw new Error("Selected workspace changed location; end sharing and re-share it explicitly");
      const changedPaths = [...publication.files].filter(([path, file]) => {
        const previous = owned.publication.files.get(path)?.stat;
        const now = file.stat;
        return previous && (previous.dev !== now.dev || previous.ino !== now.ino || previous.size !== now.size
          || previous.mtimeNs !== now.mtimeNs || previous.ctimeNs !== now.ctimeNs);
      }).map(([path]) => path);
      const publicationId = randomUUID();
      this.pendingPublication = { folder: owned.folder, publication, publicationId };
      try { this.publishWorkspaceManifest(publication.manifest, publicationId, { baseManifestId: owned.manifestId, changedPaths }); }
      catch (error) { this.pendingPublication = undefined; throw error; }
    } finally { this.workspaceRefreshing = false; }
  }

  private publishWorkspaceManifest(value: unknown, publicationId?: string, refresh?: { baseManifestId: string; changedPaths: string[] }): void {
    const manifest = validateWorkspaceManifest(value);
    const message: ClientMessage = { type: "SHARE_WORKSPACE", roomId: this.state.roomId!, manifest, publicationId, ...refresh };
    if (Buffer.byteLength(this.serializeMessage(message), "utf8") > MAX_MANIFEST_BYTES) throw new Error("Workspace manifest exceeds the 256 KiB message limit");
    this.workspaceSharePending = true;
    this.send(message);
  }

  stopWorkspaceSharing(): void {
    this.cancelFilePreviews("File request cancelled because sharing or room membership ended");
    this.fileReads.clear();
    this.pendingPublication = undefined;
    this.ownedPublication = undefined;
    this.workspaceSession += 1;
    if ((this.state.ownsWorkspaceManifest || this.workspaceSharePending) && this.state.roomId && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "END_WORKSPACE", roomId: this.state.roomId });
    }
    this.workspaceSharePending = false;
    this.state = { ...this.state, workspaceManifest: undefined, ownsWorkspaceManifest: false, workspaceManifestId: undefined, workspaceChanges: undefined };
    this.updateState({});
  }

  async requestFile(requestedPath: string): Promise<vscode.Uri> {
    if (this.batchImportRunning) throw new Error("A workspace import is already running");
    return this.requestWorkspaceText(requestedPath, true) as Promise<vscode.Uri>;
  }

  private async requestWorkspaceText(requestedPath: string, preview: boolean): Promise<vscode.Uri | string> {
    if (this.disposed || !this.state.roomId || !this.state.workspaceManifestId || !this.state.workspaceManifest) throw new Error("No workspace manifest is shared in this room");
    if (this.filePreviews.size || this.filePreviewRequest) throw new Error("Only one file request may be pending");
    const path = normalizeManifestPath(requestedPath);
    const file = this.state.workspaceManifest.files.find((entry) => entry.path === path);
    if (!file) throw new Error("File is not listed in the current workspace manifest");
    if (file.size > MAX_FILE_BYTES) throw new Error("File exceeds the 256 KiB UTF-8 text limit");
    const key = { requestId: randomUUID(), roomId: this.state.roomId, manifestId: this.state.workspaceManifestId, path };
    this.filePreviewRequest = key.requestId;
    try { return await this.previewRequestedFile(key, preview); }
    finally { if (this.filePreviewRequest === key.requestId) this.filePreviewRequest = undefined; }
  }

  private async previewRequestedFile(key: FileRequestKey, preview = true): Promise<vscode.Uri | string> {
    const session = this.fileSession;
    const socket = this.socket;
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.filePreviews.delete(key.requestId);
        if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "FILE_CANCEL", ...key });
        reject(new Error("File request timed out; try again"));
      }, this.options.fileRequestTimeoutMs ?? FILE_CLIENT_TIMEOUT_MS);
      this.filePreviews.set(key.requestId, { key, resolve, reject, timer });
      try { this.send({ type: "FILE_REQUEST", ...key }); }
      catch (error) { clearTimeout(timer); this.filePreviews.delete(key.requestId); reject(error); }
    });
    const stillCurrent = () => !this.disposed && this.fileSession === session && this.socket === socket && this.state.roomId === key.roomId && this.state.workspaceManifestId === key.manifestId;
    if (!stillCurrent()) throw new Error("File preview cancelled because the room or manifest changed");
    if (!preview) return text;
    this.previewProvider ??= vscode.workspace.registerTextDocumentContentProvider("codemesh-preview", {
      provideTextDocumentContent: (uri) => this.latestPreview?.uri === uri.toString() ? this.latestPreview.text : "Preview is no longer available"
    });
    const uri = vscode.Uri.from({ scheme: "codemesh-preview", path: "/" + key.roomId + "/" + key.path, query: key.requestId });
    this.latestPreview = { uri: uri.toString(), text };
    const document = await vscode.workspace.openTextDocument(uri);
    if (!stillCurrent()) throw new Error("File preview cancelled because the room or manifest changed");
    await vscode.window.showTextDocument(document, { preview: true });
    if (!stillCurrent()) throw new Error("File preview cancelled because the room or manifest changed");
    this.completedPreview = { uri: uri.toString(), text, key, session };
    this.updateState({});
    return uri;
  }

  canImportPreview(uri = vscode.window.activeTextEditor?.document.uri): boolean {
    const preview = this.completedPreview;
    return Boolean(uri && preview && uri.toString() === preview.uri && !this.disposed
      && preview.session === this.fileSession && this.socket?.readyState === WebSocket.OPEN
      && this.state.roomId === preview.key.roomId && this.state.workspaceManifestId === preview.key.manifestId
      && this.state.workspaceManifest?.files.some((file) => file.path === preview.key.path));
  }

  async importFile(uri = vscode.window.activeTextEditor?.document.uri): Promise<string | undefined> {
    if (this.batchImportRunning) throw new Error("A workspace import is already running");
    if (!this.canImportPreview(uri)) throw new Error("Open a successfully received, current workspace preview before importing");
    const preview = this.completedPreview!;
    const folders = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === "file");
    if (!folders?.length) throw new Error("Open a local workspace folder before importing");
    const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { title: "Import Workspace File", placeHolder: "Select the destination workspace" }
    ))?.folder;
    if (!folder) return undefined;
    const relativePath = await vscode.window.showInputBox({
      title: "Import Workspace File", prompt: "Destination path relative to " + folder.uri.fsPath, value: preview.key.path,
      validateInput: (value) => { try { normalizeManifestPath(value); return undefined; } catch (error) { return String((error as Error).message); } }
    });
    if (relativePath === undefined) return undefined;
    return importPreviewText(folder.uri.fsPath, relativePath, preview.text, {
      isActive: () => this.completedPreview === preview && this.canImportPreview(uri)
        && Boolean(vscode.workspace.workspaceFolders?.some((candidate) => candidate.uri.toString() === folder.uri.toString())),
      isDirty: (destination) => vscode.workspace.textDocuments.some((document) => document.uri.scheme === "file" && document.isDirty
        && (process.platform === "win32" ? document.uri.fsPath.toLowerCase() === destination.toLowerCase() : document.uri.fsPath === destination)),
      confirm: async (destination, exists) => {
        const action = exists ? "Overwrite" : "Import";
        return await vscode.window.showWarningMessage(
          (exists ? "Overwrite this file?" : "Import this file?") + "\n" + destination,
          { modal: true }, action
        ) === action;
      }
    });
  }

  async importWorkspace(): Promise<ImportResult[] | undefined> {
    if (this.batchImportRunning || this.filePreviewRequest) throw new Error("A file request or import is already running");
    const manifest = this.state.workspaceManifest;
    const manifestId = this.state.workspaceManifestId;
    const roomId = this.state.roomId;
    const session = this.fileSession;
    if (!manifest || !manifestId || !roomId || this.state.ownsWorkspaceManifest) throw new Error("Select a workspace explicitly shared by another room member");
    this.batchImportRunning = true;
    try {
      const selected = await vscode.window.showQuickPick(manifest.files.map(file => ({ label: file.path, description: file.size + " bytes", file })),
        { title: "Import Workspace Files", canPickMany: true, placeHolder: "Select up to 50 files / 10 MiB; each at most 256 KiB" });
      if (!selected?.length) return;
      const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === "file");
      if (!folders?.length) throw new Error("Open a local workspace folder before importing");
      const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
        folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
        { title: "Import Workspace Files", placeHolder: "Select destination workspace" }))?.folder;
      if (!folder) return;
      const isActive = () => !this.disposed && this.fileSession === session && this.state.roomId === roomId
        && this.state.workspaceManifestId === manifestId && this.socket?.readyState === WebSocket.OPEN
        && Boolean(vscode.workspace.workspaceFolders?.some(candidate => candidate.uri.toString() === folder.uri.toString()));
      const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "CodeMesh workspace import", cancellable: true }, async (progress, token) => {
        const cancellation = token.onCancellationRequested(() => this.cancelFilePreviews("Workspace import cancelled"));
        let completed = 0;
        try {
          return await importWorkspaceFiles(folder.uri.fsPath, selected.map(item => item.file), {
            isActive, isCancelled: () => token.isCancellationRequested,
            isDirty: destination => vscode.workspace.textDocuments.some(document => document.uri.scheme === "file" && document.isDirty
              && (process.platform === "win32" ? document.uri.fsPath.toLowerCase() === destination.toLowerCase() : document.uri.fsPath === destination)),
            review: async (files, bytes) => await vscode.window.showWarningMessage(
              "Import " + files.length + " files (" + bytes + " bytes) into " + folder.uri.fsPath + "?\n"
              + files.map(file => file.path + " (" + file.size + " bytes)").join("\n")
              + "\nCreates a local project copy. Live edits require Share Current File on each PC. Existing files require separate overwrite approval.",
              { modal: true }, "Confirm Import") === "Confirm Import",
            request: async path => {
              if (!isActive() || token.isCancellationRequested) throw new Error("Import cancelled or manifest changed");
              return await this.requestWorkspaceText(path, false) as string;
            },
            confirm: async (destination, exists) => !exists || await vscode.window.showWarningMessage(
              "Overwrite this file?\n" + destination, { modal: true }, "Overwrite") === "Overwrite",
            progress: (count, total, path) => { progress.report({ message: path, increment: (count - completed) * 100 / total }); completed = count; }
          });
        } finally { cancellation.dispose(); }
      });
      // Keep every outcome visible, including successful writes before cancellation.
      const report = this.importResults ??= vscode.window.createOutputChannel("CodeMesh Import Results");
      report.appendLine("Local project copy: " + folder.uri.fsPath);
      for (const result of results) report.appendLine(result.status + " | " + result.path + " | " + result.detail);
      report.show(true);
      const count = (status: ImportResult["status"]) => results.filter(result => result.status === status).length;
      void vscode.window.showInformationMessage(`CodeMesh import: ${count("imported")} imported, ${count("declined")} declined, ${count("failed")} failed, ${count("cancelled")} cancelled. See CodeMesh Import Results.`);
      return results;
    } finally { this.batchImportRunning = false; }
  }

  private cancelFilePreviews(reason: string): void {
    this.fileSession += 1;
    this.completedPreview = undefined;
    this.filePreviewRequest = undefined;
    for (const pending of this.filePreviews.values()) {
      clearTimeout(pending.timer);
      if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "FILE_CANCEL", ...pending.key });
      pending.reject(new Error(reason));
    }
    this.filePreviews.clear();
  }

  private async serveFileRequest(key: FileRequestKey): Promise<void> {
    const owned = this.ownedPublication;
    if (!owned || !this.state.ownsWorkspaceManifest || owned.manifestId !== key.manifestId
      || this.state.roomId !== key.roomId || this.fileReads.has(key.requestId) || this.fileReads.size >= MAX_ROOM_FILE_REQUESTS) {
      if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "FILE_FAILURE", ...key, message: "Unauthorized file request: no matching local workspace publication" });
      return;
    }
    this.fileReads.set(key.requestId, key);
    const active = () => this.fileReads.get(key.requestId) === key && this.ownedPublication === owned
      && this.state.roomId === key.roomId && this.state.workspaceManifestId === key.manifestId && this.socket?.readyState === WebSocket.OPEN;
    try {
      if (!vscode.workspace.workspaceFolders?.some((folder) => folder.uri.toString() === owned.folder.uri.toString())) throw new Error("Selected workspace is no longer open");
      const text = await readPublishedText(owned.publication, key.path, owned.folder.uri.fsPath, active);
      if (active()) this.send({ type: "FILE_RESPONSE", ...key, text });
    } catch (error) {
      if (active()) this.send({ type: "FILE_FAILURE", ...key, message: error instanceof Error ? error.message : "Cannot read shared file" });
    } finally {
      if (this.fileReads.get(key.requestId) === key) this.fileReads.delete(key.requestId);
    }
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("CodeMesh client has been disposed"));
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (this.activeServer !== this.configuredServer) return Promise.reject(new Error("Server setting changed; leave the room and reload VS Code"));
      return Promise.resolve();
    }
    return this.connectionPromise ?? this.connect(false);
  }

  private connect(isReconnect: boolean): Promise<void> {
    const configuredUrl = this.configuredServer;
    let serverUrl: string;
    try {
      serverUrl = validateServerUrl(configuredUrl);
      if (this.cloudMode && !serverUrl.startsWith("wss://")) throw new Error("Cloud collaboration requires wss://");
      this.activeServer = serverUrl;
    }
    catch (error) { return Promise.reject(error); }

    this.updateState({
      connectionState: isReconnect ? "reconnecting" : "connecting",
      roomId: undefined,
      members: [],
      sharedFiles: []
    });
    this.output.appendLine(`[client] ${isReconnect ? "reconnecting" : "connecting"} to ${serverUrl}`);

    const attempt = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(serverUrl, { maxPayload: MAX_MESSAGE_BYTES, handshakeTimeout: this.options.connectionTimeoutMs ?? 10000 });
      let opened = false;
      let settled = false;
      this.socket = socket;

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      socket.on("open", () => {
        if (this.disposed || this.socket !== socket) {
          socket.close();
          return;
        }

        opened = true;
        this.output.appendLine("[client] connected");
        if (isReconnect && this.restoreRoomId) {
          this.pendingRoomRequest = "restore";
          if (this.cloudMode) this.sendCloud({ type: "AUTH_RESUME", credential: this.cloudCredential });
          else this.send({
            type: "JOIN_ROOM",
            roomId: this.restoreRoomId,
            member: this.state.self
          });
        } else {
          this.updateState({ connectionState: "connected" });
        }
        resolveOnce();
      });

      socket.on("message", (data) => {
        if (this.socket === socket) this.handleServerMessage(data.toString());
      });

      socket.on("close", (code) => {
        if (this.socket !== socket || this.disposed) return;

        this.output.appendLine("[client] disconnected");
        this.socket = undefined;
        this.stopWorkspaceSharing();
        const wasSharing = Boolean(this.sharedDocumentPath);
        this.stopAllDocumentCollaboration();
        this.clearPresence();
        if (wasSharing) {
          vscode.window.showWarningMessage(code === 1009
            ? `CodeMesh stopped sharing: ${MESSAGE_SIZE_ERROR}. Your local draft is unchanged.`
            : "CodeMesh stopped sharing after disconnect. Re-share the file after the room reconnects; your local text is unchanged.");
        }
        if (code === 1008 && this.cloudMode) { this.cancelRestore(); this.cloudCredential = undefined; }
        const roomToRestore = code === 1008 && this.cloudMode ? undefined : this.state.roomId ?? this.restoreRoomId;
        this.restoreRoomId = roomToRestore;
        this.pendingRoomRequest = undefined;
        this.updateState({
          connectionState: roomToRestore ? "reconnecting" : "disconnected",
          roomId: undefined,
          members: [],
          sharedFiles: []
        });

        if (roomToRestore) this.scheduleReconnect();
        rejectOnce(new Error(opened
          ? "CodeMesh connection closed"
          : "CodeMesh connection closed before it was ready"));
      });

      socket.on("error", (error) => {
        const reason = (error as NodeJS.ErrnoException).code ?? "connection failed";
        this.output.appendLine(`[client] error: ${reason}`);
        rejectOnce(new Error(`Cannot connect to CodeMesh at ${serverUrl}. Check the server, codemesh.serverUrl, and LAN/firewall settings (${reason}).`));
      });
    });

    this.connectionPromise = attempt;
    const clearAttempt = () => {
      if (this.connectionPromise === attempt) this.connectionPromise = undefined;
    };
    void attempt.then(clearAttempt, clearAttempt);
    return attempt;
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.restoreRoomId || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed || !this.restoreRoomId) return;
      if (this.socket) {
        this.scheduleReconnect();
        return;
      }

      void this.connect(true).catch(() => {
        this.scheduleReconnect();
      });
    }, this.options.reconnectDelayMs ?? 750);
  }

  private cancelRestore(): void {
    this.restoreRoomId = undefined;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private handleServerMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch (error) {
      const description = error instanceof Error ? error.message : "Unknown parse error";
      this.output.appendLine(`[client] malformed server message: ${description}`);
      return;
    }

    const cloudMessage = message as unknown as { type: string; credential?: string; token?: string; expires?: number };
    if (cloudMessage.type === "AUTH_SESSION") {
      if (this.cloudMode && typeof cloudMessage.credential === "string" && /^[A-Za-z0-9_-]{43}$/.test(cloudMessage.credential)) this.cloudCredential = cloudMessage.credential;
      return;
    }
    if (cloudMessage.type === "INVITATION") {
      if (!this.cloudMode || typeof cloudMessage.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(cloudMessage.token) || typeof cloudMessage.expires !== "number") return;
      this.invitation = { token: cloudMessage.token, expires: cloudMessage.expires };
      const base = vscode.workspace.getConfiguration("codemesh").get<string>("invitationUrlBase", "vscode://codemesh.codemesh/join");
      try {
        const link = createInviteLink(base, this.activeServer!, cloudMessage.token);
        void vscode.env.clipboard.writeText(link).then(() => { vscode.window.showInformationMessage("CodeMesh invitation copied. Single use; expires in five minutes. Creating another invitation revokes this link."); }, () => { vscode.window.showErrorMessage("CodeMesh could not copy the invitation. Try Copy Invite Link again."); });
      } catch { vscode.window.showErrorMessage("CodeMesh: invalid invitation URL base"); }
      return;
    }

    if (message.type === "DOCUMENT_SYNC" || message.type === "DOCUMENT_EDIT"
      || message.type === "DOCUMENT_ACK" || message.type === "DOCUMENT_CONFLICT") {
      const additional = this.additionalDocuments.get(message.documentPath);
      if (additional && message.roomId === additional.roomId) {
        additional.handle(message);
        return;
      }
      if (this.sharedDocumentPath === message.documentPath && this.state.roomId === message.roomId
        && message.shareSessionId !== undefined && message.shareSessionId !== this.sharedDocumentSessionId) return;
    }

    switch (message.type) {
      case "ROOM_CREATED":
      case "ROOM_JOINED":
        this.cancelRestore();
        this.pendingRoomRequest = undefined;
        this.presenceSessionId = typeof message.presenceSessionId === "string" && /^[0-9a-f-]{36}$/i.test(message.presenceSessionId)
          ? message.presenceSessionId : undefined;
        this.presenceSequence = 0;
        this.presenceRevision = -1;
        this.updateState({
          connectionState: "connected",
          roomId: message.roomId,
          self: this.cloudMode ? message.member : this.state.self,
          members: this.uniqueMembers(message.members),
          sharedFiles: []
        });
        vscode.window.showInformationMessage(`CodeMesh room: ${message.roomId}`);
        break;
      case "MEMBERS_UPDATED":
        if (this.state.connectionState === "connected" && this.state.roomId === message.roomId) {
          const members = this.uniqueMembers(message.members);
          this.updateState({ members, sharedFiles: this.state.sharedFiles.filter((file) => members.some((member) => member.memberId === file.memberId)) });
          for (const memberId of new Set([...this.sharedFileSessions.keys(), ...this.remoteCursors.keys(),
            ...this.remoteSelections.keys(), ...this.remoteTyping.keys()])) {
            if (!members.some((member) => member.memberId === memberId)) {
              this.removeRemoteCursor(memberId);
              this.removeRemoteSelection(memberId);
              this.removeRemoteTyping(memberId);
              this.cursorColors.delete(memberId);
            }
          }
          this.renderRemoteCursors();
        }
        break;
      case "SHARED_FILES":
        if (this.state.connectionState !== "connected" || this.state.roomId !== message.roomId
          || this.presenceSessionId !== message.presenceSessionId || !Number.isSafeInteger(message.revision)
          || message.revision <= this.presenceRevision || !Array.isArray(message.files)
          || message.files.length > this.state.members.length) break;
        try {
          const seen = new Set<string>();
          const sessions = new Map<string, string>();
          const previousSessions = new Map(this.sharedFileSessions);
          const files = message.files.filter((file) => {
            if (!file || typeof file.memberId !== "string" || typeof file.documentPath !== "string"
              || typeof file.shareId !== "string" || !/^[0-9a-f-]{36}$/i.test(file.shareId)
              || !this.isValidDocumentPath(file.documentPath) || seen.has(file.memberId)
              || !this.state.members.some((member) => member.memberId === file.memberId)) throw new Error("Invalid shared-file presence");
            seen.add(file.memberId);
            const included = file.memberId !== this.state.self.memberId || file.documentPath === this.sharedDocumentPath;
            if (included) sessions.set(file.memberId, file.shareId);
            return included;
          });
          const openShares = message.openShares ?? [];
          if (!Array.isArray(openShares) || openShares.length > this.state.members.length * 2
            || openShares.some(entry => !entry || typeof entry.memberId !== "string"
              || typeof entry.documentPath !== "string" || !this.isValidDocumentPath(entry.documentPath)
              || typeof entry.shareSessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(entry.shareSessionId)
              || typeof entry.shareId !== "string" || !/^[0-9a-f-]{36}$/i.test(entry.shareId)
              || !this.state.members.some(member => member.memberId === entry.memberId))) throw new Error("Invalid open-share presence");
          const validPrimaryPeer = (memberId: string, shareId: string) =>
            files.some(file => file.memberId === memberId && file.documentPath === this.sharedDocumentPath && file.shareId === shareId)
            || openShares.some(file => file.memberId === memberId && file.documentPath === this.sharedDocumentPath && file.shareId === shareId);
          this.presenceRevision = message.revision;
          for (const [memberId, cursor] of this.remoteCursors) {
            if (!validPrimaryPeer(memberId, cursor.shareId)) {
              this.removeRemoteCursor(memberId);
            }
          }
          for (const [memberId, selection] of this.remoteSelections) {
            if (!validPrimaryPeer(memberId, selection.shareId)) {
              this.removeRemoteSelection(memberId);
            }
          }
          for (const [memberId, typing] of this.remoteTyping) {
            if (!validPrimaryPeer(memberId, typing.shareId)) {
              this.removeRemoteTyping(memberId);
            }
          }
          this.sharedFileSessions.clear();
          for (const [memberId, shareId] of sessions) this.sharedFileSessions.set(memberId, shareId);
          this.openPresenceShares.clear();
          for (const file of openShares) this.openPresenceShares.set(`${file.memberId}\0${file.documentPath}`, file.shareId);
          this.updateState({ sharedFiles: files,
            openSharedFiles: openShares.map(({ memberId, documentPath, shareSessionId }) => ({ memberId, documentPath, shareSessionId })) });
          for (const session of this.additionalDocuments.values()) {
            session.setPresence(Boolean(message.openDocuments?.some((entry) => entry.memberId === this.state.self.memberId
              && entry.documentPath === session.path && entry.shareSessionId === session.shareSessionId)));
            this.additionalPresence.get(session.path)?.setShares(openShares, message.files);
          }
          this.renderRemoteCursors();
          this.renderRemoteSelections();
          const selfShare = files.some((file) => file.memberId === this.state.self.memberId)
            ? sessions.get(this.state.self.memberId) : undefined;
          if (selfShare !== this.localCursorShareId) {
            this.localCursorShareId = selfShare;
            this.cursorSequence = 0;
            this.selectionSequence = 0;
            this.stopLocalTyping(false);
            this.typingSequence = 0;
            this.localSelectionActive = false;
            this.lastSelectionKey = "";
            if (selfShare) {
              this.queueCursorPosition();
              this.queueSelectionRanges();
            }
          } else if (selfShare && files.some((file) => file.memberId !== this.state.self.memberId
            && file.documentPath === this.sharedDocumentPath && previousSessions.get(file.memberId) !== file.shareId)) {
            this.lastSelectionKey = "";
            this.queueSelectionRanges();
          }
        } catch (error) { this.output.appendLine("[presence] ignored invalid room snapshot: " + String(error)); }
        break;
      case "CURSOR_UPDATE":
        this.additionalPresence.get(message.documentPath)?.receive(message);
        if (this.state.connectionState !== "connected" || this.state.roomId !== message.roomId
          || (message.recipientShareSessionId !== undefined && message.recipientShareSessionId !== this.sharedDocumentSessionId)
          || this.presenceSessionId !== message.presenceSessionId || !this.sharedDocument
          || this.sharedDocumentPath !== message.documentPath || message.memberId === this.state.self.memberId
          || !this.sharedFileSessions.has(this.state.self.memberId)
          || !this.matchesPrimaryPeerShare(message.memberId, message.documentPath, message.shareId)
          || !Number.isSafeInteger(message.sequence) || message.sequence < 1
          || !this.isValidCursorPosition(message.position)) break;
        if (message.sequence <= (this.remoteCursors.get(message.memberId)?.sequence ?? 0)) break;
        this.remoteCursors.set(message.memberId, { shareId: message.shareId, sequence: message.sequence, position: message.position });
        this.renderRemoteCursors();
        break;
      case "SELECTION_UPDATE":
        this.additionalPresence.get(message.documentPath)?.receive(message);
        if (this.state.connectionState !== "connected" || this.state.roomId !== message.roomId
          || (message.recipientShareSessionId !== undefined && message.recipientShareSessionId !== this.sharedDocumentSessionId)
          || this.presenceSessionId !== message.presenceSessionId || !this.sharedDocument
          || this.sharedDocumentPath !== message.documentPath || message.memberId === this.state.self.memberId
          || !this.sharedFileSessions.has(this.state.self.memberId)
          || !this.matchesPrimaryPeerShare(message.memberId, message.documentPath, message.shareId)
          || !Number.isSafeInteger(message.sequence) || message.sequence < 1
          || !Number.isSafeInteger(message.documentRevision) || message.documentRevision < 0
          || !this.isValidSelectionRanges(message.ranges)) break;
        if (message.sequence <= (this.remoteSelections.get(message.memberId)?.sequence ?? 0)) break;
        if (message.ranges.length && (message.documentRevision !== this.sharedDocumentRevision
          || this.state.documentStatus !== "shared" || this.awaitingDocumentSync || this.documentEditInFlight
          || this.pendingDocumentText !== undefined || this.applyingRemoteDocumentPath !== undefined)) break;
        this.remoteSelections.set(message.memberId, { shareId: message.shareId, sequence: message.sequence, ranges: message.ranges });
        if (message.ranges.length === 0) this.disposeSelectionDecoration(message.memberId);
        else this.renderRemoteSelections();
        break;
      case "TYPING_ACTIVITY":
        this.additionalPresence.get(message.documentPath)?.receive(message);
        if (this.state.connectionState !== "connected" || this.state.roomId !== message.roomId
          || (message.recipientShareSessionId !== undefined && message.recipientShareSessionId !== this.sharedDocumentSessionId)
          || this.presenceSessionId !== message.presenceSessionId || !this.sharedDocument
          || this.sharedDocumentPath !== message.documentPath || message.memberId === this.state.self.memberId
          || !this.sharedFileSessions.has(this.state.self.memberId)
          || !this.matchesPrimaryPeerShare(message.memberId, message.documentPath, message.shareId)
          || !Number.isSafeInteger(message.sequence) || message.sequence < 1
          || typeof message.active !== "boolean" || !Number.isSafeInteger(message.leaseMs)
          || message.leaseMs < 0 || message.leaseMs > TYPING_LEASE_MS
          || (message.active && message.leaseMs === 0) || (!message.active && message.leaseMs !== 0)) break;
        if (message.sequence <= (this.remoteTyping.get(message.memberId)?.sequence ?? 0)) break;
        this.removeRemoteTyping(message.memberId);
        const typing = { shareId: message.shareId, sequence: message.sequence, active: message.active,
          timer: undefined as NodeJS.Timeout | undefined };
        this.remoteTyping.set(message.memberId, typing);
        if (message.active) {
          typing.timer = setTimeout(() => {
            if (this.remoteTyping.get(message.memberId) === typing) {
              typing.active = false;
              typing.timer = undefined;
              this.refreshTypingState();
            }
          }, message.leaseMs);
          typing.timer.unref();
        }
        this.refreshTypingState();
        break;
      case "TYPING_REJECTED":
        this.output.appendLine("[presence] " + message.message);
        break;
      case "DOCUMENT_SYNC":
        if (this.state.roomId === message.roomId && this.sharedDocumentPath === message.documentPath) {
          void this.handleDocumentSync(message.documentPath, message.text, message.revision);
        }
        break;
      case "WORKSPACE_MANIFEST":
        if (this.state.roomId === message.roomId) {
          try {
            if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) throw new Error("Workspace manifest exceeds the 256 KiB message limit");
            if (typeof message.ownedByYou !== "boolean") throw new Error("Workspace manifest ownership must be boolean");
            const manifest = message.manifest === null ? undefined : validateWorkspaceManifest(message.manifest);
            if (manifest && (typeof message.manifestId !== "string" || !/^[0-9a-f-]{36}$/i.test(message.manifestId))) throw new Error("Workspace manifest identity is invalid");
            if (message.manifestId !== this.state.workspaceManifestId) {
              this.cancelFilePreviews("File request cancelled because the workspace manifest changed");
              this.fileReads.clear();
              this.ownedPublication = undefined;
              this.state = { ...this.state, workspaceChanges: undefined };
            }
            if (manifest && message.ownedByYou && this.pendingPublication && this.pendingPublication.publicationId === message.publicationId) {
              this.ownedPublication = { ...this.pendingPublication, manifestId: message.manifestId! };
              this.pendingPublication = undefined;
            }
            this.workspaceSharePending = false;
            this.updateState({ workspaceManifest: manifest, ownsWorkspaceManifest: manifest ? message.ownedByYou : false, workspaceManifestId: manifest ? message.manifestId! : undefined });
          } catch (error) {
            vscode.window.showErrorMessage(`CodeMesh ignored an invalid workspace manifest: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        break;
      case "WORKSPACE_CHANGES":
        if (this.state.roomId === message.roomId && this.state.workspaceManifestId === message.manifestId) {
          try {
            if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) throw new Error(MESSAGE_SIZE_ERROR);
            const changes = validateWorkspaceChanges(message.changes);
            this.updateState({ workspaceChanges: changes });
            vscode.window.showInformationMessage("CodeMesh workspace refreshed: " + changes.added.length + " added, " + changes.changed.length + " changed, " + changes.removed.length + " removed");
          } catch (error) { this.output.appendLine("[workspace] ignored invalid change summary: " + String(error)); }
        }
        break;
      case "WORKSPACE_ERROR":
        this.workspaceSharePending = false;
        this.pendingPublication = undefined;
        vscode.window.showErrorMessage(`CodeMesh workspace: ${message.message}`);
        break;
      case "FILE_REQUEST": {
        try {
          const key = parseFileRequestKey(message as unknown as Record<string, unknown>);
          void this.serveFileRequest(key);
        } catch (error) { this.output.appendLine("[files] ignored invalid owner request: " + String(error)); }
        break;
      }
      case "FILE_CANCEL": {
        const key = this.fileReads.get(message.requestId);
        if (key && sameFileRequest(key, message)) this.fileReads.delete(message.requestId);
        break;
      }
      case "FILE_ERROR": {
        const pending = this.filePreviews.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.filePreviews.delete(message.requestId);
          pending.reject(new Error(message.message));
        }
        break;
      }
      case "FILE_RESPONSE": {
        const pending = this.filePreviews.get(message.requestId);
        if (!pending) break;
        try {
          const key = parseFileRequestKey(message as unknown as Record<string, unknown>);
          if (!sameFileRequest(pending.key, key) || this.state.workspaceManifestId !== key.manifestId || this.state.roomId !== key.roomId) throw new Error("Unsolicited or mismatched file response");
          const text = validateFileText(message.text);
          const file = this.state.workspaceManifest?.files.find((entry) => entry.path === key.path);
          if (!file || Buffer.byteLength(text, "utf8") !== file.size) throw new Error("File response differs from the published size");
          clearTimeout(pending.timer);
          this.filePreviews.delete(key.requestId);
          pending.resolve(text);
        } catch (error) {
          clearTimeout(pending.timer);
          this.filePreviews.delete(pending.key.requestId);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
          if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "FILE_CANCEL", ...pending.key });
        }
        break;
      }
      case "DOCUMENT_EDIT":
        if (this.state.roomId === message.roomId && this.sharedDocumentPath === message.documentPath) {
          if (this.state.documentStatus === "paused") break;
          if (this.awaitingDocumentSync) break;
          this.receivedDocumentRevision = Math.max(this.receivedDocumentRevision, message.revision);
          this.output.appendLine(`[sync] received DOCUMENT_EDIT room=${message.roomId} path=${message.documentPath} session=${this.documentSession} presenceSession=${this.presenceSessionId ?? "none"} revision=${message.revision} inFlight=${this.documentEditInFlight} pending=${this.pendingDocumentText !== undefined}`);
          this.queueRemoteDocumentText(message.documentPath, message.text, message.revision);
        }
        break;
      case "DOCUMENT_ACK":
        if (this.state.roomId === message.roomId && this.sharedDocumentPath === message.documentPath
          && this.state.documentStatus === "shared" && !this.awaitingDocumentSync) {
          this.output.appendLine(`[sync] received DOCUMENT_ACK room=${message.roomId} path=${message.documentPath} session=${this.documentSession} presenceSession=${this.presenceSessionId ?? "none"} revision=${message.revision} inFlight=${this.documentEditInFlight} pending=${this.pendingDocumentText !== undefined}`);
          if (!this.sentDocument || !this.documentEditInFlight || message.revision !== this.sentDocument.baseRevision + 1) break;
          this.confirmedDocument = { text: this.sentDocument.text, revision: message.revision };
          this.sentDocument = undefined;
          this.receivedDocumentRevision = Math.max(this.receivedDocumentRevision, message.revision);
          if (this.documentAckTimer) clearTimeout(this.documentAckTimer);
          this.documentAckTimer = undefined;
          this.sharedDocumentRevision = message.revision;
          this.documentEditInFlight = false;
          this.flushPendingDocumentText();
          this.queueSelectionRanges();
        }
        break;
      case "DOCUMENT_CONFLICT":
        if (this.state.roomId === message.roomId && this.sharedDocumentPath === message.documentPath
          && this.state.documentStatus !== "paused") {
          if (this.documentAckTimer) clearTimeout(this.documentAckTimer);
          this.documentAckTimer = undefined;
          this.receivedDocumentRevision = Math.max(this.receivedDocumentRevision, message.revision);
          this.handleDocumentConflict(message.text, message.revision);
        }
        break;
      case "ERROR": {
        if (message.documentPath) {
          if (message.roomId !== this.state.roomId) break;
          const additional = this.additionalDocuments.get(message.documentPath);
          if (additional && message.shareSessionId === additional.shareSessionId) additional.fail(message.message);
          else if (message.documentPath === this.sharedDocumentPath
            && (message.shareSessionId === undefined || message.shareSessionId === this.sharedDocumentSessionId)) {
            this.rejectDocumentEdit(message.message);
          }
          this.output.appendLine(`[server] ${message.message}`);
          break;
        }
        const wasRestore = this.pendingRoomRequest === "restore";
        if (wasRestore && this.cloudMode) this.cloudCredential = undefined;
        this.pendingRoomRequest = undefined;
        if (wasRestore) {
          const failedRoomId = this.restoreRoomId;
          this.cancelRestore();
          this.updateState({
            connectionState: "connected",
            roomId: undefined,
            members: []
          });
          vscode.window.showWarningMessage(
            `CodeMesh could not restore room ${failedRoomId ?? ""}. Create or join a room again.`
          );
        } else {
          if (this.sharedDocumentPath) this.rejectDocumentEdit(message.message);
          else vscode.window.showErrorMessage(`CodeMesh: ${message.message}`);
        }
        this.output.appendLine(`[server] ${message.message}`);
        break;
      }
      default:
        this.output.appendLine("[client] ignored unknown server message");
    }
  }

  private uniqueMembers(members: Member[]): Member[] {
    return [...new Map(members.map((member) => [member.memberId, member])).values()];
  }

  stopDocumentCollaboration(): void {
    this.approvedProposalApplication = undefined;
    this.invalidateConflictComparison();
    this.conflict = undefined;
    const stoppedPath = this.sharedDocumentPath;
    const stoppedSessionId = this.sharedDocumentSessionId;
    this.stopLocalTyping(true);
    if (stoppedPath && this.state.roomId && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "CLOSE_DOCUMENT", roomId: this.state.roomId, documentPath: stoppedPath, shareSessionId: stoppedSessionId });
      this.sendSharedFile(null);
    }
    this.documentSession += 1;
    this.clearCursorPresence();
    this.documentListener?.dispose();
    this.documentListener = undefined;
    this.documentCloseListener?.dispose();
    this.documentCloseListener = undefined;
    this.sharedDocumentPath = undefined;
    this.sharedDocumentSessionId = undefined;
    this.sharedDocument = undefined;
    this.awaitingDocumentSync = false;
    this.sharedDocumentRevision = 0;
    this.confirmedDocument = undefined;
    this.sentDocument = undefined;
    this.receivedDocumentRevision = 0;
    this.documentEditInFlight = false;
    if (this.documentAckTimer) clearTimeout(this.documentAckTimer);
    this.documentAckTimer = undefined;
    this.pendingDocumentText = undefined;
    this.documentConflict = false;
    this.applyingRemoteDocumentPath = undefined;
    this.applyingRemoteDocumentText = undefined;
    this.remoteDocumentQueue = Promise.resolve();
    this.state = { ...this.state, sharedDocumentPath: undefined, documentStatus: undefined, documentError: undefined,
      sharedFiles: this.state.sharedFiles.filter((file) => file.memberId !== this.state.self.memberId) };
    if (this.additionalDocuments.size) this.installTypingInput();
    this.updateState({});
  }

  private queueDocumentText(text: string): void {
    try {
      this.validateDocumentText(text);
    } catch (error) {
      this.rejectDocumentEdit(error instanceof Error ? error.message : String(error));
      return;
    }
    this.pendingDocumentText = text;
    this.flushPendingDocumentText();
  }

  private flushPendingDocumentText(approval?: DocumentConflict): void {
    // This guard runs synchronously at the send boundary, after any editor await.
    if (approval && (approval.session !== this.documentSession || approval.roomId !== this.state.roomId
      || approval.path !== this.sharedDocumentPath || approval.revision !== this.receivedDocumentRevision
      || approval.revision !== this.sharedDocumentRevision)) return;
    if (
      this.documentEditInFlight
      || this.awaitingDocumentSync
      || this.applyingRemoteDocumentPath !== undefined
      || this.documentConflict
      || this.state.documentStatus !== "shared"
      || !this.state.roomId
      || !this.sharedDocumentPath
      || this.pendingDocumentText === undefined
    ) {
      return;
    }

    const text = this.pendingDocumentText;
    this.pendingDocumentText = undefined;
    this.documentEditInFlight = true;
    const roomId = this.state.roomId;
    const documentPath = this.sharedDocumentPath;
    const session = this.documentSession;
    const baseRevision = this.sharedDocumentRevision;
    this.sentDocument = { text, baseRevision };
    this.output.appendLine(`[sync] send DOCUMENT_EDIT room=${roomId} path=${documentPath} session=${session} presenceSession=${this.presenceSessionId ?? "none"} baseRevision=${baseRevision} pending=${this.pendingDocumentText !== undefined}`);
    try {
      this.send({ type: "DOCUMENT_EDIT", roomId, documentPath, baseRevision, text, shareSessionId: this.sharedDocumentSessionId });
    } catch (error) {
      this.pauseDocumentSync(error instanceof Error ? error.message : String(error), session);
      return;
    }
    this.documentAckTimer = setTimeout(() => {
      this.documentAckTimer = undefined;
      if (session === this.documentSession && this.documentEditInFlight) {
        this.pauseDocumentSync("The server did not confirm the last edit", session);
      }
    }, this.options.documentAckTimeoutMs ?? 15000);
    this.documentAckTimer.unref();
  }

  private async handleDocumentSync(documentPath: string, text: string, revision: number): Promise<void> {
    text = normalizeDocumentText(text);
    this.awaitingDocumentSync = false;
    this.sharedDocumentRevision = revision;
    this.receivedDocumentRevision = revision;
    if (this.getSharedDocumentText() !== text) {
      this.handleDocumentConflict(text, revision);
      return;
    }
    this.pendingDocumentText = undefined;
    this.confirmedDocument = { text, revision };
    this.updateState({ documentStatus: "shared", documentError: undefined });
    await this.applyRemoteDocumentText(documentPath, text, revision);
    this.queueSelectionRanges();
  }

  private queueRemoteDocumentText(documentPath: string, text: string, revision: number): void {
    const session = this.documentSession;
    this.remoteDocumentQueue = this.remoteDocumentQueue.then(async () => {
      if (session !== this.documentSession) return;
      if (this.documentConflict || this.documentEditInFlight || this.pendingDocumentText !== undefined) {
        this.handleDocumentConflict(text, revision);
      } else {
        await this.applyRemoteDocumentText(documentPath, text, revision);
      }
    }).catch((error: unknown) => {
      if (session === this.documentSession) {
        this.rejectDocumentEdit(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private handleDocumentConflict(serverText: string, revision: number): void {
    // A competing edit can arrive as both a broadcast and a stale-edit rejection.
    if (revision < this.sharedDocumentRevision) return;
    if (this.documentConflict && this.sharedDocumentRevision >= revision) return;
    if (this.documentAckTimer) clearTimeout(this.documentAckTimer);
    this.documentAckTimer = undefined;
    serverText = normalizeDocumentText(serverText);
    const requiresInspection = Boolean(this.conflict?.comparison || this.conflict?.proposal || this.conflict?.requiresInspection);
    this.invalidateConflictComparison();
    const localText = this.getSharedDocumentText();
    this.sharedDocumentRevision = revision;
    this.documentEditInFlight = false;
    this.sentDocument = undefined;
    this.pendingDocumentText = localText;
    this.documentConflict = true;
    this.hideAllRemoteSelections();
    this.clearPublishedSelection();
    const previousRecovery = this.conflict?.recovery;
    const conflict: DocumentConflict = {
      roomId: this.state.roomId!, path: this.sharedDocumentPath!, session: this.documentSession,
      revision, text: serverText,
      base: this.confirmedDocument && this.confirmedDocument.revision < revision ? this.confirmedDocument.text : undefined,
      requiresInspection
    };
    if (previousRecovery) {
      const oldRoom = this.conflictSnapshots.get(previousRecovery.room.toString());
      if (oldRoom) oldRoom.stale = true;
      this.conflictChanges.fire(previousRecovery.room);
      conflict.recovery = { ...previousRecovery, revision, reviewed: false,
        room: this.recoverySnapshot("Latest room text", serverText) };
      this.recoveryArchive = conflict.recovery;
    }
    this.conflict = conflict;
    this.updateState({ documentStatus: "conflict", documentError: conflict.recovery ? UNSHARED_COMBINATION : undefined });
    if (!this.approvedProposalApplication) this.promptDocumentConflict(conflict);
  }

  private isCurrentConflict(conflict: DocumentConflict): boolean {
    return this.conflict === conflict && this.documentConflict && conflict.session === this.documentSession
      && conflict.roomId === this.state.roomId && conflict.path === this.sharedDocumentPath;
  }

  private invalidateConflictComparison(): void {
    for (const comparison of [this.conflict?.comparison, this.conflict?.proposal]) {
      if (!comparison || comparison.stale) continue;
      comparison.stale = true;
      for (const uri of [comparison.mine, comparison.room]) {
        const snapshot = this.conflictSnapshots.get(uri.toString());
        if (snapshot) snapshot.stale = true;
        this.conflictChanges.fire(uri);
      }
    }
  }

  private ensureConflictProvider(): void {
    if (!this.conflictProvider) {
      this.conflictProvider = vscode.workspace.registerTextDocumentContentProvider("codemesh-conflict", {
        onDidChange: this.conflictChanges.event,
        provideTextDocumentContent: (uri) => {
          const snapshot = this.conflictSnapshots.get(uri.toString());
          return snapshot ? (snapshot.stale ? "[STALE comparison — inspect differences again before choosing]\n" : "") + snapshot.text : "";
        }
      });
    }
  }

  private isAdditionalConflictCurrent(session: DocumentSyncSession, conflict: SessionConflict): boolean {
    return this.state.roomId === session.roomId && this.additionalDocuments.get(session.path) === session
      && session.isCurrentConflict(conflict);
  }

  private ensureAdditionalConflictProvider(): void {
    if (this.additionalConflictProvider) return;
    this.additionalConflictProvider = vscode.workspace.registerTextDocumentContentProvider("codemesh-session-conflict", {
      provideTextDocumentContent: uri => this.additionalConflictTexts.get(uri.toString()) ?? ""
    });
  }

  private additionalConflictUri(label: string, text: string): vscode.Uri {
    this.ensureAdditionalConflictProvider();
    const uri = vscode.Uri.parse(`codemesh-session-conflict:/${randomUUID()}/${label}`);
    this.additionalConflictTexts.set(uri.toString(), text);
    return uri;
  }

  private async promptAdditionalConflict(session: DocumentSyncSession, conflict: SessionConflict): Promise<void> {
    if (conflict.recovery && !conflict.recovery.reviewed) {
      void this.promptAdditionalRecovery(session, conflict, conflict.recovery);
      return;
    }
    const proposal = proposeCombinedText(conflict.baseText, session.document.getText(), conflict.roomText);
    const choice = await vscode.window.showWarningMessage(
      `CodeMesh preserved your unsaved draft for ${session.path} (room revision ${conflict.revision}). Sharing this file is paused.`,
      { modal: true }, "Inspect Differences", ...(proposal.text === undefined ? [] : ["Preview Combined Text"]),
      "Retry Mine", "Use Room Text", "End Sharing"
    );
    if (!this.isAdditionalConflictCurrent(session, conflict) || (conflict.recovery && !conflict.recovery.reviewed)) return;
    if (choice === "Inspect Differences") await this.inspectConflictDifferences(session.path);
    else if (choice === "Preview Combined Text") await this.previewCombinedText(session.path);
    else if (choice === "Retry Mine") session.retryMine(conflict);
    else if (choice === "Use Room Text") await session.useRoomText(conflict);
    else if (choice === "End Sharing") this.stopDocumentSession(session.path);
  }

  private async promptAdditionalRecovery(session: DocumentSyncSession, conflict: SessionConflict,
    recovery: SessionRecovery): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `CodeMesh preserved the original draft, proposed text, and latest room text for ${session.path}. `
        + (recovery.delivery === "unconfirmed" ? "The proposed text was not confirmed by the server. "
          : "The proposed text was not shared. ") + "Sharing this file remains paused.",
      { modal: true }, "Inspect Preserved Versions", "Start Fresh Comparison", "End Sharing");
    if (!this.isAdditionalConflictCurrent(session, conflict) || conflict.recovery !== recovery) return;
    if (choice === "Inspect Preserved Versions") await this.inspectRecoveryVersions(session.path);
    else if (choice === "Start Fresh Comparison") await this.inspectConflictDifferences(session.path);
    else if (choice === "End Sharing") this.stopDocumentSession(session.path);
  }

  async inspectConflictDifferences(path?: string): Promise<void> {
    const additional = path && this.additionalDocuments.get(path);
    if (additional) {
      const conflict = additional.conflict;
      if (!conflict || !this.isAdditionalConflictCurrent(additional, conflict)) return;
      const mine = this.additionalConflictUri("My unsaved draft", additional.document.getText());
      const room = this.additionalConflictUri("Room text", conflict.roomText);
      await vscode.commands.executeCommand("vscode.diff", mine, room,
        `${path} · Room revision ${conflict.revision} · My unsaved draft ↔ Room text`, { preview: false });
      if (this.isAdditionalConflictCurrent(additional, conflict) && conflict.recovery) {
        conflict.recovery.reviewed = true;
        void this.promptAdditionalConflict(additional, conflict);
      }
      return;
    }
    if (path && path !== this.sharedDocumentPath) return;
    const conflict = this.conflict;
    if (!conflict || !this.isCurrentConflict(conflict)) return;
    this.ensureConflictProvider();
    this.invalidateConflictComparison();
    const id = randomUUID();
    const mine = vscode.Uri.parse(`codemesh-conflict:/${id}/My unsaved draft`);
    const room = vscode.Uri.parse(`codemesh-conflict:/${id}/Room text`);
    const draft = this.sharedDocument!.getText();
    this.conflictSnapshots.set(mine.toString(), { text: draft, stale: false });
    this.conflictSnapshots.set(room.toString(), { text: conflict.text, stale: false });
    conflict.comparison = { draft, stale: false, mine, room };
    conflict.requiresInspection = false;
    await vscode.commands.executeCommand("vscode.diff", mine, room,
      `${conflict.path} · Room revision ${conflict.revision} · My unsaved draft ↔ Room text`, { preview: false });
    if (this.isCurrentConflict(conflict)) {
      if (conflict.recovery) conflict.recovery.reviewed = true;
      this.promptDocumentConflict(conflict);
    }
  }

  private promptDocumentConflict(conflict: DocumentConflict): void {
    if (conflict.recovery && !conflict.recovery.reviewed) {
      this.promptCombinedRecovery(conflict);
      return;
    }
    const comparison = conflict.comparison;
    const proposal = proposeCombinedText(conflict.base, this.getSharedDocumentText() ?? "", conflict.text);
    void vscode.window.showWarningMessage(
      `CodeMesh preserved your local draft: ${conflict.path} (room revision ${conflict.revision}). `
        + (conflict.recovery ? "The unsaved proposed combination in your editor has NOT been shared. " : "")
        + (conflict.requiresInspection ? "Comparison stale. Inspect Differences again before choosing. " : "Sharing is paused. Choose which text to share. ")
        + (proposal.reason ? `Combined proposal unavailable: ${proposal.reason}` : "Separate ranges can be previewed as a combined proposal."),
      { modal: true },
      "Inspect Differences", ...(proposal.text !== undefined ? ["Preview Combined Text"] : []),
      ...(conflict.requiresInspection ? [] : ["Retry Mine", "Use Room Text"]), "End Sharing"
    ).then((choice) => {
      if (!this.isCurrentConflict(conflict)) return;
      if (choice === "Preview Combined Text") {
        void this.previewCombinedText().catch(() => vscode.window.showErrorMessage("CodeMesh could not preview combined text. Sharing remains paused; your drafts are preserved."));
        return;
      }
      if (choice === "Inspect Differences") {
        void this.inspectConflictDifferences().catch(() => vscode.window.showErrorMessage("CodeMesh could not open the comparison. Your draft is preserved and sharing remains paused."));
        return;
      }
      if (choice === "End Sharing") {
        this.stopDocumentCollaboration();
        return;
      }
      if (choice !== "Retry Mine" && choice !== "Use Room Text") return;
      if (conflict.requiresInspection || comparison !== conflict.comparison
        || (comparison && (comparison.stale || comparison.draft !== this.sharedDocument?.getText()))) {
        this.invalidateConflictComparison();
        conflict.requiresInspection = true;
        this.promptDocumentConflict(conflict);
        return;
      }
      if (choice === "Retry Mine") {
        this.conflict = undefined;
        this.documentConflict = false;
        this.updateState({ documentStatus: "shared", documentError: undefined });
        this.pendingDocumentText = this.getSharedDocumentText() ?? conflict.text;
        this.flushPendingDocumentText();
      } else if (choice === "Use Room Text" && this.sharedDocumentPath) {
        this.conflict = undefined;
        this.documentConflict = false;
        this.pendingDocumentText = undefined;
        this.updateState({ documentStatus: "shared", documentError: undefined });
        void this.applyRemoteDocumentText(this.sharedDocumentPath, conflict.text, conflict.revision);
      }
    });
  }

  async previewCombinedText(path?: string): Promise<void> {
    const additional = path && this.additionalDocuments.get(path);
    if (additional) {
      const conflict = additional.conflict;
      if (!conflict || !this.isAdditionalConflictCurrent(additional, conflict)) return;
      if (conflict.recovery && !conflict.recovery.reviewed) {
        void this.promptAdditionalRecovery(additional, conflict, conflict.recovery);
        return;
      }
      const draft = additional.document.getText();
      const proposal = proposeCombinedText(conflict.baseText, draft, conflict.roomText);
      if (proposal.text === undefined) return;
      const mine = this.additionalConflictUri("My unsaved draft", draft);
      const combined = this.additionalConflictUri("Proposed combined text", proposal.text);
      await vscode.commands.executeCommand("vscode.diff", mine, combined,
        `${path} · Room revision ${conflict.revision} · My unsaved draft ↔ Proposed combined text`, { preview: false });
      if (!this.isAdditionalConflictCurrent(additional, conflict) || additional.document.getText() !== draft) return;
      const choice = await vscode.window.showWarningMessage(
        `Apply the combined proposal to the unsaved editor for ${path} and share it? No file will be saved.`,
        { modal: true }, "Apply and Share Combined Text", "Reject Proposal");
      if (choice === "Apply and Share Combined Text" && this.isAdditionalConflictCurrent(additional, conflict)
        && (!conflict.recovery || conflict.recovery.reviewed))
        await additional.applyProposal(conflict, draft, proposal.text);
      return;
    }
    if (path && path !== this.sharedDocumentPath) return;
    const conflict = this.conflict;
    if (!conflict || !this.isCurrentConflict(conflict)) return;
    if (this.approvedProposalApplication) return;
    if (conflict.recovery && !conflict.recovery.reviewed) { this.promptCombinedRecovery(conflict); return; }
    const draft = this.sharedDocument!.getText();
    const result = proposeCombinedText(conflict.base, draft, conflict.text);
    if (result.text === undefined) {
      this.promptDocumentConflict(conflict);
      return;
    }
    this.ensureConflictProvider();
    this.invalidateConflictComparison();
    const id = randomUUID();
    const mine = vscode.Uri.parse(`codemesh-conflict:/${id}/My unsaved draft`);
    const room = vscode.Uri.parse(`codemesh-conflict:/${id}/Proposed combined text`);
    this.conflictSnapshots.set(mine.toString(), { text: draft, stale: false });
    this.conflictSnapshots.set(room.toString(), { text: result.text, stale: false });
    const proposal = { draft, text: result.text, mine, room, stale: false };
    conflict.proposal = proposal;
    await vscode.commands.executeCommand("vscode.diff", mine, room,
      `${conflict.path} · Room revision ${conflict.revision} · My unsaved draft ↔ Proposed combined text`, { preview: false });
    if (!this.isCurrentConflict(conflict) || conflict.proposal !== proposal || proposal.stale) return;
    const choice = await vscode.window.showWarningMessage(
      `Combined proposal for ${conflict.path} (room revision ${conflict.revision}). Apply to your unsaved buffer and send to the room? No file will be saved.`,
      { modal: true }, "Apply and Share Combined Text", "Reject Proposal"
    );
    if (choice !== "Apply and Share Combined Text") return;
    const current = () => this.isCurrentConflict(conflict) && conflict.proposal === proposal && !proposal.stale
      && conflict.revision === this.sharedDocumentRevision && conflict.revision === this.receivedDocumentRevision
      && this.socket?.readyState === WebSocket.OPEN;
    if (!current() || draft !== this.sharedDocument?.getText()) {
      if (this.isCurrentConflict(conflict)) {
        this.invalidateConflictComparison();
        conflict.requiresInspection = true;
        this.promptDocumentConflict(conflict);
      }
      return;
    }
    const document = this.sharedDocument!;
    const text = document.eol === vscode.EndOfLine.CRLF ? proposal.text.replace(/\n/g, "\r\n") : proposal.text;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    this.applyingRemoteDocumentPath = conflict.path;
    this.applyingRemoteDocumentText = proposal.text;
    const application = { conflict };
    this.approvedProposalApplication = application;
    let applied = false;
    try {
      applied = await vscode.workspace.applyEdit(edit);
    } finally {
      if (this.approvedProposalApplication === application) {
        this.approvedProposalApplication = undefined;
        this.applyingRemoteDocumentPath = undefined;
        this.applyingRemoteDocumentText = undefined;
      }
    }
    // applyEdit yields to incoming frames and session changes. Never flush a
    // proposal approved for an earlier room revision or a different session.
    if (!applied || !current() || this.getSharedDocumentText() !== proposal.text) {
      const latest = this.conflict;
      if (applied && latest && this.isCurrentConflict(latest) && latest.session === conflict.session
        && latest.roomId === conflict.roomId && latest.path === conflict.path) {
        latest.recovery = {
          path: conflict.path, revision: latest.revision, reviewed: false,
          original: this.recoverySnapshot("Original local draft", draft),
          proposed: this.recoverySnapshot("Applied proposed combination - NOT shared", proposal.text),
          room: this.recoverySnapshot("Latest room text", latest.text)
        };
        this.recoveryArchive = latest.recovery;
        latest.requiresInspection = true;
        this.updateState({ documentStatus: "conflict", documentError: UNSHARED_COMBINATION });
        this.promptCombinedRecovery(latest);
        return;
      }
      if (latest && this.isCurrentConflict(latest) && latest.session === conflict.session) {
        this.invalidateConflictComparison();
        latest.requiresInspection = true;
        this.promptDocumentConflict(latest);
      }
      return;
    }
    this.conflict = undefined;
    this.documentConflict = false;
    this.pendingDocumentText = proposal.text;
    this.updateState({ documentStatus: "shared", documentError: undefined });
    this.flushPendingDocumentText(conflict);
  }

  private recoverySnapshot(label: string, text: string): vscode.Uri {
    this.ensureConflictProvider();
    const uri = vscode.Uri.parse(`codemesh-conflict:/${randomUUID()}/${label}`);
    this.conflictSnapshots.set(uri.toString(), { text, stale: false });
    return uri;
  }

  hasRecoveryVersions(path?: string): boolean {
    if (path && path !== this.sharedDocumentPath) {
      const session = this.additionalDocuments.get(path);
      return Boolean(session?.recovery || session?.recoverySnapshots.length);
    }
    return Boolean(this.recoveryArchive && (!path || this.recoveryArchive.path === path));
  }

  async inspectRecoveryVersions(path?: string): Promise<void> {
    if (path && path !== this.sharedDocumentPath) {
      const session = this.additionalDocuments.get(path);
      const combined = session?.recovery;
      if (combined) {
        const original = this.additionalConflictUri("Original local draft", combined.originalText);
        const proposalLabel = combined.delivery === "confirmed" ? "Confirmed proposal"
          : combined.delivery === "unconfirmed" ? "Unconfirmed proposal" : "Applied proposal - NOT shared";
        const proposed = this.additionalConflictUri(proposalLabel, combined.proposedText);
        const room = this.additionalConflictUri("Latest room text", combined.roomText);
        if (session !== this.additionalDocuments.get(path)) return;
        await vscode.commands.executeCommand("vscode.diff", original, proposed,
          `${path} · Original draft ↔ ${proposalLabel}`, { preview: false });
        if (session !== this.additionalDocuments.get(path)) return;
        await vscode.commands.executeCommand("vscode.diff", proposed, room,
          `${path} · ${proposalLabel} ↔ Room revision ${combined.revision}`, { preview: false });
        return;
      }
      const recovery = session?.recoverySnapshots.at(-1);
      if (!recovery) return;
      const mine = this.additionalConflictUri("Preserved local draft", recovery.localText);
      const room = this.additionalConflictUri("Preserved room text", recovery.roomText);
      if (session !== this.additionalDocuments.get(path)) return;
      await vscode.commands.executeCommand("vscode.diff", mine, room,
        `${path} · Preserved versions · Room revision ${recovery.revision}`, { preview: false });
      return;
    }
    const recovery = this.conflict?.recovery ?? this.recoveryArchive;
    if (!recovery || (path && recovery.path !== path)) return;
    await vscode.commands.executeCommand("vscode.diff", recovery.original, recovery.proposed,
      `${recovery.path} · Original local draft ↔ Applied in editor - NOT shared`, { preview: false });
    await vscode.commands.executeCommand("vscode.diff", recovery.proposed, recovery.room,
      `${recovery.path} · NOT shared proposal ↔ Room text revision ${recovery.revision}`, { preview: false });
  }

  private promptCombinedRecovery(conflict: DocumentConflict): void {
    void vscode.window.showWarningMessage(
      `${UNSHARED_COMBINATION} ${conflict.path} (latest room revision ${conflict.revision}). `
        + "The original local draft, applied proposal and latest room text are preserved. Further typing stays local.",
      { modal: true }, "Inspect Preserved Versions", "Start Fresh Comparison", "End Sharing"
    ).then((choice) => {
      if (!this.isCurrentConflict(conflict)) return;
      if (choice === "End Sharing") this.stopDocumentCollaboration();
      else if (choice === "Start Fresh Comparison") void this.inspectConflictDifferences().catch(() =>
        vscode.window.showErrorMessage("CodeMesh could not open a fresh comparison. Sharing remains paused and the preserved versions are available."));
      else if (choice === "Inspect Preserved Versions") void this.inspectRecoveryVersions().catch(() =>
        vscode.window.showErrorMessage("CodeMesh could not open the preserved versions. Your editor is unchanged and sharing remains paused."));
    });
  }

  private pauseDocumentSync(reason: string, session: number): void {
    if (session !== this.documentSession || !this.sharedDocumentPath || this.state.documentStatus === "paused") return;
    const roomId = this.state.roomId;
    const documentPath = this.sharedDocumentPath;
    this.output.appendLine(`[sync] pause room=${roomId ?? "none"} path=${documentPath} session=${session} presenceSession=${this.presenceSessionId ?? "none"} revision=${this.sharedDocumentRevision} inFlight=${this.documentEditInFlight} pending=${this.pendingDocumentText !== undefined} reason=${reason}; localDraftPreserved=true`);
    if (this.documentAckTimer) clearTimeout(this.documentAckTimer);
    this.documentAckTimer = undefined;
    this.documentEditInFlight = false;
    this.pendingDocumentText = this.getSharedDocumentText();
    this.documentConflict = false;
    this.confirmedDocument = undefined;
    this.sentDocument = undefined;
    this.updateState({
      documentStatus: "paused",
      documentError: reason,
      sharedFiles: this.state.sharedFiles.filter((file) => file.memberId !== this.state.self.memberId)
    });
    this.hideAllRemoteSelections();
    try { this.clearPublishedSelection(); } catch { /* Keep pause state even if the socket has failed. */ }
    this.clearCursorPresence();
    if (roomId && this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.send({ type: "CLOSE_DOCUMENT", roomId, documentPath, shareSessionId: this.sharedDocumentSessionId });
        this.sendSharedFile(null);
      } catch (error) {
        this.output.appendLine(`[sync] failed to clear paused presence room=${roomId} path=${documentPath} session=${session}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    vscode.window.showErrorMessage(`CodeMesh paused live sync for ${documentPath}: ${reason}. Your unsaved draft is unchanged. Re-share explicitly to reconcile it with room text.`);
  }

  private async applyRemoteDocumentText(documentPath: string, text: string, revision: number): Promise<void> {
    try {
      this.validateDocumentText(normalizeDocumentText(text));
    } catch (error) {
      this.rejectDocumentEdit(error instanceof Error ? error.message : String(error));
      return;
    }
    const document = this.sharedDocument;
    if (this.sharedDocumentPath !== documentPath) return;
    text = normalizeDocumentText(text);
    if (document?.eol === vscode.EndOfLine.CRLF) text = text.replace(/\n/g, "\r\n");
    if (!document || document.getText() === text) {
      this.sharedDocumentRevision = revision;
      if (document) this.confirmedDocument = { text: normalizeDocumentText(text), revision };
      this.queueSelectionRanges();
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    edit.replace(document.uri, fullRange, text);
    this.applyingRemoteDocumentPath = documentPath;
    this.applyingRemoteDocumentText = normalizeDocumentText(text);
    const session = this.documentSession;
    try {
      const applied = await vscode.workspace.applyEdit(edit);
      if (session !== this.documentSession) return;
      if (applied && !this.documentConflict) {
        this.sharedDocumentRevision = revision;
        this.confirmedDocument = { text: normalizeDocumentText(text), revision };
      }
      else this.handleDocumentConflict(text, revision);
    } finally {
      if (session === this.documentSession) {
        this.applyingRemoteDocumentPath = undefined;
        this.applyingRemoteDocumentText = undefined;
        this.flushPendingDocumentText();
        this.queueSelectionRanges();
      }
    }
  }

  private getSharedDocumentText(): string | undefined {
    return this.sharedDocument ? normalizeDocumentText(this.sharedDocument.getText()) : undefined;
  }

  private isValidDocumentPath(documentPath: string): boolean {
    const segments = documentPath.split("/");
    return Boolean(documentPath)
      && Buffer.byteLength(documentPath, "utf8") <= MAX_DOCUMENT_PATH_BYTES
      && !documentPath.includes("\\")
      && !documentPath.startsWith("/")
      && !/^[A-Za-z]:\//.test(documentPath)
      && !/[\u0000-\u001f]/.test(documentPath)
      && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  }

  private sendSharedFile(documentPath: string | null): void {
    if (!this.state.roomId || !this.presenceSessionId || this.socket?.readyState !== WebSocket.OPEN) return;
    this.send({ type: "SET_SHARED_FILE", roomId: this.state.roomId, presenceSessionId: this.presenceSessionId,
      sequence: ++this.presenceSequence, documentPath });
  }

  private installTypingInput(): void {
    if (this.typingInput || !vscode.commands?.registerCommand || !vscode.commands.executeCommand) return;
    try {
      // Document-change events lack an edit source; only the editor input command can qualify for typing presence.
      this.typingInput = vscode.commands.registerCommand("type", async (args: { text?: string }) => {
        const document = vscode.window.activeTextEditor?.document;
        const additional = [...this.additionalDocuments.values()].find(value => value.document === document);
        if (additional) {
          const version = additional.document.version;
          const sessionId = additional.shareSessionId;
          await vscode.commands.executeCommand("default:type", args);
          if (typeof args?.text === "string" && args.text.length > 0 && additional.document.version === version + 1
            && this.additionalDocuments.get(additional.path) === additional && additional.shareSessionId === sessionId)
            this.additionalPresence.get(additional.path)?.noteLocalUserEdit();
          return;
        }
        const session = this.documentSession;
        const eligible = document === this.sharedDocument && typeof args?.text === "string" && args.text.length > 0
          && this.state.documentStatus === "shared" && !this.documentConflict && !this.awaitingDocumentSync
          && !this.applyingRemoteDocumentPath && Boolean(this.localCursorShareId);
        const probe = eligible && document ? { document, session, version: document.version, changes: 0, ambiguous: false } : undefined;
        if (this.typingProbe) this.typingProbe.ambiguous = true;
        this.typingProbe = probe;
        try {
          await vscode.commands.executeCommand("default:type", args);
        } finally {
          if (this.typingProbe === probe) this.typingProbe = undefined;
        }
        if (probe && !probe.ambiguous && probe.changes === 1 && probe.document.version === probe.version + 1
          && session === this.documentSession
          && document === this.sharedDocument && !this.applyingRemoteDocumentPath) this.noteLocalUserEdit();
      });
    } catch (error) {
      this.output.appendLine("[presence] typing command unavailable: " + String(error));
    }
  }

  private noteLocalUserEdit(): void {
    if (!this.state.roomId || !this.sharedDocumentPath || !this.presenceSessionId || !this.localCursorShareId
      || this.state.documentStatus !== "shared" || this.socket?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (!this.localTypingActive || now - this.lastTypingSentAt >= 400) {
      this.send({ type: "TYPING_ACTIVITY", roomId: this.state.roomId, documentPath: this.sharedDocumentPath,
        presenceSessionId: this.presenceSessionId, shareId: this.localCursorShareId,
        sequence: ++this.typingSequence, active: true });
      this.localTypingActive = true;
      this.lastTypingSentAt = now;
    }
    if (this.typingIdleTimer) clearTimeout(this.typingIdleTimer);
    this.typingIdleTimer = setTimeout(() => this.stopLocalTyping(true), 1000);
    this.typingIdleTimer.unref();
  }

  private stopLocalTyping(sendStop: boolean): void {
    if (this.typingIdleTimer) clearTimeout(this.typingIdleTimer);
    this.typingIdleTimer = undefined;
    if (sendStop && this.localTypingActive && this.state.roomId && this.sharedDocumentPath
      && this.presenceSessionId && this.localCursorShareId && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "TYPING_ACTIVITY", roomId: this.state.roomId, documentPath: this.sharedDocumentPath,
        presenceSessionId: this.presenceSessionId, shareId: this.localCursorShareId,
        sequence: ++this.typingSequence, active: false });
    }
    this.localTypingActive = false;
    this.lastTypingSentAt = 0;
  }

  private removeRemoteTyping(memberId: string): void {
    const typing = this.remoteTyping.get(memberId);
    if (!typing) return;
    if (typing.timer) clearTimeout(typing.timer);
    this.remoteTyping.delete(memberId);
    if (typing.active) this.refreshTypingState();
  }

  private refreshTypingState(): void {
    const typingMemberIds = [...this.remoteTyping].filter(([memberId, typing]) => typing.active
      && this.state.members.some((member) => member.memberId === memberId)).map(([memberId]) => memberId);
    if (typingMemberIds.join("\0") !== this.state.typingMemberIds.join("\0")) this.updateState({ typingMemberIds });
    this.refreshAdditionalTyping();
  }

  private clearPresence(): void {
    this.clearCursorPresence();
    this.sharedFileSessions.clear();
    this.openPresenceShares.clear();
    this.presenceSessionId = undefined;
    this.presenceSequence = 0;
    this.presenceRevision = -1;
    this.updateState({ sharedFiles: [], openSharedFiles: [], recentEditFiles: [], typingMemberIds: [] });
  }

  private matchesPrimaryPeerShare(memberId: string, path: string, shareId: string): boolean {
    return this.openPresenceShares.get(`${memberId}\0${path}`) === shareId
      || (this.sharedFileSessions.get(memberId) === shareId
        && this.state.sharedFiles.some(file => file.memberId === memberId && file.documentPath === path));
  }

  private isValidCursorPosition(value: unknown): value is CursorPosition {
    if (!value || typeof value !== "object") return false;
    const position = value as CursorPosition;
    return Number.isSafeInteger(position.line) && position.line >= 0 && position.line <= 1000000
      && Number.isSafeInteger(position.character) && position.character >= 0 && position.character <= 1000000;
  }

  private isValidSelectionRanges(value: unknown): value is SelectionRange[] {
    if (!Array.isArray(value) || value.length > MAX_SELECTION_RANGES) return false;
    return value.every((range) => {
      if (!range || typeof range !== "object" || Array.isArray(range)
        || Object.keys(range).sort().join() !== "end,start") return false;
      const item = range as SelectionRange;
      const validPosition = (position: unknown) => Boolean(position && typeof position === "object"
        && !Array.isArray(position) && Object.keys(position).sort().join() === "character,line"
        && this.isValidCursorPosition(position));
      return validPosition(item.start) && validPosition(item.end)
        && (item.start.line < item.end.line
          || (item.start.line === item.end.line && item.start.character < item.end.character));
    });
  }

  private localSelectionRanges(editor: vscode.TextEditor): SelectionRange[] | undefined {
    const selections = editor.selections ?? [editor.selection];
    if (selections.length > MAX_SELECTION_RANGES) {
      if (!this.selectionLimitWarned) {
        this.selectionLimitWarned = true;
        void vscode.window.showWarningMessage(`CodeMesh shows at most ${MAX_SELECTION_RANGES} remote selection ranges. Your local selections are unchanged.`);
      }
      return undefined;
    }
    const ranges: SelectionRange[] = [];
    for (const selection of selections) {
      const anchor = selection.anchor ?? selection.active;
      const active = selection.active;
      if (!this.isValidCursorPosition(anchor) || !this.isValidCursorPosition(active)) return undefined;
      const start = anchor.line < active.line || (anchor.line === active.line && anchor.character <= active.character) ? anchor : active;
      const end = start === anchor ? active : anchor;
      if (start.line >= editor.document.lineCount || end.line >= editor.document.lineCount
        || start.character > editor.document.lineAt(start.line).text.length
        || end.character > editor.document.lineAt(end.line).text.length) return undefined;
      if (start.line !== end.line || start.character !== end.character) ranges.push({
        start: { line: start.line, character: start.character },
        end: { line: end.line, character: end.character }
      });
    }
    return ranges;
  }

  private clearPublishedSelection(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = undefined;
    if (this.localSelectionActive && this.state.roomId && this.sharedDocumentPath && this.presenceSessionId
      && this.localCursorShareId && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "SELECTION_UPDATE", roomId: this.state.roomId, documentPath: this.sharedDocumentPath,
        presenceSessionId: this.presenceSessionId, shareId: this.localCursorShareId,
        sequence: ++this.selectionSequence, documentRevision: this.sharedDocumentRevision, ranges: [] });
    }
    this.localSelectionActive = false;
    this.lastSelectionKey = "";
  }

  private queueSelectionRanges(): void {
    if (!this.localCursorShareId || !this.sharedDocument || !this.sharedDocumentPath) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== this.sharedDocument) return;
    const ranges = this.localSelectionRanges(editor);
    if (!ranges?.length || this.state.documentStatus !== "shared" || this.awaitingDocumentSync
      || this.documentEditInFlight || this.pendingDocumentText !== undefined
      || this.applyingRemoteDocumentPath !== undefined) {
      this.clearPublishedSelection();
      return;
    }
    if (this.selectionTimer) return;
    const session = this.documentSession;
    const shareId = this.localCursorShareId;
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = undefined;
      if (session !== this.documentSession || shareId !== this.localCursorShareId
        || !this.sharedDocumentPath || !this.state.roomId || !this.presenceSessionId
        || this.socket?.readyState !== WebSocket.OPEN) return;
      const currentEditor = vscode.window.activeTextEditor;
      if (!currentEditor || currentEditor.document !== this.sharedDocument) return;
      const current = this.localSelectionRanges(currentEditor);
      if (!current?.length || this.state.documentStatus !== "shared" || this.awaitingDocumentSync
        || this.documentEditInFlight || this.pendingDocumentText !== undefined
        || this.applyingRemoteDocumentPath !== undefined) {
        this.clearPublishedSelection();
        return;
      }
      const key = `${this.sharedDocumentRevision}:${JSON.stringify(current)}`;
      if (key === this.lastSelectionKey) return;
      this.send({ type: "SELECTION_UPDATE", roomId: this.state.roomId, documentPath: this.sharedDocumentPath,
        presenceSessionId: this.presenceSessionId, shareId, sequence: ++this.selectionSequence,
        documentRevision: this.sharedDocumentRevision, ranges: current });
      this.localSelectionActive = true;
      this.lastSelectionKey = key;
    }, 50);
    this.selectionTimer.unref();
  }

  private queueCursorPosition(): void {
    if (this.cursorTimer) return;
    const session = this.documentSession;
    const shareId = this.localCursorShareId;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined;
      if (session !== this.documentSession || !shareId || shareId !== this.localCursorShareId
        || !this.sharedDocumentPath || !this.state.roomId || !this.presenceSessionId
        || this.socket?.readyState !== WebSocket.OPEN) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== this.sharedDocument) return;
      const position = editor.selection.active;
      if (!this.isValidCursorPosition(position) || position.line >= editor.document.lineCount
        || position.character > editor.document.lineAt(position.line).text.length) return;
      this.send({ type: "CURSOR_UPDATE", roomId: this.state.roomId, documentPath: this.sharedDocumentPath,
        presenceSessionId: this.presenceSessionId, shareId, sequence: ++this.cursorSequence,
        position: { line: position.line, character: position.character } });
    }, 50);
    this.cursorTimer.unref();
  }

  private removeRemoteCursor(memberId: string): void {
    this.remoteCursors.delete(memberId);
    const decoration = this.cursorDecorations.get(memberId);
    if (decoration) decoration.dispose();
    this.cursorDecorations.delete(memberId);
  }

  private disposeSelectionDecoration(memberId: string): void {
    this.selectionDecorations.get(memberId)?.dispose();
    this.selectionDecorations.delete(memberId);
  }

  private removeRemoteSelection(memberId: string): void {
    this.remoteSelections.delete(memberId);
    this.disposeSelectionDecoration(memberId);
  }

  private hideAllRemoteSelections(): void {
    for (const [memberId, selection] of this.remoteSelections) {
      this.remoteSelections.set(memberId, { ...selection, ranges: [] });
      this.disposeSelectionDecoration(memberId);
    }
  }

  private clearCursorPresence(): void {
    this.typingInput?.dispose();
    this.typingInput = undefined;
    this.typingProbe = undefined;
    this.stopLocalTyping(false);
    for (const memberId of [...this.remoteTyping.keys()]) this.removeRemoteTyping(memberId);
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.cursorTimer = undefined;
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = undefined;
    this.selectionListener?.dispose();
    this.selectionListener = undefined;
    this.visibleEditorListener?.dispose();
    this.visibleEditorListener = undefined;
    for (const memberId of [...this.cursorDecorations.keys()]) this.removeRemoteCursor(memberId);
    for (const memberId of [...this.selectionDecorations.keys()]) this.disposeSelectionDecoration(memberId);
    this.remoteCursors.clear();
    this.remoteSelections.clear();
    this.cursorColors.clear();
    this.nextCursorColor = 0;
    this.localCursorShareId = undefined;
    this.cursorSequence = 0;
    this.selectionSequence = 0;
    this.typingSequence = 0;
    this.localSelectionActive = false;
    this.lastSelectionKey = "";
    this.selectionLimitWarned = false;
  }

  private colorForMember(memberId: string): string {
    let color = this.cursorColors.get(memberId);
    if (!color) {
      color = `hsl(${(this.nextCursorColor++ * 137.508) % 360}, 75%, 42%)`;
      this.cursorColors.set(memberId, color);
    }
    return color;
  }

  private renderRemoteCursors(): void {
    if (!vscode.window.createTextEditorDecorationType) return;
    const activeEditor = vscode.window.activeTextEditor;
    const editors = vscode.window.visibleTextEditors ?? (activeEditor ? [activeEditor] : []);
    for (const [memberId, cursor] of this.remoteCursors) {
      const member = this.state.members.find((entry) => entry.memberId === memberId);
      if (!member || !this.sharedDocument || !this.sharedDocumentPath) { this.removeRemoteCursor(memberId); continue; }
      let decoration = this.cursorDecorations.get(memberId);
      if (!decoration) {
        const color = this.colorForMember(memberId);
        const name = member.displayName.replace(/[\u0000-\u001f]/g, " ").slice(0, 32);
        decoration = vscode.window.createTextEditorDecorationType({
          before: { contentText: `| ${name}`, color, fontWeight: "bold" },
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        });
        this.cursorDecorations.set(memberId, decoration);
      }
      for (const editor of editors) {
        if (editor.document !== this.sharedDocument || cursor.position.line >= editor.document.lineCount) {
          editor.setDecorations(decoration, []);
          continue;
        }
        const line = editor.document.lineAt(cursor.position.line);
        if (cursor.position.character > line.text.length) { editor.setDecorations(decoration, []); continue; }
        const position = new vscode.Position(cursor.position.line, cursor.position.character);
        editor.setDecorations(decoration, [new vscode.Range(position, position)]);
      }
    }
  }

  private renderRemoteSelections(): void {
    if (!vscode.window.createTextEditorDecorationType) return;
    const activeEditor = vscode.window.activeTextEditor;
    const editors = vscode.window.visibleTextEditors ?? (activeEditor ? [activeEditor] : []);
    for (const [memberId, selection] of this.remoteSelections) {
      if (!selection.ranges.length || !this.sharedDocument || !this.sharedDocumentPath) {
        this.disposeSelectionDecoration(memberId);
        continue;
      }
      let decoration = this.selectionDecorations.get(memberId);
      if (!decoration) {
        const color = this.colorForMember(memberId);
        decoration = vscode.window.createTextEditorDecorationType({
          backgroundColor: color.replace("hsl(", "hsla(").replace(")", ", 0.16)"),
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        });
        this.selectionDecorations.set(memberId, decoration);
      }
      for (const editor of editors) {
        if (editor.document !== this.sharedDocument) { editor.setDecorations(decoration, []); continue; }
        const ranges = selection.ranges.filter(({ start, end }) => start.line < editor.document.lineCount
          && end.line < editor.document.lineCount
          && start.character <= editor.document.lineAt(start.line).text.length
          && end.character <= editor.document.lineAt(end.line).text.length)
          .map(({ start, end }) => new vscode.Range(
            new vscode.Position(start.line, start.character), new vscode.Position(end.line, end.character)));
        editor.setDecorations(decoration, ranges);
      }
    }
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("CodeMesh socket is not connected");
    }
    this.socket.send(this.serializeMessage(message));
  }

  private validateDocumentText(text: string): void {
    if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) throw new Error(DOCUMENT_SIZE_ERROR);
  }

  private serializeMessage(message: ClientMessage): string {
    const raw = JSON.stringify(message);
    if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) throw new Error(MESSAGE_SIZE_ERROR);
    return raw;
  }

  private rejectDocumentEdit(reason: string): void {
    this.stopDocumentCollaboration();
    vscode.window.showErrorMessage(`CodeMesh stopped sharing: ${reason}. Your local draft was preserved. Reduce the text size if needed, then re-share explicitly.`);
  }

  private updateState(update: Partial<CodeMeshState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    this.changeEmitter.fire(this.getState());
  }

  private getOrCreateMember(): Member {
    const configuredName = vscode.workspace
      .getConfiguration("codemesh")
      .get<string>("displayName", "")
      .trim();

    return {
      memberId: randomUUID(),
      displayName: configuredName || `User ${Math.floor(1000 + Math.random() * 9000)}`
    };
  }
}
