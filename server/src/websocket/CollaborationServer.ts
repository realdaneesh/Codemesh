import { createServer, type Server } from "node:http";
import { CloudAccess } from "../cloudAccess";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_LISTEN_HOST, validateListenHost } from "../listenConfig";
import { randomUUID } from "node:crypto";
import { RoomManager, type Room } from "../rooms/RoomManager";
import { TYPING_LEASE_MS, type ServerMessage } from "../types/protocol";

interface OpenSession {
  id: string;
  legacy: boolean;
  tokenedEdits: boolean;
  shareId: string;
  cursorSequence: number;
  selectionSequence: number;
  typingSequence: number;
  typingUntil: number;
}
import { MAX_MESSAGE_BYTES } from "../types/syncLimits";
import { type WorkspaceManifest, type WorkspaceChanges, WorkspaceRequestError } from "../types/workspaceManifest";
import { parseClientMessage } from "./messageValidation";
import { FILE_REQUEST_TIMEOUT_MS, FileTransferError, MAX_FILE_BYTES, MAX_ROOM_FILE_REQUESTS, sameFileRequest, type FileRequestKey } from "../types/fileTransfer";

interface SharedDocument {
  text: string;
  revision: number;
  clients: Set<WebSocket>;
}

interface PendingFile {
  key: FileRequestKey;
  requester: WebSocket;
  owner: WebSocket;
  timer: NodeJS.Timeout;
}

export class CollaborationServer {
  private readonly roomManager = new RoomManager<WebSocket>();
  private readonly documents = new Map<string, SharedDocument>();
  private readonly openDocuments = new Map<WebSocket, Map<string, OpenSession>>();
  private readonly workspaces = new Map<string, { owner: WebSocket; manifest: WorkspaceManifest; id: string; publicationId: string | null; changes?: WorkspaceChanges }>();
  private readonly fileRequests = new Map<string, PendingFile>();
  private readonly presenceSessions = new Map<WebSocket, { roomId: string; memberId: string; id: string; sequence: number; documentPath?: string; shareId?: string; cursorSequence: number; selectionSequence: number; typingSequence: number; typingUntil: number }>();
  private readonly presenceRevisions = new Map<string, number>();
  private readonly server: WebSocketServer;
  private readonly http?: Server;
  private readonly cloud?: CloudAccess;
  private heartbeat?: NodeJS.Timeout;
  private upgradeWindow = { start: Date.now(), count: 0 };
  private readonly traffic = new Map<WebSocket, { start: number; count: number; bytes: number; connectedAt: number; alive: boolean; joined: boolean; errors: number }>();

