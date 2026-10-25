import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import {
  DATA_DIR, getSettings, updateSettings, getState, saveState, getIndex, invalidateIndex, publicFile, walk, fileKind,
  safeSegment, safeResolve, moveNoClobber, moveSidecar, httpError, startJob, getJob, toPosix, fileId, unnamedClusters, faceResults,
} from './lib.js';
import * as dup from './duplicates.js';
import * as backup from './backup.js';
import * as clutter from './classify.js';
import { analyseFaces, loadSavedResults, watchDigikam } from './faces.js';
import { startUpload, stopUpload, uploadInfo, resetToken } from './upload.js';
import { nameGroup, undoBatch, dismissGroup, undoDismiss, getCover, setCover, clearCover } from './names.js';

const PORT = Number(process.env.PORT || 4000);
const origins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:8080,http://localhost:3000').split(',');
const API_KEY = process.env.API_KEY || '';

const app = express();
// Lovable preview/published domains are allowed via ALLOWED_ORIGINS, e.g. https://xxxx.lovable.app
app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o)) }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', (req, _res, next) => {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY && req.query.key !== API_KEY) return next(httpError(401, 'Bad API key'));
  next();
});

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ---------- health / dashboard / settings ----------
app.get('/api/health', (_q, res) => res.json({ ok: true }));

app.get('/api/dashboard', h(async (_q, res) => {
  const settings = await getSettings();
  const index = await getIndex();
  let photos = 0, videos = 0, bytes = 0;
  for (const f of index.values()) { f.kind === 'photo' ? photos++ : videos++; bytes += f.size; }
  const disk = await fs.statfs(settings.archiveRoot).catch(() => null);
  const state = await getState();
  const targets = await Promise.all(settings.backupTargets.map(async (t) => ({ id: t.id, name: t.name, kind: t.kind, ...(state.backups[t.id] ?? {}) })));
  const lastBackupAt = targets.map((t) => t.lastSyncAt).filter(Boolean).sort().pop() ?? null;
  const overdue = !lastBackupAt || Date.now() - Date.parse(lastBackupAt) > 1000 * 60 * 60 * 24 * 30;
  res.json({
    photos, videos, archiveBytes: bytes,
    driveCapacityBytes: disk ? disk.blocks * disk.bsize : null,
    driveFreeBytes: disk ? disk.bavail * disk.bsize : null,
    lastImportAt: state.imports.at(-1)?.at ?? null,
    lastBackupAt, backupOverdue: overdue, backupTargets: targets,
    duplicates: await dup.summary(),
    binItems: (await dup.listBin()).items.length,
    recentImports: state.imports.slice(-5).reverse(),
  });
}));

app.get('/api/settings', h(async (_q, res) => res.json(await getSettings())));
app.put('/api/settings', h(async (req, res) => res.json(await updateSettings(req.body ?? {}))));

// ---------- folder browser (for pickers in the UI; lists directories only) ----------
app.get('/api/fs/browse', h(async (req, res) => {
  const p = String(req.query.path || '');
  if (!p) {
    const drives = [];
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (await fs.access(`${l}:\\`).then(() => true, () => false)) drives.push({ name: `${l}:\\`, path: `${l}:\\` });
    return res.json({ path: '', parent: null, dirs: drives });
  }
  const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => { throw httpError(400, 'Cannot read that folder'); });
  const parent = path.dirname(p);
  res.json({
    path: p, parent: parent === p ? '' : parent,
    dirs: entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '$RECYCLE.BIN' && e.name !== 'System Volume Information')
      .map((e) => ({ name: e.name, path: path.join(p, e.name) })),
  });
}));

// ---------- jobs ----------
app.get('/api/jobs/:id', h((req, res) => {
  const j = getJob(req.params.id);
  if (!j) throw httpError(404, 'Unknown job');
  res.json(j);
}));

