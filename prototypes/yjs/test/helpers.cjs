const limits = require("../../../extension/dist/types/syncLimits");
const { normalizeManifestPath } = require("../../../extension/dist/types/workspaceManifest");
const { BinaryProtocol } = require("../dist/protocol");
exports.protocol = new BinaryProtocol({ maxMessageBytes: limits.MAX_MESSAGE_BYTES, maxDocumentBytes: limits.MAX_DOCUMENT_BYTES, maxPathBytes: limits.MAX_DOCUMENT_PATH_BYTES }, normalizeManifestPath);
exports.limits = limits;
exports.waitFor = async (condition) => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Experimental test timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
exports.editor = (initial, eol = 1) => {
  const changes = new Set(), closes = new Set();
  const subscribe = (set) => (listener) => { set.add(listener); return { dispose: () => set.delete(listener) }; };
  let saves = 0, applications = 0, scrollTop = 0, selections = [], applied = [];
  const document = { uri: { scheme: "file", toString: () => "file:///test/shared.txt" }, text: initial, eol, isDirty: false,
    getText() { return this.text; }, positionAt(offset) { return { offset }; }, save() { saves += 1; } };
  const emit = (contentChanges, origin, reason) => { for (const listener of changes) listener({ document, contentChanges, origin, reason }); };
  const apply = (edits, origin, reason) => {
    const next = [...edits].sort((a, b) => b.rangeOffset - a.rangeOffset);
    for (const edit of next) {
      document.text = document.text.slice(0, edit.rangeOffset) + edit.text + document.text.slice(edit.rangeOffset + edit.rangeLength);
      const move = (offset) => offset < edit.rangeOffset ? offset
        : offset >= edit.rangeOffset + edit.rangeLength ? offset + edit.text.length - edit.rangeLength
          : edit.rangeOffset + edit.text.length;
      selections = selections.map((selection) => ({ anchor: move(selection.anchor), active: move(selection.active) }));
    }
    document.isDirty = true; emit(edits, origin, reason);
  };
  const history = [], redo = [];
  const api = {
    WorkspaceEdit: class { constructor() { this.edits = []; } replace(_uri, range, text) { this.edits.push({ rangeOffset: range.start.offset, rangeLength: range.end.offset - range.start.offset, text }); } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: {
      getWorkspaceFolder: () => ({ uri: { scheme: "file" } }), asRelativePath: () => "shared.txt",
      onDidChangeTextDocument: subscribe(changes), onDidCloseTextDocument: subscribe(closes),
      applyEdit: async (edit) => { applications += 1; if (api.gate) await api.gate; if (api.reject) return false; applied.push(edit.edits); apply(edit.edits); return true; }
    }
  };
  const origin = {
    applyEdit: async (edit, token) => { applications += 1; if (api.gate) await api.gate; if (api.reject) return false; applied.push(edit.edits); apply(edit.edits, token); return true; },
    isOwnEdit: (event, token) => event.origin === token
  };
  return { api, origin, document, initial,
    setSelections(value) { selections = value.map((selection) => ({ ...selection })); },
    setScroll(value) { scrollTop = value; },
    edit(edits) { history.push(document.text); redo.splice(0); apply(edits); },
    undo() { if (!history.length) return; redo.push(document.text); const text = history.pop(); apply([{ rangeOffset: 0, rangeLength: document.text.length, text }], undefined, 1); },
    redo() { if (!redo.length) return; history.push(document.text); const text = redo.pop(); apply([{ rangeOffset: 0, rangeLength: document.text.length, text }], undefined, 2); },
    eol(value) { document.eol = value; document.text = document.text.replace(/\r\n/g, "\n").replace(/\n/g, value === 2 ? "\r\n" : "\n"); emit([]); },
    close() { for (const listener of closes) listener(document); },
    get selections() { return selections; }, get scrollTop() { return scrollTop; }, get applied() { return applied; },
    get saves() { return saves; }, get applications() { return applications; }, get listeners() { return changes.size + closes.size; }
  };
};
