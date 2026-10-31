// NetEase Cloud Music ← Wallpaper Engine live wallpaper bridge.
//
//   node main.mjs [--port 9333] [--media-port 2000] [--restart]
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
import { debugPort, mediaPort, scenePort } from './ports.mjs';
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
// 9222 is the port every Chromium-family browser reaches for when someone adds
// --remote-debugging-port, so it collides with whatever the user happens to be
// running. Default to something uncommon; an old 9222 install is still honoured
// as a *detection* candidate as long as it proves it is the music client.
//
// Every value here can be overridden in config.json (see config.example.json),
// which is the point of it: users should not have to edit a .cmd file to move a
// port that some other program already owns.
let PORT = debugPort(arg('port'));
const MEDIA_PORT = mediaPort(arg('media-port'));
const SCENE_PORT = scenePort(arg('scene-port'));
const RESTART = argv.includes('--restart');
const NO_RELAUNCH = argv.includes('--no-relaunch');
// dev aid: force a scene wallpaper regardless of what Wallpaper Engine has selected
const FORCE_SCENE = arg('force-scene', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');
// local time, so the log lines line up with what Windows and WE show
const log = (...a) => {
  const d = new Date();
  console.log(`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`, ...a);
};
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

const CDP_UA_MARK = 'NeteaseMusicDesktop';

async function cdpVersion(port = PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = await r.json();
    // Anything can answer on this port. Only the music client's own CEF carries
    // this token in its UA, so a browser that grabbed the port is never mistaken
    // for the client we are supposed to be driving.
    if (!String(j['User-Agent'] || '').includes(CDP_UA_MARK)) return null;
    return j;
  } catch {
    return null;
  }
}

/** Whatever is on the port, and whether it says it is our client. */
async function probePort(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return { speaks: true, ours: false, status: r.status };
    const j = await r.json();
    return { speaks: true, ours: String(j['User-Agent'] || '').includes(CDP_UA_MARK), status: r.status, ua: j['User-Agent'] };
  } catch {
    return { speaks: false, ours: false, status: 0 };
  }
}

