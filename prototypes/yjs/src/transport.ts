import WebSocket, { WebSocketServer } from "ws";
import { randomBytes, randomUUID } from "node:crypto";
import { BinaryProtocol, type Scope } from "./protocol";
import { PrototypeClient, PrototypeRoom } from "./prototype";

type Control = Record<string, unknown>;
export const EXPERIMENTAL_LIMITS = Object.freeze({
  rooms: 32, grantsPerRoom: 8, pendingSockets: 16, pendingJoinsPerRoom: 4,
  queuedBytesPerSocket: 4 * 1024 * 1024, queuedMessagesPerSocket: 32, queuedBytesGlobal: 32 * 1024 * 1024,
  updatesPerSecond: 64, handshakeMs: 5000
});
interface SocketState { bytes: number; messages: number; timer?: NodeJS.Timeout; windowStart: number; updates: number; incoming: number }
const sameScope = (a: unknown, b: Scope) => {
  const scope = a as Scope | undefined;
  return scope?.roomId === b.roomId && scope.documentPath === b.documentPath && scope.epoch === b.epoch;
};
const canonical = (text: string) => text.replace(/\r\n/g, "\n");

function control(raw: string, protocol: BinaryProtocol): Control {
  if (Buffer.byteLength(raw, "utf8") > protocol.limits.maxMessageBytes) throw new Error("Control exceeds CodeMesh message limit");
  const message: unknown = JSON.parse(raw);
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid CRDT control");
  return message as Control;
}
function fields(message: Control, allowed: string[]): void {
  if (Object.keys(message).some((key) => !allowed.includes(key))) throw new Error("Unsupported CRDT control fields");
}

interface RoomSession {
  model: PrototypeRoom;
  owner: string;
  grants: Set<string>;
  members: Map<WebSocket, { token: string; joined: boolean }>;
  recoveryId?: string;
  proposal?: { id: string; text: string; approvals: Set<string> };
}

export class ExperimentalServer {
  private readonly server: WebSocketServer;
  private readonly rooms = new Map<string, RoomSession>();
  private readonly grants = new Map<string, RoomSession>();
  private readonly bindings = new Map<WebSocket, RoomSession>();
  private readonly sockets = new Map<WebSocket, SocketState>();

