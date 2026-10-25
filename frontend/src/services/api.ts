// Family Vault data service. All app data flows through this file.
// It talks to the local backend (see ../../backend/API.md). Set VITE_API_URL to change the address.

export interface PhoneUpload {
  running: boolean;
  port?: number;
  urls?: string[];
  qr?: string | null;
  received: { files: number; bytes: number; lastAt: string | null; person: string | null };
  last?: { total: number; newestPhotoAt: string | null; lastAt: string | null; lastCount: number };
}

export type MediaKind = "photo" | "video";

export interface Photo {
  id: string;
  filename: string;
  kind: MediaKind;
  url: string;
  thumb: string;
  width: number;
  height: number;
  sizeBytes: number;
  takenAt: string; // ISO
  takenEstimated?: boolean | undefined; // true when the date was borrowed from neighbouring IMG_ numbers
  takenKnown?: boolean | undefined; // false when no capture date was found (takenAt is then just the file time)
  folder: string; // e.g. "2026/2026-10 Diwali"
  year: number;
  event: string;
  person: string; // whose phone/export it came from
  people: string[]; // who is in the photo (confirmed in digiKam)
  autoPeople: { name: string; score: number }[]; // matched automatically, high confidence
  maybePeople: { name: string; score: number }[]; // possible matches, not counted
  tags?: ("screenshot" | "blurry" | "large-video")[];
}

export interface DuplicateGroup {
  id: string;
  photos: Photo[];
  similarity: number; // 0-100
  exact: boolean;
  kind: "exact" | "copy" | "burst";
  spanSeconds: number; // time between first and last photo
}

export interface ImportBatch {
  id: string;
  quarter: string;
  person: string;
  source: string;
  photos: number;
  videos: number;
  sizeBytes: number;
  importedAt: string;
}

export interface ImportPreview {
  photos: number;
  videos: number;
  bytes: number;
  newFiles?: number | null; // files not yet in the archive (only when a quarter was given)
  sample: { rel: string; kind: MediaKind; size: number }[];
}

export type BackupStatus = "synced" | "behind" | "offline";
export interface BackupTarget {
  id: string;
  name: string;
  role: "master" | "backup" | "offsite";
  path: string;
  lastSynced: string | null;
  fileCount: number;
  status: BackupStatus;
  pending?: number | undefined; // files a backup would copy right now
  pendingBytes?: number | undefined;
}

export interface SyncPlan {
  add: string[];
  update: string[];
  remove: string[];
  counts: { add: number; update: number; remove: number; bytes: number };
  mode: "update" | "mirror";
}

export interface Settings {
  archivePath: string;
  backupPath: string;
  offsitePath: string;
  similarityDefault: number;
  namingPattern: string;
  theme: "light" | "dark" | "system";
  people: string[];
  importReminderMonths: number;
  offsiteReminderMonths: number;
}