// ---------- import ----------
async function checkSource(p) {
  const st = await fs.stat(String(p || '')).catch(() => null);
  if (!st?.isDirectory()) throw httpError(400, 'sourcePath is not a folder');
  const { archiveRoot } = await getSettings();
  if (path.resolve(p).toLowerCase().startsWith(path.resolve(archiveRoot).toLowerCase())) throw httpError(400, 'Source cannot be inside the archive');
  return path.resolve(p);
}

app.post('/api/import/preview', h(async (req, res) => {
  const src = await checkSource(req.body.sourcePath);
  const quarter = /^\d{4}-Q[1-4]$/.test(String(req.body.quarter)) ? String(req.body.quarter) : null;
  const { archiveRoot } = await getSettings();
  let photos = 0, videos = 0, bytes = 0, newFiles = 0;
  const sample = [];
  for await (const f of walk(src)) {
    f.kind === 'photo' ? photos++ : videos++;
    bytes += f.size;
    // same test the import uses to skip a file: already there with the same size
    if (quarter && (await fs.stat(path.join(archiveRoot, 'Imports', quarter, f.rel)).catch(() => null))?.size !== f.size) newFiles++;
    if (sample.length < 60) sample.push({ rel: f.rel, kind: f.kind, size: f.size });
  }
  res.json({ photos, videos, bytes, newFiles: quarter ? newFiles : null, sample });
}));

// The folder last imported from, so the page can offer to pick up from there.
app.get('/api/import/last', h(async (_q, res) => {
  const last = [...(await getState()).imports].reverse().find((i) => i.source && !String(i.source).startsWith('phone'));
  res.json({ source: last?.source ?? null, at: last?.at ?? null });
}));

app.post('/api/import', h(async (req, res) => {
  const src = await checkSource(req.body.sourcePath);
  const quarter = String(req.body.quarter || '');
  if (!/^\d{4}-Q[1-4]$/.test(quarter)) throw httpError(400, 'quarter must look like 2026-Q4');
  const { archiveRoot } = await getSettings();
  const destRoot = path.join(archiveRoot, 'Imports', quarter); // one folder per quarter, not per person

  const job = startJob('import', async (update) => {
    const files = [];
    for await (const f of walk(src)) files.push(f);
    update({ total: files.length, done: 0, message: `Copying to Imports/${quarter}` });
    let copied = 0, skipped = 0, done = 0;
    for (const f of files) {
      let to = path.join(destRoot, f.rel);
      await fs.mkdir(path.dirname(to), { recursive: true });
      const existing = await fs.stat(to).catch(() => null);
      if (existing?.size === f.size) skipped++; // already imported
      else {
        if (existing) { const p = path.parse(to); to = path.join(p.dir, `${p.name}_${Date.now()}${p.ext}`); }
        await fs.copyFile(f.abs, to, fs.constants.COPYFILE_EXCL);
        await fs.utimes(to, new Date(), new Date(f.mtimeMs)); // keep original capture time
        copied++;
      }
      update({ done: ++done });
    }
    invalidateIndex();
    if (copied > 0) autoClutterScan();
    if (copied > 0 && (await getSettings()).autoLaunchDigikam) await launchDigikam().catch(() => {});
    const state = await getState();
    state.imports.push({ at: new Date().toISOString(), quarter, copied, skipped, source: src });
    await saveState();
    return { copied, skipped, destination: toPosix(path.join('Imports', quarter)) };
  });
  res.status(202).json(job);
}));

// New files get checked for screenshots/documents/forwards on their own, so the Clean Up tab is already up to date.
let clutterScanning = false;
function autoClutterScan() {
  if (clutterScanning) return;
  clutterScanning = true;
  clutter.scanClutter({ scope: 'archive' }, () => {}).catch((e) => console.error('clutter scan failed:', e.message)).finally(() => { clutterScanning = false; });
}

