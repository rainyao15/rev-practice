// Ports, in one place, so the four ways of starting this thing cannot disagree.
//
// Precedence, highest first:
//   1. the command line (--port / --media-port / --scene-port)
//   2. config.json next to this file (see config.example.json)
//   3. environment variables (CMB_PORT / CMB_MEDIA_PORT / CMB_SCENE_PORT)
//   4. the defaults below
//
// Run this file directly to print the three ports that config.json resolves to —
// the .cmd launchers do that instead of hard-coding numbers:
//
//   node src/ports.mjs      ->  9333 2000 2001
import { configPort } from './paths.mjs';

export const DEFAULT_DEBUG_PORT = 9333; // CEF devtools; 9222 collides with every browser
export const DEFAULT_MEDIA_PORT = 2000; // local HTTP for video wallpapers
export const DEFAULT_SCENE_PORT = 2001; // MJPEG for captured Scene wallpapers

// A command-line value that is not a usable port is ignored rather than trusted:
// silently listening on 0 or 70000 would be far more confusing than a warning.
const fromCli = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn(`ignoring --port ${value}: not a port number (1-65535)`);
    return 0;
  }
  return n;
};

const pick = (cli, key, env, fallback) => fromCli(cli) || configPort(key, env, fallback);

export const debugPort = (cli) => pick(cli, 'port', 'CMB_PORT', DEFAULT_DEBUG_PORT);
export const mediaPort = (cli) => pick(cli, 'mediaPort', 'CMB_MEDIA_PORT', DEFAULT_MEDIA_PORT);
export const scenePort = (cli) => pick(cli, 'scenePort', 'CMB_SCENE_PORT', DEFAULT_SCENE_PORT);

// `node src/ports.mjs` — used by start.cmd / autostart.cmd so they test the same
// ports the bridge will actually bind. Extra arguments are honoured too, which is
// handy when checking what `node src/main.mjs --port 9777` would use.
if (process.argv[1] && process.argv[1].endsWith('ports.mjs')) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  console.log(`${debugPort(arg('port'))} ${mediaPort(arg('media-port'))} ${scenePort(arg('scene-port'))}`);
}
