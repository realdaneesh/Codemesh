const assert = require("node:assert/strict");
const Module = require("node:module");
const { WebSocketServer } = require("ws");

const notifications = { info: [], warning: [], error: [] };
const documents = [];
let warningChoice;
const prompts = [];
const diffs = [];
const providers = new Map();
const logs = [];
let applications = 0;
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

const documentChangeEmitter = new EventEmitter();
const documentCloseEmitter = new EventEmitter();
const fakeWindow = {};
let applyCompletion;

class WorkspaceEdit {
  constructor() {
    this.entries = [];
  }

  replace(uri, range, text) {
    this.entries.push({ uri, range, text });
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class FakeDocument {
  constructor(path, text) {
    this.path = path;
    this.uri = { fsPath: `C:\\workspace\\${path}`, toString: () => `file:///workspace/${path}` };
    this.text = text;
    this.eol = text.includes("\r\n") ? 2 : 1;
  }

  getText() {
    return this.text;
  }

  positionAt(offset) {
    return { line: 0, character: offset };
  }

  setText(text) {
    this.text = text;
    documentChangeEmitter.fire({ document: this, contentChanges: [{ text }] });
  }
}

Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      EventEmitter,
      Range,
      WorkspaceEdit,
      EndOfLine: { LF: 1, CRLF: 2 },
      Uri: { parse: (value) => ({ scheme: value.split(':')[0], toString: () => value }) },
      commands: { executeCommand: async (command, ...args) => { if (command === 'vscode.diff') diffs.push(args); } },
      workspace: {
        registerTextDocumentContentProvider: (scheme, provider) => { providers.set(scheme, provider); return { dispose() { providers.delete(scheme); } }; },
        textDocuments: documents,
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        getWorkspaceFolder: (uri) => uri.fsPath.startsWith("C:\\workspace\\") ? { uri: { fsPath: "C:\\workspace" } } : undefined,
        asRelativePath: (uri) => uri.fsPath.replace("C:\\workspace\\", "").replace(/\\/g, "/"),
        onDidChangeTextDocument: documentChangeEmitter.event,
        onDidCloseTextDocument: documentCloseEmitter.event,
        applyEdit: async (edit) => {
          applications += 1;
          const completion = applyCompletion;
          applyCompletion = undefined;
          for (const entry of edit.entries) {
            const document = documents.find((candidate) => candidate.uri.toString() === entry.uri.toString());
            assert.ok(document, "expected document for workspace edit");
            document.setText(entry.text);
          }
          return completion ? await completion : true;
        }
      },
      window: {
        get activeTextEditor() { return fakeWindow.activeTextEditor; },
        createOutputChannel: () => ({ appendLine(line) { logs.push(line); }, dispose() {} }),
        showInformationMessage: (message) => {
          notifications.info.push(message);
          return Promise.resolve(undefined);
        },
        showWarningMessage: (message, options, ...choices) => {
          notifications.warning.push(message);
          if (warningChoice === 'defer' && choices.length) return new Promise(resolve => prompts.push({ message, choices, resolve }));
          return Promise.resolve(warningChoice);
        },
        showErrorMessage: (message) => {
          notifications.error.push(message);
          return Promise.resolve(undefined);
        }
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { CodeMeshClient } = require("../dist/services/CodeMeshClient");
Module._load = originalLoad;

async function main() {
  await rejectsOutsideWorkspace();
  await rapidEditsAreCoalesced();
  await remoteEditsDoNotEcho();
  await conflictPreservesLocalDraftAndCanRetry();
  await documentSessionLifecycle();
  await divergentInitialSync();
  await textAndSizeBoundaries();
  await asynchronousRemoteEdits();
  await conflictInspection();
  await combinedApprovals();
  await manualProposalChoices();
  await combinedRecovery();
  console.log("PASS: extension sync rapid edits, remote apply no echo, conflict draft preservation, retry, path guard");
}

async function manualProposalChoices() {
  const base = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
  for (const [name, common, draft, room, reason] of [
    ['same line', base, base.replace('alpha', 'mine'), base.replace('alpha', 'room'), /same line/],
    ['adjacent', base, base.replace('alpha', 'mine'), base.replace('beta', 'room'), /adjacent/],
    ['repeated', 'same\nx\nsame\ny\n', 'mine\nx\nsame\ny\n', 'same\nx\nsame\nroom\n', /Repeated/]
  ]) {
    const harness = await createHarness();
    const doc = new FakeDocument('src/shared.txt', common);
    documents.push(doc);
    warningChoice = 'defer';
    try {
      await harness.client.createRoom();
      await waitFor(() => harness.client.getState().roomId);
      await harness.client.collaborateDocument(doc);
      await harness.waitForClientMessage('OPEN_DOCUMENT');
      harness.send({ type: 'DOCUMENT_SYNC', roomId: harness.roomId, documentPath: doc.path, revision: 0, text: common });
      await waitFor(() => harness.client.getState().documentStatus === 'shared');
      doc.setText(draft);
      await harness.waitForClientMessage('DOCUMENT_EDIT');
      harness.send({ type: 'DOCUMENT_CONFLICT', roomId: harness.roomId, documentPath: doc.path, revision: 1, text: room });
      await waitFor(() => prompts.length);
      const prompt = prompts.shift();
      assert.match(prompt.message, reason);
      for (const choice of ['Retry Mine', 'Use Room Text', 'End Sharing']) assert.ok(prompt.choices.includes(choice));
      assert.equal(prompt.choices.includes('Preview Combined Text'), false);
      prompt.resolve(undefined);
      assert.equal(doc.getText(), draft);
      console.log('PASS: manual combined fallback: ' + name);
    } finally {
      warningChoice = undefined;
      prompts.length = 0;
      await harness.close();
      documents.length = 0;
    }
  }
}

async function combinedApprovals() {
  const common = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
  const mine = common.replace('alpha', 'mine 🚀');
  const room = common.replace('epsilon', 'room 中文');
  const combined = mine.replace('epsilon', 'room 中文');
  for (const scenario of ['reject', 'dismiss', 'approve', 'room changes', 'draft changes', 're-share', 'disconnect', 'room changes during apply', 'ACK uses sent text']) {
    const harness = await createHarness();
    const document = new FakeDocument('src/shared.txt', common);
    documents.push(document);
    warningChoice = 'defer';
    let finishApply;
    const next = async () => { await waitFor(() => prompts.length); return prompts.shift(); };
    try {
      await harness.client.createRoom();
      await waitFor(() => harness.client.getState().roomId);
      await harness.client.collaborateDocument(document);
      await harness.waitForClientMessage('OPEN_DOCUMENT');
      harness.send({ type: 'DOCUMENT_SYNC', roomId: harness.roomId, documentPath: document.path, revision: 0, text: common });
      await waitFor(() => harness.client.getState().documentStatus === 'shared');
      if (scenario === 'ACK uses sent text') {
        const acknowledged = common.replace('beta', 'confirmed beta');
        document.setText(acknowledged);
        await harness.waitForClientMessage('DOCUMENT_EDIT');
        document.setText(acknowledged.replace('alpha', 'mine 🚀'));
        harness.send({ type: 'DOCUMENT_ACK', roomId: harness.roomId, documentPath: document.path, revision: 1 });
        await harness.waitForClientMessage('DOCUMENT_EDIT');
        assert.equal(harness.client.confirmedDocument.text, acknowledged, 'base is acknowledged sent text, never queued draft');
      } else {
        document.setText(mine);
        await harness.waitForClientMessage('DOCUMENT_EDIT');
      }
      const originalDraft = document.getText();
      const roomText = scenario === 'ACK uses sent text' ? room.replace('beta', 'confirmed beta') : room;
      const revision = scenario === 'ACK uses sent text' ? 2 : 1;
      harness.send({ type: 'DOCUMENT_CONFLICT', roomId: harness.roomId, documentPath: document.path, revision, text: roomText });
      const conflict = await next();
      assert.ok(conflict.choices.includes('Preview Combined Text'));
      if (scenario === 'reject') {
        harness.send({ type: 'DOCUMENT_CONFLICT', roomId: harness.roomId, documentPath: document.path, revision: 0, text: 'obsolete room text' });
        await delay(15);
        assert.equal(harness.client.conflict.revision, revision, 'older conflict cannot regress the trusted room revision');
        assert.equal(prompts.length, 0);
      }
      conflict.resolve('Preview Combined Text');
      const approval = await next();
      const provider = providers.get('codemesh-conflict');
      const [left, right] = diffs.at(-1);
      assert.equal(provider.provideTextDocumentContent(left), originalDraft);
      assert.equal(provider.provideTextDocumentContent(right), scenario === 'ACK uses sent text' ? combined.replace('beta', 'confirmed beta') : combined);
      assert.equal(harness.takeClientMessages('DOCUMENT_EDIT').length, 0);
      assert.equal(document.getText(), originalDraft);
      const applies = applications;
      if (scenario === 'room changes') {
        harness.send({ type: 'DOCUMENT_EDIT', roomId: harness.roomId, documentPath: document.path, revision: 2, text: room.replace('delta', 'new room delta') });
        (await next()).resolve(undefined);
        assert.match(provider.provideTextDocumentContent(right), /STALE/);
      }
      if (scenario === 'draft changes') document.setText(originalDraft + 'typed while previewing');
      if (scenario === 're-share') {
        harness.client.stopDocumentCollaboration();
        await harness.client.collaborateDocument(document);
        await harness.waitForClientMessage('OPEN_DOCUMENT');
        harness.send({ type: 'DOCUMENT_SYNC', roomId: harness.roomId, documentPath: document.path, revision: 3, text: document.getText() });
        await waitFor(() => harness.client.getState().documentStatus === 'shared');
      }
      if (scenario === 'disconnect') { harness.disconnect(); await waitFor(() => !harness.client.getState().sharedDocumentPath); }
      if (scenario === 'room changes during apply') applyCompletion = new Promise(resolve => { finishApply = resolve; });
      approval.resolve(scenario === 'reject' ? 'Reject Proposal' : scenario === 'dismiss' ? undefined : 'Apply and Share Combined Text');
      if (scenario === 'room changes during apply') {
        await waitFor(() => document.getText() === combined);
        harness.send({ type: 'DOCUMENT_EDIT', roomId: harness.roomId, documentPath: document.path, revision: 2, text: room.replace('delta', 'room delta later') });
        await waitFor(() => harness.client.conflict.revision === 2);
        finishApply(true);
        const recovery = await next();
        assert.match(recovery.message, /unsaved editor.*NOT shared/);
        recovery.resolve(undefined);
      }
      if (scenario === 'approve' || scenario === 'ACK uses sent text') {
        const sent = await harness.waitForClientMessage('DOCUMENT_EDIT');
        assert.equal(sent.baseRevision, revision);
        assert.equal(sent.text, provider.provideTextDocumentContent(right));
        assert.equal(document.getText(), sent.text);
      } else {
        await delay(30);
        assert.equal(harness.takeClientMessages('DOCUMENT_EDIT').length, 0, 'rejected, dismissed or stale approval cannot send');
        if (scenario !== 'room changes during apply') assert.equal(applications, applies);
        assert.ok(provider.provideTextDocumentContent(left).includes(originalDraft), 'original draft snapshot remains recoverable');
        if (scenario === 'reject' || scenario === 'dismiss') {
          assert.equal(document.getText(), originalDraft);
          assert.equal(harness.client.conflict.text, roomText, 'room draft is preserved too');
          assert.equal(harness.client.getState().documentStatus, 'conflict');
        }
      }
      console.log('PASS: combined lifecycle: ' + scenario);
    } finally {
      finishApply?.(true);
      applyCompletion = undefined;
      warningChoice = undefined;
      prompts.length = 0;
      await harness.close();
      documents.length = 0;
    }
  }
}

async function combinedRecovery() {
  const common = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
  const mine = common.replace('alpha', 'mine');
  const room = common.replace('epsilon', 'room');
  const combined = mine.replace('epsilon', 'room');
  for (const scenario of ['dismiss and inspect', 'repeated room changes', 'fresh comparison', 'end sharing', 'delayed notice after re-share', 'session end during apply']) {
    const harness = await createHarness();
    const doc = new FakeDocument('src/shared.txt', common);
    documents.push(doc);
    warningChoice = 'defer';
    let finish;
    const next = async () => { await waitFor(() => prompts.length); return prompts.shift(); };
    const remote = (revision) => harness.send({ type: 'DOCUMENT_EDIT', roomId: harness.roomId, documentPath: doc.path, revision, text: room.replace('delta', `latest ${revision}`) });
    try {
      await harness.client.createRoom();
      await waitFor(() => harness.client.getState().roomId);
      await harness.client.collaborateDocument(doc);
      await harness.waitForClientMessage('OPEN_DOCUMENT');
      harness.send({ type: 'DOCUMENT_SYNC', roomId: harness.roomId, documentPath: doc.path, revision: 0, text: common });
      await waitFor(() => harness.client.getState().documentStatus === 'shared');
      doc.setText(mine);
      await harness.waitForClientMessage('DOCUMENT_EDIT');
      harness.send({ type: 'DOCUMENT_CONFLICT', roomId: harness.roomId, documentPath: doc.path, revision: 1, text: room });
      (await next()).resolve('Preview Combined Text');
      const approval = await next();
      applyCompletion = new Promise(resolve => { finish = resolve; });
      approval.resolve('Apply and Share Combined Text');
      await waitFor(() => doc.getText() === combined);
      const applies = applications;
      remote(2);
      await waitFor(() => harness.client.conflict.revision === 2);
      assert.equal(prompts.length, 0, 'no misleading generic conflict prompt while the approved edit completes');
      if (scenario === 'session end during apply') harness.client.stopDocumentCollaboration();
      finish(true);
      if (scenario === 'session end during apply') {
        await delay(20);
        assert.equal(prompts.length, 0);
        assert.equal(harness.client.getState().sharedDocumentPath, undefined);
      } else {
        const notice = await next();
        assert.match(notice.message, /unsaved editor.*NOT shared.*Sharing is paused/);
        assert.deepEqual(notice.choices, ['Inspect Preserved Versions', 'Start Fresh Comparison', 'End Sharing']);
        assert.match(harness.client.getState().documentError, /NOT shared/);
        const recovery = harness.client.conflict.recovery;
        const provider = providers.get('codemesh-conflict');
        assert.equal(provider.provideTextDocumentContent(recovery.original), mine);
        assert.equal(provider.provideTextDocumentContent(recovery.proposed), combined);
        assert.equal(provider.provideTextDocumentContent(recovery.room), room.replace('delta', 'latest 2'));
        if (scenario === 'repeated room changes') {
          remote(3);
          const newer = await next();
          remote(4);
          const newest = await next();
          notice.resolve('End Sharing'); newer.resolve('Start Fresh Comparison');
          newest.resolve(undefined);
          await delay(15);
          assert.equal(harness.client.conflict.revision, 4);
          assert.equal(provider.provideTextDocumentContent(harness.client.conflict.recovery.room), room.replace('delta', 'latest 4'));
          assert.equal(harness.client.conflict.recovery.original, recovery.original);
        } else if (scenario === 'fresh comparison') {
          notice.resolve('Start Fresh Comparison');
          const fresh = await next();
          assert.match(fresh.message, /in your editor has NOT been shared/);
          assert.ok(fresh.choices.includes('Retry Mine'));
          fresh.resolve(undefined);
        } else if (scenario === 'end sharing') {
          notice.resolve('End Sharing');
          await waitFor(() => !harness.client.getState().sharedDocumentPath);
          assert.equal(harness.client.hasRecoveryVersions(), true);
          await harness.client.inspectRecoveryVersions();
        } else if (scenario === 'delayed notice after re-share') {
          harness.client.stopDocumentCollaboration();
          await harness.client.collaborateDocument(doc);
          await harness.waitForClientMessage('OPEN_DOCUMENT');
          harness.send({ type: 'DOCUMENT_SYNC', roomId: harness.roomId, documentPath: doc.path, revision: 5, text: combined });
          await waitFor(() => harness.client.getState().documentStatus === 'shared');
          notice.resolve('End Sharing');
          await delay(15);
          assert.equal(harness.client.getState().documentStatus, 'shared');
        } else {
          notice.resolve(undefined);
          await harness.client.inspectRecoveryVersions();
          assert.equal(diffs.at(-2)[0], recovery.original);
          assert.equal(diffs.at(-1)[1], recovery.room);
          assert.equal(harness.client.getState().documentStatus, 'conflict');
        }
      }
      await delay(15);
      assert.equal(doc.getText(), combined, 'recovery never overwrites or silently restores the editor');
      assert.equal(applications, applies, 'no further editor edits during recovery');
      assert.equal(harness.takeClientMessages('DOCUMENT_EDIT').length, 0);
      console.log('PASS: combined recovery: ' + scenario);
    } finally {
      finish?.(true); applyCompletion = undefined; warningChoice = undefined; prompts.length = 0;
      await harness.close(); documents.length = 0;
    }
  }
}

async function conflictInspection() {
  const harness = await createHarness();
  const document = new FakeDocument('src/shared.txt', 'private draft 🚀\r\nunsaved');
  documents.push(document);
  warningChoice = 'defer';
  const nextPrompt = async () => { await waitFor(() => prompts.length); return prompts.shift(); };
  const conflict = (revision, text) => harness.send({ type: 'DOCUMENT_CONFLICT', roomId: harness.roomId, documentPath: document.path, revision, text });
  try {
    await harness.client.createRoom();
    await waitFor(() => harness.client.getState().roomId);
    await harness.client.collaborateDocument(document);
    await harness.waitForClientMessage('OPEN_DOCUMENT');
    harness.send({ type: 'DOCUMENT_SYNC', roomId: harness.roomId, documentPath: document.path, revision: 1, text: 'room one' });
    (await nextPrompt()).resolve(undefined);
    const initialApplications = applications;
    await harness.client.inspectConflictDifferences();
    const old = await nextPrompt();
    const [mine, room, title] = diffs.at(-1);
    const provider = providers.get('codemesh-conflict');
    assert.equal(provider.provideTextDocumentContent(mine), document.getText());
    assert.equal(provider.provideTextDocumentContent(room), 'room one');
    assert.match(title, /src\/shared.txt.*revision 1.*My unsaved draft.*Room text/);
    let staleEvents = 0;
    const subscription = provider.onDidChange(() => staleEvents++);
    conflict(2, 'room two');
    const stale = await nextPrompt();
    assert.match(provider.provideTextDocumentContent(room), /STALE/);
    assert.equal(staleEvents, 2);
    assert.ok(!stale.choices.includes('Use Room Text'));
    old.resolve('Retry Mine');
    stale.resolve(undefined);
    await delay(15);
    assert.equal(applications, initialApplications);
    assert.equal(harness.takeClientMessages('DOCUMENT_EDIT').length, 0);
    assert.equal(harness.client.getState().documentStatus, 'conflict');
    await harness.client.inspectConflictDifferences();
    const changedDraftChoice = await nextPrompt();
    document.setText('private draft changed during inspection');
    changedDraftChoice.resolve('Use Room Text');
    const needsFreshDraft = await nextPrompt();
    assert.ok(!needsFreshDraft.choices.includes('Use Room Text'));
    assert.equal(applications, initialApplications);
    needsFreshDraft.resolve(undefined);
    await harness.client.inspectConflictDifferences();
    (await nextPrompt()).resolve('Use Room Text');
    await waitFor(() => document.getText() === 'room two');
    assert.equal(harness.takeClientMessages('DOCUMENT_EDIT').length, 0);

    for (const action of ['end', 'leave', 'disconnect']) {
      if (!harness.client.getState().roomId) {
        await harness.client.joinRoom(harness.roomId);
        await waitFor(() => harness.client.getState().roomId);
      }
      await harness.client.collaborateDocument(document);
      if (harness.client.awaitingDocumentSync) {
        await harness.waitForClientMessage('OPEN_DOCUMENT');
        harness.send({ type: 'DOCUMENT_SYNC', roomId: harness.roomId, documentPath: document.path, revision: 3, text: document.getText() });
        await waitFor(() => harness.client.getState().documentStatus === 'shared');
      }
      document.setText('private draft ' + action);
      await harness.waitForClientMessage('DOCUMENT_EDIT');
      conflict(harness.client.sharedDocumentRevision + 1, 'competing text');
      (await nextPrompt()).resolve('Inspect Differences');
      const delayed = await nextPrompt();
      if (action === 'end') harness.client.stopDocumentCollaboration();
      if (action === 'leave') harness.client.leaveRoom();
      if (action === 'disconnect') { harness.disconnect(); await waitFor(() => !harness.client.getState().sharedDocumentPath); }
      if (action === 'end') {
        await harness.client.collaborateDocument(document);
        await harness.waitForClientMessage('OPEN_DOCUMENT');
        harness.send({ type: 'DOCUMENT_SYNC', roomId: harness.roomId, documentPath: document.path, revision: 5, text: document.getText() });
        await waitFor(() => harness.client.getState().documentStatus === 'shared');
      }
      delayed.resolve('End Sharing');
      await delay(20);
      assert.equal(document.getText(), 'private draft ' + action);
      if (action === 'end') assert.equal(harness.client.getState().documentStatus, 'shared');
      assert.equal(harness.takeClientMessages('DOCUMENT_EDIT').length, 0);
    }
    assert.equal(logs.some(line => line.includes('private draft')), false);
    await waitFor(() => harness.client.getState().roomId);
    await harness.client.collaborateDocument(document);
    await harness.waitForClientMessage('OPEN_DOCUMENT');
    harness.send({ type: 'DOCUMENT_SYNC', roomId: harness.roomId, documentPath: document.path, revision: 6, text: 'another room draft' });
    (await nextPrompt()).resolve('End Sharing');
    await waitFor(() => !harness.client.getState().sharedDocumentPath);
    assert.equal(document.getText(), 'private draft disconnect');
    subscription.dispose();
    console.log('PASS: inspection snapshots, dismissal recovery, stale room diff/events, fresh comparison, repeated conflicts, delayed choices after re-share/leave/disconnect, zero inspection edits/applies');
  } finally {
    warningChoice = undefined;
    prompts.length = 0;
    await harness.close();
    documents.length = 0;
  }
}

async function rejectsOutsideWorkspace() {
  const harness = await createHarness();
  try {
    await harness.client.createRoom();
    await waitFor(() => harness.client.getState().roomId === harness.roomId);
    await assert.rejects(
      harness.client.collaborateDocument({
        uri: { fsPath: "C:\\elsewhere\\x.txt", toString: () => "file:///elsewhere/x.txt" },
        getText: () => "",
        positionAt: (offset) => ({ line: 0, character: offset })
      }),
      /Document must be inside the current workspace/
    );
  } finally {
    await harness.close();
  }
}

async function rapidEditsAreCoalesced() {
  const harness = await createHarness();
  const document = new FakeDocument("src/shared.txt", "start");
  documents.push(document);

  try {
    await harness.client.createRoom();
    await waitFor(() => harness.client.getState().roomId === harness.roomId);
    await harness.client.collaborateDocument(document);
    await harness.waitForClientMessage("OPEN_DOCUMENT");
    harness.send({ type: "DOCUMENT_SYNC", roomId: harness.roomId, documentPath: "src/shared.txt", revision: 0, text: "start" });
    await delay(10);

    document.setText("a");
    const first = await harness.waitForClientMessage("DOCUMENT_EDIT");
    assert.equal(first.baseRevision, 0);
    assert.equal(first.text, "a");
    document.setText("ab");
    document.setText("abc");
    await delay(30);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0, "edits are held while one is in flight");

    harness.send({ type: "DOCUMENT_ACK", roomId: harness.roomId, documentPath: "src/shared.txt", revision: 1 });
    const second = await harness.waitForClientMessage("DOCUMENT_EDIT");
    assert.equal(second.baseRevision, 1);
    assert.equal(second.text, "abc");
  } finally {
    await harness.close();
    documents.length = 0;
  }
}

async function remoteEditsDoNotEcho() {
  const harness = await createHarness();
  const document = new FakeDocument("src/shared.txt", "start");
  documents.push(document);

  try {
    await harness.client.createRoom();
    await waitFor(() => harness.client.getState().roomId === harness.roomId);
    await harness.client.collaborateDocument(document);
    await harness.waitForClientMessage("OPEN_DOCUMENT");
    harness.send({ type: "DOCUMENT_SYNC", roomId: harness.roomId, documentPath: "src/shared.txt", revision: 0, text: "start" });
    harness.send({ type: "DOCUMENT_EDIT", roomId: harness.roomId, documentPath: "src/shared.txt", revision: 1, text: "remote" });
    await waitFor(() => document.getText() === "remote");
    await delay(30);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0, "remote apply is not rebroadcast");
  } finally {
    await harness.close();
    documents.length = 0;
  }
}

async function conflictPreservesLocalDraftAndCanRetry() {
  const harness = await createHarness();
  const document = new FakeDocument("src/shared.txt", "start");
  documents.push(document);
  warningChoice = "Retry Mine";

  try {
    await harness.client.createRoom();
    await waitFor(() => harness.client.getState().roomId === harness.roomId);
    await harness.client.collaborateDocument(document);
    await harness.waitForClientMessage("OPEN_DOCUMENT");
    harness.send({ type: "DOCUMENT_SYNC", roomId: harness.roomId, documentPath: "src/shared.txt", revision: 0, text: "start" });

    await waitFor(() => harness.client.getState().documentStatus === "shared");
    document.setText("mine");
    await harness.waitForClientMessage("DOCUMENT_EDIT");
    harness.send({ type: "DOCUMENT_CONFLICT", roomId: harness.roomId, documentPath: "src/shared.txt", revision: 1, text: "theirs" });
    await waitFor(() => notifications.warning.length > 0);
    assert.equal(document.getText(), "mine");

    const retry = await harness.waitForClientMessage("DOCUMENT_EDIT");
    assert.equal(retry.baseRevision, 1);
    assert.equal(retry.text, "mine");
  } finally {
    warningChoice = undefined;
    await harness.close();
    documents.length = 0;
  }
}

async function divergentInitialSync() {
  const harness = await createHarness();
  const document = new FakeDocument("src/shared.txt", "unsaved draft");
  document.isDirty = true;
  documents.push(document);
  let resolveChoice;
  warningChoice = new Promise((resolve) => { resolveChoice = resolve; });
  try {
    await harness.client.createRoom();
    await waitFor(() => harness.client.getState().roomId);
    await harness.client.collaborateDocument(document);
    await harness.waitForClientMessage("OPEN_DOCUMENT");
    document.setText("draft before initial sync");
    await delay(20);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0);
    harness.send({ type: "DOCUMENT_SYNC", roomId: harness.roomId, documentPath: document.path, revision: 7, text: "room text" });
    await waitFor(() => harness.client.getState().documentStatus === "conflict");
    assert.equal(document.getText(), "draft before initial sync");
    assert.match(notifications.warning.at(-1), /No trustworthy confirmed common base/);
    document.setText("draft while deciding");
    await delay(20);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0, "typing cannot clear conflict");
    resolveChoice("Use Room Text");
    await waitFor(() => document.getText() === "room text");
    assert.equal(harness.client.getState().documentStatus, "shared");
    await delay(20);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0, "explicit room text apply does not echo");

    warningChoice = new Promise((resolve) => { resolveChoice = resolve; });
    document.setText("new draft");
    await harness.waitForClientMessage("DOCUMENT_EDIT");
    harness.send({ type: "DOCUMENT_CONFLICT", roomId: harness.roomId, documentPath: document.path, revision: 8, text: "new room text" });
    await waitFor(() => harness.client.getState().documentStatus === "conflict");
    harness.client.stopDocumentCollaboration();
    resolveChoice("Use Room Text");
    await delay(20);
    assert.equal(document.getText(), "new draft", "late prompt cannot modify an ended session");
    console.log("PASS: divergent initial sync preserves draft, blocks typing, explicit room text, late resolution guard");
  } finally {
    warningChoice = undefined;
    await harness.close();
    documents.length = 0;
  }
}