// ---------- phone upload over Wi-Fi (QR code) ----------
const uploadHooks = { launchDigikam, afterImport: autoClutterScan };
app.get('/api/upload', h(async (_q, res) => res.json(await uploadInfo())));
app.post('/api/upload/start', h(async (_q, res) => res.json(await startUpload(uploadHooks))));
app.post('/api/upload/stop', h(async (_q, res) => { stopUpload(); res.json(await uploadInfo()); }));
app.post('/api/upload/reset-token', h(async (_q, res) => { await resetToken(); const was = (await uploadInfo()).running; stopUpload(); res.json(was ? await startUpload(uploadHooks) : await uploadInfo()); }));

// ---------- duplicates (Clean Up tab) ----------
app.post('/api/duplicates/scan', h(async (req, res) => {
  const { mode = 'similar', similarity, scope = 'imports', burstWindowSeconds } = req.body ?? {};
  if (!['exact', 'similar'].includes(mode) || !['imports', 'archive'].includes(scope)) throw httpError(400, 'Bad mode or scope');
  res.status(202).json(startJob('duplicate-scan', (update) => dup.scan({ mode, similarity: Number(similarity) || undefined, scope, burstWindowSeconds: Number.isFinite(Number(burstWindowSeconds)) && burstWindowSeconds !== undefined ? Number(burstWindowSeconds) : undefined }, update)));
}));
app.get('/api/duplicates/summary', h(async (_q, res) => res.json(await dup.summary())));
app.get('/api/duplicates/groups', h(async (req, res) => res.json(await dup.listGroups({
  status: String(req.query.status || 'pending'), offset: Number(req.query.offset) || 0, limit: Math.min(Number(req.query.limit) || 50, 200),
}))));
app.get('/api/duplicates/groups/:id', h(async (req, res) => res.json(await dup.getGroup(req.params.id))));
// body: { keepId: "<file id>" } keeps that one and bins the rest; { keepId: "all" } keeps everything.
app.post('/api/duplicates/groups/:id/resolve', h(async (req, res) => res.json(await dup.resolveGroup(req.params.id, req.body?.keepId))));
app.post('/api/duplicates/groups/:id/skip', h(async (req, res) => { await dup.skipGroup(req.params.id); res.json({ ok: true }); }));

// ---------- other clean-up: screenshots, documents, forwarded images ----------
app.post('/api/cleanup/scan', h(async (req, res) => {
  const scope = req.body?.scope === 'archive' ? 'archive' : 'imports';
  res.status(202).json(startJob('clutter-scan', (update) => clutter.scanClutter({ scope }, update)));
}));
app.get('/api/cleanup/items', h(async (req, res) => {
  const category = String(req.query.category || '');
  if (!['screenshot', 'document', 'forwarded'].includes(category)) throw httpError(400, 'category must be screenshot, document or forwarded');
  res.json({ items: await clutter.listClutter(category) });
}));

// ---------- review bin ----------
app.get('/api/bin', h(async (_q, res) => res.json(await dup.listBin())));
app.post('/api/bin', h(async (req, res) => res.json(await dup.binByIds(Array.isArray(req.body?.ids) ? req.body.ids : [], String(req.body?.reason || '')))));
app.get('/api/bin/:binId/thumb', h(async (req, res) => {
  const abs = await dup.binFilePath(req.params.binId);
  try {
    const buf = await sharp(abs, { failOn: 'none' }).rotate().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    res.type('image/webp').send(buf);
  } catch { throw httpError(404, 'No thumbnail'); }
}));
app.post('/api/bin/:binId/restore', h(async (req, res) => { await dup.restoreFromBin(req.params.binId); res.json({ ok: true }); }));
app.delete('/api/bin', h(async (req, res) => {
  if (req.query.confirm !== 'yes') throw httpError(400, 'Add ?confirm=yes to permanently empty the bin');
  res.json(await dup.emptyBin());
}));

