// Path resolution. Everything that is machine-specific lives here, so the rest
// of the code never has to guess where NetEase or Wallpaper Engine are.
//
// Order of precedence:
//   1. config.json next to this file (see config.example.json)
//   2. environment variables (NETEASE_EXE / WE_ROOT / WE_WORKSHOP)
//   3. auto-detection (registry, then the usual install locations)
//   4. a sensible hard-coded fallback
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readConfig = () => {
  const p = join(ROOT, 'config.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`config.json is not valid JSON — ignoring it (${e.message})`);
    return {};
  }
};

export const config = readConfig();

const regQuery = (key, name) => {
  const r = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return '';
  const m = /REG_(?:SZ|EXPAND_SZ)\s+(.+)$/m.exec(r.stdout);
  return m ? m[1].trim() : '';
};

// ---------------------------------------------------------------- NetEase client
const detectClient = () => {
  const fromReg = regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Netease\\cloudmusic', 'install_dir')
    || regQuery('HKLM\\SOFTWARE\\Netease\\cloudmusic', 'install_dir');
  if (fromReg) {
    const exe = join(fromReg, 'cloudmusic.exe');
    if (existsSync(exe)) return exe;
  }
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']) {
    if (!base) continue;
    const exe = join(base, 'NetEase', 'CloudMusic', 'cloudmusic.exe');
    if (existsSync(exe)) return exe;
  }
  return 'C:\\Program Files\\NetEase\\CloudMusic\\cloudmusic.exe';
};

export const clientExe = () =>
  resolve(config.clientExe || process.env.NETEASE_EXE || detectClient());

// ------------------------------------------------------------ Wallpaper Engine
const steamLibraries = () => {
  const out = new Set();
  const steam = regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath') || 'C:\\Program Files (x86)\\Steam';
  out.add(steam);
  const vdf = join(steam, 'steamapps', 'libraryfolders.vdf');
  if (existsSync(vdf)) {
    // the file lists "path" "D:\\SteamLibrary" entries, one per library
    const text = readFileSync(vdf, 'utf8');
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) out.add(m[1].replace(/\\\\/g, '\\'));
  }
  for (const drive of ['D:', 'E:', 'F:', 'C:']) out.add(`${drive}\\SteamLibrary`);
  return [...out];
};

const detectWeRoot = () => {
  for (const lib of steamLibraries()) {
    const dir = join(lib, 'steamapps', 'common', 'wallpaper_engine');
    if (existsSync(join(dir, 'wallpaper64.exe'))) return dir;
  }
  return 'D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine';
};

export const weRoot = () => resolve(config.weRoot || process.env.WE_ROOT || detectWeRoot());

export const weConfigPath = () => join(weRoot(), 'config.json');
export const weExe = () => join(weRoot(), 'wallpaper64.exe');

export const workshopRoot = () =>
  resolve(config.workshopRoot || process.env.WE_WORKSHOP || join(weRoot(), '..', '..', 'workshop', 'content', '431960'));

// ---------------------------------------------------------------- our own files
export const sceneExe = () =>
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'native',
    process.platform === 'win32' ? 'SceneCapture.exe' : 'SceneCapture');
