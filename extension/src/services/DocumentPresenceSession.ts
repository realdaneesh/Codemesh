import type * as vscode from "vscode";
import { MAX_SELECTION_RANGES, TYPING_LEASE_MS, type ClientMessage, type SelectionRange, type ServerMessage } from "../types/protocol";
import type { DocumentSyncSession } from "./DocumentSyncSession";

type PresenceFrame = Extract<ServerMessage, { type: "CURSOR_UPDATE" | "SELECTION_UPDATE" | "TYPING_ACTIVITY" }>;
type OpenShare = { memberId: string; documentPath: string; shareSessionId: string; shareId: string };
type LegacyShare = { memberId: string; documentPath: string; shareId: string };

/** Editor indicators for one explicit document share. All timers and decorations die with the share. */
export class DocumentPresenceSession implements vscode.Disposable {
  private shareId: string | undefined;
  private readonly peers = new Map<string, Set<string>>();
  private readonly cursors = new Map<string, { shareId: string; sequence: number; position: vscode.Position }>();
  private readonly selections = new Map<string, { shareId: string; sequence: number; ranges: SelectionRange[] }>();
  private readonly typing = new Map<string, { shareId: string; sequence: number; active: boolean; timer?: NodeJS.Timeout }>();
  private readonly cursorDecorations = new Map<string, vscode.TextEditorDecorationType>();
  private readonly selectionDecorations = new Map<string, vscode.TextEditorDecorationType>();
  private readonly selectionListener: vscode.Disposable;
  private readonly editorsListener: vscode.Disposable;
  private readonly activeListener: vscode.Disposable;
  private cursorTimer: NodeJS.Timeout | undefined;
  private selectionTimer: NodeJS.Timeout | undefined;
  private typingTimer: NodeJS.Timeout | undefined;
  private cursorSequence = 0;
  private selectionSequence = 0;
  private typingSequence = 0;
  private lastSelection = "";
  private localTyping = false;
  private lastTypingSent = 0;
  private closed = false;

  constructor(private readonly session: DocumentSyncSession, private readonly api: typeof vscode,
    private readonly memberId: string, private readonly presenceSessionId: () => string | undefined,
    private readonly send: (message: ClientMessage) => void, private readonly changed: () => void,
    private readonly memberName: (memberId: string) => string | undefined) {
    this.selectionListener = api.window.onDidChangeTextEditorSelection?.(event => {
      if (event.textEditor.document === session.document) { this.queueCursor(); this.queueSelection(); }
    }) ?? { dispose() {} };
    this.editorsListener = api.window.onDidChangeVisibleTextEditors?.(() => this.render()) ?? { dispose() {} };
    this.activeListener = api.window.onDidChangeActiveTextEditor?.(editor => {
      if (editor?.document === session.document) { this.queueCursor(); this.queueSelection(); }
      else { this.clearSelection(); this.stopTyping(true); }
    }) ?? { dispose() {} };
  }

  get typingMemberIds(): string[] { return [...this.typing].filter(([, value]) => value.active).map(([id]) => id); }

  setShares(openShares: OpenShare[], legacyShares: LegacyShare[]): void {
    if (this.closed) return;
    const self = openShares.find(share => share.memberId === this.memberId && share.documentPath === this.session.path
      && share.shareSessionId === this.session.shareSessionId);
    const nextId = self?.shareId;
    if (nextId !== this.shareId) {
      this.stopTyping(false);
      this.clearSelection();
      this.shareId = nextId;
      this.cursorSequence = this.selectionSequence = this.typingSequence = 0;
      if (nextId) { this.queueCursor(); this.queueSelection(); }
    }
    const nextPeers = new Map<string, Set<string>>();
    for (const share of openShares) {
      if (share.memberId === this.memberId || share.documentPath !== this.session.path) continue;
      const ids = nextPeers.get(share.memberId) ?? new Set<string>();
      ids.add(share.shareId);
      nextPeers.set(share.memberId, ids);
    }
    for (const share of legacyShares) {
      if (share.memberId === this.memberId || share.documentPath !== this.session.path || !nextPeers.has(share.memberId)) continue;
      nextPeers.get(share.memberId)!.add(share.shareId);
    }
    for (const [memberId, cursor] of this.cursors) if (!nextPeers.get(memberId)?.has(cursor.shareId)) this.removeCursor(memberId);
    for (const [memberId, selection] of this.selections) if (!nextPeers.get(memberId)?.has(selection.shareId)) this.removeSelection(memberId);
    for (const [memberId, activity] of this.typing) if (!nextPeers.get(memberId)?.has(activity.shareId)) this.removeTyping(memberId);
    this.peers.clear();
    for (const [id, shares] of nextPeers) this.peers.set(id, shares);
    this.render();
    this.changed();
  }

