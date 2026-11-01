import * as vscode from "vscode";
import type { CodeMeshClient } from "../services/CodeMeshClient";
import { getPresenceViewModel } from "./presenceViewModel";
import { getWorkspaceViewModel } from "./workspaceViewModel";

export class CodeMeshStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly stateSubscription: vscode.Disposable;

  constructor(private readonly client: CodeMeshClient) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = "CodeMesh";
    this.item.command = "codemesh.showActions";
    this.stateSubscription = this.client.onDidChangeState(() => this.update());
    this.update();
    this.item.show();
  }

  dispose(): void {
    this.stateSubscription.dispose();
    this.item.dispose();
  }

  private update(): void {
    const state = this.client.getState();
    const viewModel = getPresenceViewModel(state);
    const sessions = this.client.getDocumentSessions();
    const documentLabel = sessions.length
      ? sessions.map(session => `${session.path} (${session.status === "conflict" ? "paused/conflict" : session.status})`).join(" | ")
      : "No shared file";
    this.item.text = `${viewModel.statusBarText} | ${documentLabel}`;
    this.item.tooltip = `${viewModel.statusBarTooltip}\n${documentLabel}`;
    for (const session of sessions) if (session.error)
      this.item.tooltip += `\n${session.path}: ${session.error}. Unsaved draft preserved.`;
    if (state.workspaceManifest) {
      const workspace = getWorkspaceViewModel(state);
      this.item.tooltip += `\nWorkspace: ${workspace.label}\n${workspace.summary}`;
    }
  }
}
