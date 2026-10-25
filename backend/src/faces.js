import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { appNames, dismissedKeys } from './names.js';
import { DATA_DIR, getSettings, getIndex, invalidateIndex, faceResults, unnamedClusters, readJson, writeJson } from './lib.js';

// Names faces automatically. digiKam finds the faces (its database has the boxes) and you confirm a few
// by name; this module fingerprints every face with the same SFace model digiKam downloads, compares each
// unnamed face with the confirmed ones, and records a name plus a confidence score.
//   score >= acceptThreshold  -> counted as that person ("auto")
//   score >= suggestThreshold -> shown as a possible match ("maybe") but not counted
// Nothing is written to your photos or to digiKam.

// digiKam's folders: %LOCALAPPDATA% on Windows; ~/.local/share and ~/.config (XDG) on Linux.
const DATA_HOME = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const CONFIG_HOME = process.env.LOCALAPPDATA || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const DIGIKAM_DIR = path.join(DATA_HOME, 'digikam');
// The two face models ship with the app (../models); otherwise use the copies digiKam downloaded.
const MODEL_DIRS = [process.env.MODELS_DIR, fileURLToPath(new URL('../models', import.meta.url)), path.join(DIGIKAM_DIR, 'facesengine')].filter(Boolean);
const findModel = (name) => MODEL_DIRS.map((d) => path.join(d, name)).find((p) => existsSync(p)) ?? path.join(MODEL_DIRS.at(-1), name);
const MODEL = process.env.SFACE_MODEL || findModel('face_recognition_sface_2021dec.onnx');

// digiKam keeps its database where its own settings say (Database Name=...); fall back to the usual folder.
function digikamDb() {
  if (process.env.DIGIKAM_DB) return process.env.DIGIKAM_DB;
  try {
    const rc = readFileSync(path.join(CONFIG_HOME, 'digikamrc'), 'utf8');
    const dir = /^Database Name=(.+)$/m.exec(rc)?.[1]?.trim();
    if (dir) return path.join(dir, 'digikam4.db');
  } catch { /* digiKam not set up yet */ }
  return process.platform === 'win32' ? 'C:/DigiCam Images/digikam4.db' : path.join(os.homedir(), 'Pictures', 'digikam4.db');
}
const DB_FILE = digikamDb();
const RESULTS_FILE = path.join(DATA_DIR, 'faces.json');
const EMB_FILE = path.join(DATA_DIR, 'face-embeddings.json');

let session = null;
async function getSession() {
  session ??= await ort.InferenceSession.create(MODEL, { logSeverityLevel: 3 });
  return session;
}

const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }; // vectors are unit length

const YUNET = process.env.YUNET_MODEL || findModel('face_detection_yunet_2023mar.onnx');
let yunet = null;
async function getYunet() {
  yunet ??= await ort.InferenceSession.create(YUNET, { logSeverityLevel: 3 });
  return yunet;
}

// Standard 112x112 template for the SFace/ArcFace family: left eye, right eye, nose, left mouth, right mouth.
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

