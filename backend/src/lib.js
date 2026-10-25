import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import exifr from 'exifr';
import { execFile } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

export const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.bmp', '.heic', '.heif', '.dng']);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.3gp', '.mts']);

const DEFAULTS = {
  archiveRoot: process.env.ARCHIVE_ROOT || path.resolve('..', 'Family Archive'), // dev: sibling of backend/
  similarityDefault: 90,
  burstWindowSeconds: 120,
  people: ['Dad', 'Mom', 'Son', 'Daughter'],
  lockedPeople: [], // when set, only these people are recognised: no other names, no suggestions, no "who is this?" groups
  eventFolderPattern: 'YYYY-MM Event Name',
  autoLaunchDigikam: true, // open digiKam after an import so it indexes new files and detects faces
  backupTargets: [], // { id, name, kind: 'backup' | 'offsite', path, mode: 'update' | 'mirror' }
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export { readJson, writeJson };

let settings;
export async function getSettings() {
  settings ??= { ...DEFAULTS, ...(await readJson(SETTINGS_FILE, {})) };
  return settings;
}

export async function updateSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur };
  if (typeof patch.archiveRoot === 'string') {
    const st = await fs.stat(patch.archiveRoot).catch(() => null);
    if (!st?.isDirectory()) throw httpError(400, 'archiveRoot is not an existing directory');
    next.archiveRoot = path.resolve(patch.archiveRoot);
  }
  if (Number.isFinite(patch.similarityDefault)) next.similarityDefault = Math.min(100, Math.max(70, patch.similarityDefault));
  if (Array.isArray(patch.people)) next.people = patch.people.map((p) => safeSegment(String(p))).filter(Boolean);
  if (Array.isArray(patch.lockedPeople)) next.lockedPeople = [...new Set(patch.lockedPeople.map((p) => safeSegment(String(p))).filter(Boolean))];
  for (const k of ['faceAcceptThreshold', 'faceSuggestThreshold']) if (Number.isFinite(patch[k])) next[k] = Math.min(0.95, Math.max(0.2, patch[k]));
  if (typeof patch.uploadToken === 'string' && /^[\w-]{12,64}$/.test(patch.uploadToken)) next.uploadToken = patch.uploadToken;
  if (typeof patch.autoLaunchDigikam === 'boolean') next.autoLaunchDigikam = patch.autoLaunchDigikam;
  if (typeof patch.eventFolderPattern === 'string') next.eventFolderPattern = patch.eventFolderPattern.slice(0, 80);
  if (Array.isArray(patch.backupTargets)) {
    next.backupTargets = patch.backupTargets.map((t, i) => ({
      id: String(t.id || `target-${i + 1}`),
      name: String(t.name || `Target ${i + 1}`),
      kind: t.kind === 'offsite' ? 'offsite' : 'backup',
      path: path.resolve(String(t.path)),
      mode: t.mode === 'mirror' ? 'mirror' : 'update',
    }));
  }
  for (const t of next.backupTargets ?? []) {
    const root = path.resolve(next.archiveRoot).toLowerCase(), p = path.resolve(t.path).toLowerCase();
    if (p === root || p.startsWith(root + path.sep)) throw httpError(400, 'The backup folder cannot be inside the archive');
    // Create the folder when its drive is there but the folder is new; a missing drive just shows as offline.
    const parent = path.dirname(t.path);
    if (parent !== t.path && (await fs.stat(parent).catch(() => null))?.isDirectory()) await fs.mkdir(t.path, { recursive: true });
  }
  settings = next;
  await writeJson(SETTINGS_FILE, next);
  invalidateIndex();
  return next;
}

let state;
export async function getState() {
  state ??= await readJson(STATE_FILE, { imports: [], backups: {} });
  return state;
}
export async function saveState() {
  await writeJson(STATE_FILE, await getState());
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Strip anything that could escape a folder or be illegal on Windows. */
export function safeSegment(s) {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/^\.+/, '').trim().slice(0, 80);
}

/** Resolve a relative path under root; throws if it would escape. */
export function safeResolve(root, rel) {
  const abs = path.resolve(root, rel || '.');
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw httpError(400, 'Path escapes archive root');
  return abs;
}

export const toPosix = (p) => p.split(path.sep).join('/');
export const fileId = (rel) => crypto.createHash('sha1').update(rel.toLowerCase()).digest('hex').slice(0, 16);
export const fileKind = (name) => {
  const ext = path.extname(name).toLowerCase();
  return PHOTO_EXT.has(ext) ? 'photo' : VIDEO_EXT.has(ext) ? 'video' : null;
};

/** Walk a directory yielding media files. Dot-directories (.bin, .sync-trash) are skipped. */
export async function* walk(root, base = root, sidecars = false) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(root, e.name);
    if (e.isDirectory()) yield* walk(abs, base, sidecars);
    else if (e.isFile() && (fileKind(e.name) || (sidecars && e.name.toLowerCase().endsWith('.xmp')))) {
      const st = await fs.stat(abs);
      yield { abs, rel: toPosix(path.relative(base, abs)), name: e.name, size: st.size, mtimeMs: st.mtimeMs, kind: fileKind(e.name) ?? 'sidecar' };
    }
  }
}

