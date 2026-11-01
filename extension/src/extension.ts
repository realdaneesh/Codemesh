import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";
import { CodeMeshTreeProvider } from "./providers/CodeMeshTreeProvider";
import { CodeMeshClient } from "./services/CodeMeshClient";
import { CodeMeshStatusBar } from "./ui/CodeMeshStatusBar";

export function activate(context: vscode.ExtensionContext): void {
  const client = new CodeMeshClient();
  const treeProvider = new CodeMeshTreeProvider(client);
  const statusBar = new CodeMeshStatusBar(client);

  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri: async uri => {
      try { await client.joinInvitation(uri.toString()); }
      catch { vscode.window.showErrorMessage("CodeMesh: invalid invitation or connection failed"); }
    } }),
    client,
    treeProvider,
    statusBar,
    vscode.window.registerTreeDataProvider("codemesh.sidebar", treeProvider)
  );

  registerCommands(context, client);
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered during activation.
}