/** Find the five landmarks of the face nearest the middle of a square crop (YuNet needs a 640x640 input). */
async function landmarks(raw, info, rect) {
  const side = Math.round(Math.min(Math.max(rect.w, rect.h) * 1.9, Math.min(info.width, info.height)));
  const left = Math.round(Math.min(Math.max(rect.x + rect.w / 2 - side / 2, 0), info.width - side));
  const top = Math.round(Math.min(Math.max(rect.y + rect.h / 2 - side / 2, 0), info.height - side));
  const px = await sharp(raw, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .extract({ left, top, width: side, height: side }).resize(640, 640).removeAlpha().raw().toBuffer();
  const f = new Float32Array(3 * 640 * 640);
  for (let i = 0; i < 640 * 640; i++) for (let c = 0; c < 3; c++) f[c * 640 * 640 + i] = px[i * 3 + 2 - c]; // BGR
  const s = await getYunet();
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, 640, 640]) });
  const scale = side / 640;
  const cx0 = (rect.x + rect.w / 2 - left) / scale, cy0 = (rect.y + rect.h / 2 - top) / scale; // wanted face centre in 640 space
  let best = null;
  for (const st of [8, 16, 32]) {
    const cls = out[`cls_${st}`].data, obj = out[`obj_${st}`].data, bb = out[`bbox_${st}`].data, kp = out[`kps_${st}`].data;
    const cols = 640 / st;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(Math.max(cls[i], 0), 1) * Math.min(Math.max(obj[i], 0), 1));
      if (score < 0.5) continue;
      const r = Math.floor(i / cols), c = i % cols;
      const cx = (c + bb[i * 4]) * st, cy = (r + bb[i * 4 + 1]) * st;
      const d = Math.hypot(cx - cx0, cy - cy0) - score * 20; // prefer the face closest to the expected centre
      if (!best || d < best.d) {
        best = { d, pts: Array.from({ length: 5 }, (_, k) => [((kp[i * 10 + 2 * k] + c) * st) * scale + left, ((kp[i * 10 + 2 * k + 1] + r) * st) * scale + top]) };
      }
    }
  }
  return best?.pts ?? null;
}

/** Warp the face so its landmarks sit on the template (similarity transform), then fingerprint it. */
async function embed(raw, info, rect) {
  const pts = await landmarks(raw, info, rect);
  if (!pts) return null; // no clear frontal-ish face (profiles, blur): don't guess
  // Least-squares similarity transform dst = a*src + b, treating points as complex numbers.
  const mean = (arr) => arr.reduce((m, p) => [m[0] + p[0] / arr.length, m[1] + p[1] / arr.length], [0, 0]);
  const ms = mean(pts), md = mean(TEMPLATE);
  let nr = 0, ni = 0, den = 0;
  pts.forEach((p, k) => {
    const sx = p[0] - ms[0], sy = p[1] - ms[1], dx = TEMPLATE[k][0] - md[0], dy = TEMPLATE[k][1] - md[1];
    nr += sx * dx + sy * dy; ni += sx * dy - sy * dx; den += sx * sx + sy * sy;
  });
  const ar = nr / den, ai = ni / den; // a = ar + i*ai
  const inv = ar * ar + ai * ai;
  const f = new Float32Array(3 * 112 * 112);
  const ch = info.channels;
  for (let v = 0; v < 112; v++) {
    for (let u = 0; u < 112; u++) {
      // source = (dst - md) / a + ms
      const dx = u - md[0], dy = v - md[1];
      const x = (dx * ar + dy * ai) / inv + ms[0], y = (dy * ar - dx * ai) / inv + ms[1];
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      for (let c = 0; c < 3; c++) {
        const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= info.width || yy >= info.height ? 0 : raw[(yy * info.width + xx) * ch + c]);
        f[c * 112 * 112 + v * 112 + u] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      }
    }
  }
  const s = await getSession();
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, 112, 112]) });
  const vec = Float32Array.from(out[s.outputNames[0]].data);
  const norm = Math.hypot(...vec) || 1;
  return vec.map((x) => x / norm);
}

