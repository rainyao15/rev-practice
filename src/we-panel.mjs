import { workshopRoot } from './paths.mjs';
// Injects the NetEase-background property group into Wallpaper Engine
// project.json files, as a collapsible WE-native section.
//
// How it works (ui/dist/scripts/scripts.js ~0x015EA0):
//     list.sort((a,b) => a.order - b.order)
//     for (p of list) {
//         if (p.type === "group") groups.push(cur = { properties: [], property: p });
//         else cur.properties.push(p);
//     }
// i.e. a property with type "group" opens a new collapsible section and every
// later property (by `order`) lands inside it. The section renders through
// views/includes/templates/browseruserpropertiesgroup.html, collapsed by default.
//
// Any wallpaper can carry this group — `video`, `scene`, `web`, whatever. WE only
// reads `general.properties`, and never rewrites project.json, so parking ten
// extra keys in a wallpaper the user never opens costs nothing.
//
// Idempotent: re-running repairs missing keys and leaves edits intact.
//
//   node we-panel.mjs --all                 every wallpaper under the workshop root
//   node we-panel.mjs --dir <wallpaperDir>  one wallpaper
//   node we-panel.mjs --revert --all        remove every ne_* key
import fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';



// Our section must come *last*: a group swallows every property that sorts after
// it, so a low order would pull the wallpaper's own controls into our section.
// Wallpapers use small orders (0-200), so 9000+ safely lands at the bottom.
const GROUP = {
  ne_group: { order: 9000, text: '网易云背景', type: 'group' },
};

const PROPS = {
  // fractional order so this lands on top of our section without renumbering the
  // properties below it (renumbering would rewrite every installed wallpaper)
  ne_pin: {
    order: 9000.5, text: '保存为网易云背景', type: 'bool', value: false,
  },
  ne_enabled: {
    order: 9001, text: '启用网易云背景', type: 'bool', value: true,
  },
  ne_opacity: {
    order: 9002, text: '壁纸不透明度 (%)', type: 'slider',
    value: 100, min: 0, max: 100, step: 1,
  },
  ne_dim: {
    order: 9003, text: '明暗调节 (叠加黑 %)', type: 'slider',
    value: 0, min: 0, max: 100, step: 1,
  },
  ne_tint: {
    order: 9004, text: '染色', type: 'color', value: '1 1 1',
  },
  ne_tintstrength: {
    order: 9005, text: '染色强度 (%)', type: 'slider',
    value: 0, min: 0, max: 100, step: 1,
  },
  ne_blur: {
    order: 9006, text: '背景模糊 (px)', type: 'slider',
    value: 0, min: 0, max: 60, step: 1,
  },
  ne_fit: {
    order: 9007, text: '铺满方式', type: 'combo', value: 'cover',
    options: [
      { label: '铺满 (cover)', value: 'cover' },
      { label: '完整显示 (contain)', value: 'contain' },
      { label: '拉伸 (fill)', value: 'fill' },
      { label: '平铺 (tile)', value: 'tile' },
    ],
  },
  ne_audio: {
    order: 9008, text: '播放壁纸音轨', type: 'bool', value: false,
  },
  ne_scenevolume: {
    order: 9009, text: 'Scene 壁纸音量 (%)', type: 'slider',
    value: 100, min: 0, max: 100, step: 1,
  },
};

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, obj) {
  await fs.writeFile(file, JSON.stringify(obj, null, '\t') + '\n', 'utf8');
}