async function documentSessionLifecycle() {
  const harness = await createHarness();
  const document = new FakeDocument("src/shared.txt", "start");
  const other = new FakeDocument("src/other.txt", "other");
  documents.push(document, other);
  const remote = (text) => harness.send({ type: "DOCUMENT_EDIT", roomId: harness.roomId, documentPath: document.path, revision: 1, text });
  const share = async () => {
    await harness.client.collaborateDocument(document);
    await harness.waitForClientMessage("OPEN_DOCUMENT");
    harness.send({ type: "DOCUMENT_SYNC", roomId: harness.roomId, documentPath: document.path, revision: 0, text: document.getText() });
    await waitFor(() => harness.client.getState().documentStatus === "shared");
  };
  try {
    await harness.client.createRoom();
    await waitFor(() => harness.client.getState().roomId);
    await share();
    await harness.client.collaborateDocument(document);
    assert.equal(documentChangeEmitter.listeners.size, 1);
    assert.equal(documentCloseEmitter.listeners.size, 1);
    fakeWindow.activeTextEditor = { document: other };
    other.setText("different tab edited");
    await delay(20);
    assert.equal(harness.takeClientMessages("OPEN_DOCUMENT").length, 0);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0);
    assert.equal(harness.client.getState().sharedDocumentPath, document.path);

    harness.disconnect();
    await harness.waitForClientMessage("JOIN_ROOM");
    await waitFor(() => harness.client.getState().roomId);
    assert.equal(documentChangeEmitter.listeners.size, 0);
    assert.equal(harness.client.getState().sharedDocumentPath, undefined);
    document.setText("offline draft");
    remote("late after reconnect");
    await delay(20);
    assert.equal(document.getText(), "offline draft");
    assert.equal(harness.takeClientMessages("OPEN_DOCUMENT").length, 0);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0);

    await share();
    harness.client.stopDocumentCollaboration();
    await harness.waitForClientMessage("CLOSE_DOCUMENT");
    remote("after end");
    await delay(20);
    assert.equal(document.getText(), "offline draft");
    assert.equal(documentChangeEmitter.listeners.size, 0);
    await share();
    documentCloseEmitter.fire(document);
    remote("after close");
    await delay(20);
    assert.equal(document.getText(), "offline draft");
    assert.equal(documentCloseEmitter.listeners.size, 0);
    await share();
    harness.client.leaveRoom();
    remote("after leave");
    document.setText("left draft");
    await delay(20);
    assert.equal(document.getText(), "left draft");
    assert.equal(documentChangeEmitter.listeners.size, 0);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0);

    await harness.client.joinRoom(harness.roomId);
    await waitFor(() => harness.client.getState().roomId);
    await share();
    harness.client.dispose();
    assert.equal(documentChangeEmitter.listeners.size, 0);
    assert.equal(harness.client.getState().sharedDocumentPath, undefined);
    document.setText("disposed draft");
    console.log("PASS: repeated share, other-tab edits, reconnect requires re-share, end, leave, dispose cleanup");
  } finally {
    await harness.close();
    documents.length = 0;
  }
}

