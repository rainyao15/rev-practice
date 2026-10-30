import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, weConfigPath } from './paths.mjs';

const CONFIG = weConfigPath();

const DEFAULTS = {
  enabled: true,
  opacity: 100,
  dim: 0,
  tint: null,
  tintStrength: 0,
  blur: 0,
  fit: 'cover',
  audio: false,
  sceneVolume: 100,
};

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

/**
 * Which wallpaper the user ticked `保存为网易云背景` on most recently.
 *
 * WE keeps the flag per wallpaper, so ticking a second one leaves the first
 * ticked too — the file alone cannot say which of them is current. We watch for
 * the flag flipping to true and remember that one, which is the same rule a
 * human would use: the last one you ticked wins.
 */
const PIN_STATE = path.join(
  process.env.LOCALAPPDATA || os.tmpdir(),
  'cloudmusic-wallpaper-bridge',
  'pin.json',
);
let activePin;
let knownPins = [];
let pinsPrimed = false;

async function loadPinState() {
  if (activePin !== undefined) return;
  try {
    const j = JSON.parse(await fs.readFile(PIN_STATE, 'utf8'));
    activePin = typeof j.pin === 'string' ? j.pin : '';
  } catch {
    activePin = '';
  }
}

async function savePinState() {
  try {
    await fs.mkdir(path.dirname(PIN_STATE), { recursive: true });
    await fs.writeFile(PIN_STATE, JSON.stringify({ pin: activePin || '' }));
  } catch {}
}

/** Adopt the newest tick as the current pin; forget it once it is unticked. */
function trackPins(pins, changed) {
  if (!pinsPrimed) {
    // whatever is already ticked when we start is history, not a fresh choice
    knownPins = pins;
    pinsPrimed = true;
    return;
  }
  const fresh = pins.filter((p) => !knownPins.includes(p));
  knownPins = pins;
  const candidate = (changed || []).length ? changed[changed.length - 1] : fresh[fresh.length - 1];
  if (candidate && knownPins.includes(candidate)) {
    activePin = candidate;
    savePinState();
    return;
  }
  if (activePin && !pins.includes(activePin)) {
    activePin = '';
    savePinState();
  }
}

/** The Monitor0 block of one wallpaper, however WE happened to name the monitor. */
function propsOf(node, key) {
  const v = node?.wproperties?.[key];
  if (!v || typeof v !== 'object') return null;
  return v.Monitor0 || v[Object.keys(v)[0]] || null;
}

const sigOf = (props) => {
  try {
    return JSON.stringify(props);
  } catch {
    return '';
  }
};

let pinSig = new Map();
let lastClearAt = 0;
let lastForcedOn = '';

/**
 * A checkbox cannot express "exactly one of these is the client background", so
 * a second tick leaves the first one ticked forever: the file then says several
 * wallpapers are pinned, and confirming a panel that already says `true` changes
 * nothing observable — which is exactly the "both switches on, confirm, nothing
 * happens" dead end. Keep the winner the user last meant and write `false` to
 * the rest, so the panel always shows the truth.
 */
async function clearOtherPins(cfg, profile, winner, pins) {
  if (Date.now() - lastClearAt < 5000) return false;
  lastClearAt = Date.now();
  let dirty = false;
  for (const key of pins) {
    if (key === winner) continue;
    const props = propsOf(cfg[profile], key);
    if (props && props.ne_pin === true) {
      props.ne_pin = false;
      dirty = true;
    }
  }
  if (!dirty) return false;
  try {
    const tmp = CONFIG + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(cfg, null, '\t'));
    await fs.rename(tmp, CONFIG);
    return true;
  } catch {
    return false;
  }
}

// Keys that live next to the profiles but are not profiles.
const NOT_A_PROFILE = new Set(['installdirectory', 'installdirectoryx', 'version']);

/**
 * Wallpaper Engine stores everything under a section named after the Windows
 * account that set it up (`"Rain": {...}`). That name is different on every
 * machine, so it can never be hardcoded — we look for the section that actually
 * carries a wallpaper config, and let the user force one when there are several.
 */
