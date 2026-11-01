import type * as vscode from "vscode";
import { PrototypeClient, type TextDelta } from "./prototype";

const canonical = (text: string) => text.replace(/\r\n/g, "\n");
type EditorAPI = Pick<typeof vscode, "workspace" | "WorkspaceEdit" | "Range">;
type EditOrigin = { applyEdit(edit: vscode.WorkspaceEdit, origin: symbol): Promise<boolean>; isOwnEdit(event: vscode.TextDocumentChangeEvent, origin: symbol): boolean };
type Patch = { offset: number; count: number; text: string };

function deltaPatches(before: string, target: string, delta: TextDelta, eol: vscode.EndOfLine): Patch[] {
  const source = canonical(before);
  let offset = 0;
  const changes: Patch[] = [];
  for (const part of delta) {
    if (part.retain !== undefined) { offset += part.retain; continue; }
    if (part.delete !== undefined) {
      if (!Number.isInteger(part.delete) || part.delete < 0) throw new Error("Invalid CRDT deletion delta");
      const last = changes.at(-1);
      if (last && last.offset + last.count === offset) last.count += part.delete;
      else changes.push({ offset, count: part.delete, text: "" });
      offset += part.delete;
    } else if (typeof part.insert === "string") {
      const last = changes.at(-1);
      if (last && last.offset + last.count === offset) last.text += part.insert;
      else changes.push({ offset, count: 0, text: part.insert });
    } else throw new Error("Unsupported CRDT text delta");
  }
  let result = source;
  for (const patch of [...changes].reverse()) result = result.slice(0, patch.offset) + patch.text + result.slice(patch.offset + patch.count);
  if (result !== target) throw new Error("CRDT delta does not match the editor shadow; draft preserved");
  const rawOffset = (index: number): number => {
    let raw = 0, logical = 0;
    while (logical < index && raw < before.length) {
      raw += before[raw] === "\r" && before[raw + 1] === "\n" ? 2 : 1;
      logical += 1;
    }
    if (logical !== index) throw new Error("CRDT delta offset is outside the editor shadow");
    return raw;
  };
  return changes.map((patch) => {
    const start = rawOffset(patch.offset), end = rawOffset(patch.offset + patch.count);
    return { offset: start, count: end - start, text: eol === 2 ? patch.text.replace(/\n/g, "\r\n") : patch.text };
  });
}

export class TestEditorBinding {
  private shadow: string;
  private status: "active" | "paused" | "disposed" = "active";
  private draft: string | undefined;
  private pauseReason: string | undefined;
  private latestDraft: string | undefined;
  private readonly draftCandidates: string[] = [];
  private expected: string | undefined;
  private pending = false;
  private interrupted = false;
  private restoring = false;
  private pendingChanges: Patch[] = [];
  private pendingOrigin: symbol | undefined;
  private pendingLocal: { offset: number; text: string } | undefined;
  private ambiguous = false;
  private resolved = false;
  private generation = 0;
  private queue = Promise.resolve();
  private readonly listeners: vscode.Disposable[] = [];

