const assert = require("node:assert/strict");
const { test } = require("node:test");
const WebSocket = require("ws");
const Y = require("yjs");
const { ExperimentalServer, ExperimentalClient, EXPERIMENTAL_LIMITS } = require("../dist/transport");
const { TestEditorBinding } = require("../dist/binding");
const { protocol, waitFor, editor, limits } = require("./helpers.cjs");

function orderedDelay(socket, delays) {
  const send = socket.send;
  const queue = [];
  let sequence = 0, timer, closed = false;
  const next = () => {
    if (closed || timer || !queue.length) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      const [data, options, callback] = queue[0];
      send.call(socket, data, options, (error) => {
        queue.shift(); callback?.(error); next();
      });
    }, delays[sequence++ % delays.length]);
  };
  socket.send = (data, options, callback) => { queue.push([data, options, callback]); next(); };
  socket.once("close", () => { closed = true; clearTimeout(timer); queue.length = 0; });
  return { get pending() { return queue.length; } };
}

function measure(server) {
  const start = process.memoryUsage();
  const peak = { queuedBytes: 0, queuedMessages: 0, heapBytes: start.heapUsed, rssBytes: start.rss };
  const sample = () => {
    const resources = server.getResources(), memory = process.memoryUsage();
    peak.queuedBytes = Math.max(peak.queuedBytes, resources.queuedBytes);
    peak.queuedMessages = Math.max(peak.queuedMessages, resources.queuedMessages);
    peak.heapBytes = Math.max(peak.heapBytes, memory.heapUsed);
    peak.rssBytes = Math.max(peak.rssBytes, memory.rss);
  };
  const interval = setInterval(sample, 2); interval.unref();
  return { peak, sample, stop: () => { clearInterval(interval); sample(); return {
    ...peak, heapDeltaBytes: peak.heapBytes - start.heapUsed, rssDeltaBytes: peak.rssBytes - start.rss
  }; } };
}

async function setup(t, seed = "abcdef") {
  const server = new ExperimentalServer(protocol);
  const grant = server.createRoom("ABC234", "shared.txt", seed);
  const url = await server.listening();
  const a = new ExperimentalClient(protocol), b = new ExperimentalClient(protocol);
  const clients = [a, b], bindings = [];
  t.after(async () => { for (const binding of bindings) binding.dispose(); for (const client of clients) client.dispose(); await server.dispose(); });
  await a.connect(url, grant.ownerToken, "ABC234", "shared.txt");
  await b.connect(url, grant.memberToken, "ABC234", "shared.txt");
  const ea = editor(seed), eb = editor(seed.replace(/\n/g, "\r\n"), 2);
  const ba = new TestEditorBinding(ea.api, ea.document, a.model, undefined, ea.origin), bb = new TestEditorBinding(eb.api, eb.document, b.model, undefined, eb.origin);
  bindings.push(ba, bb);
  return { server, grant, url, a, b, clients, bindings, ea, eb, ba, bb };
}

test("real WebSockets: two independently bound editors converge after simultaneous inserts and insert/delete", async (t) => {
  const h = await setup(t);
  h.ea.edit([{ rangeOffset: 1, rangeLength: 0, text: "A" }]);
  h.eb.edit([{ rangeOffset: 5, rangeLength: 0, text: "B" }]);
  await waitFor(() => h.a.model.getText() === "aAbcdeBf" && h.b.model.getText() === "aAbcdeBf");
  await h.ba.settled(); await h.bb.settled();
  assert.equal(h.ea.document.text, "aAbcdeBf"); assert.equal(h.eb.document.text, "aAbcdeBf");
  assert.equal(h.a.sentUpdates, 1); assert.equal(h.b.sentUpdates, 1);
  h.ea.edit([{ rangeOffset: 3, rangeLength: 0, text: "\u4e2d\u6587\n" }]);
  h.eb.edit([{ rangeOffset: 3, rangeLength: 2, text: "" }]);
  await waitFor(() => h.a.model.getText() === h.b.model.getText() && h.a.sentUpdates === 2 && h.b.sentUpdates === 2);
  await h.ba.settled(); await h.bb.settled();
  assert.equal(h.ea.document.text, h.eb.document.text.replace(/\r\n/g, "\n"));
  assert.ok(h.eb.document.text.includes("\r\n"));
  assert.equal(h.ea.saves + h.eb.saves, 0);
});

test("one binary update delivers separated Unicode patches to a CRLF editor without echo", async (t) => {
  const h = await setup(t, "A\nBxxx\nC\nDyyy\nE");
  h.ea.edit([{ rangeOffset: 3, rangeLength: 3, text: "\ud83d\ude80" }, { rangeOffset: 10, rangeLength: 3, text: "\u4e2d\u6587" }]);
  await waitFor(() => h.b.model.getText() === "A\nB\ud83d\ude80\nC\nD\u4e2d\u6587\nE");
  await h.bb.settled();
  assert.equal(h.eb.document.text, "A\r\nB\ud83d\ude80\r\nC\r\nD\u4e2d\u6587\r\nE");
  assert.equal(h.eb.applied.length, 1); assert.equal(h.eb.applied[0].length, 2);
  assert.equal(h.a.sentUpdates, 1); assert.equal(h.b.sentUpdates, 0);
  assert.equal(h.ea.saves + h.eb.saves, 0);
});

test("same and adjacent position edits from independent editors converge exactly once", async (t) => {
  for (const [aOffset, bOffset] of [[2, 2], [2, 3]]) {
    const h = await setup(t);
    h.ea.edit([{ rangeOffset: aOffset, rangeLength: 0, text: "A" }]);
    h.eb.edit([{ rangeOffset: bOffset, rangeLength: 0, text: "B" }]);
    await waitFor(() => h.a.model.getText() === h.b.model.getText() && h.a.model.getText().includes("A") && h.a.model.getText().includes("B"));
    await h.ba.settled(); await h.bb.settled();
    const text = h.a.model.getText();
    assert.equal(text.match(/A/g).length, 1); assert.equal(text.match(/B/g).length, 1);
    assert.equal(h.ea.document.text, text); assert.equal(h.eb.document.text, text);
    assert.equal(h.a.sentUpdates, 1); assert.equal(h.b.sentUpdates, 1);
    assert.equal(h.ea.saves + h.eb.saves, 0);
    h.a.dispose(); h.b.dispose();
  }
});