  constructor(port: number, private readonly options: { fileRequestTimeoutMs?: number; host?: string; cloud?: { hostKey: string; inviteTtlMs?: number } } = {}) {
    const host = options.cloud ? (options.host ?? "0.0.0.0") : validateListenHost(options.host ?? DEFAULT_LISTEN_HOST);
    if (options.cloud) {
      this.cloud = new CloudAccess(options.cloud.hostKey,
        socket => this.roomManager.getRoomForClient(socket)?.roomId,
        room => [...this.server.clients].filter(s => this.roomManager.getRoomForClient(s)?.roomId === room).length,
        options.cloud.inviteTtlMs);
      this.http = createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(req.method === "GET" && req.url === "/health" ? 200 : 404, { "Content-Type": "application/json" });
        res.end(req.method === "GET" && req.url === "/health" ? '{"status":"ok"}' : '{}');
      });
      this.http.headersTimeout = 10000;
      this.http.requestTimeout = 10000;
      this.http.maxConnections = 128;
      this.server = new WebSocketServer({ server: this.http, path: "/", maxPayload: MAX_MESSAGE_BYTES,
        perMessageDeflate: false, verifyClient: () => {
          if (Date.now() - this.upgradeWindow.start > 60000) this.upgradeWindow = { start: Date.now(), count: 0 };
          return ++this.upgradeWindow.count <= 120 && this.server.clients.size < 64;
        } });
      this.http.listen(port, host);
    } else this.server = new WebSocketServer({ port, host, maxPayload: MAX_MESSAGE_BYTES });
  }

  start(onListening?: () => void): void {
    if (onListening) this.server.once("listening", onListening);
    if (this.cloud) {
      this.heartbeat = setInterval(() => {
        this.cloud?.sweep();
        for (const [socket, state] of this.traffic) {
          if (!state.alive || (!state.joined && Date.now() - state.connectedAt > 15000)) socket.terminate();
          else { state.alive = false; socket.ping(); }
        }
      }, 15000);
      this.heartbeat.unref();
    }
    this.server.on("connection", (socket) => {
      console.log("[ws] client connected");
      this.traffic.set(socket, { start: Date.now(), count: 0, bytes: 0, connectedAt: Date.now(), alive: true, joined: false, errors: 0 });
      socket.on("pong", () => { const state = this.traffic.get(socket); if (state) state.alive = true; });

      socket.on("message", (data) => {
        if (this.cloud) {
          const state = this.traffic.get(socket)!;
          if (Date.now() - state.start > 1000) { state.start = Date.now(); state.count = 0; state.bytes = 0; }
          state.count++; state.bytes += Buffer.byteLength(data.toString(), "utf8");
          if (state.count > 120 || state.bytes > 4 * 1024 * 1024) { socket.close(1008, "Rate limit"); return; }
        }
        this.handleMessage(socket, data.toString());
      });

      socket.on("close", () => {
        console.log("[ws] client disconnected");
        this.cloud?.disconnect(socket);
        this.traffic.delete(socket);
        const room = this.roomManager.leaveRoom(socket);
        this.clearPresenceSession(socket);
        this.cancelFileRequests((pending) => pending.owner === socket || pending.requester === socket, "File request cancelled because a member disconnected");
        this.closeDocumentsForClient(socket);
        if (room) {
          this.broadcastMembers(room);
        }
      });

      socket.on("error", (error) => {
        console.error("[ws] socket error", (error as NodeJS.ErrnoException).code ?? "transport failure");
      });
    });
  }

  shutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const pending of this.fileRequests.values()) clearTimeout(pending.timer);
    for (const socket of this.server.clients) socket.close(1001, "Relay shutting down");
    this.server.close();
    this.http?.close();
    const timer = setTimeout(() => { for (const socket of this.server.clients) socket.terminate(); this.http?.closeAllConnections(); }, 2000);
    timer.unref();
  }

  private handleMessage(socket: WebSocket, rawMessage: string): void {
    try {
      const admitted = this.cloud ? this.cloud.filter(socket, rawMessage) : rawMessage;
      if (admitted === undefined) return;
      const message = parseClientMessage(admitted);
      if (this.cloud && (message.type === "CREATE_ROOM" || message.type === "JOIN_ROOM")) message.member = this.cloud.member(socket);

      switch (message.type) {
        case "CREATE_ROOM": {
          this.cancelFileRequests((pending) => pending.owner === socket || pending.requester === socket, "File request cancelled because a member changed rooms");
          this.closeDocumentsForClient(socket);
          const previousRoom = this.roomManager.leaveRoom(socket);
          this.clearPresenceSession(socket);
          if (previousRoom) this.broadcastMembers(previousRoom);
          const room = this.roomManager.createRoom(socket, message.member);
          this.cloud?.bindCreated(socket, room.roomId);
          const presenceSessionId = this.startPresenceSession(socket, room, message.member.memberId);
          const members = this.roomManager.getMembers(room);
          this.send(socket, {
            type: "ROOM_CREATED",
            roomId: room.roomId,
            member: message.member,
            members,
            presenceSessionId
          });
          this.broadcastMembers(room);
          this.cloud?.created(socket, room.roomId);
          this.traffic.get(socket)!.joined = true;
          if (!this.cloud) console.log(`[rooms] created ${room.roomId} by ${message.member.displayName}`);
          break;
        }
        case "JOIN_ROOM": {
          const previousRoom = this.roomManager.getRoomForClient(socket);
          const room = this.roomManager.joinRoom(message.roomId, socket, message.member);
          if (!room) {
            this.sendError(socket, `Room ${message.roomId} does not exist`);
            return;
          }
          this.closeDocumentsForClient(socket);
          this.clearPresenceSession(socket);
          for (const [other, session] of this.presenceSessions) {
            if (other !== socket && session.roomId === room.roomId && session.memberId === message.member.memberId) {
              this.closeDocumentsForClient(other);
              this.clearPresenceSession(other);
            }
          }
          const presenceSessionId = this.startPresenceSession(socket, room, message.member.memberId);

          if (previousRoom && previousRoom !== room) this.broadcastMembers(previousRoom);

          const members = this.roomManager.getMembers(room);
          this.send(socket, {
            type: "ROOM_JOINED",
            roomId: room.roomId,
            member: message.member,
            members,
            presenceSessionId
          });
          this.broadcastMembers(room);
          this.traffic.get(socket)!.joined = true;
          if (!this.cloud) console.log(`[rooms] ${message.member.displayName} joined ${room.roomId}`);
          if (this.workspaces.has(room.roomId)) this.sendWorkspace(socket, room);
          break;
        }
        case "LEAVE_ROOM": {
          this.cancelFileRequests((pending) => pending.owner === socket || pending.requester === socket, "File request cancelled because a member left the room");
          const room = this.roomManager.leaveRoom(socket);
          this.clearPresenceSession(socket);
          this.closeDocumentsForClient(socket);
          if (room) {
            this.broadcastMembers(room);
            console.log(`[rooms] client left ${room.roomId}`);
          }
          break;
        }
        case "OPEN_DOCUMENT": {
          if (!this.isClientInRoom(socket, message.roomId)) {
            this.sendError(socket, `Client is not in room ${message.roomId}`);
            return;
          }

          const documentKey = this.getDocumentKey(message.roomId, message.documentPath);
          const opened = this.openDocuments.get(socket) ?? new Map<string, OpenSession>();
          if (!opened.has(documentKey) && opened.size >= 2) {
            this.sendDocumentError(socket, "A member can share at most two open document paths; close one before opening another",
              message.roomId, message.documentPath, message.shareSessionId);
            return;
          }
          let document = this.documents.get(documentKey);
          if (!document) {
            document = { text: message.text, revision: 0, clients: new Set() };
            this.documents.set(documentKey, document);
          }

          const shareSessionId = message.shareSessionId ?? randomUUID();
          opened.set(documentKey, { id: shareSessionId, legacy: message.shareSessionId === undefined, tokenedEdits: false,
            shareId: randomUUID(), cursorSequence: 0, selectionSequence: 0, typingSequence: 0, typingUntil: 0 });
          this.openDocuments.set(socket, opened);
          document.clients.add(socket);
          this.send(socket, {
            type: "DOCUMENT_SYNC",
            roomId: message.roomId,
            documentPath: message.documentPath,
            revision: document.revision,
            text: document.text,
            shareSessionId
          });
          this.broadcastPresence(this.roomManager.getRoomForClient(socket)!);
          this.sendOpenTyping(socket, this.roomManager.getRoomForClient(socket)!, message.documentPath);
          break;
        }
        case "SET_SHARED_FILE": {
          const room = this.roomManager.getRoomForClient(socket);
          const presence = this.presenceSessions.get(socket);
          if (!room || room.roomId !== message.roomId || !presence || presence.id !== message.presenceSessionId) {
            this.sendError(socket, "Shared-file presence belongs to an old or unauthorized room session");
            return;
          }
          if (message.sequence <= presence.sequence) break;
          if (message.documentPath !== null) {
            const document = this.documents.get(this.getDocumentKey(room.roomId, message.documentPath));
            if (!document?.clients.has(socket)) {
              this.sendError(socket, "File is not open for collaboration in this room");
              return;
            }
          }
          presence.sequence = message.sequence;
          const path = message.documentPath ?? undefined;
          if (presence.documentPath !== path) {
            presence.documentPath = path;
            presence.shareId = path ? randomUUID() : undefined;
            presence.cursorSequence = 0;
            presence.selectionSequence = 0;
            presence.typingSequence = 0;
            presence.typingUntil = 0;
            this.broadcastPresence(room);
            if (path) this.sendActiveTyping(socket, room, path);
          }
          break;
        }
        case "CURSOR_UPDATE": {
          const room = this.roomManager.getRoomForClient(socket);
          const presence = this.presenceSessions.get(socket);
          const key = this.getDocumentKey(message.roomId, message.documentPath);
          const openShare = this.openDocuments.get(socket)?.get(key);
          const tokened = openShare?.shareId === message.shareId;
          if (!room || room.roomId !== message.roomId || !presence || presence.id !== message.presenceSessionId
            || (!tokened && (presence.documentPath !== message.documentPath || presence.shareId !== message.shareId))
            || room.clients.get(socket)?.memberId !== presence.memberId) {
            this.sendError(socket, "Cursor update belongs to an old or unauthorized shared-document session");
            break;
          }
          if (message.sequence <= (tokened ? openShare!.cursorSequence : presence.cursorSequence)) break;
          if (tokened) openShare!.cursorSequence = message.sequence;
          else presence.cursorSequence = message.sequence;
          for (const [peer, member] of room.clients) {
            if (peer === socket) continue;
            const peerSession = this.presenceSessions.get(peer);
            const peerOpen = this.openDocuments.get(peer)?.get(key);
            if (peerSession?.id && peerOpen) {
              this.send(peer, { ...message, presenceSessionId: peerSession.id, memberId: presence.memberId,
                recipientShareSessionId: peerOpen.id });
            }
          }
          break;
        }
        case "SELECTION_UPDATE": {
          const room = this.roomManager.getRoomForClient(socket);
          const presence = this.presenceSessions.get(socket);
          const key = this.getDocumentKey(message.roomId, message.documentPath);
          const openShare = this.openDocuments.get(socket)?.get(key);
          const tokened = openShare?.shareId === message.shareId;
          if (!room || room.roomId !== message.roomId || !presence || presence.id !== message.presenceSessionId
            || (!tokened && (presence.documentPath !== message.documentPath || presence.shareId !== message.shareId))
            || room.clients.get(socket)?.memberId !== presence.memberId) {
            this.sendError(socket, "Selection update belongs to an old or unauthorized shared-document session");
            break;
          }
          if (message.sequence <= (tokened ? openShare!.selectionSequence : presence.selectionSequence)) break;
          if (tokened) openShare!.selectionSequence = message.sequence;
          else presence.selectionSequence = message.sequence;
          const document = this.documents.get(this.getDocumentKey(room.roomId, message.documentPath));
          if (!document?.clients.has(socket) || (message.ranges.length > 0 && document.revision !== message.documentRevision)) break;
          if (message.ranges.length > 0) {
            const lines = document.text.split("\n");
            const insideText = (position: { line: number; character: number }) => position.line < lines.length
              && position.character <= lines[position.line].length;
            if (message.ranges.some((range) => !insideText(range.start) || !insideText(range.end))) break;
          }
          for (const peer of room.clients.keys()) {
            if (peer === socket) continue;
            const peerSession = this.presenceSessions.get(peer);
            const peerOpen = this.openDocuments.get(peer)?.get(key);
            if (peerSession?.id && peerOpen) {
              this.send(peer, { ...message, presenceSessionId: peerSession.id, memberId: presence.memberId,
                recipientShareSessionId: peerOpen.id });
            }
          }
          break;
        }
        case "TYPING_ACTIVITY": {
          const room = this.roomManager.getRoomForClient(socket);
          const presence = this.presenceSessions.get(socket);
          const document = this.documents.get(this.getDocumentKey(message.roomId, message.documentPath));
          const key = this.getDocumentKey(message.roomId, message.documentPath);
          const openShare = this.openDocuments.get(socket)?.get(key);
          const tokened = openShare?.shareId === message.shareId;
          if (!room || room.roomId !== message.roomId || !presence || presence.id !== message.presenceSessionId
            || (!tokened && (presence.documentPath !== message.documentPath || presence.shareId !== message.shareId))
            || room.clients.get(socket)?.memberId !== presence.memberId || !document?.clients.has(socket)) {
            this.send(socket, { type: "TYPING_REJECTED", message: "Typing activity belongs to an old or unauthorized shared-document session" });
            break;
          }
          if (message.sequence <= (tokened ? openShare!.typingSequence : presence.typingSequence)) break;
          if (tokened) { openShare!.typingSequence = message.sequence; openShare!.typingUntil = message.active ? Date.now() + TYPING_LEASE_MS : 0; }
          else { presence.typingSequence = message.sequence; presence.typingUntil = message.active ? Date.now() + TYPING_LEASE_MS : 0; }
          for (const peer of room.clients.keys()) {
            if (peer === socket || !document.clients.has(peer)) continue;
            const peerSession = this.presenceSessions.get(peer);
            const peerOpen = this.openDocuments.get(peer)?.get(key);
            if (peerSession?.id && peerOpen) {
              this.send(peer, { ...message, presenceSessionId: peerSession.id, memberId: presence.memberId,
                recipientShareSessionId: peerOpen.id, leaseMs: message.active ? TYPING_LEASE_MS : 0 });
            }
          }
          break;
        }
        case "SHARE_WORKSPACE":
        case "END_WORKSPACE": {
          const room = this.roomManager.getRoomForClient(socket);
          if (!room || room.roomId !== message.roomId) throw new WorkspaceRequestError("Client is not in the manifest room");
          const current = this.workspaces.get(room.roomId);
          if (current && current.owner !== socket) throw new WorkspaceRequestError("Only the member sharing the workspace can replace or end its manifest");
          let changes: WorkspaceChanges | undefined;
          if (message.type === "SHARE_WORKSPACE" && message.baseManifestId !== undefined) {
            if (!current || current.id !== message.baseManifestId) throw new WorkspaceRequestError("Workspace changed before refresh; refresh the current publication again");
            const before = new Map(current.manifest.files.map((file) => [file.path, file.size]));
            const after = new Map(message.manifest.files.map((file) => [file.path, file.size]));
            const changed = new Set(message.changedPaths);
            if ([...changed].some((path) => !before.has(path) || !after.has(path))) throw new WorkspaceRequestError("Refresh changed paths must exist in both manifests");
            changes = {
              added: [...after.keys()].filter((path) => !before.has(path)).sort(),
              changed: [...after.keys()].filter((path) => before.has(path) && (before.get(path) !== after.get(path) || changed.has(path))).sort(),
              removed: [...before.keys()].filter((path) => !after.has(path)).sort()
            };
          }
          this.cancelFileRequests((pending) => pending.key.roomId === room.roomId, "File request cancelled because workspace sharing ended or the manifest changed");
          if (message.type === "SHARE_WORKSPACE") this.workspaces.set(room.roomId, { owner: socket, manifest: message.manifest, id: randomUUID(), publicationId: message.publicationId ?? null, changes });
          else this.workspaces.delete(room.roomId);
          this.broadcastWorkspace(room);
          break;
        }
        case "FILE_REQUEST": {
          const workspace = this.workspaces.get(message.roomId);
          if (!this.isClientInRoom(socket, message.roomId) || !workspace || !this.isClientInRoom(workspace.owner, message.roomId)) throw new FileTransferError("Unauthorized file request: no shared workspace in this room", message.requestId);
          if (workspace.id !== message.manifestId) throw new FileTransferError("Workspace manifest changed; select the file again", message.requestId);
          const file = workspace.manifest.files.find((entry) => entry.path === message.path);
          if (!file) throw new FileTransferError("File is not listed in the current workspace manifest", message.requestId);
          if (file.size > MAX_FILE_BYTES) throw new FileTransferError("File exceeds the 256 KiB UTF-8 text limit", message.requestId);
          if (this.fileRequests.has(message.requestId)) throw new FileTransferError("Duplicate file request ID", message.requestId);
          const pending = [...this.fileRequests.values()];
          if (pending.some((entry) => entry.requester === socket)) throw new FileTransferError("Only one file request may be pending per member", message.requestId);
          if (pending.filter((entry) => entry.key.roomId === message.roomId).length >= MAX_ROOM_FILE_REQUESTS) throw new FileTransferError("Room reached the 16 pending file-request limit", message.requestId);
          const timer = setTimeout(() => this.failFileRequest(message.requestId, "File request timed out; try again"), this.options.fileRequestTimeoutMs ?? FILE_REQUEST_TIMEOUT_MS);
          timer.unref();
          const key = { requestId: message.requestId, roomId: message.roomId, manifestId: message.manifestId, path: message.path };
          this.fileRequests.set(message.requestId, { key, requester: socket, owner: workspace.owner, timer });
          this.send(workspace.owner, message);
          break;
        }
        case "FILE_RESPONSE":
        case "FILE_FAILURE": {
          const pending = this.fileRequests.get(message.requestId);
          const workspace = this.workspaces.get(message.roomId);
          if (!pending || pending.owner !== socket || !sameFileRequest(pending.key, message)
            || workspace?.owner !== socket || workspace.id !== message.manifestId
            || !this.isClientInRoom(socket, message.roomId) || !this.isClientInRoom(pending.requester, message.roomId)) {
            throw new FileTransferError("Unsolicited or unauthorized file response", message.requestId);
          }
          if (message.type === "FILE_FAILURE") this.failFileRequest(message.requestId, message.message);
          else {
            const file = workspace.manifest.files.find((entry) => entry.path === message.path);
            if (!file || Buffer.byteLength(message.text, "utf8") !== file.size) {
              this.failFileRequest(message.requestId, "File response differs from the published size; re-share the workspace");
              break;
            }
            clearTimeout(pending.timer);
            this.fileRequests.delete(message.requestId);
            this.send(pending.requester, message);
          }
          break;
        }
        case "FILE_CANCEL": {
          const pending = this.fileRequests.get(message.requestId);
          if (!pending) break;
          if (pending.requester !== socket || !sameFileRequest(pending.key, message)) throw new FileTransferError("Unauthorized file cancellation", message.requestId);
          this.failFileRequest(message.requestId, "File request cancelled by requester");
          break;
        }
        case "DOCUMENT_EDIT": {
          if (!this.isClientInRoom(socket, message.roomId)) {
            this.sendError(socket, `Client is not in room ${message.roomId}`);
            return;
          }

          const document = this.documents.get(this.getDocumentKey(message.roomId, message.documentPath));
          const openSession = this.openDocuments.get(socket)?.get(this.getDocumentKey(message.roomId, message.documentPath));
          if (!document || !document.clients.has(socket) || !openSession) {
            this.sendDocumentError(socket, `Document ${message.documentPath} is not open for collaboration`,
              message.roomId, message.documentPath, message.shareSessionId);
            return;
          }
          if (message.shareSessionId ? message.shareSessionId !== openSession.id : openSession.tokenedEdits) {
            this.sendDocumentError(socket, `Document ${message.documentPath} edit belongs to an older share session`,
              message.roomId, message.documentPath, message.shareSessionId);
            return;
          }
          if (message.shareSessionId) openSession.tokenedEdits = true;

          if (message.baseRevision !== document.revision) {
            if (!this.cloud) console.warn(`[sync] DOCUMENT_CONFLICT room=${message.roomId} path=${message.documentPath} session=${this.presenceSessions.get(socket)?.id ?? "none"} baseRevision=${message.baseRevision} currentRevision=${document.revision}`);
            this.send(socket, {
              type: "DOCUMENT_CONFLICT",
              roomId: message.roomId,
              documentPath: message.documentPath,
              revision: document.revision,
              text: document.text,
              shareSessionId: openSession.id
            });
            return;
          }

          document.revision += 1;
          document.text = message.text;
          if (!this.cloud) console.log(`[sync] accepted DOCUMENT_EDIT room=${message.roomId} path=${message.documentPath} session=${this.presenceSessions.get(socket)?.id ?? "none"} baseRevision=${message.baseRevision} revision=${document.revision} members=${document.clients.size}`);
          this.send(socket, {
            type: "DOCUMENT_ACK",
            roomId: message.roomId,
            documentPath: message.documentPath,
            revision: document.revision,
            shareSessionId: openSession.id
          });
          for (const client of document.clients) {
            if (client !== socket) {
              this.send(client, {
                type: "DOCUMENT_EDIT",
                roomId: message.roomId,
                documentPath: message.documentPath,
                revision: document.revision,
                text: document.text,
                shareSessionId: this.openDocuments.get(client)?.get(this.getDocumentKey(message.roomId, message.documentPath))?.id
              });
            }
          }
          break;
        }
        case "CLOSE_DOCUMENT": {
          if (!this.isClientInRoom(socket, message.roomId)) return;
          const key = this.getDocumentKey(message.roomId, message.documentPath);
          const opened = this.openDocuments.get(socket);
          const currentSession = opened?.get(key);
          if (!currentSession || (message.shareSessionId ? message.shareSessionId !== currentSession.id : !currentSession.legacy)) return;
          opened!.delete(key);
          if (opened!.size === 0) this.openDocuments.delete(socket);
          const document = this.documents.get(key);
          document?.clients.delete(socket);
          if (document?.clients.size === 0) this.documents.delete(key);
          const presence = this.presenceSessions.get(socket);
          if (presence?.documentPath === message.documentPath) {
            presence.documentPath = undefined;
            presence.shareId = undefined;
            presence.cursorSequence = 0;
            presence.selectionSequence = 0;
            presence.typingSequence = 0;
            presence.typingUntil = 0;
            const room = this.roomManager.getRoomForClient(socket);
          }
          const room = this.roomManager.getRoomForClient(socket);
          if (room) this.broadcastPresence(room);
          break;
        }
      }
    } catch (error) {
      const message = this.cloud ? "Request rejected; invitation or session may be invalid, expired, used or revoked" : error instanceof Error ? error.message : "Unknown server error";
      const traffic = this.traffic.get(socket);
      if (!this.cloud || (traffic && ++traffic.errors <= 3)) console.error("[ws] message handling error", message);
      if (this.cloud && traffic && traffic.errors >= 10) { socket.close(1008, "Too many rejected requests"); return; }
      if (error instanceof FileTransferError) {
        const pending = this.fileRequests.get(error.requestId);
        if (error.isResponse && pending?.owner === socket) this.failFileRequest(error.requestId, message);
        this.send(socket, { type: "FILE_ERROR", requestId: error.requestId, message });
      } else if (error instanceof WorkspaceRequestError) this.send(socket, { type: "WORKSPACE_ERROR", message });
      else this.sendError(socket, message);
    }
  }

  private broadcastMembers(room: Room<WebSocket>): void {
    this.cancelFileRequests((pending) => pending.key.roomId === room.roomId
      && (!this.isClientInRoom(pending.owner, room.roomId) || !this.isClientInRoom(pending.requester, room.roomId)),
    "File request cancelled because room membership changed");
    const workspace = this.workspaces.get(room.roomId);
    if (workspace && !this.roomManager.getClients(room).includes(workspace.owner)) {
      this.workspaces.delete(room.roomId);
      this.broadcastWorkspace(room);
    }
    const members = this.roomManager.getMembers(room);
    const message: ServerMessage = {
      type: "MEMBERS_UPDATED",
      roomId: room.roomId,
      members
    };

    for (const client of this.roomManager.getClients(room)) {
      this.send(client, message);
    }
    this.broadcastPresence(room);
    if (!room.clients.size) { this.presenceRevisions.delete(room.roomId); this.cloud?.retireRoom(room.roomId); }
  }

  private startPresenceSession(socket: WebSocket, room: Room<WebSocket>, memberId: string): string {
    const id = randomUUID();
    this.presenceSessions.set(socket, { roomId: room.roomId, memberId, id, sequence: 0, cursorSequence: 0, selectionSequence: 0, typingSequence: 0, typingUntil: 0 });
    if (!this.presenceRevisions.has(room.roomId)) this.presenceRevisions.set(room.roomId, 0);
    return id;
  }

  private clearPresenceSession(socket: WebSocket): void {
    this.presenceSessions.delete(socket);
  }

  private broadcastPresence(room: Room<WebSocket>): void {
    const revision = (this.presenceRevisions.get(room.roomId) ?? 0) + 1;
    this.presenceRevisions.set(room.roomId, revision);
    const files = [...room.clients].flatMap(([socket, member]) => {
      const presence = this.presenceSessions.get(socket);
      return presence?.documentPath && presence.shareId
        ? [{ memberId: member.memberId, documentPath: presence.documentPath, shareId: presence.shareId }] : [];
    });
    const openDocuments = [...room.clients].flatMap(([socket, member]) =>
      [...(this.openDocuments.get(socket) ?? new Map<string, OpenSession>())].map(([key, session]) => ({
        memberId: member.memberId, documentPath: key.slice(room.roomId.length + 1), shareSessionId: session.id
      })));
    const openShares = [...room.clients].flatMap(([socket, member]) =>
      [...(this.openDocuments.get(socket) ?? new Map<string, OpenSession>())].map(([key, session]) => ({
        memberId: member.memberId, documentPath: key.slice(room.roomId.length + 1), shareSessionId: session.id, shareId: session.shareId
      })));
    for (const socket of room.clients.keys()) {
      const presenceSessionId = this.presenceSessions.get(socket)?.id;
      if (presenceSessionId) this.send(socket, { type: "SHARED_FILES", roomId: room.roomId, presenceSessionId, revision, files, openDocuments, openShares });
    }
  }

  private sendActiveTyping(recipient: WebSocket, room: Room<WebSocket>, path: string): void {
    const recipientSession = this.presenceSessions.get(recipient);
    const document = this.documents.get(this.getDocumentKey(room.roomId, path));
    if (!recipientSession?.shareId || !document?.clients.has(recipient)) return;
    for (const [socket, presence] of this.presenceSessions) {
      const leaseMs = presence.typingUntil - Date.now();
      if (socket !== recipient && presence.roomId === room.roomId && presence.documentPath === path
        && presence.shareId && leaseMs > 0 && document.clients.has(socket)) {
        this.send(recipient, { type: "TYPING_ACTIVITY", roomId: room.roomId, documentPath: path,
          presenceSessionId: recipientSession.id, shareId: presence.shareId, memberId: presence.memberId,
          sequence: presence.typingSequence, active: true, leaseMs });
      }
    }
  }

  private sendOpenTyping(recipient: WebSocket, room: Room<WebSocket>, path: string): void {
    const key = this.getDocumentKey(room.roomId, path);
    const recipientPresence = this.presenceSessions.get(recipient);
    const recipientOpen = this.openDocuments.get(recipient)?.get(key);
    if (!recipientPresence || !recipientOpen) return;
    for (const [socket, presence] of this.presenceSessions) {
      if (socket === recipient || presence.roomId !== room.roomId) continue;
      const senderOpen = this.openDocuments.get(socket)?.get(key);
      if (!senderOpen) continue;
      const tokenLease = senderOpen.typingUntil - Date.now();
      const legacyLease = presence.documentPath === path ? presence.typingUntil - Date.now() : 0;
      const leaseMs = Math.max(tokenLease, legacyLease);
      if (leaseMs <= 0) continue;
      this.send(recipient, { type: "TYPING_ACTIVITY", roomId: room.roomId, documentPath: path,
        presenceSessionId: recipientPresence.id, recipientShareSessionId: recipientOpen.id,
        shareId: tokenLease > 0 ? senderOpen.shareId : presence.shareId!, memberId: presence.memberId,
        sequence: tokenLease > 0 ? senderOpen.typingSequence : presence.typingSequence, active: true, leaseMs });
    }
  }

  private sendWorkspace(socket: WebSocket, room: Room<WebSocket>): void {
    const workspace = this.workspaces.get(room.roomId);
    this.send(socket, {
      type: "WORKSPACE_MANIFEST", roomId: room.roomId,
      manifest: workspace?.manifest ?? null, ownedByYou: workspace?.owner === socket, manifestId: workspace?.id ?? null,
      publicationId: workspace?.owner === socket ? workspace.publicationId : null
    });
    if (workspace?.changes) this.send(socket, { type: "WORKSPACE_CHANGES", roomId: room.roomId, manifestId: workspace.id, changes: workspace.changes });
  }

  private broadcastWorkspace(room: Room<WebSocket>): void {
    for (const client of this.roomManager.getClients(room)) this.sendWorkspace(client, room);
  }

  private failFileRequest(requestId: string, message: string): void {
    const pending = this.fileRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.fileRequests.delete(requestId);
    this.send(pending.requester, { type: "FILE_ERROR", requestId, message });
    this.send(pending.owner, { type: "FILE_CANCEL", ...pending.key });
  }

  private cancelFileRequests(predicate: (pending: PendingFile) => boolean, reason: string): void {
    for (const pending of [...this.fileRequests.values()]) {
      if (predicate(pending)) this.failFileRequest(pending.key.requestId, reason);
    }
  }

  private closeDocumentsForClient(socket: WebSocket): void {
    this.openDocuments.delete(socket);
    for (const [key, document] of this.documents) {
      document.clients.delete(socket);
      if (document.clients.size === 0) {
        this.documents.delete(key);
      }
    }
  }

  private isClientInRoom(socket: WebSocket, roomId: string): boolean {
    return this.roomManager.getRoomForClient(socket)?.roomId === roomId;
  }

  private getDocumentKey(roomId: string, documentPath: string): string {
    return `${roomId}:${documentPath}`;
  }

  private sendError(socket: WebSocket, message: string): void {
    this.send(socket, {
      type: "ERROR",
      message
    });
  }

  private sendDocumentError(socket: WebSocket, message: string, roomId: string, documentPath: string, shareSessionId?: string): void {
    this.send(socket, { type: "ERROR", message, roomId, documentPath, shareSessionId });
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (this.cloud && message.type !== "ERROR" && !this.cloud.canReceive(socket)) return;
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (this.cloud && socket.bufferedAmount > 2 * MAX_MESSAGE_BYTES) { socket.terminate(); return; }
    socket.send(JSON.stringify(message));
  }
}
