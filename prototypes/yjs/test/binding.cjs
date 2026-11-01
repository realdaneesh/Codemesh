const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PrototypeClient, PrototypeRoom } = require("../dist/prototype");
const { TestEditorBinding } = require("../dist/binding");
const { registerPrototypeUndoCommands, UNDO_LOCAL_COMMAND, REDO_LOCAL_COMMAND } = require("../dist/undoCommands");
const { PrototypePauseFlow, PAUSE_CHOICES } = require("../dist/pauseFlow");
const { protocol, editor } = require("./helpers.cjs");

function pair(t, initial = "first\nmiddle\nlast", bText) {
  const room = new PrototypeRoom("ABC234", "shared.txt", protocol, initial);
  const frames = [];
  const a = new PrototypeClient(room.scope, protocol, (frame) => frames.push({ id: "a", frame }));
  const b = new PrototypeClient(room.scope, protocol, (frame) => frames.push({ id: "b", frame }));
  a.receive(room.join("a", a.stateVectorFrame())); b.receive(room.join("b", b.stateVectorFrame()));
  const ea = editor(initial), eb = editor(bText ?? initial.replace(/\n/g, "\r\n"), 2);
  const ba = new TestEditorBinding(ea.api, ea.document, a, undefined, ea.origin), bb = new TestEditorBinding(eb.api, eb.document, b, undefined, eb.origin);
  t.after(() => { ba.dispose(); bb.dispose(); a.dispose(); b.dispose(); room.dispose(); });
  const flush = async () => {
    for (const { id, frame } of frames.splice(0)) for (const packet of room.receive(id, frame)) (packet.memberId === "a" ? a : b).receive(packet.frame);
    await ba.settled(); await bb.settled();
    assert.equal(frames.length, 0, "remote editor applications never echo");
    assert.equal(ea.saves + eb.saves, 0);
  };
  return { room, a, b, ea, eb, ba, bb, frames, flush };
}

test("LF/CRLF multiline paste, Unicode, deletion and local-only undo/redo sync without save/echo", async (t) => {
  const h = pair(t);
  h.eb.edit([{ rangeOffset: 7, rangeLength: 0, text: "paste\r\n\u4e2d\u6587 \ud83d\ude80 e\u0301\r\n" }]);
  await h.flush();
  assert.equal(h.ea.document.text, h.eb.document.text.replace(/\r\n/g, "\n"));
  assert.ok(h.eb.document.text.includes("\r\n")); assert.equal(h.eb.document.eol, 2);
  const pasted = h.ea.document.text;
  h.ea.edit([{ rangeOffset: 6, rangeLength: "paste\n\u4e2d\u6587 \ud83d\ude80 e\u0301\n".length, text: "" }]);
  await h.flush(); assert.equal(h.ea.document.text, "first\nmiddle\nlast");
  assert.equal(await h.ba.undoLocal(), true); await h.flush(); assert.equal(h.ea.document.text, pasted);
  assert.equal(await h.ba.redoLocal(), true); await h.flush(); assert.equal(h.ea.document.text, "first\nmiddle\nlast");
  assert.equal(h.ea.document.isDirty, true); assert.equal(h.eb.document.isDirty, true);
});

test("batched pre-change offsets commit as one CRDT update and EOL-only changes do not broadcast", async (t) => {
  const h = pair(t, "a\nb\nc");
  h.eb.edit([{ rangeOffset: 0, rangeLength: 1, text: "A" }, { rangeOffset: 6, rangeLength: 1, text: "C" }]);
  assert.equal(h.frames.length, 1); await h.flush(); assert.equal(h.a.getText(), "A\nb\nC");
  h.eb.eol(1); assert.equal(h.frames.length, 0);
  h.eb.edit([{ rangeOffset: 2, rangeLength: 1, text: "B" }]); await h.flush(); assert.equal(h.a.getText(), "A\nB\nC");
});