  constructor(private readonly protocol: BinaryProtocol, port = 0) {
    this.server = new WebSocketServer({ port, host: "127.0.0.1", maxPayload: protocol.limits.maxMessageBytes });
    this.server.on("connection", (socket) => {
      if ([...this.sockets.keys()].filter((peer) => !this.bindings.has(peer)).length >= EXPERIMENTAL_LIMITS.pendingSockets) { socket.terminate(); return; }
      const state: SocketState = { bytes: 0, messages: 0, windowStart: Date.now(), updates: 0, incoming: 0 };
      this.sockets.set(socket, state); this.arm(socket);
      socket.on("message", (raw, binary) => {
        const room = this.bindings.get(socket);
        const now = Date.now();
        if (now - state.windowStart >= 1000) { state.windowStart = now; state.updates = 0; state.incoming = 0; }
        if (++state.incoming > 128) { if (room && !room.recoveryId) this.pause(room, "CRDT inbound message rate limit reached; explicit recovery required"); socket.terminate(); return; }
        try { if (binary) this.binary(socket, room, raw as Buffer); else this.message(socket, room, control(raw.toString(), protocol)); }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (room && /CRDT (text|frame) exceeds CodeMesh/.test(reason)) this.pause(room, reason);
          else this.send(socket, { type: "ERROR", scope: room?.model.scope, reason: reason.slice(0, 256) });
        }
      });
      socket.on("close", () => this.leave(socket));
      socket.on("error", () => undefined);
    });
  }

  async listening(): Promise<string> {
    if (!this.server.address()) await new Promise<void>((resolve, reject) => { this.server.once("listening", resolve); this.server.once("error", reject); });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Experimental server did not bind");
    return "ws://127.0.0.1:" + address.port;
  }

  createRoom(roomId: string, path: string, text: string): { ownerToken: string; memberToken: string } {
    if (this.rooms.has(roomId)) throw new Error("Experimental room already exists");
    if (this.rooms.size >= EXPERIMENTAL_LIMITS.rooms) throw new Error("Experimental room limit reached");
    const owner = randomBytes(32).toString("hex"), member = randomBytes(32).toString("hex");
    const room: RoomSession = { model: new PrototypeRoom(roomId, path, this.protocol, text), owner, grants: new Set([owner, member]), members: new Map() };
    this.rooms.set(roomId, room); this.grants.set(owner, room); this.grants.set(member, room);
    return { ownerToken: owner, memberToken: member };
  }
  grantMember(roomId: string): string {
    const room = this.rooms.get(roomId); if (!room) throw new Error("Room does not exist");
    if (room.grants.size >= EXPERIMENTAL_LIMITS.grantsPerRoom) throw new Error("Experimental room capability limit reached");
    const token = randomBytes(32).toString("hex"); room.grants.add(token); this.grants.set(token, room); return token;
  }
  getStatus(roomId: string): { active: boolean; paused: boolean; members: number; pendingJoins: number; grants: number; text?: string; scope?: Scope } {
    const room = this.rooms.get(roomId);
    return { active: Boolean(room), paused: Boolean(room?.recoveryId), members: room?.members.size ?? 0,
      pendingJoins: [...(room?.members.values() ?? [])].filter((member) => !member.joined).length,
      grants: room?.grants.size ?? 0, text: room?.model.getText(), scope: room?.model.scope };
  }

  getResources(): { rooms: number; sockets: number; pendingSockets: number; queuedBytes: number; queuedMessages: number } {
    const states = [...this.sockets.values()];
    return { rooms: this.rooms.size, sockets: states.length, pendingSockets: [...this.sockets.keys()].filter((socket) => !this.bindings.has(socket)).length,
      queuedBytes: [...this.sockets].reduce((total, [socket, state]) => total + Math.max(state.bytes, socket.bufferedAmount), 0),
      queuedMessages: states.reduce((total, state) => total + state.messages, 0) };
  }

  private arm(socket: WebSocket): void {
    const state = this.sockets.get(socket); if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => socket.terminate(), EXPERIMENTAL_LIMITS.handshakeMs);
    state.timer.unref();
  }
  private clearTimer(socket: WebSocket): void {
    const state = this.sockets.get(socket);
    if (state?.timer) clearTimeout(state.timer);
    if (state) state.timer = undefined;
  }
  private sendFrame(socket: WebSocket, data: string | Uint8Array, binary = false): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const state = this.sockets.get(socket); if (!state) return false;
    const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    if (bytes > this.protocol.limits.maxMessageBytes) throw new Error("CRDT frame exceeds CodeMesh message limit");
    if (state.messages >= EXPERIMENTAL_LIMITS.queuedMessagesPerSocket ||
      state.bytes + bytes > EXPERIMENTAL_LIMITS.queuedBytesPerSocket ||
      socket.bufferedAmount + bytes > EXPERIMENTAL_LIMITS.queuedBytesPerSocket ||
      this.getResources().queuedBytes + bytes > EXPERIMENTAL_LIMITS.queuedBytesGlobal) {
      // The room retains accepted updates. A fresh state-vector join repairs this peer.
      socket.terminate(); return false;
    }
    state.messages++; state.bytes += bytes;
    socket.send(data, { binary }, (error) => {
      state.messages--; state.bytes -= bytes;
      if (error) socket.terminate();
    });
    return true;
  }

  private send(socket: WebSocket, message: Control): void {
    const data = JSON.stringify(message);
    if (Buffer.byteLength(data, "utf8") > this.protocol.limits.maxMessageBytes) throw new Error("Control exceeds CodeMesh message limit");
    this.sendFrame(socket, data);
  }
  private broadcast(room: RoomSession, message: Control): void { for (const socket of room.members.keys()) this.send(socket, message); }
  private pause(room: RoomSession, reason: string): void {
    room.recoveryId ??= randomUUID();
    for (const socket of room.members.keys()) this.clearTimer(socket);
    this.broadcast(room, { type: "PAUSED", scope: room.model.scope, recoveryId: room.recoveryId, proposalId: room.proposal?.id ?? null, reason });
  }

  private binary(socket: WebSocket, room: RoomSession | undefined, frame: Uint8Array): void {
    if (!room) throw new Error("Unauthorized CRDT binary frame");
    const member = room.members.get(socket)!;
    if (room.recoveryId) return;
    let vector = false;
    try { this.protocol.decode(room.model.scope, frame, "STATE_VECTOR"); vector = true; }
    catch { this.protocol.decode(room.model.scope, frame, "UPDATE"); }
    if (vector) {
      const response = member.joined ? room.model.sync(member.token, frame) : room.model.join(member.token, frame);
      member.joined = true; this.clearTimer(socket); this.sendFrame(socket, response, true);
      this.send(socket, { type: "READY", scope: room.model.scope });
    } else {
      if (!member.joined) throw new Error("Complete state-vector exchange before updates");
      const state = this.sockets.get(socket)!;
      if (++state.updates > EXPERIMENTAL_LIMITS.updatesPerSecond) { this.pause(room, "CRDT update rate limit reached; explicit recovery required"); return; }
      for (const packet of room.model.receive(member.token, frame)) {
        const target = [...room.members].find(([, entry]) => entry.token === packet.memberId)?.[0];
        if (target?.readyState === WebSocket.OPEN) this.sendFrame(target, packet.frame, true);
      }
    }
  }

  private message(socket: WebSocket, room: RoomSession | undefined, message: Control): void {
    if (!room) {
      fields(message, ["type", "token", "roomId", "documentPath"]);
      if (message.type !== "HELLO" || typeof message.token !== "string") throw new Error("Authorize the experimental room first");
      const granted = this.grants.get(message.token);
      if (!granted || granted.model.scope.roomId !== message.roomId || granted.model.scope.documentPath !== message.documentPath
        || [...granted.members.values()].some((member) => member.token === message.token)) throw new Error("Unauthorized room/document or token already connected");
      if (granted.members.size >= EXPERIMENTAL_LIMITS.grantsPerRoom) throw new Error("Experimental room member limit reached");
      if (!granted.recoveryId && [...granted.members.values()].filter((member) => !member.joined).length >= EXPERIMENTAL_LIMITS.pendingJoinsPerRoom) throw new Error("Experimental pending join limit reached");
      granted.members.set(socket, { token: message.token, joined: false }); this.bindings.set(socket, granted);
      this.arm(socket);
      this.send(socket, { type: "SCOPE", scope: granted.model.scope });
      if (granted.recoveryId) { granted.proposal = undefined; this.pause(granted, "Recovery membership changed; propose and approve again"); }
      return;
    }
    const allowed: Record<string, string[]> = {
      LEAVE: ["type", "scope"], PAUSE: ["type", "scope"],
      RECOVER_PROPOSE: ["type", "scope", "recoveryId", "text"],
      RECOVER_APPROVE: ["type", "scope", "recoveryId", "proposalId"]
    };
    if (typeof message.type !== "string" || !allowed[message.type]) throw new Error("Unsupported experimental control");
    fields(message, allowed[message.type]);
    if (!sameScope(message.scope, room.model.scope)) throw new Error("Control does not match room, document and epoch");
    if (message.type === "LEAVE") { this.leave(socket); socket.close(1000); return; }
    if (message.type === "PAUSE") { this.pause(room, "A replica rejected a merged update; explicit recovery required"); return; }
    if (!room.recoveryId || message.recoveryId !== room.recoveryId) throw new Error("No matching recovery session");
    const member = room.members.get(socket)!;
    if (message.type === "RECOVER_PROPOSE") {
      if (member.token !== room.owner || typeof message.text !== "string") throw new Error("Only the owner can propose recovery text");
      if (canonical(message.text) !== message.text || Buffer.byteLength(message.text, "utf8") > this.protocol.limits.maxDocumentBytes) throw new Error("Recovery text must be LF and within the document limit");
      room.proposal = { id: randomUUID(), text: message.text, approvals: new Set() };
      this.broadcast(room, { type: "RECOVERY_PROPOSAL", scope: room.model.scope, recoveryId: room.recoveryId, proposalId: room.proposal.id, text: message.text });
    } else if (message.type === "RECOVER_APPROVE") {
      const proposal = room.proposal;
      if (!proposal || message.proposalId !== proposal.id) throw new Error("Stale or missing recovery proposal");
      proposal.approvals.add(member.token);
      if ([...room.members.values()].some((entry) => !proposal.approvals.has(entry.token))) return;
      const oldScope = room.model.scope;
      const replacement = new PrototypeRoom(oldScope.roomId, oldScope.documentPath, this.protocol, proposal.text);
      room.model.dispose(); room.model = replacement; room.recoveryId = undefined; room.proposal = undefined;
      for (const [peer, entry] of room.members) {
        entry.joined = false;
        const state = this.sockets.get(peer);
        if (state && (state.messages || state.bytes || peer.bufferedAmount)) { peer.terminate(); continue; }
        if (state) { state.windowStart = Date.now(); state.updates = 0; state.incoming = 0; }
        this.arm(peer);
        this.send(peer, { type: "RESET", scope: oldScope, nextScope: replacement.scope, proposalId: proposal.id });
      }
    } else throw new Error("Unsupported experimental control");
  }

  private leave(socket: WebSocket): void {
    this.clearTimer(socket); this.sockets.delete(socket);
    const room = this.bindings.get(socket); if (!room) return;
    const member = room.members.get(socket)!;
    this.bindings.delete(socket); room.members.delete(socket);
    // A changed recovery quorum must be explicitly proposed and approved again.
    if (room.proposal) { room.proposal = undefined; this.pause(room, "Recovery membership changed; propose again"); }
    room.model.leave(member.token, true);
    if (!room.members.size) {
      room.model.dispose(); this.rooms.delete(room.model.scope.roomId);
      for (const grant of room.grants) this.grants.delete(grant);
    }
  }
  async dispose(): Promise<void> {
    for (const state of this.sockets.values()) if (state.timer) clearTimeout(state.timer);
    for (const socket of this.server.clients) socket.terminate();
    for (const room of this.rooms.values()) room.model.dispose();
    this.rooms.clear(); this.grants.clear(); this.bindings.clear(); this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export class ExperimentalClient {
  private socket: WebSocket | undefined;
  model: PrototypeClient | undefined;
  status: "disconnected" | "syncing" | "active" | "paused" = "disconnected";
  draft: string | undefined;
  recoveryId: string | undefined;
  proposal: { id: string; text: string } | undefined;
  readonly errors: string[] = [];
  readonly controls: Control[] = [];
  sentUpdates = 0;
  private readonly pauseListeners = new Set<() => void>();
  private approvedProposalId: string | undefined;
  private queuedBytes = 0;
  private queuedMessages = 0;

  constructor(private readonly protocol: BinaryProtocol) {}
  onPause(listener: () => void): { dispose(): void } { this.pauseListeners.add(listener); return { dispose: () => { this.pauseListeners.delete(listener); } }; }
  private pause(reason: string): void {
    if (this.status !== "paused" && this.model?.getStatus().ready) this.draft = this.model.getText();
    this.status = "paused"; this.model?.suspend(); this.errors.push(reason);
    for (const listener of this.pauseListeners) listener();
  }
  private json(message: Control): void {
    const raw = JSON.stringify(message);
    if (Buffer.byteLength(raw, "utf8") > this.protocol.limits.maxMessageBytes) throw new Error("Control exceeds CodeMesh message limit");
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Experimental socket is disconnected");
    this.sendFrame(raw);
  }
  private sendFrame(frame: string | Uint8Array, binary = false): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Experimental socket is disconnected");
    const bytes = typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.byteLength;
    if (bytes > this.protocol.limits.maxMessageBytes) throw new Error("CRDT frame exceeds CodeMesh message limit");
    if (this.queuedMessages >= EXPERIMENTAL_LIMITS.queuedMessagesPerSocket ||
      this.queuedBytes + bytes > EXPERIMENTAL_LIMITS.queuedBytesPerSocket ||
      socket.bufferedAmount + bytes > EXPERIMENTAL_LIMITS.queuedBytesPerSocket) {
      this.pause("CRDT outgoing queue limit reached; keep the local draft and explicitly rejoin");
      socket.terminate(); return false;
    }
    this.queuedBytes += bytes; this.queuedMessages++;
    socket.send(frame, { binary }, (error) => {
      if (this.socket === socket) { this.queuedBytes -= bytes; this.queuedMessages--; }
      if (error && this.socket === socket) {
        this.pause("CRDT send failed; keep the local draft and explicitly rejoin");
        socket.terminate();
      }
    });
    return true;
  }
  async connect(url: string, token: string, roomId: string, documentPath: string): Promise<void> {
    if (this.socket) throw new Error("Dispose or disconnect before explicit reconnect");
    this.status = "syncing";
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { maxPayload: this.protocol.limits.maxMessageBytes }); this.socket = socket;
      const timeout = setTimeout(() => { reject(new Error("Experimental handshake timed out")); socket.close(); }, 5000);
      const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
      socket.on("open", () => {
        try { this.json({ type: "HELLO", token, roomId, documentPath }); }
        catch (error) { fail(new Error(String(error))); socket.close(); }
      });
      socket.on("message", (raw, binary) => {
        try {
          if (binary) {
            if (!this.model) throw new Error("Unsolicited CRDT update");
            if (this.status !== "paused") this.model.receive(raw as Buffer);
            return;
          }
          const message = control(raw.toString(), this.protocol); this.controls.push(message);
          if (message.type === "SCOPE" || message.type === "RESET") {
            if (message.type === "SCOPE" && (this.model || this.status !== "syncing")) throw new Error("Unsolicited CRDT scope reset");
            const scope = (message.type === "SCOPE" ? message.scope : message.nextScope) as Scope;
            this.protocol.validateScope(scope);
            if (scope.roomId !== roomId || scope.documentPath !== documentPath) throw new Error("Server changed authorized scope");
            if (message.type === "RESET" && (!this.model || !sameScope(message.scope, this.model.scope) || message.proposalId !== this.proposal?.id || message.proposalId !== this.approvedProposalId)) throw new Error("Unapproved recovery reset");
            if (message.type === "RESET" && (this.queuedMessages || socket.bufferedAmount)) {
              this.pause("Old-epoch updates are still queued; keep the local draft and explicitly rejoin");
              socket.terminate(); return;
            }
            this.model?.dispose(); this.status = "syncing";
            if (message.type === "RESET") { this.recoveryId = undefined; this.proposal = undefined; this.approvedProposalId = undefined; }
            this.model = new PrototypeClient(scope, this.protocol, (frame) => {
              if (this.status !== "active" || socket.readyState !== WebSocket.OPEN) throw new Error("CRDT session is not active");
              if (this.sendFrame(frame, true)) this.sentUpdates += 1;
            });
            this.sendFrame(this.model.stateVectorFrame(), true);
          } else if (message.type === "ERROR") {
            const reason = String(message.reason); this.errors.push(reason);
            if (this.status === "syncing") { fail(new Error(reason)); socket.close(); }
          } else {
            if (!this.model || !sameScope(message.scope, this.model.scope)) throw new Error("Unscoped server control");
            if (message.type === "READY") {
              if (!this.model.getStatus().ready) throw new Error("Ready before state sync");
              this.status = "active"; clearTimeout(timeout); resolve();
            } else if (message.type === "PAUSED") {
              const wasSyncing = this.status === "syncing";
              this.recoveryId = String(message.recoveryId);
              if (message.proposalId !== this.proposal?.id) { this.proposal = undefined; this.approvedProposalId = undefined; }
              this.pause(String(message.reason));
              if (wasSyncing) { clearTimeout(timeout); resolve(); }
            } else if (message.type === "RECOVERY_PROPOSAL") {
              if (message.recoveryId !== this.recoveryId || typeof message.text !== "string" || Buffer.byteLength(message.text, "utf8") > this.protocol.limits.maxDocumentBytes) throw new Error("Invalid recovery proposal");
              this.proposal = { id: String(message.proposalId), text: message.text };
              this.approvedProposalId = undefined;
            } else throw new Error("Unsupported server control");
          }
        } catch (error) {
          const syncing = this.status === "syncing";
          this.pause(String(error));
          if (this.model && socket.readyState === WebSocket.OPEN) this.json({ type: "PAUSE", scope: this.model.scope });
          if (syncing) { fail(new Error(String(error))); socket.close(); }
        }
      });
      socket.on("error", fail);
      socket.on("close", () => {
        clearTimeout(timeout);
        if (this.model) { this.draft ??= this.model.getText(); this.model.dispose(); this.model = undefined; }
        this.queuedBytes = 0; this.queuedMessages = 0;
        if (this.status === "active") this.errors.push("Transport disconnected; keep the local draft and explicitly rejoin with a state vector");
        this.socket = undefined; this.status = "disconnected"; fail(new Error("Experimental socket closed"));
      });
    });
  }
  insert(offset: number, text: string): void { if (this.status !== "active") throw new Error("Explicit recovery or re-share required"); this.model!.insert(offset, text); }
  delete(offset: number, count: number): void { if (this.status !== "active") throw new Error("Explicit recovery or re-share required"); this.model!.delete(offset, count); }
  proposeRecovery(text: string): void { this.json({ type: "RECOVER_PROPOSE", scope: this.model?.scope, recoveryId: this.recoveryId, text }); }
  approveRecovery(): void {
    if (!this.proposal) throw new Error("Choose a recovery proposal explicitly first");
    this.approvedProposalId = this.proposal.id;
    this.json({ type: "RECOVER_APPROVE", scope: this.model?.scope, recoveryId: this.recoveryId, proposalId: this.proposal.id });
  }
  duplicate(frame: Uint8Array): void { if (!this.socket || this.status !== "active") throw new Error("Not active"); this.sendFrame(frame, true); }
  disconnect(): void {
    if (this.model) { this.draft ??= this.model.getText(); this.model.dispose(); this.model = undefined; }
    this.status = "disconnected"; this.socket?.terminate();
  }
  dispose(): void { this.disconnect(); this.pauseListeners.clear(); }
}