test("identical local text during a delayed remote apply is sent once and has its own undo step", async (t) => {
  const h = await setup(t, "base");
  let release; h.eb.api.gate = new Promise((resolve) => { release = resolve; });
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "X" }]);
  await waitFor(() => h.eb.applications === 1);
  h.eb.edit([{ rangeOffset: 0, rangeLength: 0, text: "X" }]);
  release(); await h.bb.settled();
  await waitFor(() => h.a.model.getText() === "XXbase");
  assert.equal(h.eb.document.text, "XXbase");
  assert.equal(h.a.sentUpdates, 1); assert.equal(h.b.sentUpdates, 1);
  assert.equal(await h.bb.undoLocal(), true);
  await waitFor(() => h.a.model.getText() === "Xbase");
  await h.ba.settled(); await h.bb.settled();
  assert.equal(h.ea.document.text, "Xbase"); assert.equal(h.eb.document.text, "Xbase");
  assert.equal(await h.bb.redoLocal(), true);
  await waitFor(() => h.a.model.getText() === "XXbase");
  await h.ba.settled(); await h.bb.settled();
  assert.equal(h.ea.document.text, "XXbase"); assert.equal(h.eb.document.text, "XXbase");
  assert.equal(h.ea.saves + h.eb.saves, 0);
});

test("WebSocket interleaving: local-only undo preserves peer insertion and deletion", async (t) => {
  const h = await setup(t, "abcd");
  h.ea.edit([{ rangeOffset: 1, rangeLength: 0, text: "OWN" }]);
  await waitFor(() => h.b.model.getText() === "aOWNbcd"); await h.bb.settled();
  h.eb.edit([{ rangeOffset: h.eb.document.text.length, rangeLength: 0, text: "PEER" }]);
  await waitFor(() => h.a.model.getText() === "aOWNbcdPEER"); await h.ba.settled();
  h.eb.edit([{ rangeOffset: 4, rangeLength: 1, text: "" }]);
  await waitFor(() => h.a.model.getText() === h.b.model.getText()); await h.ba.settled();
  const afterPeer = h.a.model.getText();
  assert.equal(await h.ba.undoLocal(), true);
  await waitFor(() => h.b.model.getText() === afterPeer.replace("OWN", ""));
  await h.ba.settled(); await h.bb.settled();
  assert.equal(h.ea.document.text, h.eb.document.text);
  assert.equal(await h.ba.redoLocal(), true);
  await waitFor(() => h.b.model.getText() === afterPeer);
  await h.ba.settled(); await h.bb.settled();
  assert.equal(h.ea.document.text, afterPeer); assert.equal(h.eb.document.text, afterPeer);
  assert.equal(h.ea.saves + h.eb.saves, 0);
});

test("real WebSocket undo with rejected editor patch pauses and preserves the unsaved local draft", async (t) => {
  const h = await setup(t, "base");
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "own " }]);
  await waitFor(() => h.b.model.getText() === "own base"); await h.bb.settled();
  h.ea.api.reject = true;
  await assert.rejects(h.ba.undoLocal(), /rejected/);
  await waitFor(() => h.b.model.getText() === "base"); await h.bb.settled();
  assert.equal(h.server.getStatus("ABC234").text, "base");
  assert.equal(h.ea.document.text, "own base");
  assert.equal(h.ba.getStatus().status, "paused");
  assert.equal(h.ba.getStatus().draft, "own base");
  assert.equal(h.eb.document.text, "base");
  assert.equal(h.ea.saves + h.eb.saves, 0);
});

test("delayed and duplicated network updates converge without editor echo", async (t) => {
  const h = await setup(t);
  const room = h.server.rooms.get("ABC234");
  const socket = [...room.members].find(([, entry]) => entry.token === h.grant.memberToken)[0];
  const original = socket.send;
  const delayed = [];
  socket.send = function (data, options) {
    if (options?.binary) { delayed.push(Buffer.from(data)); return; }
    return original.call(this, data, options);
  };
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "one " }]);
  h.ea.edit([{ rangeOffset: 4, rangeLength: 0, text: "two " }]);
  await waitFor(() => delayed.length === 2);
  assert.equal(h.eb.document.text, "abcdef");
  socket.send = original;
  for (const packet of [delayed[1], delayed[1], delayed[0], delayed[0]]) original.call(socket, packet, { binary: true });
  await waitFor(() => h.b.model.getText() === "one two abcdef");
  await h.bb.settled();
  assert.equal(h.eb.document.text, "one two abcdef");
  assert.equal(h.a.sentUpdates, 2); assert.equal(h.b.sentUpdates, 0);
  assert.equal(h.b.model.canUndo(), false, "duplicates and remote applies do not enter local history");
  assert.equal(h.ea.saves + h.eb.saves, 0);
});

test("remote WebSocket update pending in editor preserves local draft through disconnect", async (t) => {
  const h = await setup(t, "first\nmiddle\nlast");
  let release; h.eb.api.gate = new Promise((resolve) => { release = resolve; });
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "remote " }]);
  await waitFor(() => h.eb.applications === 1);
  h.eb.edit([{ rangeOffset: 6, rangeLength: 7, text: "\u4e2d\u6587\r\nnew\r\n" }]);
  const draft = h.eb.document.text;
  h.b.disconnect();
  release(); await h.bb.settled();
  assert.equal(h.eb.document.text, draft); assert.equal(h.bb.getStatus().draft, draft);
  assert.equal(h.eb.listeners, 0); assert.equal(h.eb.saves, 0);
  assert.equal(h.server.getStatus("ABC234").text, "remote first\nmiddle\nlast");
});