// ---------- library ----------
app.get('/api/library/folders', h(async (_q, res) => {
  const root = { name: 'Family Archive', rel: '', count: 0, children: [] };
  const nodes = new Map([['', root]]);
  for (const f of (await getIndex()).values()) {
    let parent = root, acc = '';
    root.count++;
    for (const seg of f.folder ? f.folder.split('/') : []) {
      acc = acc ? `${acc}/${seg}` : seg;
      let n = nodes.get(acc);
      if (!n) { n = { name: seg, rel: acc, count: 0, children: [] }; nodes.set(acc, n); parent.children.push(n); }
      n.count++;
      parent = n;
    }
  }
  const sort = (n) => { n.children.sort((a, b) => a.name.localeCompare(b.name)); n.children.forEach(sort); };
  sort(root);
  res.json(root);
}));

app.get('/api/library/photos', h(async (req, res) => {
  const { folder = '', q = '', person = '', who = '', year = '', type = '', tag = '' } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(Number(req.query.limit) || 100, 500);
  const needle = String(q).toLowerCase();
  let items = [...(await getIndex()).values()].filter((f) =>
    (!folder || f.folder === folder || f.folder.startsWith(`${folder}/`)) &&
    (!needle || f.rel.toLowerCase().includes(needle)) &&
    (!person || f.person === person) &&
    (!who || f.people.includes(who) || f.autoPeople.some((p) => p.name === who)) &&
    (!type || f.kind === type) &&
    (!tag || (tag === 'screenshot' && /screenshot|screen shot|screen_shot/i.test(f.name)) || (tag === 'large-video' && f.kind === 'video' && f.size > 500e6)) &&
    (!year || new Date(f.takenMs).getFullYear() === Number(year)));
  items.sort((a, b) => b.takenMs - a.takenMs);
  res.json({ total: items.length, page, limit, items: items.slice((page - 1) * limit, page * limit).map(publicFile) });
}));

app.get('/api/library/people', h(async (_q, res) => {
  const people = new Map();
  for (const f of (await getIndex()).values()) {
    for (const n of [...f.people, ...f.autoPeople.map((a) => a.name)]) {
      const p = people.get(n) ?? { name: n, count: 0, auto: 0, hasFace: false };
      p.count++;
      if (!f.people.includes(n)) p.auto++;
      if (f.kind === 'photo' && f.faces.some((x) => x.name === n)) p.hasFace = true;
      people.set(n, p);
    }
  }
  for (const p of people.values()) { const c = await getCover(p.name); if (c) Object.assign(p, { hasFace: true, coverV: c.v }); }
  res.json({ people: [...people.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) });
}));

// Re-run face matching now (it also re-runs by itself whenever digiKam's database changes).
app.post('/api/people/analyze', h(async (_q, res) => res.status(202).json(startJob('face-analysis', (update) => analyseFaces(update)))));

