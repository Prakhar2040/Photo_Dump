import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { DATA_DIR, getIndex, invalidateIndex, unnamedClusters, httpError, safeSegment, readJson, writeJson } from './lib.js';

// Names given inside this app to groups of unnamed faces ("Who is this?").
//  1) Always kept in data/names.json (the matcher uses these faces as references, so new photos match too).
//  2) Optionally written into each photo's digiKam sidecar (<photo>.xmp) so digiKam and backups carry the name.
// Each naming is a batch that can be undone: the sidecar as it was before is kept in data/xmp-backup/<batch>/.

export const NAMES_FILE = path.join(DATA_DIR, 'names.json');
const BACKUPS = path.join(DATA_DIR, 'xmp-backup');
const BLOCKED = new Set(['unknown', 'unconfirmed', 'ignored', 'people']);

const rectKey = (rel, r) => `${rel}|${r.x},${r.y},${r.w},${r.h}`;
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const num = (n) => String(Math.round(n * 1e6) / 1e6);

let store = null;
async function load() {
  store ??= await readJson(NAMES_FILE, { batches: [] });
  store.dismissals ??= [];
  store.covers ??= {};
  return store;
}

/** Map of "rel|x,y,w,h" -> name, for faces that were named inside the app. */
export async function appNames() {
  const m = new Map();
  for (const b of (await load()).batches) for (const it of b.items) m.set(rectKey(it.rel, it.rect), b.name);
  return m;
}

const NS = {
  digiKam: 'http://www.digikam.org/ns/1.0/',
  lr: 'http://ns.adobe.com/lightroom/1.0/',
  'mwg-rs': 'http://www.metadataworkinggroup.com/schemas/regions/',
  stDim: 'http://ns.adobe.com/xap/1.0/sType/Dimensions#',
  stArea: 'http://ns.adobe.com/xmp/sType/Area#',
};

export const FRESH = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:digiKam="${NS.digiKam}"
   xmlns:lr="${NS.lr}"
   xmlns:mwg-rs="${NS['mwg-rs']}"
   xmlns:stDim="${NS.stDim}"
   xmlns:stArea="${NS.stArea}">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/** Add <rdf:li>item</rdf:li> to the list inside <tag>...</tag>, creating the property if it is missing. */