test("approved epoch replacement cannot land an old pending editor patch", async (t) => {
  const h = await setup(t, "base");
  let release; h.ea.api.gate = new Promise((resolve) => { release = resolve; });
  h.eb.edit([{ rangeOffset: 0, rangeLength: 0, text: "remote " }]);
  await waitFor(() => h.ea.applications === 1);
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "local " }]);
  const draft = h.ea.document.text;
  h.a.socket.send(JSON.stringify({ type: "PAUSE", scope: h.a.model.scope }));
  await waitFor(() => h.a.recoveryId && h.b.recoveryId);
  h.a.proposeRecovery("chosen room text");
  await waitFor(() => h.a.proposal && h.b.proposal);
  h.a.approveRecovery(); h.b.approveRecovery();
  await waitFor(() => h.a.status === "active" && h.b.status === "active");
  assert.equal(h.ba.getStatus().status, "disposed");
  release(); await h.ba.settled();
  assert.equal(h.ea.document.text, draft);
  assert.equal(h.ba.getStatus().draft, draft);
  assert.equal(h.ea.listeners, 0); assert.equal(h.ea.saves, 0);
  assert.equal(h.a.model.getText(), "chosen room text");
  const next = new TestEditorBinding(h.ea.api, h.ea.document, h.a.model, undefined, h.ea.origin); h.bindings.push(next);
  assert.equal(next.getStatus().status, "paused");
  await next.useRoomText();
  assert.equal(h.ea.document.text, "chosen room text");
  assert.equal(next.getStatus().draft, draft);
  assert.equal(h.a.model.canUndo(), false, "old epoch history never transfers");
  assert.equal(await next.undoLocal(), false);
});

test("real WebSockets: late state-vector join and duplicated binary updates are idempotent", async (t) => {
  const h = await setup(t);
  h.a.insert(6, "tail"); await waitFor(() => h.b.model.getText() === "abcdeftail");
  const frame = protocol.encode(h.a.model.scope, "UPDATE", Y.encodeStateAsUpdate(h.a.model.doc));
  const before = h.b.sentUpdates;
  h.a.duplicate(frame); h.a.duplicate(frame);
  const late = new ExperimentalClient(protocol); h.clients.push(late);
  await late.connect(h.url, h.server.grantMember("ABC234"), "ABC234", "shared.txt");
  assert.equal(late.model.getText(), "abcdeftail"); assert.equal(h.b.sentUpdates, before);
  assert.equal(h.server.getStatus("ABC234").text, "abcdeftail");
});

test("disconnect removes binding listeners; explicit rejoin preserves local draft and requires explicit choice", async (t) => {
  const h = await setup(t);
  const oldModel = h.b.model, oldScope = oldModel.scope;
  h.b.disconnect(); assert.equal(h.bb.getStatus().status, "disposed"); assert.equal(h.eb.listeners, 0);
  h.eb.edit([{ rangeOffset: 0, rangeLength: 0, text: "offline draft " }]);
  await waitFor(() => h.b.socket === undefined);
  h.a.insert(0, "room "); await waitFor(() => h.server.getStatus("ABC234").text === "room abcdef");
  await h.b.connect(h.url, h.grant.memberToken, "ABC234", "shared.txt");
  assert.equal(h.b.model.scope.epoch, oldScope.epoch, "surviving member retains the room epoch");
  const binding = new TestEditorBinding(h.eb.api, h.eb.document, h.b.model, undefined, h.eb.origin); h.bindings.push(binding);
  assert.equal(binding.getStatus().status, "paused"); assert.equal(h.eb.document.text, "offline draft abcdef");
  await binding.useRoomText(); assert.equal(h.eb.document.text, "room abcdef");
  assert.equal(binding.getStatus().draft, "offline draft abcdef"); assert.equal(h.eb.saves, 0);
  assert.equal(oldModel.getStatus().active, false);
});

test("room and document capabilities isolate identical paths and reject unauthorized access", async (t) => {
  const h = await setup(t);
  const other = h.server.createRoom("DEF567", "shared.txt", "isolated");
  const c = new ExperimentalClient(protocol); h.clients.push(c);
  await c.connect(h.url, other.ownerToken, "DEF567", "shared.txt");
  const bad = new ExperimentalClient(protocol); h.clients.push(bad);
  await assert.rejects(bad.connect(h.url, h.server.grantMember("ABC234"), "DEF567", "shared.txt"), /Unauthorized/);
  const wrongPath = new ExperimentalClient(protocol); h.clients.push(wrongPath);
  await assert.rejects(wrongPath.connect(h.url, h.server.grantMember("ABC234"), "ABC234", "other.txt"), /Unauthorized/);
  const foreign = protocol.encode(h.a.model.scope, "UPDATE", Y.encodeStateAsUpdate(h.a.model.doc));
  c.duplicate(foreign); await waitFor(() => c.errors.length);
  assert.match(c.errors.at(-1), /does not match/);
  h.a.insert(0, "A"); await waitFor(() => h.b.model.getText() === "Aabcdef");
  assert.equal(c.model.getText(), "isolated"); assert.equal(h.server.getStatus("DEF567").text, "isolated");
});

test("invalid controls, malformed binary updates and state vectors reject without corrupting a room", async (t) => {
  const h = await setup(t);
  for (const data of ["not json", JSON.stringify({ type: "DOCUMENT_EDIT", scope: h.a.model.scope, text: "production" }),
    JSON.stringify({ type: "LEAVE", scope: h.a.model.scope, text: "unsupported" }),
    protocol.encode(h.a.model.scope, "UPDATE", new Uint8Array([255, 255, 255])),
    protocol.encode(h.a.model.scope, "STATE_VECTOR", new Uint8Array([255, 255, 255]))]) {
    const before = h.a.errors.length; h.a.socket.send(data, { binary: typeof data !== "string" });
    await waitFor(() => h.a.errors.length > before);
    assert.equal(h.server.getStatus("ABC234").text, "abcdef");
    assert.equal(h.server.getStatus("ABC234").paused, false);
  }
  const raw = new WebSocket(h.url); t.after(() => raw.terminate());
  const messages = []; raw.on("message", (message) => messages.push(JSON.parse(message.toString())));
  await new Promise((resolve) => raw.once("open", resolve));
  raw.send(protocol.encode(h.a.model.scope, "UPDATE", new Uint8Array([0, 0])), { binary: true });
  await waitFor(() => messages.length); assert.match(messages[0].reason, /Unauthorized/);
});