// ---- archive index (id -> entry), rebuilt lazily ----
let indexCache = null;
let indexBuiltAt = 0;
const INDEX_TTL_MS = 15000; // pick up digiKam sidecar edits made outside this app
export function invalidateIndex() {
  indexCache = null;
}

// Face-matching results from faces.js: rel path -> [{ name, score, status: 'confirmed'|'auto'|'maybe', rect }]
export const faceResults = new Map();
// Groups of similar faces nobody has named yet: [{ id, count, rels, rel, rect }]
export const unnamedClusters = { list: [] };

// ---- people from digiKam's .xmp sidecars (<photo>.xmp, tags like "People/Rasika") ----
const NOT_A_PERSON = new Set(['unknown', 'unconfirmed', 'ignored']);
const xmpCache = new Map(); // xmp path -> { mtimeMs, people }
async function readPeople(abs) {
  const xmp = `${abs}.xmp`;
  const st = await fs.stat(xmp).catch(() => null);
  if (!st) return { people: [], faces: [] };
  const hit = xmpCache.get(xmp);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit;
  const text = await fs.readFile(xmp, 'utf8').catch(() => '');
  const block = /<digiKam:TagsList>([\s\S]*?)<\/digiKam:TagsList>/.exec(text)?.[1] ?? '';
  const people = [...block.matchAll(/<rdf:li>People\/([^<]+)<\/rdf:li>/g)]
    .map((m) => m[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim())
    .filter((n) => n && !n.includes('/') && !NOT_A_PERSON.has(n.toLowerCase()));
  const unique = [...new Set(people)].sort();
  // Face boxes (MWG regions): x,y = centre, w,h = size, all 0..1 of the displayed image
  const faces = [];
  const list = /<mwg-rs:RegionList>([\s\S]*?)<\/mwg-rs:RegionList>/.exec(text)?.[1] ?? '';
  for (const part of list.split('<rdf:Description').slice(1)) {
    const name = /mwg-rs:Name="([^"]*)"/.exec(part)?.[1];
    const num = (k) => Number(new RegExp(`stArea:${k}="([0-9.]+)"`).exec(part)?.[1]);
    const box = { x: num('x'), y: num('y'), w: num('w'), h: num('h') };
    if (name && !NOT_A_PERSON.has(name.toLowerCase()) && Object.values(box).every((v) => Number.isFinite(v) && v > 0)) faces.push({ name, ...box });
  }
  const entry = { mtimeMs: st.mtimeMs, people: unique, faces };
  xmpCache.set(xmp, entry);
  return entry;
}
// ---- capture time: EXIF date, else a date in the file name, else the file's modified time ----
const TAKEN_FILE = path.join(DATA_DIR, 'taken.json');
let taken = null;
let takenDirty = false;
const NAME_DATE = /(?:^|[^0-9])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/;
async function captureTime(f) {
  taken ??= await readJson(TAKEN_FILE, {});
  const key = `${f.rel}|${f.size}|${Math.round(f.mtimeMs)}`;
  if (taken[key] !== undefined) return taken[key];
  const ms = await readTaken(f);
  if (!ms) return -Math.round(f.mtimeMs); // negative = no real date found (only the file time); not cached, so a failed read is retried
  taken[key] = ms;
  takenDirty = true;
  return ms;
}
// The real capture time of a file ({ abs, name, kind }), or 0 when neither EXIF, the container nor the file name has one.
export async function readTaken(f) {
  let ms = 0;
  if (f.kind === 'photo') {
    const t = await exifr.parse(f.abs, ['DateTimeOriginal', 'CreateDate']).catch(() => null);
    const d = t?.DateTimeOriginal ?? t?.CreateDate;
    if (d instanceof Date && d.getFullYear() > 1990 && d.getTime() <= Date.now() + 864e5) ms = d.getTime();
  }
  if (!ms && f.kind === 'video') {
    // ffmpeg prints the container's creation_time when asked to open a file with no output
    const err = await new Promise((res) => execFile(ffmpegPath, ['-hide_banner', '-i', f.abs], { timeout: 15000 }, (_e, _out, stderr) => res(String(stderr))));
    const d = Date.parse(/creation_time\s*:\s*(\S+)/.exec(err)?.[1] ?? '');
    if (d > Date.UTC(1990, 0, 1) && d <= Date.now() + 864e5) ms = d;
  }
  if (!ms) {
    const m = NAME_DATE.exec(f.name);
    if (m) ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
  }
  return ms;
}

const takenFields = (v) => ({ takenMs: Math.abs(v), takenKnown: v > 0 });

