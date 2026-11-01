const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");
const { adapter, delay, waitFor } = require("./cursor-presence.cjs");

const treeFile = require.resolve("../dist/providers/CodeMeshTreeProvider");
const treeModule = new Module(treeFile, module);
treeModule.filename = treeFile;
treeModule.paths = Module._nodeModulePaths(path.dirname(treeFile));
treeModule.require = (id) => id === "vscode" ? { ThemeIcon: class { constructor(id) { this.id = id; } } }
  : Module.prototype.require.call(treeModule, id);
treeModule._compile(fs.readFileSync(treeFile, "utf8"), treeFile);
const { CodeMeshTreeProvider } = treeModule.exports;

async function main() {
  const server = new CollaborationServer(0); server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.server.address().port}`;
  const ae = adapter("A", "\n"), be = adapter("B", "\r\n"), ce = adapter("C", "\n"), other = adapter("Other", "\n");
  const a = new ae.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "A", displayName: "Alice" } });
  const b = new be.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "B", displayName: "Bob" } });
  const c = new ce.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "C", displayName: "Casey" } });
  const outsider = new other.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "O", displayName: "Other" } });
  try {
    await a.createRoom(); await waitFor(() => a.getState().roomId, "room A");
    const roomId = a.getState().roomId;
    await b.joinRoom(roomId); await waitFor(() => b.getState().roomId === roomId, "room B");
    await outsider.createRoom(); await waitFor(() => outsider.getState().roomId && outsider.getState().roomId !== roomId, "isolated room");
    const isolatedRoom = outsider.getState().roomId;
    await c.joinRoom(isolatedRoom); await waitFor(() => c.getState().roomId === isolatedRoom, "C joins isolated room");
    await outsider.collaborateDocument(other.document);
    await c.collaborateDocument(ce.document);
    await waitFor(() => outsider.getState().documentStatus === "shared" && c.getState().documentStatus === "shared"
      && outsider.sharedFileSessions.has("C"), "same path shared in separate room");
    ce.select(0, 3);
    await waitFor(() => outsider.remoteCursors.has("C"), "same-room control cursor");
    await ce.userType("z");
    await waitFor(() => outsider.getState().typingMemberIds.includes("C"), "same-room control activity");
    assert.equal(a.remoteCursors.has("C") || b.remoteCursors.has("C"), false, "same path in a different room is isolated");
    assert.equal(a.getState().typingMemberIds.includes("C") || b.getState().typingMemberIds.includes("C"), false);
    c.stopDocumentCollaboration();
    await c.joinRoom(roomId); await waitFor(() => c.getState().roomId === roomId, "C switches to main room");

    await a.collaborateDocument(ae.document);
    await waitFor(() => a.getState().documentStatus === "shared" && a.localCursorShareId, "A shared file");
    assert.ok(b.getState().members.some((member) => member.memberId === "A"));
    assert.equal(b.getState().sharedFiles.some((file) => file.memberId === "B"), false, "Bob has not shared a file");
    assert.equal(b.getState().typingMemberIds.length, 0);
    const beforeShareNodes = CodeMeshTreeProvider.prototype.getChildren.call({ client: b });
    assert.ok(beforeShareNodes.some((node) => node.label === "Alice" && node.description === "src/shared.txt"));
    assert.ok(beforeShareNodes.some((node) => node.label === "Bob" && node.description === "No shared file"));

    await b.collaborateDocument(be.document);
    await waitFor(() => b.getState().documentStatus === "shared" && b.sharedFileSessions.has("A"), "both share same path");
    const beforePresenceText = [ae.document.text, be.document.text];
    const presenceFrames = [];
    const aSend = a.socket.send.bind(a.socket);
    a.socket.send = (raw, ...rest) => { const message = JSON.parse(raw); if (["CURSOR_UPDATE", "SELECTION_UPDATE", "TYPING_ACTIVITY"].includes(message.type)) presenceFrames.push(message); return aSend(raw, ...rest); };
    const bSend = b.socket.send.bind(b.socket), outboundB = [];
    b.socket.send = (raw, ...rest) => { const message = JSON.parse(raw); if (["CURSOR_UPDATE", "SELECTION_UPDATE", "TYPING_ACTIVITY"].includes(message.type)) outboundB.push(message); return bSend(raw, ...rest); };
    for (let index = 0; index < 24; index += 1) ae.selectRanges([
      { anchor: { line: 0, character: 1 }, active: { line: 0, character: 2 + index % 4 } }
    ]);
    ae.select(1, 2);
    await waitFor(() => b.remoteCursors.get("A")?.position.line === 1 && b.remoteCursors.get("A")?.position.character === 2
      && (!b.remoteSelections.has("A") || b.remoteSelections.get("A").ranges.length === 0), "latest rapid cursor and collapsed range");
    assert.ok(b.cursorDecorations.get("A").options.before.contentText.includes("Alice"));
    assert.match(b.cursorDecorations.get("A").options.before.color, /^hsl\(/);
    assert.equal(b.selectionDecorations.size, 0, "collapsed selection leaves no tint");
    assert.deepEqual([ae.document.text, be.document.text], beforePresenceText, "cursor and selection presence do not edit either buffer");
    assert.ok(presenceFrames.length && presenceFrames.every((message) => !Object.hasOwn(message, "text")
      && !JSON.stringify(message).includes("first")), "presence frames contain no document content");

    const shareA = b.sharedFileSessions.get("A");
    await ae.userType("x");
    await waitFor(() => b.getState().typingMemberIds.includes("A"), "same-file edit activity");
    const tree = CodeMeshTreeProvider.prototype.getChildren.call({ client: b });
    assert.ok(tree.some((node) => node.label === "Alice" && node.description === "src/shared.txt | Recent edit"));
    assert.ok(outboundB.every((message) => !JSON.stringify(message).includes("first")), "outgoing presence contains no file text");
    await waitFor(() => !a.documentEditInFlight && ae.document.text.replace(/\r\n/g, "\n") === be.document.text.replace(/\r\n/g, "\n"), "typed edit converges");
    ae.select(0, 2); ae.selectRanges([{ anchor: { line: 0, character: 1 }, active: { line: 0, character: 3 } }]);
    await waitFor(() => b.remoteCursors.get("A")?.position.character === 3 && b.remoteSelections.get("A")?.ranges.length === 1, "cursor and selection delivered");
    const tint = b.selectionDecorations.get("A").options.backgroundColor;
    assert.ok(tint.includes(b.cursorDecorations.get("A").options.before.color.slice(4, -1).split(",")[0]));
    assert.ok(presenceFrames.every((message) => !Object.hasOwn(message, "text") && !JSON.stringify(message).includes("xfirst")));
    assert.equal(ae.saves + be.saves + ce.saves + other.saves, 0);
    assert.equal(ae.document.text.replace(/\n/g, "\n"), be.document.text.replace(/\r\n/g, "\n"));
    console.log("PASS: explicit same-file sharing, LF/CRLF, cursor identity/color, collapsed and ranged selections, activity state, model label, and no presence text or saves");

    ce.document.text = ae.document.text;
    await c.collaborateDocument(ce.document);
    await waitFor(() => c.getState().documentStatus === "shared" && c.getState().typingMemberIds.includes("A"), "late join shares while lease active");
    assert.equal(c.remoteCursors.size, 0, "cursor location is not replayed to late joiners");
    assert.equal(c.remoteSelections.size, 0, "selection is not replayed to late joiners");
    await waitFor(() => !b.getState().typingMemberIds.includes("A") && !c.getState().typingMemberIds.includes("A"), "typing lease and stop expire");
    console.log("PASS: late same-file join receives active lease only; no stale cursor or selection replay; activity expires");

    const oldCursor = { type: "CURSOR_UPDATE", roomId, documentPath: "src/shared.txt", presenceSessionId: b.presenceSessionId,
      shareId: shareA, memberId: "A", sequence: 100, position: { line: 0, character: 0 } };
    const oldSelection = { type: "SELECTION_UPDATE", roomId, documentPath: "src/shared.txt", presenceSessionId: b.presenceSessionId,
      shareId: shareA, memberId: "A", sequence: 100, documentRevision: 0, ranges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }] };
    const oldTyping = { type: "TYPING_ACTIVITY", roomId, documentPath: "src/shared.txt", presenceSessionId: b.presenceSessionId,
      shareId: shareA, memberId: "A", sequence: 100, active: true, leaseMs: 1800 };
    await a.stopDocumentCollaboration();
    await waitFor(() => !b.sharedFileSessions.has("A") && !b.remoteCursors.has("A") && !b.remoteSelections.has("A")
      && !b.getState().typingMemberIds.includes("A"), "End Sharing clears all presence");
    const oldShare = shareA;
    await a.collaborateDocument(ae.document);
    await waitFor(() => b.sharedFileSessions.has("A") && b.sharedFileSessions.get("A") !== oldShare, "new share session");
    b.handleServerMessage(JSON.stringify(oldCursor));
    b.handleServerMessage(JSON.stringify(oldSelection));
    b.handleServerMessage(JSON.stringify(oldTyping));
    assert.equal(b.remoteCursors.has("A") || b.remoteSelections.has("A") || b.getState().typingMemberIds.includes("A"), false,
      "old session frames do not revive Alice state");

    be.document.uri = { fsPath: "C:\\B\\src\\other.txt", toString: () => "file:///B/src/other.txt" };
    b.stopDocumentCollaboration();
    await waitFor(() => !a.getState().sharedFiles.some((file) => file.memberId === "B"), "old path ends");
    await b.collaborateDocument(be.document);
    await waitFor(() => b.getState().sharedFiles.some((file) => file.memberId === "B" && file.documentPath === "src/other.txt"), "B shares another path");
    ae.select(0, 1); await delay(100);
    assert.equal(b.remoteCursors.has("A"), false, "different path sees no cursor from Alice");
    assert.equal(b.getState().typingMemberIds.includes("A"), false, "different path sees no activity");
    assert.equal(outsider.getState().sharedFiles.some((file) => file.memberId === "A" || file.memberId === "B"), false,
      "same path in another room remains isolated");
    console.log("PASS: end/re-share rejects delayed old sessions; different paths and rooms receive no presence");

    be.document.uri = { fsPath: "C:\\B\\src\\shared.txt", toString: () => "file:///B/src/shared.txt" };
    be.document.text = ae.document.text;
    b.stopDocumentCollaboration();
    await b.collaborateDocument(be.document);
    await waitFor(() => b.sharedFileSessions.has("A") && b.getState().documentStatus === "shared", "same path restored");
    ae.select(1, 2);
    await waitFor(() => b.remoteCursors.has("A"), "cursor before invalidating edit");
    be.type("short");
    await waitFor(() => a.documentEditInFlight === false && aEditorDocumentText(a) === "short", "coordinate-invalidating edit converges");
    assert.equal(b.remoteCursors.has("A"), false, "text edits clear stale cursor decorations immediately");
    assert.equal(b.remoteSelections.has("A"), false, "text edits clear stale selection decorations immediately");
    b.handleServerMessage(JSON.stringify({ ...oldSelection, shareId: b.sharedFileSessions.get("A"),
      presenceSessionId: b.presenceSessionId, sequence: 101, documentRevision: Math.max(0, b.sharedDocumentRevision - 1) }));
    assert.equal(b.remoteSelections.size, 0, "old document revision cannot restore a highlight");

    const beforeDisk = ae.saves + be.saves + ce.saves + other.saves;
    ae.closes.fire(ae.document);
    await waitFor(() => !b.getState().sharedFiles.some((file) => file.memberId === "A")
      && !b.remoteCursors.has("A") && !b.remoteSelections.has("A") && !b.getState().typingMemberIds.includes("A"), "close and end cleanup");
    await b.leaveRoom();
    assert.deepEqual(b.getState().sharedFiles, []);
    assert.deepEqual(b.getState().typingMemberIds, []);
    await b.joinRoom(roomId); await waitFor(() => b.getState().roomId === roomId, "leave and rejoin");
    assert.equal(b.getState().sharedDocumentPath, undefined, "reconnect/rejoin requires explicit share");
    await b.collaborateDocument(be.document);
    await waitFor(() => b.getState().documentStatus === "shared", "explicit re-share after join");
    b.socket.terminate();
    await waitFor(() => a.getState().sharedFiles.every((file) => file.memberId !== "B"), "disconnect clears shared path");
    await waitFor(() => b.getState().roomId === roomId && !b.getState().sharedDocumentPath, "reconnect restores room only");
    await b.createRoom(); await waitFor(() => b.getState().roomId && b.getState().roomId !== roomId, "room switch");
    assert.equal(b.getState().sharedFiles.length, 0);
    assert.equal(b.getState().typingMemberIds.length, 0);
    assert.equal(ae.saves + be.saves + ce.saves + other.saves, beforeDisk, "presence causes no saves");
    console.log("PASS: edit coordinate invalidation, leave/disconnect/reconnect/room switch cleanup, no stale decorations and no saves");
  } finally {
    a.dispose(); b.dispose(); c.dispose(); outsider.dispose();
    await new Promise((resolve) => server.server.close(resolve));
  }
}

function aEditorDocumentText(client) { return client.sharedDocument?.getText(); }

main().catch((error) => { console.error(error); process.exitCode = 1; });
