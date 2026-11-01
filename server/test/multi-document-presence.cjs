const assert = require("node:assert/strict");
const { CollaborationServer } = require("../dist/websocket/CollaborationServer");
const { connect, delay } = require("./cursor-presence.cjs");

async function main() {
  const server = new CollaborationServer(0); server.start();
  await new Promise(resolve => server.server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.server.address().port}`;
  const clients = [];
  try {
    const a = await connect(url), b = await connect(url), other = await connect(url);
    clients.push(a, b, other);
    a.send({ type: "CREATE_ROOM", member: { memberId: "a", displayName: "A" } });
    const created = await a.wait("ROOM_CREATED"), roomId = created.roomId;
    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "B" } });
    const joined = await b.wait("ROOM_JOINED");
    other.send({ type: "CREATE_ROOM", member: { memberId: "other", displayName: "Other" } });
    await other.wait("ROOM_CREATED");
    const open = async (client, memberId, documentPath, shareSessionId) => {
      client.send({ type: "OPEN_DOCUMENT", roomId, documentPath, text: "abc", shareSessionId });
      await client.wait("DOCUMENT_SYNC", message => message.documentPath === documentPath && message.shareSessionId === shareSessionId);
      const snapshot = await client.wait("SHARED_FILES", message => message.openShares?.some(share =>
        share.memberId === memberId && share.documentPath === documentPath && share.shareSessionId === shareSessionId));
      return snapshot.openShares.find(share => share.memberId === memberId && share.documentPath === documentPath
        && share.shareSessionId === shareSessionId).shareId;
    };
    const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
    const aA = await open(a, "a", "A.txt", id(1));
    const aB = await open(a, "a", "B.txt", id(2));
    await open(b, "b", "A.txt", id(3));
    await open(b, "b", "B.txt", id(4));
    const cursor = (shareId, sequence, documentPath = "B.txt") => ({ type: "CURSOR_UPDATE", roomId, documentPath,
      presenceSessionId: created.presenceSessionId, shareId, sequence, position: { line: 0, character: 1 } });
    a.send(cursor(aB, 1));
    const delivered = await b.wait("CURSOR_UPDATE", message => message.documentPath === "B.txt");
    assert.equal(delivered.recipientShareSessionId, id(4));
    assert.equal(delivered.shareId, aB);
    assert.equal(other.messages.some(message => message.type === "CURSOR_UPDATE"), false);
    a.send({ type: "SELECTION_UPDATE", roomId, documentPath: "B.txt", presenceSessionId: created.presenceSessionId,
      shareId: aB, sequence: 1, documentRevision: 0,
      ranges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }] });
    assert.equal((await b.wait("SELECTION_UPDATE", message => message.documentPath === "B.txt")).recipientShareSessionId, id(4));
    a.send({ type: "TYPING_ACTIVITY", roomId, documentPath: "B.txt", presenceSessionId: created.presenceSessionId,
      shareId: aB, sequence: 1, active: true });
    assert.equal((await b.wait("TYPING_ACTIVITY", message => message.documentPath === "B.txt")).recipientShareSessionId, id(4));
    assert.equal(b.messages.some(message => message.type === "CURSOR_UPDATE" && message.documentPath === "A.txt"), false);
    console.log("PASS: concurrent A/B presence routes B cursor, selection and Recent edit by path, room and recipient share generation");

    a.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "B.txt", shareSessionId: id(2) });
    await b.wait("SHARED_FILES", message => !message.openShares?.some(share => share.memberId === "a" && share.documentPath === "B.txt"));
    a.send(cursor(aB, 2));
    assert.match((await a.wait("ERROR")).message, /old or unauthorized/);
    a.send(cursor(aA, 1, "A.txt"));
    assert.equal((await b.wait("CURSOR_UPDATE", message => message.documentPath === "A.txt")).recipientShareSessionId, id(3));
    const newB = await open(a, "a", "B.txt", id(5));
    assert.notEqual(newB, aB);
    a.send(cursor(aB, 3));
    assert.match((await a.wait("ERROR")).message, /old or unauthorized/);
    a.send(cursor(newB, 1));
    await b.wait("CURSOR_UPDATE", message => message.documentPath === "B.txt" && message.shareId === newB);
    b.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "B.txt", shareSessionId: id(4) });
    await a.wait("SHARED_FILES", message => !message.openShares?.some(share => share.memberId === "b" && share.documentPath === "B.txt"));
    a.send(cursor(newB, 2)); await delay(30);
    assert.equal(b.messages.some(message => message.type === "CURSOR_UPDATE" && message.sequence === 2 && message.documentPath === "B.txt"), false);
    console.log("PASS: close B keeps A active; old sender token and closed recipient cannot receive stale B indicators");
  } finally {
    for (const client of clients) client.socket.terminate();
    await new Promise(resolve => server.server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
