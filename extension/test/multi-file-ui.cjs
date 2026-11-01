const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");
const { createEditor, createProxy, waitFor, listening, canonical } = require("./multi-file-sync.cjs");

function load(filename, vscode) {
  const resolved = require.resolve(filename);
  const isolated = new Module(resolved, module);
  isolated.filename = resolved;
  isolated.paths = Module._nodeModulePaths(path.dirname(resolved));
  isolated.require = request => request === "vscode" ? vscode : Module.prototype.require.call(isolated, request);
  isolated._compile(fsSync.readFileSync(resolved, "utf8"), resolved);
  return isolated.exports;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codemesh-stage3-ui-"));
  const server = new CollaborationServer(0); server.start(); await listening(server.server);
  const clients = [], editors = [], proxies = [], subscriptions = [];
  try {
    const target = `ws://127.0.0.1:${server.server.address().port}`;
    for (const [name, eol] of [["a", "\n"], ["b", "\r\n"]]) {
      const proxy = await createProxy(target);
      const editor = await createEditor(path.join(root, name), eol);
      const client = new editor.Client({ serverUrl: proxy.url, documentAckTimeoutMs: 250,
        self: { memberId: name, displayName: name } });
      proxies.push(proxy); editors.push(editor); clients.push(client);
      load("../dist/commands/registerCommands", editor.vscode).registerCommands({ subscriptions }, client);
    }
    const [a, b] = clients, [ea, eb] = editors, [pa] = proxies;
    const aA = await ea.open("A.txt", "A0"), aB = await ea.open("B.txt", "B0"), aC = await ea.open("C.txt", "C0");
    const bA = await eb.open("A.txt", "A0"), bB = await eb.open("B.txt", "B0");
    await a.createRoom(); await waitFor(() => a.getState().roomId, "room created");
    const roomId = a.getState().roomId;
    await b.joinRoom(roomId); await waitFor(() => b.getState().roomId === roomId, "joined");
    const share = async (editor, client, document) => {
      editor.show(document);
      await editor.vscode.commands.executeCommand("codemesh.shareFile");
      await waitFor(() => client.getDocumentSessions().find(session => session.path === document.documentPath)?.status === "shared",
        `share ${document.documentPath}`);
    };
    await share(ea, a, aA); await share(eb, b, bA);
    const firstId = a.getDocumentSessions()[0].shareSessionId;
    await ea.vscode.commands.executeCommand("codemesh.shareFile");
    assert.equal(a.getDocumentSessions()[0].shareSessionId, firstId, "duplicate command keeps one session");
    ea.show(aC);
    assert.equal(a.getDocumentSessions().length, 1, "switching tabs does not share C");
    await share(ea, a, aB); await share(eb, b, bB);
    assert.deepEqual(a.getDocumentSessions().map(session => session.path).sort(), ["A.txt", "B.txt"]);
    const tree = new (load("../dist/providers/CodeMeshTreeProvider", ea.vscode).CodeMeshTreeProvider)(a);
    const status = new (load("../dist/ui/CodeMeshStatusBar", ea.vscode).CodeMeshStatusBar)(a);
    const labels = tree.getChildren().map(node => `${node.label}: ${node.description ?? ""}`);
    assert.ok(labels.some(label => label.includes("A.txt: shared")));
    assert.ok(labels.some(label => label.includes("B.txt: shared")));
    assert.match(status.item.text, /A\.txt \(shared\).*B\.txt \(shared\)/);
    ea.show(aC); await ea.vscode.commands.executeCommand("codemesh.shareFile");
    assert.match(ea.errors.at(-1), /at most two files/i);
    assert.equal(a.getDocumentSessions().length, 2);
    assert.equal(pa.upstream.some(message => message.type === "OPEN_DOCUMENT" && message.documentPath === "C.txt"), false);
    console.log("PASS: explicit A then B commands, duplicate and third-path safety, two named sidebar/status states, no tab-share");

    ea.type(aA, "A from a"); await waitFor(() => canonical(bA.getText()) === "A from a", "A to b");
    eb.type(bB, "B from b"); await waitFor(() => canonical(aB.getText()) === "B from b", "B to a");
    eb.type(bA, "A from b"); await waitFor(() => canonical(aA.getText()) === "A from b", "A to a");
    ea.type(aB, "B from a"); await waitFor(() => canonical(bB.getText()) === "B from a", "B to b");
    assert.equal(a.getDocumentSessions().find(s => s.path === "A.txt").revision, 2);
    assert.equal(a.getDocumentSessions().find(s => s.path === "B.txt").revision, 2);
    console.log("PASS: two production clients edit both files in both directions with independent revisions");

    eb.show(bB);
    const bEditor = eb.vscode.window.activeTextEditor;
    const p0 = new eb.vscode.Position(0, 0), p1 = new eb.vscode.Position(0, 1);
    bEditor.selection = { start: p0, end: p1, active: p1 };
    bEditor.selections = [bEditor.selection];
    eb.selections.fire({ textEditor: bEditor });
    await waitFor(() => a.additionalPresence.get("B.txt")?.cursors.has("b")
      && a.additionalPresence.get("B.txt")?.selections.has("b"), "B cursor and selection");
    assert.equal(a.remoteCursors.has("b"), false, "B cursor cannot appear on A");
    await eb.vscode.commands.executeCommand("type", { text: "!" });
    await waitFor(() => a.getState().recentEditFiles.some(file => file.memberId === "b" && file.documentPath === "B.txt"), "B recent edit");
    assert.equal(a.getState().recentEditFiles.some(file => file.documentPath === "A.txt"), false);
    assert.ok(tree.getChildren().some(node => node.label === "b" && node.description.includes("B.txt | Recent edit")));
    console.log("PASS: cursor, selection and Recent edit stay on B and its share generation");

    b.stopAllDocumentCollaboration();
    await share(eb, b, bB);
    await share(eb, b, bA);
    const aEditor = eb.vscode.window.activeTextEditor;
    aEditor.selection = { start: p0, end: p1, active: p1 };
    aEditor.selections = [aEditor.selection];
    eb.selections.fire({ textEditor: aEditor });
    await waitFor(() => a.remoteCursors.has("b") && a.remoteSelections.has("b"), "primary A sees peer additional A");
    await eb.vscode.commands.executeCommand("type", { text: "!" });
    await waitFor(() => a.getState().typingMemberIds.includes("b"), "primary A Recent edit from additional A");
    assert.ok(tree.getChildren().some(node => node.label === "b" && node.description.includes("A.txt | Recent edit")));
    assert.equal(tree.getChildren().some(node => node.label === "b" && node.description.includes("B.txt | Recent edit")), false,
      "A typing cannot mark peer primary B");
    eb.show(bB);
    await waitFor(() => b.localCursorShareId && a.additionalPresence.get("B.txt")?.peers.has("b"), "B primary presence ready");
    eb.selections.fire({ textEditor: eb.vscode.window.activeTextEditor });
    await waitFor(() => a.additionalPresence.get("B.txt")?.cursors.has("b"), "additional B sees peer primary B");
    console.log("PASS: mixed primary/additional roles show cursor, selection and Recent edit on the matching file");

    pa.current().holdAckPath = "A.txt";
    ea.type(aA, "A unconfirmed");
    await waitFor(() => canonical(bA.getText()) === "A unconfirmed", "A remote accepted");
    eb.type(bB, "B continues");
    await waitFor(() => canonical(aB.getText()) === "B continues", "B while A delayed");
    await waitFor(() => a.getDocumentSessions().find(s => s.path === "A.txt")?.status === "paused", "A paused");
    pa.current().releaseAcks();
    assert.equal(a.getDocumentSessions().find(s => s.path === "B.txt")?.status, "shared");
    const beforeRoomA = b.getDocumentSessions().find(s => s.path === "A.txt").revision;
    eb.type(bA, "A room changed"); await waitFor(() => b.getDocumentSessions().find(s => s.path === "A.txt")?.revision === beforeRoomA + 1, "A room revision");
    ea.show(aA); await ea.vscode.commands.executeCommand("codemesh.shareFile");
    await waitFor(() => a.getDocumentSessions().find(s => s.path === "A.txt")?.status === "conflict", "A conflict");
    const oldPrompt = ea.prompts.find(prompt => !prompt.resolved && prompt.message.includes("A.txt"));
    assert.ok(oldPrompt);
    ea.nextQuickPick = item => item.label === "A.txt";
    await ea.vscode.commands.executeCommand("codemesh.endSharing");
    assert.deepEqual(a.getDocumentSessions().map(s => s.path), ["B.txt"]);
    assert.ok(a.additionalPresence.get("B.txt")?.cursors.has("b"), "B indicator survives A end");
    ea.show(aA); await ea.vscode.commands.executeCommand("codemesh.shareFile");
    await waitFor(() => a.getDocumentSessions().find(s => s.path === "A.txt")?.status === "conflict", "reopened A conflict");
    const reopened = a.getDocumentSessions().find(s => s.path === "A.txt").shareSessionId;
    oldPrompt.resolved = true; oldPrompt.resolve("Retry Mine");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(a.getDocumentSessions().find(s => s.path === "A.txt").status, "conflict", "old dialog cannot retry reopened A");
    assert.equal(a.getDocumentSessions().find(s => s.path === "A.txt").shareSessionId, reopened);
    assert.equal(a.getDocumentSessions().find(s => s.path === "B.txt").status, "shared");
    const bShare = a.getDocumentSessions().find(s => s.path === "B.txt").shareSessionId;
    a.handleServerMessage(JSON.stringify({ type: "CURSOR_UPDATE", roomId, documentPath: "B.txt",
      presenceSessionId: a.presenceSessionId, recipientShareSessionId: "00000000-0000-4000-8000-000000000000",
      memberId: "b", shareId: a.additionalPresence.get("B.txt").peers.get("b").values().next().value,
      sequence: 999, position: { line: 0, character: 0 } }));
    assert.notEqual(a.additionalPresence.get("B.txt").cursors.get("b")?.sequence, 999, "stale recipient generation rejected");
    assert.equal(a.getDocumentSessions().find(s => s.path === "B.txt").shareSessionId, bShare);
    console.log("PASS: A lost ACK and conflict preserve draft while B syncs; named end/reopen and stale dialog/frame leave B intact");

    ea.type(aB, "one\ntwo\nthree");
    await waitFor(() => canonical(bB.getText()) === "one\ntwo\nthree", "B base text");
    await waitFor(() => !a.additionalDocuments.get("B.txt").sent, "B base ACK");
    pa.current().holdUp = true;
    ea.type(aB, "local\ntwo\nthree");
    eb.type(bB, "one\ntwo\nremote");
    await waitFor(() => a.getDocumentSessions().find(s => s.path === "B.txt")?.status === "conflict", "B conflict");
    pa.current().releaseUp();
    await waitFor(() => pa.downstream.some(message => message.type === "DOCUMENT_CONFLICT" && message.documentPath === "B.txt"),
      "stale B edit rejected");
    const bConflict = a.additionalDocuments.get("B.txt").conflict;
    assert.equal(bConflict.baseText, "one\ntwo\nthree");
    await a.inspectConflictDifferences("B.txt");
    await a.inspectRecoveryVersions("B.txt");
    assert.ok(ea.comparisons.slice(-2).every(args => args[2].includes("B.txt")), "preserved versions use B path");
    const oldBPrompt = ea.prompts.find(prompt => !prompt.resolved && prompt.message.includes("B.txt"));
    assert.ok(oldBPrompt);
    const preview = a.previewCombinedText("B.txt");
    await waitFor(() => ea.prompts.some(prompt => !prompt.resolved && prompt.message.includes("Apply the combined proposal")), "B proposal approval");
    const approval = ea.prompts.find(prompt => !prompt.resolved && prompt.message.includes("Apply the combined proposal"));
    approval.resolved = true; approval.resolve("Apply and Share Combined Text");
    await preview;
    await waitFor(() => canonical(bB.getText()) === "local\ntwo\nremote", "B combined proposal shared");
    assert.equal(a.getDocumentSessions().find(s => s.path === "B.txt")?.status, "shared");
    oldBPrompt.resolved = true; oldBPrompt.resolve("End Sharing");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(a.getDocumentSessions().find(s => s.path === "B.txt")?.status, "shared", "old B dialog cannot end resolved B");
    assert.equal(a.getDocumentSessions().find(s => s.path === "A.txt")?.status, "conflict", "B action cannot alter A");
    console.log("PASS: B conflict, file-scoped comparisons and preserved versions, combined proposal, stale dialog, independent A state");

    await waitFor(() => !a.additionalDocuments.get("B.txt").sent, "B proposal ACK");
    pa.current().holdUp = true;
    ea.type(aB, "draft\ntwo\nremote");
    eb.type(bB, "local\ntwo\nlatest");
    await waitFor(() => a.getDocumentSessions().find(s => s.path === "B.txt")?.status === "conflict", "second B conflict");
    pa.current().releaseUp();
    await waitFor(() => pa.downstream.filter(message => message.type === "DOCUMENT_CONFLICT" && message.documentPath === "B.txt").length >= 2,
      "second B stale edit rejected");
    let finishProposal;
    ea.applyCompletion = new Promise(resolve => { finishProposal = resolve; });
    const delayedPreview = a.previewCombinedText("B.txt");
    await waitFor(() => ea.prompts.some(prompt => !prompt.resolved && prompt.message.includes("Apply the combined proposal")
      && prompt !== approval), "second B proposal approval");
    const secondApproval = ea.prompts.find(prompt => !prompt.resolved && prompt.message.includes("Apply the combined proposal"));
    secondApproval.resolved = true; secondApproval.resolve("Apply and Share Combined Text");
    await waitFor(() => canonical(aB.getText()) === "draft\ntwo\nlatest", "B proposal applied locally");
    eb.type(bB, "local\ntwo\nnewest");
    await waitFor(() => a.additionalDocuments.get("B.txt").conflict?.roomText === "local\ntwo\nnewest", "new B room revision during apply");
    finishProposal(true);
    await delayedPreview;
    const recovery = a.additionalDocuments.get("B.txt").recovery;
    assert.deepEqual([recovery.originalText, recovery.proposedText, recovery.roomText],
      ["draft\ntwo\nremote", "draft\ntwo\nlatest", "local\ntwo\nnewest"]);
    assert.equal(a.getDocumentSessions().find(s => s.path === "B.txt")?.status, "conflict");
    const beforeRecoveryDiffs = ea.comparisons.length;
    await a.inspectRecoveryVersions("B.txt");
    assert.equal(ea.comparisons.length, beforeRecoveryDiffs + 2, "B recovery compares all three preserved versions");
    assert.ok(ea.comparisons.slice(-2).every(args => args[2].includes("B.txt")));
    assert.equal(a.getDocumentSessions().find(s => s.path === "A.txt")?.status, "conflict");
    console.log("PASS: stale B proposal during apply preserves original, unshared proposal and latest room text without changing A");

    const currentBConflict = a.additionalDocuments.get("B.txt").conflict;
    const recoveryPrompt = ea.prompts.find(prompt => !prompt.resolved && prompt.message.includes("original draft, proposed text")
      && prompt.message.includes("B.txt"));
    assert.ok(recoveryPrompt, "B receives a file-named recovery prompt");
    recoveryPrompt.resolved = true; recoveryPrompt.resolve("Start Fresh Comparison");
    await waitFor(() => currentBConflict.recovery.reviewed, "B recovery comparison reviewed");
    await a.additionalDocuments.get("B.txt").useRoomText(currentBConflict);
    await waitFor(() => a.getDocumentSessions().find(s => s.path === "B.txt")?.status === "shared"
      && canonical(aB.getText()) === "local\ntwo\nnewest", "B recovery uses room text");
    pa.current().holdUp = true;
    ea.type(aB, "mine\ntwo\nnewest");
    eb.type(bB, "local\ntwo\npeer");
    await waitFor(() => a.getDocumentSessions().find(s => s.path === "B.txt")?.status === "conflict", "third B conflict");
    pa.current().releaseUp();
    await waitFor(() => pa.downstream.filter(message => message.type === "DOCUMENT_CONFLICT" && message.documentPath === "B.txt").length >= 3,
      "third B stale edit rejected");
    pa.current().holdAckPath = "B.txt";
    const unconfirmedPreview = a.previewCombinedText("B.txt");
    await waitFor(() => ea.prompts.some(prompt => !prompt.resolved && prompt.message.includes("Apply the combined proposal")
      && prompt !== approval && prompt !== secondApproval), "unconfirmed B proposal approval");
    const thirdApproval = ea.prompts.find(prompt => !prompt.resolved && prompt.message.includes("Apply the combined proposal"));
    thirdApproval.resolved = true; thirdApproval.resolve("Apply and Share Combined Text");
    await unconfirmedPreview;
    await waitFor(() => canonical(bB.getText()) === "mine\ntwo\npeer", "B proposal accepted without ACK");
    await waitFor(() => a.getDocumentSessions().find(s => s.path === "B.txt")?.status === "paused", "B unconfirmed proposal paused");
    assert.equal(a.additionalDocuments.get("B.txt").recovery?.delivery, "unconfirmed");
    const oldBSession = a.getDocumentSessions().find(s => s.path === "B.txt").shareSessionId;
    pa.current().releaseAcks();
    ea.show(aB); await ea.vscode.commands.executeCommand("codemesh.shareFile");
    await waitFor(() => a.getDocumentSessions().find(s => s.path === "B.txt")?.status === "shared", "B explicit re-share");
    assert.notEqual(a.getDocumentSessions().find(s => s.path === "B.txt").shareSessionId, oldBSession);
    assert.equal(a.additionalDocuments.get("B.txt").recovery?.delivery, "confirmed");
    assert.equal(a.additionalDocuments.get("B.txt").recovery?.originalText, "mine\ntwo\nnewest");
    const beforeConfirmedDiffs = ea.comparisons.length;
    await a.inspectRecoveryVersions("B.txt");
    assert.equal(ea.comparisons.length, beforeConfirmedDiffs + 2);
    assert.ok(ea.comparisons.slice(-2).every(args => args[2].includes("Confirmed proposal")));
    console.log("PASS: lost proposal ACK preserves B versions across explicit re-share and confirms room result without affecting A");

    await ea.assertUnsaved(); await eb.assertUnsaved();
    tree.dispose(); status.dispose();
    console.log("PASS: two-file workflow makes zero saves and leaves disk contents unchanged");
  } finally {
    for (const subscription of subscriptions) subscription.dispose?.();
    for (const client of clients) client.dispose();
    for (const editor of editors) editor.dismissPrompts();
    for (const proxy of proxies) await proxy.close();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise(resolve => server.server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