  receive(message: PresenceFrame): void {
    if (this.closed || !this.shareId || message.roomId !== this.session.roomId || message.documentPath !== this.session.path
      || message.presenceSessionId !== this.presenceSessionId() || message.recipientShareSessionId !== this.session.shareSessionId
      || message.memberId === this.memberId || !this.peers.get(message.memberId)?.has(message.shareId)
      || !Number.isSafeInteger(message.sequence) || message.sequence < 1) return;
    if (message.type === "CURSOR_UPDATE") {
      if (message.sequence <= (this.cursors.get(message.memberId)?.sequence ?? 0)) return;
      if (!Number.isSafeInteger(message.position.line) || !Number.isSafeInteger(message.position.character)
        || message.position.line < 0 || message.position.character < 0) return;
      this.cursors.set(message.memberId, { shareId: message.shareId, sequence: message.sequence,
        position: new this.api.Position(message.position.line, message.position.character) });
      this.render();
    } else if (message.type === "SELECTION_UPDATE") {
      if (message.sequence <= (this.selections.get(message.memberId)?.sequence ?? 0)
        || !Array.isArray(message.ranges) || message.ranges.length > MAX_SELECTION_RANGES) return;
      if (message.ranges.length && (this.session.status !== "shared" || message.documentRevision !== this.session.revision
        || this.session.sent || this.session.pending !== undefined)) return;
      this.selections.set(message.memberId, { shareId: message.shareId, sequence: message.sequence, ranges: message.ranges });
      this.render();
    } else {
      if (message.sequence <= (this.typing.get(message.memberId)?.sequence ?? 0)
        || message.leaseMs < 0 || message.leaseMs > TYPING_LEASE_MS) return;
      this.removeTyping(message.memberId);
      const activity = { shareId: message.shareId, sequence: message.sequence, active: message.active,
        timer: undefined as NodeJS.Timeout | undefined };
      this.typing.set(message.memberId, activity);
      if (message.active) {
        activity.timer = setTimeout(() => {
          if (this.typing.get(message.memberId) === activity) { activity.active = false; activity.timer = undefined; this.changed(); }
        }, message.leaseMs);
        activity.timer.unref();
      }
      this.changed();
    }
  }

