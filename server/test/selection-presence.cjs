const assert = require("node:assert/strict");
const { CollaborationServer } = require("../dist/websocket/CollaborationServer");
const { parseClientMessage } = require("../dist/websocket/messageValidation");
const { connect } = require("./cursor-presence.cjs");

const point = (line, character) => ({ line, character });
const range = (start, end) => ({ start, end });

async function main() {
  const server = new CollaborationServer(0); server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.server.address().port}`;
  const clients = [];
  try {
    const a = await connect(url), b = await connect(url), outsider = await connect(url);
    clients.push(a, b, outsider);
    a.send({ type: "CREATE_ROOM", member: { memberId: "a", displayName: "A" } });
    const created = await a.wait("ROOM_CREATED"), roomId = created.roomId;
    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "B" } });
    const joined = await b.wait("ROOM_JOINED");
    outsider.send({ type: "CREATE_ROOM", member: { memberId: "other", displayName: "Other" } });
    const otherCreated = await outsider.wait("ROOM_CREATED"), otherRoom = otherCreated.roomId;
    const open = async (client, session, memberId, documentPath, sequence, oldShare) => {
      client.send({ type: "OPEN_DOCUMENT", roomId, documentPath, text: "first\nsecond" });
      await client.wait("DOCUMENT_SYNC", (message) => message.documentPath === documentPath);
      client.send({ type: "SET_SHARED_FILE", roomId, presenceSessionId: session, sequence, documentPath });
      const snapshot = await client.wait("SHARED_FILES", (message) => message.files.some((file) => file.memberId === memberId
        && file.documentPath === documentPath && file.shareId !== oldShare));
      return snapshot.files.find((file) => file.memberId === memberId).shareId;
    };
    const aShare = await open(a, created.presenceSessionId, "a", "src/file.txt", 1);
    const ranges = [range(point(0, 1), point(0, 4)), range(point(1, 0), point(1, 3))];
    const selection = (sequence, selected = ranges, overrides = {}) => ({
      type: "SELECTION_UPDATE", roomId, documentPath: "src/file.txt", presenceSessionId: created.presenceSessionId,
      shareId: aShare, sequence, documentRevision: 0, ranges: selected, ...overrides
    });
    const barrier = async (sequence) => {
      a.send(selection(sequence, ranges, { shareId: "0".repeat(36) }));
      assert.match((await a.wait("ERROR")).message, /old or unauthorized/);
    };
    a.send(selection(1, [ranges[0]])); await barrier(2);
    assert.equal(b.messages.some((message) => message.type === "SELECTION_UPDATE"), false, "unshared recipient is isolated");
    const bOther = await open(b, joined.presenceSessionId, "b", "src/other.txt", 1);
    a.send(selection(2, ranges)); await barrier(3);
    assert.equal(b.messages.some((message) => message.type === "SELECTION_UPDATE"), false, "different path is isolated");
    b.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "src/other.txt" });
    await a.wait("SHARED_FILES", (message) => !message.files.some((file) => file.memberId === "b"));
    const bShare = await open(b, joined.presenceSessionId, "b", "src/file.txt", 2, bOther);
    a.send(selection(3, ranges));
    const delivered = await b.wait("SELECTION_UPDATE");
    assert.equal(delivered.memberId, "a");
    assert.equal(delivered.presenceSessionId, joined.presenceSessionId);
    assert.deepEqual(delivered.ranges, ranges, "multiple disjoint ranges retain line/character coordinates");
    assert.equal(JSON.stringify(delivered).includes("first"), false, "selection carries no selected text");
    assert.equal(outsider.messages.some((message) => message.type === "SELECTION_UPDATE"), false, "other room is isolated");
    a.send(selection(2, [ranges[0]])); await barrier(4);
    assert.equal(b.messages.some((message) => message.type === "SELECTION_UPDATE"), false, "old sequence is dropped");
    a.send(selection(4, []));
    assert.deepEqual((await b.wait("SELECTION_UPDATE")).ranges, [], "collapsed selection clears peer highlight");
    a.send(selection(4, ranges)); await barrier(5);
    assert.equal(b.messages.some((message) => message.type === "SELECTION_UPDATE"), false, "duplicate sequence cannot restore highlight");
    for (const invalid of [
      selection(5, [range(point(1, 2), point(0, 2))]),
      selection(5, [range(point(0, 2), point(0, 2))]),
      selection(5, Array(17).fill(ranges[0])),
      selection(5, [range(point(-1, 0), point(0, 1))]),
      selection(5, [{ ...ranges[0], text: "secret" }]),
      selection(5, ranges, { documentPath: "../secret" }),
      selection(5, ranges, { memberId: "b" })
    ]) assert.throws(() => parseClientMessage(JSON.stringify(invalid)), /Selection|workspace-relative/);
    a.send(selection(5, ranges, { documentPath: "src/other.txt" }));
    assert.match((await a.wait("ERROR")).message, /old or unauthorized/);
    a.send(selection(5, [range(point(1, 99), point(1, 100))]));
    await barrier(6);
    assert.equal(b.messages.some((message) => message.type === "SELECTION_UPDATE"), false, "range outside the server text is dropped");
    outsider.send(selection(5, ranges, { roomId: otherRoom, presenceSessionId: otherCreated.presenceSessionId }));
    assert.match((await outsider.wait("ERROR")).message, /old or unauthorized/);
    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/file.txt", baseRevision: 0, text: "first\nsecond!" });
    await a.wait("DOCUMENT_ACK");
    await b.wait("DOCUMENT_EDIT", (message) => message.revision === 1);
    a.send(selection(6, ranges)); await barrier(7);
    assert.equal(b.messages.some((message) => message.type === "SELECTION_UPDATE"), false, "old document revision is dropped");
    a.send(selection(7, [ranges[0]], { documentRevision: 1 }));
    assert.equal((await b.wait("SELECTION_UPDATE")).documentRevision, 1);
    a.send(selection(8, [], { documentRevision: 0 }));
    assert.deepEqual((await b.wait("SELECTION_UPDATE")).ranges, [], "clear is delivered despite an older revision");
    a.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "src/file.txt" });
    await b.wait("SHARED_FILES", (message) => !message.files.some((file) => file.memberId === "a"));
    a.send(selection(9, ranges, { documentRevision: 1 }));
    assert.match((await a.wait("ERROR")).message, /old or unauthorized/);
    const newShare = await open(a, created.presenceSessionId, "a", "src/file.txt", 2, aShare);
    assert.notEqual(newShare, aShare);
    a.send(selection(10, ranges, { shareId: aShare, documentRevision: 0 }));
    assert.match((await a.wait("ERROR")).message, /old or unauthorized/);
    a.socket.terminate();
    await b.wait("SHARED_FILES", (message) => !message.files.some((file) => file.memberId === "a"));
    const replacement = await connect(url); clients.push(replacement);
    replacement.send({ type: "JOIN_ROOM", roomId, member: { memberId: "a", displayName: "A" } });
    const freshSession = (await replacement.wait("ROOM_JOINED")).presenceSessionId;
    assert.notEqual(freshSession, created.presenceSessionId);
    replacement.send(selection(11, ranges, { presenceSessionId: created.presenceSessionId, shareId: newShare }));
    assert.match((await replacement.wait("ERROR")).message, /old or unauthorized/);
    assert.ok(bShare);
    console.log("PASS: selection single/multiple/empty ranges, identity, path/room isolation, ordering, revision and session guards, malformed/cap rejection, close/disconnect cleanup");
  } finally {
    for (const client of clients) client.socket.terminate();
    await new Promise((resolve) => server.server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
