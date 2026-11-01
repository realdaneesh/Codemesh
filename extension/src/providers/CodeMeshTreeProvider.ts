import * as vscode from "vscode";
import type { CodeMeshClient } from "../services/CodeMeshClient";
import type { Member } from "../types/protocol";
import { getPresenceViewModel } from "../ui/presenceViewModel";
import { getWorkspaceViewModel } from "../ui/workspaceViewModel";

type TreeItemKind = "heading" | "status" | "room" | "member" | "empty" | "command";

interface CodeMeshTreeNode {
  kind: TreeItemKind;
  label: string;
  description?: string;
  command?: vscode.Command;
  icon?: vscode.ThemeIcon;
}

export class CodeMeshTreeProvider implements vscode.TreeDataProvider<CodeMeshTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<CodeMeshTreeNode | undefined | null | void>();
  private readonly stateSubscription: vscode.Disposable;
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly client: CodeMeshClient) {
    this.stateSubscription = this.client.onDidChangeState(() => this.refresh());
  }

  dispose(): void {
    this.stateSubscription.dispose();
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: CodeMeshTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.command = element.command;
    item.iconPath = element.icon;
    return item;
  }

  getChildren(): CodeMeshTreeNode[] {
    const state = this.client.getState();
    const sessions = this.client.getDocumentSessions();
    const presence = getPresenceViewModel(state);
    const workspace = getWorkspaceViewModel(state);
    return [
      { kind: "heading", label: "CODEMESH", icon: new vscode.ThemeIcon("mesh") },
      { kind: "status", label: "Connection", description: presence.statusLabel },
      { kind: "room", label: "Active Room", description: presence.roomLabel },
      { kind: "status", label: "Presence", description: presence.memberCountLabel },
      { kind: "heading", label: "Shared Files" },
      ...(sessions.length ? sessions.map(session => ({
        kind: "status" as const, label: session.path,
        description: session.status === "conflict" ? "paused/conflict" : session.status,
        icon: new vscode.ThemeIcon(session.status === "shared" ? "file-code" : "warning")
      })) : [{ kind: "empty" as const, label: "None" }]),
      ...sessions.map(session => ({ kind: "command" as const, label: `End Sharing: ${session.path}`,
        command: { command: "codemesh.endSharing", title: `End Sharing: ${session.path}`, arguments: [session.path] } })),
      ...(state.documentStatus === "paused" || (state.documentStatus === "conflict" && state.documentError) ? [{
        kind: "status" as const, label: "Live Sync", description: `Paused: ${state.documentError ?? "waiting for explicit re-share"}`,
        icon: new vscode.ThemeIcon("warning")
      }] : []),
      ...(state.documentStatus === "conflict" && state.documentError ? [{
        kind: "command" as const, label: `Inspect Preserved Versions: ${state.sharedDocumentPath}`,
        command: { command: "codemesh.inspectRecoveryVersions", title: "Inspect Preserved Versions", arguments: [state.sharedDocumentPath] }
      }, {
        kind: "command" as const, label: `Start Fresh Comparison: ${state.sharedDocumentPath}`,
        command: { command: "codemesh.inspectDifferences", title: "Start Fresh Comparison", arguments: [state.sharedDocumentPath] }
      }] : []),
      ...sessions.filter(session => session.status === "conflict" && session.path !== state.sharedDocumentPath).flatMap(session => [
        { kind: "command" as const, label: `Inspect Differences: ${session.path}`,
          command: { command: "codemesh.inspectDifferences", title: "Inspect Differences", arguments: [session.path] } },
        { kind: "command" as const, label: `Preview Combined Text: ${session.path}`,
          command: { command: "codemesh.previewCombinedText", title: "Preview Combined Text", arguments: [session.path] } },
        { kind: "command" as const, label: `Inspect Preserved Versions: ${session.path}`,
          command: { command: "codemesh.inspectRecoveryVersions", title: "Inspect Preserved Versions", arguments: [session.path] } }
      ]),
      { kind: "status", label: "Workspace", description: workspace.label },
      { kind: "status", label: "Manifest", description: workspace.summary },
      ...(state.workspaceChanges ? [{
        kind: "command" as const, label: "Workspace Changes",
        description: state.workspaceChanges.added.length + " added, " + state.workspaceChanges.changed.length + " changed, " + state.workspaceChanges.removed.length + " removed",
        command: { command: "codemesh.workspaceChanges", title: "Workspace Changes" }
      }] : []),
      ...memberNodes(presence.hasActiveRoom ? state.members : [], state.sharedFiles, state.openSharedFiles,
        state.typingMemberIds, state.recentEditFiles),
      {
        kind: "command", label: "Share Workspace", icon: new vscode.ThemeIcon("folder"),
        command: { command: "codemesh.shareWorkspace", title: "Share Workspace" }
      },
      ...(state.ownsWorkspaceManifest ? [{
        kind: "command" as const, label: "Refresh Shared Workspace", icon: new vscode.ThemeIcon("refresh"),
        command: { command: "codemesh.refreshWorkspace", title: "Refresh Shared Workspace" }
      }, {
        kind: "command" as const, label: "End Workspace Sharing", icon: new vscode.ThemeIcon("close"),
        command: { command: "codemesh.endWorkspaceSharing", title: "End Workspace Sharing" }
      }] : []),
      ...(state.workspaceManifest ? [{
        kind: "command" as const, label: "Preview Workspace File", icon: new vscode.ThemeIcon("preview"),
        command: { command: "codemesh.requestFile", title: "Preview Workspace File" }
      }] : []),
      {
        kind: "command",
        label: "Create Room",
        icon: new vscode.ThemeIcon("add"),
        command: {
          command: "codemesh.createRoom",
          title: "Create Room"
        }
      },
      {
        kind: "command",
        label: "Join Room",
        icon: new vscode.ThemeIcon("plug"),
        command: {
          command: "codemesh.joinRoom",
          title: "Join Room"
        }
      },
      {
        kind: "command",
        label: "Leave Room",
        icon: new vscode.ThemeIcon("sign-out"),
        description: presence.hasActiveRoom ? undefined : "No active room",
        command: {
          command: "codemesh.leaveRoom",
          title: "Leave Room"
        }
      }
    ];
  }
}