// Returns the list of keys that were added/removed, empty when already correct.
export async function applyTo(dir, { revert = false, backup = true } = {}) {
  const file = path.join(dir, 'project.json');
  let obj;
  try {
    obj = await readJson(file);
  } catch {
    return { dir, skipped: 'no project.json' };
  }
  // workshop items without a `type` are WE presets/collections, not wallpapers:
  // they have no property UI at all, and inventing a `general` section there is a
  // schema change we have no business making
  if (!obj.type) return { dir, skipped: 'preset (no type)' };

  if (obj.general === null || obj.general === undefined) obj.general = {};
  if (typeof obj.general !== 'object') {
    return { dir, skipped: 'unusable general section' };
  }
  const props = (obj.general.properties ??= {});
  const changed = [];

  if (revert) {
    for (const k of Object.keys(props)) {
      if (k.startsWith('ne_')) {
        delete props[k];
        changed.push('-' + k);
      }
    }
  } else {
    for (const [k, v] of Object.entries({ ...GROUP, ...PROPS })) {
      const cur = props[k];
      if (!cur) {
        props[k] = { ...v };
        changed.push('+' + k);
      } else if (cur.order !== v.order) {
        // an older version of this tool used orders 9..18, which made our group
        // swallow every wallpaper property that sorted after it
        cur.order = v.order;
        changed.push('~' + k);
      }
    }
  }

  if (!changed.length) return { dir, changed };

  if (backup) {
    const stamp = Math.floor(Date.now() / 1000);
    await fs.copyFile(file, `${file}.bak-${stamp}`);
  }
  await writeJson(file, obj);
  // round-trip validation: a wallpaper WE cannot parse is worse than no panel
  await readJson(file);
  return { dir, changed };
}

// Give one wallpaper our property section if it does not have it yet. Safe to
// call for a wallpaper that is already patched — it then writes nothing.
export async function ensurePanel(dir) {
  if (!dir) return { changed: [] };
  return applyTo(dir, { backup: false });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Steam drops new workshop items into the library while we are running. Watch for
// new item folders and patch them right away, so the section is there the first
// time WE shows the wallpaper — waiting for the next restart is too late.
export function startPanelWatcher({ log = () => {}, root = workshopRoot() } = {}) {
  const timers = new Map();
  let watcher;
  try {
    watcher = fsWatch(root, { persistent: false }, (_event, filename) => {
      const name = filename ? String(filename) : '';
      if (!/^\d+$/.test(name)) return; // only workshop item folders
      const dir = path.join(root, name);
      clearTimeout(timers.get(dir));
      timers.set(dir, setTimeout(async () => {
        timers.delete(dir);
        // the folder appears before Steam has finished writing project.json
        for (let i = 0; i < 20; i++) {
          try {
            const st = await fs.stat(path.join(dir, 'project.json'));
            if (st.isFile() && st.size > 0) break;
          } catch {}
          await sleep(500);
        }
        try {
          const r = await ensurePanel(dir);
          if (r.changed?.length) log(`panel: ${name} ${r.changed.join(' ')}`);
        } catch (e) {
          log(`panel: ${name} ${e.message}`);
        }
      }, 800));
    });
  } catch (e) {
    log('panel watch: ' + e.message);
    return null;
  }
  watcher.on?.('error', (e) => log('panel watch: ' + e.message));
  return watcher;
}

export async function listWallpapers(root = workshopRoot()) {  const out = [];
  let names;
  try {
    names = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of names) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      await fs.access(path.join(dir, 'project.json'));
      out.push(dir);
    } catch {}
  }
  return out;
}

export async function syncAll({
  root = workshopRoot(),
  revert = false,
  log = () => {},
} = {}) {
  const dirs = await listWallpapers(root);
  const stats = { total: dirs.length, patched: 0, unchanged: 0, skipped: 0, files: 0 };
  for (const dir of dirs) {
    const r = await applyTo(dir, { revert });
    if (r.skipped) {
      stats.skipped++;
      continue;
    }
    if (!r.changed.length) {
      stats.unchanged++;
      continue;
    }
    stats.patched++;
    stats.files += r.changed.length;
    log(`  ${path.basename(dir)}: ${r.changed.join(' ')}`);
  }
  return stats;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const revert = argv.includes('--revert');
  const dirIdx = argv.indexOf('--dir');
  if (dirIdx >= 0) {
    const r = await applyTo(argv[dirIdx + 1], { revert });
    console.log(JSON.stringify(r, null, 2));
  } else if (argv.includes('--all')) {
    const s = await syncAll({ revert, log: (l) => console.log(l) });
    console.log(
      `${revert ? 'reverted' : 'synced'}: ${s.patched} changed, ` +
        `${s.unchanged} already ok, ${s.skipped} skipped, ` +
        `${s.files} keys touched, ${s.total} wallpapers scanned`,
    );
  } else {
    console.log('usage: --all | --dir <dir> [--revert]');
  }
}
