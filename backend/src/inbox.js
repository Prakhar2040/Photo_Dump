import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSettings, updateSettings, getState, saveState, getIndex, invalidateIndex, walk, hashFile, readTaken, httpError } from './lib.js';

// Inbox: drop photos and videos into one folder (a Windows Photos import, iCloud for Windows, an SD card copy...) and
// they are filed into Imports/<quarter>. Every file is copied, checked byte for byte (SHA-256), and only then removed
// from the inbox. A file already in the library with identical content is just removed. Nothing is deleted unverified.

const POLL_MS = 10000;
const QUIET_MS = 8000; // the newest file must be at least this old, and the folder unchanged since the last look
const CHUNK_PAUSE_MS = 0;

const status = { running: false, total: 0, done: 0, copied: 0, duplicates: 0, failed: [], message: '', lastAt: null, waiting: 0 };
let lastSig = null;
let timer = null;

const quarterNow = () => { const d = new Date(); return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`; };
const inside = (child, parent) => { const c = path.resolve(child).toLowerCase(), p = path.resolve(parent).toLowerCase(); return c === p || c.startsWith(p + path.sep); };

async function list(dir) {
  const files = [];
  for await (const f of walk(dir)) files.push(f);
  return files;
}

// Removing can fail briefly while OneDrive or another program still has the file open (EPERM/EBUSY): retry for a while.
async function removeSource(abs) {
  for (let i = 0; ; i++) {
    try {
      await fs.rm(abs);
      return;
    } catch (e) {
      if (e.code === 'ENOENT') return;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 8) throw e;
      await fs.chmod(abs, 0o666).catch(() => {}); // clears a read-only flag
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
// The copy is already safe by now, so a stuck delete is a warning (the next run removes it as an identical duplicate).
const stuck = (f, e) => status.failed.push({ name: f.name, error: `Filed correctly, but could not be removed from the inbox yet (${e.code || e.message}). If it keeps happening, Windows Security (Controlled folder access) may be blocking Family Vault in this folder: allow node.exe there, or use an inbox folder outside Pictures/Documents/Desktop.` });

async function removeEmptyDirs(dir, root) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) await removeEmptyDirs(path.join(dir, e.name), root);
  if (dir !== root) await fs.rmdir(dir).catch(() => {}); // only succeeds when empty
}

export async function inboxInfo() {
  const s = await getSettings();
  const dir = s.inboxPath || '';
  const exists = dir ? !!(await fs.stat(dir).catch(() => null))?.isDirectory() : false;
  return {
    path: dir, auto: !!s.inboxAuto, exists,
    suggested: path.join(path.dirname(path.resolve(s.archiveRoot)), 'Inbox'),
    status: { ...status, failed: status.failed.slice(0, 20) },
  };
}

export async function setInbox({ path: p, auto, create }) {
  const s = await getSettings();
  const patch = {};
  if (typeof p === 'string') {
    if (!p.trim()) patch.inboxPath = '';
    else {
      const dir = path.resolve(p.trim());
      if (path.parse(dir).root === dir) throw httpError(400, 'Pick a folder, not a whole drive');
      if (dir === path.resolve(os.homedir())) throw httpError(400, 'Pick a dedicated folder, not your whole user folder');
      if (inside(dir, s.archiveRoot)) throw httpError(400, 'The inbox cannot be inside the archive');
      if (inside(s.archiveRoot, dir)) throw httpError(400, 'The inbox cannot contain the archive');
      let st = await fs.stat(dir).catch(() => null);
      if (!st && create && (await fs.stat(path.dirname(dir)).catch(() => null))?.isDirectory()) { await fs.mkdir(dir); st = await fs.stat(dir); }
      if (!st?.isDirectory()) throw httpError(400, 'That folder does not exist');
      patch.inboxPath = dir;
    }
  }
  if (typeof auto === 'boolean') patch.inboxAuto = auto;
  await updateSettings(patch);
  lastSig = null;
  if (patch.inboxPath !== undefined) status.waiting = patch.inboxPath ? (await list(patch.inboxPath)).length : 0;
  return inboxInfo();
}

export async function runInbox(hooks = {}) {
  if (status.running) throw httpError(409, 'Already importing');
  const s = await getSettings();
  if (!s.inboxPath || !(await fs.stat(s.inboxPath).catch(() => null))?.isDirectory()) throw httpError(400, 'Choose an inbox folder first');
  Object.assign(status, { running: true, total: 0, done: 0, copied: 0, duplicates: 0, failed: [], message: 'Looking at the inbox…' });
  // Runs in the background; progress is read from inboxInfo().
  doRun(s, hooks).catch((e) => { status.message = `Stopped: ${e.message}`; }).finally(() => { status.running = false; status.lastAt = new Date().toISOString(); lastSig = null; });
}

async function doRun(s, hooks) {
  const inbox = s.inboxPath;
  const files = await list(inbox);
  status.total = files.length;
  const quarter = quarterNow();
  const dest = path.join(s.archiveRoot, 'Imports', quarter);

  // What the library already holds, by name + size; identical content is then confirmed by hash.
  const lib = new Map();
  for (const f of (await getIndex()).values()) {
    const k = `${f.name.toLowerCase()}|${f.size}`;
    (lib.get(k) ?? lib.set(k, []).get(k)).push(f.abs);
  }

  for (const f of files) {
    status.message = f.name;
    const k = `${f.name.toLowerCase()}|${f.size}`;
    try {
      const srcHash = await hashFile(f.abs);
      let duplicate = false;
      for (const c of lib.get(k) ?? []) if ((await hashFile(c).catch(() => null)) === srcHash) { duplicate = true; break; }
      if (duplicate) {
        await removeSource(f.abs).catch((e) => stuck(f, e));
        status.duplicates++;
      } else {
        await fs.mkdir(dest, { recursive: true });
        const tmp = path.join(dest, `.inbox-${crypto.randomBytes(6).toString('hex')}.part`); // dot-files are invisible to the library
        await fs.copyFile(f.abs, tmp);
        if ((await hashFile(tmp)) !== srcHash) { await fs.rm(tmp, { force: true }); throw new Error('The copy did not match the original, so it was left in the inbox'); }
        const { name: base, ext } = path.parse(f.name);
        let to = path.join(dest, f.name);
        for (let i = 2; await fs.stat(to).then(() => true, () => false); i++) to = path.join(dest, `${base} (${i})${ext}`);
        await fs.rename(tmp, to);
        const takenMs = await readTaken({ abs: to, name: path.basename(to), kind: f.kind }).catch(() => 0);
        await fs.utimes(to, new Date(), new Date(takenMs || f.mtimeMs)); // keep the photo's own date
        await removeSource(f.abs).catch((e) => stuck(f, e)); // only after the verified copy is in place
        (lib.get(k) ?? lib.set(k, []).get(k)).push(to);
        status.copied++;
      }
    } catch (e) {
      status.failed.push({ name: f.name, error: e.message });
    }
    status.done++;
    if (CHUNK_PAUSE_MS) await new Promise((r) => setTimeout(r, CHUNK_PAUSE_MS));
  }

  await removeEmptyDirs(inbox, inbox);
  invalidateIndex();
  status.waiting = (await list(inbox)).length;
  status.message = status.failed.length ? `Done, ${status.failed.length} left in the inbox` : 'Done';
  if (status.copied > 0 || status.duplicates > 0) {
    const state = await getState();
    state.imports.push({ at: new Date().toISOString(), quarter, copied: status.copied, skipped: status.duplicates, source: 'inbox' });
    await saveState();
  }
  if (status.copied > 0) {
    hooks.afterImport?.();
    if ((await getSettings()).autoLaunchDigikam) await hooks.launchDigikam?.().catch(() => {});
  }
}

/** Looks at the inbox every few seconds; when it has things in it and has stopped changing, imports them. */
export function startInbox(hooks) {
  if (timer) return;
  const tick = async () => {
    try {
      const s = await getSettings();
      if (status.running || !s.inboxPath) return;
      const files = await list(s.inboxPath);
      status.waiting = files.length;
      if (!files.length) { lastSig = null; return; }
      const newest = Math.max(...files.map((f) => f.mtimeMs));
      const sig = `${files.length}:${files.reduce((n, f) => n + f.size, 0)}:${newest}`;
      const settled = sig === lastSig && Date.now() - newest > QUIET_MS;
      lastSig = sig;
      if (s.inboxAuto && settled) await runInbox(hooks);
    } catch (e) {
      console.error('inbox check failed:', e.message);
    }
  };
  timer = setInterval(tick, POLL_MS);
  timer.unref();
  tick();
}
