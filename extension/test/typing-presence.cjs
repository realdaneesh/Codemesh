const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");
const { adapter, delay, waitFor } = require("./cursor-presence.cjs");

const filename = require.resolve("../dist/providers/CodeMeshTreeProvider");
const isolated = new Module(filename, module);
isolated.filename = filename;
isolated.paths = Module._nodeModulePaths(path.dirname(filename));
isolated.require = (id) => id === "vscode" ? { ThemeIcon: class { constructor(id) { this.id = id; } } }
  : Module.prototype.require.call(isolated, id);
isolated._compile(fs.readFileSync(filename, "utf8"), filename);
const { CodeMeshTreeProvider } = isolated.exports;

async function main() {
  const server = new CollaborationServer(0); server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.server.address().port}`;
  const aEditor = adapter("A", "\n"), bEditor = adapter("B", "\r\n"), cEditor = adapter("C", "\n");
  const a = new aEditor.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "A", displayName: "Alice" } });
  const b = new bEditor.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "B", displayName: "Bob" } });
  const c = new cEditor.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "C", displayName: "Carol" } });
  try {
    await a.createRoom(); await waitFor(() => a.getState().roomId, "A creates room");
    const roomId = a.getState().roomId;
    await b.joinRoom(roomId); await waitFor(() => b.getState().roomId === roomId, "B joins room");
    await a.collaborateDocument(aEditor.document);
    await b.collaborateDocument(bEditor.document);
    await waitFor(() => a.localCursorShareId && b.sharedFileSessions.has("A") && b.getState().documentStatus === "shared", "both share file");
    const sent = [];
    const send = a.socket.send.bind(a.socket);
    a.socket.send = (raw, ...rest) => { const message = JSON.parse(raw); if (message.type === "TYPING_ACTIVITY") sent.push(message); return send(raw, ...rest); };
    await aEditor.userType("x");
    await waitFor(() => b.getState().typingMemberIds.includes("A"), "typing start");
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0]).sort(), ["type", "roomId", "documentPath", "presenceSessionId", "shareId", "sequence", "active"].sort());
    assert.equal(sent[0].active, true);
    assert.equal(JSON.stringify(sent[0]).includes("first"), false, "activity has no document text");
    const nodes = CodeMeshTreeProvider.prototype.getChildren.call({ client: b, refresh() {} });
    assert.ok(nodes.some((node) => node.label === "Alice" && node.description === "src/shared.txt | Recent edit"));
    for (let index = 0; index < 12; index += 1) await aEditor.userType("z");
    assert.equal(sent.filter((message) => message.active).length, 1, "rapid commands do not send each key");
    await waitFor(() => !a.documentEditInFlight && a.pendingDocumentText === undefined, "rapid text accepted");
    await c.joinRoom(roomId);
    await waitFor(() => c.getState().roomId === roomId, "late C joins");
    cEditor.document.text = aEditor.document.text;
    await c.collaborateDocument(cEditor.document);
    await waitFor(() => c.getState().documentStatus === "shared" && c.getState().typingMemberIds.includes("A"), "late sharer gets current activity");
    await waitFor(() => !b.getState().typingMemberIds.includes("A") && !c.getState().typingMemberIds.includes("A"), "idle stop");
    assert.equal(sent.at(-1).active, false);
    const unrelated = { ...aEditor.document, text: "unrelated", version: 1,
      uri: { toString: () => "file:///A/other.txt" } };
    aEditor.vscode.window.activeTextEditor = { document: unrelated };
    await aEditor.userType("?");
    aEditor.vscode.window.activeTextEditor = aEditor.editor;
    assert.equal(sent.at(-1).active, false, "unrelated active tab cannot publish activity");
    assert.equal(aEditor.document.text.includes("?"), false);
    console.log("PASS: real-WebSocket typing start, prompt sidebar state, burst throttle, late shared-file join, idle stop and no text on presence wire");

    // A lost stop cannot leave a permanent indicator: the receiver owns an expiry timer.
    a.socket.send = (raw, ...rest) => JSON.parse(raw).type === "TYPING_ACTIVITY" && JSON.parse(raw).active === false ? undefined : send(raw, ...rest);
    await aEditor.userType("q");
    await waitFor(() => b.getState().typingMemberIds.includes("A"), "second typing start");
    await waitFor(() => !b.getState().typingMemberIds.includes("A"), "recipient lease expiry after lost stop");
    assert.equal(b.getState().typingMemberIds.length, 0);
    const old = { type: "TYPING_ACTIVITY", roomId, documentPath: "src/shared.txt", presenceSessionId: b.presenceSessionId,
      shareId: b.sharedFileSessions.get("A"), memberId: "A", sequence: b.remoteTyping.get("A").sequence,
      active: true, leaseMs: 1800 };
    b.handleServerMessage(JSON.stringify(old));
    assert.equal(b.getState().typingMemberIds.length, 0, "duplicate cannot renew expired activity");
    a.socket.send = send;
    console.log("PASS: lost stop expires locally; duplicate delivery cannot revive indicator");

    const beforeA = aEditor.document.text;
    bEditor.type(bEditor.document.text + "!");
    await waitFor(() => aEditor.document.text.endsWith("!"), "programmatic edit syncs without typing");
    assert.equal(a.getState().typingMemberIds.includes("B"), false);
    assert.equal(aEditor.saves + bEditor.saves + cEditor.saves, 0);
    assert.notEqual(aEditor.document.text, beforeA);
    await aEditor.userType("r");
    await waitFor(() => b.getState().typingMemberIds.includes("A"), "typing before close");
    aEditor.closes.fire(aEditor.document);
    await waitFor(() => !b.getState().typingMemberIds.includes("A") && !b.getState().sharedFiles.some((file) => file.memberId === "A"), "close clears peer");
    b.handleServerMessage(JSON.stringify({ ...old, sequence: old.sequence + 999 }));
    assert.equal(b.getState().typingMemberIds.length, 0, "old share cannot restore indicator");
    b.handleServerMessage(JSON.stringify({ type: "TYPING_REJECTED", message: "old session" }));
    assert.equal(b.getState().documentStatus, "shared", "presence rejection cannot end document sync");
    b.leaveRoom();
    assert.deepEqual(b.getState().typingMemberIds, []);
    await b.joinRoom(roomId);
    await waitFor(() => b.getState().roomId === roomId, "B rejoins room");
    bEditor.document.text = cEditor.document.text;
    await b.collaborateDocument(bEditor.document);
    await waitFor(() => b.getState().documentStatus === "shared" && b.sharedFileSessions.has("C"), "B explicitly re-shares");
    await cEditor.userType("p");
    await waitFor(() => b.getState().typingMemberIds.includes("C"), "C typing before disconnect");
    const oldCShare = b.sharedFileSessions.get("C");
    c.socket.terminate();
    await waitFor(() => !b.getState().typingMemberIds.includes("C") && !b.sharedFileSessions.has("C"), "peer disconnect clears activity");
    await waitFor(() => c.getState().roomId === roomId && !c.getState().sharedDocumentPath, "C restores room without sharing");
    b.handleServerMessage(JSON.stringify({ type: "TYPING_ACTIVITY", roomId, documentPath: "src/shared.txt",
      presenceSessionId: b.presenceSessionId, shareId: oldCShare, memberId: "C",
      sequence: 999, active: true, leaseMs: 1800 }));
    assert.deepEqual(b.getState().typingMemberIds, [], "old connection cannot restore typing state");
    assert.equal(aEditor.saves + bEditor.saves + cEditor.saves, 0);
    console.log("PASS: generic programmatic edits and remote WorkspaceEdits stay silent; close/leave/disconnect/reconnect/old-session cleanup; no save calls");
  } finally {
    a.dispose(); b.dispose(); c.dispose();
    await new Promise((resolve) => server.server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
