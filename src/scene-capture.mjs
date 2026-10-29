// Turns a Wallpaper Engine "scene" wallpaper into an MJPEG stream the page can use.
//
//   wallpaper64.exe -control openWallpaper -file <scene.pkg> -playInWindow -width 1920 -height 1080
//        │
//        ├─ SceneCapture.exe   (PrintWindow + JPEG, runs as a child of this process)
//        │      stdout: [u32 len][jpeg] …
//        └─ http://127.0.0.1:2001/frame   multipart/x-mixed-replace  →  <img src>
//
// The pop-out window is parked far off-screen, so nothing ever shows on the
// desktop; the browser decodes the MJPEG natively, so no per-frame JS is needed.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sceneExe, weExe } from './paths.mjs';

const EXE = sceneExe();

// WE's -x/-y are not accepted by openWallpaper (passing them yields a minimized
// 160x28 window), so SceneCapture.exe parks the window itself right after it
// appears — that costs one frame of it sitting at its default spot.
const BOUNDARY = 'neframe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSceneCapture({ port = 2001, fps = 60, quality = 80, log = () => {} } = {}) {
  const clients = new Set();
  let child = null;
  let buf = Buffer.alloc(0);
  let size = { w: 0, h: 0 };
  let frames = 0;
  let lastFrameAt = 0;
  let startedAt = 0;
  let currentPkg = '';
  let stalled = false;

  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/frame')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('no');
      return;
    }
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
    });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    req.on('error', () => clients.delete(res));
  });
  // an MJPEG response never finishes: Node's default request timeout would kill it
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.listen(port, '127.0.0.1');

  function feed(jpg) {
    if (!clients.size) return;
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`,
      'latin1'
    );
    const packet = Buffer.concat([head, jpg, Buffer.from('\r\n', 'latin1')]);
    for (const res of clients) {
      // a stalled reader must not grow our memory: drop frames instead
      if (res.writableLength > 4 * 1024 * 1024) continue;
      try {
        res.write(packet);
      } catch {
        clients.delete(res);
      }
    }
  }

  function onData(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!size.w) {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const m = /^SCENE (\d+) (\d+)$/.exec(buf.subarray(0, nl).toString());
      if (m) size = { w: +m[1], h: +m[2] };
      buf = buf.subarray(nl + 1);
      if (size.w) log(`scene capture: ${size.w}x${size.h}`);
    }
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (n <= 0 || n > 32 * 1024 * 1024) {
        buf = Buffer.alloc(0);
        break;
      }
      if (buf.length < 4 + n) break;
      const jpg = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      frames++;
      lastFrameAt = Date.now();
      feed(jpg);
    }
  }

  function startChild() {
    if (child) return;
    buf = Buffer.alloc(0);
    size = { w: 0, h: 0 };
    child = spawn(EXE, ['--fps', String(fps), '--quality', String(quality)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => log('scene capture:', d.toString().trim()));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) log(`scene capture exited (${code})`);
      child = null;
    });
  }

  function stopChild() {
    if (!child) return;
    try {
      child.kill();
    } catch {}
    child = null;
  }

  async function closePopout() {
    await new Promise((resolve) => {
      const p = spawn(EXE, ['--close'], { stdio: 'ignore' });
      p.on('exit', resolve);
      p.on('error', resolve);
    });
    await sleep(1200);
    currentPkg = '';
    stalled = true;
  }

  /** Make sure the pop-out window is showing `pkg` and capture is running. */
  async function ensure(pkg, { width = 1920, height = 1080 } = {}) {
    if (currentPkg !== pkg) {
      if (currentPkg) await closePopout();
      log('opening Wallpaper Engine pop-out for', path.basename(pkg));
      spawn(
        weExe(),
        [
          '-control',
          'openWallpaper',
          '-file',
          pkg,
          '-playInWindow',
          '-width',
          String(width),
          '-height',
          String(height),
        ],
        { detached: true, stdio: 'ignore' }
      ).unref();
      currentPkg = pkg;
      await sleep(3500);
    }
    if (!child) startedAt = Date.now();
    startChild();
  }

  function stop() {
    stopChild();
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
    clients.clear();
  }

  /** true when frames are actually flowing right now */
  function alive() {
    return !!child && Date.now() - lastFrameAt < 2000;
  }

  return {
    ensure,
    stop,
    closePopout,
    alive,
    url: `http://127.0.0.1:${port}/frame`,
    get stats() {
      const secs = startedAt ? (Date.now() - startedAt) / 1000 : 0;
      return {
        size,
        frames,
        fps: secs > 0 ? +(frames / secs).toFixed(1) : 0,
        clients: clients.size,
        pkg: currentPkg ? path.basename(currentPkg) : '',
      };
    },
  };
}