// Square face crop for a person, from their largest tagged face box (cached on disk).
app.get('/api/people/:name/face', h(async (req, res) => {
  const name = req.params.name;
  const size = Math.min(Number(req.query.size) || 256, 512);
  const cover = await getCover(name);
  const coverFile = cover && [...(await getIndex()).values()].find((x) => x.rel === cover.rel);
  if (coverFile) return sendWebp(res, await faceCrop(coverFile, cover.rect, size, `c:${cover.v}`));
  let best = null;
  for (const f of (await getIndex()).values()) {
    if (f.kind !== 'photo') continue;
    for (const b of f.faces) if (b.name === name && (!best || b.w * b.h > best.box.w * best.box.h)) best = { f, box: b };
  }
  if (!best) throw httpError(404, 'No face box for this person');
  const key = crypto.createHash('sha1').update(`v3:${name}:${best.f.id}:${best.f.mtimeMs}:${JSON.stringify(best.box)}:${size}`).digest('hex');
  const cached = path.join(thumbDir, `face-${key}.webp`);
  let out = await fs.readFile(cached).catch(() => null);
  if (!out) {
    const upright = await sharp(best.f.abs, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
    const W = upright.info.width, H = upright.info.height;
    // Hand-drawn boxes are often tall (head + shoulders): crop a square from the top of the box.
    // Tight auto-detected face boxes are centred with some padding.
    const bw = best.box.w * W, bh = best.box.h * H;
    const tall = bh > bw * 1.1;
    const side = Math.min(tall ? bw * 1.15 : Math.max(bw, bh) * 1.35, Math.min(W, H));
    const left = Math.round(Math.min(Math.max(best.box.x * W - side / 2, 0), W - side));
    const idealTop = tall ? best.box.y * H - bh / 2 - side * 0.05 : best.box.y * H - side / 2;
    const top = Math.round(Math.min(Math.max(idealTop, 0), H - side));
    out = await sharp(upright.data).extract({ left, top, width: Math.round(side), height: Math.round(side) }).resize(size, size).webp({ quality: 80 }).toBuffer();
    await fs.mkdir(thumbDir, { recursive: true });
    await fs.writeFile(cached, out);
  }
  res.set('Cache-Control', 'private, max-age=300').type('image/webp').send(out);
}));

// Faces nobody has named yet, grouped by similarity. Name one in digiKam and the whole group is matched.
app.get('/api/people/unnamed', h(async (_q, res) => {
  const index = await getIndex();
  const groups = unnamedClusters.list
    .map((c) => {
      // drop photos that have since been named, moved away or deleted
      const ids = c.rels.map(fileId).filter((id) => index.has(id));
      return { id: c.id, count: ids.length, photoIds: ids };
    })
    .filter((g) => g.count >= 2);
  res.json({ groups });
}));

// Name a whole group at once. Always remembered by the app; optionally also written to each photo's digiKam sidecar.
app.post('/api/people/unnamed/:id/name', h(async (req, res) => {
  const r = await nameGroup(req.params.id, req.body.name, req.body.writeToPhotos !== false);
  await analyseFaces();
  res.json(r);
}));
app.post('/api/people/names/:batchId/undo', h(async (req, res) => {
  const r = await undoBatch(req.params.batchId);
  await analyseFaces();
  res.json(r);
}));

/** Square crop around a face box given in pixels of the upright image (cached on disk). */
async function faceCrop(f, rect, size, tag) {
  if (rect.h > rect.w * 1.1) rect = { ...rect, h: rect.w * 1.1 }; // tall hand-drawn boxes (head and shoulders): keep the top, where the face is
  const key = crypto.createHash('sha1').update(`${tag}:${f.id}:${f.mtimeMs}:${JSON.stringify(rect)}:${size}`).digest('hex');
  const cached = path.join(thumbDir, `pface-${key}.webp`);
  let out = await fs.readFile(cached).catch(() => null);
  if (!out) {
    const upright = await sharp(f.abs, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
    const W = upright.info.width, H = upright.info.height;
    const side = Math.min(Math.max(rect.w, rect.h) * 1.4, Math.min(W, H));
    const left = Math.round(Math.min(Math.max(rect.x + rect.w / 2 - side / 2, 0), W - side));
    const top = Math.round(Math.min(Math.max(rect.y + rect.h / 2 - side / 2, 0), H - side));
    out = await sharp(upright.data).extract({ left, top, width: Math.round(side), height: Math.round(side) }).resize(size, size).webp({ quality: 80 }).toBuffer();
    await fs.mkdir(thumbDir, { recursive: true });
    await fs.writeFile(cached, out);
  }
  return out;
}
const sendWebp = (res, out) => res.set('Cache-Control', 'private, max-age=300').type('image/webp').send(out);

app.get('/api/people/unnamed/:id/face', h(async (req, res) => {
  const c = unnamedClusters.list.find((x) => x.id === req.params.id);
  const f = c && (await getIndex()).get(fileId(c.rel));
  if (!f) throw httpError(404, 'Unknown group');
  sendWebp(res, await faceCrop(f, c.rect, Math.min(Number(req.query.size) || 160, 512), 'u2'));
}));

// "Not a person I care about" (a stranger in the background): hide this group from the Who-is-this row.
app.post('/api/people/unnamed/:id/dismiss', h(async (req, res) => res.json(await dismissGroup(req.params.id))));
app.post('/api/people/dismissed/:id/undo', h(async (req, res) => { await undoDismiss(req.params.id); await analyseFaces(); res.json({ ok: true }); }));

// Faces that can be used as a person's cover picture: clear, large faces matched to them.
app.get('/api/people/:name/faces', h(async (req, res) => {
  const name = req.params.name;
  const byRel = new Map([...(await getIndex()).values()].map((f) => [f.rel, f]));
  const out = [];
  for (const [rel, list] of faceResults) {
    const f = byRel.get(rel);
    if (!f || f.kind !== 'photo') continue;
    for (const x of list) if (x.name === name && x.score >= 0.6 && Math.min(x.rect.w, x.rect.h) >= 80) out.push({ rel, id: f.id, rect: x.rect, score: x.score, size: x.rect.w * x.rect.h });
  }
  out.sort((a, b) => b.score - a.score || b.size - a.size);
  res.json({ faces: out.slice(0, 36).map(({ size, ...rest }) => rest) });
}));
app.get('/api/files/:id/face', h(async (req, res) => {
  const f = (await getIndex()).get(req.params.id);
  const rect = { x: +req.query.x, y: +req.query.y, w: +req.query.w, h: +req.query.h };
  if (!f || f.kind !== 'photo' || !Object.values(rect).every((v) => Number.isFinite(v) && v >= 0) || !rect.w || !rect.h) throw httpError(400, 'Bad face');
  sendWebp(res, await faceCrop(f, rect, Math.min(Number(req.query.size) || 160, 512), 'f1'));
}));
app.put('/api/people/:name/cover', h(async (req, res) => res.json(await setCover(req.params.name, String(req.body.rel), req.body.rect))));
app.delete('/api/people/:name/cover', h(async (req, res) => { await clearCover(req.params.name); res.json({ ok: true }); }));

app.post('/api/library/folders', h(async (req, res) => {
  const { archiveRoot } = await getSettings();
  const rel = String(req.body.path || '').split('/').map(safeSegment).filter(Boolean).join('/');
  if (!rel) throw httpError(400, 'path required');
  await fs.mkdir(safeResolve(archiveRoot, rel), { recursive: true });
  invalidateIndex();
  res.status(201).json({ path: rel });
}));

app.post('/api/library/move', h(async (req, res) => {
  const { archiveRoot } = await getSettings();
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const dest = String(req.body.destFolder || '').split('/').map(safeSegment).filter(Boolean).join('/');
  if (!ids.length || !dest) throw httpError(400, 'ids and destFolder required');
  const index = await getIndex();
  const destAbs = safeResolve(archiveRoot, dest);
  let moved = 0;
  for (const id of ids) {
    const f = index.get(id);
    if (f) { const to = await moveNoClobber(f.abs, path.join(destAbs, f.name)); await moveSidecar(f.abs, to); moved++; }
  }
  invalidateIndex();
  res.json({ moved, destFolder: dest });
}));

// ---------- file serving ----------
app.get('/api/files/:id/raw', h(async (req, res) => {
  const f = (await getIndex()).get(req.params.id);
  if (!f) throw httpError(404, 'Not found');
  res.sendFile(f.abs);
}));
const run = promisify(execFile);

// ---------- digiKam launcher ----------
// Fixed install path only (override with DIGIKAM_EXE); the API can't point this at another program.
const DIGIKAM_EXE = process.env.DIGIKAM_EXE || 'C:/Program Files/digiKam/digikam.exe';
async function digikamRunning() {
  const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq digikam.exe', '/NH']).catch(() => ({ stdout: '' }));
  return /digikam.exe/i.test(stdout);
}
async function launchDigikam() {
  if (await digikamRunning()) return { launched: false, reason: 'already running' };
  if (!(await fs.stat(DIGIKAM_EXE).then(() => true, () => false))) return { launched: false, reason: 'digiKam not found' };
  // Start minimized so it works in the background without jumping in front of the app (digiKam finds faces while minimized).
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:DK_EXE -WindowStyle Minimized'], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, DK_EXE: path.resolve(DIGIKAM_EXE) },
  }).unref();
  return { launched: true };
}
app.post('/api/digikam/open', h(async (_q, res) => res.json(await launchDigikam())));
app.get('/api/digikam/status', h(async (_q, res) => res.json({ running: await digikamRunning(), installed: await fs.stat(DIGIKAM_EXE).then(() => true, () => false) })));
const thumbDir = path.join(DATA_DIR, 'thumbs');

