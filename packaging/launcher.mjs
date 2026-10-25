// Starts Family Vault from the packaged folder: the API (port 4000) and the web app (port 8080), then opens the browser.
// Close this window (or press Ctrl+C) to stop both. Everything it writes stays inside this folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const logs = path.join(root, 'logs');
const archive = process.env.ARCHIVE_ROOT || path.join(root, 'Family Archive');
fs.mkdirSync(logs, { recursive: true });
fs.mkdirSync(archive, { recursive: true });

const env = {
  ...process.env,
  DATA_DIR: path.join(root, 'data'),
  ARCHIVE_ROOT: archive,
  MODELS_DIR: path.join(root, 'models'),
};

const busy = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

for (const port of [4000, 8080]) {
  if (await busy(port)) {
    console.error(`Port ${port} is already in use. Is Family Vault already running? Close it first, then start again.`);
    process.exit(1);
  }
}

const children = [];
function run(name, file, cwd, extraEnv = {}) {
  const out = fs.openSync(path.join(logs, `${name}.log`), 'a');
  const child = spawn(node, [file], { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', out, out], windowsHide: true });
  child.on('exit', (code) => { if (!stopping) { console.error(`${name} stopped (code ${code}). See logs\\${name}.log`); stop(1); } });
  children.push(child);
}

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  process.exit(code);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

run('api', path.join(root, 'backend', 'src', 'server.js'), path.join(root, 'backend'));
run('web', path.join(root, 'web', 'server', 'index.mjs'), path.join(root, 'web'), { PORT: '8080', HOST: '127.0.0.1' });

// Wait for the web app, then open it.
for (let i = 0; i < 60; i++) {
  if (await busy(8080)) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log('');
console.log('  Family Vault is running:  http://localhost:8080');
console.log('  Your photos are kept in:  ' + archive);
console.log('  Close this window to stop it.');
console.log('');
spawn('cmd', ['/c', 'start', '', 'http://localhost:8080'], { stdio: 'ignore', windowsHide: true });
setInterval(() => {}, 1 << 30); // keep running
