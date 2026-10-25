import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import QRCode from 'qrcode';
import { DATA_DIR, getSettings, updateSettings, getState, saveState, getIndex, invalidateIndex, fileKind, readTaken, safeSegment, readJson, writeJson, httpError } from './lib.js';

// Phone upload over Wi-Fi: the app shows a QR code, the phone opens a small page in its browser, picks photos and
// uploads them. This is a SEPARATE listener (port 4001, all interfaces) that can only receive files; the main API
// stays on 127.0.0.1. It runs only while the user has switched it on, and every URL carries a random token.

const PORT = Number(process.env.UPLOAD_PORT) || 4001;
const MAX_BYTES = 12 * 1024 ** 3;
const LEDGER = path.join(DATA_DIR, 'uploads.json'); // "name|size|lastModified" of everything ever received, so deleted duplicates are not re-uploaded

let server = null;
let ledger = null;
const received = { files: 0, bytes: 0, skipped: 0, lastAt: null, person: null };

const quarterNow = () => { const d = new Date(); return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`; };
const sig = (name, size, lm) => `${name}|${size}|${lm}`;
async function getLedger() {
  ledger ??= await readJson(LEDGER, {});
  return ledger;
}

// Where the last upload stopped: when it happened and the newest photo that came across (by the phone's own file date).
async function lastUpload() {
  const l = await getLedger();
  let newest = 0, total = 0;
  for (const k of Object.keys(l)) { const lm = Number(k.slice(k.lastIndexOf('|') + 1)); total++; if (lm > newest) newest = lm; }
  const last = [...(await getState()).imports].reverse().find((i) => String(i.source).startsWith('phone'));
  return { total, newestPhotoAt: newest ? new Date(newest).toISOString() : null, lastAt: last?.at ?? null, lastCount: last?.copied ?? 0 };
}

async function getToken() {
  const s = await getSettings();
  if (s.uploadToken) return s.uploadToken;
  const t = crypto.randomBytes(12).toString('base64url');
  await updateSettings({ uploadToken: t });
  return t;
}
export async function resetToken() {
  await updateSettings({ uploadToken: crypto.randomBytes(12).toString('base64url') });
}

function lanAddresses() {
  const bad = /vethernet|wsl|hyper-v|virtualbox|vmware|loopback|tailscale|docker|bluetooth/i;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (bad.test(name)) continue;
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function buildApp(token, hooks) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/u/:token', (req, res, next) => {
    if (!same(String(req.params.token), token)) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/u/:token', async (_q, res) => res.type('html').send(await fs.readFile(new URL('./upload-page.html', import.meta.url), 'utf8')));

  app.get('/u/:token/last', async (_q, res) => res.json(await lastUpload()));
  app.get('/u/:token/people', async (_q, res) => res.json({ people: (await getSettings()).people }));

  // Which of these files has the laptop not received before? (name + size + last-modified)
  app.post('/u/:token/check', express.json({ limit: '10mb' }), async (req, res) => {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const led = await getLedger();
    const have = new Set([...(await getIndex()).values()].map((f) => `${f.name.toLowerCase()}|${f.size}`));
    const need = [];
    files.forEach((f, i) => {
      const name = path.basename(String(f.name ?? ''));
      const known = led[sig(name, f.size, f.lastModified)] || have.has(`${name.toLowerCase()}|${f.size}`);
      if (!known && fileKind(name)) need.push(i);
    });
    res.json({ need, total: files.length });
  });

  // One file per request, sent as the raw body.
  app.post('/u/:token/file', async (req, res) => {
    try {
      const name = path.basename(safeSegment(String(req.query.name ?? '')));
      const size = Number(req.query.size);
      const lm = Number(req.query.lm) || 0; // 0 = the phone did not say
      if (!name || !fileKind(name)) throw httpError(400, 'Not a photo or video');
      if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) throw httpError(400, 'Bad size');

      const { archiveRoot } = await getSettings();
      const dir = path.join(archiveRoot, 'Imports', quarterNow());
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.upload-${crypto.randomBytes(6).toString('hex')}.part`); // dot-files are invisible to the library
      let got = 0;
      await new Promise((resolve, reject) => {
        const out = createWriteStream(tmp);
        req.on('data', (c) => { got += c.length; if (got > size) req.destroy(new Error('Too much data')); });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        req.on('aborted', () => reject(new Error('Upload interrupted')));
        req.pipe(out);
      }).catch(async (e) => { await fs.rm(tmp, { force: true }); throw e; });
      if (got !== size) { await fs.rm(tmp, { force: true }); throw httpError(400, 'Incomplete upload'); }

      const { name: base, ext } = path.parse(name);
      let to = path.join(dir, name);
      for (let i = 2; await fs.stat(to).then(() => true, () => false); i++) to = path.join(dir, `${base} (${i})${ext}`);
      await fs.rename(tmp, to);
      // Keep the photo's own date: EXIF / video metadata / date in the name first, since Android often reports the copy time as lastModified.
      const takenMs = await readTaken({ abs: to, name: path.basename(to), kind: fileKind(name) }).catch(() => 0);
      const when = takenMs || lm;
      if (when) await fs.utimes(to, new Date(), new Date(when));
      else console.warn(`[upload] no date found for ${name}; keeping the upload time`);
      const led = await getLedger();
      led[sig(name, size, lm)] = path.relative(archiveRoot, to).split(path.sep).join('/');
      await writeJson(LEDGER, led);
      invalidateIndex();
      Object.assign(received, { files: received.files + 1, bytes: received.bytes + size, lastAt: new Date().toISOString() });
      res.json({ ok: true });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // The phone says it is finished: record the import and let digiKam find the new faces.
  app.post('/u/:token/done', express.json(), async (req, res) => {
    const copied = Number(req.body?.copied) || 0;
    if (copied > 0) {
      const state = await getState();
      state.imports.push({ at: new Date().toISOString(), quarter: quarterNow(), copied, skipped: Number(req.body?.skipped) || 0, source: 'phone (Wi-Fi)' });
      await saveState();
      hooks.afterImport?.();
      if ((await getSettings()).autoLaunchDigikam) await hooks.launchDigikam().catch(() => {});
    }
    res.json({ ok: true });
  });

  return app;
}

export async function startUpload(hooks) {
  if (!server) {
    const token = await getToken();
    const s = http.createServer(buildApp(token, hooks));
    s.requestTimeout = 0; // big videos
    s.headersTimeout = 30000;
    await new Promise((resolve, reject) => { s.once('error', reject); s.listen(PORT, '0.0.0.0', resolve); });
    server = s;
  }
  return uploadInfo();
}

export function stopUpload() {
  if (server) { server.closeAllConnections?.(); server.close(); server = null; }
}

export async function uploadInfo() {
  // The QR is built even while the listener is off, so the page can show it greyed out.
  const token = await getToken();
  const urls = lanAddresses().map((ip) => `http://${ip}:${PORT}/u/${token}`);
  const qr = urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 280 }) : null;
  return { running: !!server, port: PORT, urls, qr, received, last: await lastUpload() };
}