/** First-second frame of a video as a JPEG buffer (cached on disk by file id + mtime). */
async function videoFrame(f, w) {
  await fs.mkdir(thumbDir, { recursive: true });
  const key = crypto.createHash('sha1').update(`${f.id}:${f.mtimeMs}:${w}`).digest('hex');
  const cached = path.join(thumbDir, `${key}.webp`);
  try { return await fs.readFile(cached); } catch { /* not cached yet */ }
  const tmp = path.join(thumbDir, `${key}.tmp.jpg`);
  // -ss before -i seeks fast; fall back to frame 0 for clips shorter than 1s
  for (const ss of ['1', '0']) {
    await run(ffmpegPath, ['-y', '-v', 'error', '-ss', ss, '-i', f.abs, '-frames:v', '1', '-vf', `scale=${w}:-2`, tmp], { timeout: 30000 }).catch(() => {});
    if (await fs.stat(tmp).then((st) => st.size > 0, () => false)) break;
  }
  const jpg = await fs.readFile(tmp).catch(() => null);
  await fs.rm(tmp, { force: true });
  if (!jpg) throw httpError(404, 'Cannot read video frame');
  const out = await sharp(jpg).webp({ quality: 70 }).toBuffer();
  await fs.writeFile(cached, out);
  return out;
}