test("remote separated Unicode replacements keep intervening CRLF text, selections and scroll stable", async (t) => {
  const seed = "A\nBxxx\nC\nDyyy\nE";
  const h = pair(t, seed);
  const before = h.eb.document.text;
  const between = before.indexOf("C"), after = before.indexOf("E");
  h.eb.setSelections([{ anchor: 0, active: 0 }, { anchor: between, active: between }, { anchor: after, active: after }]);
  h.eb.setScroll(7);
  h.ea.edit([{ rangeOffset: 3, rangeLength: 3, text: "\ud83d\ude80" }, { rangeOffset: 10, rangeLength: 3, text: "\u4e2d\u6587" }]);
  await h.flush();
  assert.equal(h.eb.document.text, "A\r\nB\ud83d\ude80\r\nC\r\nD\u4e2d\u6587\r\nE");
  assert.equal(h.eb.applied.length, 1);
  assert.equal(h.eb.applied[0].length, 2, "one remote WorkspaceEdit contains two disjoint replacements");
  assert.deepEqual(h.eb.applied[0].map((patch) => [patch.rangeOffset, patch.rangeLength, patch.text]),
    [[before.indexOf("xxx"), 3, "\ud83d\ude80"], [before.indexOf("yyy"), 3, "\u4e2d\u6587"]]);
  assert.deepEqual(h.eb.selections.map((selection) => selection.active), [0, between - 1, after - 2]);
  assert.equal(h.eb.scrollTop, 7); assert.equal(h.eb.saves, 0); assert.equal(h.frames.length, 0);
});

test("one remote update applies separated inserts and deletion as three narrow edits", async (t) => {
  const h = pair(t, "ab\ncd\nef\ngh");
  const before = h.eb.document.text;
  h.ea.edit([{ rangeOffset: 1, rangeLength: 0, text: "\ud83d\ude80" },
    { rangeOffset: 4, rangeLength: 1, text: "" },
    { rangeOffset: 10, rangeLength: 0, text: "\u4e2d" }]);
  await h.flush();
  assert.equal(h.eb.document.text, "a\ud83d\ude80b\r\nc\r\nef\r\ng\u4e2dh");
  assert.equal(h.eb.applied.length, 1);
  assert.deepEqual(h.eb.applied[0].map((patch) => [patch.rangeOffset, patch.rangeLength, patch.text]),
    [[before.indexOf("b"), 0, "\ud83d\ude80"], [before.indexOf("d"), 1, ""], [before.indexOf("h"), 0, "\u4e2d"]]);
  assert.equal(h.eb.saves, 0); assert.equal(h.frames.length, 0);
});

test("typing between disjoint remote patches pauses and restores the unsaved local draft", async (t) => {
  const h = pair(t, "A\nBxxx\nC\nDyyy\nE");
  let release; h.eb.api.gate = new Promise((resolve) => { release = resolve; });
  h.ea.edit([{ rangeOffset: 3, rangeLength: 3, text: "ONE" }, { rangeOffset: 10, rangeLength: 3, text: "TWO" }]);
  for (const packet of h.frames.splice(0)) for (const routed of h.room.receive(packet.id, packet.frame)) h.b.receive(routed.frame);
  await Promise.resolve(); await Promise.resolve();
  const position = h.eb.document.text.indexOf("C");
  h.eb.edit([{ rangeOffset: position, rangeLength: 0, text: "local " }]);
  const draft = h.eb.document.text;
  assert.equal(h.bb.getStatus().status, "paused");
  release(); await h.bb.settled();
  assert.equal(h.eb.document.text, draft); assert.equal(h.bb.getStatus().draft, draft);
  assert.equal(h.b.getText(), "A\nBONE\nC\nDTWO\nE");
  assert.equal(h.frames.length, 0); assert.equal(h.eb.saves, 0);
});

test("divergent initial draft is preserved until explicit use-room choice", async (t) => {
  const h = pair(t, "room text", "unsaved draft");
  assert.equal(h.bb.getStatus().status, "paused"); assert.equal(h.eb.document.text, "unsaved draft");
  assert.equal(h.frames.length, 0); await h.bb.useRoomText();
  assert.equal(h.eb.document.text, "room text"); assert.equal(h.bb.getStatus().draft, "unsaved draft");
  assert.equal(h.eb.document.isDirty, true); assert.equal(h.eb.saves, 0); assert.equal(h.frames.length, 0);
});

