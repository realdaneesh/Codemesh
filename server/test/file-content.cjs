const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");
const { CollaborationServer } = require("../dist/websocket/CollaborationServer");
const { MAX_FILE_BYTES } = require("../dist/types/fileTransfer");
assert.equal(MAX_FILE_BYTES, require("../../extension/dist/types/fileTransfer").MAX_FILE_BYTES, "client/server text limits agree");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return {
    socket, messages, send: (message) => socket.send(JSON.stringify(message)),
    async wait(type, predicate = () => true) {
      const deadline = Date.now() + 3000;
      while (true) {
        const index = messages.findIndex((message) => message.type === type && predicate(message));
        if (index >= 0) return messages.splice(index, 1)[0];
        if (Date.now() > deadline) throw new Error("Timed out waiting for " + type);
        await pause(5);
      }
    }
  };
}

async function main() {
  const server = new CollaborationServer(0, { fileRequestTimeoutMs: 500 });
  server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const clients = [];
  const make = async () => { const client = await connect("ws://127.0.0.1:" + server.server.address().port); clients.push(client); return client; };
  try {
    let owner = await make(), requester = await make();
    const bystander = await make(), outsider = await make();
    owner.send({ type: "CREATE_ROOM", member: { memberId: "owner", displayName: "Owner" } });
    const roomId = (await owner.wait("ROOM_CREATED")).roomId;
    const join = async (client, memberId) => {
      client.send({ type: "JOIN_ROOM", roomId, member: { memberId, displayName: memberId } });
      await client.wait("ROOM_JOINED");
    };
    await join(requester, "requester");
    await join(bystander, "bystander");
    outsider.send({ type: "CREATE_ROOM", member: { memberId: "outsider", displayName: "Outsider" } });
    const otherRoom = (await outsider.wait("ROOM_CREATED")).roomId;
    const manifest = { workspaceName: "Files", files: [{ path: "ok.txt", size: 5 }, { path: "other.txt", size: 3 }, { path: "large.txt", size: MAX_FILE_BYTES + 1 }] };
    let manifestId;
    const publish = async () => {
      owner.send({ type: "SHARE_WORKSPACE", roomId, manifest });
      manifestId = (await owner.wait("WORKSPACE_MANIFEST", (message) => !!message.manifest)).manifestId;
      await requester.wait("WORKSPACE_MANIFEST", (message) => message.manifestId === manifestId);
    };
    await publish();
    const key = (requestId = randomUUID()) => ({ requestId, roomId, manifestId, path: "ok.txt" });
    const start = async () => {
      const request = key();
      requester.send({ type: "FILE_REQUEST", ...request });
      assert.deepEqual(await owner.wait("FILE_REQUEST", (message) => message.requestId === request.requestId), { type: "FILE_REQUEST", ...request });
      return request;
    };
    const error = (client, request) => client.wait("FILE_ERROR", (message) => message.requestId === request.requestId);
    const request = await start();
    bystander.send({ type: "FILE_RESPONSE", ...request, text: "hello" });
    assert.match((await error(bystander, request)).message, /unauthorized/);
    owner.send({ type: "FILE_RESPONSE", ...request, path: "other.txt", text: "bad" });
    assert.match((await error(owner, request)).message, /unauthorized/);
    owner.send({ type: "FILE_RESPONSE", ...request, text: "hello" });
    assert.deepEqual(await requester.wait("FILE_RESPONSE"), { type: "FILE_RESPONSE", ...request, text: "hello" });
    owner.send({ type: "FILE_RESPONSE", ...request, text: "hello" });
    assert.match((await error(owner, request)).message, /Unsolicited/);
    assert.equal(server.fileRequests.size, 0);
    assert.ok(!bystander.messages.some((message) => ["FILE_RESPONSE", "FILE_REQUEST"].includes(message.type)));
    assert.ok(!outsider.messages.some((message) => ["FILE_RESPONSE", "FILE_REQUEST"].includes(message.type)));
    console.log("PASS: request routes only to owner, response only to requester; forged owner, wrong path, replay and unsolicited responses rejected");

    for (const changes of [{ path: "../escape" }, { path: "C:\\secret" }, { path: "missing.txt" }, { path: "large.txt" }, { manifestId: randomUUID() }, { roomId: otherRoom }]) {
      const bad = { ...key(), ...changes };
      requester.send({ type: "FILE_REQUEST", ...bad });
      await error(requester, bad);
      assert.equal(server.fileRequests.size, 0);
    }
    const crossed = key();
    outsider.send({ type: "FILE_REQUEST", ...crossed });
    assert.match((await error(outsider, crossed)).message, /Unauthorized/);
    assert.ok(!owner.messages.some((message) => message.type === "FILE_REQUEST"));
    const first = await start();
    const second = key();
    requester.send({ type: "FILE_REQUEST", ...second });
    assert.match((await error(requester, second)).message, /one file request/);
    owner.send({ type: "FILE_FAILURE", ...first, message: "File was removed after publication" });
    assert.match((await error(requester, first)).message, /removed/);
    await owner.wait("FILE_CANCEL", (message) => message.requestId === first.requestId);
    for (const text of ["bad", "\0abcd", "\ud800", "x".repeat(MAX_FILE_BYTES + 1)]) {
      const current = await start();
      owner.send({ type: "FILE_RESPONSE", ...current, text });
      const rejected = await error(requester, current);
      assert.match(rejected.message, /size|binary|UTF-8|256 KiB/);
      await owner.wait("FILE_CANCEL", (message) => message.requestId === current.requestId);
      assert.equal(server.fileRequests.size, 0);
    }
    console.log("PASS: room/manifest/path authorization, one pending request per member, published-size matching, binary and oversize response limits");

    let current = await start();
    requester.send({ type: "LEAVE_ROOM" });
    await error(requester, current);
    await owner.wait("FILE_CANCEL", (message) => message.requestId === current.requestId);
    await join(requester, "requester");
    await requester.wait("WORKSPACE_MANIFEST", (message) => message.manifestId === manifestId);
    current = await start();
    owner.send({ type: "END_WORKSPACE", roomId });
    await error(requester, current);
    await owner.wait("FILE_CANCEL", (message) => message.requestId === current.requestId);
    await owner.wait("WORKSPACE_MANIFEST", (message) => message.manifest === null);
    await publish();
    current = await start();
    const oldId = manifestId;
    await publish();
    await error(requester, current);
    await owner.wait("FILE_CANCEL", (message) => message.requestId === current.requestId);
    assert.notEqual(manifestId, oldId, "each publication has a fresh manifest identity");
    current = await start();
    requester.socket.terminate();
    await owner.wait("FILE_CANCEL", (message) => message.requestId === current.requestId);
    assert.equal(server.fileRequests.size, 0);
    requester = await make();
    await join(requester, "requester");
    await requester.wait("WORKSPACE_MANIFEST", (message) => message.manifestId === manifestId);
    current = await start();
    owner.socket.terminate();
    assert.match((await error(requester, current)).message, /disconnected/);
    assert.equal(server.fileRequests.size, 0);
    owner = await make();
    await join(owner, "owner");
    await publish();
    current = await start();
    assert.match((await error(requester, current)).message, /timed out/);
    await owner.wait("FILE_CANCEL", (message) => message.requestId === current.requestId);
    owner.send({ type: "FILE_RESPONSE", ...current, text: "hello" });
    assert.match((await error(owner, current)).message, /Unsolicited/);
    assert.equal(server.fileRequests.size, 0);
    console.log("PASS: leave, manifest replacement, end sharing, requester/owner disconnect, timeout and late-response cancellation");
  } finally {
    for (const client of clients) client.socket.terminate();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise((resolve) => server.server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
