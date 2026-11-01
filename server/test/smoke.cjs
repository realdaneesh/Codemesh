const assert = require("node:assert/strict");
const WebSocket = require("ws");

const url = process.env.CODEMESH_SERVER_URL || "ws://localhost:3977";

async function connect() {
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
    wait: (type, predicate = () => true) => new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        const index = messages.findIndex((message) => message.type === type && predicate(message));
        if (index >= 0) return resolve(messages.splice(index, 1)[0]);
        if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${type}`));
        setTimeout(poll, 5);
      };
      poll();
    })
  };
}

async function main() {
  const clients = [];
  try {
    const a = await connect(); clients.push(a);
    const b = await connect(); clients.push(b);
    const c = await connect(); clients.push(c);

    a.send({ type: "CREATE_ROOM", member: { memberId: "a", displayName: "User A" } });
    const { roomId } = await a.wait("ROOM_CREATED");
    assert.match(roomId, /^[A-Z2-9]{6}$/);

    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "User B" } });
    assert.equal((await b.wait("ROOM_JOINED")).members.length, 2);
    assert.equal((await a.wait("MEMBERS_UPDATED", (message) => message.members.length === 2)).members.length, 2);

    b.send({ type: "LEAVE_ROOM" });
    assert.deepEqual((await a.wait("MEMBERS_UPDATED", (message) => message.members.length === 1)).members.map((member) => member.displayName), ["User A"]);

    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "User B" } });
    await b.wait("ROOM_JOINED");
    await a.wait("MEMBERS_UPDATED", (message) => message.members.length === 2);
    b.socket.terminate();
    assert.deepEqual((await a.wait("MEMBERS_UPDATED", (message) => message.members.length === 1)).members.map((member) => member.displayName), ["User A"]);

    c.send({ type: "JOIN_ROOM", roomId: "", member: { memberId: "c", displayName: "User C" } });
    assert.match((await c.wait("ERROR")).message, /roomId/);
    c.send({ type: "JOIN_ROOM", roomId: "bad!", member: { memberId: "c", displayName: "User C" } });
    assert.match((await c.wait("ERROR")).message, /valid six-character roomId/);
    c.send({ type: "JOIN_ROOM", roomId: "ZZZZZZ", member: { memberId: "c", displayName: "User C" } });
    assert.match((await c.wait("ERROR")).message, /does not exist/);
    c.socket.send("{broken");
    assert.match((await c.wait("ERROR")).message, /valid JSON/);

    c.send({ type: "JOIN_ROOM", roomId, member: { memberId: "c", displayName: "User C" } });
    await c.wait("ROOM_JOINED");
    await a.wait("MEMBERS_UPDATED", (message) => message.members.length === 2);
    a.send({ type: "CREATE_ROOM", member: { memberId: "a", displayName: "User A" } });
    assert.notEqual((await a.wait("ROOM_CREATED", (message) => message.roomId !== roomId)).roomId, roomId);
    assert.deepEqual((await c.wait("MEMBERS_UPDATED", (message) => message.members.length === 1)).members.map((member) => member.displayName), ["User C"]);

    c.send({ type: "JOIN_ROOM", roomId, member: { memberId: "c", displayName: "User C" } });
    await c.wait("ROOM_JOINED");
    a.send({ type: "JOIN_ROOM", roomId, member: { memberId: "a", displayName: "User A" } });
    assert.equal((await a.wait("ROOM_JOINED")).members.length, 2);
    assert.equal((await c.wait("MEMBERS_UPDATED", (message) => message.members.length === 2)).members.length, 2);

    const replacement = await connect(); clients.push(replacement);
    replacement.send({ type: "JOIN_ROOM", roomId, member: { memberId: "a", displayName: "User A" } });
    const replacementMembers = (await replacement.wait("ROOM_JOINED")).members;
    assert.equal(replacementMembers.length, 2);
    assert.equal(new Set(replacementMembers.map((member) => member.memberId)).size, 2);
    await c.wait("MEMBERS_UPDATED", (message) => message.members.length === 2);

    console.log("PASS: create, join, leave, abrupt close, invalid/empty room, malformed JSON, room switch, rejoin, reconnect dedupe");
  } finally {
    for (const client of clients) client.socket.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