test("typing during asynchronous remote application pauses and retains the original local draft", async (t) => {
  const h = pair(t, "base");
  let release; h.eb.api.gate = new Promise((resolve) => { release = resolve; });
  h.a.insert(4, " remote");
  for (const packet of h.frames.splice(0)) for (const routed of h.room.receive(packet.id, packet.frame)) h.b.receive(routed.frame);
  await Promise.resolve(); await Promise.resolve();
  h.eb.edit([{ rangeOffset: 0, rangeLength: 0, text: "local " }]);
  assert.equal(h.bb.getStatus().status, "paused"); assert.equal(h.bb.getStatus().draft, "local base");
  release(); await h.bb.settled();
  assert.equal(h.bb.getStatus().draft, "local base"); assert.equal(h.frames.length, 0);
  assert.equal(h.eb.document.text, "local base", "late remote patch must not leave a mixed buffer");
  assert.equal(h.b.getText(), "base remote", "accepted remote state remains available for explicit recovery");
  await h.bb.useRoomText();
  assert.equal(h.eb.document.text, "base remote"); assert.equal(h.bb.getStatus().draft, "local base");
});

test("same-position typing and multiline deletion during a pending remote edit preserve the latest draft", async (t) => {
  for (const local of [
    { rangeOffset: 2, rangeLength: 7, text: "\u4e2d\u6587\n" },
    { rangeOffset: 0, rangeLength: 6, text: "" }
  ]) {
    const h = pair(t);
    let release; h.ea.api.gate = new Promise((resolve) => { release = resolve; });
    h.b.insert(0, "R");
    for (const packet of h.frames.splice(0)) for (const routed of h.room.receive(packet.id, packet.frame)) h.a.receive(routed.frame);
    await Promise.resolve(); await Promise.resolve();
    h.ea.edit([local]); const draft = h.ea.document.text;
    assert.equal(h.ba.getStatus().status, "paused");
    release(); await h.ba.settled();
    assert.equal(h.ea.document.text, draft);
    assert.equal(h.ba.getStatus().draft, draft);
    assert.equal(h.a.getText(), "Rfirst\nmiddle\nlast");
    assert.equal(h.frames.length, 0); assert.equal(h.ea.saves, 0);
    h.ba.dispose(); h.a.dispose(); h.ea.api.gate = undefined;
  }
});

test("identical local insertion during pending remote apply is tagged, sent once and locally undoable", async (t) => {
  const h = pair(t, "base");
  let release; h.eb.api.gate = new Promise((resolve) => { release = resolve; });
  h.a.insert(0, "R");
  for (const packet of h.frames.splice(0)) for (const routed of h.room.receive(packet.id, packet.frame)) h.b.receive(routed.frame);
  await Promise.resolve(); await Promise.resolve();
  h.eb.edit([{ rangeOffset: 0, rangeLength: 0, text: "R" }]);
  release(); await h.bb.settled();
  assert.equal(h.bb.getStatus().status, "active");
  assert.equal(h.eb.document.text, "RRbase");
  assert.equal(h.frames.length, 1, "identical local text publishes one own update");
  await h.flush(); assert.equal(h.a.getText(), "RRbase");
  assert.equal(h.a.canUndo(), true, "sender still owns its own earlier insertion");
  assert.equal(h.b.canUndo(), true, "receiver owns the identical local insertion");
  assert.equal(await h.bb.undoLocal(), true); await h.flush();
  assert.equal(h.a.getText(), "Rbase"); assert.equal(h.eb.document.text, "Rbase");
  assert.equal(await h.bb.redoLocal(), true); await h.flush();
  assert.equal(h.a.getText(), "RRbase"); assert.equal(h.eb.document.text, "RRbase");
  assert.equal(h.ea.saves + h.eb.saves, 0);
});

