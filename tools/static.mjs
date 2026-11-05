// Throwaway static file server for previewing panel/ui in a real Chromium.
//   node tools/static.mjs [port] [root]
// ES modules cannot be loaded from file:// (CORS), so the preview needs http.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] || 2010);
const root = path.resolve(process.argv[3] || 'panel/ui');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

http
  .createServer(async (req, res) => {
    try {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
      const file = path.resolve(root, rel);
      if (!file.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`preview on http://127.0.0.1:${port}`));
