const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { CollaborationServer } = require('../dist/websocket/CollaborationServer');
const key = 'test-only-host-key-32-bytes-xxxxxxxx';
const pause = ms => new Promise(r => setTimeout(r, ms));

async function fixture(t, ttl = 300000) {
  const server = new CollaborationServer(0, { host: '127.0.0.1', cloud: { hostKey: key, inviteTtlMs: ttl } });
  server.start(); await once(server.server, 'listening');
  const port = server.server.address().port;
  const peers = [];
  t.after(async () => { for (const p of peers) p.socket.terminate(); server.shutdown(); await pause(30); });
  async function peer() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = []; socket.on('message', b => messages.push(JSON.parse(b)));
    await once(socket, 'open');
    const p = { socket, messages, send: value => socket.send(JSON.stringify(value)), async take(type) {
      const end = Date.now() + 2500;
      while (Date.now() < end) { const i = messages.findIndex(m => m.type === type); if (i >= 0) return messages.splice(i, 1)[0]; await pause(5); }
      throw new Error(`Missing ${type}: ${messages.map(m => m.type)}`);
    } }; peers.push(p); return p;
  }
  async function host() {
    const p = await peer(); p.send({ type: 'AUTH_CREATE', key, displayName: 'Host' });
    p.auth = await p.take('AUTH_SESSION'); p.room = await p.take('ROOM_CREATED'); p.invite = await p.take('INVITATION'); return p;
  }
  return { server, port, peer, host };
}

test('cloud fails closed without host key', () => assert.throws(() => new CollaborationServer(0, { cloud: { hostKey: '' } }), /HOST_KEY/));
test('expired membership cannot receive outbound room data', () => {
  const { CloudAccess } = require('../dist/cloudAccess');
  let room; const socket = { send() {}, close() {} };
  const access = new CloudAccess(key, () => room, () => 1);
  access.filter(socket, JSON.stringify({ type: 'AUTH_CREATE', key, displayName: 'Host' }));
  room = 'ABC234'; access.bindCreated(socket, room);
  assert.equal(access.canReceive(socket), true);
  const now = Date.now;
  try { const future = now() + 8 * 60 * 60 * 1000 + 1; Date.now = () => future;
    assert.equal(access.canReceive(socket), false);
    assert.throws(() => access.filter(socket, JSON.stringify({ type: 'CREATE_INVITE' })), /rejected/);
  } finally { Date.now = now; }
});
test('deployment entry point rejects unsafe environment configuration', () => {
  const { spawnSync } = require('node:child_process');
  for (const settings of [
    { CODEMESH_MODE: 'cloud', PORT: '10000', CODEMESH_HOST_KEY: '' },
    { CODEMESH_MODE: 'cloud', PORT: '0', CODEMESH_HOST_KEY: key },
    { CODEMESH_MODE: 'cloud', PORT: '10000', CODEMESH_HOST_KEY: key, CODEMESH_HOST: '127.0.0.1' },
    { CODEMESH_MODE: 'other' }, { CODEMESH_MODE: 'lan', NODE_ENV: 'production' }
  ]) {
    const result = spawnSync(process.execPath, [require.resolve('../dist/index')], { env: { ...process.env, ...settings }, encoding: 'utf8', timeout: 4000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /Startup rejected/); assert.ok(!result.stderr.includes(key));
  }
});
test('production entry point binds platform PORT and serves health', async t => {
  const net = require('node:net');
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, CODEMESH_MODE: 'cloud', CODEMESH_HOST_KEY: key, NODE_ENV: 'production', PORT: String(port) };
  delete env.CODEMESH_HOST; delete env.CODEMESH_PORT;
  const child = require('node:child_process').spawn(process.execPath, [require.resolve('../dist/index')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
  const end = Date.now() + 5000;
  while (!logs.includes('relay ready') && Date.now() < end) await pause(10);
  assert.match(logs, /Authenticated cloud relay ready/); assert.ok(!logs.includes(key));
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { status: 'ok' });
});
test('hosted listener health, authenticated admission, replay, isolation, spoofing, revocation and resume', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/health`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/rooms`)).status, 404);
  const host = await f.host(); const attacker = await f.peer();
  attacker.send({ type: 'JOIN_ROOM', roomId: host.room.roomId, member: host.room.member }); await attacker.take('ERROR');
  attacker.send({ type: 'AUTH_CREATE', key: 'bad', displayName: 'Host' }); await attacker.take('ERROR');
  attacker.send({ type: 'OPEN_DOCUMENT', roomId: host.room.roomId, documentPath: 'secret.txt', text: '' }); await attacker.take('ERROR');
  attacker.send({ type: 'AUTH_JOIN', token: host.invite.token, displayName: 'Host' }); await attacker.take('ERROR');
  attacker.send({ type: 'AUTH_JOIN', token: host.invite.token, displayName: 'Host [host]' }); await attacker.take('ERROR');
  const guest = await f.peer();
  guest.send({ type: 'AUTH_JOIN', token: host.invite.token, displayName: 'Guest', memberId: host.room.member.memberId, role: 'host' });
  const auth = await guest.take('AUTH_SESSION'); const joined = await guest.take('ROOM_JOINED');
  assert.notEqual(joined.member.memberId, host.room.member.memberId);
  assert.equal(host.room.member.role, 'host'); assert.equal(joined.member.role, 'guest');
  attacker.send({ type: 'AUTH_JOIN', token: host.invite.token, displayName: 'Replay' }); await attacker.take('ERROR');
  guest.send({ type: 'CREATE_INVITE' }); await guest.take('ERROR');
  const other = await f.host();
  guest.send({ type: 'OPEN_DOCUMENT', roomId: other.room.roomId, documentPath: 'secret.txt', text: '' }); await guest.take('ERROR');
  guest.send({ type: 'OPEN_DOCUMENT', roomId: joined.roomId, documentPath: 'shared.txt', text: 'baseline', shareSessionId: '11111111-1111-4111-8111-111111111111' });
  await guest.take('DOCUMENT_SYNC');
  host.send({ type: 'OPEN_DOCUMENT', roomId: joined.roomId, documentPath: 'shared.txt', text: 'baseline', shareSessionId: '22222222-2222-4222-8222-222222222222' }); await host.take('DOCUMENT_SYNC');
  guest.send({ type: 'DOCUMENT_EDIT', roomId: joined.roomId, documentPath: 'shared.txt', text: 'guest draft', baseRevision: 0, shareSessionId: '11111111-1111-4111-8111-111111111111' });
  host.send({ type: 'DOCUMENT_EDIT', roomId: joined.roomId, documentPath: 'shared.txt', text: 'host draft', baseRevision: 0, shareSessionId: '22222222-2222-4222-8222-222222222222' });
  await pause(60);
  assert.equal([...guest.messages, ...host.messages].filter(m => m.type === 'DOCUMENT_ACK').length, 1);
  assert.equal([...guest.messages, ...host.messages].filter(m => m.type === 'DOCUMENT_CONFLICT').length, 1);
  guest.socket.terminate(); await pause(40);
  const resumed = await f.peer(); resumed.send({ type: 'AUTH_RESUME', credential: auth.credential });
  const rotated = await resumed.take('AUTH_SESSION'); assert.notEqual(rotated.credential, auth.credential);
  assert.equal((await resumed.take('ROOM_JOINED')).member.memberId, joined.member.memberId);
  attacker.send({ type: 'AUTH_RESUME', credential: auth.credential }); await attacker.take('ERROR');
  host.send({ type: 'CREATE_INVITE' }); const invite = await host.take('INVITATION');
  host.send({ type: 'REVOKE_INVITES' }); await pause(20);
  attacker.send({ type: 'AUTH_JOIN', token: invite.token, displayName: 'Revoked' }); await attacker.take('ERROR');
  host.send({ type: 'LEAVE_ROOM' }); await once(resumed.socket, 'close');
  assert.ok(!attacker.messages.some(m => ['ROOM_JOINED','WORKSPACE_MANIFEST','SHARED_FILES','DOCUMENT_SYNC'].includes(m.type)));
});