test("unmarked identical pending insertions pause without guessing their origin", async (t) => {
  const h = pair(t, "base");
  h.bb.dispose();
  const plain = new TestEditorBinding(h.eb.api, h.eb.document, h.b); t.after(() => plain.dispose());
  let release; h.eb.api.gate = new Promise((resolve) => { release = resolve; });
  h.a.insert(0, "R");
  for (const packet of h.frames.splice(0)) for (const routed of h.room.receive(packet.id, packet.frame)) h.b.receive(routed.frame);
  await Promise.resolve(); await Promise.resolve();
  h.eb.edit([{ rangeOffset: 0, rangeLength: 0, text: "R" }]);
  release(); await plain.settled();
  assert.equal(plain.getStatus().status, "paused");
  assert.equal(plain.getStatus().draft, "Rbase");
  assert.equal(plain.getStatus().latestDraft, "RRbase");
  assert.equal(h.eb.document.text, "Rbase");
  assert.equal(h.frames.length, 0); assert.equal(h.b.canUndo(), false);
  await assert.rejects(plain.undoLocal(), /Resolve or re-share/);
  await plain.useRoomText(); assert.equal(plain.getStatus().status, "active");
  assert.equal(h.a.getText(), "Rbase");
  h.a.insert(0, "S");
  for (const packet of h.frames.splice(0)) for (const routed of h.room.receive(packet.id, packet.frame)) h.b.receive(routed.frame);
  await plain.settled();
  assert.equal(plain.getStatus().status, "paused");
  assert.equal(plain.getStatus().draft, "SRbase", "a later pause must not restore the previous resolved draft");
  assert.equal(h.eb.document.text, "SRbase");
  assert.equal(h.eb.saves, 0);
});

test("ambiguous unmarked deletion pauses and preserves the local buffer for explicit choice", async (t) => {
  const h = pair(t, "base"); h.bb.dispose();
  const plain = new TestEditorBinding(h.eb.api, h.eb.document, h.b); t.after(() => plain.dispose());
  let release; h.eb.api.gate = new Promise((resolve) => { release = resolve; });
  h.a.delete(0, 1);
  for (const packet of h.frames.splice(0)) for (const routed of h.room.receive(packet.id, packet.frame)) h.b.receive(routed.frame);
  await Promise.resolve(); await Promise.resolve();
  h.eb.edit([{ rangeOffset: 0, rangeLength: 1, text: "" }]);
  assert.equal(plain.getStatus().status, "paused");
  release(); await plain.settled();
  assert.equal(h.eb.document.text, "ase"); assert.equal(plain.getStatus().draft, "ase");
  assert.equal(h.frames.length, 0); assert.equal(h.eb.saves, 0);
  await plain.useRoomText(); assert.equal(plain.getStatus().status, "active");
});

test("local-only CRDT undo and redo retain peer insertions and deletions", async (t) => {
  const h = pair(t, "abcd");
  assert.equal(h.a.canUndo(), false); assert.equal(h.b.canUndo(), false);
  h.ea.edit([{ rangeOffset: 1, rangeLength: 0, text: "OWN" }]); await h.flush();
  h.eb.edit([{ rangeOffset: h.eb.document.text.length, rangeLength: 0, text: "PEER" }]); await h.flush();
  assert.equal(h.a.getText(), "aOWNbcdPEER");
  assert.equal(await h.ba.undoLocal(), true); await h.flush();
  assert.equal(h.a.getText(), "abcdPEER"); assert.equal(h.ea.document.text, "abcdPEER");
  assert.equal(await h.ba.redoLocal(), true); await h.flush();
  assert.equal(h.a.getText(), "aOWNbcdPEER");
  h.eb.edit([{ rangeOffset: 4, rangeLength: 1, text: "" }]); await h.flush();
  const afterPeerDelete = h.a.getText();
  assert.equal(await h.ba.undoLocal(), true); await h.flush();
  assert.equal(h.a.getText(), afterPeerDelete.replace("OWN", ""));
  assert.equal(await h.ba.redoLocal(), true); await h.flush();
  assert.equal(h.a.getText(), afterPeerDelete);
  assert.equal(h.ea.saves + h.eb.saves, 0); assert.equal(h.frames.length, 0);
});

test("remote-only editor changes create no local CRDT undo entry or outbound echo", async (t) => {
  const h = pair(t, "base");
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "peer " }]); await h.flush();
  assert.equal(h.b.canUndo(), false);
  assert.equal(await h.bb.undoLocal(), false);
  assert.equal(h.b.getText(), "peer base"); assert.equal(h.eb.document.text, "peer base");
  assert.equal(h.frames.length, 0); assert.equal(h.eb.saves, 0);
});

