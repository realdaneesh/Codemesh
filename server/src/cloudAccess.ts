import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";
import type { Member } from "./types/protocol";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
interface Identity { roomId: string; member: Member; host: boolean; expires: number; socket?: WebSocket }

/** Cloud-only admission. Credentials never enter the legacy message parser or logs. */
export class CloudAccess {
  private readonly sessions = new Map<string, Identity>();
  private readonly connections = new Map<WebSocket, Identity>();
  private readonly invites = new Map<string, { roomId: string; expires: number }>();
  constructor(private readonly hostKey: string, private readonly roomFor: (socket: WebSocket) => string | undefined,
    private readonly roomSize: (room: string) => number, private readonly inviteTtl = 300_000) {
    if (Buffer.byteLength(hostKey) < 32) throw new Error("Cloud mode requires CODEMESH_HOST_KEY of at least 32 bytes");
  }
  private send(socket: WebSocket, value: object): void { socket.send(JSON.stringify(value)); }
  canReceive(socket: WebSocket): boolean {
    const identity = this.connections.get(socket);
    return Boolean(identity && identity.socket === socket && identity.expires > Date.now() && this.roomFor(socket) === identity.roomId);
  }
  sweep(): void { this.prune(); }
  member(socket: WebSocket): Member { return this.connections.get(socket)!.member; }
  bindCreated(socket: WebSocket, roomId: string): void { this.connections.get(socket)!.roomId = roomId; }
  private prune(): void {
    for (const [key, value] of this.invites) if (value.expires <= Date.now()) this.invites.delete(key);
    for (const [key, value] of this.sessions) if (value.expires <= Date.now()) {
      value.socket?.close(1008, "Session expired"); this.sessions.delete(key);
    }
  }
  disconnect(socket: WebSocket): void {
    const identity = this.connections.get(socket);
    if (identity?.socket === socket) identity.socket = undefined;
    this.connections.delete(socket);
  }
  retireRoom(roomId: string): void {
    for (const [key, value] of this.sessions) if (value.roomId === roomId) {
      this.sessions.delete(key); value.expires = 0;
      if (value.socket) this.connections.delete(value.socket);
    }
    for (const [key, value] of this.invites) if (value.roomId === roomId) this.invites.delete(key);
  }
  created(socket: WebSocket, roomId: string): void {
    const identity = this.connections.get(socket)!;
    identity.roomId = roomId;
    this.invite(socket);
  }
  private invite(socket: WebSocket): void {
    const identity = this.connections.get(socket);
    if (!identity?.host || this.roomFor(socket) !== identity.roomId) throw new Error("Admission rejected");
    // One outstanding invitation per room; reissuing revokes the previous link.
    for (const [key, value] of this.invites) if (value.roomId === identity.roomId) this.invites.delete(key);
    const token = secret(); const expires = Date.now() + this.inviteTtl;
    this.invites.set(digest(token), { roomId: identity.roomId, expires });
    this.send(socket, { type: "INVITATION", roomId: identity.roomId, token, expires });
  }
  filter(socket: WebSocket, raw: string): string | undefined {
    this.prune();
    const message = JSON.parse(raw);
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Admission rejected");
    const identity = this.connections.get(socket);
    if (["AUTH_CREATE", "AUTH_JOIN", "AUTH_RESUME"].includes(message.type)) {
      if (identity || (message.type !== "AUTH_RESUME" && this.sessions.size >= 256)) throw new Error("Admission rejected");
      let next: Identity;
      let type: "CREATE_ROOM" | "JOIN_ROOM" = "JOIN_ROOM";
      if (message.type === "AUTH_RESUME") {
        if (typeof message.credential !== "string") throw new Error("Admission rejected");
        const previous = this.sessions.get(digest(message.credential));
        if (!previous || previous.socket || previous.expires <= Date.now() || this.roomSize(previous.roomId) === 0) throw new Error("Admission rejected");
        if ([...this.sessions.values()].some(s => s !== previous && s.socket && s.roomId === previous.roomId && s.member.displayName.toLowerCase() === previous.member.displayName.toLowerCase())) throw new Error("Admission rejected");
        next = previous;
        this.sessions.delete(digest(message.credential));
      } else {
        const displayName = typeof message.displayName === "string" ? message.displayName.trim().slice(0, 64) : "";
        if (!displayName || /[\x00-\x1f\[\]\u202a-\u202e\u2066-\u2069]/.test(displayName)) throw new Error("Admission rejected");
        next = { roomId: "", member: { memberId: randomUUID(), displayName }, host: false, expires: Date.now() + 8 * 60 * 60_000 };
        if (message.type === "AUTH_CREATE") {
          if (typeof message.key !== "string" || !timingSafeEqual(Buffer.from(digest(message.key)), Buffer.from(digest(this.hostKey)))) throw new Error("Admission rejected");
          if ([...this.sessions.values()].filter(s => s.host).length >= 32) throw new Error("Relay capacity reached");
          next.host = true; next.member.role = "host"; type = "CREATE_ROOM";
        } else {
          if (typeof message.token !== "string") throw new Error("Admission rejected");
          const invitation = this.invites.get(digest(message.token));
          if (!invitation || invitation.expires <= Date.now() || this.roomSize(invitation.roomId) === 0 || this.roomSize(invitation.roomId) >= 8) throw new Error("Admission rejected");
          if ([...this.sessions.values()].some(s => s.socket && s.roomId === invitation.roomId && s.member.displayName.toLowerCase() === displayName.toLowerCase())) throw new Error("Admission rejected");
          next.roomId = invitation.roomId; next.member.role = "guest";
          this.invites.delete(digest(message.token));
        }
      }
      if (type === "JOIN_ROOM" && this.roomSize(next.roomId) >= 8) throw new Error("Relay capacity reached");
      next.socket = socket; this.connections.set(socket, next);
      const credential = secret(); this.sessions.set(digest(credential), next);
      this.send(socket, { type: "AUTH_SESSION", credential });
      return JSON.stringify({ type, member: next.member, roomId: next.roomId });
    }
    if (!identity || identity.expires <= Date.now() || identity.socket !== socket || this.roomFor(socket) !== identity.roomId) throw new Error("Admission rejected");
    if (message.type === "CREATE_ROOM" || message.type === "JOIN_ROOM") throw new Error("Invitation required");
    if (message.roomId !== undefined && message.roomId !== identity.roomId) throw new Error("Admission rejected");
    if (message.memberId !== undefined && message.memberId !== identity.member.memberId) throw new Error("Admission rejected");
    if (message.type === "CREATE_INVITE") { this.invite(socket); return; }
    if (message.type === "REVOKE_INVITES") {
      if (!identity.host) throw new Error("Admission rejected");
      for (const [key, value] of this.invites) if (value.roomId === identity.roomId) this.invites.delete(key);
      return;
    }
    if (message.type === "LEAVE_ROOM") {
      for (const [key, value] of this.sessions) if (value === identity) this.sessions.delete(key);
      // Ending a host session revokes every credential and disconnects its guests.
      if (identity.host) {
        for (const [key, value] of this.sessions) if (value.roomId === identity.roomId) {
          this.sessions.delete(key); value.expires = 0;
          if (value.socket) this.connections.delete(value.socket);
          value.socket?.close(1008, "Host ended session");
        }
        for (const [key, value] of this.invites) if (value.roomId === identity.roomId) this.invites.delete(key);
      }
      this.connections.delete(socket);
    }
    return raw;
  }
}
