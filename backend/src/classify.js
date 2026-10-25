import path from 'node:path';
import sharp from 'sharp';
import exifr from 'exifr';
import { DATA_DIR, getIndex, invalidateIndex, publicFile, readJson, writeJson } from './lib.js';

// Finds likely clutter (screenshots, documents/receipts, forwarded images) from cheap signals.
// It only *suggests* candidates; the UI sends whatever you pick to the Review Bin.

const FILE = path.join(DATA_DIR, 'clutter.json');
const SCREEN_SIZES = new Set([
  '1170x2532', '1179x2556', '1284x2778', '1290x2796', '1125x2436', '828x1792', '750x1334', '1242x2208', '1242x2688', '1080x1920',
  '1080x2340', '1080x2400', '1080x2412', '1440x3200', '1440x3120', '1440x2960', '720x1600', '1080x2160',
]);

const NAME = {
  screenshot: /screen[ _-]?shot|scrnshot|^Screenshot/i,
  whatsapp: /^IMG-\d{8}-WA\d+|whatsapp/i,
  document: /camscanner|adobe ?scan|\bscan(ned)?\b|document|receipt|invoice|aadhaar|aadhar|\bpan\b/i,
};

async function pixelStats(abs) {
  const { data } = await sharp(abs, { failOn: 'none' }).rotate().resize(32, 32, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let light = 0, sat = 0;
  const hist = new Map();
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (0.299 * r + 0.587 * g + 0.114 * b > 185) light++;
    sat += max ? (max - min) / max : 0;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }
  const n = data.length / 3;
  return { lightFrac: light / n, meanSat: sat / n, topColor: Math.max(...hist.values()) / n };
}

async function analyse(f) {
  const reasons = [];
  let meta = {};
  try { meta = await sharp(f.abs, { failOn: 'none' }).metadata(); } catch { /* HEIC etc. */ }
  const w = meta.width ?? 0, h = meta.height ?? 0;
  const dim = `${Math.min(w, h)}x${Math.max(w, h)}`;
  const dimPortrait = `${Math.min(w, h)}x${Math.max(w, h)}`;
  const exif = await exifr.parse(f.abs, ['Make', 'Model', 'GPSLatitude']).catch(() => null);
  const hasCamera = !!(exif?.Make || exif?.Model);
  const hasGps = exif?.GPSLatitude != null;

  const nameShot = NAME.screenshot.test(f.name);
  const nameWa = NAME.whatsapp.test(f.name);
  const nameDoc = NAME.document.test(f.name);
  const ratio = w && h ? Math.max(w, h) / Math.min(w, h) : 0;
  const screenSized = SCREEN_SIZES.has(dimPortrait) || (w > 0 && ratio >= 1.9);

  let category = null, confidence = 'low';

  if (nameShot) { category = 'screenshot'; confidence = 'high'; reasons.push('file name says screenshot'); }
  else if (!hasCamera && screenSized && w) {
    category = 'screenshot';
    confidence = SCREEN_SIZES.has(dimPortrait) ? 'high' : 'medium';
    reasons.push(`phone-screen shape (${w}×${h})`, 'no camera info');
  }

  let stats = null;
  if (!category && w) stats = await pixelStats(f.abs).catch(() => null);

  if (!category && nameDoc) { category = 'document'; confidence = 'medium'; reasons.push('file name looks like a document'); }
  else if (!category && stats && stats.lightFrac >= 0.6 && stats.meanSat < 0.15) {
    category = 'document';
    confidence = hasCamera ? 'low' : 'medium';
    reasons.push(`mostly white/paper-like (${Math.round(stats.lightFrac * 100)}% light, low colour)`);
    reasons.push(hasCamera ? 'taken with a camera (could be a photo of paper)' : 'no camera info');
  }

  if (!category && nameWa) { category = 'forwarded'; confidence = 'high'; reasons.push('WhatsApp file name'); }
  else if (!category && w && !hasCamera && !hasGps && Math.max(w, h) <= 1600 && f.kind === 'photo') {
    category = 'forwarded'; confidence = 'low';
    reasons.push('no camera info or location', `small image (${w}×${h})`);
  }

  return category ? { category, confidence, reasons } : null;
}

let cache = null;
const load = async () => (cache ??= await readJson(FILE, { signature: {}, items: {} }));

export async function scanClutter({ scope = 'imports' } = {}, update) {
  const db = await load();
  invalidateIndex();
  const all = [...(await getIndex()).values()].filter((f) => f.kind === 'photo');
  const files = scope === 'archive' ? all : all.filter((f) => f.rel.startsWith('Imports/'));
  update({ total: files.length, done: 0, message: 'Looking for screenshots and documents' });
  let done = 0;
  const todo = files.filter((f) => db.signature[f.id] !== `${f.size}:${Math.round(f.mtimeMs)}`);
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async (f) => {
      try {
        const r = await analyse(f);
        if (r) db.items[f.id] = r; else delete db.items[f.id];
        db.signature[f.id] = `${f.size}:${Math.round(f.mtimeMs)}`;
      } catch { /* skip unreadable file */ }
    }));
    update({ done: (done = files.length - todo.length + Math.min(i + 6, todo.length)) });
  }
  await writeJson(FILE, db);
  return counts(files.map((f) => f.id));
}

function counts(ids) {
  const out = { screenshot: 0, document: 0, forwarded: 0 };
  for (const id of ids) { const c = cache?.items[id]?.category; if (c) out[c]++; }
  return out;
}

export async function listClutter(category) {
  const db = await load();
  const index = await getIndex();
  const rank = { high: 0, medium: 1, low: 2 };
  return [...index.values()]
    .filter((f) => db.items[f.id]?.category === category)
    .map((f) => ({ ...publicFile(f), confidence: db.items[f.id].confidence, reasons: db.items[f.id].reasons }))
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.modifiedAt.localeCompare(a.modifiedAt));
}
