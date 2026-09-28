import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT || 4187);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
if (!existsSync(resolve(root, 'index.html'))) throw new Error('Missing dist directory. Run npm install and npm run build first.');
const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('Invalid URL'); return; }
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ app: 'tennis-shoe-explorer', version: '1.0.0' })); return;
  }
  const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': statSync(file).size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`ALAB shoe explorer is ready: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