test("native Undo after a peer edit pauses with a draft instead of broadcasting the peer deletion", async (t) => {
  const h = pair(t, "base");
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "own " }]); await h.flush();
  h.eb.edit([{ rangeOffset: h.eb.document.text.length, rangeLength: 0, text: " PEER" }]); await h.flush();
  const roomText = h.a.getText();
  h.ea.undo();
  assert.equal(h.ba.getStatus().status, "paused");
  assert.equal(h.ba.getStatus().draft, h.ea.document.text);
  assert.equal(h.a.getText(), roomText); assert.equal(h.b.getText(), roomText);
  assert.equal(h.frames.length, 0, "native undo never publishes an unscoped history operation");
  h.ea.redo();
  assert.equal(h.ba.getStatus().status, "paused");
  assert.equal(h.a.getText(), roomText); assert.equal(h.frames.length, 0);
  assert.equal(h.ea.saves + h.eb.saves, 0);
});

test("paused or disposed binding cannot replay CRDT undo into an old epoch", async (t) => {
  const h = pair(t, "base");
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "own " }]); await h.flush();
  h.ba.pause("explicit stop");
  await assert.rejects(h.ba.undoLocal(), /Resolve or re-share/);
  assert.equal(h.a.getText(), "own base");
  h.ba.dispose();
  await assert.rejects(h.ba.redoLocal(), /Resolve or re-share/);
  assert.equal(h.ba.getStatus().draft, "own base");
  assert.equal(h.ea.saves, 0);
});

test("pending remote edit cannot change the editor after binding disposal", async (t) => {
  const h = pair(t, "base");
  let release; h.eb.api.gate = new Promise((resolve) => { release = resolve; });
  h.a.insert(0, "remote ");
  for (const packet of h.frames.splice(0)) for (const routed of h.room.receive(packet.id, packet.frame)) h.b.receive(routed.frame);
  await Promise.resolve(); await Promise.resolve();
  h.bb.dispose(); h.eb.edit([{ rangeOffset: 0, rangeLength: 0, text: "offline " }]);
  release(); await h.bb.settled();
  assert.equal(h.eb.document.text, "offline base");
  assert.ok(h.bb.getStatus().draftCandidates.includes("offline base"));
  assert.equal(h.eb.listeners, 0); assert.equal(h.eb.saves, 0);
});

test("queued remote updates remain in Y.Text while a pending local draft is recovered", async (t) => {
  const h = pair(t, "base");
  let release; h.eb.api.gate = new Promise((resolve) => { release = resolve; });
  h.a.insert(0, "one ");
  for (const packet of h.frames.splice(0)) for (const routed of h.room.receive(packet.id, packet.frame)) h.b.receive(routed.frame);
  await Promise.resolve(); await Promise.resolve();
  h.a.insert(4, "two ");
  for (const packet of h.frames.splice(0)) for (const routed of h.room.receive(packet.id, packet.frame)) h.b.receive(routed.frame);
  h.eb.edit([{ rangeOffset: 0, rangeLength: 0, text: "local " }]);
  release(); await h.bb.settled();
  assert.equal(h.eb.document.text, "local base");
  assert.equal(h.bb.getStatus().draft, "local base");
  assert.equal(h.b.getText(), "one two base");
  assert.equal(h.frames.length, 0); assert.equal(h.eb.saves, 0);
  await h.bb.useRoomText();
  assert.equal(h.eb.document.text, "one two base");
  assert.equal(h.bb.getStatus().draft, "local base");
});

test("rejected remote editor apply preserves text, and closing/disposal removes all binding listeners", async (t) => {
  const h = pair(t, "base"); h.eb.api.reject = true;
  h.a.insert(4, " remote"); await h.flush();
  assert.equal(h.eb.document.text, "base"); assert.equal(h.bb.getStatus().status, "paused");
  h.eb.close(); assert.equal(h.eb.listeners, 0); assert.equal(h.bb.getStatus().listenerCount, 0);
  const before = h.eb.applications; h.a.insert(0, "new"); await h.flush(); assert.equal(h.eb.applications, before);
  h.a.dispose(); assert.equal(h.ea.listeners, 0); assert.equal(h.ba.getStatus().status, "disposed");
});

test("binding rejects non-workspace, preview and mismatched paths before installing listeners", (t) => {
  const h = pair(t, "base"); h.bb.dispose();
  h.eb.document.uri.scheme = "codemesh-preview";
  assert.throws(() => new TestEditorBinding(h.eb.api, h.eb.document, h.b), /authorized workspace/);
  h.eb.document.uri.scheme = "file"; h.eb.api.workspace.getWorkspaceFolder = () => undefined;
  assert.throws(() => new TestEditorBinding(h.eb.api, h.eb.document, h.b), /authorized workspace/);
  h.eb.api.workspace.getWorkspaceFolder = () => ({}); h.eb.api.workspace.asRelativePath = () => "other.txt";
  assert.throws(() => new TestEditorBinding(h.eb.api, h.eb.document, h.b), /authorized workspace/);
  assert.equal(h.eb.listeners, 0);
});

