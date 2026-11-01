const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { CollaborationServer } = require("../dist/websocket/CollaborationServer");
const { parseClientMessage } = require("../dist/websocket/messageValidation");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect(url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return {
    socket, messages, send: (message) => socket.send(JSON.stringify(message)),
    async wait(type, predicate = () => true) {
      for (let i = 0; i < 600; i += 1) {
        const index = messages.findIndex((message) => message.type === type && predicate(message));
        if (index >= 0) return messages.splice(index, 1)[0];
        await delay(5);
      }
      throw new Error(`Timed out waiting for ${type}`);
    }
  };
}

async function main() {
  const server = new CollaborationServer(0);
  server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.server.address().port}`;
  const clients = [];
  try {
    const a = await connect(url), b = await connect(url), c = await connect(url);
    clients.push(a, b, c);
    a.send({ type: "CREATE_ROOM", member: { memberId: "a", displayName: "A" } });
    const created = await a.wait("ROOM_CREATED"), roomId = created.roomId;
    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "B" } });
    const joined = await b.wait("ROOM_JOINED");
    c.send({ type: "CREATE_ROOM", member: { memberId: "c", displayName: "C" } });
    const other = await c.wait("ROOM_CREATED");
    const open = async (client, session, memberId, documentPath, sequence, previousShareId) => {
      client.send({ type: "OPEN_DOCUMENT", roomId, documentPath, text: "one\ntwo" });
      await client.wait("DOCUMENT_SYNC", (message) => message.documentPath === documentPath);
      client.send({ type: "SET_SHARED_FILE", roomId, presenceSessionId: session, sequence, documentPath });
      const snapshot = await client.wait("SHARED_FILES", (message) => message.files.some((file) => file.memberId === memberId
        && file.documentPath === documentPath && file.shareId !== previousShareId));
      return snapshot.files.find((file) => file.memberId === memberId).shareId;
    };
    const aShare = await open(a, created.presenceSessionId, "a", "src/x.txt", 1);
    const cursor = (session, shareId, sequence, documentPath = "src/x.txt") => ({
      type: "CURSOR_UPDATE", roomId, documentPath, presenceSessionId: session, shareId, sequence,
      position: { line: 1, character: 2 }
    });
    const barrier = async (sequence) => {
      a.send(cursor(created.presenceSessionId, "0".repeat(36), sequence));
      assert.match((await a.wait("ERROR")).message, /old or unauthorized/);
    };
    a.send(cursor(created.presenceSessionId, aShare, 1));
    await barrier(2);
    assert.equal(b.messages.some((message) => message.type === "CURSOR_UPDATE"), false, "recipient must explicitly share the same path");
    const bOther = await open(b, joined.presenceSessionId, "b", "src/other.txt", 1);
    a.send(cursor(created.presenceSessionId, aShare, 2));
    await barrier(3);
    assert.equal(b.messages.some((message) => message.type === "CURSOR_UPDATE"), false, "different path is isolated");
    b.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "src/other.txt" });
    await a.wait("SHARED_FILES", (message) => !message.files.some((file) => file.memberId === "b"));
    const bShare = await open(b, joined.presenceSessionId, "b", "src/x.txt", 2);
    assert.notEqual(bOther, bShare);
    const togetherRevision = server.presenceRevisions.get(roomId);
    a.send(cursor(created.presenceSessionId, aShare, 3));
    const delivered = await b.wait("CURSOR_UPDATE");
    assert.deepEqual(delivered.position, { line: 1, character: 2 });
    assert.equal(delivered.memberId, "a", "identity comes from room membership");
    assert.equal(delivered.presenceSessionId, joined.presenceSessionId, "recipient gets its own room-session token");
    assert.equal(JSON.stringify(delivered).includes("one"), false, "cursor contains no text");
    assert.equal(c.messages.some((message) => message.type === "CURSOR_UPDATE"), false, "different room is isolated");
    a.send(cursor(created.presenceSessionId, aShare, 2));
    await barrier(4);
    assert.equal(b.messages.some((message) => message.type === "CURSOR_UPDATE"), false, "old sequence is dropped");
    a.send(cursor(created.presenceSessionId, aShare, 4, "src/other.txt"));
    assert.match((await a.wait("ERROR")).message, /old or unauthorized/);
    c.send(cursor(other.presenceSessionId, aShare, 4));
    assert.match((await c.wait("ERROR")).message, /old or unauthorized/);
    for (const position of [{ line: -1, character: 0 }, { line: 1.5, character: 0 }, { line: 0, character: 1000001 }]) {
      assert.throws(() => parseClientMessage(JSON.stringify({ ...cursor(created.presenceSessionId, aShare, 4), position })), /Cursor position/);
    }
    assert.throws(() => parseClientMessage(JSON.stringify({ ...cursor(created.presenceSessionId, aShare, 4), text: "private" })), /unsupported fields/);
    assert.throws(() => parseClientMessage(JSON.stringify(cursor(created.presenceSessionId, aShare, 4, "../secret"))), /workspace-relative/);
    a.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "src/x.txt" });
    const closed = await b.wait("SHARED_FILES", (message) => message.revision > togetherRevision
      && !message.files.some((file) => file.memberId === "a"));
    a.send(cursor(created.presenceSessionId, aShare, 5));
    assert.match((await a.wait("ERROR")).message, /old or unauthorized/);
    const newShare = await open(a, created.presenceSessionId, "a", "src/x.txt", 2, aShare);
    assert.notEqual(newShare, aShare, "re-sharing creates a new document session");
    a.send(cursor(created.presenceSessionId, aShare, 6));
    assert.match((await a.wait("ERROR")).message, /old or unauthorized/);
    a.send(cursor(created.presenceSessionId, newShare, 1));
    await b.wait("CURSOR_UPDATE", (message) => message.shareId === newShare);
    a.socket.terminate();
    await b.wait("SHARED_FILES", (message) => message.revision > closed.revision
      && !message.files.some((file) => file.memberId === "a"));
    const rejoined = await connect(url); clients.push(rejoined);
    rejoined.send({ type: "JOIN_ROOM", roomId, member: { memberId: "a", displayName: "A" } });
    const newSession = (await rejoined.wait("ROOM_JOINED")).presenceSessionId;
    assert.notEqual(newSession, created.presenceSessionId);
    rejoined.send(cursor(created.presenceSessionId, newShare, 2));
    assert.match((await rejoined.wait("ERROR")).message, /old or unauthorized/);
    console.log("PASS: cursor path/room/member/session authorization, ordered delivery, stale sequence and share rejection, payload limits, close/disconnect/rejoin cleanup");
  } finally {
    for (const client of clients) client.socket.terminate();
    await new Promise((resolve) => server.server.close(resolve));
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { connect, delay };
