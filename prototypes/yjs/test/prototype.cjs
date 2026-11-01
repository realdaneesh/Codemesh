const assert = require("node:assert/strict");
const { test } = require("node:test");
const Y = require("yjs");
const { BinaryProtocol } = require("../dist/protocol");
const { PrototypeClient, PrototypeRoom } = require("../dist/prototype");
const { MAX_MESSAGE_BYTES, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PATH_BYTES } = require("../../../extension/dist/types/syncLimits");
const { normalizeManifestPath } = require("../../../extension/dist/types/workspaceManifest");

const limits = { maxMessageBytes: MAX_MESSAGE_BYTES, maxDocumentBytes: MAX_DOCUMENT_BYTES, maxPathBytes: MAX_DOCUMENT_PATH_BYTES };
const protocol = new BinaryProtocol(limits, normalizeManifestPath);

function setup(t, seed = "abcdef", codec = protocol) {
  const room = new PrototypeRoom("ABC234", "src/shared.txt", codec, seed);
  const clients = new Map(), outgoing = [], observations = new Map();
  const join = (id) => {
    const observed = [];
    observations.set(id, observed);
    const client = new PrototypeClient(room.scope, codec, (frame) => outgoing.push({ memberId: id, frame }), (text) => observed.push(text));
    clients.set(id, client);
    client.receive(room.join(id, client.stateVectorFrame()));
    return client;
  };
  const a = join("a"), b = join("b");
  t.after(() => { for (const client of clients.values()) client.dispose(); room.dispose(); });
  const deliver = (packets) => { for (const packet of packets) clients.get(packet.memberId).receive(packet.frame); };
  const route = (packets) => packets.flatMap((packet) => room.receive(packet.memberId, packet.frame));
  const converge = (expected) => {
    assert.equal(room.getText(), expected);
    for (const client of clients.values()) assert.equal(client.getText(), expected);
    assert.equal(outgoing.length, 0, "remote application must not echo as a local update");
  };
  return { room, a, b, join, clients, outgoing, observations, route, deliver, converge };
}

test("different-position concurrent inserts converge in either server order without echo", (t) => {
  for (const reversed of [false, true]) {
    const h = setup(t);
    h.a.insert(1, "A"); h.b.insert(5, "B");
    assert.equal(h.a.getText(), "aAbcdef"); assert.equal(h.b.getText(), "abcdeBf");
    assert.equal(h.outgoing.length, 2);
    const packets = h.outgoing.splice(0);
    h.deliver(h.route(reversed ? packets.reverse() : packets));
    h.converge("aAbcdeBf");
  }
});

test("concurrent insertion into a deleted range converges in either server order", (t) => {
  for (const reversed of [false, true]) {
    const h = setup(t);
    h.a.insert(2, "X"); h.b.delete(2, 2);
    const packets = h.outgoing.splice(0);
    h.deliver(h.route(reversed ? packets.reverse() : packets));
    h.converge("abXef");
  }
});

test("dependent updates delivered out of order and repeatedly converge", (t) => {
  const h = setup(t);
  h.a.insert(6, "1"); h.a.insert(7, "2"); h.a.insert(8, "3"); h.b.insert(0, "B");
  const [first, second, third, other] = h.outgoing.splice(0);
  const routed = h.route([third, second, third, other, first, second, first]);
  h.deliver([...routed].reverse()); h.deliver(routed);
  h.converge("Babcdef123");
  const calls = [...h.observations.values()].reduce((sum, values) => sum + values.length, 0);
  h.deliver(routed);
  assert.equal([...h.observations.values()].reduce((sum, values) => sum + values.length, 0), calls, "duplicates do not notify text observers again");
});

test("late joiner receives the room's current state via its binary state vector", (t) => {
  const h = setup(t);
  h.a.delete(1, 3); h.a.insert(1, "late");
  h.deliver(h.route(h.outgoing.splice(0)));
  const late = h.join("late");
  assert.equal(late.getText(), "alateef");
  h.converge("alateef");
});

