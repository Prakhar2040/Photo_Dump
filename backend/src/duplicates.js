import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import exifr from 'exifr';
import { DATA_DIR, getSettings, getIndex, invalidateIndex, hashFile, moveNoClobber, publicFile, readJson, writeJson, httpError, safeResolve } from './lib.js';

const GROUPS_FILE = path.join(DATA_DIR, 'duplicates.json');
let groups = null; // Map<groupId, group>

async function loadGroups() {
  if (!groups) groups = new Map((await readJson(GROUPS_FILE, [])).map((g) => [g.id, g]));
  return groups;
}
const saveGroups = async () => writeJson(GROUPS_FILE, [...(await loadGroups()).values()]);

// ---------- Review Bin (soft delete inside <archive>/.bin) ----------
const binDir = async () => path.join((await getSettings()).archiveRoot, '.bin');
const manifestPath = async () => path.join(await binDir(), 'manifest.json');
const readManifest = async () => readJson(await manifestPath(), []);
const writeManifest = async (m) => writeJson(await manifestPath(), m);

export async function moveToBin(entry, groupId = null, reason = 'Duplicate') {
  const id = crypto.randomUUID();
  const dest = path.join(await binDir(), `${id}${path.extname(entry.name)}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(entry.abs, dest);
  await fs.rename(`${entry.abs}.xmp`, `${dest}.xmp`).catch(() => {});
  const m = await readManifest();
  m.push({ binId: id, name: entry.name, originalRel: entry.rel, size: entry.size, deletedAt: new Date().toISOString(), groupId, reason });
  await writeManifest(m);
  invalidateIndex();
  return id;
}

export async function listBin() {
  const m = await readManifest();
  return { items: m.reverse(), totalBytes: m.reduce((s, x) => s + x.size, 0) };
}

export async function restoreFromBin(binId) {
  const m = await readManifest();
  const item = m.find((x) => x.binId === binId);
  if (!item) throw httpError(404, 'Not in bin');
  const { archiveRoot } = await getSettings();
  const from = path.join(await binDir(), `${binId}${path.extname(item.name)}`);
  const to = await moveNoClobber(from, safeResolve(archiveRoot, item.originalRel));
  await moveNoClobber(`${from}.xmp`, `${to}.xmp`).catch(() => {});
  await writeManifest(m.filter((x) => x.binId !== binId));
  invalidateIndex();
}

export async function emptyBin() {
  const m = await readManifest();
  for (const item of m) {
    const p = path.join(await binDir(), `${item.binId}${path.extname(item.name)}`);
    await fs.rm(p, { force: true });
    await fs.rm(`${p}.xmp`, { force: true });
  }
  await writeManifest([]);
  return { removed: m.length, freedBytes: m.reduce((s, x) => s + x.size, 0) };
}

// ---------- scanning ----------
async function dhash(abs) {
  // 9x8 grayscale; each bit = left pixel brighter than right. Returns [hi, lo] 32-bit halves.
  const img = sharp(abs, { failOn: 'none' }).rotate();
  const [{ data }, meta] = await Promise.all([img.clone().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true }), img.metadata()]);
  let hi = 0, lo = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = data[y * 9 + x] > data[y * 9 + x + 1] ? 1 : 0;
      const n = y * 8 + x;
      if (n < 32) hi = ((hi << 1) | bit) >>> 0;
      else lo = ((lo << 1) | bit) >>> 0;
    }
  }
  const swap = (meta.orientation ?? 1) >= 5;
  return { hi, lo, width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };
}

const popcount = (n) => {
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i) { while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]]; return i; }
  union(a, b) { this.p[this.find(a)] = this.find(b); }
}

const COPY_MAX_BITS = 3; // ~95% similar: treat as the same photo even if taken far apart

/** Capture time from EXIF (works for JPEG and HEIC); falls back to the file's modified time. */
async function captureTime(f) {
  if (f.kind === 'photo') {
    try {
      const t = await exifr.parse(f.abs, ['DateTimeOriginal', 'CreateDate']);
      const d = t?.DateTimeOriginal ?? t?.CreateDate;
      if (d instanceof Date && !Number.isNaN(d.getTime())) return { ms: d.getTime(), fromExif: true };
    } catch { /* no EXIF */ }
  }
  return { ms: f.mtimeMs, fromExif: false };
}

export async function scan({ mode = 'similar', similarity, scope = 'imports', burstWindowSeconds }, update) {
  const settings = await getSettings();
  similarity = Number.isFinite(similarity) ? similarity : settings.similarityDefault;
  const maxDist = Math.round(((100 - similarity) / 100) * 64);
  const windowMs = (Number.isFinite(burstWindowSeconds) ? burstWindowSeconds : settings.burstWindowSeconds ?? 120) * 1000;

  invalidateIndex();
  const all = [...(await getIndex()).values()];
  const files = scope === 'archive' ? all : all.filter((f) => f.rel.startsWith('Imports/'));
  const uf = new UnionFind(files.length);
  const dims = new Map();
  const taken = new Array(files.length);
  const burstNode = new Set(), copyNode = new Set(); // files joined by a visual match
  const edges = []; // [a, similarity%]
  update({ total: files.length, done: 0, message: 'Finding identical files' });

  // Pass 1: exact duplicates (same size, then same SHA-256)
  const bySize = new Map();
  files.forEach((f, i) => bySize.set(f.size, [...(bySize.get(f.size) ?? []), i]));
  let done = 0;
  for (const idxs of bySize.values()) {
    if (idxs.length > 1) {
      const byHash = new Map();
      for (const i of idxs) {
        const h = await hashFile(files[i].abs).catch(() => null);
        if (h) byHash.set(h, [...(byHash.get(h) ?? []), i]);
      }
      for (const same of byHash.values()) for (let k = 1; k < same.length; k++) uf.union(same[0], same[k]);
    }
    update({ done: (done += idxs.length) });
  }

  // Capture times (also shown in the review screen)
  update({ done: 0, message: 'Reading capture times' });
  for (let i = 0; i < files.length; i++) {
    taken[i] = await captureTime(files[i]);
    if (i % 50 === 0) update({ done: i });
  }

  // Pass 2: visually similar photos (perceptual hash) + time proximity
  if (mode === 'similar') {
    update({ done: 0, message: 'Comparing how photos look' });
    const hashes = [];
    for (let i = 0; i < files.length; i++) {
      if (files[i].kind === 'photo') {
        try {
          const h = await dhash(files[i].abs);
          hashes.push({ i, hi: h.hi, lo: h.lo, t: taken[i].ms });
          dims.set(i, { width: h.width, height: h.height });
        } catch { /* undecodable: exact matching only */ }
      }
      if (i % 25 === 0) update({ done: i });
    }
    const dist = (x, y) => popcount(x.hi ^ y.hi) + popcount(x.lo ^ y.lo);
    const join = (x, y, d, set) => {
      edges.push([x.i, Math.round(100 - (d / 64) * 100)]);
      set.add(x.i); set.add(y.i);
      uf.union(x.i, y.i);
    };
    // Bursts: only compare photos taken within the window (sorted by time, so this is fast)
    const byTime = [...hashes].sort((p, q) => p.t - q.t);
    for (let a = 0; a < byTime.length; a++) {
      for (let b = a + 1; b < byTime.length && byTime[b].t - byTime[a].t <= windowMs; b++) {
        const d = dist(byTime[a], byTime[b]);
        if (d <= maxDist) join(byTime[a], byTime[b], d, burstNode);
      }
    }
    // Copies: near-identical images regardless of when they were taken (re-exports, WhatsApp forwards)
    const copyBits = Math.min(maxDist, COPY_MAX_BITS);
    for (let a = 0; a < hashes.length; a++) {
      for (let b = a + 1; b < hashes.length; b++) {
        const d = dist(hashes[a], hashes[b]);
        if (d <= copyBits) join(hashes[a], hashes[b], d, copyNode);
      }
    }
  }

  // Build groups
  const buckets = new Map();
  files.forEach((_, i) => buckets.set(uf.find(i), [...(buckets.get(uf.find(i)) ?? []), i]));
  const minSim = new Map();
  for (const [a, s] of edges) { const r = uf.find(a); minSim.set(r, Math.min(minSim.get(r) ?? 100, s)); }
  const out = new Map();
  for (const idxs of buckets.values()) {
    if (idxs.length < 2) continue;
    const members = idxs.map((i) => ({
      ...publicFile(files[i]), ...(dims.get(i) ?? {}),
      takenAt: new Date(taken[i].ms).toISOString(), takenFromExif: taken[i].fromExif,
    }));
    const kind = idxs.some((i) => burstNode.has(i)) ? 'burst' : idxs.some((i) => copyNode.has(i)) ? 'copy' : 'exact';
    const best = [...members].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) || b.size - a.size || a.takenAt.localeCompare(b.takenAt))[0];
    const id = idxs.map((i) => files[i].id).sort()[0];
    const times = members.map((m) => Date.parse(m.takenAt));
    out.set(id, {
      id, kind, status: 'pending',
      similarity: kind === 'exact' ? 100 : (minSim.get(uf.find(idxs[0])) ?? 95),
      spanSeconds: Math.round((Math.max(...times) - Math.min(...times)) / 1000),
      files: members.sort((a, b) => a.takenAt.localeCompare(b.takenAt)),
      suggestedKeepId: best.id,
      reclaimableBytes: members.filter((m) => m.id !== best.id).reduce((s, m) => s + m.size, 0),
    });
  }
  groups = out;
  await saveGroups();
  return summary();
}

export async function summary() {
  const g = [...(await loadGroups()).values()].filter((x) => x.status === 'pending');
  return {
    groups: g.length,
    photos: g.reduce((s, x) => s + x.files.length, 0),
    reclaimableBytes: g.reduce((s, x) => s + x.reclaimableBytes, 0),
  };
}

export async function listGroups({ status = 'pending', offset = 0, limit = 50 } = {}) {
  const all = [...(await loadGroups()).values()].filter((g) => g.status === status);
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

export async function getGroup(id) {
  const g = (await loadGroups()).get(id);
  if (!g) throw httpError(404, 'Group not found');
  return g;
}

/** keepId null/'all' keeps everything. Others go to the Review Bin. */
export async function resolveGroup(id, keepId) {
  const g = await getGroup(id);
  const index = await getIndex();
  if (keepId && keepId !== 'all' && !g.files.some((f) => f.id === keepId)) throw httpError(400, 'keepId is not in this group');
  let freed = 0;
  if (keepId && keepId !== 'all') {
    for (const f of g.files) {
      if (f.id === keepId) continue;
      const entry = index.get(f.id);
      if (entry) {
        await moveToBin(entry, g.id, 'Duplicate');
        freed += f.size;
      }
    }
  }
  g.status = 'resolved';
  g.keptId = keepId ?? 'all';
  await saveGroups();
  return { freedBytes: freed };
}

export async function skipGroup(id) {
  const g = await getGroup(id);
  g.status = 'skipped';
  await saveGroups();
}

/** Move arbitrary library files (screenshots, large videos...) to the bin. */
export async function binByIds(ids, reason) {
  const index = await getIndex();
  let moved = 0;
  for (const id of ids) {
    const e = index.get(id);
    if (e) { await moveToBin(e, null, reason || 'Clean-up'); moved++; }
  }
  return { moved };
}

export async function binFilePath(binId) {
  const item = (await readManifest()).find((x) => x.binId === binId);
  if (!item) throw httpError(404, 'Not in bin');
  return path.join(await binDir(), `${binId}${path.extname(item.name)}`);
}
