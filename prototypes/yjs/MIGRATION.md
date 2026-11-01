# Yjs Single-Document Migration

## Current Boundary

Production stays on `OPEN_DOCUMENT`, `DOCUMENT_EDIT`, `DOCUMENT_ACK` and
`DOCUMENT_CONFLICT`. It coalesces full text while an edit is in flight, preserves
divergent drafts, uses LF on the wire, and applies remote text without saving.
No production entry point imports this prototype. Yjs 13.6.33 is a root dev-only
dependency; `npm run test:crdt` builds both production packages and the prototype.

The experiment uses one ephemeral server `Y.Doc` and `Y.Text("text")`, independent
client replicas, and binary frames containing a versioned room/path/epoch header
plus raw Yjs update or state-vector bytes. Joining uses `encodeStateVector` and
`encodeStateAsUpdate`; clients never independently seed identical initial text.
Day 1 tests schedule, duplicate and reorder frames in memory. Day 2 adds a separate
loopback-only WebSocket server, two independent clients/editor adapters, and native
VS Code binding checks. Nothing is routed through the production WebSocket server.
The test harness grants random capabilities for one room and document; this is not
yet an integration with production room membership or a public authentication service.

## Editor Binding

`TestEditorBinding` now accepts the VS Code API and an explicitly selected local
TextDocument matching the authorized workspace-relative path. It translates each
local `contentChanges` batch into one local-origin Y.Text transaction, using
pre-change offsets and descending ranges. CRLF offsets become canonical LF UTF-16
offsets, and EOL-only events do not broadcast. Both native EOL modes are tested.

Y.Text observations supply deltas. The binding checks each delta against its editor
shadow and builds one WorkspaceEdit with separate replacements for disjoint ranges.
Offsets are mapped from canonical LF UTF-16 positions to the editor's LF or CRLF
positions. Explicit room-text selection and CRDT undo use a prefix/suffix fallback.
Edits outside changed ranges remain untouched; editor edits never save.
An asynchronous typing/application race or failed apply pauses the binding and
exposes the original draft and latest paused buffer rather than attempting unsafe
automatic rebasing. Already-dispatched WorkspaceEdits cannot be cancelled; this
is now covered by deterministic delayed-apply tests. A pending remote patch that
lands after local typing, disconnect, disposal, or epoch replacement is followed by
a compensating editor edit where its origin can be tracked safely. The
accepted remote update remains in Y.Text until an explicit room-text choice; no
save or outbound update is made by compensation. The binding keeps its document
listener until the pending edit and compensation settle, then releases it.
An untagged delayed WorkspaceEdit may leave a mixed editor buffer after disposal.
The binding retains up to four recent draft candidates, including the observed
offline draft, and warns that explicit recovery is needed; it does not claim the
mixed buffer converged. This in-memory snapshot is not crash-safe. Disjoint native
patch tests pass for Unicode, LF/CRLF, three selections before/between/after
changed ranges, unchanged text and scroll position. VS Code still owns selection
behavior inside a replaced range; relative cursor anchors remain cutover work.

## Local Edit Origin and Undo

The test editor adapter tags every WorkspaceEdit with a unique origin token. An
identical local insertion during a delayed remote apply is therefore recognized as
local. For the bounded insert/insert case, the binding maps its pre-change offset
past the remote insertion, checks the resulting editor buffer against Y.Text, and
publishes exactly one local Yjs transaction. If that check fails, it pauses and
keeps the draft for explicit resolution. Untagged VS Code change events have no
reliable provenance because TextDocumentChangeEvent carries no edit-origin field.
If any content change arrives while an untagged remote WorkspaceEdit is pending,
the binding pauses, keeps the first observed buffer as the draft and the latest
observed buffer separately, and restores the first after the pending edit settles.
This includes a local edit identical to a pending insertion or replacement. It
never counts a matching event as remote from its text or range alone. The controlled
native layout test supplies a test-only origin token while no user typing occurs;
it does not establish a general VS Code provenance API.
For cutover, keep the explicit pause-and-compare flow for ambiguous events, or use
an authoritative host edit origin/versioned application mechanism if one becomes
available. Never infer origin from matching text alone.

