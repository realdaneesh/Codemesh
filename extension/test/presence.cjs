const assert = require("node:assert/strict");
const { getPresenceViewModel } = require("../dist/ui/presenceViewModel");

const self = { memberId: "self", displayName: "Self" };

function state(overrides) {
  return {
    connectionState: "disconnected",
    roomId: undefined,
    members: [],
    self,
    ...overrides
  };
}

assert.deepEqual(
  pick(getPresenceViewModel(state({ connectionState: "disconnected", roomId: "ABC123", members: [self] }))),
  {
    statusLabel: "Disconnected",
    roomLabel: "None",
    memberCountLabel: "0 members",
    statusBarText: "$(debug-disconnect) CodeMesh: Disconnected",
    hasActiveRoom: false
  }
);

assert.deepEqual(
  pick(getPresenceViewModel(state({ connectionState: "reconnecting", roomId: "ABC123", members: [self] }))),
  {
    statusLabel: "Reconnecting",
    roomLabel: "None",
    memberCountLabel: "0 members",
    statusBarText: "$(sync~spin) CodeMesh: Reconnecting",
    hasActiveRoom: false
  }
);

assert.deepEqual(
  pick(getPresenceViewModel(state({ connectionState: "connecting" }))),
  {
    statusLabel: "Connecting",
    roomLabel: "None",
    memberCountLabel: "0 members",
    statusBarText: "$(sync~spin) CodeMesh: Connecting",
    hasActiveRoom: false
  }
);

assert.deepEqual(
  pick(getPresenceViewModel(state({ connectionState: "connected" }))),
  {
    statusLabel: "Connected",
    roomLabel: "None",
    memberCountLabel: "0 members",
    statusBarText: "$(plug) CodeMesh: Connected",
    hasActiveRoom: false
  }
);

assert.deepEqual(
  pick(getPresenceViewModel(state({
    connectionState: "connected",
    roomId: "ABC123",
    members: [
      self,
      { memberId: "peer", displayName: "Peer" }
    ]
  }))),
  {
    statusLabel: "Connected",
    roomLabel: "ABC123",
    memberCountLabel: "2 members",
    statusBarText: "$(broadcast) CodeMesh: ABC123 (2)",
    hasActiveRoom: true
  }
);

console.log("PASS: presence view model states");

function pick(viewModel) {
  return {
    statusLabel: viewModel.statusLabel,
    roomLabel: viewModel.roomLabel,
    memberCountLabel: viewModel.memberCountLabel,
    statusBarText: viewModel.statusBarText,
    hasActiveRoom: viewModel.hasActiveRoom
  };
}
