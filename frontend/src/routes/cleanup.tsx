import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Loader2, RotateCcw, Settings2, Sparkles, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { api, formatBytes, formatDateTime, formatSpan, pickBest, type ClutterItem, type DuplicateGroup, type Photo } from "@/services/api";
import { useVault } from "@/lib/vault-store";
import { PageHeader, EmptyState } from "@/components/AppShell";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/cleanup")({
  head: () => ({
    meta: [
      { title: "Clean Up · Family Vault" },
      { name: "description", content: "Find and review duplicate and similar photos, one group at a time." },
      { property: "og:title", content: "Clean Up · Family Vault" },
      { property: "og:description", content: "Find and review duplicate and similar photos, one group at a time." },
    ],
  }),
  component: CleanupPage,
});

function CleanupPage() {
  const { bin } = useVault();
  return (
    <>
      <PageHeader title="Clean Up" subtitle="Find duplicates and clutter. Removed files go to the Review Bin first." />
      <div className="px-6 py-6 md:px-10">
        <Tabs defaultValue="duplicates">
          <TabsList>
            <TabsTrigger value="duplicates">Duplicates</TabsTrigger>
            <TabsTrigger value="other">Other clean-up</TabsTrigger>
            <TabsTrigger value="bin">Review Bin {bin.length > 0 && <Badge variant="secondary" className="ml-1.5">{bin.length}</Badge>}</TabsTrigger>
          </TabsList>
          <TabsContent value="duplicates" className="mt-6"><Duplicates /></TabsContent>
          <TabsContent value="other" className="mt-6"><OtherCleanup /></TabsContent>
          <TabsContent value="bin" className="mt-6"><ReviewBin /></TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function Duplicates() {
  const { settings, session, setSession, refreshBin } = useVault();
  const [mode, setMode] = useState<"exact" | "similar">("similar");
  const [threshold, setThreshold] = useState(settings?.similarityDefault ?? 90);
  const [scope, setScope] = useState<"imports" | "archive">("archive");
  const [burst, setBurst] = useState("120");
  const [advanced, setAdvanced] = useState(false);
  const [scanProgress, setScanProgress] = useState<number | null>(null);

  const scan = async () => {
    setScanProgress(0);
    setSession(null);
    try {
      const groups = await api.scanDuplicates({ mode, threshold, scope, burstSeconds: Number(burst) }, (pct) => setScanProgress(pct));
      setSession({ groups, index: 0, freed: 0, decided: {} });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScanProgress(null);
    }
  };

  const summary = useMemo(() => {
    if (!session) return null;
    const photos = session.groups.reduce((a, g) => a + g.photos.length, 0);
    const freeable = session.groups.reduce((a, g) => {
      const b = pickBest(g.photos);
      return a + g.photos.reduce((s, p, i) => (i === b ? s : s + p.sizeBytes), 0);
    }, 0);
    return { photos, freeable };
  }, [session]);

  return (
    <div className="space-y-6">
      <div className="surface space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-4">
          <Button size="lg" onClick={scan} disabled={scanProgress !== null}>
            {scanProgress !== null ? <Loader2 className="animate-spin" /> : <Sparkles />} Scan for duplicates
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
            <Settings2 /> Advanced settings <ChevronDown className={cn("transition-transform", advanced && "rotate-180")} />
          </Button>
        </div>
        {advanced && (
          <div className="flex flex-wrap items-end gap-6 border-t pt-5">
            <div className="space-y-2">
              <p className="text-sm font-medium">Match</p>
              <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as typeof mode)}>
                <ToggleGroupItem value="exact" className="px-3">Exact only</ToggleGroupItem>
                <ToggleGroupItem value="similar" className="px-3">Similar photos</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className={cn("w-56 space-y-3", mode === "exact" && "opacity-40")}>
              <p className="text-sm font-medium">Similarity · {threshold}%</p>
              <Slider min={70} max={100} step={1} value={[threshold]} onValueChange={(v) => setThreshold(v[0] ?? 90)} disabled={mode === "exact"} />
            </div>
            <div className={cn("space-y-2", mode === "exact" && "opacity-40")}>
              <p className="text-sm font-medium">Burst window</p>
              <Select value={burst} onValueChange={setBurst} disabled={mode === "exact"}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {([["10", "10 seconds"], ["30", "30 seconds"], ["120", "2 minutes"], ["600", "10 minutes"]] as const).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Scope</p>
              <ToggleGroup type="single" variant="outline" value={scope} onValueChange={(v) => v && setScope(v as typeof scope)}>
                <ToggleGroupItem value="imports" className="px-3">Imports folder</ToggleGroupItem>
                <ToggleGroupItem value="archive" className="px-3">Whole archive</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
        )}
      </div>

      {scanProgress !== null && (
        <div className="surface space-y-3 p-6">
          <p className="text-sm text-muted-foreground">Comparing photos… {scanProgress}%</p>
          <Progress value={scanProgress} />
        </div>
      )}

      {scanProgress === null && !session && (
        <EmptyState icon={Sparkles} title="Ready to tidy up" text="Run a scan to find exact copies and near-identical shots." />
      )}

      {session && summary && (
        session.groups.length === 0 ? (
          <EmptyState icon={Check} title="No duplicates found" text="Try lowering the similarity or widening the scope." />
        ) : (
          <>
            <p className="font-display text-2xl">
              {session.groups.length} groups, {summary.photos} photos, {formatBytes(summary.freeable)} can be freed
            </p>
            <GroupReview
              key={session.index}
              group={session.groups[session.index]!}
              index={session.index}
              total={session.groups.length}
              freed={session.freed}
              decision={session.decided[session.groups[session.index]!.id]}
              onNav={(d) => setSession((s) => s && { ...s, index: Math.max(0, Math.min(s.groups.length - 1, s.index + d)) })}
              onDecide={async (kind, removed) => {
                const g = session.groups[session.index]!;
                try {
                  if (kind === "removed") await api.resolveGroup(g.id, g.photos.find((p) => !removed.some((r) => r.id === p.id))!.id);
                  else if (kind === "kept") await api.resolveGroup(g.id, "all");
                  else await api.skipGroup(g.id);
                } catch (e) {
                  toast.error((e as Error).message);
                  return;
                }
                if (removed.length) await refreshBin();
                setSession((s) =>
                  s && {
                    ...s,
                    freed: s.freed + removed.reduce((a, p) => a + p.sizeBytes, 0),
                    decided: { ...s.decided, [s.groups[s.index]!.id]: kind },
                    index: Math.min(s.groups.length - 1, s.index + 1),
                  },
                );
                if (session.index === session.groups.length - 1) toast.success("All groups reviewed");
              }}
            />
          </>
        )
      )}
    </div>
  );
}

function GroupReview({
  group, index, total, freed, decision, onNav, onDecide,
}: {
  group: DuplicateGroup; index: number; total: number; freed: number; decision?: string | undefined;
  onNav: (d: number) => void;
  onDecide: (kind: "removed" | "kept" | "skipped", removed: Photo[]) => void;
}) {
  const best = pickBest(group.photos);
  const [keep, setKeep] = useState(best);

  const confirm = useCallback(() => onDecide("removed", group.photos.filter((_, i) => i !== keep)), [group, keep, onDecide]);

  useEffect(() => {
    if (decision) return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea")) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && n <= group.photos.length) setKeep(n - 1);
      else if (e.key === "Enter") { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); confirm(); }
      else if (e.key.toLowerCase() === "s") onDecide("skipped", []);
      else if (e.key === "ArrowRight") onNav(1);
      else if (e.key === "ArrowLeft") onNav(-1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [group, confirm, onDecide, onNav, decision]);

  return (
    <div className="surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="font-medium">Group {index + 1} of {total}</p>
          <Badge variant="outline">{group.kind === "exact" ? "Exact copy" : group.kind === "copy" ? `Same photo · ${group.similarity}%` : `Burst · ${group.similarity}% similar · ${formatSpan(group.spanSeconds)} apart`}</Badge>
          {decision && <Badge variant="secondary">Already {decision}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">Space freed so far: <span className="font-medium text-foreground">{formatBytes(freed)}</span></p>
      </div>
      <Progress value={((index + 1) / total) * 100} className="mb-5 h-1.5" />

      <div className={cn("grid gap-4", group.photos.length === 2 ? "md:grid-cols-2" : "md:grid-cols-3")}>
        {group.photos.map((p, i) => {
          const selected = keep === i;
          return (
            <button
              key={p.id}
              onClick={() => setKeep(i)}
              className={cn(
                "group overflow-hidden rounded-xl border-2 bg-card text-left transition-all",
                selected ? "border-primary shadow-lift" : "border-transparent opacity-60 hover:opacity-90",
              )}
            >
              <div className="relative">
                <img src={p.url} alt={p.filename} className="aspect-[4/3] w-full object-cover" />
                <span className="absolute left-2 top-2 grid size-7 place-items-center rounded-md bg-card/90 text-sm font-medium">{i + 1}</span>
                <div className="absolute right-2 top-2 flex gap-1.5">
                  {i === best && <Badge>Best</Badge>}
                  {selected ? <Badge variant="secondary"><Check className="size-3" /> Keep</Badge> : <Badge variant="destructive">Remove</Badge>}
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 p-3 text-xs">
                <dt className="col-span-2 truncate text-sm font-medium">{p.filename}</dt>
                <dd className="text-muted-foreground">{p.width}×{p.height}</dd>
                <dd className="text-right text-muted-foreground">{formatBytes(p.sizeBytes)}</dd>
                <dd className="col-span-2 text-muted-foreground">{p.takenKnown === false ? "Unknown" : `${formatDateTime(p.takenAt)}${p.takenEstimated ? " (estimated)" : ""}`}</dd>
                <dd className="truncate text-right text-muted-foreground" title={p.folder}>{p.folder}</dd>
              </dl>
            </button>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => onNav(-1)} disabled={index === 0}><ArrowLeft /> Back</Button>
        <Button variant="ghost" onClick={() => onNav(1)} disabled={index === total - 1}>Next <ArrowRight /></Button>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => onDecide("skipped", [])}>Skip</Button>
          <Button variant="outline" onClick={() => onDecide("kept", [])}>Keep all</Button>
          <Button onClick={confirm} disabled={!!decision}><Check /> Keep selected, remove others</Button>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Shortcuts: 1–9 pick · Enter confirm · S skip · ← → navigate</p>
    </div>
  );
}

const FILTERS = [
  { id: "screenshot", label: "Screenshots" },
  { id: "document", label: "Documents & receipts" },
  { id: "forwarded", label: "Forwards & downloads" },
  { id: "large-video", label: "Large videos" },
] as const;

const CONF_VARIANT = { high: "default", medium: "secondary", low: "outline" } as const;

function OtherCleanup() {
  const { bin, addToBin } = useVault();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("screenshot");
  const [selected, setSelected] = useState<string[]>([]);
  const [scanPct, setScanPct] = useState<number | null>(null);
  const [scanned, setScanned] = useState(0);
  const q = useQuery({
    queryKey: ["other-cleanup", filter, bin.length, scanned],
    queryFn: async (): Promise<ClutterItem[]> =>
      filter === "large-video"
        ? (await api.listPhotos({ tag: "large-video" })).map((photo) => ({ photo, confidence: "high" as const, reasons: ["video over 500 MB"] }))
        : api.listClutter(filter),
  });
  const items = q.data ?? [];

  const scan = async () => {
    setScanPct(0);
    try {
      const r = await api.scanClutter("archive", setScanPct);
      toast.success(`Found ${r.screenshot} screenshots, ${r.document} documents, ${r.forwarded} forwards`);
      setScanned((n) => n + 1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScanPct(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button key={f.id} size="sm" variant={filter === f.id ? "default" : "outline"} className="rounded-full" onClick={() => { setFilter(f.id); setSelected([]); }}>
            {f.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={scan} disabled={scanPct !== null}>
          {scanPct !== null ? <Loader2 className="animate-spin" /> : <Sparkles />} Scan archive
        </Button>
        {selected.length > 0 && (
          <ConfirmDialog
            trigger={<Button size="sm" variant="destructive" className="ml-auto"><Trash2 /> Move {selected.length} to Review Bin</Button>}
            title={`Move ${selected.length} items to the Review Bin?`}
            description="They won't be deleted. You can restore them from the Review Bin any time."
            confirmLabel="Move to bin"
            onConfirm={async () => { await addToBin(items.filter((i) => selected.includes(i.photo.id)).map((i) => i.photo), FILTERS.find((f) => f.id === filter)!.label); setSelected([]); }}
          />
        )}
      </div>
      {scanPct !== null && <Progress value={scanPct} />}
      <p className="text-xs text-muted-foreground">These are suggestions based on file names, camera info, screen shape and how white the image is. Check each one before moving it to the bin.</p>
      {items.length === 0 ? (
        <EmptyState icon={Check} title="Nothing here" text={q.isLoading ? "Looking…" : filter === "large-video" ? "No videos over 500 MB." : "Nothing found yet. Press “Scan archive” to look."} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {items.map(({ photo: p, confidence, reasons }) => {
            const on = selected.includes(p.id);
            return (
              <button key={p.id} onClick={() => setSelected((s) => (on ? s.filter((x) => x !== p.id) : [...s, p.id]))}
                className={cn("overflow-hidden rounded-lg border-2 text-left", on ? "border-destructive" : "border-transparent")}>
                <img src={p.thumb} alt={p.filename} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                <p className="truncate px-2 pt-1 text-xs">{p.filename}</p>
                <p className="px-2 text-[11px] text-muted-foreground">{formatBytes(p.sizeBytes)}</p>
                <div className="px-2 pb-2 pt-1">
                  <Badge variant={CONF_VARIANT[confidence]} className="mb-1 text-[10px]">{confidence} confidence</Badge>
                  <p className="text-[11px] leading-snug text-muted-foreground">{reasons.join(" · ")}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReviewBin() {
  const { bin, restore, emptyBin } = useVault();
  const total = bin.reduce((a, b) => a + b.photo.sizeBytes, 0);
  if (bin.length === 0) return <EmptyState icon={Trash2} title="Review Bin is empty" text="Files you remove during clean-up land here first, so nothing is lost by accident." />;
  return (
    <div className="space-y-4">
      <div className="surface flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm">{bin.length} items · <span className="font-medium">{formatBytes(total)}</span></p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => restore(bin.map((b) => b.photo.id))}><RotateCcw /> Restore all</Button>
          <ConfirmDialog
            trigger={<Button variant="destructive"><Trash2 /> Empty bin</Button>}
            title="Permanently delete these files?"
            description={`${bin.length} files (${formatBytes(total)}) will be deleted from the drive. This cannot be undone.`}
            confirmLabel="Delete permanently"
            destructive
            onConfirm={() => { emptyBin(); toast.success("Review Bin emptied"); }}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        {bin.map(({ photo, reason }) => (
          <div key={photo.id} className="surface overflow-hidden">
            <img src={photo.thumb} alt={photo.filename} className="aspect-[4/3] w-full object-cover" />
            <div className="p-2">
              <p className="truncate text-xs font-medium">{photo.filename}</p>
              <p className="text-[11px] text-muted-foreground">{reason} · {formatBytes(photo.sizeBytes)}</p>
              <Button size="sm" variant="ghost" className="mt-1 h-7 w-full" onClick={() => restore([photo.id])}><Undo2 /> Restore</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