test("nonempty state vector requests missing inserts and deletion-only changes", (t) => {
  const h = setup(t, "x".repeat(1024));
  h.a.insert(1024, "new");
  h.route(h.outgoing.splice(0)); // B misses the broadcast.
  const diff = h.room.sync("b", h.b.stateVectorFrame());
  assert.ok(diff.byteLength < protocol.encode(h.room.scope, "UPDATE", Y.encodeStateAsUpdate(h.room.doc)).byteLength);
  h.b.receive(diff);
  h.converge("x".repeat(1024) + "new");
  h.a.delete(0, 5);
  h.route(h.outgoing.splice(0));
  h.b.receive(h.room.sync("b", h.b.stateVectorFrame()));
  h.converge("x".repeat(1019) + "new");
});

test("LF canonical state preserves Unicode and does not seed each joining replica again", (t) => {
  const h = setup(t, "first\r\n\u4e2d\u6587 \ud83d\ude80");
  const actor = h.a.doc.clientID;
  h.a.insert(h.a.getText().length, "\r\nlast");
  h.deliver(h.route(h.outgoing.splice(0)));
  h.join("late");
  h.converge("first\n\u4e2d\u6587 \ud83d\ude80\nlast");
  assert.equal(h.a.doc.clientID, actor, "local transactions retain their own actor identity");
  assert.ok(Y.decodeStateVector(protocol.decode(h.a.scope, h.a.stateVectorFrame(), "STATE_VECTOR")).has(actor));
});

test("leave removes observers and state; last leave releases the ephemeral room", (t) => {
  const h = setup(t);
  const oldDoc = h.a.doc, oldText = h.a.text, serverDoc = h.room.doc;
  const observations = h.observations.get("a").length;
  h.a.leave(); h.room.leave("a");
  assert.deepEqual(h.a.getStatus(), { active: false, ready: false, listenerCount: 0 });
  assert.equal(h.a.doc, undefined); assert.equal(h.a.text, undefined); assert.equal(oldDoc.isDestroyed, true);
  oldText.insert(0, "after leave");
  assert.equal(h.observations.get("a").length, observations); assert.equal(h.outgoing.length, 0);
  assert.throws(() => h.a.insert(0, "stale"), /ended/);
  assert.throws(() => h.a.receive(protocol.encode(h.room.scope, "UPDATE", new Uint8Array([0, 0]))), /ended/);
  assert.deepEqual(h.room.getStatus(), { active: true, memberCount: 1 });
  h.b.dispose(); h.b.dispose(); h.room.leave("b"); h.room.leave("b");
  assert.deepEqual(h.room.getStatus(), { active: false, memberCount: 0 });
  assert.equal(h.room.doc, undefined); assert.equal(serverDoc.isDestroyed, true);
  assert.throws(() => h.room.getText(), /ended/);
});

test("room disposal releases membership and document; new epoch rejects stale updates", (t) => {
  const h = setup(t);
  h.a.insert(0, "old"); const oldFrame = h.outgoing.splice(0)[0].frame;
  const priorDoc = h.room.doc;
  h.room.dispose(); h.a.dispose(); h.b.dispose();
  assert.equal(priorDoc.isDestroyed, true); assert.equal(h.room.getStatus().memberCount, 0);
  const next = new PrototypeRoom("ABC234", "src/shared.txt", protocol, "fresh");
  const client = new PrototypeClient(next.scope, protocol, () => undefined);
  t.after(() => { client.dispose(); next.dispose(); });
  client.receive(next.join("new", client.stateVectorFrame()));
  assert.throws(() => next.receive("new", oldFrame), /does not match/);
  assert.equal(next.getText(), "fresh");
});

test("room, document and membership boundaries reject crossed frames", (t) => {
  const h = setup(t);
  h.a.insert(0, "A"); const frame = h.outgoing.splice(0)[0].frame;
  assert.throws(() => h.room.receive("outsider", frame), /not in/);
  for (const extra of [{ roomId: "DEF567" }, { documentPath: "src/other.txt" }]) {
    const forged = protocol.encode({ ...h.room.scope, ...extra }, "UPDATE", protocol.decode(h.room.scope, frame, "UPDATE"));
    assert.throws(() => h.room.receive("a", forged), /does not match/);
    assert.throws(() => h.b.receive(forged), /does not match/);
  }
  for (const path of ["../escape", "/absolute", "C:\\machine.txt", "src\\shared.txt"]) {
    assert.throws(() => new PrototypeRoom("ABC234", path, protocol), /path|relative/i);
  }
  assert.equal(h.room.getText(), "abcdef"); assert.equal(h.b.getText(), "abcdef");
});