test("WebSocket maxPayload rejects frames over 2 MiB; local text growth over 256 KiB preserves draft", async (t) => {
  const h = await setup(t);
  const raw = new WebSocket(h.url); t.after(() => raw.terminate()); raw.on("error", () => undefined);
  await new Promise((resolve) => raw.once("open", resolve));
  const closed = new Promise((resolve) => raw.once("close", (code) => resolve(code)));
  raw.send(new Uint8Array(limits.MAX_MESSAGE_BYTES + 1), { binary: true }); assert.equal(await closed, 1009);
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "x".repeat(limits.MAX_DOCUMENT_BYTES) }]);
  assert.equal(h.ba.getStatus().status, "paused");
  assert.equal(h.ba.getStatus().draft, h.ea.document.text); assert.equal(h.a.sentUpdates, 0);
  assert.equal(h.server.getStatus("ABC234").text, "abcdef"); assert.equal(h.ea.saves, 0);
});

test("over-cap concurrent merge quarantines both drafts; explicit unanimous recovery creates a new epoch", async (t) => {
  const seed = "x".repeat(limits.MAX_DOCUMENT_BYTES - 1);
  const h = await setup(t, seed);
  const oldScope = h.a.model.scope;
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "A" }]);
  h.eb.edit([{ rangeOffset: seed.length, rangeLength: 0, text: "B" }]);
  await waitFor(() => h.a.status === "paused" && h.b.status === "paused" && h.a.recoveryId && h.b.recoveryId);
  assert.equal(h.server.getStatus("ABC234").paused, true);
  assert.equal(h.a.draft, "A" + seed); assert.equal(h.b.draft, seed + "B");
  assert.equal(h.ba.getStatus().draft, "A" + seed); assert.equal(h.bb.getStatus().draft, seed + "B");
  assert.notEqual(h.a.model.getText(), h.b.model.getText(), "quarantined divergence is not convergence success");
  assert.throws(() => h.a.insert(0, "more"), /recovery/);
  await assert.rejects(h.bb.useRoomText(), /quarantined/);
  h.b.proposeRecovery("not owner"); await waitFor(() => h.b.errors.some((message) => message.includes("Only the owner")));
  h.a.proposeRecovery("explicitly reconciled text");
  await waitFor(() => h.a.proposal && h.b.proposal);
  h.a.approveRecovery(); await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(h.server.getStatus("ABC234").scope.epoch, oldScope.epoch, "one approval cannot reset everyone");
  h.b.approveRecovery(); await waitFor(() => h.a.status === "active" && h.b.status === "active");
  assert.notEqual(h.a.model.scope.epoch, oldScope.epoch);
  assert.equal(h.a.model.getText(), "explicitly reconciled text"); assert.equal(h.b.model.getText(), "explicitly reconciled text");
  assert.equal(h.ea.document.text, "A" + seed); assert.equal(h.eb.document.text, seed + "B", "reset does not replace editors automatically");
  assert.equal(h.ba.getStatus().status, "disposed"); assert.equal(h.bb.getStatus().status, "disposed");
  const nextA = new TestEditorBinding(h.ea.api, h.ea.document, h.a.model, undefined, h.ea.origin),
    nextB = new TestEditorBinding(h.eb.api, h.eb.document, h.b.model, undefined, h.eb.origin);
  h.bindings.push(nextA, nextB); await nextA.useRoomText(); await nextB.useRoomText();
  assert.equal(h.ea.document.text, "explicitly reconciled text"); assert.equal(h.eb.document.text, "explicitly reconciled text");
  assert.equal(h.ea.saves + h.eb.saves, 0); assert.equal(h.a.draft, "A" + seed); assert.equal(h.b.draft, seed + "B");
  const stale = protocol.encode(oldScope, "UPDATE", new Uint8Array([0, 0]));
  h.a.duplicate(stale); await waitFor(() => h.a.errors.some((message) => message.includes("does not match")));
  assert.equal(h.server.getStatus("ABC234").text, "explicitly reconciled text");
});

test("last disconnect removes room state and invalidates capabilities", async (t) => {
  const h = await setup(t); h.a.disconnect(); h.b.disconnect();
  await waitFor(() => !h.server.getStatus("ABC234").active);
  const client = new ExperimentalClient(protocol); h.clients.push(client);
  await assert.rejects(client.connect(h.url, h.grant.ownerToken, "ABC234", "shared.txt"), /Unauthorized/);
});

test("owner reconnects during quarantine without publishing a draft; changed quorum requires a fresh proposal", async (t) => {
  const seed = "x".repeat(limits.MAX_DOCUMENT_BYTES - 1);
  const h = await setup(t, seed);
  h.a.insert(0, "A"); h.b.insert(seed.length, "B");
  await waitFor(() => h.a.recoveryId && h.b.recoveryId && h.a.status === "paused" && h.b.status === "paused");
  h.a.proposeRecovery("first proposal"); await waitFor(() => h.a.proposal && h.b.proposal);
  const first = h.b.proposal.id;
  h.a.disconnect(); await waitFor(() => h.a.socket === undefined && h.b.proposal === undefined);
  await h.a.connect(h.url, h.grant.ownerToken, "ABC234", "shared.txt");
  assert.equal(h.a.status, "paused"); assert.equal(h.a.model.getStatus().ready, false);
  assert.equal(h.a.draft, "A" + seed); assert.equal(h.b.draft, seed + "B");
  h.b.socket.send(JSON.stringify({ type: "RECOVER_APPROVE", scope: h.b.model.scope, recoveryId: h.b.recoveryId, proposalId: first }));
  await waitFor(() => h.b.errors.some((message) => message.includes("Stale or missing")));
  h.a.proposeRecovery("fresh quorum choice"); await waitFor(() => h.a.proposal && h.b.proposal);
  assert.notEqual(h.a.proposal.id, first);
  h.a.approveRecovery(); h.b.approveRecovery(); await waitFor(() => h.a.status === "active" && h.b.status === "active");
  assert.equal(h.a.model.getText(), "fresh quorum choice"); assert.equal(h.b.model.getText(), "fresh quorum choice");
  assert.equal(h.ea.document.text, seed); assert.equal(h.eb.document.text, seed, "unbound editors were never replaced");
});

