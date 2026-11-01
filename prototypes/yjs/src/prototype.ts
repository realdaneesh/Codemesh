import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { BinaryProtocol, type Scope } from "./protocol";

const LOCAL = Symbol("local editor");
const REMOTE = Symbol("remote transport");
const canonical = (text: string) => text.replace(/\r\n/g, "\n");
export type TextDelta = Array<{ insert?: string | object; delete?: number; retain?: number }>;

function validateText(text: string, protocol: BinaryProtocol): void {
  if (Buffer.byteLength(text, "utf8") > protocol.limits.maxDocumentBytes) throw new Error("CRDT text exceeds CodeMesh document limit");
  if (canonical(text) !== text) throw new Error("CRDT text must use LF line endings");
}

function fork(doc: Y.Doc): Y.Doc {
  const candidate = new Y.Doc();
  candidate.getText("text");
  try { Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc)); return candidate; }
  catch (error) { candidate.destroy(); throw error; }
}

function validateDocument(doc: Y.Doc, scope: Scope, protocol: BinaryProtocol): void {
  if ([...doc.share.keys()].some((key) => key !== "text")) throw new Error("Only one CRDT text type is supported");
  const text = doc.getText("text");
  if (text.toDelta().some((part: { insert?: unknown; attributes?: unknown }) => typeof part.insert !== "string" || part.attributes)) throw new Error("Only plain CRDT text is supported");
  validateText(text.toString(), protocol);
  // Bound retained encoded history and unresolved dependencies as well as each frame.
  protocol.encode(scope, "UPDATE", Y.encodeStateAsUpdate(doc));
}

function applyChecked(doc: Y.Doc, scope: Scope, protocol: BinaryProtocol, update: Uint8Array): void {
  const candidate = fork(doc);
  try { Y.applyUpdate(candidate, update, REMOTE); validateDocument(candidate, scope, protocol); }
  finally { candidate.destroy(); }
  Y.applyUpdate(doc, update, REMOTE);
}

export class PrototypeClient {
  private doc: Y.Doc | undefined;
  private text: Y.Text | undefined;
  private undoManager: Y.UndoManager | undefined;
  private historyOperation = false;
  private historyFrames: Uint8Array[] = [];
  private ready = false;
  private suspended = false;
  private send: ((frame: Uint8Array) => void) | undefined;
  private onText: ((text: string) => void) | undefined;
  private readonly changes = new Set<(text: string, remote: boolean, delta?: TextDelta) => void>();
  private readonly ends = new Set<() => void>();
  private readonly suspensions = new Set<() => void>();
  readonly scope: Scope;

