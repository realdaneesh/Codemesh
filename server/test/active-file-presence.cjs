const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { CollaborationServer } = require("../dist/websocket/CollaborationServer");
const { parseClientMessage } = require("../dist/websocket/messageValidation");

async function connect(url) {
  const socket = new WebSocket(url), messages = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return {
    socket, messages, send: (message) => socket.send(JSON.stringify(message)),
    wait: async (type, predicate = () => true) => {
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        const index = messages.findIndex((message) => message.type === type && predicate(message));
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("Timed out waiting for " + type);
    }
  };
}

async function main() {
  const bad = { type: "SET_SHARED_FILE", roomId: "ABC234", presenceSessionId: "a".repeat(36), sequence: 1, documentPath: "src/a.txt" };
  for (const path of ["/absolute.txt", "../secret", "C:\\private.txt", "a//b", "a/./b"]) {
    assert.throws(() => parseClientMessage(JSON.stringify({ ...bad, documentPath: path })), /workspace-relative/);
  }
  assert.throws(() => parseClientMessage(JSON.stringify({ ...bad, documentPath: "x".repeat(1025) })), /1024-byte/);
  assert.throws(() => parseClientMessage(JSON.stringify({ ...bad, sequence: -1 })), /positive sequence/);
  assert.throws(() => parseClientMessage(JSON.stringify({ ...bad, text: "secret" })), /unsupported fields/);
  const server = new CollaborationServer(0); server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.server.address().port}`;
  const presence = (memberId, roomId) => [...server.presenceSessions.values()]
    .find((entry) => entry.memberId === memberId && entry.roomId === roomId);
  const clients = [];
  try {
    const a = await connect(url), b = await connect(url), c = await connect(url); clients.push(a, b, c);
    a.send({ type: "CREATE_ROOM", member: { memberId: "a", displayName: "A" } });
    const created = await a.wait("ROOM_CREATED"), roomId = created.roomId, aSession = created.presenceSessionId;
    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "B" } });
    const bSession = (await b.wait("ROOM_JOINED")).presenceSessionId;
    c.send({ type: "CREATE_ROOM", member: { memberId: "c", displayName: "C" } });
    const otherRoom = (await c.wait("ROOM_CREATED")).roomId;
    assert.deepEqual((await b.wait("SHARED_FILES", (message) => message.files.length === 0)).files, []);
    const set = (client, session, sequence, documentPath, inRoom = roomId) => client.send({
      type: "SET_SHARED_FILE", roomId: inRoom, presenceSessionId: session, sequence, documentPath
    });
    set(a, aSession, 1, "src/a.txt");
    assert.match((await a.wait("ERROR")).message, /not open/);
    a.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "src/a.txt", text: "private text" });
    await a.wait("DOCUMENT_SYNC"); set(a, aSession, 1, "src/a.txt");
    const first = await b.wait("SHARED_FILES", (message) => message.files.some((file) => file.documentPath === "src/a.txt"));
    assert.deepEqual(first.files.map(({ memberId, documentPath }) => ({ memberId, documentPath })), [{ memberId: "a", documentPath: "src/a.txt" }]);
    assert.match(first.files[0].shareId, /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.stringify(first).includes("private text"), false);
    assert.equal(presence("c", otherRoom).documentPath, undefined);
    b.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "src/b.txt", text: "b" }); await b.wait("DOCUMENT_SYNC");
    set(b, bSession, 1, "src/b.txt");
    const both = await a.wait("SHARED_FILES", (message) => message.files.length === 2);
    b.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "src/b.txt" });
    await a.wait("SHARED_FILES", (message) => message.revision > both.revision && message.files.length === 1 && message.files[0].memberId === "a");
    set(b, bSession, 1, "src/b.txt");
    set(b, bSession, 2, "src/b.txt");
    assert.match((await b.wait("ERROR")).message, /not open/);
    assert.equal(presence("b", roomId).documentPath, undefined, "delayed old update stays cleared");
    a.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "src/a.txt" });
    await b.wait("SHARED_FILES", (message) => message.files.length === 0 && message.revision > first.revision);
    a.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "src/new.txt", text: "new" }); await a.wait("DOCUMENT_SYNC");
    set(a, aSession, 3, "src/new.txt");
    await b.wait("SHARED_FILES", (message) => message.files.some((file) => file.documentPath === "src/new.txt"));
    set(a, aSession, 2, "src/a.txt");
    set(a, aSession, 4, "src/a.txt");
    assert.match((await a.wait("ERROR")).message, /not open/);
    assert.equal(presence("a", roomId).documentPath, "src/new.txt", "older sequence cannot restore an old file");
    set(c, (await c.wait("SHARED_FILES")).presenceSessionId, 1, "src/new.txt", roomId);
    assert.match((await c.wait("ERROR")).message, /old or unauthorized/);
    b.send({ type: "LEAVE_ROOM" });
    await a.wait("MEMBERS_UPDATED", (message) => message.members.length === 1);
    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "B" } });
    const freshSession = (await b.wait("ROOM_JOINED")).presenceSessionId;
    assert.notEqual(freshSession, bSession);
    assert.deepEqual((await b.wait("SHARED_FILES", (message) => message.presenceSessionId === freshSession)).files.map(({ memberId, documentPath }) => ({ memberId, documentPath })),
      [{ memberId: "a", documentPath: "src/new.txt" }]);
    set(b, bSession, 2, "src/b.txt");
    assert.match((await b.wait("ERROR")).message, /old or unauthorized/);
    assert.equal(presence("b", roomId).documentPath, undefined);
    b.socket.terminate(); await a.wait("MEMBERS_UPDATED", (message) => message.members.length === 1);
    const replacement = await connect(url); clients.push(replacement);
    replacement.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "B" } });
    const replacementSession = (await replacement.wait("ROOM_JOINED")).presenceSessionId;
    assert.notEqual(replacementSession, freshSession);
    assert.deepEqual((await replacement.wait("SHARED_FILES", (message) => message.presenceSessionId === replacementSession)).files.map(({ memberId, documentPath }) => ({ memberId, documentPath })),
      [{ memberId: "a", documentPath: "src/new.txt" }]);
    assert.equal(presence("b", roomId).documentPath, undefined);
    assert.notEqual(otherRoom, roomId);
    assert.equal(presence("c", otherRoom).documentPath, undefined);
    assert.ok(c.messages.filter((message) => message.type === "SHARED_FILES").every((message) => message.roomId === otherRoom));
    console.log("PASS: room-scoped shared-file snapshots, explicit open/close, path and membership validation, delayed sequence, leave, disconnect and fresh reconnect session");
  } finally {
    for (const client of clients) client.socket.terminate();
    await new Promise((resolve) => server.server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
