import { MAX_DOCUMENT_BYTES, normalizeDocumentText } from "../types/syncLimits";

export type ConflictProposal = { text: string; reason?: never } | { text?: never; reason: string };
interface Change { start: number; end: number; lines: string[] }

// Deliberately conservative: one enclosing line range per side, unique lines,
// and at least one untouched line between ranges. This is text inspection, not
// syntax analysis; uncertain alignment must remain a manual decision.
export function proposeCombinedText(base: string | undefined, draft: string, room: string): ConflictProposal {
  if (base === undefined) return { reason: "No trustworthy confirmed common base is available; choose manually." };
  const split = (text: string) => normalizeDocumentText(text).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const original = split(base), mine = split(draft), theirs = split(room);
  for (const lines of [original, mine, theirs]) {
    const seen = new Set<string>();
    for (const line of lines) {
      const key = line.replace(/\n$/, "");
      if (seen.has(key)) return { reason: "Repeated lines make range alignment ambiguous; choose manually." };
      seen.add(key);
    }
  }
  const change = (lines: string[]): Change => {
    let start = 0, end = original.length, tail = lines.length;
    while (start < end && start < tail && original[start] === lines[start]) start++;
    while (end > start && tail > start && original[end - 1] === lines[tail - 1]) { end--; tail--; }
    return { start, end, lines: lines.slice(start, tail) };
  };
  const a = change(mine), b = change(theirs);
  if ((a.start === a.end && !a.lines.length) || (b.start === b.end && !b.lines.length)) {
    return { reason: "Both sides must have distinct changes from the common base; choose manually." };
  }
  const originalPositions = new Map(original.map((line, index) => [line, index]));
  for (const edit of [a, b]) {
    if (edit.lines.some(line => {
      const index = originalPositions.get(line);
      return index !== undefined;
    })) {
      return { reason: "Moved or reused lines make the structure uncertain; choose manually." };
    }
  }
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  if (first.end >= second.start) {
    return { reason: "Changes overlap, touch adjacent ranges, or affect the same line; choose manually." };
  }
  const text = original.slice(0, first.start).concat(first.lines,
    original.slice(first.end, second.start), second.lines, original.slice(second.end)).join("");
  if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) return { reason: "Combined text exceeds the shared document size limit; choose manually." };
  return { text };
}
