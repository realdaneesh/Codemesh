import type * as vscode from "vscode";
import { TestEditorBinding } from "./binding";

export const UNDO_LOCAL_COMMAND = "codemesh.prototype.undoLocal";
export const REDO_LOCAL_COMMAND = "codemesh.prototype.redoLocal";

type CommandAPI = Pick<typeof vscode, "commands" | "window">;

// These commands are intentionally separate from VS Code's global undo/redo.
export function registerPrototypeUndoCommands(api: CommandAPI, bindings: Map<vscode.TextDocument, TestEditorBinding>): vscode.Disposable {
  const invoke = async (direction: "undo" | "redo"): Promise<boolean> => {
    const document = api.window.activeTextEditor?.document;
    const binding = document && bindings.get(document);
    if (!binding) return false;
    return direction === "undo" ? binding.undoLocal() : binding.redoLocal();
  };
  const undo = api.commands.registerCommand(UNDO_LOCAL_COMMAND, () => invoke("undo"));
  const redo = api.commands.registerCommand(REDO_LOCAL_COMMAND, () => invoke("redo"));
  return { dispose: () => { undo.dispose(); redo.dispose(); bindings.clear(); } };
}
