import type * as vscode from "vscode";
import { type ClientMessage, type ServerMessage } from "../types/protocol";
import { DOCUMENT_SIZE_ERROR, MAX_DOCUMENT_BYTES, normalizeDocumentText } from "../types/syncLimits";

export type SessionStatus = "opening" | "shared" | "conflict" | "paused";
export interface SessionSnapshot {
  roomId: string;
  path: string;
  shareSessionId: string;
  status: SessionStatus;
  revision: number;
  error?: string;
  present?: boolean;
  conflict?: SessionConflict;
}

export interface SessionConflict {
  localText: string;
  roomText: string;
  revision: number;
  baseText?: string;
  recovery?: SessionRecovery;
}

export interface SessionRecovery {
  originalText: string;
  proposedText: string;
  roomText: string;
  revision: number;
  reviewed: boolean;
  delivery: "not-shared" | "unconfirmed" | "confirmed";
}

export class DocumentSyncSession {
  status: SessionStatus = "opening";
  revision = 0;
  error: string | undefined;
  confirmed: { text: string; revision: number } | undefined;
  sent: { text: string; baseRevision: number } | undefined;
  pending: string | undefined;
  conflict: SessionConflict | undefined;
  recoverySnapshots: SessionConflict[] = [];
  recovery: SessionRecovery | undefined;
  private proposalPending: { originalText: string; proposedText: string } | undefined;
  private awaitingRecoverySync = false;
  present = false;
  private applyingRemoteEdit = false;
  private applyingRemoteText: string | undefined;
  private remoteQueue: Promise<void> = Promise.resolve();
  private ackTimer: NodeJS.Timeout | undefined;
  private readonly changeListener: vscode.Disposable;
  private readonly closeListener: vscode.Disposable;
  private closed = false;