test("slow peer is disconnected at the bounded send queue and repairs by explicit state-vector rejoin", async (t) => {
  const h = await setup(t);
  const room = h.server.rooms.get("ABC234");
  const peer = [...room.members].find(([, entry]) => entry.token === h.grant.memberToken)[0];
  const original = peer.send;
  let held = 0;
  peer.send = function (data, options, callback) {
    if (options?.binary) { held++; return; }
    return original.call(this, data, options, callback);
  };
  for (let i = 0; i <= EXPERIMENTAL_LIMITS.queuedMessagesPerSocket; i++) {
    h.ea.edit([{ rangeOffset: i, rangeLength: 0, text: "x" }]);
    await waitFor(() => h.server.getStatus("ABC234").text === "x".repeat(i + 1) + "abcdef");
  }
  await waitFor(() => h.b.socket === undefined);
  assert.equal(held, EXPERIMENTAL_LIMITS.queuedMessagesPerSocket);
  assert.equal(h.b.draft, "abcdef");
  assert.equal(h.eb.document.text, "abcdef");
  assert.equal(h.eb.listeners, 0);
  assert.equal(h.server.getStatus("ABC234").text, "x".repeat(33) + "abcdef");
  assert.equal(h.server.getResources().queuedBytes, 0);
  assert.equal(h.server.getResources().queuedMessages, 0);
  assert.match(h.b.errors.at(-1), /explicitly rejoin/);
  await h.b.connect(h.url, h.grant.memberToken, "ABC234", "shared.txt");
  assert.equal(h.b.model.getText(), "x".repeat(33) + "abcdef");
  const rebound = new TestEditorBinding(h.eb.api, h.eb.document, h.b.model, undefined, h.eb.origin); h.bindings.push(rebound);
  assert.equal(rebound.getStatus().status, "paused");
  assert.equal(h.eb.document.text, "abcdef");
  await rebound.useRoomText();
  assert.equal(h.eb.document.text, "x".repeat(33) + "abcdef");
  assert.equal(h.eb.saves, 0);
});

test("blocked client outgoing queue pauses sharing and retains every unsaved local keystroke", async (t) => {
  const h = await setup(t);
  const socket = h.a.socket;
  const original = socket.send;
  let held = 0;
  socket.send = function (data, options, callback) {
    if (options?.binary) { held++; return; }
    return original.call(this, data, options, callback);
  };
  for (let i = 0; i <= EXPERIMENTAL_LIMITS.queuedMessagesPerSocket; i++) {
    h.ea.edit([{ rangeOffset: i, rangeLength: 0, text: "x" }]);
  }
  await waitFor(() => h.a.socket === undefined);
  assert.equal(held, EXPERIMENTAL_LIMITS.queuedMessagesPerSocket);
  assert.equal(h.a.sentUpdates, EXPERIMENTAL_LIMITS.queuedMessagesPerSocket);
  assert.equal(h.ea.document.text, "x".repeat(33) + "abcdef");
  assert.equal(h.ba.getStatus().draft, h.ea.document.text);
  assert.equal(h.server.getStatus("ABC234").text, "abcdef");
  assert.equal(h.b.model.getText(), "abcdef");
  assert.equal(h.ea.saves, 0);
});

test("explicit disconnect clears an in-flight client queue without publishing its draft", async (t) => {
  const h = await setup(t);
  const socket = h.a.socket;
  const original = socket.send;
  socket.send = function (data, options, callback) {
    if (options?.binary) return;
    return original.call(this, data, options, callback);
  };
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "draft " }]);
  assert.equal(h.a.queuedMessages, 1);
  h.a.disconnect();
  await waitFor(() => h.a.socket === undefined);
  assert.equal(h.a.queuedMessages, 0); assert.equal(h.a.queuedBytes, 0);
  assert.equal(h.a.draft, "draft abcdef");
  assert.equal(h.ea.document.text, "draft abcdef");
  assert.equal(h.server.getStatus("ABC234").text, "abcdef");
  assert.equal(h.ea.saves, 0);
});

test("update flood quarantines the room without accepting a divergent edit", async (t) => {
  const h = await setup(t);
  const frame = protocol.encode(h.a.model.scope, "UPDATE", Y.encodeStateAsUpdate(h.a.model.doc));
  for (let i = 0; i <= EXPERIMENTAL_LIMITS.updatesPerSecond; i++) h.a.socket.send(frame, { binary: true });
  await waitFor(() => h.a.status === "paused" && h.b.status === "paused");
  assert.match(h.a.errors.at(-1), /rate limit/);
  assert.equal(h.server.getStatus("ABC234").text, "abcdef");
  assert.equal(h.server.getStatus("ABC234").paused, true);
  assert.equal(h.a.draft, "abcdef"); assert.equal(h.b.draft, "abcdef");
  assert.equal(h.server.getResources().queuedMessages, 0);
});

