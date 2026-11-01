export interface Scope { roomId: string; documentPath: string; epoch: string }
export interface Limits { maxMessageBytes: number; maxDocumentBytes: number; maxPathBytes: number }
export type FrameKind = "UPDATE" | "STATE_VECTOR";

// The prototype receives CodeMesh's existing validators/limits from its test harness.
// Neither production package imports this experimental binary protocol.
export class BinaryProtocol {
  constructor(readonly limits: Limits, private readonly normalizePath: (path: unknown) => string) {}

  validateScope(scope: Scope): void {
    if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).some((key) => !["roomId", "documentPath", "epoch"].includes(key))) throw new Error("Invalid CRDT scope fields");
    if (!scope || !/^[A-HJ-NP-Z2-9]{6}$/.test(scope.roomId) || !/^[0-9a-f-]{36}$/i.test(scope.epoch)) throw new Error("Invalid CRDT scope");
    if (this.normalizePath(scope.documentPath) !== scope.documentPath || Buffer.byteLength(scope.documentPath, "utf8") > this.limits.maxPathBytes) {
      throw new Error("CRDT document path must be normalized and workspace-relative");
    }
  }

  encode(scope: Scope, kind: FrameKind, payload: Uint8Array): Uint8Array {
    this.validateScope(scope);
    if (kind !== "UPDATE" && kind !== "STATE_VECTOR") throw new Error("Invalid CRDT frame kind");
    if (!(payload instanceof Uint8Array) || !payload.byteLength) throw new Error("Missing binary CRDT payload");
    const header = Buffer.from(JSON.stringify({ version: 1, kind, ...scope }), "utf8");
    const length = 4 + header.byteLength + payload.byteLength;
    if (header.byteLength > 4096 || length > this.limits.maxMessageBytes) throw new Error("CRDT frame exceeds CodeMesh message limit");
    const frame = Buffer.allocUnsafe(length);
    frame.writeUInt32BE(header.byteLength, 0);
    header.copy(frame, 4);
    frame.set(payload, 4 + header.byteLength);
    return frame;
  }

  decode(scope: Scope, input: Uint8Array, kind: FrameKind): Uint8Array {
    this.validateScope(scope);
    if (!(input instanceof Uint8Array) || input.byteLength > this.limits.maxMessageBytes) throw new Error("CRDT frame exceeds CodeMesh message limit");
    if (input.byteLength < 6) throw new Error("Truncated CRDT frame");
    const frame = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const headerLength = frame.readUInt32BE(0);
    if (!headerLength || headerLength > 4096 || 4 + headerLength >= frame.length) throw new Error("Invalid CRDT frame length");
    const header = JSON.parse(frame.subarray(4, 4 + headerLength).toString("utf8")) as Record<string, unknown>;
    if (!header || Object.keys(header).some((key) => !["version", "kind", "roomId", "documentPath", "epoch"].includes(key))) throw new Error("Invalid CRDT header");
    if (header.version !== 1 || header.kind !== kind || header.roomId !== scope.roomId || header.documentPath !== scope.documentPath || header.epoch !== scope.epoch) {
      throw new Error("CRDT frame does not match room, document, epoch or kind");
    }
    return frame.subarray(4 + headerLength);
  }
}
