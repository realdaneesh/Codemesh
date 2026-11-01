const assert = require('node:assert/strict');
const { test } = require('node:test');
const WebSocket = require('ws');
const { readListenConfig, validateListenHost } = require('../dist/listenConfig');
const { CollaborationServer } = require('../dist/websocket/CollaborationServer');

test('default runtime settings are loopback on port 3977', () => {
  assert.deepEqual(readListenConfig({}), { host: '127.0.0.1', port: 3977 });
});
test('LAN binding requires an explicit private interface address', () => {
  for (const host of ['10.1.2.3', '172.16.0.2', '172.31.255.2', '192.168.1.10']) {
    assert.deepEqual(readListenConfig({ CODEMESH_HOST: host, CODEMESH_PORT: '3978' }), { host, port: 3978 });
  }
  assert.equal(validateListenHost('::1'), '::1');
});
for (const host of ['0.0.0.0', '::', '8.8.8.8', '172.32.0.1', 'example.com', '']) {
  test(`refuses wildcard, public or invalid listener ${JSON.stringify(host)}`, () => {
    assert.throws(() => new CollaborationServer(0, { host }), /CODEMESH_HOST/);
  });
}
test('invalid runtime ports fail before listening', () => {
  for (const port of ['0', '-1', '65536', '1.5', 'abc', '']) {
    assert.throws(() => readListenConfig({ CODEMESH_PORT: port }), /CODEMESH_PORT/);
  }
});
test('actual default listener is IPv4 loopback and localhost clients still connect', async () => {
  const server = new CollaborationServer(0);
  server.start();
  await new Promise((resolve, reject) => { server.server.once('listening', resolve); server.server.once('error', reject); });
  let socket;
  try {
    const address = server.server.address();
    assert.equal(address.address, '127.0.0.1');
    socket = new WebSocket(`ws://localhost:${address.port}`);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  } finally {
    socket?.terminate();
    for (const peer of server.server.clients) peer.terminate();
    await new Promise(resolve => server.server.close(resolve));
  }
});