  constructor(readonly roomId: string, readonly path: string, readonly shareSessionId: string,
    readonly document: vscode.TextDocument, private readonly api: typeof vscode, private readonly send: (message: ClientMessage) => void,
    private readonly changed: () => void, private readonly closedDocument: (path: string) => void,
    private readonly ackTimeoutMs: number) {
    this.changeListener = this.api.workspace.onDidChangeTextDocument(event => {
      if (this.closed || event.document.uri.toString() !== document.uri.toString() || !event.contentChanges.length) return;
      const text = normalizeDocumentText(document.getText());
      if (this.applyingRemoteEdit && text === this.applyingRemoteText) return;
      if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) {
        this.pause(DOCUMENT_SIZE_ERROR);
        return;
      }
      this.pending = text;
      this.flush();
    });
    this.closeListener = this.api.workspace.onDidCloseTextDocument(closed => {
      if (closed === document) this.closedDocument(this.path);
    });
  }

  snapshot(): SessionSnapshot {
    return { roomId: this.roomId, path: this.path, shareSessionId: this.shareSessionId,
      status: this.status, revision: this.revision, error: this.error,
      present: this.present,
      conflict: this.conflict && { ...this.conflict } };
  }

  fail(reason: string): void { this.pause(reason); }
  restoreRecovery(recovery: SessionRecovery): void {
    if (this.closed || this.status !== "opening") return;
    this.recovery = { ...recovery, reviewed: false };
    this.awaitingRecoverySync = true;
  }
  isCurrentConflict(conflict: SessionConflict): boolean {
    return !this.closed && this.status === "conflict" && this.conflict === conflict;
  }

  retryMine(conflict: SessionConflict): void {
    if (!this.isCurrentConflict(conflict)) return;
    this.conflict = undefined;
    this.status = "shared";
    this.error = undefined;
    this.pending = normalizeDocumentText(this.document.getText());
    this.flush();
    this.changed();
  }

  async useRoomText(conflict: SessionConflict): Promise<void> {
    if (!this.isCurrentConflict(conflict)) return;
    this.conflict = undefined;
    this.status = "shared";
    this.pending = undefined;
    await this.applyRemote(conflict.roomText, conflict.revision);
  }

  async applyProposal(conflict: SessionConflict, expectedDraft: string, proposal: string): Promise<boolean> {
    if (!this.isCurrentConflict(conflict) || this.document.getText() !== expectedDraft) return false;
    const editorText = this.document.eol === this.api.EndOfLine.CRLF ? proposal.replace(/\n/g, "\r\n") : proposal;
    const edit = new this.api.WorkspaceEdit();
    edit.replace(this.document.uri, new this.api.Range(this.document.positionAt(0), this.document.positionAt(this.document.getText().length)), editorText);
    this.applyingRemoteEdit = true;
    this.applyingRemoteText = proposal;
    let applied = false;
    try { applied = await this.api.workspace.applyEdit(edit); }
    finally {
      this.applyingRemoteEdit = false;
      this.applyingRemoteText = undefined;
    }
    if (!applied || !this.isCurrentConflict(conflict) || normalizeDocumentText(this.document.getText()) !== proposal) {
      if (applied && !this.closed && this.status === "conflict") {
        const latest = this.conflict ?? conflict;
        this.recovery = { originalText: expectedDraft, proposedText: proposal,
          roomText: latest.roomText, revision: latest.revision, reviewed: false, delivery: "not-shared" };
        latest.recovery = this.recovery;
        this.error = "A proposed combination was applied to the unsaved editor but was not shared. Inspect preserved versions before resolving this file.";
      }
      this.changed();
      return false;
    }
    this.conflict = undefined;
    this.status = "shared";
    this.proposalPending = { originalText: expectedDraft, proposedText: proposal };
    this.pending = proposal;
    this.flush();
    this.changed();
    return true;
  }
  setPresence(present: boolean): void {
    if (this.present === present) return;
    this.present = present;
    this.changed();
  }

  handle(message: ServerMessage): void {
    if (this.closed || !("documentPath" in message) || message.documentPath !== this.path
      || !("roomId" in message) || message.roomId !== this.roomId
      || !("shareSessionId" in message) || message.shareSessionId !== this.shareSessionId) return;
    if (message.type === "DOCUMENT_SYNC") {
      if (this.status !== "opening") return;
      const text = normalizeDocumentText(message.text);
      this.revision = message.revision;
      if (this.awaitingRecoverySync && this.recovery)
        this.recovery = { ...this.recovery, roomText: text, revision: message.revision,
          reviewed: text === this.recovery.proposedText, delivery: text === this.recovery.proposedText ? "confirmed" : this.recovery.delivery };
      if (normalizeDocumentText(this.document.getText()) !== text) this.enterConflict(text, message.revision);
      else {
        this.awaitingRecoverySync = false;
        this.confirmed = { text, revision: message.revision };
        this.status = "shared";
        this.changed();
      }
    } else if (message.type === "DOCUMENT_ACK") {
      if (this.status !== "shared" || !this.sent || message.revision !== this.sent.baseRevision + 1) return;
      this.clearAck();
      this.confirmed = { text: this.sent.text, revision: message.revision };
      this.sent = undefined;
      this.revision = message.revision;
      if (this.proposalPending?.proposedText === this.confirmed.text) this.proposalPending = undefined;
      this.flush();
      this.changed();
    } else if (message.type === "DOCUMENT_CONFLICT") {
      if (this.status !== "paused") this.enterConflict(normalizeDocumentText(message.text), message.revision);
    } else if (message.type === "DOCUMENT_EDIT") {
      if (this.status === "conflict" && message.revision > this.revision) {
        this.enterConflict(normalizeDocumentText(message.text), message.revision);
        return;
      }
      if (this.status !== "shared") return;
      this.remoteQueue = this.remoteQueue.then(async () => {
        if (this.closed || this.status !== "shared") return;
        if (message.revision <= this.revision) return;
        if (this.sent || this.pending !== undefined) {
          this.enterConflict(normalizeDocumentText(message.text), message.revision);
          return;
        }
        await this.applyRemote(normalizeDocumentText(message.text), message.revision);
      }).catch(error => this.pause(error instanceof Error ? error.message : String(error)));
    }
  }

  private flush(): void {
    if (this.closed || this.status !== "shared" || this.sent || this.pending === undefined || this.applyingRemoteEdit) return;
    const text = this.pending;
    this.pending = undefined;
    this.sent = { text, baseRevision: this.revision };
    try {
      this.send({ type: "DOCUMENT_EDIT", roomId: this.roomId, documentPath: this.path,
        shareSessionId: this.shareSessionId, baseRevision: this.revision, text });
    } catch (error) {
      this.pause(error instanceof Error ? error.message : String(error));
      return;
    }
    this.ackTimer = setTimeout(() => this.pause("The server did not confirm the last edit"), this.ackTimeoutMs);
    this.ackTimer.unref();
  }

  private async applyRemote(text: string, revision: number): Promise<void> {
    const editorText = this.document.eol === this.api.EndOfLine.CRLF ? text.replace(/\n/g, "\r\n") : text;
    if (this.document.getText() === editorText) {
      this.revision = revision;
      this.confirmed = { text, revision };
      this.changed();
      return;
    }
    const edit = new this.api.WorkspaceEdit();
    edit.replace(this.document.uri, new this.api.Range(this.document.positionAt(0), this.document.positionAt(this.document.getText().length)), editorText);
    this.applyingRemoteEdit = true;
    this.applyingRemoteText = text;
    try {
      const applied = await this.api.workspace.applyEdit(edit);
      if (this.closed) return;
      if (!applied || normalizeDocumentText(this.document.getText()) !== text) this.enterConflict(text, revision);
      else {
        this.revision = revision;
        this.confirmed = { text, revision };
        this.changed();
      }
    } finally {
      this.applyingRemoteEdit = false;
      this.applyingRemoteText = undefined;
      this.flush();
    }
  }

  private enterConflict(text: string, revision: number): void {
    if (this.closed || revision < this.revision) return;
    this.clearAck();
    this.revision = revision;
    this.sent = undefined;
    this.pending = undefined;
    let attachRecovery = false;
    if (this.proposalPending) {
      this.recovery = { originalText: this.proposalPending.originalText, proposedText: this.proposalPending.proposedText,
        roomText: text, revision, reviewed: false, delivery: "not-shared" };
      attachRecovery = true;
      this.proposalPending = undefined;
      this.error = "A proposed combination was applied to the unsaved editor but was not shared. Inspect preserved versions before resolving this file.";
    } else if (this.recovery && (this.awaitingRecoverySync || this.conflict?.recovery === this.recovery)) {
      this.recovery = { ...this.recovery, roomText: text, revision, reviewed: false };
      attachRecovery = true;
    }
    this.awaitingRecoverySync = false;
    const snapshot = { localText: this.document.getText(), roomText: text, revision,
      baseText: this.confirmed?.text, recovery: attachRecovery ? this.recovery : undefined };
    this.conflict = snapshot;
    this.recoverySnapshots.push(snapshot);
    this.status = "conflict";
    this.changed();
  }

  private pause(reason: string): void {
    if (this.closed || this.status === "paused") return;
    this.clearAck();
    if (this.proposalPending) {
      this.recovery = { originalText: this.proposalPending.originalText, proposedText: this.proposalPending.proposedText,
        roomText: this.confirmed?.text ?? "", revision: this.revision, reviewed: false, delivery: "unconfirmed" };
      this.proposalPending = undefined;
    }
    this.pending = normalizeDocumentText(this.document.getText());
    this.sent = undefined;
    this.error = reason;
    this.status = "paused";
    try { this.send({ type: "CLOSE_DOCUMENT", roomId: this.roomId, documentPath: this.path, shareSessionId: this.shareSessionId }); }
    catch { /* The local draft and paused state remain available after socket failure. */ }
    this.changed();
  }

  private clearAck(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearAck();
    this.changeListener.dispose();
    this.closeListener.dispose();
    try { this.send({ type: "CLOSE_DOCUMENT", roomId: this.roomId, documentPath: this.path, shareSessionId: this.shareSessionId }); }
    catch { /* Connection may already have closed. */ }
  }
}
