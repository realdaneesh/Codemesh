const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { randomUUID } = require("node:crypto");
const { CollaborationServer } = require("../dist/websocket/CollaborationServer");
async function waitFor(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for server state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function connect(url) {
  const socket = new WebSocket(url), messages = [];
  socket.on("message", raw => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return {
    socket, messages, shares: new Map(), send: value => socket.send(JSON.stringify(value)),
    async take(type, match = () => true) {
      const end = Date.now() + 2000;
      while (Date.now() < end) {
        const index = messages.findIndex(value => value.type === type && match(value));
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for ${type}`);
    }
  };
}

async function main() {
  const server = new CollaborationServer(0);
  server.start();
  await new Promise(resolve => server.server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.server.address().port}`;
  const clients = [];
  const open = async (client, roomId, documentPath, text, shareSessionId = randomUUID()) => {
    client.send({ type: "OPEN_DOCUMENT", roomId, documentPath, text, shareSessionId });
    const sync = await client.take("DOCUMENT_SYNC", value => value.documentPath === documentPath);
    assert.equal(sync.shareSessionId, shareSessionId);
    client.shares.set(documentPath, shareSessionId);
    return shareSessionId;
  };
  const edit = async (sender, receiver, roomId, documentPath, baseRevision, text) => {
    sender.send({ type: "DOCUMENT_EDIT", roomId, documentPath, baseRevision, text, shareSessionId: sender.shares.get(documentPath) });
    const ack = await sender.take("DOCUMENT_ACK", value => value.documentPath === documentPath);
    assert.equal(ack.revision, baseRevision + 1);
    assert.equal(ack.shareSessionId, sender.shares.get(documentPath));
    const received = await receiver.take("DOCUMENT_EDIT", value => value.documentPath === documentPath);
    assert.equal(received.text, text);
    assert.equal(received.shareSessionId, receiver.shares.get(documentPath));
    assert.equal(sender.messages.some(value => value.type === "DOCUMENT_EDIT" && value.documentPath === documentPath && value.text === text), false);
  };
  try {
    const a = await connect(url), b = await connect(url), c = await connect(url); clients.push(a, b, c);
    a.send({ type: "CREATE_ROOM", member: { memberId: "a", displayName: "A" } });
    const roomId = (await a.take("ROOM_CREATED")).roomId;
    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "B" } });
    await b.take("ROOM_JOINED");
    const socketFor = memberId => [...server.presenceSessions].find(([, session]) => session.roomId === roomId && session.memberId === memberId)?.[0];
    const aServerSocket = socketFor("a"), bServerSocket = socketFor("b");
    const aA = await open(a, roomId, "A.txt", "A0");
    const aB = await open(a, roomId, "B.txt", "B0");
    await open(b, roomId, "A.txt", "ignored A");
    await open(b, roomId, "B.txt", "ignored B");
    const snapshot = await a.take("SHARED_FILES", value => value.openDocuments?.length === 4);
    assert.deepEqual(snapshot.openDocuments.filter(value => value.memberId === "a").map(value => value.documentPath).sort(), ["A.txt", "B.txt"]);
    assert.ok(snapshot.files.length <= 2, "legacy single-path presence stays bounded by members");
    console.log("PASS: A and B remain open concurrently; additive openDocuments presence leaves legacy files bounded");

    await edit(a, b, roomId, "A.txt", 0, "A1");
    await edit(b, a, roomId, "B.txt", 0, "B1");
    await edit(b, a, roomId, "A.txt", 1, "A2");
    await edit(a, b, roomId, "B.txt", 1, "B2");
    assert.equal(server.documents.get(`${roomId}:A.txt`).revision, 2);
    assert.equal(server.documents.get(`${roomId}:B.txt`).revision, 2);
    console.log("PASS: independent bidirectional revisions and edit routing on A and B, with no echo");

    a.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "C.txt", text: "C0", shareSessionId: randomUUID() });
    assert.match((await a.take("ERROR")).message, /at most two open document paths/);
    assert.equal(server.documents.has(`${roomId}:C.txt`), false);
    await edit(a, b, roomId, "A.txt", 2, "A3");
    console.log("PASS: third-path rejection leaves both existing documents active");

    const newerA = await open(a, roomId, "A.txt", "stale local A");
    assert.notEqual(newerA, aA);
    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "A.txt", shareSessionId: aA, baseRevision: 3, text: "stale generation" });
    const staleError = await a.take("ERROR");
    assert.match(staleError.message, /older share session/);
    assert.deepEqual([staleError.roomId, staleError.documentPath, staleError.shareSessionId], [roomId, "A.txt", aA]);
    a.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "A.txt", shareSessionId: aA });
    await edit(a, b, roomId, "A.txt", 3, "A4");
    a.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "A.txt" });
    await edit(a, b, roomId, "A.txt", 4, "A5");
    assert.equal(server.openDocuments.get(aServerSocket).get(`${roomId}:A.txt`).id, newerA);
    console.log("PASS: delayed close with old share generation cannot close a newer A share");

    a.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "A.txt", shareSessionId: newerA });
    await a.take("SHARED_FILES", value => value.openDocuments?.filter(item => item.memberId === "a").length === 1
      && value.openDocuments.some(item => item.memberId === "a" && item.documentPath === "B.txt"));
    assert.equal(server.documents.get(`${roomId}:A.txt`).clients.has(aServerSocket), false);
    await edit(b, a, roomId, "B.txt", 2, "B3");
    // A's B membership remains, while a closed A cannot send another edit.
    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "A.txt", shareSessionId: newerA, baseRevision: 5, text: "closed" });
    assert.match((await a.take("ERROR")).message, /not open/);
    assert.equal(server.openDocuments.get(aServerSocket).get(`${roomId}:B.txt`).id, aB);
    console.log("PASS: close A removes only A; B continues and closed A cannot edit");

    c.send({ type: "CREATE_ROOM", member: { memberId: "c", displayName: "C" } });
    const otherRoom = (await c.take("ROOM_CREATED")).roomId;
    await open(c, otherRoom, "B.txt", "other room");
    assert.equal(server.documents.get(`${otherRoom}:B.txt`).revision, 0);
    assert.equal(server.documents.get(`${roomId}:B.txt`).text, "B3");
    console.log("PASS: identical path in another room has independent text, revision and membership");

    b.send({ type: "LEAVE_ROOM" });
    await waitFor(() => !server.openDocuments.has(bServerSocket));
    assert.equal(server.openDocuments.has(bServerSocket), false);
    assert.equal(server.documents.get(`${roomId}:B.txt`).clients.has(bServerSocket), false);
    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "B" } });
    await b.take("ROOM_JOINED");
    await open(b, roomId, "A.txt", "new A");
    await open(b, roomId, "B.txt", "new B");
    b.socket.terminate();
    await waitFor(() => !server.openDocuments.has(bServerSocket));
    assert.equal(server.openDocuments.has(bServerSocket), false);
    assert.equal(server.documents.get(`${roomId}:B.txt`).clients.has(bServerSocket), false);
    console.log("PASS: leave and disconnect remove all paths without disturbing another member");

    const old = await connect(url), replacement = await connect(url); clients.push(old, replacement);
    old.send({ type: "JOIN_ROOM", roomId, member: { memberId: "same", displayName: "Same" } });
    await old.take("ROOM_JOINED");
    const oldServerSocket = socketFor("same");
    await open(old, roomId, "A.txt", "old A");
    await open(old, roomId, "B.txt", "old B");
    replacement.send({ type: "JOIN_ROOM", roomId, member: { memberId: "same", displayName: "Same" } });
    await replacement.take("ROOM_JOINED");
    assert.equal(server.openDocuments.has(oldServerSocket), false);
    assert.equal(server.documents.get(`${roomId}:A.txt`)?.clients.has(oldServerSocket) ?? false, false);
    assert.equal(server.documents.get(`${roomId}:B.txt`).clients.has(oldServerSocket), false);
    console.log("PASS: replacement of a stale member connection removes both old paths");

    replacement.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "legacy.txt", text: "one" });
    const legacy = (await replacement.take("DOCUMENT_SYNC", value => value.documentPath === "legacy.txt")).shareSessionId;
    replacement.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "legacy.txt" });
    await waitFor(() => !server.openDocuments.has(socketFor("same")));
    assert.equal(server.openDocuments.has(socketFor("same")), false);
    assert.ok(legacy);
    console.log("PASS: existing tokenless single-file close remains supported");

    const replacementSocket = socketFor("same");
    const switchA = await open(replacement, roomId, "A.txt", "switch A");
    await open(replacement, roomId, "B.txt", "switch B");
    replacement.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "A.txt", baseRevision: 0, text: "Stage 1 edit" });
    assert.equal((await replacement.take("DOCUMENT_ACK", value => value.documentPath === "A.txt")).revision, 1);
    replacement.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "A.txt", shareSessionId: switchA, baseRevision: 1, text: "Stage 2 edit" });
    assert.equal((await replacement.take("DOCUMENT_ACK", value => value.documentPath === "A.txt")).revision, 2);
    replacement.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "A.txt", baseRevision: 2, text: "stale tokenless edit" });
    assert.match((await replacement.take("ERROR")).message, /older share session/);
    console.log("PASS: Stage 1 tokenless edits remain compatible until a session sends tokened edits");
    replacement.send({ type: "CREATE_ROOM", member: { memberId: "same", displayName: "Same" } });
    await replacement.take("ROOM_CREATED", value => value.roomId !== roomId);
    assert.equal(server.openDocuments.has(replacementSocket), false);
    assert.equal(server.documents.get(`${roomId}:A.txt`)?.clients.has(replacementSocket) ?? false, false);
    assert.equal(server.documents.get(`${roomId}:B.txt`)?.clients.has(replacementSocket) ?? false, false);
    console.log("PASS: room switch removes every previously open path");
  } finally {
    for (const client of clients) client.socket.terminate();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise(resolve => server.server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