async function textAndSizeBoundaries() {
  const { MAX_DOCUMENT_BYTES, MAX_MESSAGE_BYTES } = require("../dist/types/syncLimits");
  const harness = await createHarness();
  const document = new FakeDocument("src/shared.txt", "first\r\nlast");
  documents.push(document);
  const share = async () => {
    await harness.client.collaborateDocument(document);
    const open = await harness.waitForClientMessage("OPEN_DOCUMENT");
    assert.ok(!open.text.includes("\r\n"), "wire text is LF");
    harness.send({ type: "DOCUMENT_SYNC", roomId: harness.roomId, documentPath: document.path, revision: 0, text: open.text });
    await waitFor(() => harness.client.getState().documentStatus === "shared");
  };
  try {
    await harness.client.createRoom();
    await waitFor(() => harness.client.getState().roomId);
    await share();
    documentChangeEmitter.fire({ document, contentChanges: [] });
    await delay(20);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0, "metadata events do not send duplicate edits");
    harness.send({ type: "DOCUMENT_EDIT", roomId: harness.roomId, documentPath: document.path, revision: 1, text: "first\n\u4e2d\u6587 \ud83d\ude80 e\u0301\nlast" });
    await waitFor(() => document.getText() === "first\r\n\u4e2d\u6587 \ud83d\ude80 e\u0301\r\nlast");
    await delay(20);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0);
    document.setText("");
    const deletion = await harness.waitForClientMessage("DOCUMENT_EDIT");
    assert.equal(deletion.text, "");
    assert.equal(deletion.baseRevision, 1);
    harness.send({ type: "DOCUMENT_ACK", roomId: harness.roomId, documentPath: document.path, revision: 2 });
    await waitFor(() => !harness.client.documentEditInFlight);

    const nearLimit = "x".repeat(MAX_DOCUMENT_BYTES - 3);
    document.setText(nearLimit + "000");
    const first = await harness.waitForClientMessage("DOCUMENT_EDIT");
    assert.equal(Buffer.byteLength(first.text), MAX_DOCUMENT_BYTES);
    for (let i = 1; i <= 60; i += 1) document.setText(nearLimit + String(i).padStart(3, "0"));
    await delay(20);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0, "large rapid changes have one message in flight");
    harness.send({ type: "DOCUMENT_ACK", roomId: harness.roomId, documentPath: document.path, revision: 3 });
    const final = await harness.waitForClientMessage("DOCUMENT_EDIT");
    assert.equal(final.text, nearLimit + "060");
    assert.equal(final.baseRevision, 3);

    document.setText("\u4e2d".repeat(Math.floor(MAX_DOCUMENT_BYTES / 3) + 1));
    const oversizedDraft = document.getText();
    assert.equal(harness.client.getState().sharedDocumentPath, undefined);
    assert.match(notifications.error.at(-1), /256 KiB.*draft was preserved/);
    harness.send({ type: "DOCUMENT_ACK", roomId: harness.roomId, documentPath: document.path, revision: 4 });
    harness.send({ type: "DOCUMENT_EDIT", roomId: harness.roomId, documentPath: document.path, revision: 5, text: "remote overwrite" });
    await delay(20);
    assert.equal(document.getText(), oversizedDraft);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0);
    await assert.rejects(harness.client.collaborateDocument(document), /256 KiB/);
    assert.equal(harness.takeClientMessages("OPEN_DOCUMENT").length, 0);

    document.setText("\u0000".repeat(MAX_DOCUMENT_BYTES));
    await share();
    assert.ok(Buffer.byteLength(JSON.stringify({ text: document.getText() })) < MAX_MESSAGE_BYTES, "maximum JSON escaping fits envelope limit");
    document.setText("local rejected draft");
    await harness.waitForClientMessage("DOCUMENT_EDIT");
    harness.send({ type: "ERROR", message: "Document edit rejected" });
    await waitFor(() => harness.client.getState().sharedDocumentPath === undefined);
    harness.send({ type: "DOCUMENT_EDIT", roomId: harness.roomId, documentPath: document.path, revision: 1, text: "server" });
    await delay(20);
    assert.equal(document.getText(), "local rejected draft");
    assert.equal(documentChangeEmitter.listeners.size, 0);
    assert.match(notifications.error.at(-1), /draft was preserved/);
    console.log("PASS: metadata events, LF wire/CRLF editor, Unicode, empty deletion, 60 large rapid changes, byte limits, escaping, rejected draft preservation");
  } finally {
    await harness.close();
    documents.length = 0;
  }
}

