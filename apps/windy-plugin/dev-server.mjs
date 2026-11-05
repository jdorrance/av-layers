import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const certDir = resolve('/tmp', 'av-windy-plugin-cert');
const keyPath = resolve(certDir, 'key.pem');
const certPath = resolve(certDir, 'cert.pem');

if (!existsSync(keyPath) || !existsSync(certPath)) {
  mkdirSync(certDir, { recursive: true });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '30',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { stdio: 'inherit' });
}

const files = new Map([
  ['/plugin.js', ['plugin.min.js', 'text/javascript; charset=utf-8']],
  ['/plugin.min.js', ['plugin.min.js', 'text/javascript; charset=utf-8']],
  ['/plugin.min.js.map', ['plugin.min.js.map', 'application/json; charset=utf-8']],
  ['/plugin.json', ['plugin.json', 'application/json; charset=utf-8']]
]);

const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
  const path = new URL(request.url ?? '/', 'https://localhost').pathname;
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-private-network': 'true',
    'access-control-allow-methods': 'GET, OPTIONS',
    'cache-control': 'no-store'
  };
  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers);
    response.end();
    return;
  }
  const file = files.get(path);
  if (!file || request.method !== 'GET') {
    response.writeHead(404, headers);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { ...headers, 'content-type': file[1] });
  response.end(readFileSync(resolve(root, 'dist', file[0])));
});

server.listen(9999, '127.0.0.1', () => {
  process.stdout.write('https://127.0.0.1:9999/plugin.js\n');
});
