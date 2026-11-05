// Tiny HTTP server that backs the control panel: serves the static page, hands
// out the current state, and accepts button presses.
//
//   GET  /            the panel page (panel/ui)
//   GET  /state       { bridge, client, wallpaper, ports, pin, paused, ... }
//   POST /action      { action: "pause" | "resume" | "restore" | "log" }
//
// It also mirrors every state payload to runtime/state.json with a heartbeat, so
// the panel (or `tail`) can tell "bridge died" from "bridge is thinking".
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export function createPanel({ port, uiDir, stateFile, onAction, log = () => {} }) {
  let state = { heartbeat: 0 };
  let dir = uiDir;

  if (stateFile) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    } catch {}
  }

  function writeStateFile() {
    if (!stateFile) return;
    try {
      // write-then-rename so a reader never sees half a file
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch {}
  }

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/state') {
      res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(state));
      return;
    }

    if (url === '/action' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => {
        body += d;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', async () => {
        let payload = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch {}
        try {
          const result = await onAction?.(payload.action, payload);
          res.writeHead(200, { 'Content-Type': TYPES['.json'] });
          res.end(JSON.stringify({ ok: true, result: result ?? null }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': TYPES['.json'] });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // static
    try {
      const rel = url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, '');
      const file = path.resolve(dir, rel);
      if (!file.startsWith(path.resolve(dir))) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  server.on('error', (e) => log('panel: ' + e.message));

  const p = new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      log(`panel on http://127.0.0.1:${port}`);
      resolve(true);
    });
  });

  return {
    server,
    listening: p,
    url: `http://127.0.0.1:${port}/`,
    setState(next) {
      state = { ...next, heartbeat: Date.now() };
      writeStateFile();
    },
    getState() {
      return state;
    },
  };
}
