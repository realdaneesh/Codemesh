const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const vscode = require("vscode");
const { ExperimentalServer, ExperimentalClient } = require("../dist/transport");
const { TestEditorBinding } = require("../dist/binding");
const { registerPrototypeUndoCommands, UNDO_LOCAL_COMMAND, REDO_LOCAL_COMMAND } = require("../dist/undoCommands");
const { PrototypePauseFlow } = require("../dist/pauseFlow");
const { protocol, waitFor } = require("./helpers.cjs");
const canonical = (text) => text.replace(/\r\n/g, "\n");
const controlledOrigin = (document) => {
  const tagged = new WeakMap(), applied = [];
  let activeOrigin;
  const listener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (activeOrigin && event.document === document) tagged.set(event, activeOrigin);
  });
  return {
    applied,
    adapter: {
      applyEdit: async (edit, token) => {
        applied.push(edit);
        activeOrigin = token;
        try { return await vscode.workspace.applyEdit(edit); }
        finally { activeOrigin = undefined; }
      },
      isOwnEdit: (event, token) => tagged.get(event) === token
    },
    dispose: () => listener.dispose()
  };
};

exports.run = async () => {
  const passed = [], clients = [], bindings = [];
  const sharedBindings = new Map();
  const historyCommands = registerPrototypeUndoCommands(vscode, sharedBindings);
  const server = new ExperimentalServer(protocol);
  let error;
  try {
    const url = await server.listening();
    for (const eol of ["\n", "\r\n"]) {
      const name = eol === "\n" ? "crdt-lf.txt" : "crdt-crlf.txt";
      const roomId = eol === "\n" ? "ABC234" : "DEF567";
      const initial = ["first", "middle", "last"].join(eol);
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, name);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(initial));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const grant = server.createRoom(roomId, name, canonical(initial));
      const a = new ExperimentalClient(protocol), b = new ExperimentalClient(protocol); clients.push(a, b);
      await a.connect(url, grant.ownerToken, roomId, name); await b.connect(url, grant.memberToken, roomId, name);
      const warnings = [];
      const origin = controlledOrigin(document);
      const binding = new TestEditorBinding(vscode, document, a.model, (message) => warnings.push(message), origin.adapter); bindings.push(binding);
      sharedBindings.set(document, binding);
      const converge = async () => {
        await waitFor(() => b.model.getText() === canonical(document.getText()));
        await binding.settled(); assert.equal(binding.getStatus().status, "active"); assert.deepEqual(warnings, []);
        assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial, "binding never saves the file");
      };
      assert.ok(await editor.edit((edit) => edit.insert(new vscode.Position(1, 0), "paste" + eol + "\u4e2d\u6587 \ud83d\ude80 e\u0301" + eol)));
      const pasted = document.getText(); await converge();
      passed.push(name + ": real TextDocument multiline paste and Unicode over binary WebSocket updates, disk unchanged");
      assert.ok(await editor.edit((edit) => edit.delete(new vscode.Range(1, 0, 3, 0)))); await converge(); assert.equal(document.getText(), initial);
      assert.ok(await vscode.commands.executeCommand(UNDO_LOCAL_COMMAND)); await converge(); assert.equal(document.getText(), pasted);
      assert.ok(await vscode.commands.executeCommand(REDO_LOCAL_COMMAND)); await converge(); assert.equal(document.getText(), initial);
      passed.push(name + ": native deletion and explicit CRDT undo/redo update Y.Text and peer without saving");

      editor.selection = new vscode.Selection(1, 1, 1, 1);
      const sent = a.sentUpdates;
      b.insert(b.model.getText().length, "\nremote \ud83d\ude80");
      await waitFor(() => canonical(document.getText()) === canonical(initial) + "\nremote \ud83d\ude80");
      await binding.settled();
      assert.equal(a.sentUpdates, sent, "remote editor edit never echoes");
      assert.equal(document.eol, eol === "\n" ? vscode.EndOfLine.LF : vscode.EndOfLine.CRLF);
      assert.equal(document.isDirty, true);
      assert.deepEqual([editor.selection.active.line, editor.selection.active.character], [1, 1]);
      assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial);
      passed.push(name + ": remote CRDT apply is dirty, preserves EOL and unaffected cursor, no echo or save");

      const withRemote = document.getText();
      assert.ok(await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "own "))); await converge();
      assert.ok(await vscode.commands.executeCommand(UNDO_LOCAL_COMMAND)); await converge(); assert.equal(document.getText(), withRemote, "latest local undo keeps peer suffix");
      assert.ok(await vscode.commands.executeCommand(REDO_LOCAL_COMMAND)); await converge(); assert.equal(document.getText(), "own " + withRemote);
      passed.push(name + ": latest explicit local undo/redo preserves concurrent peer text");

      b.insert(b.model.getText().length, "\npeer after own edit");
      await waitFor(() => a.model.getText() === b.model.getText() && canonical(document.getText()) === b.model.getText());
      await binding.settled();
      const beforeCrdtUndo = document.getText();
      assert.equal(vscode.window.activeTextEditor?.document, document, "prototype command requires the shared editor to be active");
      assert.equal(a.model.canUndo(), true, "native edit should have created a local Yjs undo step");
      assert.ok(await vscode.commands.executeCommand(UNDO_LOCAL_COMMAND));
      await waitFor(() => b.model.getText() === canonical(document.getText())); await binding.settled();
      assert.equal(document.getText(), beforeCrdtUndo.replace(/^own /, ""), "CRDT undo keeps the peer suffix");
      assert.ok(await vscode.commands.executeCommand(REDO_LOCAL_COMMAND));
      await waitFor(() => b.model.getText() === canonical(document.getText())); await binding.settled();
      assert.equal(document.getText(), beforeCrdtUndo);
      assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial);
      passed.push(name + ": explicit active-editor CRDT commands keep peer text and disk unchanged");

      const ordinaryUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, name + ".ordinary");
      await vscode.workspace.fs.writeFile(ordinaryUri, Buffer.from("ordinary draft"));
      const ordinary = await vscode.workspace.openTextDocument(ordinaryUri);
      await vscode.window.showTextDocument(ordinary, { preview: false });
      assert.equal(await vscode.commands.executeCommand(UNDO_LOCAL_COMMAND), false);
      assert.equal(await vscode.commands.executeCommand(REDO_LOCAL_COMMAND), false);
      assert.equal(ordinary.getText(), "ordinary draft");
      const sharedEditor = await vscode.window.showTextDocument(document, { preview: false });
      passed.push(name + ": prototype history commands ignore an ordinary active editor");

      sharedEditor.selections = [new vscode.Selection(0, 0, 0, 0), new vscode.Selection(1, 0, 1, 0)];
      const beforeMulti = document.getText();
      assert.ok(await sharedEditor.edit((edit) => { for (const selection of sharedEditor.selections) edit.insert(selection.active, "M"); }));
      const multiText = document.getText(); await converge();
      b.insert(b.model.getText().length, "\npeer after multi");
      await waitFor(() => canonical(document.getText()) === b.model.getText()); await binding.settled();
      assert.ok(await vscode.commands.executeCommand(UNDO_LOCAL_COMMAND)); await converge();
      assert.equal(canonical(document.getText()), canonical(beforeMulti) + "\npeer after multi");
      assert.ok(await vscode.commands.executeCommand(REDO_LOCAL_COMMAND)); await converge();
      assert.equal(canonical(document.getText()), canonical(multiText) + "\npeer after multi");
      passed.push(name + ": two-cursor transaction undoes once while retaining later peer text");

      assert.ok(await sharedEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), "1"))); await converge();
      assert.ok(await sharedEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), "2"))); await converge();
      const afterTwo = document.getText();
      assert.ok(await vscode.commands.executeCommand(UNDO_LOCAL_COMMAND)); await converge();
      assert.ok(await vscode.commands.executeCommand(UNDO_LOCAL_COMMAND)); await converge();
      assert.ok(await vscode.commands.executeCommand(REDO_LOCAL_COMMAND)); await converge();
      assert.ok(await vscode.commands.executeCommand(REDO_LOCAL_COMMAND)); await converge();
      assert.equal(document.getText(), afterTwo);
      passed.push(name + ": consecutive explicit local undo/redo returns to the same dirty buffer");

      sharedBindings.delete(document); binding.dispose(); origin.dispose();
      let release, applications = 0;
      const gatedWorkspace = {
        getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri),
        asRelativePath: (uri, includeWorkspaceFolder) => vscode.workspace.asRelativePath(uri, includeWorkspaceFolder),
        onDidChangeTextDocument: (listener) => vscode.workspace.onDidChangeTextDocument(listener),
        onDidCloseTextDocument: (listener) => vscode.workspace.onDidCloseTextDocument(listener),
        applyEdit: async (edit) => { applications += 1; await gate; return vscode.workspace.applyEdit(edit); }
      };
      const resolveWithTaggedApply = async (current) => {
        current.dispose();
        const tagged = controlledOrigin(document);
        const resolver = new TestEditorBinding(vscode, document, a.model, undefined, tagged.adapter); bindings.push(resolver);
        if (resolver.getStatus().status === "paused") await resolver.useRoomText();
        assert.equal(resolver.getStatus().status, "active");
        assert.equal(canonical(document.getText()), a.model.getText());
        resolver.dispose(); tagged.dispose();
      };
      let gate = new Promise((resolve) => { release = resolve; });
      let race = new TestEditorBinding({ workspace: gatedWorkspace, WorkspaceEdit: vscode.WorkspaceEdit, Range: vscode.Range }, document, a.model); bindings.push(race);
      const sentBeforeRace = a.sentUpdates;
      b.insert(b.model.getText().length, "\nremote race");
      await waitFor(() => applications === 1);
      assert.ok(await sharedEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), "local draft ")));
      const draft = document.getText();
      assert.equal(race.getStatus().status, "paused");
      release(); await race.settled();
      assert.equal(document.getText(), draft, "pending remote patch must restore native local draft");
      assert.equal(race.getStatus().draft, draft);
      assert.equal(a.sentUpdates, sentBeforeRace, "paused local typing does not echo");
      await race.useRoomText();
      assert.equal(race.getStatus().status, "paused", "untagged native resolution must not guess edit origin");
      assert.equal(race.getStatus().draft, draft);
      await resolveWithTaggedApply(race);
      assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial);
      passed.push(name + ": pending remote apply preserves draft; untagged choice pauses, tagged explicit rebind resolves");

      gate = new Promise((resolve) => { release = resolve; });
      race = new TestEditorBinding({ workspace: gatedWorkspace, WorkspaceEdit: vscode.WorkspaceEdit, Range: vscode.Range }, document, a.model); bindings.push(race);
      const beforeIdenticalApply = applications;
      b.insert(b.model.getText().length, "X");
      await waitFor(() => applications === beforeIdenticalApply + 1);
      assert.ok(await sharedEditor.edit((edit) => edit.insert(document.positionAt(document.getText().length), "X")));
      const identicalDraft = document.getText();
      assert.equal(race.getStatus().status, "paused");
      release(); await race.settled();
      assert.equal(document.getText(), identicalDraft);
      assert.equal(race.getStatus().draft, identicalDraft);
      assert.equal(a.sentUpdates, sentBeforeRace, "ambiguous native event never publishes a local update");
      await race.useRoomText();
      assert.equal(race.getStatus().draft, identicalDraft);
      if (race.getStatus().status === "paused") await resolveWithTaggedApply(race);
      else {
        assert.equal(race.getStatus().status, "active");
        assert.equal(canonical(document.getText()), a.model.getText());
        race.dispose();
      }
      passed.push(name + ": identical native typing during pending remote apply pauses with draft intact and no echo");

      gate = new Promise((resolve) => { release = resolve; });
      race = new TestEditorBinding({ workspace: gatedWorkspace, WorkspaceEdit: vscode.WorkspaceEdit, Range: vscode.Range }, document, a.model); bindings.push(race);
      const beforeExtensionApply = applications, beforeExtensionSend = a.sentUpdates;
      b.insert(b.model.getText().length, "E");
      await waitFor(() => applications === beforeExtensionApply + 1);
      const externalEdit = new vscode.WorkspaceEdit();
      externalEdit.insert(uri, document.positionAt(document.getText().length), "E");
      const reasons = [];
      const reasonListener = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document === document) reasons.push(event.reason); });
      assert.ok(await vscode.workspace.applyEdit(externalEdit));
      reasonListener.dispose();
      const extensionDraft = document.getText();
      assert.equal(reasons.at(-1), undefined, "extension WorkspaceEdit has no public origin reason");
      assert.equal(race.getStatus().status, "paused");
      release(); await race.settled();
      assert.equal(document.getText(), extensionDraft);
      assert.equal(race.getStatus().draft, extensionDraft);
      assert.equal(a.sentUpdates, beforeExtensionSend);
      assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial);
      await resolveWithTaggedApply(race);
      passed.push(name + ": same-text extension WorkspaceEdit during remote apply has unknown origin; draft pauses without echo/save");

      gate = new Promise((resolve) => { release = resolve; });
      race = new TestEditorBinding({ workspace: gatedWorkspace, WorkspaceEdit: vscode.WorkspaceEdit, Range: vscode.Range }, document, a.model); bindings.push(race);
      const formatter = vscode.languages.registerDocumentFormattingEditProvider({ scheme: "file", language: document.languageId }, {
        provideDocumentFormattingEdits: () => [vscode.TextEdit.insert(new vscode.Position(0, 0), "fmt ")]
      });
      const beforeFormatApply = applications, beforeFormatSend = a.sentUpdates;
      b.insert(b.model.getText().length, " remote format");
      await waitFor(() => applications === beforeFormatApply + 1);
      await vscode.commands.executeCommand("editor.action.formatDocument");
      formatter.dispose();
      const formatDraft = document.getText();
      assert.ok(formatDraft.startsWith("fmt "), "native format action must change the editor");
      assert.equal(race.getStatus().status, "paused");
      release(); await race.settled();
      assert.equal(document.getText(), formatDraft);
      assert.equal(race.getStatus().draft, formatDraft);
      assert.equal(a.sentUpdates, beforeFormatSend);
      assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial);
      await resolveWithTaggedApply(race);
      passed.push(name + ": native formatting during remote apply pauses and retains unsaved draft without echo");

      gate = new Promise((resolve) => { release = resolve; });
      race = new TestEditorBinding({ workspace: gatedWorkspace, WorkspaceEdit: vscode.WorkspaceEdit, Range: vscode.Range }, document, a.model); bindings.push(race);
      const beforeLateApply = applications;
      b.insert(b.model.getText().length, "\nlate patch");
      await waitFor(() => applications === beforeLateApply + 1);
      race.dispose();
      assert.ok(await sharedEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), "offline ")));
      const offline = document.getText();
      release(); await race.settled();
      assert.ok(race.getStatus().draftCandidates.includes(offline), "offline native draft must survive an ambiguous delayed apply");
      assert.ok(document.getText() === offline || document.getText().includes("late patch"));
      assert.equal(race.getStatus().listenerCount, 0);
      assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial);
      passed.push(name + ": pending native edit after disposal retains offline draft snapshot and leaves disk unchanged");

      const beforeEnd = document.getText(); assert.equal(binding.getStatus().listenerCount, 0);
      b.insert(0, "after binding end "); await waitFor(() => a.model.getText() === b.model.getText());
      assert.equal(document.getText(), beforeEnd, "disposed binding cannot change the editor");
      a.disconnect(); b.disconnect(); await waitFor(() => !server.getStatus(roomId).active);
      passed.push(name + ": binding disposal removes listeners and last disconnect clears experimental document state");
    }
    for (const eol of ["\n", "\r\n"]) {
      const name = eol === "\n" ? "crdt-layout-lf.txt" : "crdt-layout-crlf.txt";
      const roomId = eol === "\n" ? "GHJ567" : "KLM789";
      const lines = Array.from({ length: 80 }, (_, index) => "line " + index + " unchanged text");
      lines[20] = "line 20 TAG left"; lines[60] = "line 60 TAG right";
      const initial = lines.join(eol), normalized = canonical(initial);
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, name);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(initial));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const grant = server.createRoom(roomId, name, normalized);
      const a = new ExperimentalClient(protocol), b = new ExperimentalClient(protocol); clients.push(a, b);
      await a.connect(url, grant.ownerToken, roomId, name); await b.connect(url, grant.memberToken, roomId, name);
      const origin = controlledOrigin(document);
      const binding = new TestEditorBinding(vscode, document, a.model, undefined, origin.adapter); bindings.push(binding);
      editor.selections = [10, 40, 70].map((line) => new vscode.Selection(line, 2, line, 2));
      editor.revealRange(new vscode.Range(35, 0, 35, 0), vscode.TextEditorRevealType.AtTop);
      await waitFor(() => editor.visibleRanges.length && editor.visibleRanges[0].start.line >= 30);
      const scrollLine = editor.visibleRanges[0].start.line;
      const beforeMiddle = document.lineAt(40).text;
      const sent = a.sentUpdates;
      b.model.replaceBatch([
        { offset: normalized.indexOf("TAG"), count: 3, text: "\ud83d\ude80" },
        { offset: normalized.lastIndexOf("TAG"), count: 3, text: "\u4e2d\u6587" }
      ]);
      await waitFor(() => canonical(document.getText()) === b.model.getText()); await binding.settled();
      assert.equal(binding.getStatus().status, "active");
      assert.equal(origin.applied.length, 1);
      const edits = origin.applied[0].entries()[0][1];
      assert.deepEqual(edits.map((edit) => edit.range.start.line), [20, 60]);
      assert.deepEqual(editor.selections.map((selection) => [selection.anchor.line, selection.anchor.character, selection.active.line, selection.active.character]),
        [[10, 2, 10, 2], [40, 2, 40, 2], [70, 2, 70, 2]]);
      assert.equal(document.lineAt(40).text, beforeMiddle);
      assert.equal(editor.visibleRanges[0].start.line, scrollLine, "remote patches must not jump the viewport");
      assert.equal(a.sentUpdates, sent); assert.equal(document.isDirty, true);
      assert.equal(document.eol, eol === "\n" ? vscode.EndOfLine.LF : vscode.EndOfLine.CRLF);
      assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), initial);
      passed.push(name + ": disjoint native edits preserve three selections, intervening text and scroll without save/echo");
      origin.dispose(); binding.dispose(); a.disconnect(); b.disconnect();
      await waitFor(() => !server.getStatus(roomId).active);
    }
    const historyName = "crdt-native-history.txt";
    const historyUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, historyName);
    await vscode.workspace.fs.writeFile(historyUri, Buffer.from("native stack base"));
    const historyDocument = await vscode.workspace.openTextDocument(historyUri);
    await vscode.window.showTextDocument(historyDocument, { preview: false });
    const historyGrant = server.createRoom("MNP234", historyName, "native stack base");
    const historyA = new ExperimentalClient(protocol), historyB = new ExperimentalClient(protocol); clients.push(historyA, historyB);
    await historyA.connect(url, historyGrant.ownerToken, "MNP234", historyName);
    await historyB.connect(url, historyGrant.memberToken, "MNP234", historyName);
    const historyOrigin = controlledOrigin(historyDocument);
    const historyBinding = new TestEditorBinding(vscode, historyDocument, historyA.model, undefined, historyOrigin.adapter); bindings.push(historyBinding);
    sharedBindings.set(historyDocument, historyBinding);
    historyB.insert(historyB.model.getText().length, " peer");
    await waitFor(() => historyDocument.getText() === "native stack base peer"); await historyBinding.settled();
    const beforeNativeUndo = historyA.sentUpdates;
    await vscode.commands.executeCommand("undo"); await historyBinding.settled();
    const nativeResult = historyDocument.getText();
    assert.ok(nativeResult === "native stack base peer" || nativeResult === "native stack base");
    assert.equal(historyA.sentUpdates, beforeNativeUndo, "native undo must not echo a peer WorkspaceEdit");
    if (nativeResult !== "native stack base peer") {
      assert.equal(historyBinding.getStatus().status, "paused");
      assert.equal(historyBinding.getStatus().draft, nativeResult);
      assert.equal(historyB.model.getText(), "native stack base peer");
      await vscode.commands.executeCommand("redo"); await historyBinding.settled();
      assert.equal(historyBinding.getStatus().status, "paused");
      assert.equal(historyBinding.getStatus().draft, nativeResult, "native redo cannot erase the first paused draft");
      assert.equal(historyA.sentUpdates, beforeNativeUndo, "native redo cannot echo a peer WorkspaceEdit");
    }
    assert.equal((await vscode.workspace.fs.readFile(historyUri)).toString(), "native stack base");
    passed.push("native undo/redo after remote WorkspaceEdit: changed peer text=" + (nativeResult !== "native stack base peer")
      + ", outgoing local updates=0, divergent buffer paused with first draft retained");
    if (historyBinding.getStatus().status !== "paused") historyBinding.pause("Native history cannot be safely attributed");
    const historyFlow = new PrototypePauseFlow(vscode, historyDocument, historyBinding, historyA);
    const flowBuffer = historyDocument.getText(), flowDraft = historyBinding.getStatus().draft, flowSent = historyA.sentUpdates;
    assert.equal(await historyFlow.choose(undefined), "dismissed");
    assert.equal(historyBinding.getStatus().status, "paused");
    assert.equal(await historyFlow.choose("Inspect Draft"), "inspected");
    assert.equal(vscode.window.activeTextEditor?.document.getText(), flowDraft);
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, "untitled");
    assert.equal(historyDocument.getText(), flowBuffer);
    await vscode.window.showTextDocument(historyDocument, { preview: false });
    assert.equal((await vscode.workspace.fs.readFile(historyUri)).toString(), "native stack base");
    passed.push("paused native draft is inspected as untitled; dismiss keeps sharing paused and disk unchanged");
    assert.equal(await historyFlow.choose("Use Room Text"), "resumed");
    assert.equal(historyDocument.getText(), historyB.model.getText());
    assert.equal(historyBinding.getStatus().draft, flowDraft);
    assert.equal(historyA.sentUpdates, flowSent, "room-text choice must not echo");
    assert.equal(historyDocument.isDirty, true);
    assert.equal((await vscode.workspace.fs.readFile(historyUri)).toString(), "native stack base");
    passed.push("explicit native room-text choice retains draft snapshot and dirty buffer without save or echo");
    historyBinding.pause("explicit test pause");
    const pausedDraft = historyDocument.getText();
    await assert.rejects(vscode.commands.executeCommand(UNDO_LOCAL_COMMAND), /Resolve or re-share/);
    assert.equal(await historyFlow.choose("End Sharing"), "ended");
    assert.equal(historyBinding.getStatus().status, "disposed");
    await assert.rejects(vscode.commands.executeCommand(REDO_LOCAL_COMMAND), /Resolve or re-share/);
    assert.equal(historyDocument.getText(), pausedDraft);
    assert.equal((await vscode.workspace.fs.readFile(historyUri)).toString(), "native stack base");
    passed.push("paused and disconnected native binding refuses prototype undo/redo without changing draft or disk");
    assert.equal((await vscode.workspace.fs.readFile(historyUri)).toString(), "native stack base");
    passed.push("explicit native End Sharing disposes binding without saving the paused draft");
    sharedBindings.delete(historyDocument); historyOrigin.dispose(); historyB.disconnect();
    await waitFor(() => !server.getStatus("MNP234").active);
  } catch (caught) { error = caught.stack || String(caught); }
  finally {
    historyCommands.dispose();
    for (const binding of bindings) binding.dispose(); for (const client of clients) client.dispose(); await server.dispose();
    await fs.writeFile(process.env.CODEMESH_EDITOR_RESULT, JSON.stringify({ passed, error }, null, 2));
  }
  if (error) throw new Error(error);
};
