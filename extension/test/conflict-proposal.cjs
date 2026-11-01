const assert = require('node:assert/strict');
const { test } = require('node:test');
const { proposeCombinedText } = require('../dist/services/conflictProposal');
const base = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
const cases = [
  ['separated insertions', base, 'mine\n' + base, base + 'room\n', 'mine\n' + base + 'room\n'],
  ['separated deletions', base, base.replace('alpha\n', ''), base.replace('epsilon\n', ''), 'beta\ngamma\ndelta\n'],
  ['separated replacement and deletion', base, base.replace('alpha', 'mine'), base.replace('epsilon\n', ''), 'mine\nbeta\ngamma\ndelta\n'],
  ['same-line edits', 'hello world\n', 'HELLO world\n', 'hello WORLD\n', /same line/],
  ['adjacent replacements', base, base.replace('alpha', 'mine'), base.replace('beta', 'room'), /adjacent/],
  ['adjacent insertion and deletion', base, 'mine\n' + base, base.replace('alpha\n', ''), /adjacent/],
  ['overlapping deletion', base, base.replace('alpha\nbeta\n', ''), base.replace('beta\ngamma\n', ''), /overlap/],
  ['repeated lines', 'same\nx\nsame\ny\n', 'mine\nx\nsame\ny\n', 'same\nx\nsame\nroom\n', /Repeated/],
  ['repeated blank lines', 'a\n\nb\n\nc\n', 'mine\n\nb\n\nc\n', 'a\n\nb\n\nroom\n', /Repeated/],
  ['moved line', base, 'beta\nalpha\ngamma\ndelta\nepsilon\n', base + 'alpha\n', /Repeated|Moved/],
  ['reordered lines inside changed range', base, 'beta\nalpha\ngamma\ndelta\nepsilon\n', base.replace('epsilon', 'room'), /Moved/],
  ['Unicode including combining characters and emoji', base, base.replace('alpha', '中文 🚀 e\u0301'), base.replace('epsilon', '😀 room'), '中文 🚀 e\u0301\nbeta\ngamma\ndelta\n😀 room\n'],
  ['CRLF base and draft with LF room', base.replaceAll('\n', '\r\n'), base.replace('alpha', 'mine').replaceAll('\n', '\r\n'), base.replace('epsilon', 'room'), 'mine\nbeta\ngamma\ndelta\nroom\n'],
  ['missing common base', undefined, 'mine', 'room', /common base/],
  ['unchanged side', base, base, base.replace('epsilon', 'room'), /distinct changes/],
  ['multiple local hunks enclosing remote range', base, base.replace('alpha', 'mine').replace('epsilon', 'end'), base.replace('gamma', 'room'), /overlap|uncertain/],
  ['no final newline', base.trimEnd(), base.trimEnd().replace('alpha', 'mine'), base.trimEnd().replace('epsilon', 'room'), 'mine\nbeta\ngamma\ndelta\nroom'],
  ['empty base', '', 'mine', 'room', /adjacent|overlap/],
  ['combined size limit', base, 'x'.repeat(140000) + '\n' + base, base + 'y'.repeat(140000), /size limit/]
];
for (const [name, common, mine, room, expected] of cases) test(name, () => {
  const result = proposeCombinedText(common, mine, room);
  if (expected instanceof RegExp) { assert.match(result.reason, expected); assert.equal(result.text, undefined); }
  else { assert.equal(result.text, expected); assert.equal(result.reason, undefined); }
});