export function resolveProfile(cfg) {
  const hint = config.weProfile || process.env.WE_PROFILE || '';
  const keys = Object.keys(cfg || {});
  const isProfile = (k) => {
    const v = cfg[k];
    return v && typeof v === 'object' && !Array.isArray(v) &&
      !NOT_A_PROFILE.has(k.toLowerCase()) && (v.general || v.wproperties);
  };
  const candidates = keys.filter(isProfile);
  if (hint) {
    const forced = candidates.find((k) => k.toLowerCase() === hint.toLowerCase());
    if (forced) return forced;
  }
  // normally it is the account you are signed in as
  const me = os.userInfo().username;
  const mine = candidates.find((k) => k.toLowerCase() === me.toLowerCase());
  if (mine) return mine;
  // otherwise the one that has a wallpaper selected on some monitor
  const picked = candidates.find((k) => cfg[k].general?.wallpaperconfig?.selectedwallpapers);
  return picked || candidates[0] || null;
}

const typeCache = new Map();

/**
 * The wallpaper pinned to the NetEase background, if the user ticked
 * `保存为网易云背景` on one. The pin lives in the wallpaper's own property block,
 * so whatever WE last wrote to disk is the truth — we keep no copy of our own,
 * and the pin survives restarts for free.
 */
function findPin(node, selectedFile) {
  const hits = findPins(node);
  if (!hits.length) return '';
  if (hits.length > 1) {
    // several ticked at once: prefer the one that is on the desktop right now,
    // otherwise the first by path. main.mjs overrides this with the wallpaper
    // the user ticked most recently, which is what "pick one" actually means.
    const want = norm(selectedFile);
    const same = hits.find((h) => norm(h) === want);
    return same || hits.sort()[0];
  }
  return hits[0];
}

/** Every wallpaper that has `保存为网易云背景` ticked right now. */
function findPins(node) {
  const wprops = node?.wproperties || {};
  const hits = [];
  for (const [key, v] of Object.entries(wprops)) {
    if (!v || typeof v !== 'object') continue;
    const props = v.Monitor0 || v[Object.keys(v)[0]];
    if (props && props.ne_pin === true) hits.push(key);
  }
  return hits;
}

/** Wallpaper kind. Reads project.json next to the wallpaper file; falls back to the extension. */
async function wallpaperType(file) {
  const dir = path.dirname(file);
  if (typeCache.has(dir)) return typeCache.get(dir);
  let type = '';
  try {
    const pj = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));
    // WE writes "video"/"Video", "scene"/"Scene" interchangeably depending on the
    // authoring tool, so compare lower-cased
    type = String(pj.type || '').toLowerCase();
  } catch {}
  if (!type) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.pkg') type = 'scene';
    else if (ext === '.mp4' || ext === '.webm' || ext === '.mov') type = 'video';
    else if (ext === '.html' || ext === '.htm') type = 'web';
  }
  typeCache.set(dir, type);
  return type;
}

