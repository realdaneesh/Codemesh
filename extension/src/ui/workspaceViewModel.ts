import type { CodeMeshState } from "../services/CodeMeshClient";

export function getWorkspaceViewModel(state: CodeMeshState): { label: string; summary: string } {
  const manifest = state.workspaceManifest;
  if (!state.roomId || !manifest) return { label: "Not shared", summary: "0 files" };
  const bytes = manifest.files.reduce((total, file) => total + BigInt(file.size), 0n);
  return {
    label: manifest.workspaceName,
    summary: `${manifest.files.length} files, ${bytes.toString()} bytes${state.ownsWorkspaceManifest ? " (yours)" : ""}`
  };
}
