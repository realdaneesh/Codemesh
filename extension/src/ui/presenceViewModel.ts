import type { CodeMeshState } from "../services/CodeMeshClient";

export interface PresenceViewModel {
  statusLabel: string;
  roomLabel: string;
  memberCountLabel: string;
  statusBarText: string;
  statusBarTooltip: string;
  hasActiveRoom: boolean;
}

export function getPresenceViewModel(state: CodeMeshState): PresenceViewModel {
  const hasActiveRoom = state.connectionState === "connected" && Boolean(state.roomId);
  const memberCount = hasActiveRoom ? state.members.length : 0;

  if (state.connectionState === "connecting" || state.connectionState === "reconnecting") {
    const reconnecting = state.connectionState === "reconnecting";
    return {
      statusLabel: reconnecting ? "Reconnecting" : "Connecting",
      roomLabel: "None",
      memberCountLabel: "0 members",
      statusBarText: `$(sync~spin) CodeMesh: ${reconnecting ? "Reconnecting" : "Connecting"}`,
      statusBarTooltip: `CodeMesh is ${reconnecting ? "reconnecting" : "connecting"} to the room server.`,
      hasActiveRoom: false
    };
  }

  if (state.connectionState === "disconnected") {
    return {
      statusLabel: "Disconnected",
      roomLabel: "None",
      memberCountLabel: "0 members",
      statusBarText: "$(debug-disconnect) CodeMesh: Disconnected",
      statusBarTooltip: "CodeMesh is disconnected. Click to open room actions.",
      hasActiveRoom: false
    };
  }

  if (!state.roomId) {
    return {
      statusLabel: "Connected",
      roomLabel: "None",
      memberCountLabel: "0 members",
      statusBarText: "$(plug) CodeMesh: Connected",
      statusBarTooltip: "CodeMesh is connected. Click to create or join a room.",
      hasActiveRoom: false
    };
  }

  return {
    statusLabel: "Connected",
    roomLabel: state.roomId,
    memberCountLabel: `${memberCount} ${memberCount === 1 ? "member" : "members"}`,
    statusBarText: `$(broadcast) CodeMesh: ${state.roomId} (${memberCount})`,
    statusBarTooltip: `CodeMesh room ${state.roomId} with ${memberCount} ${memberCount === 1 ? "member" : "members"}. Click to open room actions.`,
    hasActiveRoom
  };
}
