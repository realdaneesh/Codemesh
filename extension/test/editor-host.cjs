const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
const WebSocket = require("ws");
const { CodeMeshClient } = require("../dist/services/CodeMeshClient");
const { CodeMeshTreeProvider } = require("../dist/providers/CodeMeshTreeProvider");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for editor sync");
    await delay(10);
  }
}

exports.run = async () => {
  const passed = [];
  const diagnostics = [];
  const server = new CollaborationServer(0);
  server.start();
  const relay = new WebSocket.WebSocketServer({ port: 0 });
  const relayListening = new Promise((resolve) => relay.once("listening", resolve));
  const relayConnections = [];
  let dropNextAck = false;
  let droppedAcks = 0;
  let holdNextClientEdit = false;
  let heldClientEdit;
  const nativeClientEdits = [];
  let client;
  let peer;
  let ui;
  const subscriptions = [];
  let error;
  try {
    await new Promise((resolve) => server.server.once("listening", resolve));
    const url = `ws://127.0.0.1:${server.server.address().port}`;
    await relayListening;
    relay.on("connection", (front) => {
      const back = new WebSocket(url);
      const upstream = [];
      relayConnections.push({ front, back });
      front.on("message", (raw) => {
        if (JSON.parse(raw.toString()).type === 'DOCUMENT_EDIT') {
          nativeClientEdits.push(JSON.parse(raw.toString()));
          if (holdNextClientEdit) {
            holdNextClientEdit = false;
            heldClientEdit = { raw, back };
            return;
          }
        }
        if (back.readyState === WebSocket.OPEN) back.send(raw);
        else upstream.push(raw);
      });
      back.on("open", () => { for (const raw of upstream.splice(0)) back.send(raw); });
      back.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (dropNextAck && message.type === "DOCUMENT_ACK") {
          dropNextAck = false;
          droppedAcks += 1;
          return;
        }
        if (front.readyState === WebSocket.OPEN) front.send(raw);
      });
      front.on("close", () => back.terminate());
      back.on("close", () => front.terminate());
      front.on("error", () => back.terminate());
      back.on("error", () => front.terminate());
    });
    const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
    client = new CodeMeshClient({ serverUrl: relayUrl, documentAckTimeoutMs: 1000, self: { memberId: "editor", displayName: "Editor" } });
    // Alias only command IDs so the test client cannot replace the activated extension's commands.
    const Module = require("node:module");
    const commandFile = require.resolve("../dist/commands/registerCommands");
    const commandModule = new Module(commandFile, module);
    commandModule.require = (id) => id === "vscode" ? {
      ...vscode, commands: { ...vscode.commands, registerCommand: (id, callback) =>
        vscode.commands.registerCommand(id.replace("codemesh.", "codemesh.nativeTest."), callback) }
    } : require(id);
    commandModule._compile(require("node:fs").readFileSync(commandFile, "utf8"), commandFile);
    commandModule.exports.registerCommands({ subscriptions }, client);
    peer = new WebSocket(url);
    const messages = [];
    peer.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => { peer.once("open", resolve); peer.once("error", reject); });
    const take = async (type) => {
      await waitFor(() => messages.some((message) => message.type === type));
      return messages.splice(messages.findIndex((message) => message.type === type), 1)[0];
    };
    const send = (message) => peer.send(JSON.stringify(message));
    await client.createRoom();
    await waitFor(() => client.getState().roomId);
    const roomId = client.getState().roomId;
    send({ type: "JOIN_ROOM", roomId, member: { memberId: "peer", displayName: "Peer" } });
    const peerSessionId = (await take("ROOM_JOINED")).presenceSessionId;

    for (const eol of ["\n", "\r\n"]) {
      const documentPath = eol === "\n" ? "lf.txt" : "crlf.txt";
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, documentPath);
      const initial = ["first", "middle", "last"].join(eol);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(initial));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      await client.collaborateDocument(document);
      await waitFor(() => client.getState().documentStatus === "shared");
      send({ type: "OPEN_DOCUMENT", roomId, documentPath, text: initial });
      await take("DOCUMENT_SYNC");
      let revision = 0;
      const fingerprint = (text) => ({ length: text?.length, sha256: text === undefined ? undefined : createHash("sha256").update(text).digest("hex"),
        lf: text === undefined ? undefined : (text.match(/(?<!\r)\n/g) || []).length,
        crlf: text === undefined ? undefined : (text.match(/\r\n/g) || []).length });
      let localStep = "";
      const acceptLocal = async (expected) => {
        let message;
        try { message = await take("DOCUMENT_EDIT"); }
        catch (error) {
          const serverDocument = [...server.documents.values()].find((entry) => entry.clients.has(peer));
          const snapshot = { step: localStep, path: documentPath, expected: fingerprint(expected),
            editor: fingerprint(document.getText()), editorEol: document.eol, dirty: document.isDirty,
            activeEditor: vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString(),
            clientStatus: client.getState().documentStatus, clientError: client.getState().documentError,
            clientPath: client.getState().sharedDocumentPath, inFlight: client.documentEditInFlight,
            pending: fingerprint(client.pendingDocumentText), awaitingSync: client.awaitingDocumentSync,
            clientRevision: client.sharedDocumentRevision, peerRevision: revision,
            server: serverDocument && { revision: serverDocument.revision, text: fingerprint(serverDocument.text), clients: serverDocument.clients.size },
            peerMessages: messages.map(({ type, revision }) => ({ type, revision })) };
          diagnostics.push(snapshot);
          throw new Error(`${error.message}: ${JSON.stringify(snapshot)}`);
        }
        revision = message.revision;
        assert.deepEqual(fingerprint(message.text), fingerprint(expected.replace(/\r\n/g, "\n")), `${localStep}: peer edit fingerprint`);
        await waitFor(() => !client.documentEditInFlight);
      };

      assert.ok(await editor.edit((edit) => edit.insert(new vscode.Position(1, 0), `paste${eol}\u4e2d\u6587 \ud83d\ude80 e\u0301${eol}`)));
      const pasted = document.getText();
      await acceptLocal(pasted);
      assert.ok(await editor.edit((edit) => edit.delete(new vscode.Range(1, 0, 3, 0))));
      await acceptLocal(initial);
      assert.equal(document.getText(), initial);
      localStep = "undo local paste";
      await vscode.commands.executeCommand("undo");
      await acceptLocal(pasted);
      localStep = "redo local paste";
      await vscode.commands.executeCommand("redo");
      await acceptLocal(initial);
      passed.push(`${documentPath}: multiline paste, Unicode, deletion, local undo/redo sync`);

      editor.selection = new vscode.Selection(1, 2, 1, 2);
      send({ type: "DOCUMENT_EDIT", roomId, documentPath, baseRevision: revision, text: initial.replace(/\r\n/g, "\n") + "\nremote" });
      revision = (await take("DOCUMENT_ACK")).revision;
      await waitFor(() => document.getText() === initial + eol + "remote");
      // The document-change event can precede resolution of applyEdit and the
      // resulting undo-stack boundary. Keep that operation in this session.
      await client.remoteDocumentQueue;
      assert.equal(client.applyingRemoteDocumentPath, undefined);
      await delay(100);
      assert.equal(document.isDirty, true);
      assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial, "remote edit must not save");
      assert.equal(document.eol, eol === "\n" ? vscode.EndOfLine.LF : vscode.EndOfLine.CRLF);
      assert.deepEqual([editor.selection.active.line, editor.selection.active.character], [1, 2], "remote suffix must not move an unaffected cursor");
      assert.equal(messages.filter((message) => message.type === "DOCUMENT_EDIT").length, 0, "remote edit must not echo");

      client.stopDocumentCollaboration();
      await client.collaborateDocument(document);
      await waitFor(() => client.getState().documentStatus === "shared");
      passed.push(`${documentPath}: LF peer text retains editor EOL and re-share has no false conflict`);

      localStep = "undo remote suffix after reshare";
      await vscode.commands.executeCommand("undo");
      await acceptLocal(initial);
      assert.equal(document.getText(), initial, "remote change has its own undo step");
      localStep = "undo prior local edit";
      await vscode.commands.executeCommand("undo");
      await acceptLocal(pasted);
      assert.equal(document.getText(), pasted, "local history survives remote edits");
      await vscode.commands.executeCommand("redo");
      await acceptLocal(initial);
      await vscode.commands.executeCommand("redo");
      await acceptLocal(initial + eol + "remote");
      passed.push(`${documentPath}: remote dirty state, disk unchanged, EOL, cursor, no echo, separate undo step and local history`);
      if (process.env.CODEMESH_EDITOR_SCENARIO === "lf-undo") return;

      for (let index = 1; index <= 20; index += 1) {
        send({ type: "DOCUMENT_EDIT", roomId, documentPath, baseRevision: revision, text: `first\nmiddle\nlast\nrapid ${index}` });
        revision = (await take("DOCUMENT_ACK")).revision;
      }
      await waitFor(() => document.getText() === ["first", "middle", "last", "rapid 20"].join(eol));
      await delay(100);
      assert.equal(messages.filter((message) => message.type === "DOCUMENT_EDIT").length, 0);
      passed.push(`${documentPath}: 20 rapid remote edits deliver final text without echo`);

      const prefix = "x".repeat(256 * 1024 - 3);
      const started = Date.now();
      for (let index = 0; index < 12; index += 1) {
        const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        assert.ok(await editor.edit((edit) => edit.replace(range, prefix + String(index).padStart(3, "0"))));
      }
      const finalText = prefix + "011";
      await waitFor(() => messages.some((message) => message.type === "DOCUMENT_EDIT" && message.text === finalText));
      await waitFor(() => !client.documentEditInFlight && client.pendingDocumentText === undefined);
      const updates = messages.filter((message) => message.type === "DOCUMENT_EDIT");
      assert.equal(updates.at(-1).text, finalText);
      assert.equal(document.getText(), finalText);
      assert.equal(document.isDirty, true);
      assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial);
      passed.push(`${documentPath}: 12 edits at 256 KiB deliver final text (${updates.length} full-text messages, ${Date.now() - started} ms), disk unchanged`);
      messages.splice(0, messages.length);
      client.stopDocumentCollaboration();
      send({ type: "CLOSE_DOCUMENT", roomId, documentPath });
    }
    const cursorPath = "cursor-presence.txt";
    const cursorUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, cursorPath);
    await vscode.workspace.fs.writeFile(cursorUri, Buffer.from("native\ncontent"));
    const cursorDocument = await vscode.workspace.openTextDocument(cursorUri);
    const cursorEditor = await vscode.window.showTextDocument(cursorDocument, { preview: false });
    await client.collaborateDocument(cursorDocument);
    await waitFor(() => client.getState().documentStatus === "shared");
    send({ type: "OPEN_DOCUMENT", roomId, documentPath: cursorPath, text: "native\ncontent" });
    await take("DOCUMENT_SYNC");
    send({ type: "SET_SHARED_FILE", roomId, presenceSessionId: peerSessionId, sequence: 1, documentPath: cursorPath });
    await waitFor(() => messages.some((message) => message.type === "SHARED_FILES"
      && message.files.some((file) => file.memberId === "peer" && file.documentPath === cursorPath)));
    const peerShare = messages.find((message) => message.type === "SHARED_FILES"
      && message.files.some((file) => file.memberId === "peer" && file.documentPath === cursorPath))
      .files.find((file) => file.memberId === "peer").shareId;
    send({ type: "CURSOR_UPDATE", roomId, documentPath: cursorPath, presenceSessionId: peerSessionId,
      shareId: peerShare, sequence: 1, position: { line: 1, character: 3 } });
    await waitFor(() => client.remoteCursors.get("peer")?.position.character === 3);
    assert.equal(vscode.window.activeTextEditor.document, cursorDocument);
    assert.equal(cursorEditor.document.getText(), "native\ncontent");
    assert.equal(cursorDocument.isDirty, false);
    assert.equal((await vscode.workspace.fs.readFile(cursorUri)).toString(), "native\ncontent");
    assert.ok(client.cursorDecorations.get("peer"), "native VS Code decoration must be created");
    assert.equal(messages.filter((message) => message.type === "DOCUMENT_EDIT").length, 0);
    cursorEditor.selections = [new vscode.Selection(0, 1, 0, 4), new vscode.Selection(1, 0, 1, 3)];
    const outgoingSelection = await take("SELECTION_UPDATE");
    assert.deepEqual(outgoingSelection.ranges, [
      { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
      { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }
    ]);
    assert.equal(JSON.stringify(outgoingSelection).includes("native"), false);
    cursorEditor.selections = [new vscode.Selection(0, 0, 0, 0)];
    assert.deepEqual((await take("SELECTION_UPDATE")).ranges, []);
    assert.equal(cursorDocument.isDirty, false);
    passed.push("selection: native multi-selection sends two ranges; collapse sends empty ranges without editing or saving");
    send({ type: "SELECTION_UPDATE", roomId, documentPath: cursorPath, presenceSessionId: peerSessionId,
      shareId: peerShare, sequence: 1, documentRevision: 0,
      ranges: [
        { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
        { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }
      ] });
    await waitFor(() => client.remoteSelections.get("peer")?.ranges.length === 2 && client.selectionDecorations.has("peer"));
    assert.equal(cursorDocument.getText(), "native\ncontent");
    assert.equal(cursorDocument.isDirty, false);
    assert.equal((await vscode.workspace.fs.readFile(cursorUri)).toString(), "native\ncontent");
    send({ type: "SELECTION_UPDATE", roomId, documentPath: cursorPath, presenceSessionId: peerSessionId,
      shareId: peerShare, sequence: 2, documentRevision: 0, ranges: [] });
    await waitFor(() => client.remoteSelections.get("peer")?.ranges.length === 0 && !client.selectionDecorations.has("peer"));
    passed.push("selection: native decoration created for two peer ranges and removed on collapse; clean buffer and disk unchanged");
    send({ type: "TYPING_ACTIVITY", roomId, documentPath: cursorPath, presenceSessionId: peerSessionId,
      shareId: peerShare, sequence: 1, active: true });
    await waitFor(() => client.getState().typingMemberIds.includes("peer"));
    const tree = new CodeMeshTreeProvider(client);
    assert.ok(tree.getChildren().some((node) => node.label === "Peer"
      && node.description === `${cursorPath} | Recent edit`), "native sidebar model shows peer activity near path");
    send({ type: "TYPING_ACTIVITY", roomId, documentPath: cursorPath, presenceSessionId: peerSessionId,
      shareId: peerShare, sequence: 2, active: false });
    await waitFor(() => !client.getState().typingMemberIds.includes("peer"));
    tree.dispose();
    passed.push("typing: native sidebar model shows same-file peer activity and clears on stop");
    send({ type: "DOCUMENT_EDIT", roomId, documentPath: cursorPath, baseRevision: 0, text: "native\ncontent+" });
    const remoteTypingRevision = (await take("DOCUMENT_ACK")).revision;
    await waitFor(() => cursorDocument.getText() === "native\ncontent+");
    await delay(80);
    assert.equal(messages.some((message) => message.type === "TYPING_ACTIVITY"), false, "remote WorkspaceEdit is not user typing");
    assert.equal((await vscode.workspace.fs.readFile(cursorUri)).toString(), "native\ncontent", "presence never saves");
    messages.splice(0, messages.length);
    await vscode.env.clipboard.writeText("paste\nline\n");
    cursorEditor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    await waitFor(() => cursorDocument.getText().startsWith("paste\nline\n"));
    await take("DOCUMENT_EDIT");
    await delay(80);
    assert.equal(messages.some((message) => message.type === "TYPING_ACTIVITY"), false, "paste is not mislabeled as typing");
    cursorEditor.selection = new vscode.Selection(0, 0, 0, 5);
    await vscode.commands.executeCommand("deleteLeft");
    await waitFor(() => !cursorDocument.getText().startsWith("paste"));
    await take("DOCUMENT_EDIT");
    await delay(80);
    assert.equal(messages.some((message) => message.type === "TYPING_ACTIVITY"), false, "deletion is not mislabeled as typing");
    passed.push("typing: native paste and deletion edit the shared buffer without activity claims; IME composition is not exposed by the harness");
    const beforeTyping = cursorDocument.getText();
    await vscode.commands.executeCommand("type", { text: "!" });
    assert.equal(cursorDocument.getText().length, beforeTyping.length + 1, "type hook forwards exactly one character");
    const localTypingEdit = await take("DOCUMENT_EDIT");
    assert.equal(localTypingEdit.revision, remoteTypingRevision + 3);
    const localTypingActivity = await take("TYPING_ACTIVITY");
    assert.equal(localTypingActivity.active, true);
    assert.equal(localTypingActivity.documentPath, cursorPath);
    assert.equal(Object.hasOwn(localTypingActivity, "text"), false);
    assert.equal((await vscode.workspace.fs.readFile(cursorUri)).toString(), "native\ncontent");
    await waitFor(() => messages.some((message) => message.type === "TYPING_ACTIVITY" && message.active === false));
    passed.push("typing: direct type-command invocation produces edit activity, not a verified human-typing claim; disk unchanged");
    send({ type: "CLOSE_DOCUMENT", roomId, documentPath: cursorPath });
    await waitFor(() => client.cursorDecorations.size === 0 && client.selectionDecorations.size === 0);
    client.stopDocumentCollaboration();
    passed.push("cursor: native decoration created; cursor leaves clean buffer/disk unchanged and clears on peer close");
    const workspace = vscode.workspace.workspaceFolders[0];
    const source = vscode.Uri.joinPath(workspace.uri, "preview-source.txt");
    const sourceText = "preview \u4e2d\u6587 \ud83d\ude80\r\nsecond line";
    await vscode.workspace.fs.writeFile(source, Buffer.from(sourceText));
    const removedOnRefresh = vscode.Uri.joinPath(workspace.uri, "refresh-removed.txt");
    await vscode.workspace.fs.writeFile(removedOnRefresh, Buffer.from("remove on explicit refresh"));
    const directoryBefore = await vscode.workspace.fs.readDirectory(workspace.uri);
    ui = await require("./editor-ui.cjs").connect();
    const importVisible = "[...document.querySelectorAll('.editor-actions [aria-label], .editor-actions [title]')].some(e=>e.offsetWidth>0 && ((e.getAttribute('aria-label')||'')+(e.getAttribute('title')||'')).includes('Import Previewed File'))";
    assert.equal(await ui.evaluate(importVisible), false, "import action is absent before receiving a preview");
    await client.shareWorkspace(workspace);
    await waitFor(() => client.getState().ownsWorkspaceManifest && client.getState().workspaceManifestId);
    const preview = await client.requestFile("preview-source.txt");
    const previewEditor = vscode.window.activeTextEditor;
    assert.equal(previewEditor.document.uri.toString(), preview.toString());
    assert.equal(preview.scheme, "codemesh-preview");
    assert.equal(previewEditor.document.getText().replace(/\r\n/g, "\n"), sourceText.replace(/\r\n/g, "\n"));
    assert.equal(previewEditor.document.isDirty, false);
    const readonlyText = previewEditor.document.getText();
    await vscode.commands.executeCommand("type", { text: "must not edit" });
    assert.equal(previewEditor.document.getText(), readonlyText, "user typing cannot change a native readonly preview");
    assert.equal(previewEditor.document.isDirty, false);
    assert.equal((await vscode.workspace.fs.readFile(source)).toString(), sourceText);
    assert.deepEqual(await vscode.workspace.fs.readDirectory(workspace.uri), directoryBefore, "preview creates no local files");
    assert.equal(messages.filter((message) => message.type === "FILE_RESPONSE").length, 0, "content response is not broadcast to other room members");
    passed.push("explicit content preview: native readonly document, Unicode/CRLF, source unchanged, no file creation, requester-only response");
    await ui.wait(importVisible);
    passed.push("import: real editor toolbar action appears only after successful preview");

    const imported = vscode.Uri.joinPath(workspace.uri, "native-import.txt");
    const cancelled = vscode.commands.executeCommand("codemesh.nativeTest.importFile", preview);
    await ui.wait("[...document.querySelectorAll('.quick-input-widget input')].some(e=>e.offsetWidth>0 && e.value==='preview-source.txt')");
    await ui.input("native-import.txt");
    await ui.wait("[...document.querySelectorAll('.monaco-dialog-box')].some(e=>e.offsetWidth>0 && e.innerText.includes(" + JSON.stringify(imported.fsPath) + "))");
    await ui.choose("Cancel"); await cancelled;
    await assert.rejects(vscode.workspace.fs.stat(imported));
    assert.equal(client.getState().sharedDocumentPath, undefined);
    passed.push("import: published path default, exact destination in real confirmation, Cancel creates no file");

    const importing = vscode.commands.executeCommand("codemesh.nativeTest.importFile", preview);
    await ui.input("native-import.txt"); await ui.choose("Import"); await importing;
    assert.equal((await vscode.workspace.fs.readFile(imported)).toString(), sourceText);
    await vscode.commands.executeCommand("revealInExplorer", imported);
    await ui.wait("[...document.querySelectorAll('.sidebar .monaco-list-row')].some(e=>e.offsetWidth>0 && e.innerText.includes('native-import.txt'))");
    const importedDocument = await vscode.workspace.openTextDocument(imported);
    await vscode.window.showTextDocument(importedDocument);
    await ui.wait("!(" + importVisible + ")");
    assert.equal(importedDocument.isDirty, false);
    assert.equal(client.getState().sharedDocumentPath, undefined);
    assert.equal(client.getState().documentStatus, undefined);
    passed.push("import: real file appears in Explorer, toolbar hides on local file, imported file is clean and not live-shared");
    await vscode.window.showTextDocument(previewEditor.document);

    const existing = vscode.Uri.joinPath(workspace.uri, "existing-import.txt");
    await vscode.workspace.fs.writeFile(existing, Buffer.from("existing disk text"));
    const keepExisting = vscode.commands.executeCommand("codemesh.nativeTest.importFile", preview);
    await ui.input("existing-import.txt");
    await ui.wait("[...document.querySelectorAll('.monaco-dialog-box .monaco-button')].some(e=>e.offsetWidth>0 && e.innerText==='Overwrite')");
    await ui.choose("Cancel"); await keepExisting;
    assert.equal((await vscode.workspace.fs.readFile(existing)).toString(), "existing disk text");
    const overwrite = vscode.commands.executeCommand("codemesh.nativeTest.importFile", preview);
    await ui.input("existing-import.txt"); await ui.choose("Overwrite"); await overwrite;
    assert.equal((await vscode.workspace.fs.readFile(existing)).toString(), sourceText);
    passed.push("import: real existing-file dialog requires Overwrite; Cancel preserves original bytes");

    const dirtyDocument = await vscode.workspace.openTextDocument(existing);
    const dirtyEditor = await vscode.window.showTextDocument(dirtyDocument);
    assert.ok(await dirtyEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), "unsaved local draft\n")));
    const draft = dirtyDocument.getText();
    await vscode.window.showTextDocument(previewEditor.document);
    const blocked = vscode.commands.executeCommand("codemesh.nativeTest.importFile", preview);
    await ui.input("existing-import.txt"); await blocked;
    await ui.wait("document.body.innerText.includes('Destination has unsaved changes')");
    assert.equal(dirtyDocument.isDirty, true);
    assert.equal(dirtyDocument.getText(), draft);
    assert.equal((await vscode.workspace.fs.readFile(existing)).toString(), sourceText);
    assert.equal(client.getState().sharedDocumentPath, undefined);
    passed.push("import: real dirty-editor warning, unsaved draft and disk preserved, no live sharing");
    const beforeRefresh = client.getState().workspaceManifestId;
    const changedSource = sourceText.replace("second", "SECOND");
    const addedOnRefresh = vscode.Uri.joinPath(workspace.uri, "refresh-added.txt");
    await vscode.workspace.fs.writeFile(source, Buffer.from(changedSource));
    await vscode.workspace.fs.writeFile(addedOnRefresh, Buffer.from("new file"));
    await vscode.workspace.fs.delete(removedOnRefresh);
    assert.equal(client.getState().workspaceManifestId, beforeRefresh, "disk changes do not implicitly publish");
    await vscode.commands.executeCommand("codemesh.nativeTest.refreshWorkspace");
    await waitFor(() => client.getState().workspaceManifestId !== beforeRefresh && client.getState().workspaceChanges);
    const refreshed = client.getState().workspaceChanges;
    assert.deepEqual(refreshed, {
      added: ["existing-import.txt", "native-import.txt", "refresh-added.txt"],
      changed: ["preview-source.txt"], removed: ["refresh-removed.txt"]
    });
    await ui.wait("document.body.innerText.includes('CodeMesh workspace refreshed: 3 added, 1 changed, 1 removed')");
    await ui.wait("!(" + importVisible + ")");
    assert.equal(client.canImportPreview(preview), false);
    assert.equal(dirtyDocument.getText(), draft);
    assert.equal(dirtyDocument.isDirty, true);
    assert.equal((await vscode.workspace.fs.readFile(imported)).toString(), sourceText);
    assert.equal((await vscode.workspace.fs.readFile(existing)).toString(), sourceText);
    assert.equal(client.getState().sharedDocumentPath, undefined);
    const showChanges = vscode.commands.executeCommand("codemesh.nativeTest.workspaceChanges");
    await ui.wait("[...document.querySelectorAll('.quick-input-widget')].some(e=>e.offsetWidth>0 && e.innerText.includes('Shared Workspace Changes') && e.innerText.includes('refresh-added.txt') && e.innerText.includes('preview-source.txt') && e.innerText.includes('refresh-removed.txt') && e.innerText.includes('changed'))");
    await ui.cancelInput(); await showChanges;
    await client.requestFile("preview-source.txt");
    assert.equal(vscode.window.activeTextEditor.document.getText().replace(/\r\n/g, "\n"), changedSource.replace(/\r\n/g, "\n"));
    passed.push("refresh: real owner command, exact change summary/picker, same-size edit, stale import hidden, imported disk and dirty draft preserved, fresh request gets new text");
    client.stopWorkspaceSharing();
    await ui.wait("!(" + importVisible + ")");

    const stalledUri = vscode.Uri.joinPath(workspace.uri, "ack-timeout.txt");
    const stalledInitial = "native ACK timeout fixture";
    await vscode.workspace.fs.writeFile(stalledUri, Buffer.from(stalledInitial));
    const stalledDocument = await vscode.workspace.openTextDocument(stalledUri);
    const stalledEditor = await vscode.window.showTextDocument(stalledDocument, { preview: false });
    await client.collaborateDocument(stalledDocument);
    await waitFor(() => client.getState().documentStatus === "shared");
    send({ type: "OPEN_DOCUMENT", roomId, documentPath: "ack-timeout.txt", text: stalledInitial });
    await take("DOCUMENT_SYNC");
    dropNextAck = true;
    const preservedDraft = "native unsaved draft after lost ACK";
    assert.ok(await stalledEditor.edit((edit) => edit.replace(new vscode.Range(stalledDocument.positionAt(0), stalledDocument.positionAt(stalledDocument.getText().length)), preservedDraft)));
    const peerEdit = await take("DOCUMENT_EDIT");
    assert.equal(peerEdit.text, preservedDraft);
    await waitFor(() => client.getState().documentStatus === "paused");
    assert.equal(droppedAcks, 1);
    assert.equal(stalledDocument.getText(), preservedDraft);
    assert.equal(stalledDocument.isDirty, true);
    assert.equal((await vscode.workspace.fs.readFile(stalledUri)).toString(), stalledInitial);
    const pausedTree = new CodeMeshTreeProvider(client);
    assert.ok(pausedTree.getChildren().some((node) => node.label === "Live Sync"
      && node.description.includes("server did not confirm")), "native sidebar surfaces the paused cause");
    assert.equal(client.getState().sharedFiles.some((file) => file.memberId === "editor"), false);
    pausedTree.dispose();
    passed.push("sync: real editor lost-ACK timeout pauses live sync, clears shared-file presence, exposes reason and preserves dirty draft and disk");

    let conflictSaves = 0;
    subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => conflictSaves++));
    for (const ending of ['resolve', 'leave', 'disconnect']) {
      const conflictPath = `conflict-${ending}.txt`;
      const conflictUri = vscode.Uri.joinPath(workspace.uri, conflictPath);
      await vscode.workspace.fs.writeFile(conflictUri, Buffer.from('disk baseline'));
      const doc = await vscode.workspace.openTextDocument(conflictUri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      await editor.edit(edit => edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), 'My private unsaved draft 🚀'));
      send({ type: 'OPEN_DOCUMENT', roomId, documentPath: conflictPath, text: 'Room text one' });
      await take('DOCUMENT_SYNC');
      await client.collaborateDocument(doc);
      await waitFor(() => client.getState().documentStatus === 'conflict');
      await ui.choose('Inspect Differences');
      await ui.choose('Cancel');
      const comparison = client.conflict.comparison;
      const mineDoc = await vscode.workspace.openTextDocument(comparison.mine);
      const roomDoc = await vscode.workspace.openTextDocument(comparison.room);
      assert.equal(mineDoc.getText(), 'My private unsaved draft 🚀');
      assert.equal(roomDoc.getText(), 'Room text one');
      assert.equal(mineDoc.isDirty, false); assert.equal(roomDoc.isDirty, false);
      await vscode.window.showTextDocument(roomDoc);
      await vscode.commands.executeCommand('type', { text: 'forbidden edit' });
      assert.equal(roomDoc.getText(), 'Room text one');
      assert.equal(client.getState().documentStatus, 'conflict');
      passed.push(`conflict ${ending}: native readonly draft/room documents, canceled prompt preserves paused dirty draft`);

      if (ending === 'resolve') {
        send({ type: 'DOCUMENT_EDIT', roomId, documentPath: conflictPath, baseRevision: 0, text: 'Room text two' });
        await take('DOCUMENT_ACK');
        await ui.choose('Cancel');
        await waitFor(() => roomDoc.getText().includes('STALE'));
        assert.equal(doc.getText(), 'My private unsaved draft 🚀');
        assert.equal(client.conflict.requiresInspection, true);
        const inspection = client.inspectConflictDifferences();
        await inspection;
        await ui.choose('Use Room Text');
        await waitFor(() => doc.getText() === 'Room text two');
        passed.push('conflict: native open comparison marked STALE on room edit; fresh comparison and explicit Use Room Text');
      } else {
        if (ending === 'leave') client.leaveRoom();
        else relayConnections.at(-1).front.terminate();
        await waitFor(() => !client.getState().sharedDocumentPath);
        await waitFor(() => roomDoc.getText().includes('STALE'));
        assert.equal(doc.getText(), 'My private unsaved draft 🚀');
        await client.joinRoom(roomId);
        await waitFor(() => client.getState().roomId === roomId);
        passed.push(`conflict: native ${ending} while comparison open invalidates it and preserves draft`);
      }
      const comparisonTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === 'codemesh-conflict');
      assert.ok(comparisonTabs.length, 'native VS Code diff tab was opened');
      await vscode.window.tabGroups.close(comparisonTabs, true);
      assert.equal((await vscode.workspace.fs.readFile(conflictUri)).toString(), 'disk baseline');
      assert.equal(conflictSaves, 0);
    }
    passed.push('conflict: zero native save events and unchanged source disk across inspection, resolution, leave and disconnect');

    for (const scenario of ['approve LF', 'approve CRLF', 'reject', 'dismiss', 'stale revision', 'disconnect']) {
      const combinedPath = `combined-${scenario.replaceAll(' ', '-')}.txt`;
      const uri = vscode.Uri.joinPath(workspace.uri, combinedPath);
      const common = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
      const eol = scenario === 'approve CRLF' ? '\r\n' : '\n';
      const initial = common.replaceAll('\n', eol);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(initial));
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      await client.collaborateDocument(doc);
      await waitFor(() => client.getState().documentStatus === 'shared');
      send({ type: 'OPEN_DOCUMENT', roomId, documentPath: combinedPath, text: common });
      await take('DOCUMENT_SYNC');
      const before = nativeClientEdits.length;
      holdNextClientEdit = true;
      const mine = common.replace('alpha', 'mine 🚀').replaceAll('\n', eol);
      await editor.edit(edit => edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), mine));
      await waitFor(() => heldClientEdit);
      send({ type: 'DOCUMENT_EDIT', roomId, documentPath: combinedPath, baseRevision: 0, text: common.replace('epsilon', 'room 中文') });
      await take('DOCUMENT_ACK');
      await waitFor(() => client.getState().documentStatus === 'conflict');
      heldClientEdit.back.send(heldClientEdit.raw); heldClientEdit = undefined;
      await ui.choose('Preview Combined Text');
      await ui.choose('Cancel');
      const proposal = client.conflict.proposal;
      const left = await vscode.workspace.openTextDocument(proposal.mine);
      const right = await vscode.workspace.openTextDocument(proposal.room);
      assert.equal(left.getText().replaceAll('\r\n', '\n'), mine.replaceAll('\r\n', '\n'));
      const expected = common.replace('alpha', 'mine 🚀').replace('epsilon', 'room 中文');
      assert.equal(right.getText().replaceAll('\r\n', '\n'), expected);
      await vscode.window.showTextDocument(right);
      await vscode.commands.executeCommand('type', { text: 'must stay readonly' });
      assert.equal(right.getText().replaceAll('\r\n', '\n'), expected);
      assert.equal(doc.getText(), mine);
      assert.equal(nativeClientEdits.length, before + 1, 'preview/dismiss sends no proposal');

      const previewing = vscode.commands.executeCommand('codemesh.nativeTest.previewCombinedText');
      await ui.wait("[...document.querySelectorAll('.monaco-dialog-box')].some(e => e.offsetWidth > 0 && e.innerText.includes('Apply and Share Combined Text'))");
      if (scenario === 'stale revision') {
        send({ type: 'DOCUMENT_EDIT', roomId, documentPath: combinedPath, baseRevision: 1, text: common.replace('epsilon', 'room newer') });
        await take('DOCUMENT_ACK');
        await waitFor(() => client.conflict.revision === 2);
      }
      if (scenario === 'disconnect') {
        relayConnections.at(-1).front.terminate();
        await waitFor(() => !client.getState().sharedDocumentPath);
      }
      await ui.choose(scenario === 'reject' ? 'Reject Proposal' : scenario === 'dismiss' ? 'Cancel' : 'Apply and Share Combined Text');
      await previewing;
      if (scenario.startsWith('approve')) {
        await waitFor(() => client.getState().documentStatus === 'shared' && !client.documentEditInFlight);
        assert.equal(doc.getText(), expected.replaceAll('\n', eol));
        assert.equal(nativeClientEdits.length, before + 2);
      } else {
        assert.equal(doc.getText(), mine);
        assert.equal(nativeClientEdits.length, before + 1);
        if (scenario === 'stale revision') await ui.choose('Cancel');
        if (scenario === 'disconnect') {
          await client.joinRoom(roomId);
          await waitFor(() => client.getState().roomId === roomId);
        }
      }
      assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial);
      assert.equal(conflictSaves, 0);
      passed.push(`combined ${scenario}: native readonly proposal, explicit approval guard, correct buffer/send count, zero saves and unchanged disk`);
    }
  } catch (caught) {
    error = caught.stack || String(caught);
  } finally {
    ui?.close();
    for (const subscription of subscriptions) subscription.dispose();
    client?.dispose();
    peer?.terminate();
    for (const { front, back } of relayConnections) { front.terminate(); back.terminate(); }
    await new Promise((resolve) => relay.close(resolve));
    for (const socket of server.server.clients) socket.terminate();
    await new Promise((resolve) => server.server.close(resolve));
    await fs.writeFile(process.env.CODEMESH_EDITOR_RESULT, JSON.stringify({ passed, diagnostics, error }, null, 2));
  }
  if (error) throw new Error(error);
};