test("complete binary frames respect the exact 2 MiB CodeMesh boundary", (t) => {
  const h = setup(t);
  const overhead = protocol.encode(h.room.scope, "UPDATE", new Uint8Array([0])).byteLength - 1;
  const payload = new Uint8Array(MAX_MESSAGE_BYTES - overhead);
  const boundary = protocol.encode(h.room.scope, "UPDATE", payload);
  assert.equal(boundary.byteLength, MAX_MESSAGE_BYTES);
  assert.equal(protocol.decode(h.room.scope, boundary, "UPDATE").byteLength, payload.byteLength);
  assert.throws(() => protocol.encode(h.room.scope, "UPDATE", new Uint8Array(payload.length + 1)), /message limit/);
  assert.throws(() => h.room.receive("a", new Uint8Array(MAX_MESSAGE_BYTES + 1)), /message limit/);
  assert.equal(h.room.getText(), "abcdef");
});

test("valid 256 KiB document update fits; rejected local growth preserves state", (t) => {
  const h = setup(t, "");
  const boundary = "\ud83d\ude80".repeat(MAX_DOCUMENT_BYTES / 4);
  h.a.insert(0, boundary);
  const packets = h.outgoing.splice(0);
  assert.ok(packets[0].frame.byteLength <= MAX_MESSAGE_BYTES);
  h.deliver(h.route(packets)); h.converge(boundary);
  assert.throws(() => h.a.insert(0, "x"), /document limit/);
  assert.equal(h.a.getText(), boundary); assert.equal(h.outgoing.length, 0);
});

test("malformed updates, vectors, non-LF, extra shared types and large text fail atomically", (t) => {
  const h = setup(t);
  const invalid = new Uint8Array([255, 255, 255]);
  assert.throws(() => h.room.receive("a", protocol.encode(h.room.scope, "UPDATE", invalid)));
  assert.throws(() => h.b.receive(protocol.encode(h.room.scope, "UPDATE", invalid)));
  assert.throws(() => h.room.join("bad-vector", protocol.encode(h.room.scope, "STATE_VECTOR", invalid)));
  assert.equal(h.room.getStatus().memberCount, 2);
  for (const fill of [
    (doc) => doc.getText("text").insert(0, "raw\r\n"),
    (doc) => doc.getText("text").insert(0, "x".repeat(MAX_DOCUMENT_BYTES + 1)),
    (doc) => doc.getMap("other").set("hidden", 1),
    (doc) => doc.getText("text").insertEmbed(0, { image: "not plain text" })
  ]) {
    const doc = new Y.Doc(); fill(doc);
    const frame = protocol.encode(h.room.scope, "UPDATE", Y.encodeStateAsUpdate(doc));
    assert.throws(() => h.room.receive("a", frame));
    assert.throws(() => h.b.receive(frame)); doc.destroy();
    assert.equal(h.room.getText(), "abcdef"); assert.equal(h.b.getText(), "abcdef");
  }
});

test("oversized staged update is rejected before a local transaction or listener fires", (t) => {
  const small = new BinaryProtocol({ ...limits, maxMessageBytes: 256 }, normalizeManifestPath);
  const h = setup(t, "seed", small);
  const calls = h.observations.get("a").length;
  assert.throws(() => h.a.insert(0, "x".repeat(256)), /message limit/);
  assert.equal(h.a.getText(), "seed"); assert.equal(h.outgoing.length, 0);
  assert.equal(h.observations.get("a").length, calls);
});

test("concurrent edits exceeding the merged text cap reject without erasing the sender draft", (t) => {
  const seed = "x".repeat(MAX_DOCUMENT_BYTES - 1);
  const h = setup(t, seed);
  h.a.insert(0, "A"); h.b.insert(seed.length, "B");
  const [a, b] = h.outgoing.splice(0);
  h.room.receive(a.memberId, a.frame);
  assert.throws(() => h.room.receive(b.memberId, b.frame), /document limit/);
  assert.equal(h.room.getText(), "A" + seed);
  assert.equal(h.b.getText(), seed + "B", "rejected sender draft is not overwritten");
  // This is an intentional quarantine/reconciliation gate, not a convergence pass.
});
