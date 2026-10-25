import fs from 'node:fs/promises';
import path from 'node:path';
import { NAMES_FILE } from './names.js';
import { getSettings, getState, saveState, walk, hashFile, httpError, safeResolve } from './lib.js';

export async function getTarget(id) {
  const t = (await getSettings()).backupTargets.find((x) => x.id === id);
  if (!t) throw httpError(404, 'Unknown backup target');
  return t;
}

async function diff(source, target) {
  const dst = new Map();
  for await (const f of walk(target.path, target.path, true)) dst.set(f.rel, f);
  const add = [], update = [], same = [];
  const seen = new Set();
  for await (const f of walk(source, source, true)) {
    seen.add(f.rel);
    const d = dst.get(f.rel);
    if (!d) add.push(f);
    else if (d.size !== f.size || f.mtimeMs > d.mtimeMs + 2000) update.push(f);
    else same.push(f);
  }
  const extra = [...dst.values()].filter((f) => !seen.has(f.rel));
  return { add, update, same, extra };
}

const brief = (arr) => arr.map((f) => ({ rel: f.rel, size: f.size }));

export async function plan(targetId) {
  const { archiveRoot } = await getSettings();
  const target = await getTarget(targetId);
  await fs.access(target.path).catch(() => { throw httpError(409, `Backup location not connected: ${target.path}`); });
  const d = await diff(archiveRoot, target);
  return {
    target,
    mode: target.mode,
    toAdd: d.add.length,
    toUpdate: d.update.length,
    unchanged: d.same.length,
    // Files only on the backup. In 'mirror' mode these are moved to .sync-trash (not deleted); in 'update' mode they are left alone.
    extraOnTarget: d.extra.length,
    bytesToCopy: [...d.add, ...d.update].reduce((s, f) => s + f.size, 0),
    sample: { add: brief(d.add.slice(0, 50)), update: brief(d.update.slice(0, 50)), extra: brief(d.extra.slice(0, 50)) },
  };
}

export async function sync(targetId, progress) {
  const { archiveRoot } = await getSettings();
  const target = await getTarget(targetId);
  await fs.access(target.path).catch(() => { throw httpError(409, `Backup location not connected: ${target.path}`); });
  const d = await diff(archiveRoot, target);
  const todo = [...d.add, ...d.update];
  progress({ total: todo.length, done: 0, message: 'Copying' });
  let done = 0;
  for (const f of todo) {
    const to = safeResolve(target.path, f.rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    if (d.update.includes(f)) await fs.copyFile(to, `${to}.prev`).catch(() => {}); // keep one previous version until copy succeeds
    await fs.copyFile(f.abs, to);
    await fs.utimes(to, new Date(), new Date(f.mtimeMs));
    await fs.rm(`${to}.prev`, { force: true });
    progress({ done: ++done });
  }
  // The names given in the app live outside the archive; keep a copy with the backup (dot-folders are skipped by walk()).
  await fs.mkdir(path.join(target.path, '.vault-data'), { recursive: true });
  await fs.copyFile(NAMES_FILE, path.join(target.path, '.vault-data', 'names.json')).catch(() => {});
  let trashed = 0;
  if (target.mode === 'mirror' && d.extra.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const f of d.extra) {
      const to = path.join(target.path, '.sync-trash', stamp, f.rel);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(f.abs, to);
      trashed++;
    }
  }
  const st = await getState();
  st.backups[targetId] = { ...(st.backups[targetId] ?? {}), lastSyncAt: new Date().toISOString(), fileCount: d.same.length + todo.length };
  await saveState();
  return { copied: todo.length, movedToTrash: trashed };
}

/** Full SHA-256 compare of every archive file against the target copy. */
export async function verify(targetId, progress) {
  const { archiveRoot } = await getSettings();
  const target = await getTarget(targetId);
  const files = [];
  for await (const f of walk(archiveRoot, archiveRoot, true)) files.push(f);
  progress({ total: files.length, done: 0, message: 'Verifying checksums' });
  const missing = [], mismatched = [];
  let done = 0;
  for (const f of files) {
    const other = path.join(target.path, f.rel);
    if (!(await fs.stat(other).catch(() => null))) missing.push(f.rel);
    else if ((await hashFile(f.abs)) !== (await hashFile(other))) mismatched.push(f.rel);
    progress({ done: ++done });
  }
  const st = await getState();
  st.backups[targetId] = { ...(st.backups[targetId] ?? {}), lastVerifyAt: new Date().toISOString(), lastVerifyOk: !missing.length && !mismatched.length };
  await saveState();
  return { checked: files.length, missing, mismatched, ok: !missing.length && !mismatched.length };
}

export async function targetsStatus() {
  const { backupTargets, archiveRoot } = await getSettings();
  const st = await getState();
  let sourceCount = 0;
  for await (const _ of walk(archiveRoot, archiveRoot, true)) sourceCount++;
  return Promise.all(backupTargets.map(async (t) => {
    const connected = await fs.access(t.path).then(() => true, () => false);
    let fileCount = null, pending = null, pendingBytes = 0;
    if (connected) {
      fileCount = 0; for await (const _ of walk(t.path, t.path, true)) fileCount++;
      const d = await diff(archiveRoot, t); // stat-only, so cheap: what a backup would copy right now
      const todo = [...d.add, ...d.update];
      pending = todo.length;
      pendingBytes = todo.reduce((s, f) => s + f.size, 0);
    }
    return { ...t, connected, fileCount, pending, pendingBytes, sourceCount, ...(st.backups[t.id] ?? {}) };
  }));
}
