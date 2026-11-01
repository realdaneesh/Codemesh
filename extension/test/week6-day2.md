# Week 6 Day 2: explicit combined-text proposals

Production single-file sync still uses DOCUMENT_EDIT / DOCUMENT_ACK /
DOCUMENT_CONFLICT. No files under prototypes/yjs were changed.

The client remembers confirmed text separately from its current buffer and queued
edits. A matching initial sync, a successfully applied room edit, or an ACK for
the exact sent text establishes a base. An ACK never confirms subsequently typed
text. Ending, switching, disconnecting or pausing sharing discards that base.
Divergent initial sync requires manual choice. Obsolete conflicts cannot regress
the room revision.

Conflicts explain why a combined proposal is unavailable, or offer **Preview
Combined Text**. The preview is a read-only diff between **My unsaved draft** and
**Proposed combined text**, labeled with the relative path and room revision.
The preview can also be reopened from Room Actions or the Command Palette.
Only **Apply and Share Combined Text** authorizes changing the unsaved buffer
and sending one edit. Cancel and Reject Proposal leave sharing blocked, retain
the original draft and current room text, and send nothing. Preview text never
enters presence or logs.

Approvals belong to a specific proposal, conflict, room, path and share-session
generation. Draft changes, newer room text, a replacement comparison or session
termination invalidate them. The client checks identity and revision before
applying, after the asynchronous editor edit, and synchronously at the send
boundary. The server's existing baseRevision check still rejects changes that
race with frames the client has not received. Comparisons are marked STALE when
new room text arrives or sharing ends.

The comparison is intentionally conservative:

- Work on LF-normalized whole lines; restore the source editor's LF/CRLF when
  applying. Unicode text remains intact.
- Treat each side's changes as one enclosing range and require at least one
  untouched line between the ranges.
- Require manual choice for same-line, overlapping or adjacent changes, repeated
  lines (including repeated blank lines), moved/reused lines, uncertain multiple
  hunks, missing bases and proposals above the document size limit.
- This does not check syntax or semantic compatibility. Some valid combinations
  are deliberately withheld. No silent conflict resolution was added.

Validation completed on 2026-10-18:

| Check | Exact count in the final passing suite/run |
| --- | --- |
| `npm run compile` | 2 compiles: server and extension |
| `npm run test:conflict -w extension` | 19 proposal tests + 21 sync scenarios = 40 |
| Sync scenario breakdown | 9 existing + 9 combined approval lifecycle + 3 manual fallback |
| `node server/test/document-sync.cjs` | 2 reported server sync check groups |
| `node extension/test/live-sync-acceptance.cjs` | 8 production acceptance groups |
| `server/test/smoke.cjs` against an ephemeral production server | 1 smoke suite |
| `npm run test:editor -w extension` | 37 native check groups, including 6 new combined-preview groups |

The 19 proposal tests cover separated insertions/deletions/replacements,
same-line edits, adjacent ranges, overlap, repeated/reordered lines, Unicode,
CRLF/LF, missing bases, unchanged sides, multiple hunks, final-newline handling,
empty bases and size limits. Sync tests cover rejected/dismissed proposals,
explicit approval, changing room/draft text, re-sharing, disconnect, stale
approvals during asynchronous editor application, and the exact ACKed base.
Manual fallback tests verify explanations and all three existing choices.

Production acceptance verifies competing separated edits through the real server:
rejection preserves both drafts, then explicit approval sends exactly one combined
edit and both clients converge. Native tests verify readonly documents and real
dialogs, LF/CRLF application, rejection, dismissal, obsolete approvals and
disconnect. Conflict/combined operations produced **zero native save events**;
source disk bytes remained unchanged. Acceptance also checks zero save calls and
unchanged source disk bytes. Fixture setup and unrelated explicit import tests
intentionally write files and are outside that assertion.

Two native runs completed successfully: **37 distinct check groups per run,
74 successful native group executions total**. Reports:

- First: `C:\Users\danee\AppData\Local\Temp\codemesh-editor-U9UQKV\result.json`
- Final: `C:\Users\danee\AppData\Local\Temp\codemesh-editor-7DJBLJ\result.json`

Limitations: if room text changes while an already approved local editor edit
is completing, the approved edit may remain in the unsaved buffer, but no combined
edit is sent. Sharing stays blocked and the original draft remains recoverable
in the readonly snapshot. A fresh comparison is required. Snapshots are local
in-memory recovery, not crash-persistent storage.

Remaining manual visual check: review the longer approval buttons, diff labels,
path/revision title and STALE banner at narrow widths and in the user's theme.
No human visual review or language-level merge validation was performed.