Each client owns a Y.UndoManager scoped to its Y.Text and tracking only local editor
transactions. `undoLocal` and `redoLocal` apply its result to the editor without
saving or adding an editor event to CRDT history. Peer updates and remote
WorkspaceEdits never enter this stack. The stack is destroyed on disconnect,
disposal or epoch replacement; a paused binding refuses undo/redo. Undo-generated
updates still travel to peers. The CRDT commands differ from VS Code's native
`undo`/`redo`: native history includes WorkspaceEdits and may undo a peer's edit.
The prototype registers `codemesh.prototype.undoLocal` and
`codemesh.prototype.redoLocal` only in its native test harness. They resolve the
active TextDocument through a test-only binding map; an ordinary editor receives
no command action. No `Ctrl+Z`/`Ctrl+Y` override, keybinding contribution or
production command is installed. Reliable shortcut routing for just the active
shared document has not been demonstrated, and adapter tests do not establish
native shortcut safety. Native WorkspaceEdits can enter VS Code's own undo stack;
intercepting the built-in `undo` command globally would also affect ordinary
editors unless a verified document-scoped keybinding/context path exists.
The harness has an isolated observational check for what built-in `undo` does after
one. It proved that native Ctrl+Z can remove a peer WorkspaceEdit. The binding now
recognizes VS Code's Undo/Redo change reason and pauses the shared document with
its changed buffer retained as a draft; it does not broadcast that change. This
also quarantines native Undo of a local edit, since the native stack cannot be
proven local-only. Until scoped shortcut routing is established, shared-editor
users must use the explicit CRDT commands. Native shortcuts are safe from echo in
the tested host but interrupt sharing and require explicit draft resolution.

Deterministic binding tests cover a two-range multi-cursor transaction as one
local undo step, consecutive undo/redo, interleaved peer insertion/deletion, and
refusal while paused, disconnected or bound to a new epoch. A failed VS Code
WorkspaceEdit after a Yjs undo now pauses the binding and retains the unsaved
editor draft for explicit resolution; it never stays falsely active. This does
not roll back a CRDT undo that peers may already have accepted. Remote application
does not echo or save. Cursor/selection anchoring across undo patches is open.

## Initial Drafts and Lifecycle

Keep the unsaved editor buffer outside Yjs until initial sync completes. If its
canonical text equals room text, bind without changing the buffer. If different,
preserve the draft and require an explicit choice: use room text, keep the draft
separately and reconcile it, or end sharing. Do not insert both whole strings or
automatically publish the draft. Reconciliation must use current room text and
re-prompt if it changes while the choice is pending; a state vector alone does not
detect deletion-only changes.

Leaving, disconnecting, closing or disposing unobserves both Y.Doc and Y.Text,
destroys replicas and releases references. Last-member exit destroys server state.
Reconnecting requires explicit re-sharing and a new handshake; a new document epoch
rejects frames from discarded state. No persistence or automatic offline replay.

## Limits and Retirement Gate

The prototype imports CodeMesh's limits through its harness: 256 KiB UTF-8 text,
2 MiB for the entire binary frame, and 1024-byte portable relative paths. Staging
forks reject invalid updates before mutation, and encoded full state/history is
also bounded. There is one document per ephemeral room, at most 32 rooms and eight
capabilities/members per room. A room permits at most four incomplete state-vector
joins. There are at most 16 unauthenticated sockets; initial and post-HELLO joins
expire after five seconds. Every socket has a 4 MiB / 32-message outbound bound,
and the server has a 32 MiB aggregate outbound bound,
including `ws.bufferedAmount`; accepted updates remain in the room when a slow
peer is disconnected. The peer keeps its editor draft and must explicitly rejoin
with a fresh state vector and resolve any divergent buffer. Clients use the same
outbound bound and pause without sending a queued-overflow edit. A room pauses after
64 updates in a one-second window; a socket exceeding 128 inbound messages
in that window is disconnected, pausing its room first if needed. No edit rejected
by these limits is reported as converged. Duplicate state updates are not relayed.
Old-epoch queued delivery is discarded by disconnecting the lagging peer during
an approved reset, not by mutating its editor.