/** Read digiKam's detected faces and confirmed names from a copy of its database. */
async function readDigikam(archiveRoot) {
  const tmp = path.join(DATA_DIR, 'digikam-copy.db');
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.copyFile(DB_FILE, tmp);
  await fs.copyFile(`${DB_FILE}-wal`, `${tmp}-wal`).catch(() => fs.rm(`${tmp}-wal`, { force: true }));
  const db = new DatabaseSync(tmp, { readOnly: true });
  try {
    const norm = (p) => path.resolve(p).replace(/^[A-Za-z]:/, '').replace(/\\/g, '/').toLowerCase();
    const root = db.prepare('select id, specificPath from AlbumRoots').all().find((r) => norm(archiveRoot) === String(r.specificPath).toLowerCase());
    if (!root) return new Map();
    const rows = db.prepare(`
      select a.relativePath rp, i.name, p.property, p.value, t.name tname, t.pid
      from ImageTagProperties p join Images i on i.id = p.imageid join Albums a on a.id = i.album join Tags t on t.id = p.tagid
      where a.albumRoot = ? and p.property in ('autodetectedFace', 'tagRegion')`).all(root.id);
    const out = new Map(); // rel -> { detected: [rect], confirmed: [{rect, name}] }
    for (const r of rows) {
      const m = /x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/.exec(r.value);
      if (!m) continue;
      const rel = `${r.rp.replace(/^\//, '')}/${r.name}`.replace(/^\//, '');
      const e = out.get(rel) ?? { detected: [], confirmed: [] };
      const rect = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
      if (r.property === 'autodetectedFace') e.detected.push(rect);
      else if (r.pid === 4 && !['Unknown', 'Unconfirmed', 'Ignored'].includes(r.tname)) e.confirmed.push({ rect, name: r.tname });
      out.set(rel, e);
    }
    return out;
  } finally {
    db.close();
  }
}

const centreIn = (r, box) => { const cx = r.x + r.w / 2, cy = r.y + r.h / 2; return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h; };

let running = null;
export function analyseFaces(update = () => {}) {
  running ??= doAnalyse(update).finally(() => { running = null; });
  return running;
}

async function doAnalyse(update) {
  const settings = await getSettings();
  const locked = new Set(settings.lockedPeople ?? []); // when set: only these people, no suggestions, no unnamed groups
  const accept = settings.faceAcceptThreshold ?? 0.5;
  const suggest = settings.faceSuggestThreshold ?? 0.4; // tuned on this family (OpenCV publishes 0.363 as the generic cut-off)
  const dk = await readDigikam(settings.archiveRoot);
  const index = await getIndex();
  const byRel = new Map([...index.values()].map((f) => [f.rel, f]));
  const cache = await readJson(EMB_FILE, {});
  const named = await appNames();
  const hidden = await dismissedKeys(); // faces named from the Library's "Who is this?" row

  // 1) fingerprint every detected face
  const faces = []; // { rel, rect, emb, name|null }
  const rels = [...dk.keys()].filter((r) => byRel.has(r));
  update({ total: rels.length, done: 0, message: 'Fingerprinting faces' });
  let n = 0;
  for (const rel of rels) {
    const f = byRel.get(rel), e = dk.get(rel);
    const key = (rect) => `${rel}|${Math.round(f.mtimeMs)}|${rect.x},${rect.y},${rect.w},${rect.h}`;
    const rects = e.detected.length ? e.detected : [];
    // A confirmed hand-drawn box with no detected face inside it still counts (crop its upper part).
    for (const c of e.confirmed) if (!rects.some((r) => centreIn(r, c.rect))) rects.push({ x: c.rect.x, y: c.rect.y, w: c.rect.w, h: Math.min(c.rect.h, c.rect.w * 1.2) });
    let upright = null;
    for (const rect of rects) {
      let emb = cache[key(rect)];
      if (emb === 0) continue; // already tried: no usable face here
      if (!emb) {
        try {
          upright ??= await sharp(f.abs, { failOn: 'none' }).rotate().raw().toBuffer({ resolveWithObject: true });
          emb = await embed(upright.data, upright.info, rect);
          cache[key(rect)] = emb ? Array.from(emb, (x) => Math.round(x * 1e5) / 1e5) : 0;
        } catch { continue; } // unreadable image: skip it
      }
      if (!emb) continue;
      const dkName = e.confirmed.find((c) => centreIn(rect, c.rect))?.name ?? null;
      const appName = dkName ? null : named.get(`${rel}|${rect.x},${rect.y},${rect.w},${rect.h}`) ?? null;
      faces.push({ rel, rect, emb: Float32Array.from(emb), name: dkName ?? appName, app: !!appName });
    }
    update({ done: ++n });
  }
  await writeJson(EMB_FILE, cache);

  // 2) name the unnamed faces by comparing with the confirmed ones
  const refs = faces.filter((x) => x.name && (!locked.size || locked.has(x.name)));
  const results = {}; // rel -> [{ name, score, status, rect }]
  const loose = []; // faces with no name and no suggestion
  for (const fc of faces) {
    let entry;
    if (locked.size && fc.name && !locked.has(fc.name)) continue; // a name outside the locked list: ignore it
    if (fc.name) entry = { name: fc.name, score: 1, status: fc.app ? 'auto' : 'confirmed', rect: fc.rect }; // named in this app only: counts as a match until digiKam has it too
    else {
      const best = new Map();
      for (const r of refs) best.set(r.name, Math.max(best.get(r.name) ?? -1, cosine(fc.emb, r.emb)));
      const [name, score] = [...best].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      if (name && score >= (locked.size ? accept : suggest)) entry = { name, score: Math.round(score * 1000) / 1000, status: score >= accept ? 'auto' : 'maybe', rect: fc.rect };
    }
    if (entry) (results[fc.rel] ??= []).push(entry);
    else if (!locked.size && Math.min(fc.rect.w, fc.rect.h) >= 60 && !hidden.has(`${fc.rel}|${fc.rect.x},${fc.rect.y},${fc.rect.w},${fc.rect.h}`)) loose.push(fc);
  }

  // 3) group the faces nobody has named yet, so the app can show "who is this?" cards
  const unnamed = [];
  for (const fc of loose) {
    let hit = null, top = 0.45;
    for (const c of unnamed) { const s = cosine(fc.emb, c.emb); if (s > top) { top = s; hit = c; } }
    if (hit) {
      hit.members.push(fc);
      if (fc.rect.w * fc.rect.h > hit.best.rect.w * hit.best.rect.h) hit.best = fc; // show the biggest face on the card
    } else unnamed.push({ emb: fc.emb, members: [fc], best: fc });
  }
  const clusters = unnamed
    .map((c) => ({
      id: crypto.createHash('sha1').update(`${c.members[0].rel}|${JSON.stringify(c.members[0].rect)}`).digest('hex').slice(0, 12),
      count: new Set(c.members.map((m) => m.rel)).size,
      rels: [...new Set(c.members.map((m) => m.rel))],
      rel: c.best.rel,
      rect: c.best.rect,
      members: c.members.map((m) => ({ rel: m.rel, rect: m.rect })),
    }))
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);

  await writeJson(RESULTS_FILE, { at: new Date().toISOString(), accept, suggest, results, unnamed: clusters });
  applyResults(results, clusters);
  invalidateIndex();
  return summarise(results);
}

function applyResults(results, clusters = []) {
  unnamedClusters.list = clusters;
  faceResults.clear();
  for (const [rel, list] of Object.entries(results)) faceResults.set(rel, list);
}

function summarise(results) {
  const out = { photos: Object.keys(results).length, confirmed: 0, auto: 0, maybe: 0 };
  for (const l of Object.values(results)) for (const f of l) out[f.status]++;
  return out;
}

export async function loadSavedResults() {
  const saved = await readJson(RESULTS_FILE, null);
  if (saved?.results) applyResults(saved.results, saved.unnamed ?? []);
}

/** Re-run when digiKam's database changes (new faces detected, names confirmed). */
export function watchDigikam(intervalMs = 30000) {
  let last = 0;
  const tick = async () => {
    try {
      const mt = Math.max(...(await Promise.all([DB_FILE, `${DB_FILE}-wal`].map((f) => fs.stat(f).then((s) => s.mtimeMs, () => 0)))));
      if (mt && mt !== last) {
        await analyseFaces();
        last = mt; // only after success, so a failed run retries
      }
    } catch (e) {
      console.error('face analysis failed:', e.message);
    }
  };
  tick();
  setInterval(tick, intervalMs).unref();
}
