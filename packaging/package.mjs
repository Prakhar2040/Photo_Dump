// Builds a portable Windows folder: release/FamilyVault/ (+ a zip). Run from anywhere:  node packaging/package.mjs
// Needs: this project's node_modules already installed (frontend + backend), and digiKam's face models
// (or MODELS_SRC pointing at a folder holding the two .onnx files).
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const out = path.join(repo, 'release', 'FamilyVault');
const MODELS = ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec.onnx'];
const modelsSrc = process.env.MODELS_SRC || path.join(process.env.LOCALAPPDATA || '', 'digikam', 'facesengine');

const step = (m) => console.log(`\n== ${m}`);
const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, filter });
const size = (dir) => {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size;
  return n;
};

for (const m of MODELS) if (!fs.existsSync(path.join(modelsSrc, m))) throw new Error(`Missing ${m} in ${modelsSrc}. Open digiKam once and run face detection, or set MODELS_SRC.`);

step('Building the web app');
execSync('npx vite build', { cwd: path.join(repo, 'frontend'), stdio: 'inherit', env: { ...process.env, NITRO_PRESET: 'node-server' } });

step('Assembling release/FamilyVault');
fs.rmSync(path.join(repo, 'release'), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(out, 'node'));
fs.copyFileSync(process.execPath, path.join(out, 'node', 'node.exe'));
copy(path.join(repo, 'frontend', '.output'), path.join(out, 'web'));

const be = path.join(out, 'backend');
fs.mkdirSync(be);
copy(path.join(repo, 'backend', 'src'), path.join(be, 'src'));
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(repo, 'backend', f), path.join(be, f));
// Production dependencies only, and only the Windows x64 native parts.
copy(path.join(repo, 'backend', 'node_modules'), path.join(be, 'node_modules'));
const nm = path.join(be, 'node_modules');
const ort = path.join(nm, 'onnxruntime-node', 'bin');
if (fs.existsSync(ort)) {
  for (const napi of fs.readdirSync(ort)) {
    const base = path.join(ort, napi);
    for (const plat of fs.readdirSync(base)) if (plat !== 'win32') fs.rmSync(path.join(base, plat), { recursive: true, force: true });
    const win = path.join(base, 'win32');
    if (fs.existsSync(win)) for (const arch of fs.readdirSync(win)) if (arch !== 'x64') fs.rmSync(path.join(win, arch), { recursive: true, force: true });
  }
}
for (const d of fs.readdirSync(path.join(nm, '@img'), { withFileTypes: true })) {
  if (d.isDirectory() && /^sharp(-libvips)?-(?!win32-x64)/.test(d.name)) fs.rmSync(path.join(nm, '@img', d.name), { recursive: true, force: true });
}

fs.mkdirSync(path.join(out, 'models'));
for (const m of MODELS) fs.copyFileSync(path.join(modelsSrc, m), path.join(out, 'models', m));

fs.copyFileSync(path.join(here, 'launcher.mjs'), path.join(out, 'launcher.mjs'));
fs.copyFileSync(path.join(here, 'README.txt'), path.join(out, 'README.txt'));
fs.writeFileSync(
  path.join(out, 'Start Family Vault.bat'),
  [
    '@echo off',
    'title Family Vault',
    'cd /d "%~dp0"',
    // digiKam is not part of this folder; say so (once per start) and offer the download page. The app starts either way.
    'if not exist "%ProgramFiles%\\digiKam\\digikam.exe" (',
    '  echo.',
    '  echo   digiKam is not installed. Family Vault runs without it, but finding faces',
    '  echo   and naming people needs it. It is free: https://www.digikam.org/download/',
    '  echo.',
    '  choice /m "  Open the download page now"',
    '  if not errorlevel 2 start "" https://www.digikam.org/download/',
    '  echo.',
    ')',
    '"%~dp0node\\node.exe" --no-warnings launcher.mjs',
    'if errorlevel 1 pause',
    '',
  ].join('\r\n'),
);

step('Checking the folder starts');
const probe = execFileSync(path.join(out, 'node', 'node.exe'), ['--input-type=module', '-e', "await import('./backend/src/lib.js'); console.log('backend loads')"], { cwd: out, env: { ...process.env, DATA_DIR: path.join(out, '.probe') } });
fs.rmSync(path.join(out, '.probe'), { recursive: true, force: true });
console.log(String(probe).trim());

step('Zipping');
const zip = path.join(repo, 'release', 'FamilyVault.zip');
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });

console.log(`\nFolder: ${out} (${Math.round(size(out) / 1e6)} MB)\nZip:    ${zip} (${Math.round(fs.statSync(zip).size / 1e6)} MB)`);