  constructor(private readonly api: EditorAPI, private readonly document: vscode.TextDocument, private readonly client: PrototypeClient,
    private readonly warn: (reason: string) => void = () => undefined, private readonly editOrigin?: EditOrigin) {
    this.shadow = document.getText();
    if (document.uri.scheme !== "file" || !api.workspace.getWorkspaceFolder(document.uri)
      || api.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/") !== client.scope.documentPath) throw new Error("Binding document must match the authorized workspace-relative path");
    if (!client.getStatus().ready) this.pause("Complete state sync or explicit recovery before binding the editor");
    if (canonical(this.shadow) !== client.getText()) this.pause("Initial text differs; preserve the draft and explicitly choose room text or end sharing");
    this.listeners.push(api.workspace.onDidChangeTextDocument((event) => this.local(event)),
      api.workspace.onDidCloseTextDocument((closed) => { if (closed === document) this.dispose(); }),
      client.onChange((text, remote, delta) => { if (remote && this.status === "active") this.remote(text, delta); }),
      client.onSuspend(() => this.pause("CRDT session quarantined; preserve the draft and explicitly recover")),
      client.onEnd(() => this.dispose()));
  }

  private local(event: vscode.TextDocumentChangeEvent): void {
    if (event.document !== this.document || this.restoring) return;
    const text = this.document.getText();
    const change = event.contentChanges[0];
    const remotePatch = Boolean(this.pending && this.editOrigin && this.pendingOrigin
      && this.editOrigin.isOwnEdit(event, this.pendingOrigin));
    if (this.status === "disposed") {
      if (this.pending && !remotePatch) {
        this.rememberDraft(this.latestDraft ?? this.draft);
        this.latestDraft = text;
        this.rememberDraft(text);
        if (!this.editOrigin) this.warn("Pending edit origin is ambiguous after disposal; recover the unsaved draft from the binding snapshots");
      }
      return;
    }
    if (!event.contentChanges.length) {
      if (canonical(text) === canonical(this.shadow)) this.shadow = text;
      return;
    }
    if (this.pending && !this.editOrigin && this.status === "active") {
      this.ambiguous = true;
      this.pause("VS Code did not identify whether this edit was local or remote; draft preserved for explicit resolution");
      return;
    }
    if (this.status === "active" && event.reason !== undefined) {
      this.pause("VS Code native Undo/Redo is not local-only CRDT history; preserve the draft and resolve explicitly");
      return;
    }
    if (remotePatch && text === this.expected) { this.shadow = text; return; }
    if (this.status === "paused") { if (!remotePatch || this.ambiguous) { this.draft ??= text; this.latestDraft = text; } return; }
    if (this.expected !== undefined || canonical(this.shadow) !== this.client.getText()) {
      if (this.expected !== undefined && !remotePatch && this.editOrigin && event.contentChanges.length === 1
        && change.rangeLength === 0 && !this.pendingLocal) {
        this.pendingLocal = { offset: canonical(this.shadow.slice(0, change.rangeOffset)).length, text: canonical(change.text) };
      }
      this.pause("Local typing raced a remote application; draft preserved, explicit reconciliation required"); return;
    }
    try {
      const edits = event.contentChanges.map((change) => ({
        offset: canonical(this.shadow.slice(0, change.rangeOffset)).length,
        count: canonical(this.shadow.slice(change.rangeOffset, change.rangeOffset + change.rangeLength)).length,
        text: canonical(change.text)
      }));
      let predicted = canonical(this.shadow);
      for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) predicted = predicted.slice(0, edit.offset) + edit.text + predicted.slice(edit.offset + edit.count);
      if (predicted !== canonical(text)) throw new Error("Editor batch does not match its pre-change offsets; draft preserved");
      this.client.replaceBatch(edits);
      if (this.client.getText() !== canonical(text)) throw new Error("Editor and CRDT offsets differ");
      this.shadow = text;
    } catch (error) { this.pause(String(error)); }
  }

  private remote(text: string, delta?: TextDelta): void {
    const generation = this.generation;
    this.queue = this.queue.then(async () => {
      if (this.status !== "active" || generation !== this.generation) return;
      await this.apply(text, delta);
    }).catch((error) => { if (generation === this.generation) this.pause(String(error)); });
  }

  private async apply(text: string, delta?: TextDelta): Promise<void> {
    const before = this.document.getText();
    if (before !== this.shadow) { this.pause("Editor changed before remote application; draft preserved"); return; }
    const target = this.document.eol === 2 ? text.replace(/\n/g, "\r\n") : text;
    if (before === target) return;
    let patches: Patch[];
    if (delta) patches = deltaPatches(before, text, delta, this.document.eol);
    else {
      let start = 0, end = before.length, targetEnd = target.length;
      while (start < end && start < targetEnd && before[start] === target[start]) start += 1;
      if (start && /[\uD800-\uDBFF]/.test(before[start - 1])) start -= 1;
      while (end > start && targetEnd > start && before[end - 1] === target[targetEnd - 1]) { end -= 1; targetEnd -= 1; }
      if (end < before.length && /[\uDC00-\uDFFF]/.test(before[end])) { end += 1; targetEnd += 1; }
      patches = [{ offset: start, count: end - start, text: target.slice(start, targetEnd) }];
    }
    const edit = new this.api.WorkspaceEdit();
    for (const patch of patches) edit.replace(this.document.uri,
      new this.api.Range(this.document.positionAt(patch.offset), this.document.positionAt(patch.offset + patch.count)), patch.text);
    this.expected = target;
    this.pendingChanges = patches;
    this.pendingOrigin = Symbol("CRDT editor apply");
    this.pending = true;
    try {
      if (!await (this.editOrigin ? this.editOrigin.applyEdit(edit, this.pendingOrigin) : this.api.workspace.applyEdit(edit))) throw new Error("Remote editor edit was rejected");
      if (this.status === "active" && this.document.getText() === target) this.shadow = target;
      else if (this.status === "active") this.pause("Editor changed during remote application; draft preserved");
    } finally {
      this.expected = undefined;
      try {
        if (this.interrupted) this.reconcilePendingLocal(before);
        if (this.interrupted) await this.restoreDraft();
      } catch (error) {
        this.warn("Draft restore failed; recover it explicitly from the binding snapshot: " + String(error));
      } finally {
        this.pendingChanges = [];
        this.pendingOrigin = undefined;
        this.pendingLocal = undefined;
        this.pending = false;
        this.interrupted = false;
        if (this.status === "disposed") for (const listener of this.listeners.splice(0)) listener.dispose();
      }
    }
  }

