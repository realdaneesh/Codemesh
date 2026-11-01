const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
class EventEmitter {
  constructor() { this.event = () => ({ dispose() {} }); }
  fire() {}
  dispose() {}
}
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return {
    EventEmitter, ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0 }
  };
  return original.call(this, request, parent, isMain);
};
const { CodeMeshTreeProvider } = require("../dist/providers/CodeMeshTreeProvider");
Module._load = original;

const self = { memberId: "self", displayName: "Self" }, peer = { memberId: "peer", displayName: "Peer" };
const state = { connectionState: "connected", roomId: "ABC234", self, members: [self, peer], sharedFiles: [], openSharedFiles: [], recentEditFiles: [], typingMemberIds: [] };
const provider = new CodeMeshTreeProvider({ getState: () => state, getDocumentSessions: () => [], onDidChangeState: () => ({ dispose() {} }) });
const members = () => provider.getChildren().filter((node) => node.kind === "member")
  .map((node) => [node.label, node.description]);
assert.deepEqual(members(), [["Self", "No shared file"], ["Peer", "No shared file"]]);
self.role = 'host'; peer.role = 'guest';
assert.deepEqual(members(), [["Self [host]", "No shared file"], ["Peer [guest]", "No shared file"]]);
delete self.role; delete peer.role;
state.sharedFiles = [{ memberId: "self", documentPath: "src/a.txt" }, { memberId: "peer", documentPath: "src/b.txt" }];
assert.deepEqual(members(), [["Self", "src/a.txt"], ["Peer", "src/b.txt"]]);
state.sharedFiles = [{ memberId: "self", documentPath: "src/a.txt" }];
assert.deepEqual(members(), [["Self", "src/a.txt"], ["Peer", "No shared file"]]);
state.documentStatus = 'conflict';
state.documentError = 'Unsaved proposal in editor, NOT shared';
assert.ok(provider.getChildren().some(node => node.label === 'Live Sync' && node.description.includes('NOT shared')));
assert.ok(provider.getChildren().some(node => node.command?.command === 'codemesh.inspectRecoveryVersions'));
assert.ok(provider.getChildren().some(node => node.command?.command === 'codemesh.inspectDifferences'));
assert.deepEqual(members(), [["Self", "src/a.txt"], ["Peer", "No shared file"]]);
state.documentError = undefined;
assert.equal(provider.getChildren().some(node => node.command?.command === 'codemesh.inspectRecoveryVersions'), false);
state.connectionState = "reconnecting"; state.roomId = undefined;
assert.deepEqual(members(), []);
provider.dispose();
console.log("PASS: sidebar member paths, No shared file, recovery notice/actions, and reconnect hiding");