test("pending joins, capabilities and unauthenticated sockets remain bounded and clean up", async (t) => {
  const h = await setup(t);
  const pending = [];
  t.after(() => pending.forEach((socket) => socket.terminate()));
  for (let i = 0; i < EXPERIMENTAL_LIMITS.pendingJoinsPerRoom + 1; i++) {
    const token = h.server.grantMember("ABC234");
    const socket = new WebSocket(h.url); pending.push(socket);
    const replies = []; socket.on("message", (raw) => replies.push(JSON.parse(raw.toString())));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "HELLO", token, roomId: "ABC234", documentPath: "shared.txt" }));
    await waitFor(() => replies.length);
    assert.equal(replies[0].type, i < EXPERIMENTAL_LIMITS.pendingJoinsPerRoom ? "SCOPE" : "ERROR");
  }
  assert.equal(h.server.getStatus("ABC234").pendingJoins, EXPERIMENTAL_LIMITS.pendingJoinsPerRoom);
  assert.equal(h.server.getStatus("ABC234").grants, 2 + EXPERIMENTAL_LIMITS.pendingJoinsPerRoom + 1);
  h.server.grantMember("ABC234");
  assert.throws(() => h.server.grantMember("ABC234"), /capability limit/);
  for (const socket of pending) socket.terminate();
  await waitFor(() => h.server.getStatus("ABC234").pendingJoins === 0);
  assert.equal(h.server.getStatus("ABC234").members, 2);
  const unauth = [];
  t.after(() => unauth.forEach((socket) => socket.terminate()));
  for (let i = 0; i < EXPERIMENTAL_LIMITS.pendingSockets; i++) {
    const socket = new WebSocket(h.url); unauth.push(socket);
    await new Promise((resolve) => socket.once("open", resolve));
  }
  await waitFor(() => h.server.getResources().pendingSockets === EXPERIMENTAL_LIMITS.pendingSockets);
  const excess = new WebSocket(h.url); unauth.push(excess);
  await new Promise((resolve) => excess.once("close", resolve));
  assert.equal(h.server.getResources().pendingSockets, EXPERIMENTAL_LIMITS.pendingSockets);
  for (const socket of unauth) socket.terminate();
  await waitFor(() => h.server.getResources().pendingSockets === 0);
});

test("malformed, stale-epoch and forged-capability frames do not allocate room state", async (t) => {
  const h = await setup(t);
  const staleScope = { ...h.a.model.scope, epoch: "00000000-0000-0000-0000-000000000000" };
  const frames = [
    Buffer.from([0, 0, 16, 0, 1, 2]),
    protocol.encode(staleScope, "UPDATE", new Uint8Array([0, 0])),
    protocol.encode({ ...h.a.model.scope, documentPath: "other.txt" }, "UPDATE", new Uint8Array([0, 0]))
  ];
  for (const frame of frames) {
    const before = h.a.errors.length;
    h.a.socket.send(frame, { binary: true });
    await waitFor(() => h.a.errors.length > before);
    assert.equal(h.server.getStatus("ABC234").text, "abcdef");
    assert.equal(h.server.getStatus("ABC234").paused, false);
  }
  const stranger = new WebSocket(h.url); t.after(() => stranger.terminate());
  const replies = []; stranger.on("message", (raw) => replies.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => stranger.once("open", resolve));
  stranger.send(JSON.stringify({ type: "HELLO", token: "a".repeat(64), roomId: "ABC234", documentPath: "shared.txt" }));
  await waitFor(() => replies.length);
  assert.match(replies[0].reason, /Unauthorized/);
  assert.equal(h.server.getStatus("ABC234").members, 2);
});

test("queued old-epoch delivery is dropped at reset and the disconnected draft survives", async (t) => {
  const h = await setup(t);
  const room = h.server.rooms.get("ABC234");
  const peer = [...room.members].find(([, entry]) => entry.token === h.grant.memberToken)[0];
  const original = peer.send;
  let held = 0;
  peer.send = function (data, options, callback) {
    if (options?.binary) { held++; return; }
    return original.call(this, data, options, callback);
  };
  h.a.insert(0, "x"); await waitFor(() => held === 1);
  const oldEpoch = h.a.model.scope.epoch;
  h.a.socket.send(JSON.stringify({ type: "PAUSE", scope: h.a.model.scope }));
  await waitFor(() => h.a.status === "paused" && h.b.status === "paused");
  h.a.proposeRecovery("chosen"); await waitFor(() => h.a.proposal && h.b.proposal);
  h.a.approveRecovery(); h.b.approveRecovery();
  await waitFor(() => h.a.status === "active" && h.b.socket === undefined);
  assert.notEqual(h.a.model.scope.epoch, oldEpoch);
  assert.equal(h.b.draft, "abcdef"); assert.equal(h.eb.document.text, "abcdef");
  assert.equal(h.server.getResources().queuedMessages, 0);
  await h.b.connect(h.url, h.grant.memberToken, "ABC234", "shared.txt");
  assert.equal(h.b.model.getText(), "chosen");
  const rebound = new TestEditorBinding(h.eb.api, h.eb.document, h.b.model); h.bindings.push(rebound);
  assert.equal(rebound.getStatus().status, "paused");
  assert.equal(h.eb.document.text, "abcdef");
  assert.equal(h.eb.saves, 0);
});

test("room sessions are capped and disposal releases all resources", async () => {
  const server = new ExperimentalServer(protocol);
  try {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (const char of alphabet) server.createRoom("ABC" + char + "AA", "shared.txt", "");
    assert.equal(server.getResources().rooms, EXPERIMENTAL_LIMITS.rooms);
    assert.throws(() => server.createRoom("DEF234", "shared.txt", ""), /room limit/);
  } finally { await server.dispose(); }
  assert.deepEqual(server.getResources(), { rooms: 0, sockets: 0, pendingSockets: 0, queuedBytes: 0, queuedMessages: 0 });
});