test('expired invitations, malformed and oversized frames, rate limits and restart invalidation', async t => {
  const f = await fixture(t, 30); const host = await f.host(); await pause(60);
  const p = await f.peer(); p.send({ type: 'AUTH_JOIN', token: host.invite.token, displayName: 'Expired' }); await p.take('ERROR');
  p.socket.send('{"key":"must-not-appear-in-errors"'); assert.ok(!JSON.stringify(await p.take('ERROR')).includes('must-not-appear'));
  const second = await fixture(t); const stale = await second.peer(); stale.send({ type: 'AUTH_RESUME', credential: host.auth.credential }); await stale.take('ERROR');
  const oversized = await f.peer(); const closed = once(oversized.socket, 'close'); oversized.socket.send('x'.repeat(3 * 1024 * 1024)); assert.equal((await closed)[0], 1009);
  const flood = await f.host(); const limited = once(flood.socket, 'close'); for (let i = 0; i < 125; i++) flood.send({ type: 'CREATE_INVITE' }); assert.equal((await limited)[0], 1008);
});

test('capacity is eight participants and abandoned rooms invalidate their credentials', async t => {
  const f = await fixture(t); const host = await f.host();
  const guests = [];
  for (let i = 0; i < 7; i++) {
    if (i > 0) { host.send({ type: 'CREATE_INVITE' }); host.invite = await host.take('INVITATION'); }
    const guest = await f.peer(); guest.send({ type: 'AUTH_JOIN', token: host.invite.token, displayName: `Guest ${i}` });
    await guest.take('ROOM_JOINED'); guests.push(guest);
  }
  host.send({ type: 'CREATE_INVITE' }); const invite = await host.take('INVITATION');
  const ninth = await f.peer(); ninth.send({ type: 'AUTH_JOIN', token: invite.token, displayName: 'Ninth' }); await ninth.take('ERROR');
  for (const guest of guests) guest.socket.terminate(); host.socket.terminate(); await pause(40);
  ninth.send({ type: 'AUTH_RESUME', credential: host.auth.credential }); await ninth.take('ERROR');
  ninth.send({ type: 'AUTH_JOIN', token: invite.token, displayName: 'Stale room' }); await ninth.take('ERROR');
});
