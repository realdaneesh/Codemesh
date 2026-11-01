import * as vscode from "vscode";
import type { CodeMeshClient } from "../services/CodeMeshClient";

export function registerCommands(context: vscode.ExtensionContext, client: CodeMeshClient): void {
  const conflictPath = async (path?: string): Promise<string | undefined> => {
    if (path) return path;
    const conflicted = client.getDocumentSessions().filter(session => session.status === "conflict");
    if (conflicted.length === 1) return conflicted[0].path;
    if (conflicted.length > 1) return (await vscode.window.showQuickPick(
      conflicted.map(session => ({ label: session.path })),
      { title: "Choose Conflicted File", placeHolder: "Select the file for this recovery action" }))?.label;
    return undefined;
  };
  const updateImportContext = () => {
    void vscode.commands.executeCommand?.("setContext", "codemesh.canImportPreview", client.canImportPreview());
    void vscode.commands.executeCommand?.("setContext", "codemesh.ownsWorkspace", Boolean(client.getState().ownsWorkspaceManifest));
  };
  context.subscriptions.push(client.onDidChangeState(updateImportContext));
  if (vscode.window.onDidChangeActiveTextEditor) context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateImportContext));
  updateImportContext();
  context.subscriptions.push(
    vscode.commands.registerCommand("codemesh.inspectRecoveryVersions", async (path?: string) => {
      try {
        const candidates = client.getDocumentSessions().filter(session => client.hasRecoveryVersions(session.path));
        const selected = path ?? (candidates.length === 1 ? candidates[0].path : candidates.length > 1
          ? (await vscode.window.showQuickPick(candidates.map(session => ({ label: session.path })),
            { title: "Choose Preserved Versions" }))?.label : undefined);
        if (selected) await client.inspectRecoveryVersions(selected);
      } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand("codemesh.previewCombinedText", async (path?: string) => {
      try { const selected = await conflictPath(path); if (selected) await client.previewCombinedText(selected); } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand("codemesh.inspectDifferences", async (path?: string) => {
      try { const selected = await conflictPath(path); if (selected) await client.inspectConflictDifferences(selected); } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand("codemesh.refreshWorkspace", async () => {
      try { await client.refreshWorkspace(); } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand("codemesh.workspaceChanges", async () => {
      const changes = client.getState().workspaceChanges;
      if (!changes) return;
      await vscode.window.showQuickPick(
        ["added", "changed", "removed"].flatMap((kind) => changes[kind as keyof typeof changes].map((path) => ({ label: path, description: kind }))),
        { title: "Shared Workspace Changes", placeHolder: "Latest refresh" }
      );
    }),
    vscode.commands.registerCommand("codemesh.importWorkspace", async () => {
      try { await client.importWorkspace(); } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand("codemesh.importFile", async (uri?: vscode.Uri) => {
      try {
        const destination = await client.importFile(uri);
        if (destination) vscode.window.showInformationMessage("CodeMesh imported: " + destination);
      } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand("codemesh.showActions", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.codemesh");
      const sessions = client.getDocumentSessions();
      const activePath = vscode.window.activeTextEditor
        ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri, false).replace(/\\/g, "/") : undefined;
      const action = await vscode.window.showQuickPick(
        [
          { label: "Create Room", command: "codemesh.createRoom" },
          { label: "Copy Invite Link", command: "codemesh.copyInviteLink" },
          { label: "Join Room", command: "codemesh.joinRoom" },
          { label: `Share Current File${activePath ? `: ${activePath}` : ""}`, command: "codemesh.shareFile" },
          { label: "Share Workspace", command: "codemesh.shareWorkspace" },
          ...(client.getState().ownsWorkspaceManifest ? [{ label: "Refresh Shared Workspace", command: "codemesh.refreshWorkspace" }] : []),
          ...(client.getState().workspaceChanges ? [{ label: "Workspace Changes", command: "codemesh.workspaceChanges" }] : []),
          { label: "Import Workspace Files", command: "codemesh.importWorkspace" },
          { label: "Preview Workspace File", command: "codemesh.requestFile" },
          { label: "End Workspace Sharing", command: "codemesh.endWorkspaceSharing" },
          ...sessions.map(session => ({ label: `End Sharing: ${session.path}`, command: "codemesh.endSharing", path: session.path })),
          ...sessions.filter(session => session.status === "conflict").flatMap(session => [
            { label: `Inspect Differences: ${session.path}`, command: "codemesh.inspectDifferences", path: session.path },
            { label: `Preview Combined Text: ${session.path}`, command: "codemesh.previewCombinedText", path: session.path }
          ]),
          ...sessions.filter(session => client.hasRecoveryVersions(session.path)).map(session => ({
            label: `Inspect Preserved Versions: ${session.path}`, command: "codemesh.inspectRecoveryVersions", path: session.path
          })),
          { label: "Leave Room", command: "codemesh.leaveRoom" }
        ],
        {
          title: "CodeMesh Room Actions",
          placeHolder: "Choose a room action"
        }
      );

      if (action) {
        await vscode.commands.executeCommand(action.command, "path" in action ? action.path : undefined);
      }
    }),
    vscode.commands.registerCommand("codemesh.copyInviteLink", async () => {
      try { await client.copyInviteLink(); } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand("codemesh.revokeInvitations", () => {
      try { client.revokeInvitations(); } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand("codemesh.createRoom", async () => {
      try {
        await client.createRoom();
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("codemesh.joinRoom", async () => {
      const roomId = await vscode.window.showInputBox({
        title: "Join CodeMesh Room",
        prompt: "Paste an invitation link, or a trusted LAN room ID",
        placeHolder: "ABC123",
        validateInput: (value) => {
          if (/^vscode(?:-insiders)?:\/\//.test(value.trim())) return undefined;
          if (!value.trim()) return "Invitation or room ID is required";
          return /^[A-HJ-NP-Z2-9]{6}$/.test(value.trim().toUpperCase())
            ? undefined
            : "Enter a valid six-character room ID";
        }
      });

      if (!roomId) {
        return;
      }

      try {
        await client.joinRoom(roomId.trim());
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("codemesh.leaveRoom", () => {
      try {
        client.leaveRoom();
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("codemesh.endSharing", async (requestedPath?: string) => {
      const sessions = client.getDocumentSessions();
      const path = requestedPath ?? (sessions.length === 1 ? sessions[0].path :
        (await vscode.window.showQuickPick(sessions.map(session => ({ label: session.path, description: session.status })),
          { title: "End Sharing", placeHolder: "Choose the file to stop sharing" }))?.label);
      if (path && sessions.some(session => session.path === path)) client.stopDocumentSession(path);
    }),
    vscode.commands.registerCommand("codemesh.endWorkspaceSharing", () => client.stopWorkspaceSharing()),
    vscode.commands.registerCommand("codemesh.requestFile", async (requestedPath?: string) => {
      try {
        const manifest = client.getState().workspaceManifest;
        if (!manifest) throw new Error("No workspace manifest is shared in this room");
        const selected = requestedPath ?? (await vscode.window.showQuickPick(
          manifest.files.map((file) => ({ label: file.path, description: file.size + " bytes" })),
          { title: "Preview Workspace File", placeHolder: "Select one shared UTF-8 text file" }
        ))?.label;
        if (selected) await client.requestFile(selected);
      } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand("codemesh.shareWorkspace", async () => {
      try {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) throw new Error("Open a workspace folder before sharing it");
        const selected = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
          folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
          { title: "Share Workspace", placeHolder: "Select a workspace folder" }
        ))?.folder;
        if (selected) await client.shareWorkspace(selected);
      } catch (error) { showError(error); }
    }),
    vscode.commands.registerCommand("codemesh.shareFile", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) {
        vscode.window.showErrorMessage("CodeMesh: Open a text file before sharing it");
        return;
      }

      try {
        await client.shareDocumentForService(document);
      } catch (error) {
        showError(error);
      }
    })
  );
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown CodeMesh error";
  vscode.window.showErrorMessage(`CodeMesh: ${message}`);
}