test("prototype commands target only the active shared editor and ignore ordinary editors", async (t) => {
  const h = pair(t, "abcd");
  const handlers = new Map();
  const api = {
    commands: { registerCommand: (id, action) => { handlers.set(id, action); return { dispose: () => handlers.delete(id) }; } },
    window: { activeTextEditor: { document: h.ea.document } }
  };
  const bindings = new Map([[h.ea.document, h.ba]]);
  const commands = registerPrototypeUndoCommands(api, bindings); t.after(() => commands.dispose());
  h.ea.edit([{ rangeOffset: 1, rangeLength: 0, text: "A" }]); await h.flush();
  h.eb.edit([{ rangeOffset: h.eb.document.text.length, rangeLength: 0, text: "PEER" }]); await h.flush();
  assert.equal(h.ea.applied.length, 1, "the remote WorkspaceEdit reached this editor");
  const ordinary = editor("ordinary draft"); api.window.activeTextEditor = { document: ordinary.document };
  assert.equal(await handlers.get(UNDO_LOCAL_COMMAND)(), false);
  assert.equal(await handlers.get(REDO_LOCAL_COMMAND)(), false);
  assert.equal(ordinary.document.text, "ordinary draft");
  api.window.activeTextEditor = { document: h.ea.document };
  assert.equal(await handlers.get(UNDO_LOCAL_COMMAND)(), true); await h.flush();
  assert.equal(h.ea.document.text, "abcdPEER");
  assert.equal(await handlers.get(REDO_LOCAL_COMMAND)(), true); await h.flush();
  assert.equal(h.ea.document.text, "aAbcdPEER");
  commands.dispose(); assert.equal(handlers.size, 0); assert.equal(bindings.size, 0);
});

test("multi-cursor batch and consecutive local-only undo/redo preserve interleaved peer changes", async (t) => {
  const h = pair(t, "abcd");
  h.ea.edit([{ rangeOffset: 1, rangeLength: 0, text: "A" }, { rangeOffset: 3, rangeLength: 0, text: "B" }]);
  await h.flush(); assert.equal(h.a.getText(), "aAbcBd");
  h.eb.edit([{ rangeOffset: h.eb.document.text.length, rangeLength: 0, text: "P" }]); await h.flush();
  h.eb.edit([{ rangeOffset: 0, rangeLength: 1, text: "" }]); await h.flush();
  assert.equal(h.ea.applied.length, 2, "both peer changes entered the editor through WorkspaceEdit");
  assert.equal(await h.ba.undoLocal(), true); await h.flush();
  assert.equal(h.a.getText(), "bcdP"); assert.equal(h.b.getText(), "bcdP");
  assert.equal(await h.ba.redoLocal(), true); await h.flush();
  assert.equal(h.a.getText(), "AbcBdP");
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "1" }]); await h.flush();
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "2" }]); await h.flush();
  assert.equal(await h.ba.undoLocal(), true); await h.flush(); assert.equal(h.a.getText(), "1AbcBdP");
  assert.equal(await h.ba.undoLocal(), true); await h.flush(); assert.equal(h.a.getText(), "AbcBdP");
  assert.equal(await h.ba.redoLocal(), true); await h.flush(); assert.equal(h.a.getText(), "1AbcBdP");
  assert.equal(await h.ba.redoLocal(), true); await h.flush(); assert.equal(h.a.getText(), "21AbcBdP");
  assert.equal(h.ea.document.text, h.a.getText()); assert.equal(h.eb.document.text, h.a.getText());
  assert.equal(h.ea.saves + h.eb.saves, 0);
});