async function asynchronousRemoteEdits() {
  const harness = await createHarness();
  const document = new FakeDocument("src/shared.txt", "start");
  documents.push(document);
  let finishApply;
  try {
    await harness.client.createRoom();
    await waitFor(() => harness.client.getState().roomId);
    await harness.client.collaborateDocument(document);
    await harness.waitForClientMessage("OPEN_DOCUMENT");
    harness.send({ type: "DOCUMENT_SYNC", roomId: harness.roomId, documentPath: document.path, revision: 0, text: "start" });
    await waitFor(() => harness.client.getState().documentStatus === "shared");
    applyCompletion = new Promise((resolve) => { finishApply = resolve; });
    harness.send({ type: "DOCUMENT_EDIT", roomId: harness.roomId, documentPath: document.path, revision: 1, text: "remote one" });
    await waitFor(() => document.getText() === "remote one");
    harness.send({ type: "DOCUMENT_EDIT", roomId: harness.roomId, documentPath: document.path, revision: 2, text: "remote two" });
    await delay(20);
    assert.equal(document.getText(), "remote one", "remote edits wait for the preceding apply to finish");
    finishApply(true);
    await waitFor(() => document.getText() === "remote two");
    await delay(20);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0);
    document.setText("local after two");
    const local = await harness.waitForClientMessage("DOCUMENT_EDIT");
    assert.equal(local.baseRevision, 2, "async apply completion cannot regress revision");
    harness.send({ type: "DOCUMENT_ACK", roomId: harness.roomId, documentPath: document.path, revision: 3 });
    await waitFor(() => !harness.client.documentEditInFlight);

    applyCompletion = new Promise((resolve) => { finishApply = resolve; });
    harness.send({ type: "DOCUMENT_EDIT", roomId: harness.roomId, documentPath: document.path, revision: 4, text: "remote four" });
    await waitFor(() => document.getText() === "remote four");
    document.setText("local typed during apply completion");
    await delay(20);
    assert.equal(harness.takeClientMessages("DOCUMENT_EDIT").length, 0);
    finishApply(true);
    const queued = await harness.waitForClientMessage("DOCUMENT_EDIT");
    assert.equal(queued.text, "local typed during apply completion");
    assert.equal(queued.baseRevision, 4);
    assert.equal(document.getText(), queued.text);
    console.log("PASS: ordered asynchronous remote edits, confirmed revision, local typing during remote apply is preserved without echo");
  } finally {
    finishApply?.(true);
    applyCompletion = undefined;
    await harness.close();
    documents.length = 0;
  }
}

