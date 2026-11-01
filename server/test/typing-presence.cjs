const assert = require("node:assert/strict");
const { CollaborationServer } = require("../dist/websocket/CollaborationServer");
const { parseClientMessage } = require("../dist/websocket/messageValidation");
const { connect, delay } = require("./cursor-presence.cjs");

async function main() {
  const server = new CollaborationServer(0); server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.server.address().port}`;
  const clients = [];
  try {
    const a = await connect(url), b = await connect(url), c = await connect(url), outsider = await connect(url);
    clients.push(a, b, c, outsider);
    a.send({ type: "CREATE_ROOM", member: { memberId: "a", displayName: "Alice" } });
    const created = await a.wait("ROOM_CREATED"), roomId = created.roomId;
    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "Bob" } });
    const joined = await b.wait("ROOM_JOINED");
    outsider.send({ type: "CREATE_ROOM", member: { memberId: "other", displayName: "Other" } });
    const otherRoom = (await outsider.wait("ROOM_CREATED")).roomId;
    const open = async (client, session, memberId, path, sequence) => {
      client.send({ type: "OPEN_DOCUMENT", roomId, documentPath: path, text: "sample" });
      await client.wait("DOCUMENT_SYNC", (message) => message.documentPath === path);
      client.send({ type: "SET_SHARED_FILE", roomId, presenceSessionId: session, sequence, documentPath: path });
      const snapshot = await client.wait("SHARED_FILES", (message) => message.files.some((file) => file.memberId === memberId && file.documentPath === path));
      return snapshot.files.find((file) => file.memberId === memberId).shareId;
    };
    const aShare = await open(a, created.presenceSessionId, "a", "src/x.txt", 1);
    const update = (sequence, active, overrides = {}) => ({ type: "TYPING_ACTIVITY", roomId, documentPath: "src/x.txt",
      presenceSessionId: created.presenceSessionId, shareId: aShare, sequence, active, ...overrides });
    a.send(update(1, true));
    const bShareOther = await open(b, joined.presenceSessionId, "b", "src/other.txt", 1);
    assert.equal(b.messages.some((message) => message.type === "TYPING_ACTIVITY"), false, "different path gets no activity");
    b.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "src/other.txt" });
    await a.wait("SHARED_FILES", (message) => !message.files.some((file) => file.memberId === "b"));
    const bShare = await open(b, joined.presenceSessionId, "b", "src/x.txt", 2);
    assert.notEqual(bShare, bShareOther);
    const late = await b.wait("TYPING_ACTIVITY");
    assert.equal(late.memberId, "a");
    assert.equal(late.presenceSessionId, joined.presenceSessionId);
    assert.ok(late.leaseMs > 0 && late.leaseMs <= 1800);
    assert.equal(outsider.messages.some((message) => message.type === "TYPING_ACTIVITY"), false);
    a.send(update(2, true));
    assert.equal((await b.wait("TYPING_ACTIVITY", (message) => message.sequence === 2)).active, true);
    a.send(update(1, false));
    await delay(30);
    assert.equal(b.messages.some((message) => message.type === "TYPING_ACTIVITY" && !message.active), false, "stale stop is dropped");
    a.send(update(3, false));
    assert.equal((await b.wait("TYPING_ACTIVITY", (message) => message.sequence === 3)).leaseMs, 0);
    c.send({ type: "JOIN_ROOM", roomId, member: { memberId: "c", displayName: "Carol" } });
    const cSession = (await c.wait("ROOM_JOINED")).presenceSessionId;
    await open(c, cSession, "c", "src/x.txt", 1);
    assert.equal(c.messages.some((message) => message.type === "TYPING_ACTIVITY"), false, "stopped activity is not restored to late joiner");
    a.send(update(4, true));
    assert.equal((await c.wait("TYPING_ACTIVITY", (message) => message.sequence === 4)).memberId, "a");
    a.send(update(5, true, { shareId: "0".repeat(36) }));
    assert.match((await a.wait("TYPING_REJECTED")).message, /old or unauthorized/);
    a.send(update(5, true, { roomId: otherRoom }));
    assert.match((await a.wait("TYPING_REJECTED")).message, /old or unauthorized/);
    a.send(update(5, true, { documentPath: "src/other.txt" }));
    assert.match((await a.wait("TYPING_REJECTED")).message, /old or unauthorized/);
    for (const invalid of [update(5, true, { text: "secret" }), update(5, "true"), update(5, true, { documentPath: "../secret" }),
      update(0, true), update(5, true, { memberId: "b" })]) {
      assert.throws(() => parseClientMessage(JSON.stringify(invalid)), /Typing|workspace-relative/);
    }
    a.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "src/x.txt" });
    await b.wait("SHARED_FILES", (message) => !message.files.some((file) => file.memberId === "a"));
    a.send(update(5, true));
    assert.match((await a.wait("TYPING_REJECTED")).message, /old or unauthorized/);
    assert.equal(outsider.messages.some((message) => message.type === "TYPING_ACTIVITY"), false);
    console.log("PASS: room/path/session validation, ordered activity, late join snapshot, stale stop, close cleanup and no cross-room activity");
  } finally {
    for (const client of clients) client.socket.close();
    await new Promise((resolve) => server.server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
