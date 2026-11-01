const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");
const { createEditor, createProxy, delay, canonical, listening } = require("./multi-file-sync.cjs");

const FULL_DURATION_MS = 15 * 60 * 1000;
const requestedDuration = Number(process.env.CODEMESH_SOAK_DURATION_MS ?? FULL_DURATION_MS);
if (!Number.isFinite(requestedDuration) || requestedDuration < 1) throw new Error("Invalid soak duration");

async function until(predicate, description, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(10);
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codemesh-two-file-soak-"));
  const server = new CollaborationServer(0);
  server.start();
  await listening(server.server);
  const clients = [], editors = [], proxies = [];
  const counts = { A: 0, B: 0, idlePeriods: 0, idleMs: 0, reshares: 0, reconnects: 0 };
  let heartbeat;
  try {
    const target = `ws://127.0.0.1:${server.server.address().port}`;
    for (const [name, eol] of [["a", "\n"], ["b", "\r\n"]]) {
      const proxy = await createProxy(target);
      const editor = await createEditor(path.join(root, name), eol);
      const client = new editor.Client({ serverUrl: proxy.url, reconnectDelayMs: 20, documentAckTimeoutMs: 300,
        self: { memberId: name, displayName: name } });
      proxies.push(proxy); editors.push(editor); clients.push(client);
    }
    const [a, b] = clients, [ea, eb] = editors, [pa, pb] = proxies;
    const docs = {
      a: { A: await ea.open("A.txt", "A0\n"), B: await ea.open("B.txt", "B0\n") },
      b: { A: await eb.open("A.txt", "A0\n"), B: await eb.open("B.txt", "B0\n") }
    };
    const expected = { A: "A0\n", B: "B0\n" };
    const session = (client, file) => client.getDocumentSessions().find(value => value.path === `${file}.txt`);
    const editCount = (proxy, file) => proxy.upstream.filter(value => value.type === "DOCUMENT_EDIT" && value.documentPath === `${file}.txt`).length;
    const roomDoc = (file) => server.documents.get(`${roomId}:${file}.txt`);
    const assertDisk = async () => { await ea.assertUnsaved(); await eb.assertUnsaved(); };
    const assertServer = (file) => {
      assert.equal(roomDoc(file)?.revision, counts[file], `${file} server revision`);
      assert.equal(roomDoc(file)?.text, expected[file], `${file} server text`);
    };
    const assertShared = (file) => {
      for (const [name, client] of [["a", a], ["b", b]]) {
        assert.equal(session(client, file)?.status, "shared", `${name} ${file} status`);
        assert.equal(session(client, file)?.revision, counts[file], `${name} ${file} revision`);
        assert.equal(canonical(docs[name][file].getText()), expected[file], `${name} ${file} buffer`);
      }
      assertServer(file);
    };
    const stable = async (file) => {
      await until(() => [a, b].every((client, index) => session(client, file)?.status === "shared"
        && session(client, file)?.revision === counts[file]
        && canonical(docs[index ? "b" : "a"][file].getText()) === expected[file]), `${file} convergence`);
      assertShared(file);
    };
    const edit = async (file, who, phase, otherMayBePaused = false) => {
      const editor = who === "a" ? ea : eb;
      const before = { aA: editCount(pa, "A"), aB: editCount(pa, "B"), bA: editCount(pb, "A"), bB: editCount(pb, "B") };
      const other = file === "A" ? "B" : "A";
      const otherRevision = counts[other];
      expected[file] = `${file}|${counts[file] + 1}|${who}|${phase}\n`;
      editor.type(docs[who][file], expected[file]);
      counts[file] += 1;
      await stable(file);
      if (otherMayBePaused) {
        assertServer(other);
        assert.equal(session(b, other)?.revision, counts[other], `${other} peer revision while a is paused`);
        assert.equal(canonical(docs.a[other].getText()), expected[other], `${other} preserved draft`);
      } else if (session(a, other)) assertShared(other);
      else {
        assertServer(other);
        assert.equal(session(b, other)?.revision, counts[other], `${other} peer revision while a is closed`);
        assert.equal(canonical(docs.b[other].getText()), expected[other], `${other} peer buffer while a is closed`);
      }
      await delay(35);
      assert.equal(editCount(pa, "A") - before.aA, file === "A" && who === "a" ? 1 : 0, "A upstream count from a");
      assert.equal(editCount(pa, "B") - before.aB, file === "B" && who === "a" ? 1 : 0, "B upstream count from a");
      assert.equal(editCount(pb, "A") - before.bA, file === "A" && who === "b" ? 1 : 0, "A upstream count from b");
      assert.equal(editCount(pb, "B") - before.bB, file === "B" && who === "b" ? 1 : 0, "B upstream count from b");
      assert.equal(counts[other], otherRevision, "other file revision remains independent");
      assert.equal(editCount(pa, "A") + editCount(pb, "A"), counts.A, "A has no duplicate edit frames");
      assert.equal(editCount(pa, "B") + editCount(pb, "B"), counts.B, "B has no duplicate edit frames");
    };
    await a.createRoom();
    await until(() => a.getState().roomId, "room created");
    const roomId = a.getState().roomId;
    await b.joinRoom(roomId);
    await until(() => b.getState().roomId === roomId, "room joined");
    for (const file of ["A", "B"]) {
      await a.shareDocumentForService(docs.a[file]);
      await b.shareDocumentForService(docs.b[file]);
      await stable(file);
    }
    const started = performance.now();
    heartbeat = setInterval(() => console.log(`PROGRESS: ${Math.floor((performance.now() - started) / 1000)}s; edits A=${counts.A} B=${counts.B}; idle=${counts.idlePeriods}`), 60000);
    console.log(`START: ${requestedDuration} ms two-client production soak${requestedDuration < FULL_DURATION_MS ? " (dry run)" : ""}`);

    for (const [file, who] of [["A", "a"], ["B", "b"], ["A", "b"], ["B", "a"]]) await edit(file, who, "warmup");
    await assertDisk();
    console.log("PASS: initial bidirectional A/B edits, independent revisions, no echoes or saves");

    const oldA = session(a, "A").shareSessionId;
    const bId = session(a, "B").shareSessionId;
    a.stopDocumentSession("A.txt");
    await until(() => !session(a, "A") && session(a, "B")?.shareSessionId === bId, "A closed, B retained");
    await edit("B", "b", "A-closed");
    await a.shareDocumentForService(docs.a.A);
    await stable("A");
    counts.reshares += 1;
    assert.notEqual(session(a, "A").shareSessionId, oldA);
    assert.equal(session(a, "B").shareSessionId, bId);
    const beforeStale = { A: canonical(docs.a.A.getText()), B: canonical(docs.a.B.getText()), ARevision: session(a, "A").revision, BRevision: session(a, "B").revision };
    for (const message of [
      { type: "DOCUMENT_ACK", roomId, documentPath: "A.txt", revision: 999, shareSessionId: oldA },
      { type: "DOCUMENT_EDIT", roomId, documentPath: "A.txt", revision: 999, text: "delayed-old-generation", shareSessionId: oldA },
      { type: "DOCUMENT_CONFLICT", roomId, documentPath: "A.txt", revision: 999, text: "delayed-old-generation", shareSessionId: oldA }
    ]) a.handleServerMessage(JSON.stringify(message));
    assert.deepEqual({ A: canonical(docs.a.A.getText()), B: canonical(docs.a.B.getText()), ARevision: session(a, "A").revision, BRevision: session(a, "B").revision }, beforeStale);
    await assertDisk();
    console.log("PASS: close/re-share A retains B; delayed old-generation ACK/EDIT/CONFLICT ignored");

    pa.current().holdAckPath = "A.txt";
    expected.A = `A|${counts.A + 1}|a|withheld-ACK\n`;
    ea.type(docs.a.A, expected.A);
    counts.A += 1;
    await until(() => roomDoc("A")?.revision === counts.A && canonical(docs.b.A.getText()) === expected.A, "A accepted without ACK");
    await edit("B", "b", "A-ACK-withheld", true);
    await until(() => session(a, "A")?.status === "paused", "A paused after lost ACK");
    assert.equal(canonical(docs.a.A.getText()), expected.A, "A draft preserved");
    assertShared("B");
    assertServer("A");
    pa.current().releaseAcks();
    const pausedId = session(a, "A").shareSessionId;
    await a.shareDocumentForService(docs.a.A);
    await stable("A");
    counts.reshares += 1;
    assert.notEqual(session(a, "A").shareSessionId, pausedId);
    assert.equal(session(a, "B").shareSessionId, bId);
    assert.equal(editCount(pa, "A") + editCount(pb, "A"), counts.A);
    await assertDisk();
    console.log("PASS: withheld A ACK pauses A and preserves its draft while B advances; explicit A recovery converges");

    pa.current().close();
    await until(() => a.getDocumentSessions().length === 0, "disconnect clears both shares");
    await until(() => a.getState().roomId === roomId && pa.connections.length >= 2, "room reconnects", 10000);
    await delay(100);
    assert.deepEqual(a.getDocumentSessions(), [], "reconnect cannot auto-share A or B");
    assert.equal(pa.connections.at(-1).up.length, 0, "reconnect has no queued document opens");
    const opensAfterReconnect = pa.upstream.filter(value => value.type === "OPEN_DOCUMENT").length;
    await a.shareDocumentForService(docs.a.A);
    await stable("A");
    assert.deepEqual(a.getDocumentSessions().map(value => value.path), ["A.txt"], "B still requires explicit share");
    await a.shareDocumentForService(docs.a.B);
    await stable("B");
    assert.equal(pa.upstream.filter(value => value.type === "OPEN_DOCUMENT").length - opensAfterReconnect, 2, "exactly two explicit opens after reconnect");
    counts.reconnects += 1;
    counts.reshares += 2;
    await assertDisk();
    console.log("PASS: disconnect/reconnect clears both shares; each file requires one explicit re-share");

    let sequence = 0;
    while (performance.now() - started < requestedDuration) {
      if (sequence > 0 && sequence % 12 === 0) {
        const before = { A: counts.A, B: counts.B, editsA: editCount(pa, "A") + editCount(pb, "A"), editsB: editCount(pa, "B") + editCount(pb, "B") };
        const idleStart = performance.now();
        await delay(Math.min(10000, Math.max(0, requestedDuration - (idleStart - started))));
        counts.idlePeriods += 1;
        counts.idleMs += performance.now() - idleStart;
        assert.deepEqual({ A: counts.A, B: counts.B, editsA: editCount(pa, "A") + editCount(pb, "A"), editsB: editCount(pa, "B") + editCount(pb, "B") }, before, "idle must not generate edits");
        assertShared("A"); assertShared("B"); await assertDisk();
        if (performance.now() - started >= requestedDuration) break;
      }
      const file = sequence % 2 === 0 ? "A" : "B";
      const who = sequence % 4 < 2 ? "a" : "b";
      await edit(file, who, "soak");
      sequence += 1;
      if (sequence % 12 === 0) await assertDisk();
      const remaining = requestedDuration - (performance.now() - started);
      if (remaining > 0) await delay(Math.min(5000, remaining));
    }
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs >= requestedDuration, "soak elapsed for full requested wall time");
    assertShared("A"); assertShared("B"); await assertDisk();
    assert.deepEqual(pa.failures, []); assert.deepEqual(pb.failures, []);
    const summary = { elapsedMs: Math.round(elapsedMs), requiredMs: requestedDuration, edits: { A: counts.A, B: counts.B, total: counts.A + counts.B },
      idlePeriods: counts.idlePeriods, idleMs: Math.round(counts.idleMs), reshares: counts.reshares, reconnects: counts.reconnects,
      serverRevisions: { A: roomDoc("A").revision, B: roomDoc("B").revision }, duplicateEdits: 0, implicitSaves: 0, diskFilesUnchanged: 4 };
    await fs.writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(`PASS: ${requestedDuration < FULL_DURATION_MS ? "dry run" : "15-minute"} two-file soak ${JSON.stringify(summary)}`);
    console.log(`ARTIFACT: ${path.join(root, "summary.json")}`);
  } finally {
    clearInterval(heartbeat);
    for (const client of clients) client.dispose();
    for (const editor of editors) editor.dismissPrompts();
    for (const proxy of proxies) await proxy.close();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise(resolve => server.server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
