// NetEase Cloud Music ← Wallpaper Engine live wallpaper bridge.
//
//   node main.mjs [--port 9222] [--media-port 2000] [--restart]
//
// Responsibilities:
//   1. make sure the client runs with --remote-debugging-port (its CEF passthrough)
//   2. serve the current WE video wallpaper over local HTTP (Range enabled)
//   3. inject the page layer at document-start on every navigation
//   4. poll Wallpaper Engine's config.json and push the ne_* knobs live
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState } from './we-config.mjs';
import { clientExe, sceneAudioExe, weConfigPath } from './paths.mjs';
import { startMediaServer } from './media-server.mjs';
import { createSceneCapture } from './scene-capture.mjs';
import { syncAll, startPanelWatcher, ensurePanel } from './we-panel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_IMAGE = 'cloudmusic.exe';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(arg('port', 9222));
const MEDIA_PORT = Number(arg('media-port', 2000));
const SCENE_PORT = Number(arg('scene-port', 2001));
const RESTART = argv.includes('--restart');
const NO_RELAUNCH = argv.includes('--no-relaunch');
// dev aid: force a scene wallpaper regardless of what Wallpaper Engine has selected
const FORCE_SCENE = arg('force-scene', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// the reconnect loop can spin for minutes while the client is gone; repeat a
// message at most once a minute so the log stays readable
let lastMsg = '';
let lastMsgAt = 0;
function logOnce(msg) {
  const now = Date.now();
  if (msg === lastMsg && now - lastMsgAt < 60000) return;
  lastMsg = msg;
  lastMsgAt = now;
  log(msg);
}

async function cdpVersion() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function clientRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${CLIENT_IMAGE}`, '/NH'], { encoding: 'utf8' });
    return out.toLowerCase().includes(CLIENT_IMAGE.toLowerCase());
  } catch {
    return false;
  }
}

function killClient() {
  try {
    execFileSync('taskkill', ['/IM', CLIENT_IMAGE, '/F'], { stdio: 'ignore' });
  } catch {}
}

async function ensureClient() {
  if (await cdpVersion()) return true;

  if (clientRunning()) {
    if (NO_RELAUNCH) {
      logOnce('client is running WITHOUT the debug port — restart it via "start.cmd --restart"');
      return false;
    }
    // a plain double-click loses the debug port; without it there is no way in,
    // and the feature is dead until the client is started correctly
    logOnce('client lost its debug port — relaunching it (--no-relaunch disables this)');
    killClient();
    await sleep(2500);
  } else {
    logOnce('client is not running — waiting for it to start');
    return false;
  }

  log('launching the client with --remote-debugging-port=' + PORT);
  spawn(clientExe(), [`--remote-debugging-port=${PORT}`], { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 60; i++) {
    if (await cdpVersion()) {
      log('client is up and debuggable');
      return true;
    }
    await sleep(500);
  }
  logOnce('the debug port never came up');
  return false;
}

async function findPage() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
  const list = await r.json();
  return list.find((t) => t.type === 'page' && /pub\/app\.html/.test(t.url)) || list.find((t) => t.type === 'page');
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function rpc(ws) {
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  // a frozen renderer (e.g. a runaway observer) must not wedge the controller
  return (method, params = {}, timeoutMs = 8000) =>
    new Promise((res) => {
      const i = id++;
      const timer = setTimeout(() => {
        pending.delete(i);
        res({ error: { message: `timeout after ${timeoutMs}ms calling ${method}` } });
      }, timeoutMs);
      pending.set(i, (m) => {
        clearTimeout(timer);
        res(m);
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
}

const INJECT = await fs.readFile(path.join(HERE, 'inject.js'), 'utf8');

async function session(media, state) {
  const target = await findPage();
  if (!target) throw new Error('no page target');

  const ws = await openWs(target.webSocketDebuggerUrl);
  const call = rpc(ws);
  await call('Page.enable');
  await call('Runtime.enable');
  // survives reloads and in-page navigation
  await call('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
  // ...but it does not touch the document that is already loaded, and an older
  // version of the layer may still be living there — install the current one now
  await call('Runtime.evaluate', { expression: INJECT, returnByValue: true });

  const push = async (knobs, url, mode) => {
    const expr = `window.__neApply(${JSON.stringify({ ...knobs, mode, url })})`;
    let r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      // the layer is not in this document yet (addScriptToEvaluateOnNewDocument only
      // covers future documents) — install it now and retry once
      await call('Runtime.evaluate', { expression: INJECT, returnByValue: true });
      r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    }
    if (r.result?.exceptionDetails) {
      log('apply failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
    }
    if (r.error) log('cdp error:', r.error.message);
    return r.result?.result?.value;
  };

  const boot = await push(state.knobs, state.url, state.mode);
  log('injected:', JSON.stringify(boot));

  let lastSignature = '';
  let lastEpoch = '';
  let lastPin;
  let closed = false;
  ws.addEventListener('close', () => {
    closed = true;
  });

  while (!closed) {
    // WE only writes config.json when the panel's confirm button is pressed, so
    // this poll is the whole latency budget between "confirm" and "the page
    // updates". 250 ms is a few parses of a small JSON per second, i.e. free.
    await sleep(250);
    if (closed) break;
    // a reload creates a fresh document whose layer has no knobs yet
    const epochRes = await call('Runtime.evaluate', {
      expression: 'window.__neEpoch || ""',
      returnByValue: true,
    });
    const epoch = epochRes.result?.result?.value || '';
    let st;
    try {
      st = await readState();
    } catch {
      continue;
    }
    if (st.pinFile !== lastPin) {
      lastPin = st.pinFile;
      log(
        st.pinFile
          ? 'pinned: ' + path.basename(st.pinFile) + ' (the desktop wallpaper no longer matters)'
          : 'pinned: none — following the desktop wallpaper',
      );
    }
    if (st.pinMissing) {
      logOnce('warning: the pinned wallpaper is gone, following the desktop wallpaper again');
    }
    let src;
    try {
      src = await resolveSource(st);
    } catch (e) {
      log('source:', e.message);
      continue;
    }
    // a wallpaper can be patched after WE already scanned it (download that landed
    // while we were down, or a fresh subscription) — fill in the gap for whatever
    // is selected right now, so at worst the next WE start shows the section
    if (st.file) {
      const dir = path.dirname(st.file);
      if (dir !== lastPanelDir) {
        lastPanelDir = dir;
        ensurePanel(dir).catch(() => {});
      }
    }
    // this loop is the one that reacts to property changes, so the scene audio has
    // to follow it as well — the outside loop only comes round when this one exits
    syncSceneVolume(st.knobs, src.mode);
    const sig = JSON.stringify(st.knobs) + '|' + src.mode + '|' + src.url;
    if (sig === lastSignature && epoch === lastEpoch) continue;
    lastSignature = sig;
    lastEpoch = epoch;
    try {
      const r = await push(st.knobs, src.url, src.mode);
      log(`knobs -> [${src.mode}]`, JSON.stringify(st.knobs), r?.paused === false ? '(playing)' : '');
    } catch {
      break;
    }
  }
  try {
    ws.close();
  } catch {}
  throw new Error('session ended');
}

// Which wallpaper is selected decides who paints the background: a video is
// served straight to a <video>; a scene has no decodable file, so Wallpaper
// Engine renders it in a pop-out window that we capture into an MJPEG <img>.
let lastSourceMode = '';
let lastWarnExt = '';

// Scene audio is played by Wallpaper Engine's own renderer, not by anything we
// put on the page (an MJPEG stream carries no sound), so the only way to change
// its loudness is to ride the audio session of the process that owns the pop-out.
let lastSceneVolume = -1;
let lastPanelDir = '';
let lastSceneVolumeAt = 0;

function applySceneVolume(vol) {
  lastSceneVolume = vol;
  lastSceneVolumeAt = Date.now();
  const p = spawn(sceneAudioExe(), ['--class', 'WPEOverlappedWallpaper', '--volume', String(vol)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  p.stdout.on('data', (d) => log('scene audio:', d.toString().trim()));
  p.stderr.on('data', (d) => {
    err += d.toString();
  });
  p.on('error', (e) => logOnce('scene audio: ' + e.message));
  p.on('exit', (code) => {
    if (code !== 0) logOnce(`scene audio: could not set ${vol}% (${err.trim() || 'exit ' + code})`);
  });
}

function syncSceneVolume(knobs, mode) {
  if (mode !== 'scene') {
    lastSceneVolume = -1;
    return;
  }
  const want = knobs.enabled === false ? 0 : Math.max(0, Math.min(100, Math.round(knobs.sceneVolume ?? 100)));
  // re-assert now and then, because WE resets the session volume when it rebuilds
  // a renderer — but only when there is something to re-assert
  const stale = want !== 100 && Date.now() - lastSceneVolumeAt > 60000;
  if (want !== lastSceneVolume || stale) {
    log(`scene volume: ${want}% (was ${lastSceneVolume})`);
    applySceneVolume(want);
  }
}

async function resolveSource(st) {
  if (FORCE_SCENE) {
    await scene.ensure(FORCE_SCENE);
    lastSourceMode = 'scene';
    return { mode: 'scene', url: scene.url };
  }
  if (st.type === 'scene') {
    if (!st.file) throw new Error('no wallpaper selected');
    await scene.ensure(st.file);
    lastSourceMode = 'scene';
    return { mode: 'scene', url: scene.url };
  }
  if (lastSourceMode === 'scene') {
    lastSourceMode = 'video';
    // stop the capture child first: closing the window would only make it idle
    scene.stop();
    await scene.closePopout();
  }
  // web wallpapers are an HTML app rendered by WE; there is nothing to feed a
  // <video>, and feeding it the .html would just make the layer retry forever
  const ext = path.extname(st.file || '').toLowerCase();
  if (!['.mp4', '.webm', '.mov', '.m4v'].includes(ext)) {
    if (ext && lastWarnExt !== ext) {
      lastWarnExt = ext;
      log(`unsupported wallpaper file (${ext}) — background stays on the theme colour`);
    }
    return { mode: 'video', url: '' };
  }
  const file = media.setFile(st.file);
  return { mode: 'video', url: file ? media.url(path.basename(file)) : '' };
}

// ---------------------------------------------------------------- bootstrap
// Fail loudly and once, before anything starts watching a directory that may not
// exist — a missing client or a wrong Steam library should read as one clear line.
if (!existsSync(clientExe())) {
  log('client not found:', clientExe());
  log('set "clientExe" in config.json (see config.example.json) or the NETEASE_EXE env var');
  process.exit(1);
}
if (!existsSync(weConfigPath())) {
  log('Wallpaper Engine config not found:', weConfigPath());
  log('set "weRoot" in config.json or the WE_ROOT env var');
  process.exit(1);
}

// every wallpaper needs the property group: WE only ever renders what the
// wallpaper's own project.json declares, and new subscriptions arrive without it
if (!argv.includes('--no-panel-sync')) {
  try {
    const s = await syncAll({ log: () => {} });
    if (s.patched) {
      log(`panel: added the 网易云背景 group to ${s.patched} wallpaper(s)` +
        ` — restart Wallpaper Engine to see it`);
    }
  } catch (e) {
    log('panel sync:', e.message);
  }
  // new subscriptions arrive while we are running — patch them on arrival
  startPanelWatcher({ log });
}

await ensureClient();

const media = startMediaServer(MEDIA_PORT);
log(`media server on http://127.0.0.1:${MEDIA_PORT}`);

const scene = createSceneCapture({ port: SCENE_PORT, fps: 60, quality: 80, log });
log(`scene capture on http://127.0.0.1:${SCENE_PORT}/frame`);

// drop a pop-out left behind by a previous run
try {
  await scene.closePopout();
} catch {}

for (;;) {
  // the client can be restarted, crash, or be closed at any moment — without the
  // debug port the whole feature is asleep, so re-check before every round
  if (!(await ensureClient())) {
    try {
      scene.stop();
      await scene.closePopout();
    } catch {}
    await sleep(2000);
    continue;
  }

  const state = { knobs: {}, file: '', type: '', url: '', mode: 'video' };
  try {
    const st = await readState();
    state.knobs = st.knobs;
    state.file = st.file;
    state.type = st.type;
    if (!st.profile) {
      logOnce('warning: no Wallpaper Engine profile found in config.json — set "weProfile" in your config file, or start Wallpaper Engine once');
    } else if (!st.file) {
      logOnce(`warning: no wallpaper selected in Wallpaper Engine (profile "${st.profile}")`);
    }
    const src = await resolveSource(st);
    state.url = src.url;
    state.mode = src.mode;
    syncSceneVolume(st.knobs, state.mode);
  } catch (e) {
    logOnce('state: ' + e.message);
  }

  try {
    await session(media, state);
  } catch (e) {
    if (e.message !== 'session ended') logOnce('reconnect: ' + e.message);
  }
  await sleep(1500);
}