The WebSocket parser rejects frames over 2 MiB before application; version, shape,
capability, room, document, epoch and membership checks precede Yjs decoding.
Pending timers, queue counters and capabilities are cleared on leave, disconnect,
last-member exit and disposal. Staging forks copy state per edit and are not a
performance-ready adapter. CPU cost of repeated valid Yjs decoding, aggregate
memory across the room cap, and behavior over a truly congested Internet link
remain cutover work. Draft snapshots are in memory, not crash-safe persistence.

## Explicit Recovery

When a merged update exceeds the text/history cap, the server rejects it atomically
and quarantines the entire room. Clients suspend Y.Text edits, pause bindings and
retain both original local drafts. Divergent frozen replicas are not success.
The owner calls `proposeRecovery` with explicitly reconciled, bounded LF text.
Every connected member inspects the proposal and calls `approveRecovery`; the
client also records its own approval before accepting a reset. One approval alone
does not change state. Any membership change invalidates the proposal and approvals.

After unanimous approval, the server creates a fresh epoch and clients exchange
state vectors again. Old bindings are disposed and editor buffers remain unchanged.
Users explicitly rebind and choose room text, retaining the original draft snapshot;
this makes the buffer dirty but does not save. Stale old-epoch updates are rejected.
An owner can explicitly reconnect during quarantine without publishing any draft,
but cannot edit until a fresh proposal is approved. Last disconnect destroys the
room and its capabilities. History exhaustion uses the same policy, never truncation.

Run `npm run test:crdt` for prototype, binding and real transport tests. For native
checks, set `CODEMESH_VSCODE_PATH` and run `npm run test:crdt:editor`; it reuses the
isolated development-host runner with a test-only suite override. Production
acceptance remains `npm run test:acceptance -w extension` after compilation.

On 2026-10-16, the installed `6d62b1d5da` directory and parent ACLs were
inspected. Electron's ACL fatal occurred only when VS Code inherited Codex's
restricted command-runner token. A temporary `ALL APPLICATION PACKAGES` read/execute
ACE was added only to that commit directory using
`icacls <commit-directory> /grant *S-1-15-2-1:(OI)(CI)(RX)`; it did not fix the
restricted launch. The grant was rolled back with
`icacls <commit-directory> /remove:g *S-1-15-2-1`, and the original ACL was
verified. The unchanged native suite then passed 28/28 outside the command-runner
sandbox with Electron's sandbox still enabled and no installation permission
change retained. An official repair/reinstall is not indicated by this evidence.
The native checks include Day 5 cursor, selections, scroll, unchanged-range and
identical-typing cases and Day 7 explicit history commands. Native Ctrl+Z after a
remote WorkspaceEdit changed only the local buffer, produced zero outgoing Yjs
updates, and paused for recovery; neither editor edit nor resolution saved the file.
Final Day 8 commands: `npm run test:crdt:editor` passed 28/28 native checks when
launched outside Codex's command sandbox; `npm run test:crdt` passed 64/64 tests
and its server, extension and prototype compile checks; and
`npm run test:acceptance -w extension` passed all seven production criteria.

## Day 9 Congestion and Paused-Document UX

The test-only pause flow now exposes the binding's reason. A transport quarantine
uses its specific network/limit error rather than the generic binding warning.
Its modal offers **Inspect Draft**, **Use Room Text**, and **End Sharing**. Inspect
opens an unsaved untitled snapshot beside the shared editor; dismissing the menu
leaves sharing paused and the buffer untouched. Room text is applied only after
the explicit choice, while retaining the draft snapshot. A failed or ambiguous
apply remains paused. End Sharing disposes the binding and disconnects the client.
The warning explains that native Ctrl+Z/Ctrl+Y is not local-only CRDT history;
the prototype Undo Local/Redo Local commands are usable only in an active session.
Choosing room text during quarantine shows a recovery-required warning and stays
paused with the draft intact.
These are prototype-host APIs, not production extension commands or shortcuts.

