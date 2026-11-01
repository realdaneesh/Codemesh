const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { CollaborationServer } = require("../dist/websocket/CollaborationServer");
const { parseClientMessage } = require("../dist/websocket/messageValidation");
const limits = require("../dist/types/syncLimits");

async function connect(url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return {
    socket,
    send: (message) => socket.send(JSON.stringify(message)),
    wait: (type, predicate = () => true, timeoutMs = 1000) => new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const index = messages.findIndex((message) => message.type === type && predicate(message));
        if (index >= 0) return resolve(messages.splice(index, 1)[0]);
        if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${type}`));
        setTimeout(poll, 5);
      };
      poll();
    }),
    waitForNoMessage: (type, predicate = () => true, timeoutMs = 80) => new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const index = messages.findIndex((message) => message.type === type && predicate(message));
        if (index >= 0) return reject(new Error(`Unexpected ${type}: ${JSON.stringify(messages[index])}`));
        if (Date.now() > deadline) return resolve();
        setTimeout(poll, 5);
      };
      poll();
    })
  };
}

async function main() {
  const clientLimits = require("../../extension/dist/types/syncLimits");
  for (const key of ["MAX_DOCUMENT_BYTES", "MAX_MESSAGE_BYTES", "MAX_DOCUMENT_PATH_BYTES"]) {
    assert.equal(limits[key], clientLimits[key], `client and server ${key} must match`);
  }
  const envelope = { type: "OPEN_DOCUMENT", roomId: "ABC234", documentPath: "text.txt", text: "" };
  assert.equal(parseClientMessage(JSON.stringify({ ...envelope, text: "\u0000".repeat(limits.MAX_DOCUMENT_BYTES) })).text.length, limits.MAX_DOCUMENT_BYTES);
  assert.throws(() => parseClientMessage(JSON.stringify({ ...envelope, text: "x".repeat(limits.MAX_DOCUMENT_BYTES + 1) })), /256 KiB/);
  assert.throws(() => parseClientMessage(JSON.stringify({ ...envelope, text: "\u4e2d".repeat(Math.floor(limits.MAX_DOCUMENT_BYTES / 3) + 1) })), /256 KiB/);
  assert.throws(() => parseClientMessage(JSON.stringify({ ...envelope, documentPath: "x".repeat(limits.MAX_DOCUMENT_PATH_BYTES + 1) })), /1024-byte/);
  assert.throws(() => parseClientMessage(" ".repeat(limits.MAX_MESSAGE_BYTES + 1)), /2 MiB/);
  const server = new CollaborationServer(0);
  server.start();
  await once(server.server, "listening");
  const address = server.server.address();
  assert.equal(typeof address, "object");

  const url = `ws://127.0.0.1:${address.port}`;
  const clients = [];
  try {
    const a = await connect(url); clients.push(a);
    const b = await connect(url); clients.push(b);
    const c = await connect(url); clients.push(c);

    a.send({ type: "CREATE_ROOM", member: { memberId: "a", displayName: "A" } });
    const roomId = (await a.wait("ROOM_CREATED")).roomId;
    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "B" } });
    await b.wait("ROOM_JOINED");
    await a.wait("MEMBERS_UPDATED", (message) => message.members.length === 2);

    a.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "src/shared.txt", text: "one" });
    assert.deepEqual(
      pickSync(await a.wait("DOCUMENT_SYNC")),
      { roomId, documentPath: "src/shared.txt", revision: 0, text: "one" }
    );

    b.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "src/shared.txt", text: "local joiner text" });
    assert.deepEqual(
      pickSync(await b.wait("DOCUMENT_SYNC")),
      { roomId, documentPath: "src/shared.txt", revision: 0, text: "one" }
    );

    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: 0, text: "two" });
    assert.deepEqual(
      pickAck(await a.wait("DOCUMENT_ACK")),
      { roomId, documentPath: "src/shared.txt", revision: 1 }
    );
    assert.deepEqual(
      pickEdit(await b.wait("DOCUMENT_EDIT")),
      { roomId, documentPath: "src/shared.txt", revision: 1, text: "two" }
    );
    await a.waitForNoMessage("DOCUMENT_EDIT", (message) => message.documentPath === "src/shared.txt");

    b.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: 1, text: "three" });
    assert.deepEqual(
      pickAck(await b.wait("DOCUMENT_ACK")),
      { roomId, documentPath: "src/shared.txt", revision: 2 }
    );
    assert.deepEqual(
      pickEdit(await a.wait("DOCUMENT_EDIT")),
      { roomId, documentPath: "src/shared.txt", revision: 2, text: "three" }
    );
    await b.waitForNoMessage("DOCUMENT_EDIT", (message) => message.documentPath === "src/shared.txt");

    c.send({ type: "CREATE_ROOM", member: { memberId: "c", displayName: "C" } });
    const otherRoomId = (await c.wait("ROOM_CREATED")).roomId;
    c.send({ type: "OPEN_DOCUMENT", roomId: otherRoomId, documentPath: "src/shared.txt", text: "isolated" });
    assert.deepEqual(
      pickSync(await c.wait("DOCUMENT_SYNC")),
      { roomId: otherRoomId, documentPath: "src/shared.txt", revision: 0, text: "isolated" }
    );

    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: 2, text: "four" });
    await a.wait("DOCUMENT_ACK", (message) => message.revision === 3);
    await b.wait("DOCUMENT_EDIT", (message) => message.revision === 3 && message.text === "four");
    await c.waitForNoMessage("DOCUMENT_EDIT", (message) => message.documentPath === "src/shared.txt");

    b.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: 1, text: "stale" });
    assert.deepEqual(
      pickSync(await b.wait("DOCUMENT_CONFLICT")),
      { roomId, documentPath: "src/shared.txt", revision: 3, text: "four" }
    );
    await a.waitForNoMessage("DOCUMENT_EDIT", (message) => message.text === "stale");

    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: 3, text: "rapid-one" });
    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: 3, text: "rapid-two" });
    await a.wait("DOCUMENT_ACK", (message) => message.revision === 4);
    await b.wait("DOCUMENT_EDIT", (message) => message.revision === 4 && message.text === "rapid-one");
    await a.wait("DOCUMENT_CONFLICT", (message) => message.revision === 4 && message.text === "rapid-one");
    await b.waitForNoMessage("DOCUMENT_EDIT", (message) => message.text === "rapid-two");

    b.send({ type: "CLOSE_DOCUMENT", roomId, documentPath: "src/shared.txt" });
    b.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: 4, text: "closed draft" });
    await b.wait("ERROR", (message) => /not open/.test(message.message));
    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: 4, text: "after close" });
    await a.wait("DOCUMENT_ACK", (message) => message.revision === 5);
    await b.waitForNoMessage("DOCUMENT_EDIT");
    b.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "src/shared.txt", text: "closed draft" });
    await b.wait("DOCUMENT_SYNC", (message) => message.revision === 5 && message.text === "after close");
    b.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "src/other.txt", text: "other" });
    await b.wait("DOCUMENT_SYNC", (message) => message.documentPath === "src/other.txt");
    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: 5, text: "after switch" });
    await a.wait("DOCUMENT_ACK", (message) => message.revision === 6);
    await b.wait("DOCUMENT_EDIT", (message) => message.documentPath === "src/shared.txt" && message.revision === 6 && message.text === "after switch");
    b.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "src/shared.txt", text: "after switch" });
    await b.wait("DOCUMENT_SYNC", (message) => message.revision === 6);
    let revision = 6;
    for (const [index, text] of ["first\nsecond\nlast", "first\r\n\u4e2d\u6587 \ud83d\ude80 e\u0301\r\nlast", "", "x".repeat(limits.MAX_DOCUMENT_BYTES), "\u0000".repeat(limits.MAX_DOCUMENT_BYTES)].entries()) {
      const sender = index % 2 === 0 ? a : b;
      const receiver = sender === a ? b : a;
      sender.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: revision, text });
      revision += 1;
      await sender.wait("DOCUMENT_ACK", (message) => message.revision === revision);
      const received = await receiver.wait("DOCUMENT_EDIT", (message) => message.revision === revision);
      assert.equal(received.text, text.replace(/\r\n/g, "\n"));
      await sender.waitForNoMessage("DOCUMENT_EDIT");
    }
    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: revision, text: "x".repeat(limits.MAX_DOCUMENT_BYTES + 1) });
    await a.wait("ERROR", (message) => /256 KiB/.test(message.message));
    await b.waitForNoMessage("DOCUMENT_EDIT");
    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "src/shared.txt", baseRevision: revision, text: "after rejected edit" });
    revision += 1;
    await a.wait("DOCUMENT_ACK", (message) => message.revision === revision);
    await b.wait("DOCUMENT_EDIT", (message) => message.revision === revision && message.text === "after rejected edit");
    c.send({ type: "OPEN_DOCUMENT", roomId: otherRoomId, documentPath: "large.txt", text: "x".repeat(limits.MAX_DOCUMENT_BYTES + 1) });
    await c.wait("ERROR", (message) => /256 KiB/.test(message.message));
    const closed = new Promise((resolve) => c.socket.once("close", resolve));
    c.socket.send(" ".repeat(limits.MAX_MESSAGE_BYTES + 1));
    assert.equal(await closed, 1009, "oversized WebSocket frame is rejected before JSON parsing");
    console.log("PASS: two-client multiline/Unicode/CRLF/deletion, 256 KiB boundary and escaping, rejected edit retains revision, oversized open and 2 MiB transport limit");
    console.log("PASS: document sync initial text, bidirectional edits, ack, no echo, room isolation, stale conflict, rapid stale rejection, close and concurrent document membership");
  } finally {
    for (const client of clients) client.socket.close();
    await new Promise((resolve) => server.server.close(resolve));
  }
}

function pickSync(message) {
  return {
    roomId: message.roomId,
    documentPath: message.documentPath,
    revision: message.revision,
    text: message.text
  };
}

function pickEdit(message) {
  return pickSync(message);
}

function pickAck(message) {
  return {
    roomId: message.roomId,
    documentPath: message.documentPath,
    revision: message.revision
  };
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once("error", reject);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