test("aggregate outbound budget rejects an additional slow peer before exceeding 32 MiB", async (t) => {
  const h = await setup(t);
  for (let i = 0; i < EXPERIMENTAL_LIMITS.grantsPerRoom - 2; i++) {
    const client = new ExperimentalClient(protocol); h.clients.push(client);
    await client.connect(h.url, h.server.grantMember("ABC234"), "ABC234", "shared.txt");
  }
  const otherGrant = h.server.createRoom("DEF567", "other.txt", "");
  const other = new ExperimentalClient(protocol); h.clients.push(other);
  await other.connect(h.url, otherGrant.ownerToken, "DEF567", "other.txt");
  const room = h.server.rooms.get("ABC234");
  for (const socket of room.members.keys()) socket.send = function () { return; };
  const megabyte = new Uint8Array(1024 * 1024);
  for (const socket of room.members.keys()) {
    for (let i = 0; i < 4; i++) assert.equal(h.server.sendFrame(socket, megabyte, true), true);
  }
  assert.equal(h.server.getResources().queuedBytes, EXPERIMENTAL_LIMITS.queuedBytesGlobal);
  const otherSocket = [...h.server.rooms.get("DEF567").members.keys()][0];
  assert.equal(h.server.sendFrame(otherSocket, new Uint8Array([1]), true), false);
  await waitFor(() => other.socket === undefined);
  assert.equal(h.server.getResources().queuedBytes, EXPERIMENTAL_LIMITS.queuedBytesGlobal);
  assert.equal(h.server.getResources().queuedMessages, 32);
});

test("uncompleted state-vector join expires and releases its pending slot", async (t) => {
  const h = await setup(t);
  const token = h.server.grantMember("ABC234");
  const socket = new WebSocket(h.url); t.after(() => socket.terminate());
  const replies = []; socket.on("message", (raw) => replies.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "HELLO", token, roomId: "ABC234", documentPath: "shared.txt" }));
  await waitFor(() => replies.some((message) => message.type === "SCOPE"));
  assert.equal(h.server.getStatus("ABC234").pendingJoins, 1);
  await new Promise((resolve) => socket.once("close", resolve));
  await waitFor(() => h.server.getStatus("ABC234").pendingJoins === 0);
  assert.equal(h.server.getStatus("ABC234").members, 2);
});

test("ordered latency and jitter: concurrent editor edits and undo during delayed delivery converge without echo", async (t) => {
  const h = await setup(t, "base");
  const peers = [...h.server.rooms.get("ABC234").members.keys()];
  const links = [orderedDelay(h.a.socket, [18, 31, 22]), orderedDelay(h.b.socket, [27, 16, 35]),
    orderedDelay(peers[0], [24, 39, 20]), orderedDelay(peers[1], [32, 19, 41])];
  const metrics = measure(h.server); t.after(() => metrics.stop());
  const start = performance.now();
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: "A" }]);
  h.eb.edit([{ rangeOffset: 4, rangeLength: 0, text: "B" }]);
  await waitFor(() => h.a.model.getText() === h.b.model.getText() && h.a.model.getText().includes("A") && h.a.model.getText().includes("B"));
  await h.ba.settled(); await h.bb.settled();
  const concurrentMs = performance.now() - start;
  const converged = h.a.model.getText();
  assert.equal(h.ea.document.text, converged); assert.equal(h.eb.document.text, converged);
  assert.equal(converged.match(/A/g).length, 1); assert.equal(converged.match(/B/g).length, 1);
  const sentA = h.a.sentUpdates, sentB = h.b.sentUpdates;
  const undoStart = performance.now();
  h.ea.edit([{ rangeOffset: h.ea.document.text.length, rangeLength: 0, text: "U" }]);
  assert.equal(await h.ba.undoLocal(), true);
  await waitFor(() => h.a.model.getText() === converged && h.b.model.getText() === converged
    && h.server.getStatus("ABC234").text === converged);
  await h.ba.settled(); await h.bb.settled();
  assert.equal(h.ea.document.text, converged); assert.equal(h.eb.document.text, converged);
  assert.equal(h.a.sentUpdates, sentA + 2); assert.equal(h.b.sentUpdates, sentB);
  assert.equal(h.ea.saves + h.eb.saves, 0);
  await waitFor(() => links.every((link) => link.pending === 0));
  const result = metrics.stop();
  assert.ok(result.queuedBytes <= EXPERIMENTAL_LIMITS.queuedBytesPerSocket * 2);
  assert.ok(result.queuedMessages <= EXPERIMENTAL_LIMITS.queuedMessagesPerSocket * 2);
  console.log("CONGESTION_METRICS " + JSON.stringify({ case: "ordered-concurrent-undo", concurrentMs: Math.round(concurrentMs),
    undoMs: Math.round(performance.now() - undoStart), ...result }));
});

