const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vscode = require("vscode");
const WebSocket = require("ws");
const { CodeMeshClient } = require("../dist/services/CodeMeshClient");
const { CodeMeshTreeProvider } = require("../dist/providers/CodeMeshTreeProvider");
const { CodeMeshStatusBar } = require("../dist/ui/CodeMeshStatusBar");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

exports.run = async () => {
  const passed = [];
  const server = new CollaborationServer(0); server.start();
  let client, tree, status, peer;
  const subscriptions = [];
  let error;
  try {
    await new Promise(resolve => server.server.once("listening", resolve));
    client = new CodeMeshClient({ serverUrl: `ws://127.0.0.1:${server.server.address().port}`,
      self: { memberId: "native", displayName: "Native" } });
    const quickPicks = [];
    const commandErrors = [];
    const commandFile = require.resolve("../dist/commands/registerCommands");
    const isolated = new Module(commandFile, module);
    isolated.filename = commandFile;
    isolated.paths = Module._nodeModulePaths(path.dirname(commandFile));
    const testVscode = { window: Object.create(vscode.window), commands: Object.create(vscode.commands), workspace: vscode.workspace };
    testVscode.window.showQuickPick = async (items, options) => {
      quickPicks.push({ items, options });
      if (options?.title === "End Sharing") return items.find(item => item.label === "B.txt");
      return undefined;
    };
    testVscode.window.showErrorMessage = message => { commandErrors.push(message); return Promise.resolve(undefined); };
    testVscode.commands.registerCommand = (id, callback) => vscode.commands.registerCommand(id.replace("codemesh.", "codemesh.nativeTwoFile."), callback);
    testVscode.commands.executeCommand = (id, ...args) => vscode.commands.executeCommand(id.startsWith("codemesh.")
      ? id.replace("codemesh.", "codemesh.nativeTwoFile.") : id, ...args);
    isolated.require = request => request === "vscode" ? testVscode : Module.prototype.require.call(isolated, request);
    isolated._compile(fsSync.readFileSync(commandFile, "utf8"), commandFile);
    isolated.exports.registerCommands({ subscriptions }, client);
    tree = new CodeMeshTreeProvider(client);
    status = new CodeMeshStatusBar(client);

    peer = new WebSocket(`ws://127.0.0.1:${server.server.address().port}`);
    const peerMessages = [];
    peer.on("message", raw => peerMessages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => { peer.once("open", resolve); peer.once("error", reject); });
    const take = async (type, path) => {
      await waitFor(() => peerMessages.some(message => message.type === type && (!path || message.documentPath === path)), `${type} ${path ?? ""}`);
      return peerMessages.splice(peerMessages.findIndex(message => message.type === type && (!path || message.documentPath === path)), 1)[0];
    };
    const send = message => peer.send(JSON.stringify(message));
    await client.createRoom(); await waitFor(() => client.getState().roomId, "room created");
    const roomId = client.getState().roomId;
    send({ type: "JOIN_ROOM", roomId, member: { memberId: "peer", displayName: "Peer" } });
    await take("ROOM_JOINED");
    const folder = vscode.workspace.workspaceFolders[0].uri;
    const files = {};
    for (const name of ["A.txt", "B.txt", "C.txt"]) {
      const uri = vscode.Uri.joinPath(folder, name);
      const initial = `${name[0]}0\n`;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(initial));
      files[name] = { uri, initial, document: await vscode.workspace.openTextDocument(uri) };
    }
    const show = (name, viewColumn) => vscode.window.showTextDocument(files[name].document, { preview: false, viewColumn });
    const command = (name, ...args) => vscode.commands.executeCommand(`codemesh.nativeTwoFile.${name}`, ...args);
    const share = async (name, column) => {
      await show(name, column);
      await command("shareFile");
      await waitFor(() => client.getDocumentSessions().find(session => session.path === name)?.status === "shared", `${name} shared`);
    };
    await share("A.txt", vscode.ViewColumn.One);
    await share("B.txt", vscode.ViewColumn.Two);
    const aId = client.getDocumentSessions().find(session => session.path === "A.txt").shareSessionId;
    const bId = client.getDocumentSessions().find(session => session.path === "B.txt").shareSessionId;
    await command("shareFile");
    assert.equal(client.getDocumentSessions().find(session => session.path === "B.txt").shareSessionId, bId);
    await show("C.txt", vscode.ViewColumn.Two);
    assert.equal(client.getDocumentSessions().length, 2, "tab switch cannot share C");
    await command("shareFile");
    assert.match(commandErrors.at(-1), /at most two files/i);
    assert.equal(client.getDocumentSessions().length, 2);
    const nodes = tree.getChildren();
    assert.ok(nodes.some(node => node.label === "A.txt" && node.description === "shared"));
    assert.ok(nodes.some(node => node.label === "B.txt" && node.description === "shared"));
    assert.match(status.item.text, /A\.txt \(shared\).*B\.txt \(shared\)/);
    await command("showActions");
    assert.ok(quickPicks.at(-1).items.some(item => item.label === "End Sharing: A.txt"));
    assert.ok(quickPicks.at(-1).items.some(item => item.label === "End Sharing: B.txt"));
    passed.push("native commands explicitly share A and B, reject C, show both named controls and never share on tab switch");

    for (const name of ["A.txt", "B.txt"]) {
      send({ type: "OPEN_DOCUMENT", roomId, documentPath: name, text: files[name].initial });
      await take("DOCUMENT_SYNC", name);
    }
    const editorA = await show("A.txt", vscode.ViewColumn.One);
    assert.ok(await editorA.edit(edit => edit.insert(files["A.txt"].document.positionAt(files["A.txt"].document.getText().length), "local A\n")));
    const aLocal = await take("DOCUMENT_EDIT", "A.txt");
    assert.equal(aLocal.text, "A0\nlocal A\n");
    const editorB = await show("B.txt", vscode.ViewColumn.Two);
    assert.ok(await editorB.edit(edit => edit.insert(files["B.txt"].document.positionAt(files["B.txt"].document.getText().length), "local B\n")));
    const bLocal = await take("DOCUMENT_EDIT", "B.txt");
    assert.equal(bLocal.text, "B0\nlocal B\n");
    await waitFor(() => client.getDocumentSessions().find(session => session.path === "A.txt")?.revision === aLocal.revision
      && client.getDocumentSessions().find(session => session.path === "B.txt")?.revision === bLocal.revision, "local ACKs");
    send({ type: "DOCUMENT_EDIT", roomId, documentPath: "A.txt", baseRevision: aLocal.revision, text: `${aLocal.text}remote A\n` });
    await take("DOCUMENT_ACK", "A.txt");
    send({ type: "DOCUMENT_EDIT", roomId, documentPath: "B.txt", baseRevision: bLocal.revision, text: `${bLocal.text}remote B\n` });
    await take("DOCUMENT_ACK", "B.txt");
    await waitFor(() => files["A.txt"].document.getText().endsWith("remote A\n")
      && files["B.txt"].document.getText().endsWith("remote B\n"), "both native editor buffers");
    assert.ok(files["A.txt"].document.isDirty && files["B.txt"].document.isDirty);
    for (const name of ["A.txt", "B.txt", "C.txt"])
      assert.equal((await vscode.workspace.fs.readFile(files[name].uri)).toString(), files[name].initial, `${name} disk unchanged`);
    passed.push("native A and B editors sync local and remote unsaved edits independently with unchanged disk contents");

    await command("endSharing");
    assert.equal(quickPicks.at(-1).options.title, "End Sharing");
    assert.deepEqual(quickPicks.at(-1).items.map(item => item.label).sort(), ["A.txt", "B.txt"]);
    assert.deepEqual(client.getDocumentSessions().map(session => session.path), ["A.txt"]);
    assert.equal(client.getDocumentSessions()[0].shareSessionId, aId);
    assert.ok(tree.getChildren().some(node => node.label === "A.txt" && node.description === "shared"));
    assert.doesNotMatch(status.item.text, /B\.txt/);
    assert.ok(await editorA.edit(edit => edit.insert(files["A.txt"].document.positionAt(files["A.txt"].document.getText().length), "still A\n")));
    await take("DOCUMENT_EDIT", "A.txt");
    await share("B.txt", vscode.ViewColumn.Two);
    assert.notEqual(client.getDocumentSessions().find(session => session.path === "B.txt").shareSessionId, bId);
    assert.equal(client.getDocumentSessions().find(session => session.path === "A.txt").shareSessionId, aId);
    for (const name of ["A.txt", "B.txt", "C.txt"])
      assert.equal((await vscode.workspace.fs.readFile(files[name].uri)).toString(), files[name].initial, `${name} remains unsaved`);
    passed.push("native named End Sharing removes B only; A continues and B requires explicit re-share without saves");
  } catch (caught) {
    error = caught?.stack ?? String(caught);
  } finally {
    for (const subscription of subscriptions) subscription.dispose?.();
    tree?.dispose(); status?.dispose(); client?.dispose(); peer?.terminate();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise(resolve => server.server.close(resolve));
    await fs.writeFile(process.env.CODEMESH_EDITOR_RESULT, JSON.stringify({ passed, error }, null, 2));
  }
};