  noteLocalUserEdit(): void {
    if (!this.ready() || this.api.window.activeTextEditor?.document !== this.session.document) return;
    const now = Date.now();
    if (!this.localTyping || now - this.lastTypingSent >= 400) {
      this.publish({ type: "TYPING_ACTIVITY", active: true, sequence: ++this.typingSequence });
      this.localTyping = true;
      this.lastTypingSent = now;
    }
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.stopTyping(true), 1000);
    this.typingTimer.unref();
  }

  onDocumentChanged(): void {
    this.clearSelection();
    this.queueCursor();
  }

  private ready(): boolean {
    return !this.closed && Boolean(this.shareId && this.presenceSessionId()) && this.session.status === "shared";
  }

  private publish(extra: { type: "TYPING_ACTIVITY"; active: boolean; sequence: number } |
    { type: "CURSOR_UPDATE"; position: { line: number; character: number }; sequence: number } |
    { type: "SELECTION_UPDATE"; ranges: SelectionRange[]; documentRevision: number; sequence: number }): void {
    if (!this.shareId || !this.presenceSessionId()) return;
    try {
      this.send({ ...extra, roomId: this.session.roomId, documentPath: this.session.path,
        presenceSessionId: this.presenceSessionId()!, shareId: this.shareId } as ClientMessage);
    } catch { /* A disconnect clears the session; editor indicators never change document text. */ }
  }

  private queueCursor(): void {
    if (!this.ready() || this.cursorTimer) return;
    const shareId = this.shareId;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined;
      const editor = this.api.window.activeTextEditor;
      if (!this.ready() || shareId !== this.shareId || editor?.document !== this.session.document) return;
      const position = editor.selection.active;
      if (position.line >= editor.document.lineCount || position.character > editor.document.lineAt(position.line).text.length) return;
      this.publish({ type: "CURSOR_UPDATE", sequence: ++this.cursorSequence,
        position: { line: position.line, character: position.character } });
    }, 50);
    this.cursorTimer.unref();
  }

  private queueSelection(): void {
    if (!this.ready() || this.selectionTimer) return;
    const shareId = this.shareId;
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = undefined;
      const editor = this.api.window.activeTextEditor;
      if (!this.ready() || shareId !== this.shareId || editor?.document !== this.session.document
        || this.session.sent || this.session.pending !== undefined) { this.clearSelection(); return; }
      const selections = editor.selections ?? [editor.selection];
      if (selections.length > MAX_SELECTION_RANGES) return;
      const ranges: SelectionRange[] = [];
      for (const selection of selections) {
        const start = selection.start, end = selection.end;
        if (!start || !end || start.line >= editor.document.lineCount || end.line >= editor.document.lineCount
          || start.character > editor.document.lineAt(start.line).text.length
          || end.character > editor.document.lineAt(end.line).text.length) return;
        if (start.line !== end.line || start.character !== end.character) ranges.push({ start: { line: start.line, character: start.character },
          end: { line: end.line, character: end.character } });
      }
      const key = `${this.session.revision}:${JSON.stringify(ranges)}`;
      if (key === this.lastSelection) return;
      this.lastSelection = key;
      this.publish({ type: "SELECTION_UPDATE", sequence: ++this.selectionSequence,
        documentRevision: this.session.revision, ranges });
    }, 50);
    this.selectionTimer.unref();
  }

  private clearSelection(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = undefined;
    if (this.lastSelection && this.ready()) this.publish({ type: "SELECTION_UPDATE", sequence: ++this.selectionSequence,
      documentRevision: this.session.revision, ranges: [] });
    this.lastSelection = "";
  }

  private stopTyping(sendStop: boolean): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = undefined;
    if (sendStop && this.localTyping && this.ready())
      this.publish({ type: "TYPING_ACTIVITY", active: false, sequence: ++this.typingSequence });
    this.localTyping = false;
    this.lastTypingSent = 0;
  }

  private removeCursor(id: string): void { this.cursors.delete(id); this.cursorDecorations.get(id)?.dispose(); this.cursorDecorations.delete(id); }
  private removeSelection(id: string): void { this.selections.delete(id); this.selectionDecorations.get(id)?.dispose(); this.selectionDecorations.delete(id); }
  private removeTyping(id: string): void { const old = this.typing.get(id); if (old?.timer) clearTimeout(old.timer); this.typing.delete(id); this.changed(); }

  private render(): void {
    if (!this.api.window.createTextEditorDecorationType) return;
    const editors = this.api.window.visibleTextEditors ?? [];
    for (const [id, cursor] of this.cursors) {
      let decoration = this.cursorDecorations.get(id);
      if (!decoration) {
        decoration = this.api.window.createTextEditorDecorationType({
          before: { contentText: `| ${(this.memberName(id) ?? "Member").replace(/[\u0000-\u001f]/g, " ").slice(0, 32)}`,
            color: "#4587d4", fontWeight: "bold" }, rangeBehavior: this.api.DecorationRangeBehavior.ClosedClosed
        });
        this.cursorDecorations.set(id, decoration);
      }
      for (const editor of editors) {
        const position = cursor.position;
        const valid = editor.document === this.session.document && position.line < editor.document.lineCount
          && position.character <= editor.document.lineAt(position.line).text.length;
        editor.setDecorations(decoration, valid ? [new this.api.Range(position, position)] : []);
      }
    }
    for (const [id, selection] of this.selections) {
      let decoration = this.selectionDecorations.get(id);
      if (!decoration) {
        decoration = this.api.window.createTextEditorDecorationType({ backgroundColor: "rgba(69, 135, 212, 0.16)",
          rangeBehavior: this.api.DecorationRangeBehavior.ClosedClosed });
        this.selectionDecorations.set(id, decoration);
      }
      for (const editor of editors) {
        const ranges = editor.document === this.session.document ? selection.ranges.filter(range =>
          range.start.line < editor.document.lineCount && range.end.line < editor.document.lineCount
          && range.start.character <= editor.document.lineAt(range.start.line).text.length
          && range.end.character <= editor.document.lineAt(range.end.line).text.length).map(range =>
          new this.api.Range(new this.api.Position(range.start.line, range.start.character),
            new this.api.Position(range.end.line, range.end.character))) : [];
        editor.setDecorations(decoration, ranges);
      }
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.stopTyping(true);
    this.clearSelection();
    this.closed = true;
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.selectionListener.dispose(); this.editorsListener.dispose(); this.activeListener.dispose();
    for (const id of [...this.cursors.keys()]) this.removeCursor(id);
    for (const id of [...this.selections.keys()]) this.removeSelection(id);
    for (const id of [...this.typing.keys()]) this.removeTyping(id);
  }
}
