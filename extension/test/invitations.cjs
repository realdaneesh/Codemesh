const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInviteLink, parseInviteLink } = require('../dist/services/invitations');
test('invitation round trip and strict secure relay URL', () => {
  const token = 'a'.repeat(43);
  const link = createInviteLink('vscode://codemesh.codemesh/join', 'wss://relay.example', token);
  assert.deepEqual(parseInviteLink(link), { server: 'wss://relay.example/', token });
  for (const value of [link.replace('wss', 'ws'), link + '&token=duplicate', link.replace('codemesh.codemesh', 'evil.extension'), link.replace(token, 'bad')]) assert.throws(() => parseInviteLink(value));
  assert.throws(() => createInviteLink('https://example.com', 'wss://relay.example', token));
});
