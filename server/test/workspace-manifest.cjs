const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { CollaborationServer } = require("../dist/websocket/CollaborationServer");
const { MAX_MANIFEST_BYTES } = require("../dist/types/workspaceManifest");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return {
    socket, messages,
    send: (message) => socket.send(JSON.stringify(message)),
    async wait(type, predicate = () => true) {
      const deadline = Date.now() + 2500;
      while (true) {
        const index = messages.findIndex((message) => message.type === type && predicate(message));
        if (index >= 0) return messages.splice(index, 1)[0];
        if (Date.now() > deadline) throw new Error("Timed out waiting for " + type);
        await pause(5);
      }
    },
    async none(type) {
      await pause(60);
      assert.ok(!messages.some((message) => message.type === type), "Unexpected " + type);
    }
  };
}

async function main() {
  const server = new CollaborationServer(0);
  server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const url = "ws://127.0.0.1:" + server.server.address().port;
  const clients = [];
  const newClient = async () => { const client = await connect(url); clients.push(client); return client; };
  try {
    const a = await newClient(), b = await newClient(), c = await newClient();
    a.send({ type: "CREATE_ROOM", member: { memberId: "a", displayName: "A" } });
    const roomId = (await a.wait("ROOM_CREATED")).roomId;
    b.send({ type: "JOIN_ROOM", roomId, member: { memberId: "b", displayName: "B" } });
    await b.wait("ROOM_JOINED");
    c.send({ type: "CREATE_ROOM", member: { memberId: "c", displayName: "C" } });
    const otherRoom = (await c.wait("ROOM_CREATED")).roomId;
    await a.none("WORKSPACE_MANIFEST");
    const manifest = { workspaceName: "Project", files: [{ path: "src\\main.ts", size: 20 }, { path: "readme.md", size: 12 }] };
    const normalized = { ...manifest, files: [{ path: "src/main.ts", size: 20 }, { path: "readme.md", size: 12 }] };
    a.send({ type: "SHARE_WORKSPACE", roomId, manifest });
    assert.deepEqual((await a.wait("WORKSPACE_MANIFEST")).manifest, normalized);
    const received = await b.wait("WORKSPACE_MANIFEST");
    assert.deepEqual(received.manifest, normalized);
    assert.equal(received.ownedByYou, false);
    await c.none("WORKSPACE_MANIFEST");
    const late = await newClient();
    late.send({ type: "JOIN_ROOM", roomId, member: { memberId: "late", displayName: "Late" } });
    await late.wait("ROOM_JOINED");
    assert.deepEqual((await late.wait("WORKSPACE_MANIFEST")).manifest, normalized, "late members see only their room's manifest");
    b.send({ type: "END_WORKSPACE", roomId });
    await b.wait("WORKSPACE_ERROR", (message) => /Only the member/.test(message.message));
    await a.none("WORKSPACE_MANIFEST");
    c.send({ type: "SHARE_WORKSPACE", roomId, manifest });
    await c.wait("WORKSPACE_ERROR", (message) => /not in/.test(message.message));

    for (const invalid of [
      { ...manifest, files: [{ path: "../escape", size: 1 }] },
      { ...manifest, files: [{ path: "C:\\secret", size: 1 }] },
      { ...manifest, files: [{ path: "a/b", size: 1 }, { path: "a\\b", size: 1 }] },
      { ...manifest, files: [{ path: ".env", size: 1 }] },
      { ...manifest, files: [{ path: "safe", size: 1, text: "contents" }] },
      { ...manifest, files: Array.from({ length: 2001 }, (_, i) => ({ path: "f" + i, size: 0 })) }
    ]) {
      a.send({ type: "SHARE_WORKSPACE", roomId, manifest: invalid });
      await a.wait("WORKSPACE_ERROR");
      assert.deepEqual(server.workspaces.get(roomId).manifest, normalized, "invalid publication cannot change current manifest");
    }
    a.socket.send(JSON.stringify({ type: "SHARE_WORKSPACE", roomId, manifest }) + " ".repeat(MAX_MANIFEST_BYTES));
    await a.wait("WORKSPACE_ERROR", (message) => /256 KiB/.test(message.message));
    await b.none("WORKSPACE_MANIFEST");

    const beforeRefresh = server.workspaces.get(roomId).id;
    for (const extra of [{ baseManifestId: "11111111-1111-1111-1111-111111111111", changedPaths: [] },
      { baseManifestId: beforeRefresh, changedPaths: ["not-listed.txt"] }]) {
      a.send({ type: "SHARE_WORKSPACE", roomId, manifest: normalized, ...extra });
      await a.wait("WORKSPACE_ERROR");
      assert.equal(server.workspaces.get(roomId).id, beforeRefresh, "invalid refresh leaves publication unchanged");
    }
    b.send({ type: "SHARE_WORKSPACE", roomId, manifest: normalized, baseManifestId: beforeRefresh, changedPaths: [] });
    await b.wait("WORKSPACE_ERROR", (message) => /Only the member/.test(message.message));
    a.send({ type: "SHARE_WORKSPACE", roomId, manifest: normalized, baseManifestId: beforeRefresh, changedPaths: ["readme.md"] });
    const refreshed = await a.wait("WORKSPACE_MANIFEST");
    assert.notEqual(refreshed.manifestId, beforeRefresh);
    await b.wait("WORKSPACE_MANIFEST", (message) => message.manifestId === refreshed.manifestId);
    await late.wait("WORKSPACE_MANIFEST", (message) => message.manifestId === refreshed.manifestId);
    for (const client of [a, b, late]) assert.deepEqual((await client.wait("WORKSPACE_CHANGES")).changes, { added: [], changed: ["readme.md"], removed: [] });
    await c.none("WORKSPACE_CHANGES");
    console.log("PASS: owner-only refresh, stale identity and unlisted change rejection preserve publication; same-size metadata hint broadcasts only within room");

    a.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "live.txt", text: "one" });
    await a.wait("DOCUMENT_SYNC");
    b.send({ type: "OPEN_DOCUMENT", roomId, documentPath: "live.txt", text: "one" });
    await b.wait("DOCUMENT_SYNC");
    a.send({ type: "SHARE_WORKSPACE", roomId, manifest: { ...manifest, files: [{ path: "../invalid", size: 0 }] } });
    await a.wait("WORKSPACE_ERROR");
    a.send({ type: "DOCUMENT_EDIT", roomId, documentPath: "live.txt", baseRevision: 0, text: "still live" });
    await a.wait("DOCUMENT_ACK", (message) => message.revision === 1);
    await b.wait("DOCUMENT_EDIT", (message) => message.text === "still live");
    assert.deepEqual(server.workspaces.get(roomId).manifest, normalized);
    a.send({ type: "END_WORKSPACE", roomId });
    await a.wait("WORKSPACE_MANIFEST", (message) => message.manifest === null);
    await b.wait("WORKSPACE_MANIFEST", (message) => message.manifest === null);
    await late.wait("WORKSPACE_MANIFEST", (message) => message.manifest === null);
    assert.equal(server.workspaces.size, 0);
    await c.none("WORKSPACE_MANIFEST");

    a.send({ type: "SHARE_WORKSPACE", roomId, manifest });
    await a.wait("WORKSPACE_MANIFEST");
    await b.wait("WORKSPACE_MANIFEST");
    a.send({ type: "LEAVE_ROOM" });
    await b.wait("WORKSPACE_MANIFEST", (message) => message.manifest === null);
    assert.equal(server.workspaces.size, 0);
    a.send({ type: "JOIN_ROOM", roomId, member: { memberId: "a", displayName: "A" } });
    await a.wait("ROOM_JOINED");
    a.send({ type: "SHARE_WORKSPACE", roomId, manifest });
    await a.wait("WORKSPACE_MANIFEST");
    await b.wait("WORKSPACE_MANIFEST");
    const replacement = await newClient();
    replacement.send({ type: "JOIN_ROOM", roomId, member: { memberId: "a", displayName: "A reconnected" } });
    await replacement.wait("ROOM_JOINED");
    await b.wait("WORKSPACE_MANIFEST", (message) => message.manifest === null);
    assert.equal(server.workspaces.size, 0, "reconnect identity cannot retain previous socket's workspace consent");
    replacement.send({ type: "SHARE_WORKSPACE", roomId, manifest });
    await replacement.wait("WORKSPACE_MANIFEST");
    await b.wait("WORKSPACE_MANIFEST");
    replacement.socket.terminate();
    await b.wait("WORKSPACE_MANIFEST", (message) => message.manifest === null);
    assert.equal(server.workspaces.size, 0);
    console.log("PASS: server manifest opt-in, room isolation, late join, owner-only actions, boundary rejection, live-sync coexistence, end/leave/disconnect/reconnect cleanup");
  } finally {
    for (const client of clients) client.socket.terminate();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise((resolve) => server.server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