async function createHarness() {
  const roomId = "ABC234";
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const clientMessages = [];
  let activeSocket;

  server.on("connection", (socket) => {
    activeSocket = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      clientMessages.push(message);
      if (message.type === "CREATE_ROOM" || message.type === "JOIN_ROOM") {
        socket.send(JSON.stringify({
          type: message.type === "CREATE_ROOM" ? "ROOM_CREATED" : "ROOM_JOINED",
          roomId,
          member: message.member,
          members: [message.member]
        }));
      }
    });
  });

  const client = new CodeMeshClient({
    serverUrl: `ws://127.0.0.1:${address.port}`,
    reconnectDelayMs: 10,
    self: { memberId: "self", displayName: "Self" }
  });

  return {
    roomId,
    client,
    disconnect: () => activeSocket.terminate(),
    send: (message) => activeSocket.send(JSON.stringify(message)),
    waitForClientMessage: (type) => waitFor(() => {
      const index = clientMessages.findIndex((message) => message.type === type);
      if (index < 0) return undefined;
      return clientMessages.splice(index, 1)[0];
    }),
    takeClientMessages: (type) => {
      const matching = clientMessages.filter((message) => message.type === type);
      for (const message of matching) {
        clientMessages.splice(clientMessages.indexOf(message), 1);
      }
      return matching;
    },
    close: async () => {
      client.dispose();
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once("error", reject);
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for sync condition");
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