function addToList(text, tag, container, li) {
  const re = new RegExp(`(<${tag}>[\\s\\S]*?)(</rdf:${container}>)`);
  if (re.test(text)) {
    const block = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`).exec(text)[0];
    if (block.includes(li)) return text;
    return text.replace(re, (_m, a, b) => `${a} ${li}\n    ${b}`);
  }
  return text.replace(/(\s*)<\/rdf:Description>/, (_m, ws) => `\n   <${tag}>\n    <rdf:${container}>\n     ${li}\n    </rdf:${container}>\n   </${tag}>${ws}</rdf:Description>`);
}

export function patchXmp(text, name, boxes, dims) {
  for (const [p, uri] of Object.entries(NS)) {
    if (!text.includes(`xmlns:${p}=`)) text = text.replace(/<rdf:Description\b/, () => `<rdf:Description xmlns:${p}="${uri}"`);
  }
  text = addToList(text, 'digiKam:TagsList', 'Seq', `<rdf:li>People/${xml(name)}</rdf:li>`);
  text = addToList(text, 'lr:hierarchicalSubject', 'Bag', `<rdf:li>People|${xml(name)}</rdf:li>`);
  const items = boxes.map((b) => `<rdf:li>
       <rdf:Description
        mwg-rs:Name="${xml(name)}"
        mwg-rs:Type="Face">
       <mwg-rs:Area
        stArea:x="${num(b.x)}"
        stArea:y="${num(b.y)}"
        stArea:w="${num(b.w)}"
        stArea:h="${num(b.h)}"
        stArea:unit="normalized"/>
       </rdf:Description>
      </rdf:li>`).join('\n      ');
  if (/<mwg-rs:RegionList>/.test(text)) {
    text = text.replace(/(<mwg-rs:RegionList>[\s\S]*?)(\s*<\/rdf:Bag>\s*<\/mwg-rs:RegionList>)/, (_m, a, b) => `${a}\n      ${items}${b}`);
  } else {
    text = text.replace(/(\s*)<\/rdf:Description>/, (_m, ws) => `
   <mwg-rs:Regions rdf:parseType="Resource">
    <mwg-rs:AppliedToDimensions
     stDim:w="${dims.w}"
     stDim:h="${dims.h}"
     stDim:unit="pixel"/>
    <mwg-rs:RegionList>
     <rdf:Bag>
      ${items}
     </rdf:Bag>
    </mwg-rs:RegionList>
   </mwg-rs:Regions>${ws}</rdf:Description>`);
  }
  return text;
}

async function imageDims(abs) {
  const m = await sharp(abs, { failOn: 'none' }).metadata();
  return m.orientation >= 5 ? { w: m.height, h: m.width } : { w: m.width, h: m.height }; // as displayed
}

async function writeSidecar(f, name, rects, batchId) {
  const xmp = `${f.abs}.xmp`;
  const before = await fs.readFile(xmp, 'utf8').catch(() => null);
  if (before !== null) {
    const copy = path.join(BACKUPS, batchId, `${f.rel}.xmp`);
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.writeFile(copy, before);
  }
  const dims = await imageDims(f.abs);
  const boxes = rects.map((r) => ({ x: (r.x + r.w / 2) / dims.w, y: (r.y + r.h / 2) / dims.h, w: r.w / dims.w, h: r.h / dims.h }));
  const out = patchXmp(before ?? FRESH, name, boxes, dims);
  await fs.writeFile(`${xmp}.tmp`, out);
  await fs.rename(`${xmp}.tmp`, xmp);
  const st = await fs.stat(xmp);
  return { rel: f.rel, created: before === null, mtimeMs: st.mtimeMs };
}

export async function nameGroup(groupId, rawName, writeToPhotos) {
  const name = safeSegment(String(rawName ?? ''));
  if (!name || BLOCKED.has(name.toLowerCase()) || name.includes('/')) throw httpError(400, 'Enter a name');
  const cluster = unnamedClusters.list.find((c) => c.id === groupId);
  if (!cluster?.members?.length) throw httpError(404, 'Unknown group. Refresh the page; the faces may already be named.');
  const index = await getIndex();
  const byRel = new Map([...index.values()].map((f) => [f.rel, f]));
  const members = cluster.members.filter((m) => byRel.has(m.rel));
  const s = await load();
  const batch = { id: crypto.randomUUID(), name, at: new Date().toISOString(), items: members, sidecars: [] };
  const failed = [];
  if (writeToPhotos) {
    const perPhoto = new Map();
    for (const m of members) perPhoto.set(m.rel, [...(perPhoto.get(m.rel) ?? []), m.rect]);
    for (const [rel, rects] of perPhoto) {
      try { batch.sidecars.push(await writeSidecar(byRel.get(rel), name, rects, batch.id)); }
      catch (e) { failed.push({ rel, error: e.message }); }
    }
  }
  s.batches.push(batch);
  await writeJson(NAMES_FILE, s);
  unnamedClusters.list = unnamedClusters.list.filter((c) => c.id !== groupId);
  invalidateIndex();
  return { batchId: batch.id, name, photos: new Set(members.map((m) => m.rel)).size, written: batch.sidecars.length, failed };
}

/** Forget a naming and put the sidecars back as they were (only if digiKam has not changed them since). */
export async function undoBatch(batchId) {
  const s = await load();
  const batch = s.batches.find((b) => b.id === batchId);
  if (!batch) throw httpError(404, 'Unknown naming');
  const index = await getIndex();
  const byRel = new Map([...index.values()].map((f) => [f.rel, f]));
  let restored = 0;
  const skipped = [];
  for (const sc of batch.sidecars) {
    const f = byRel.get(sc.rel);
    if (!f) continue;
    const xmp = `${f.abs}.xmp`;
    const st = await fs.stat(xmp).catch(() => null);
    if (st && Math.abs(st.mtimeMs - sc.mtimeMs) > 2) { skipped.push(sc.rel); continue; }
    if (sc.created) await fs.rm(xmp, { force: true });
    else await fs.copyFile(path.join(BACKUPS, batch.id, `${sc.rel}.xmp`), xmp);
    restored++;
  }
  s.batches = s.batches.filter((b) => b.id !== batchId);
  await writeJson(NAMES_FILE, s);
  await fs.rm(path.join(BACKUPS, batch.id), { recursive: true, force: true });
  invalidateIndex();
  return { restored, skipped };
}

/** Faces the user said they don't care about (a stranger in the background). Kept out of the "Who is this?" row. */
export async function dismissedKeys() {
  return new Set((await load()).dismissals.flatMap((d) => d.items.map((it) => rectKey(it.rel, it.rect))));
}

export async function dismissGroup(groupId) {
  const cluster = unnamedClusters.list.find((c) => c.id === groupId);
  if (!cluster?.members?.length) throw httpError(404, 'Unknown group');
  const s = await load();
  const d = { id: crypto.randomUUID(), at: new Date().toISOString(), items: cluster.members };
  s.dismissals.push(d);
  await writeJson(NAMES_FILE, s);
  unnamedClusters.list = unnamedClusters.list.filter((c) => c.id !== groupId);
  return { dismissId: d.id, faces: d.items.length };
}

export async function undoDismiss(dismissId) {
  const s = await load();
  if (!s.dismissals.some((d) => d.id === dismissId)) throw httpError(404, 'Unknown dismissal');
  s.dismissals = s.dismissals.filter((d) => d.id !== dismissId);
  await writeJson(NAMES_FILE, s);
}

/** Cover photo for a person: a face box (pixels, upright image) chosen by the user. */
export async function getCover(name) {
  return (await load()).covers[name] ?? null;
}

export async function setCover(name, rel, rect) {
  const f = [...(await getIndex()).values()].find((x) => x.rel === rel);
  const ok = f && f.kind === 'photo' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(rect?.[k]) && rect[k] >= 0) && rect.w > 0 && rect.h > 0;
  if (!ok) throw httpError(400, 'Not a valid face');
  const s = await load();
  s.covers[name] = { rel, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, v: Date.now().toString(36) };
  await writeJson(NAMES_FILE, s);
  return s.covers[name];
}

export async function clearCover(name) {
  const s = await load();
  delete s.covers[name];
  await writeJson(NAMES_FILE, s);
}