function pidImage(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
    const m = out.match(/"([^"]+)"/);
    return m ? m[1] : '';
  } catch {
    return '';
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

/** PID that holds a listening socket on a loopback port, or 0. */
function portOwner(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const re = new RegExp(`127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    const m = out.match(re);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function portFree(port) {
  return portOwner(port) === 0;
}

/** First loopback port at or above `from` that nothing is listening on. */
function findFreePort(from, tries = 24) {
  for (let p = from; p < from + tries; p++) {
    if (portFree(p)) return p;
  }
  return 0;
}

function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until no cloudmusic.exe is left. taskkill returns before the processes are
 * actually gone, and the client is single-instance: launching while the old one
 * still holds its mutex makes the new process forward the request and exit, so the
 * debug port never opens. That turns into the "relaunch → never came up" loop.
 */
async function waitClientGone(ms = 12000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!clientRunning()) return true;
    await sleep(250);
  }
  return !clientRunning();
}

let relaunchFailures = 0;
let relaunchPaused = false;

/** True when this process holds an elevated token (fsutil refuses otherwise). */
function detectElevated() {
  try {
    execFileSync('fsutil', ['dirty', 'query', process.env.SystemDrive || 'C:'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const ELEVATED = detectElevated();

/**
 * Start the music client.
 *
 * When the bridge itself runs elevated (autostart/start ask for UAC so they can
 * replace a client that was started as administrator), the client would inherit
 * the elevated token. That breaks drag and drop from Explorer into the client and
 * is not what a music player should run as, so hand the launch to the shell
 * instead: explorer.exe runs at the normal integrity level and starts its child
 * with the same token. We do not get a PID back, which is fine — liveness is
 * tracked through the debug port, not the process.
 */
function spawnClient(args) {
  const exe = clientExe();
  if (ELEVATED) {
    // Handing the launch to explorer.exe to strip the elevated token sounds
    // better than it works: explorer does not reliably pass arguments through,
    // the client then never sees --remote-debugging-port, and the feature stays
    // dead. A client that runs beats a tidy integrity level.
    logOnce('bridge runs elevated, so the client is started elevated too — drag and drop from Explorer into the client will not work');
  }
  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
}

async function ensureClient() {
  if (await cdpVersion()) return true;

  // An install from before 0.2.0 launches the client with --remote-debugging-port=9222
  // through the Run key. Adopt it when, and only when, it proves it is the client.
  if (PORT !== 9222 && (await cdpVersion(9222))) {
    log(`found the client on the legacy port 9222 — using it`);
    PORT = 9222;
    return true;
  }

  if (relaunchPaused) return false;

  const probe = await probePort(PORT);
  const owner = portOwner(PORT);
  if (owner) {
    const image = pidImage(owner);
    if (image.toLowerCase() === CLIENT_IMAGE.toLowerCase()) {
      // a cloudmusic.exe that holds the port but will not talk: never finished
      // shutting down, and the next launch would fail to bind. Take it back.
      logOnce(`the client holds ${PORT} but does not answer — killing pid ${owner}`);
      killPid(owner);
      await sleep(1000);
    } else if (probe.ours) {
      // impossible in practice (another app would have to fake the UA), keep it
    } else {
      // Someone else's DevTools / socket lives here. Killing it would take down
      // whatever the user is running, so move to a port that is actually free.
      const alt = findFreePort(PORT + 1);
      if (!alt) {
        logOnce(`port ${PORT} is used by ${image || 'another process'} and no free port was found`);
        return false;
      }
      logOnce(`port ${PORT} is used by ${image || 'another process'} (${probe.status}) — using ${alt} instead`);
      PORT = alt;
    }
  } else if (probe.speaks) {
    const alt = findFreePort(PORT + 1);
    if (!alt) {
      logOnce(`port ${PORT} answers but is not the client, and no free port was found`);
      return false;
    }
    logOnce(`port ${PORT} answers but is not the client — using ${alt} instead`);
    PORT = alt;
  }

  if (clientRunning()) {
    // after a reboot the client is often still coming up: Chrome has not opened
    // the debug port yet, and killing it here would cost another cold start on a
    // machine that is already busy. Give it a moment first.
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (await cdpVersion()) return true;
    }
    if (NO_RELAUNCH) {
      logOnce('client is running WITHOUT the debug port — restart it via "start.cmd --restart"');
      return false;
    }
    // a plain double-click loses the debug port; without it there is no way in,
    // and the feature is dead until the client is started correctly
    logOnce('client lost its debug port — relaunching it (--no-relaunch disables this)');
    killClient();
    if (!(await waitClientGone())) {
      logOnce('could not stop the running client — is it running as administrator?');
      return false;
    }
  } else {
    logOnce('client is not running — starting it');
  }

  log('launching the client with --remote-debugging-port=' + PORT);
  spawnClient([`--remote-debugging-port=${PORT}`]);

  // a launch that dies immediately means the single-instance mutex was still held
  await sleep(3000);
  if (!clientRunning()) {
    relaunchFailures++;
    logOnce('the client exited right after launch (another instance still holding it?)');
    backoff();
    return false;
  }

  for (let i = 0; i < 40; i++) {
    if (await cdpVersion()) {
      log('client is up and debuggable');
      relaunchFailures = 0;
      return true;
    }
    await sleep(500);
  }
  relaunchFailures++;
  logOnce(`the debug port never came up (attempt ${relaunchFailures})`);
  backoff();
  return false;
}

/**
 * Repeated relaunches are what the user actually feels as "it keeps restarting
 * my music player". After a few misses, stop and say something useful instead.
 */
function backoff() {
  if (relaunchFailures >= 3) {
    relaunchPaused = true;
    logOnce(
      'giving up on the automatic restart — start the client yourself with "start.cmd", ' +
        'then restart the bridge (nothing else will be restarted until you do)',
    );
  }
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
// move the startup chatter onto the listeners so a losing instance never claims a port it did not get
if (media.server) media.server.on('listening', () => log(`media server on http://127.0.0.1:${MEDIA_PORT}`));

const scene = createSceneCapture({ port: SCENE_PORT, fps: 60, quality: 80, log });
if (scene.server) scene.server.on('listening', () => log(`scene capture on http://127.0.0.1:${SCENE_PORT}/frame`));

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