export async function getIndex() {
  if (indexCache && Date.now() - indexBuiltAt < INDEX_TTL_MS) return indexCache;
  const { archiveRoot, lockedPeople = [] } = await getSettings();
  const locked = new Set(lockedPeople);
  const map = new Map();
  for await (const f of walk(archiveRoot)) {
    const parts = f.rel.split('/');
    const person = parts[0] === 'Imports' && parts.length >= 4 ? parts[2] : null;
    map.set(fileId(f.rel), { id: fileId(f.rel), ...f, ...takenFields(await captureTime(f)), folder: parts.slice(0, -1).join('/'), person, ...(await lockPeople(f.abs, f.rel, locked)) });
  }
  if (takenDirty) { takenDirty = false; await writeJson(TAKEN_FILE, taken); }
  estimateFromNeighbours(map);
  indexCache = map;
  indexBuiltAt = Date.now();
  return map;
}

async function lockPeople(abs, rel, locked) {
  const read = await readPeople(abs);
  const keep = (n) => !locked.size || locked.has(n);
  const people = read.people.filter(keep);
  const m = matchedPeople(rel, people);
  return { ...read, people, autoPeople: m.autoPeople.filter((p) => keep(p.name)), maybePeople: locked.size ? [] : m.maybePeople };
}

// Photos with no date inside them but a camera-style name (IMG_3862) borrow the date of the nearest numbered photo
// from the same person's folder. The number must be close and the neighbours must agree, otherwise we leave it unknown.
const IMG_NUM = /^IMG_(\d{3,5})\./i;
function estimateFromNeighbours(map) {
  const known = new Map(); // person -> [{ n, ms }] sorted by n
  for (const f of map.values()) {
    const n = IMG_NUM.exec(f.name)?.[1];
    if (n && f.takenKnown) (known.get(f.person) ?? known.set(f.person, []).get(f.person)).push({ n: +n, ms: f.takenMs });
  }
  for (const list of known.values()) list.sort((a, b) => a.n - b.n);
  const MAX_GAP = 150, MAX_SPREAD_MS = 30 * 864e5;
  for (const f of map.values()) {
    const n = !f.takenKnown && IMG_NUM.exec(f.name)?.[1];
    const list = n && known.get(f.person);
    if (!list) continue;
    const before = [...list].reverse().find((x) => x.n < +n && +n - x.n <= MAX_GAP);
    const after = list.find((x) => x.n > +n && x.n - +n <= MAX_GAP);
    if (before && after && Math.abs(after.ms - before.ms) > MAX_SPREAD_MS) continue; // neighbours disagree
    const ms = before && after ? Math.round((before.ms + after.ms) / 2) : (before ?? after)?.ms;
    if (ms) Object.assign(f, { takenMs: ms, takenKnown: true, takenEstimated: true });
  }
}

function matchedPeople(rel, confirmed) {
  const found = faceResults.get(rel) ?? [];
  const best = (status) => {
    const m = new Map();
    for (const x of found) if (x.status === status && !confirmed.includes(x.name)) m.set(x.name, Math.max(m.get(x.name) ?? 0, x.score));
    return [...m].sort((a, b) => b[1] - a[1]).map(([name, score]) => ({ name, score }));
  };
  const autoPeople = best('auto');
  const taken = new Set([...confirmed, ...autoPeople.map((p) => p.name)]);
  return { autoPeople, maybePeople: best('maybe').filter((p) => !taken.has(p.name)) };
}

export const publicFile = ({ abs, mtimeMs, takenMs, takenKnown, ...rest }) => ({ ...rest, takenKnown, modifiedAt: new Date(mtimeMs).toISOString(), takenAt: new Date(takenMs ?? mtimeMs).toISOString() });

export function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    createReadStream(abs).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Rename without clobbering: appends " (2)", " (3)"... if the target exists. */
/** Also moves digiKam's <file>.xmp sidecar, if there is one, alongside the photo. */
export async function moveSidecar(from, to) {
  if (await fs.stat(`${from}.xmp`).then(() => true, () => false)) await moveNoClobber(`${from}.xmp`, `${to}.xmp`);
}

export async function moveNoClobber(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  const { dir, name, ext } = path.parse(to);
  let candidate = to;
  for (let i = 2; ; i++) {
    const exists = await fs.stat(candidate).then(() => true, () => false);
    if (!exists) break;
    candidate = path.join(dir, `${name} (${i})${ext}`);
  }
  await fs.rename(from, candidate);
  return candidate;
}

// ---- background jobs, polled by the UI ----
const jobs = new Map();
export function startJob(type, fn) {
  const id = crypto.randomUUID();
  const job = { id, type, status: 'running', progress: { done: 0, total: 0, message: '' }, result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  jobs.set(id, job);
  const update = (p) => Object.assign(job.progress, p);
  fn(update)
    .then((r) => Object.assign(job, { status: 'done', result: r ?? null }))
    .catch((e) => Object.assign(job, { status: 'error', error: e.message }))
    .finally(() => (job.finishedAt = new Date().toISOString()));
  return job;
}
export const getJob = (id) => jobs.get(id);
