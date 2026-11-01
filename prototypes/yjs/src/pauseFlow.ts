import type * as vscode from "vscode";
import { TestEditorBinding } from "./binding";
import { ExperimentalClient } from "./transport";

export const PAUSE_CHOICES = ["Inspect Draft", "Use Room Text", "End Sharing"] as const;
export type PauseChoice = typeof PAUSE_CHOICES[number];
type PauseAPI = Pick<typeof vscode, "window" | "workspace" | "ViewColumn">;

// Test-host UX only. No global shortcuts or production extension registration.
export class PrototypePauseFlow {
  constructor(private readonly api: PauseAPI, private readonly document: vscode.TextDocument,
    private readonly binding: TestEditorBinding, private readonly client: ExperimentalClient) {}

  async present(): Promise<string> {
    const status = this.binding.getStatus();
    if (status.status !== "paused") throw new Error("Document is not paused");
    const reason = status.reason?.startsWith("CRDT session quarantined")
      ? this.client.errors.at(-1) ?? status.reason : status.reason;
    const choice = await this.api.window.showWarningMessage(
      "CRDT sharing paused: " + (reason ?? "The editor could not be reconciled safely") +
      ". Your unsaved draft remains in the editor. Native Undo/Redo is not local-only while sharing; use the prototype Undo Local/Redo Local commands only after recovery.",
      { modal: true }, ...PAUSE_CHOICES);
    return this.choose(choice);
  }

  async choose(choice: PauseChoice | undefined): Promise<string> {
    const status = this.binding.getStatus();
    if (status.status !== "paused") throw new Error("Document is no longer paused");
    if (!choice) return "dismissed";
    if (choice === "Inspect Draft") {
      const draft = status.draft ?? status.latestDraft ?? this.document.getText();
      const preview = await this.api.workspace.openTextDocument({ content: draft, language: this.document.languageId });
      await this.api.window.showTextDocument(preview, { preview: true, viewColumn: this.api.ViewColumn.Beside });
      return "inspected";
    }
    if (choice === "Use Room Text") {
      try { await this.binding.useRoomText(); }
      catch (error) {
        await this.api.window.showWarningMessage("Room text is unavailable until recovery: " + String(error));
        return "paused";
      }
      return this.binding.getStatus().status === "active" ? "resumed" : "paused";
    }
    if (choice === "End Sharing") {
      this.binding.dispose();
      this.client.disconnect();
      return "ended";
    }
    throw new Error("Unknown pause choice");
  }
}
