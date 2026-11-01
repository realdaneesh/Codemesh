# Week 6 Day 3: recover an applied proposal that was never shared

Production remains on DOCUMENT_EDIT / DOCUMENT_ACK / DOCUMENT_CONFLICT.
No automatic merging was added and prototypes/yjs was left untouched.

When a newer room revision arrives during an approved combined editor edit,
CodeMesh keeps synchronization blocked and sends no stale proposal. The approved
edit can finish in the unsaved editor; recovery never saves, overwrites or
silently restores that buffer. A dedicated notice and persistent Live Sync
sidebar status distinguish **in my editor** from **shared with the room**:

> An approved proposed combination was applied to your unsaved editor, but was NOT shared with the room. Sharing is paused. No file was saved or restored.

The notice offers **Inspect Preserved Versions**, **Start Fresh Comparison** and
**End Sharing**. Cancel leaves the buffer and all snapshots intact. While the
approved editor edit is completing, generic conflict prompts are suppressed so
they cannot misdescribe the newly applied proposal as the original local draft.

Inspect Preserved Versions opens two read-only diffs:

- Original local draft versus the applied proposal, labeled **NOT shared**.
- Applied proposal versus the latest known room text, labeled with its revision.

This action is also available through the sidebar, Room Actions and **CodeMesh:
Inspect Preserved Versions** in the Command Palette. After End Sharing, the last
recovery versions remain inspectable through the command and Room Actions;
archived room text is a snapshot of the last known revision, not a live feed.

Further room changes replace only the current room snapshot, mark the previous
room comparison stale, and keep the original draft and applied proposal available.
A fresh comparison uses the current editor buffer and latest room text; its
dialog still says that the editor proposal has NOT been shared. Opening it does
not send or apply anything. Existing explicit conflict choices remain available
after that comparison. Notices and choices are bound to their original conflict,
room, file and share session; obsolete actions cannot end or alter a later session.
No draft text is added to presence or logs.

Validation on 2026-10-18:

| Check | Exact result |
| --- | --- |
| Affected workspace compilation | Extension compile passed; server source/protocol unchanged |
| `npm run test:conflict -w extension` | 19 proposal tests + 27 sync scenarios = **46 passed** |
| New focused recovery scenarios | **6 passed**: dismissal/inspection, repeated revisions, fresh comparison, End Sharing, delayed notice after re-share, session end during apply |
| `node extension/test/live-sync-acceptance.cjs` | **9 production acceptance groups passed**, including the new asynchronous apply/revision recovery race |
| Targeted native editor flow | **6 check groups executed and passed** in one completed run |
| Shared-file sidebar regression | Passed; checked because recovery adds sidebar state/actions |

The native run used real VS Code documents, dialogs, readonly diffs and the real
production server. A wrapper awaited the real editor edit and held its completion
until a peer room revision arrived, making the race deterministic. It checked the
NOT shared notice and sidebar, dismissal, three preserved versions, readonly typing,
repeated room revisions through revision 4, fresh comparison, and session end.
It observed **zero recovery editor edits**, **zero native save events**, unchanged
source disk bytes, and **zero proposal sends**. Production acceptance separately
verified that one client retained the unsent combination while its peer retained
the newer room text, with zero saves and unchanged disk.

Native report: `C:\Users\danee\AppData\Local\Temp\codemesh-editor-b9SZ5K\result.json`.
An initial harness setup attempt executed **0 checks**: enumerating VS Code workspace
getters touched a guarded proposed API. The harness now intercepts only applyEdit;
no proposed API permission or production configuration was added. Thus there were
two launch attempts, one completed native flow, and six actual native check-group
executions. Broader suites, smoke and server compilation were not rerun because
this change is confined to extension conflict recovery and its UI.
The sidebar regression fixture initially lacked the existing typingMemberIds
state field; it was updated and now checks recovery visibility as well as the
existing member paths and reconnect behavior.

Recovery is in-memory and lasts for this client instance; it is not crash-persistent
storage. Preserved diffs never replace the active editor. Ending sharing stops
updates to the archived room snapshot. The line-range proposal limitations from
Day 2 remain unchanged.

Still open:

- **15-minute physical two-host stability test** — not performed by this run.
- **Narrow-window visual review** — notice buttons, diff titles and persistent
  sidebar warning still need a human readability check in the user's theme.
