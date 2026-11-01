// Generate disposable TLS material outside the repository. Never disable TLS verification.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemesh-cloud-tls-'));
try {
  const gitOpenSSL = 'C:/Program Files/Git/usr/bin/openssl.exe';
  const openssl = process.platform === 'win32' && fs.existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl';
  const key = path.join(temp, 'key.pem'), cert = path.join(temp, 'cert.pem');
  const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  if (generated.status !== 0) throw new Error('Cloud TLS tests require OpenSSL on PATH (or Git for Windows OpenSSL).');
  const result = spawnSync(process.execPath, ['--test', 'server/test/cloud-relay.cjs', 'extension/test/invitations.cjs', 'extension/test/cloud-client.cjs'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, CODEMESH_TEST_TLS_KEY: key, CODEMESH_TEST_TLS_CERT: cert }
  });
  process.exitCode = result.status ?? 1;
} finally {
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('codemesh-cloud-tls-')) fs.rmSync(resolved, { recursive: true });
}