  private readonly observeText = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (this.historyOperation) return;
    const text = this.text!.toString();
    this.onText?.(text);
    for (const listener of this.changes) listener(text, transaction.origin !== LOCAL && transaction.origin !== this.undoManager, event.delta);
  };
  private readonly observeUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== LOCAL && origin !== this.undoManager) return;
    const frame = this.protocol.encode(this.scope, "UPDATE", update);
    if (this.historyOperation) this.historyFrames.push(frame);
    else this.send?.(frame);
  };

  constructor(scope: Scope, private readonly protocol: BinaryProtocol, send: (frame: Uint8Array) => void, onText: (text: string) => void = () => undefined) {
    protocol.validateScope(scope);
    this.scope = Object.freeze({ ...scope });
    this.doc = new Y.Doc();
    this.text = this.doc.getText("text");
    this.undoManager = new Y.UndoManager(this.text, { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    this.send = send;
    this.onText = onText;
    this.doc!.on("update", this.observeUpdate);
    this.text!.observe(this.observeText);
  }

  private requireDoc(): Y.Doc {
    if (!this.doc) throw new Error("CRDT document session has ended");
    return this.doc;
  }

  getText(): string { this.requireDoc(); return this.text!.toString(); }

  onChange(listener: (text: string, remote: boolean, delta?: TextDelta) => void): { dispose(): void } {
    this.requireDoc(); this.changes.add(listener);
    return { dispose: () => { this.changes.delete(listener); } };
  }
  onEnd(listener: () => void): { dispose(): void } {
    this.requireDoc(); this.ends.add(listener);
    return { dispose: () => { this.ends.delete(listener); } };
  }
  onSuspend(listener: () => void): { dispose(): void } {
    this.requireDoc(); this.suspensions.add(listener);
    return { dispose: () => { this.suspensions.delete(listener); } };
  }
  suspend(): void {
    if (this.suspended || !this.doc) return;
    this.suspended = true;
    for (const listener of this.suspensions) listener();
  }

  stateVectorFrame(): Uint8Array { return this.protocol.encode(this.scope, "STATE_VECTOR", Y.encodeStateVector(this.requireDoc())); }

  receive(frame: Uint8Array): void {
    const doc = this.requireDoc();
    if (this.suspended) throw new Error("CRDT session is quarantined");
    applyChecked(doc, this.scope, this.protocol, this.protocol.decode(this.scope, frame, "UPDATE"));
    this.ready = true;
  }

  replace(offset: number, count: number, value: string): void {
    this.replaceBatch([{ offset, count, text: value }]);
  }

  replaceBatch(edits: Array<{ offset: number; count: number; text: string }>): void {
    const doc = this.requireDoc();
    if (!this.ready || this.suspended) throw new Error("Complete state sync or explicit recovery before editing");
    const current = this.text!.toString();
    const batch = edits.map((edit) => ({ ...edit, text: canonical(edit.text) })).sort((a, b) => b.offset - a.offset);
    let result = current, next = current.length;
    for (const { offset, count, text } of batch) {
      if (!Number.isInteger(offset) || !Number.isInteger(count) || offset < 0 || count < 0 || offset + count > next) throw new Error("Invalid CRDT edit range");
      result = result.slice(0, offset) + text + result.slice(offset + count);
      next = offset;
    }
    validateText(result, this.protocol);
    if (!batch.some((edit) => edit.count || edit.text)) return;
    const apply = (shared: Y.Text) => {
      for (const { offset, count, text } of batch) {
        if (count) shared.delete(offset, count);
        if (text) shared.insert(offset, text);
      }
    };
    const candidate = fork(doc);
    let update: Uint8Array | undefined;
    try {
      // The fork stages this actor's next transaction; it is never published as a peer.
      candidate.clientID = doc.clientID;
      candidate.on("update", (bytes: Uint8Array) => { update = bytes; });
      candidate.transact(() => {
        apply(candidate.getText("text"));
      }, LOCAL);
      validateDocument(candidate, this.scope, this.protocol);
      if (update) this.protocol.encode(this.scope, "UPDATE", update);
    } finally { candidate.destroy(); }
    if (update) {
      doc.transact(() => {
        apply(this.text!);
      }, LOCAL);
    }
  }

  insert(offset: number, text: string): void { this.replace(offset, 0, text); }
  delete(offset: number, count: number): void { this.replace(offset, count, ""); }

  canUndo(): boolean { return this.getStatus().ready && Boolean(this.undoManager?.canUndo()); }
  canRedo(): boolean { return this.getStatus().ready && Boolean(this.undoManager?.canRedo()); }
  undo(): boolean { return this.changeHistory("undo"); }
  redo(): boolean { return this.changeHistory("redo"); }

  private changeHistory(direction: "undo" | "redo"): boolean {
    const doc = this.requireDoc();
    if (!this.ready || this.suspended) throw new Error("Complete state sync or explicit recovery before undo/redo");
    if (!this.undoManager?.[direction === "undo" ? "canUndo" : "canRedo"]()) return false;
    this.historyOperation = true;
    this.historyFrames = [];
    let changed = false;
    try {
      changed = Boolean(this.undoManager[direction]());
      validateDocument(doc, this.scope, this.protocol);
      for (const frame of this.historyFrames) this.send?.(frame);
      if (changed) {
        const text = this.text!.toString();
        this.onText?.(text);
        for (const listener of this.changes) listener(text, false);
      }
      return changed;
    } catch (error) {
      this.suspend();
      throw new Error("Undo/redo requires explicit recovery: " + String(error));
    } finally {
      this.historyOperation = false;
      this.historyFrames = [];
    }
  }

  getStatus(): { active: boolean; ready: boolean; listenerCount: number } {
    return { active: Boolean(this.doc), ready: this.ready && !this.suspended, listenerCount: this.doc ? 2 : 0 };
  }

  leave(): void { this.dispose(); }

  dispose(): void {
    if (!this.doc) return;
    this.doc.off("update", this.observeUpdate);
    this.text!.unobserve(this.observeText);
    this.undoManager?.destroy();
    this.undoManager = undefined;
    this.send = undefined;
    this.onText = undefined;
    this.doc.destroy();
    this.doc = undefined;
    this.text = undefined;
    this.ready = false;
    for (const listener of [...this.ends]) listener();
    this.changes.clear(); this.ends.clear(); this.suspensions.clear();
  }
}

export class PrototypeRoom {
  readonly scope: Scope;
  private doc: Y.Doc | undefined = new Y.Doc();
  private readonly members = new Set<string>();

  constructor(roomId: string, documentPath: string, private readonly protocol: BinaryProtocol, initialText = "") {
    this.scope = Object.freeze({ roomId, documentPath, epoch: randomUUID() });
    try {
      protocol.validateScope(this.scope);
      const text = canonical(initialText);
      validateText(text, protocol);
      this.doc!.getText("text").insert(0, text);
      validateDocument(this.doc!, this.scope, protocol);
    } catch (error) { this.dispose(); throw error; }
  }

  private requireDoc(): Y.Doc {
    if (!this.doc) throw new Error("CRDT room document has ended");
    return this.doc;
  }

  private syncFrame(frame: Uint8Array): Uint8Array {
    const doc = this.requireDoc();
    const vector = this.protocol.decode(this.scope, frame, "STATE_VECTOR");
    Y.decodeStateVector(vector);
    return this.protocol.encode(this.scope, "UPDATE", Y.encodeStateAsUpdate(doc, vector));
  }

  join(memberId: string, stateVector: Uint8Array): Uint8Array {
    if (!memberId || this.members.has(memberId)) throw new Error("Invalid or duplicate CRDT member");
    const frame = this.syncFrame(stateVector);
    this.members.add(memberId);
    return frame;
  }

  sync(memberId: string, stateVector: Uint8Array): Uint8Array {
    if (!this.members.has(memberId)) throw new Error("Member is not in this CRDT room");
    return this.syncFrame(stateVector);
  }

  receive(memberId: string, frame: Uint8Array): Array<{ memberId: string; frame: Uint8Array }> {
    const doc = this.requireDoc();
    if (!this.members.has(memberId)) throw new Error("Member is not in this CRDT room");
    const update = this.protocol.decode(this.scope, frame, "UPDATE");
    const before = Y.encodeStateAsUpdate(doc);
    applyChecked(doc, this.scope, this.protocol, update);
    if (Buffer.from(before).equals(Buffer.from(Y.encodeStateAsUpdate(doc)))) return [];
    return [...this.members].filter((member) => member !== memberId).map((memberId) => ({ memberId, frame: frame.slice() }));
  }

  getText(): string { return this.requireDoc().getText("text").toString(); }
  getStatus(): { active: boolean; memberCount: number } { return { active: Boolean(this.doc), memberCount: this.members.size }; }

  leave(memberId: string, preserveEmpty = false): void {
    if (!this.members.delete(memberId)) return;
    if (!this.members.size && !preserveEmpty) this.dispose();
  }

  dispose(): void { this.doc?.destroy(); this.doc = undefined; this.members.clear(); }
}