test("undo refused while paused, disconnected or rebound to a new epoch without a fresh local edit", async (t) => {
  const h = pair(t, "base");
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "own " }]); await h.flush();
  h.ba.pause("test pause");
  await assert.rejects(h.ba.undoLocal(), /Resolve or re-share/);
  assert.equal(h.ea.document.text, "own base");
  h.a.dispose();
  await assert.rejects(h.ba.redoLocal(), /Resolve or re-share/);
  assert.equal(h.ba.getStatus().draft, "own base");
  const nextRoom = new PrototypeRoom("ABC234", "shared.txt", protocol, "new room");
  const next = new PrototypeClient(nextRoom.scope, protocol, () => undefined);
  t.after(() => { next.dispose(); nextRoom.dispose(); });
  next.receive(nextRoom.join("next", next.stateVectorFrame()));
  const rebound = new TestEditorBinding(h.ea.api, h.ea.document, next, undefined, h.ea.origin); t.after(() => rebound.dispose());
  assert.equal(rebound.getStatus().status, "paused");
  await assert.rejects(rebound.undoLocal(), /Resolve or re-share/);
  assert.equal(h.ea.document.text, "own base");
  await rebound.useRoomText();
  assert.equal(await rebound.undoLocal(), false, "old-epoch undo history cannot migrate");
  assert.equal(h.ea.document.text, "new room");
  assert.equal(rebound.getStatus().draft, "own base");
  assert.equal(h.ea.saves, 0);
});

test("rejected editor apply during local undo pauses and retains the unsaved draft", async (t) => {
  const h = pair(t, "base");
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "own " }]); await h.flush();
  h.ea.api.reject = true;
  await assert.rejects(h.ba.undoLocal(), /rejected/);
  assert.equal(h.ba.getStatus().status, "paused");
  assert.equal(h.ba.getStatus().draft, "own base");
  assert.equal(h.ea.document.text, "own base");
  assert.equal(h.ea.saves, 0);
});

test("pause choices expose the reason, keep dismissal inert, preview a draft without writing, and require explicit recovery", async (t) => {
  const h = pair(t, "base");
  const prompts = [], previews = [], shown = [];
  let answer;
  const api = {
    ViewColumn: { Beside: 2 },
    workspace: { openTextDocument: async (options) => { previews.push(options); return { uri: { scheme: "untitled" }, getText: () => options.content }; } },
    window: {
      showWarningMessage: async (...args) => { prompts.push(args); return answer; },
      showTextDocument: async (...args) => shown.push(args)
    }
  };
  let disconnected = 0;
  const flow = new PrototypePauseFlow(api, h.ea.document, h.ba, {
    errors: ["CRDT outgoing queue limit reached; explicitly rejoin"],
    disconnect: () => { disconnected++; h.a.dispose(); }
  });
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "my " }]); await h.flush();
  h.ba.pause("Native Undo/Redo cannot be attributed safely");
  h.eb.edit([{ rangeOffset: h.eb.document.text.length, rangeLength: 0, text: " peer" }]); await h.flush();
  const draft = h.ea.document.text, sent = h.frames.length;
  assert.equal(await flow.present(), "dismissed");
  assert.match(prompts[0][0], /Native Undo\/Redo cannot be attributed safely/);
  assert.deepEqual(prompts[0].slice(2), [...PAUSE_CHOICES]);
  assert.equal(h.ba.getStatus().status, "paused"); assert.equal(h.ea.document.text, draft);
  answer = "Inspect Draft";
  assert.equal(await flow.present(), "inspected");
  assert.equal(previews[0].content, draft); assert.equal(shown[0][0].uri.scheme, "untitled");
  assert.equal(h.ea.document.text, draft); assert.equal(h.ea.saves, 0);
  answer = "Use Room Text";
  assert.equal(await flow.present(), "resumed");
  assert.equal(h.ba.getStatus().draft, draft);
  assert.equal(h.ea.document.text, "my base peer");
  assert.equal(h.frames.length, sent, "explicit room-text application never echoes");
  h.a.suspend(); h.ba.pause("CRDT session quarantined; preserve the draft and explicitly recover");
  answer = "Use Room Text";
  assert.equal(await flow.present(), "paused");
  assert.match(prompts.at(-2)[0], /outgoing queue limit reached/);
  assert.match(prompts.at(-1)[0], /unavailable until recovery/);
  assert.equal(h.ba.getStatus().status, "paused"); assert.equal(h.ea.document.text, "my base peer");
  answer = "End Sharing";
  assert.equal(await flow.present(), "ended"); assert.equal(disconnected, 1);
  assert.equal(h.ba.getStatus().status, "disposed"); assert.equal(h.ea.saves, 0);
});