The new two-client test delays actual WebSocket sends in FIFO order per connection
with fixed latency and jitter. Both bound editor adapters converged after
concurrent inserts and after an undo made while delivery was delayed, with no
remote echo or disk save. A one-second slow-reader delay hit the 32-message
outgoing bound, disconnected that reader, and retained its unchanged draft. A
fresh state-vector join repaired its replica, but the stale editor stayed paused
until Use Room Text. A subsequent unanimous owner-proposed epoch reset again left
the editor unchanged until explicit resolution. The delay shim models a backed-up
send callback, not a physical network or OS receive buffer; process heap/RSS
samples are approximate and include the Node test runner.

In the final `npm run test:crdt` run, the ordered concurrent/undo case converged
in 96 ms and undid in 139 ms; its peak queue was 288 bytes / 2 messages, peak
heap 21,634,832 bytes, and peak RSS 91,504,640 bytes. The slow-reader case
disconnected in 519 ms and rejoined in 4 ms; its peak queue was 4,794 bytes /
32 messages, peak heap 24,783,024 bytes, and peak RSS 92,569,600 bytes. The
message-count bound was exercised; this run did not saturate the 4 MiB byte
bound. Both editor buffers stayed unsaved. The existing synthetic aggregate
budget test still covers the 32 MiB queue cap.

Day 9 commands and results: `npm run test:crdt` passed 67/67, including server,
extension and prototype compile checks; `npm run test:crdt:editor` passed 31/31
native checks outside the restricted runner using `CODEMESH_VSCODE_PATH`; and
`npm run test:acceptance -w extension` passed all seven production criteria.
The first focused congestion run failed only because its test asserted that the
delay queue was drained before its final callback; waiting for drain fixed it.
The first expanded native run executed 30 checks, then failed because its test
tried End Sharing after disconnect had already disposed the binding; the test
order was corrected and the final native run passed 31/31. No production sync
code was changed.

## Day 10 Production Cutover Review

**Decision: NO-GO.** Keep `DOCUMENT_EDIT/ACK/CONFLICT` in production. This review
changed only the isolated prototype and its tests. The binding no longer infers
remote origin from matching patch text, including during explicit room-text
resolution. With no trustworthy origin adapter, any change event during a
pending remote `WorkspaceEdit` pauses the document, keeps draft snapshots,
restores the visible draft after the asynchronous edit when possible, sends no
new local Yjs update, and requires explicit recovery. A failed restoration warns
and leaves the snapshot available; it is not reported as convergence. If room
and local text already agree, an explicit fresh binding can start active without
claiming that two identical edits were separately recorded.

