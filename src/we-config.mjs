import fs from 'node:fs/promises';
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
  const file = firstMonitor ? selected[firstMonitor]?.file || '' : '';

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
  return { file, type, knobs, touched: !!touched, profile, configPath: CONFIG };
}

export const FIT_VALUES = ['cover', 'contain', 'fill'];