test("delayed slow reader reaches the queue bound, keeps its draft, and explicitly rejoins and recovers a new epoch", async (t) => {
  const h = await setup(t);
  const peer = [...h.server.rooms.get("ABC234").members].find(([, member]) => member.token === h.grant.memberToken)[0];
  orderedDelay(peer, [1000, 1100, 950]);
  const metrics = measure(h.server); t.after(() => metrics.stop());
  const start = performance.now();
  for (let i = 0; i <= EXPERIMENTAL_LIMITS.queuedMessagesPerSocket; i++) {
    h.ea.edit([{ rangeOffset: i, rangeLength: 0, text: "x" }]);
    await waitFor(() => h.server.getStatus("ABC234").text === "x".repeat(i + 1) + "abcdef");
    metrics.sample();
  }
  await waitFor(() => h.b.socket === undefined);
  const droppedMs = performance.now() - start;
  assert.equal(h.eb.document.text, "abcdef"); assert.equal(h.b.draft, "abcdef");
  assert.equal(h.bb.getStatus().status, "disposed");
  assert.equal(h.server.getStatus("ABC234").text, "x".repeat(33) + "abcdef");
  assert.equal(h.server.getResources().queuedBytes, 0);
  assert.equal(h.server.getResources().queuedMessages, 0);
  const rejoinStart = performance.now();
  await h.b.connect(h.url, h.grant.memberToken, "ABC234", "shared.txt");
  const rebound = new TestEditorBinding(h.eb.api, h.eb.document, h.b.model, undefined, h.eb.origin); h.bindings.push(rebound);
  assert.equal(rebound.getStatus().status, "paused");
  assert.equal(h.eb.document.text, "abcdef", "rejoin cannot silently replace the local draft");
  await rebound.useRoomText();
  assert.equal(h.eb.document.text, "x".repeat(33) + "abcdef");
  const rejoinMs = performance.now() - rejoinStart;
  const oldEpoch = h.a.model.scope.epoch;
  h.a.socket.send(JSON.stringify({ type: "PAUSE", scope: h.a.model.scope }));
  await waitFor(() => h.a.status === "paused" && h.b.status === "paused");
  assert.equal(rebound.getStatus().status, "paused");
  const draft = h.eb.document.text;
  h.a.proposeRecovery("chosen epoch"); await waitFor(() => h.a.proposal && h.b.proposal);
  h.a.approveRecovery(); h.b.approveRecovery();
  await waitFor(() => h.a.status === "active" && h.b.status === "active");
  assert.notEqual(h.a.model.scope.epoch, oldEpoch);
  assert.equal(h.a.model.getText(), "chosen epoch"); assert.equal(h.b.model.getText(), "chosen epoch");
  assert.equal(h.eb.document.text, draft, "epoch reset cannot replace the paused editor");
  const next = new TestEditorBinding(h.eb.api, h.eb.document, h.b.model, undefined, h.eb.origin); h.bindings.push(next);
  assert.equal(next.getStatus().status, "paused");
  await next.useRoomText();
  assert.equal(h.eb.document.text, "chosen epoch"); assert.equal(next.getStatus().draft, draft);
  assert.equal(h.ea.saves + h.eb.saves, 0);
  const result = metrics.stop();
  assert.ok(result.queuedBytes <= EXPERIMENTAL_LIMITS.queuedBytesPerSocket);
  assert.ok(result.queuedMessages <= EXPERIMENTAL_LIMITS.queuedMessagesPerSocket);
  console.log("CONGESTION_METRICS " + JSON.stringify({ case: "slow-reader-rejoin-epoch", droppedMs: Math.round(droppedMs),
    rejoinMs: Math.round(rejoinMs), ...result }));
});

test("paused real TCP reader: outbound bytes stay bounded near 4 MiB and an accepted edit repairs on rejoin", async (t) => {
  const h = await setup(t);
  const peer = [...h.server.rooms.get("ABC234").members].find(([, member]) => member.token === h.grant.memberToken)[0];
  assert.ok(h.b.socket._socket, "this probe requires a real ws TCP socket");
  h.b.socket._socket.pause();
  let state = 0x12345678;
  const large = Array.from({ length: 220 * 1024 }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return String.fromCharCode(33 + (state >>> 0) % 90);
  }).join("");
  const metrics = measure(h.server); t.after(() => metrics.stop());
  const start = performance.now();
  h.ea.edit([{ rangeOffset: 0, rangeLength: 0, text: large }]);
  await waitFor(() => h.server.getStatus("ABC234").text?.length === large.length + 6);
  const accepted = h.server.getStatus("ABC234").text;
  const frame = protocol.encode(h.a.model.scope, "UPDATE", Y.encodeStateAsUpdate(h.a.model.doc));
  assert.ok(frame.byteLength > 200 * 1024 && frame.byteLength < limits.MAX_MESSAGE_BYTES);
  let acceptedSends = 0, peakBufferedAmount = peer.bufferedAmount, rejected = false;
  for (let i = 0; i < 128; i++) {
    const sent = h.server.sendFrame(peer, frame, true);
    peakBufferedAmount = Math.max(peakBufferedAmount, peer.bufferedAmount);
    metrics.sample();
    if (!sent) { rejected = true; break; }
    acceptedSends++;
  }
  await waitFor(() => h.server.getStatus("ABC234").members === 1);
  const dropMs = performance.now() - start;
  h.b.disconnect();
  await waitFor(() => h.b.socket === undefined);
  assert.ok(rejected, "the 4 MiB byte bound must terminate the paused reader");
  assert.ok(acceptedSends < EXPERIMENTAL_LIMITS.queuedMessagesPerSocket, "byte limit must fire before message count");
  assert.equal(h.eb.document.text, "abcdef"); assert.equal(h.b.draft, "abcdef");
  assert.equal(h.bb.getStatus().status, "disposed");
  assert.equal(h.server.getStatus("ABC234").text, accepted, "the accepted edit remains in room state");
  await waitFor(() => h.server.getResources().queuedBytes === 0 && h.server.getResources().queuedMessages === 0);
  const rejoinStart = performance.now();
  await h.b.connect(h.url, h.grant.memberToken, "ABC234", "shared.txt");
  assert.equal(h.b.model.getText(), accepted);
  const rebound = new TestEditorBinding(h.eb.api, h.eb.document, h.b.model, undefined, h.eb.origin); h.bindings.push(rebound);
  assert.equal(rebound.getStatus().status, "paused"); assert.equal(h.eb.document.text, "abcdef");
  await rebound.useRoomText();
  assert.equal(h.eb.document.text, accepted); assert.equal(rebound.getStatus().draft, "abcdef");
  assert.equal(h.ea.saves + h.eb.saves, 0);
  const result = metrics.stop();
  assert.ok(peakBufferedAmount > 2 * 1024 * 1024, "real ws bufferedAmount must show TCP backpressure");
  assert.ok(result.queuedBytes >= 0.9 * EXPERIMENTAL_LIMITS.queuedBytesPerSocket, "outbound queue must approach the byte cap");
  assert.ok(result.queuedBytes <= EXPERIMENTAL_LIMITS.queuedBytesPerSocket);
  assert.ok(result.rssDeltaBytes < 128 * 1024 * 1024);
  console.log("SOCKET_BACKPRESSURE_METRICS " + JSON.stringify({ frameBytes: frame.byteLength, acceptedSends,
    peakBufferedAmount, dropMs: Math.round(dropMs), rejoinMs: Math.round(performance.now() - rejoinStart), ...result }));
});
