const assert = require("node:assert/strict");
const Module = require("node:module");
const { WebSocketServer } = require("ws");

const notifications = { info: [], warning: [], error: [] };
const originalLoad = Module._load;

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }

  fire(value) {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose() {
    this.listeners.clear();
  }
}

Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      EventEmitter,
      workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback })
      },
      window: {
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        showInformationMessage: (message) => notifications.info.push(message),
        showWarningMessage: (message) => notifications.warning.push(message),
        showErrorMessage: (message) => notifications.error.push(message)
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { CodeMeshClient } = require("../dist/services/CodeMeshClient");
const { getPresenceViewModel } = require("../dist/ui/presenceViewModel");
Module._load = originalLoad;

const roomId = "ABC234";
const self = { memberId: "self", displayName: "Self" };

async function main() {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  let roomExists = false;
  let connectionCount = 0;
  const memberships = new Map();

  server.on("connection", (socket) => {
    connectionCount += 1;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "CREATE_ROOM") {
        roomExists = true;
        memberships.set(socket, message.member);
        socket.send(JSON.stringify({
          type: "ROOM_CREATED",
          roomId,
          member: message.member,
          members: [message.member, message.member]
        }));
      } else if (message.type === "JOIN_ROOM") {
        if (!roomExists) {
          socket.send(JSON.stringify({ type: "ERROR", message: `Room ${message.roomId} does not exist` }));
          return;
        }
        for (const [existingSocket, member] of memberships) {
          if (member.memberId === message.member.memberId) memberships.delete(existingSocket);
        }
        memberships.set(socket, message.member);
        socket.send(JSON.stringify({
          type: "ROOM_JOINED",
          roomId,
          member: message.member,
          members: [...memberships.values()]
        }));
      } else if (message.type === "LEAVE_ROOM") {
        memberships.delete(socket);
      }
    });
    socket.on("close", () => memberships.delete(socket));
  });

  const client = new CodeMeshClient({
    serverUrl: `ws://127.0.0.1:${address.port}`,
    reconnectDelayMs: 10,
    self
  });
  const observedStates = [];
  const subscription = client.onDidChangeState((state) => observedStates.push(state));

  try {
    await client.createRoom();
    await waitFor(() => client.getState().roomId === roomId);
    assertPresence(client, roomId, 1);
    assert.equal(client.getState().members.length, 1, "duplicate member payloads are normalized");

    client.leaveRoom();
    assertPresence(client, undefined, 0);
    await waitFor(() => memberships.size === 0);

    await client.joinRoom(roomId);
    await waitFor(() => client.getState().roomId === roomId);
    assertPresence(client, roomId, 1);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      activeSocket(memberships).terminate();
      await waitFor(() => client.getState().connectionState === "reconnecting");
      assertPresence(client, undefined, 0);
      await waitFor(() => client.getState().roomId === roomId);
      assertPresence(client, roomId, 1);
      assert.equal([...memberships.values()].filter((member) => member.memberId === self.memberId).length, 1);
    }
    assert.equal(connectionCount, 4, "one socket is created per reconnect event");

    roomExists = false;
    activeSocket(memberships).terminate();
    await waitFor(() => client.getState().connectionState === "reconnecting");
    assertPresence(client, undefined, 0);
    await waitFor(() => client.getState().connectionState === "connected");
    assertPresence(client, undefined, 0);
    assert.match(notifications.warning.at(-1), /Create or join a room again/);

    await client.createRoom();
    await waitFor(() => client.getState().roomId === roomId);
    const connectionsBeforeDispose = connectionCount;
    client.dispose();
    await waitFor(() => memberships.size === 0);
    await delay(30);
    assert.equal(connectionCount, connectionsBeforeDispose, "dispose does not reconnect");

    const reconnectingStates = observedStates.filter((state) => state.connectionState === "reconnecting");
    assert.ok(reconnectingStates.length >= 4);
    assert.ok(reconnectingStates.every((state) => !state.roomId && state.members.length === 0));
    console.log("PASS: create, join, leave, reconnect restore/reject, dedupe, and dispose cleanup");
  } finally {
    subscription.dispose();
    client.dispose();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

function assertPresence(client, expectedRoomId, expectedMemberCount) {
  const state = client.getState();
  assert.equal(state.roomId, expectedRoomId);
  assert.equal(state.members.length, expectedMemberCount);
  const presence = getPresenceViewModel(state);
  assert.equal(presence.roomLabel, expectedRoomId ?? "None");
  assert.equal(presence.hasActiveRoom, Boolean(expectedRoomId));
}

function activeSocket(memberships) {
  const socket = [...memberships.keys()].find((candidate) => candidate.readyState === candidate.OPEN);
  assert.ok(socket, "expected an active room socket");
  return socket;
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once("error", reject);
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for lifecycle condition");
    await delay(5);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