export type ClutterCategory = "screenshot" | "document" | "forwarded";
export interface ClutterItem {
  photo: Photo;
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

export interface BinEntry {
  photo: Photo;
  removedAt: string;
  reason: string;
}

export interface Stats {
  totalPhotos: number;
  totalVideos: number;
  archiveBytes: number;
  driveCapacityBytes: number;
  lastImport: string | null;
  lastBackup: string | null;
  backupOverdue: boolean;
}

export const API_URL: string = (import.meta.env?.["VITE_API_URL"] as string | undefined) ?? "http://127.0.0.1:4000/api";

// ---------- low-level helpers ----------
export class ApiError extends Error {}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    const req: RequestInit = { method: init.method ?? "GET" };
    if (init.body !== undefined) {
      req.headers = { "Content-Type": "application/json" };
      req.body = JSON.stringify(init.body);
    }
    res = await fetch(`${API_URL}${path}`, req);
  } catch {
    throw new ApiError("Can't reach the Family Vault backend. Is it running? (cd backend && npm start)");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

interface Job<R = unknown> {
  id: string;
  status: "running" | "done" | "error";
  progress: { done: number; total: number; message: string };
  result: R | null;
  error: string | null;
}

/** Poll a background job until it finishes, reporting progress as 0-100. */
async function runJob<R>(job: Job<R>, onProgress?: (pct: number, message: string) => void): Promise<R> {
  let cur = job;
  while (cur.status === "running") {
    onProgress?.(cur.progress.total ? Math.round((cur.progress.done / cur.progress.total) * 100) : 0, cur.progress.message);
    await new Promise((r) => setTimeout(r, 500));
    cur = await call<Job<R>>(`/jobs/${job.id}`);
  }
  if (cur.status === "error") throw new ApiError(cur.error ?? "Job failed");
  onProgress?.(100, "");
  return cur.result as R;
}

// ---------- backend shapes ----------
interface BFile {
  id: string;
  name: string;
  rel: string;
  folder: string;
  kind: MediaKind;
  size: number;
  modifiedAt: string;
  takenAt?: string;
  takenKnown?: boolean;
  takenEstimated?: boolean;
  person: string | null;
  people?: string[];
  autoPeople?: { name: string; score: number }[];
  maybePeople?: { name: string; score: number }[];
  width?: number;
  height?: number;
}

const EVENT_FOLDER = /^\d{4}\/(\d{4}-\d{2} .+)$/;

function toPhoto(f: BFile): Photo {
  const m = EVENT_FOLDER.exec(f.folder);
  const topYear = /^\d{4}$/.test(f.folder.split("/")[0] ?? "") ? Number(f.folder.split("/")[0]) : null;
  const imports = f.folder.startsWith("Imports/");
  return {
    id: f.id,
    filename: f.name,
    kind: f.kind,
    url: `${API_URL}/files/${f.id}/raw`,
    thumb: `${API_URL}/files/${f.id}/thumb?w=480`,
    width: f.width ?? 0,
    height: f.height ?? 0,
    sizeBytes: f.size,
    takenAt: f.takenAt ?? f.modifiedAt,
    takenKnown: f.takenKnown ?? true,
    takenEstimated: f.takenEstimated,
    folder: f.folder,
    year: topYear ?? new Date(f.takenAt ?? f.modifiedAt).getFullYear(),
    event: m ? m[1]! : imports ? f.folder.replace(/^Imports\//, "Imports · ") : f.folder || "Unsorted",
    person: f.person ?? "",
    people: f.people ?? [],
    autoPeople: f.autoPeople ?? [],
    maybePeople: f.maybePeople ?? [],
  };
}

// ---------- pure helpers ----------
/** Suggest the best photo: highest resolution, then largest file, then earliest. */
export function pickBest(photos: Photo[]): number {
  let best = 0;
  photos.forEach((p, i) => {
    const b = photos[best]!;
    const pr = p.width * p.height;
    const br = b.width * b.height;
    if (pr > br) best = i;
    else if (pr === br) {
      if (p.sizeBytes > b.sizeBytes) best = i;
      else if (p.sizeBytes === b.sizeBytes && p.takenAt < b.takenAt) best = i;
    }
  });
  return best;
}

// ---------- API ----------
interface BackendSettings {
  archiveRoot: string;
  similarityDefault: number;
  people: string[];
  eventFolderPattern: string;
  backupTargets: { id: string; name: string; kind: "backup" | "offsite"; path: string; mode: "update" | "mirror" }[];
}

// Theme and reminder intervals are UI preferences, kept in the browser.
const readPref = <T>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

interface BackendTargetStatus {
  id: string;
  name: string;
  kind: "backup" | "offsite";
  path: string;
  connected: boolean;
  fileCount: number | null;
  pending?: number | null;
  pendingBytes?: number;
  sourceCount: number;
  lastSyncAt?: string;
}

export const api = {
  async getStats(): Promise<Stats> {
    const d = await call<{
      photos: number; videos: number; archiveBytes: number; driveCapacityBytes: number | null;
      lastImportAt: string | null; lastBackupAt: string | null; backupOverdue: boolean;
    }>("/dashboard");
    return {
      totalPhotos: d.photos,
      totalVideos: d.videos,
      archiveBytes: d.archiveBytes,
      driveCapacityBytes: d.driveCapacityBytes ?? 1_000_000_000_000,
      lastImport: d.lastImportAt,
      lastBackup: d.lastBackupAt,
      backupOverdue: d.backupOverdue,
    };
  },

  async getDuplicateSummary() {
    return call<{ groups: number; photos: number; reclaimableBytes: number }>("/duplicates/summary");
  },

  async listImports(): Promise<ImportBatch[]> {
    const d = await call<{ recentImports: { at: string; quarter: string; person: string; copied: number; skipped: number; source: string }[] }>("/dashboard");
    return d.recentImports.map((i) => ({
      id: i.at,
      quarter: i.quarter,
      person: i.person,
      source: i.source,
      photos: i.copied,
      videos: 0,
      sizeBytes: 0,
      importedAt: i.at,
    }));
  },

  async listPhotos(opts: { tag?: "screenshot" | "large-video" } = {}): Promise<Photo[]> {
    const out: Photo[] = [];
    for (let page = 1; page <= 40; page++) {
      const q = new URLSearchParams({ page: String(page), limit: "500" });
      if (opts.tag) q.set("tag", opts.tag);
      const r = await call<{ total: number; items: BFile[] }>(`/library/photos?${q}`);
      out.push(...r.items.map(toPhoto));
      if (out.length >= r.total) break;
    }
    return out;
  },

  async listUnnamed() {
    return (await call<{ groups: { id: string; count: number; photoIds: string[] }[] }>("/people/unnamed")).groups;
  },

  async nameGroup(id: string, name: string, writeToPhotos: boolean) {
    return call<{ batchId: string; name: string; photos: number; written: number; failed: { rel: string; error: string }[] }>(
      `/people/unnamed/${id}/name`, { method: "POST", body: { name, writeToPhotos } },
    );
  },

  async undoNaming(batchId: string) {
    return call<{ restored: number; skipped: string[] }>(`/people/names/${batchId}/undo`, { method: "POST" });
  },

  async dismissGroup(id: string) {
    return call<{ dismissId: string; faces: number }>(`/people/unnamed/${id}/dismiss`, { method: "POST" });
  },

  async undoDismiss(dismissId: string) {
    await call(`/people/dismissed/${dismissId}/undo`, { method: "POST" });
  },

  async listPersonFaces(name: string) {
    return (await call<{ faces: { rel: string; id: string; rect: { x: number; y: number; w: number; h: number }; score: number }[] }>(`/people/${encodeURIComponent(name)}/faces`)).faces;
  },

  async setCover(name: string, rel: string, rect: { x: number; y: number; w: number; h: number }) {
    await call(`/people/${encodeURIComponent(name)}/cover`, { method: "PUT", body: { rel, rect } });
  },

  async clearCover(name: string) {
    await call(`/people/${encodeURIComponent(name)}/cover`, { method: "DELETE" });
  },

  async getPhoneUpload() {
    return call<PhoneUpload>("/upload");
  },
  async startPhoneUpload() {
    return call<PhoneUpload>("/upload/start", { method: "POST" });
  },
  async stopPhoneUpload() {
    return call<PhoneUpload>("/upload/stop", { method: "POST" });
  },
  async resetPhoneUploadLink() {
    return call<PhoneUpload>("/upload/reset-token", { method: "POST" });
  },

  async openDigikam() {
    await call("/digikam/open", { method: "POST" });
  },

  async listPeople() {
    return (await call<{ people: { name: string; count: number; auto: number; hasFace: boolean; coverV?: string | undefined }[] }>("/library/people")).people;
  },

  async previewImport(sourcePath: string, quarter?: string): Promise<ImportPreview> {
    return call<ImportPreview>("/import/preview", { method: "POST", body: { sourcePath, quarter } });
  },
  async lastImportSource() {
    return call<{ source: string | null; at: string | null }>("/import/last");
  },

  async runImport(opts: { sourcePath: string; quarter: string }, onProgress?: (pct: number) => void) {
    const job = await call<Job<{ copied: number; skipped: number; destination: string }>>("/import", { method: "POST", body: opts });
    return runJob(job, onProgress);
  },

  async scanDuplicates(opts: { mode: "exact" | "similar"; threshold: number; scope: "imports" | "archive"; burstSeconds?: number }, onProgress?: (pct: number) => void): Promise<DuplicateGroup[]> {
    const job = await call<Job>("/duplicates/scan", { method: "POST", body: { mode: opts.mode, similarity: opts.threshold, scope: opts.scope, burstWindowSeconds: opts.burstSeconds } });
    await runJob(job, onProgress);
    const r = await call<{ items: { id: string; kind: "exact" | "copy" | "burst"; similarity: number; spanSeconds: number; files: BFile[] }[] }>("/duplicates/groups?limit=200");
    return r.items.map((g) => ({ id: g.id, exact: g.kind === "exact", kind: g.kind, similarity: g.similarity, spanSeconds: g.spanSeconds, photos: g.files.map(toPhoto) }));
  },

  /** keepId = the photo to keep (others go to the Review Bin), or "all" to keep everything. */
  async resolveGroup(groupId: string, keepId: string) {
    return call<{ freedBytes: number }>(`/duplicates/groups/${groupId}/resolve`, { method: "POST", body: { keepId } });
  },
  async skipGroup(groupId: string) {
    await call(`/duplicates/groups/${groupId}/skip`, { method: "POST", body: {} });
  },

  // ---- Other clean-up (screenshots, documents, forwarded images) ----
  async scanClutter(scope: "imports" | "archive", onProgress?: (pct: number) => void) {
    const job = await call<Job<Record<ClutterCategory, number>>>("/cleanup/scan", { method: "POST", body: { scope } });
    return runJob(job, onProgress);
  },
  async listClutter(category: ClutterCategory): Promise<ClutterItem[]> {
    const r = await call<{ items: (BFile & { confidence: ClutterItem["confidence"]; reasons: string[] })[] }>(`/cleanup/items?category=${category}`);
    return r.items.map((f) => ({ photo: toPhoto(f), confidence: f.confidence, reasons: f.reasons }));
  },

  // ---- Review Bin ----
  async getBin(): Promise<BinEntry[]> {
    const r = await call<{ items: { binId: string; name: string; originalRel: string; size: number; deletedAt: string; reason?: string }[] }>("/bin");
    return r.items.map((i) => {
      const folder = i.originalRel.split("/").slice(0, -1).join("/");
      const photo: Photo = {
        id: i.binId, filename: i.name, kind: "photo", url: `${API_URL}/bin/${i.binId}/thumb`, thumb: `${API_URL}/bin/${i.binId}/thumb`,
        width: 0, height: 0, sizeBytes: i.size, takenAt: i.deletedAt, folder, year: new Date(i.deletedAt).getFullYear(), event: folder, person: "", people: [], autoPeople: [], maybePeople: [],
      };
      return { photo, removedAt: i.deletedAt, reason: i.reason ?? "Duplicate" };
    });
  },
  async moveToBin(ids: string[], reason: string) {
    return call<{ moved: number }>("/bin", { method: "POST", body: { ids, reason } });
  },
  async restoreFromBin(binIds: string[]) {
    for (const id of binIds) await call(`/bin/${id}/restore`, { method: "POST", body: {} });
  },
  async emptyBin() {
    return call<{ removed: number; freedBytes: number }>("/bin?confirm=yes", { method: "DELETE" });
  },

  // ---- Library ----
  async movePhotos(ids: string[], destFolder: string) {
    return call<{ moved: number }>("/library/move", { method: "POST", body: { ids, destFolder } });
  },

  // ---- Backup ----
  async getTargets(): Promise<BackupTarget[]> {
    const [dash, targets, settings] = await Promise.all([
      call<{ lastImportAt: string | null; archiveBytes: number }>("/dashboard"),
      call<BackendTargetStatus[]>("/backup/targets"),
      call<BackendSettings>("/settings"),
    ]);
    const sourceCount = targets[0]?.sourceCount ?? 0;
    const master: BackupTarget = {
      id: "master", name: "Laptop / SSD1", role: "master", path: settings.archiveRoot,
      lastSynced: dash.lastImportAt, fileCount: sourceCount, status: "synced",
    };
    return [
      master,
      ...targets.map((t): BackupTarget => ({
        id: t.id, name: t.name, role: t.kind, path: t.path, lastSynced: t.lastSyncAt ?? null, fileCount: t.fileCount ?? 0, pending: t.pending ?? undefined, pendingBytes: t.pendingBytes,
        status: !t.connected ? "offline" : t.fileCount === t.sourceCount && t.lastSyncAt ? "synced" : "behind",
      })),
    ];
  },
  async planSync(targetId: string): Promise<SyncPlan> {
    const p = await call<{ mode: "update" | "mirror"; toAdd: number; toUpdate: number; extraOnTarget: number; bytesToCopy: number; sample: { add: { rel: string }[]; update: { rel: string }[]; extra: { rel: string }[] } }>(
      "/backup/sync", { method: "POST", body: { targetId, dryRun: true } },
    );
    return {
      add: p.sample.add.map((f) => f.rel),
      update: p.sample.update.map((f) => f.rel),
      remove: p.mode === "mirror" ? p.sample.extra.map((f) => f.rel) : [],
      counts: { add: p.toAdd, update: p.toUpdate, remove: p.mode === "mirror" ? p.extraOnTarget : 0, bytes: p.bytesToCopy },
      mode: p.mode,
    };
  },
  async runSync(targetId: string, onProgress?: (pct: number) => void) {
    const job = await call<Job<{ copied: number; movedToTrash: number }>>("/backup/sync", { method: "POST", body: { targetId, dryRun: false } });
    return runJob(job, onProgress);
  },
  async verify(targetId: string, onProgress?: (pct: number) => void) {
    const job = await call<Job<{ checked: number; missing: string[]; mismatched: string[]; ok: boolean }>>("/backup/verify", { method: "POST", body: { targetId } });
    return runJob(job, onProgress);
  },

  // ---- Settings ----
  async getSettings(): Promise<Settings> {
    const s = await call<BackendSettings>("/settings");
    return {
      archivePath: s.archiveRoot,
      backupPath: s.backupTargets.find((t) => t.kind === "backup")?.path ?? "",
      offsitePath: s.backupTargets.find((t) => t.kind === "offsite")?.path ?? "",
      similarityDefault: s.similarityDefault,
      namingPattern: s.eventFolderPattern,
      theme: readPref("fv-theme-pref", "dark" as Settings["theme"]),
      people: s.people,
      importReminderMonths: readPref("fv-import-months", 3),
      offsiteReminderMonths: readPref("fv-offsite-months", 6),
    };
  },
  async saveSettings(s: Settings): Promise<Settings> {
    const targets = [
      s.backupPath && { id: "backup", name: "Backup drive", kind: "backup", path: s.backupPath, mode: "update" },
      s.offsitePath && { id: "offsite", name: "Offsite", kind: "offsite", path: s.offsitePath, mode: "update" },
    ].filter(Boolean);
    await call("/settings", {
      method: "PUT",
      body: { archiveRoot: s.archivePath, similarityDefault: s.similarityDefault, people: s.people, eventFolderPattern: s.namingPattern, backupTargets: targets },
    });
    try {
      localStorage.setItem("fv-theme-pref", JSON.stringify(s.theme));
      localStorage.setItem("fv-import-months", JSON.stringify(s.importReminderMonths));
      localStorage.setItem("fv-offsite-months", JSON.stringify(s.offsiteReminderMonths));
    } catch { /* storage unavailable */ }
    return api.getSettings();
  },
};

export function formatBytes(b: number) {
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}

export function formatDate(iso: string | null) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatSpan(sec: number) {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} days`;
}

export function currentQuarter(d = new Date()) {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}
