const assert = require("node:assert/strict");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");
const { adapter, delay, waitFor } = require("./cursor-presence.cjs");

const point = (line, character) => ({ line, character });
const choice = (anchor, active) => ({ anchor, active });

async function main() {
  const server = new CollaborationServer(0); server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.server.address().port}`;
  const aEditor = adapter("A", "\n"), bEditor = adapter("B", "\r\n");
  const a = new aEditor.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "A", displayName: "Alice" } });
  const b = new bEditor.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "B", displayName: "Bob" } });
  try {
    await a.createRoom();
    await waitFor(() => a.getState().roomId, "A creates room");
    const roomId = a.getState().roomId;
    await b.joinRoom(roomId);
    await waitFor(() => b.getState().roomId === roomId, "B joins room");
    await a.collaborateDocument(aEditor.document);
    await waitFor(() => a.getState().documentStatus === "shared" && a.localCursorShareId, "A shares file");
    aEditor.selectRanges([choice(point(0, 1), point(0, 4))]);
    await delay(70);
    assert.equal(b.remoteSelections.size, 0, "unshared member sees no selection");
    await b.collaborateDocument(bEditor.document);
    await waitFor(() => b.getState().documentStatus === "shared" && b.sharedFileSessions.has("A"), "B shares same path");
    const sent = [];
    const originalSend = a.socket.send.bind(a.socket);
    a.socket.send = (raw, ...rest) => {
      const message = JSON.parse(raw);
      if (message.type === "SELECTION_UPDATE") sent.push(message);
      return originalSend(raw, ...rest);
    };
    const beforeA = aEditor.document.text, beforeB = bEditor.document.text;
    for (let index = 0; index < 30; index += 1) aEditor.selectRanges([choice(point(0, 1), point(0, 2 + index % 3))]);
    aEditor.selectRanges([choice(point(0, 1), point(0, 4))]);
    await waitFor(() => b.remoteSelections.get("A")?.ranges[0]?.end.character === 4, "single range delivered");
    assert.equal(sent.length, 1, "31 rapid selection changes coalesce into one update");
    assert.deepEqual(sent[0].ranges, [{ start: point(0, 1), end: point(0, 4) }]);
    assert.deepEqual(Object.keys(sent[0]).sort(), ["type", "roomId", "documentPath", "presenceSessionId", "shareId", "sequence", "documentRevision", "ranges"].sort());
    assert.equal(JSON.stringify(sent[0]).includes("first"), false, "wire message contains no selected text");
    const decoration = b.selectionDecorations.get("A");
    assert.ok(decoration);
    assert.match(decoration.options.backgroundColor, /^hsla\(.+, 0\.16\)$/);
    assert.equal(decoration.options.before, undefined, "highlight has no label over code");
    assert.equal(bEditor.decorations.get(decoration).length, 1);
    assert.equal(bEditor.decorations.get(decoration)[0].start.character, 1);
    assert.equal(bEditor.decorations.get(decoration)[0].end.character, 4);
    assert.equal(aEditor.document.text, beforeA);
    assert.equal(bEditor.document.text, beforeB);
    assert.equal(aEditor.saves + bEditor.saves, 0);
    console.log("PASS: same-file single range, throttling, bounded wire shape, subtle decoration, LF/CRLF coordinates and zero text/save calls");

    aEditor.selectRanges([choice(point(0, 4), point(0, 1)), choice(point(1, 0), point(1, 3))]);
    await waitFor(() => b.remoteSelections.get("A")?.ranges.length === 2, "two ranges delivered");
    assert.deepEqual(b.remoteSelections.get("A").ranges, [
      { start: point(0, 1), end: point(0, 4) }, { start: point(1, 0), end: point(1, 3) }
    ], "backward selection is normalized and multiple ranges remain disjoint");
    assert.equal(bEditor.decorations.get(b.selectionDecorations.get("A")).length, 2);
    const cursorColor = b.cursorDecorations.get("A").options.before.color;
    assert.ok(b.selectionDecorations.get("A").options.backgroundColor.includes(cursorColor.slice(4, -1).split(",")[0]), "selection hue matches cursor");
    const latest = sent.at(-1);
    b.handleServerMessage(JSON.stringify({ ...latest, type: "SELECTION_UPDATE", memberId: "A",
      presenceSessionId: b.presenceSessionId, sequence: latest.sequence, ranges: [{ start: point(0, 0), end: point(0, 1) }] }));
    assert.equal(b.remoteSelections.get("A").ranges.length, 2, "duplicate cannot replace ranges");
    b.handleServerMessage(JSON.stringify({ ...latest, type: "SELECTION_UPDATE", memberId: "A",
      presenceSessionId: b.presenceSessionId, sequence: latest.sequence + 1,
      ranges: [{ start: point(1, 4), end: point(1, 1) }] }));
    assert.equal(b.remoteSelections.get("A").ranges.length, 2, "reversed incoming range is rejected");
    aEditor.select(0, 2);
    await waitFor(() => b.remoteSelections.get("A")?.ranges.length === 0, "collapse clears ranges");
    assert.equal(b.selectionDecorations.size, 0, "collapse disposes highlight immediately");
    const collapsed = sent.at(-1);
    b.handleServerMessage(JSON.stringify({ ...collapsed, memberId: "A", presenceSessionId: b.presenceSessionId,
      sequence: collapsed.sequence - 1, ranges: [{ start: point(0, 1), end: point(0, 4) }] }));
    assert.equal(b.remoteSelections.get("A").ranges.length, 0, "delayed old range cannot restore highlight");
    aEditor.selectRanges(Array.from({ length: 17 }, () => choice(point(0, 1), point(0, 2))));
    await waitFor(() => aEditor.warnings.some((message) => message.includes("at most 16")), "range-limit warning");
    assert.equal(b.remoteSelections.get("A").ranges.length, 0, "over-cap selection is never published");
    aEditor.selectRanges([choice(point(1, 0), point(1, 3))]);
    await waitFor(() => b.remoteSelections.get("A")?.ranges[0]?.start.line === 1, "selection resumes below cap");

    const bSend = b.socket.send.bind(b.socket);
    const delayedEdits = [];
    b.socket.send = (raw, ...rest) => {
      if (JSON.parse(raw).type === "DOCUMENT_EDIT") { delayedEdits.push([raw, rest]); return; }
      return bSend(raw, ...rest);
    };
    bEditor.type("first\nshort");
    assert.equal(b.remoteSelections.get("A").ranges.length, 0, "local edit hides old highlight before network acknowledgement");
    assert.equal(b.selectionDecorations.size, 0);
    assert.equal(delayedEdits.length, 1);
    bSend(delayedEdits[0][0], ...delayedEdits[0][1]);
    await waitFor(() => a.sharedDocumentRevision === 1 && b.sharedDocumentRevision === 1, "text revision converges");
    aEditor.selectRanges([choice(point(1, 0), point(1, 3))]);
    await waitFor(() => b.remoteSelections.get("A")?.ranges[0]?.start.line === 1, "current-revision range resumes");
    assert.equal(b.remoteSelections.get("A").ranges.length, 1);
    const current = b.remoteSelections.get("A");
    b.handleServerMessage(JSON.stringify({ type: "SELECTION_UPDATE", roomId, documentPath: "src/shared.txt",
      presenceSessionId: b.presenceSessionId, shareId: current.shareId, memberId: "A",
      sequence: current.sequence + 1, documentRevision: 0,
      ranges: [{ start: point(0, 0), end: point(0, 2) }] }));
    assert.deepEqual(b.remoteSelections.get("A").ranges, current.ranges, "stale text revision is ignored");
    b.handleServerMessage(JSON.stringify({ type: "SELECTION_UPDATE", roomId, documentPath: "src/shared.txt",
      presenceSessionId: b.presenceSessionId, shareId: current.shareId, memberId: "A",
      sequence: current.sequence + 1, documentRevision: 1,
      ranges: [{ start: point(1, 99), end: point(1, 100) }] }));
    assert.deepEqual(bEditor.decorations.get(b.selectionDecorations.get("A")), [], "out-of-buffer range is hidden");
    const oldShareId = current.shareId;
    aEditor.select(0, 0);
    b.stopDocumentCollaboration();
    assert.equal(b.selectionDecorations.size, 0);
    assert.equal(b.remoteSelections.size, 0);
    a.stopDocumentCollaboration();
    await a.collaborateDocument(aEditor.document);
    await b.collaborateDocument(bEditor.document);
    await waitFor(() => b.sharedFileSessions.has("A") && b.sharedFileSessions.get("A") !== oldShareId, "new share session");
    b.handleServerMessage(JSON.stringify({ type: "SELECTION_UPDATE", roomId, documentPath: "src/shared.txt",
      presenceSessionId: b.presenceSessionId, shareId: oldShareId, memberId: "A",
      sequence: 999, documentRevision: 1,
      ranges: [{ start: point(0, 0), end: point(0, 2) }] }));
    assert.equal(b.remoteSelections.size, 0, "old share session cannot restore highlight");
    aEditor.selectRanges([choice(point(0, 0), point(0, 2))]);
    await waitFor(() => b.selectionDecorations.has("A"), "active highlight before end sharing");
    a.stopDocumentCollaboration();
    await waitFor(() => b.selectionDecorations.size === 0 && b.remoteSelections.size === 0, "peer end-sharing cleanup");
    await a.collaborateDocument(aEditor.document);
    await waitFor(() => b.sharedFileSessions.has("A") && a.getState().documentStatus === "shared", "peer re-shares");
    aEditor.selectRanges([choice(point(0, 0), point(0, 2))]);
    await waitFor(() => b.selectionDecorations.has("A"), "active highlight before room switch");
    await b.createRoom();
    await waitFor(() => b.getState().roomId && b.getState().roomId !== roomId, "room switch");
    assert.equal(b.selectionDecorations.size, 0, "room switch clears active highlight");
    await b.joinRoom(roomId);
    await waitFor(() => b.getState().roomId === roomId, "rejoin original room");
    await b.collaborateDocument(bEditor.document);
    await waitFor(() => b.getState().documentStatus === "shared" && b.sharedFileSessions.has("A"), "explicit re-share after room switch");
    aEditor.selectRanges([choice(point(0, 0), point(0, 2))]);
    await waitFor(() => b.selectionDecorations.has("A"), "active highlight before peer disconnect");
    a.socket.terminate();
    await waitFor(() => b.selectionDecorations.size === 0 && b.remoteSelections.size === 0, "peer disconnect cleanup");
    bEditor.closes.fire(bEditor.document);
    await waitFor(() => !b.getState().sharedDocumentPath, "close clears selection state");
    assert.equal(b.selectionDecorations.size, 0);
    b.socket.terminate();
    await waitFor(() => b.getState().roomId === roomId && !b.getState().sharedDocumentPath, "room restored without file");
    assert.equal(b.remoteSelections.size, 0);
    assert.equal(aEditor.saves + bEditor.saves, 0);
    console.log("PASS: multiple/backward/empty ranges, ordering, 16-range cap, edit/revision safety, end/close/disconnect/room-switch cleanup and no saves");
  } finally {
    a.dispose(); b.dispose();
    await new Promise((resolve) => server.server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