The [public VS Code API](https://code.visualstudio.com/api/references/vscode-api#TextDocumentChangeEvent)
exposes `document`, `contentChanges`, and an optional `reason` that is only
Undo/Redo or `undefined`; it exposes no actor/transaction ID. The native harness
uses a test-only adapter that tags events while its own `applyEdit` promise is
pending. That is a timing assumption, not an API guarantee: an unrelated user,
formatter, IME, or extension edit can arrive inside that interval. Tests using
that adapter prove editor mechanics under an assumed trusted tag, **not** that
production can obtain such a tag. An untagged native same-text extension
`WorkspaceEdit` and a real Format Document action both paused and preserved
their dirty drafts without echo or save, in LF and CRLF. Native Ctrl+Z and
Ctrl+Y after a peer `WorkspaceEdit` left the binding paused, preserved the first
draft snapshot, and sent zero Yjs updates. IME composition and arbitrary third-
party extensions cannot be injected deterministically by this harness.

For the socket probe, the receiving client's actual `ws` TCP socket was paused;
the server used real `socket.send`, not the Day 9 delayed-send shim. One 220 KiB
accepted text edit remained in room state while valid duplicate update frames
filled the slow peer's outbound path. In the final full run, each frame was
225,446 bytes; 18 sends succeeded, peak `ws.bufferedAmount` was 3,607,296
bytes, and the server queue peaked at 4,058,028 bytes / 18 messages before
disconnect, below the 4 MiB / 32-message per-socket caps. The drop took 22 ms.
Peak process heap was 29,954,896 bytes and RSS 93,888,512 bytes (RSS growth
2,035,712 bytes); the probe asserts RSS growth below 128 MiB. The paused peer's
editor and unsaved draft stayed unchanged; explicit state-vector rejoin took
11 ms, then the member deliberately chose room text. These are local loopback
socket measurements. The repeated frames were authorized duplicates injected
at the transport boundary for pressure; they were not new accepted edits or a
remote WAN/OS receive-buffer benchmark.

| Requirement | Evidence | Remaining risk | Status |
| --- | --- | --- | --- |
| Reliable edit origin | No public origin field; native same-text extension and formatting races pause; text-match inference removed | Timing-tag adapter can misattribute concurrent edits; IME and third-party cases unproven | **BLOCK** |
| Local-only undo/redo | Yjs undo manager and native prototype commands preserve peer edits, including multi-cursor transactions | Commands depend on a trustworthy editor transaction boundary | **PASS in prototype** |
| Native Ctrl+Z/Ctrl+Y | Native host quarantines both actions after peer `WorkspaceEdit`, keeps first draft, no echo/save | Standard shortcuts still operate on VS Code's native history, not local-only Yjs history | **BLOCK** |
| Cursor, selections, scroll, LF/CRLF | Native disjoint-patch checks preserve three selections, unchanged text, scroll and EOL | IME, accessibility and physical two-host interaction not exercised | **PASS in single host** |
| Recovery and drafts | Over-cap merge needs owner proposal and unanimous approval; disconnect/rejoin and native pause choices retain drafts | Snapshots are in memory only; human modal click-through not done | **PASS in prototype** |
| Transport bounds | Real paused-TCP probe reached 4,058,028/4,194,304 queued bytes before drop; state-vector rejoin recovered one accepted edit | WAN stalls, valid-update CPU and multi-room memory not benchmarked | **PASS on loopback** |
| Physical two-host visual validation | No physical two-host run performed | Cross-host UI, IME, focus and modal interaction remain unknown | **BLOCK** |
| Production protocol cutover | Production acceptance still passes all seven revision-protocol criteria | No mode negotiation or mixed-version deployment test | **BLOCK** |

Day 10 final commands: `npm run test:crdt` passed **68/68** and ran server,
extension, and prototype compile checks; `npm run test:crdt:editor` passed
**35/35 native checks actually executed** outside the restricted runner with
`CODEMESH_VSCODE_PATH` set; `npm run test:acceptance -w extension` passed
**7/7**. The first expanded native attempt executed ten checks before a test
assumption failed: an explicitly rebound identical draft was already equal to
room text and correctly started active. The assertion was fixed, and the final
native run passed. No failed VS Code launch was counted as a check.

The smallest implementation experiment that could change this decision is a
prototype-only, transaction-owned editing surface (for example, a custom text
editor) with a verifiable source for every applied change and scoped local-only
undo. It must pass real-host identical typing, formatting, third-party edit,
IME, native shortcut, and delayed-apply tests without relying on event text or
timing. Only then should mode negotiation and a physical two-host visual check
be considered for a production cutover.

Retire revisions only after an opt-in, separately versioned transport and real
two-editor tests pass concurrency, initial drafts, rapid/delayed edits, EOL/Unicode,
cursor/selection/scroll anchoring, reliable edit-origin handling, scoped undo
routing (or a UX that clearly surfaces native-shortcut quarantine), failed-apply
recovery, no echo/save, limits and cleanup. The 35 Day 10 native single-host checks pass,
but reliable origin tagging for arbitrary VS Code WorkspaceEdits, multi-host
visual behavior, physical two-host acceptance, and actual human selection of the
modal choices remain open. The test host exercised choice actions in real VS Code,
but did not automate a click on the native warning modal. Performance under
valid-update bursts and true WAN backpressure, plus in-memory draft loss on
process crash, remain risks.
Mixed old/new clients must not edit one document; negotiate one mode before
sharing. Keep the revision path as a fallback until these gates pass. Do not
dual-publish full text and Yjs updates for the same session.

API references: [Yjs updates](https://docs.yjs.dev/api/document-updates) and
[Y.Doc lifecycle](https://docs.yjs.dev/api/y.doc).