function memberNodes(members: Member[], sharedFiles: { memberId: string; documentPath: string }[],
  openSharedFiles: { memberId: string; documentPath: string; shareSessionId: string }[], typingMemberIds: string[],
  recentEditFiles: { memberId: string; documentPath: string; shareSessionId: string }[]): CodeMeshTreeNode[] {
  if (members.length === 0) {
    return [
      { kind: "heading", label: "Members" },
      { kind: "empty", label: "None" }
    ];
  }

  return [
    { kind: "heading", label: "Members" },
    ...members.map((member) => ({
      kind: "member" as const,
      label: member.role ? `${member.displayName} [${member.role}]` : member.displayName,
      description: (() => {
        const paths = openSharedFiles.filter(file => file.memberId === member.memberId);
        if (paths.length) return paths.map(file => `${file.documentPath}${recentEditFiles.some(edit =>
          edit.memberId === member.memberId && edit.documentPath === file.documentPath
          && edit.shareSessionId === file.shareSessionId) || (typingMemberIds.includes(member.memberId)
            && !recentEditFiles.some(edit => edit.memberId === member.memberId)
            && sharedFiles.some(shared => shared.memberId === member.memberId && shared.documentPath === file.documentPath))
          ? " | Recent edit" : ""}`).join(", ");
        const path = sharedFiles.find(file => file.memberId === member.memberId)?.documentPath;
        return path ? (typingMemberIds.includes(member.memberId) ? `${path} | Recent edit` : path) : "No shared file";
      })(),
      icon: new vscode.ThemeIcon("account")
    }))
  ];
}