  private reconcilePendingLocal(before: string): void {
    const local = this.pendingLocal, remote = this.pendingChanges.length === 1 ? this.pendingChanges[0] : undefined;
    if (!local || !remote || remote.count !== 0 || this.status !== "paused" || !this.client.getStatus().ready) return;
    const baseOffset = canonical(before.slice(0, remote.offset)).length;
    const offset = local.offset + (local.offset >= baseOffset ? canonical(remote.text).length : 0);
    const room = this.client.getText();
    const result = room.slice(0, offset) + local.text + room.slice(offset);
    if (result !== canonical(this.document.getText())) return;
    this.client.insert(offset, local.text);
    this.shadow = this.document.getText();
    this.status = "active";
    this.interrupted = false;
    this.resolved = true;
  }

  private async restoreDraft(): Promise<void> {
    const draft = this.ambiguous ? this.draft : this.latestDraft ?? this.draft;
    if (draft === undefined || this.document.getText() === draft) return;
    const edit = new this.api.WorkspaceEdit();
    edit.replace(this.document.uri, new this.api.Range(this.document.positionAt(0), this.document.positionAt(this.document.getText().length)), draft);
    this.restoring = true;
    try {
      if (!await this.api.workspace.applyEdit(edit) || this.document.getText() !== draft) this.warn("Could not restore the paused draft; recover it explicitly from the binding snapshot");
    } finally { this.restoring = false; }
  }

  pause(reason: string): void {
    if (this.status === "disposed") return;
    if (this.resolved) { this.draft = undefined; this.latestDraft = undefined; this.resolved = false; }
    this.status = "paused"; this.pauseReason = reason; this.generation += 1; this.draft ??= this.document.getText();
    if (this.pending) { this.latestDraft ??= this.document.getText(); this.interrupted = true; }
    this.warn(reason);
  }
  private rememberDraft(text: string | undefined): void {
    if (text === undefined || this.draftCandidates.at(-1) === text) return;
    this.draftCandidates.push(text);
    if (this.draftCandidates.length > 4) this.draftCandidates.shift();
  }
  async useRoomText(): Promise<void> {
    await this.queue;
    if (this.status !== "paused") throw new Error("No paused draft to resolve");
    if (!this.client.getStatus().ready) throw new Error("Recover the quarantined CRDT session before choosing room text");
    this.shadow = this.document.getText();
    this.status = "active";
    this.ambiguous = false;
    await this.apply(this.client.getText());
    if (this.status === "active") this.resolved = true;
  }
  async undoLocal(): Promise<boolean> { return this.history("undo"); }
  async redoLocal(): Promise<boolean> { return this.history("redo"); }
  private async history(direction: "undo" | "redo"): Promise<boolean> {
    await this.queue;
    if (this.status !== "active" || !this.client.getStatus().ready) throw new Error("Resolve or re-share this document before undo/redo");
    try {
      if (!this.client[direction]()) return false;
      await this.apply(this.client.getText());
      return this.status === "active";
    } catch (error) {
      this.pause("Local-only undo/redo could not reach the editor; preserve the draft and explicitly resolve: " + String(error));
      throw error;
    }
  }
  getStatus(): { status: string; reason?: string; draft?: string; latestDraft?: string; draftCandidates: string[]; listenerCount: number } {
    return { status: this.status, reason: this.pauseReason, draft: this.draft, latestDraft: this.latestDraft, draftCandidates: [...this.draftCandidates], listenerCount: this.listeners.length };
  }
  async settled(): Promise<void> { await this.queue; }
  dispose(): void {
    if (this.status === "disposed") return;
    this.draft ??= this.document.getText(); this.status = "disposed"; this.generation += 1;
    if (this.pending) { this.latestDraft = this.document.getText(); this.rememberDraft(this.latestDraft); this.interrupted = true; }
    for (const listener of this.listeners.splice(this.pending ? 1 : 0)) listener.dispose();
  }
}