/** Read the currently selected wallpaper and our ne_* knobs for it. */
export async function readState() {
  const raw = await fs.readFile(CONFIG, 'utf8');
  const cfg = JSON.parse(raw);

  const profile = resolveProfile(cfg);
  const node = profile ? cfg[profile] : null;

  const selected = node?.general?.wallpaperconfig?.selectedwallpapers || {};
  const firstMonitor = Object.keys(selected).sort()[0];
  const selectedFile = firstMonitor ? selected[firstMonitor]?.file || '' : '';

  let pins = findPins(node);
  await loadPinState();
  // A workshop item that has been deleted or updated leaves its property block
  // behind, so a pin can point at a file that is no longer there. Never adopt
  // one of those: it would silently win over a wallpaper that still exists.
  const alive = pins.filter((k) => { try { return existsSync(k); } catch { return false; } });
  const dead = pins.filter((k) => !alive.includes(k));
  if (dead.length) {
    await clearOtherPins(cfg, profile, null, dead);
    pins = alive;
    knownPins = knownPins.filter((k) => alive.includes(k));
    if (activePin && !alive.includes(activePin)) activePin = '';
  }
  // an edit on a pinned wallpaper counts as "this is the one I mean": the panel
  // sends every slider change straight to the backend, so touching its knobs is
  // the only observable trace of a confirmation that changed no values.
  const sigs = new Map();
  for (const key of pins) sigs.set(key, sigOf(propsOf(node, key)));
  const changed = pins.filter((k) => pinSig.has(k) && pinSig.get(k) !== sigs.get(k));
  pinSig = sigs;
  trackPins(pins, changed);
  if (pins.length > 1 && pinsPrimed) {
    const winner = activePin && pins.includes(activePin) ? activePin : findPin(node, selectedFile);
    if (await clearOtherPins(cfg, profile, winner, pins)) {
      pins = [winner];
      knownPins = pins;
      activePin = winner;
      await savePinState();
    }
  }
  const pinKey = activePin && pins.includes(activePin) ? activePin : findPin(node, selectedFile);
  // Pinning means "use this one as the client background", so a pin whose own
  // 启用 switch happens to be off would show nothing at all. Turn it on once.
  if (pinKey && pinKey !== lastForcedOn) {
    const p = propsOf(node, pinKey);
    if (p && p.ne_enabled !== true) {
      p.ne_enabled = true;
      try {
        const tmp = CONFIG + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(cfg, null, '\t'));
        await fs.rename(tmp, CONFIG);
        lastForcedOn = pinKey;
      } catch {
        /* the next poll tries again */
      }
    } else if (p) {
      lastForcedOn = pinKey;
    }
  }
  let pinFile = pinKey;
  let pinMissing = false;
  if (pinFile) {
    const ok = await fs.access(pinFile).then(() => true, () => false);
    if (!ok) {
      // the pinned wallpaper was unsubscribed or moved — fall back to the desktop one
      pinMissing = true;
      pinFile = '';
    }
  }

  // pinned wins; with nothing pinned the client follows the desktop wallpaper
  const file = pinFile || selectedFile;

  const wprops = node?.wproperties || {};
  let props = null;
  if (file) {
    const want = norm(file);
    for (const [k, v] of Object.entries(wprops)) {
      if (norm(k) === want) {
        props = v?.Monitor0 || v?.[Object.keys(v || {})[0]] || null;
        break;
      }
    }
  }

  const knobs = { ...DEFAULTS };
  if (props) {
    if (typeof props.ne_enabled === 'boolean') knobs.enabled = props.ne_enabled;
    if (Number.isFinite(props.ne_opacity)) knobs.opacity = props.ne_opacity;
    if (Number.isFinite(props.ne_dim)) knobs.dim = props.ne_dim;
    if (Number.isFinite(props.ne_blur)) knobs.blur = props.ne_blur;
    if (Number.isFinite(props.ne_tintstrength)) knobs.tintStrength = props.ne_tintstrength;
    if (typeof props.ne_audio === 'boolean') knobs.audio = props.ne_audio;
    if (Number.isFinite(props.ne_scenevolume)) knobs.sceneVolume = props.ne_scenevolume;
    if (typeof props.ne_fit === 'string') knobs.fit = props.ne_fit;
    if (typeof props.ne_tint === 'string') {
      const p = props.ne_tint.trim().split(/\s+/).map(Number);
      if (p.length >= 3 && p.every((n) => Number.isFinite(n))) knobs.tint = p.slice(0, 3);
    }
  }

  // our properties only exist once the user has touched the panel
  const touched = props && Object.keys(props).some((k) => k.startsWith('ne_'));
  const type = file ? await wallpaperType(file) : '';
  return {
    file,
    selectedFile,
    pins,
    pinFile,
    pinMissing,
    type,
    knobs,
    touched: !!touched,
    profile,
    configPath: CONFIG,
  };
}

export const FIT_VALUES = ['cover', 'contain', 'fill'];
