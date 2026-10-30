// Tiny helper so tests never fight PowerShell quoting.
// usage: node tools\pin.mjs <substring> <true|false> [extraProp=value ...]
import fs from 'node:fs';
import { weConfigPath } from '../src/paths.mjs';

const [needle, value, ...pairs] = process.argv.slice(2);
if (!needle) {
  console.error('usage: node tools\\pin.mjs <substring> <true|false> [key=value ...]');
  process.exit(2);
}
const file = weConfigPath();
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const profile = Object.keys(cfg).find(
  (k) => cfg[k] && typeof cfg[k] === 'object' && cfg[k].general && cfg[k].wproperties,
);
const node = cfg[profile];
const hits = Object.keys(node.wproperties).filter(
  (k) => k.toLowerCase().includes(needle.toLowerCase()) && fs.existsSync(k),
);
if (hits.length !== 1) {
  console.error(`expected exactly one existing file matching "${needle}", got ${hits.length}`);
  hits.forEach((h) => console.error('  ' + h));
  process.exit(1);
}
const key = hits[0];
const block = node.wproperties[key];
const loc = block.Monitor0 ? 'Monitor0' : Object.keys(block)[0];
const props = block[loc];
if (value === 'true' || value === 'false') props.ne_pin = value === 'true';
for (const pair of pairs) {
  const [k, v] = pair.split('=');
  props[k] = Number.isNaN(Number(v)) ? v : Number(v);
}
fs.writeFileSync(file, JSON.stringify(cfg, null, '\t'));
console.log(`${loc} of ${key.split('/').pop()}: ne_pin=${props.ne_pin} ${JSON.stringify(props)}`);