app.get('/api/files/:id/thumb', h(async (req, res) => {
  const f = (await getIndex()).get(req.params.id);
  if (!f) throw httpError(404, 'Not found');
  const w = Math.min(Number(req.query.w) || 400, 1600);
  try {
    const buf = f.kind === 'video'
      ? await videoFrame(f, w)
      : await sharp(f.abs, { failOn: 'none' }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    res.set('Cache-Control', 'private, max-age=86400').type('image/webp').send(buf);
  } catch {
    throw httpError(404, 'Cannot render this format');
  }
}));

// ---------- backup ----------
app.get('/api/backup/targets', h(async (_q, res) => res.json(await backup.targetsStatus())));
app.post('/api/backup/plan', h(async (req, res) => res.json(await backup.plan(req.body.targetId))));
app.post('/api/backup/sync', h(async (req, res) => {
  const { targetId, dryRun = true } = req.body ?? {};
  if (dryRun !== false) return res.json(await backup.plan(targetId)); // must explicitly pass dryRun:false to copy
  res.status(202).json(startJob('backup-sync', (update) => backup.sync(targetId, update)));
}));
app.post('/api/backup/verify', h(async (req, res) => res.status(202).json(startJob('backup-verify', (update) => backup.verify(req.body.targetId, update)))));

app.use((err, _req, res, _next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`Family Vault API on http://127.0.0.1:${PORT}`);
  await loadSavedResults().catch(() => {});
  watchDigikam();
  autoClutterScan(); // catches anything added while the app was closed
});
