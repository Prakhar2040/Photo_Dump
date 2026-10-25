import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Check, FolderInput, FolderPlus, Images, Pencil, Search, Trash2, UserRound, Video, X } from "lucide-react";
import { toast } from "sonner";
import { api, API_URL, formatBytes, formatDate, type Photo } from "@/services/api";
import { PageHeader, EmptyState } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useVault } from "@/lib/vault-store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Library · Family Vault" },
      { name: "description", content: "Browse the family archive by year and event." },
      { property: "og:title", content: "Library · Family Vault" },
      { property: "og:description", content: "Browse the family archive by year and event." },
    ],
  }),
  validateSearch: (s: Record<string, unknown>): { who?: string } => (typeof s["who"] === "string" && s["who"] ? { who: s["who"] } : {}),
  component: LibraryPage,
});

function LibraryPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["photos"], queryFn: () => api.listPhotos(), refetchOnWindowFocus: true });
  const peopleQ = useQuery({ queryKey: ["people"], queryFn: api.listPeople, refetchOnWindowFocus: true });
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "photo" | "video">("all");
  const search0 = Route.useSearch();
  const [who, setWho] = useState(search0.who ?? "all");
  const unnamedQ = useQuery({ queryKey: ["unnamed"], queryFn: api.listUnnamed, refetchOnWindowFocus: true });
  const [group, setGroup] = useState<string | null>(null);
  const groupIds = useMemo(() => new Set(unnamedQ.data?.find((g) => g.id === group)?.photoIds ?? []), [unnamedQ.data, group]);
  const [newName, setNewName] = useState("");
  const [coverFor, setCoverFor] = useState<string | null>(null);
  const coverFacesQ = useQuery({ queryKey: ["person-faces", coverFor], queryFn: () => api.listPersonFaces(coverFor!), enabled: !!coverFor });
  const dismiss = async (id: string) => {
    try {
      const r = await api.dismissGroup(id);
      if (group === id) setGroup(null);
      await qc.invalidateQueries({ queryKey: ["unnamed"] });
      toast.success("Hidden from the list", {
        action: { label: "Undo", onClick: () => api.undoDismiss(r.dismissId).then(() => qc.invalidateQueries({ queryKey: ["unnamed"] }), (e: Error) => toast.error(e.message)) },
        duration: 10000,
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const chooseCover = async (f: { rel: string; rect: { x: number; y: number; w: number; h: number } }) => {
    if (!coverFor) return;
    try {
      await api.setCover(coverFor, f.rel, f.rect);
      setCoverFor(null);
      await qc.invalidateQueries({ queryKey: ["people"] });
      toast.success("Cover picture changed");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const [saveToPhotos, setSaveToPhotos] = useState(true);
  const [naming, setNaming] = useState(false);
  const refreshAll = () => Promise.all(["photos", "people", "unnamed"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const nameIt = async () => {
    if (!group || !newName.trim()) return;
    setNaming(true);
    try {
      const r = await api.nameGroup(group, newName.trim(), saveToPhotos);
      setGroup(null);
      setNewName("");
      await refreshAll();
      toast.success(`${r.name} named in ${r.photos} photos${saveToPhotos ? ` (saved to ${r.written} in digiKam)` : ""}`, {
        action: { label: "Undo", onClick: () => api.undoNaming(r.batchId).then(refreshAll, (e: Error) => toast.error(e.message)) },
        duration: 15000,
      });
      if (r.failed.length) toast.error(`${r.failed.length} photos couldn't be saved to digiKam; the names still work in this app.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setNaming(false);
    }
  };
  const { addToBin } = useVault();
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<Photo | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  const photos = useMemo(() => q.data ?? [], [q.data]);
  const events = [...new Set(photos.map((p) => p.event).filter((e) => /^d{4}-d{2} /.test(e)))].sort().reverse();

  const filtered = photos.filter(
    (p) =>
      (who === "all" || p.people.includes(who) || p.autoPeople.some((a) => a.name === who)) &&
      (!group || groupIds.has(p.id)) &&
      (kind === "all" || p.kind === kind) &&
      (!search || `${p.filename} ${p.event}`.toLowerCase().includes(search.toLowerCase())),
  );
  const grouped = useMemo(() => {
    const m = new Map<number, Map<string, Photo[]>>();
    // Year → month, by the date the photo was taken. Photos with no date go in their own group at the end (year 0).
    filtered.forEach((p) => {
      const d = new Date(p.takenAt);
      const known = p.takenKnown !== false;
      const y = known ? d.getFullYear() : 0;
      const month = known ? `${y}-${String(d.getMonth() + 1).padStart(2, "0")}` : "unknown";
      if (!m.has(y)) m.set(y, new Map());
      const ev = m.get(y)!;
      ev.set(month, [...(ev.get(month) ?? []), p]);
    });
    return [...m.entries()].sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : b[0] - a[0]));
  }, [filtered]);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <>
      <PageHeader
        title="Library"
        subtitle="Every memory, organised by year and event."
        actions={selected.length > 0 && (
          <>
            <Button variant="ghost" onClick={() => setSelected([])}><X /> Clear {selected.length}</Button>
            <Button onClick={() => setMoveOpen(true)}><FolderInput /> Move to folder</Button>
            <ConfirmDialog
              trigger={<Button variant="destructive"><Trash2 /> Delete {selected.length}</Button>}
              title={`Move ${selected.length} to the Review Bin?`}
              description="They are not deleted yet. You can restore them from Clean Up > Review Bin, and nothing is removed for good until you empty the bin."
              confirmLabel="Move to bin"
              onConfirm={async () => {
                const items = photos.filter((p) => selected.includes(p.id));
                await addToBin(items, "Removed from Library");
                await qc.invalidateQueries({ queryKey: ["photos"] });
                await qc.invalidateQueries({ queryKey: ["people"] });
                setSelected([]);
                toast.success(`${items.length} moved to the Review Bin (Clean Up > Review Bin)`);
              }}
            />
          </>
        )}
      />
      <div className="space-y-8 px-6 py-6 md:px-10">
        {(peopleQ.data?.length ?? 0) > 0 && (
          <section aria-label="People">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">People</h2>
              {who !== "all" && <button onClick={() => setWho("all")} className="text-xs text-primary hover:underline">Show everyone</button>}
            </div>
            <div className="flex gap-5 overflow-x-auto pb-2">
              {peopleQ.data!.map((p) => {
                const on = who === p.name;
                return (
                  <div key={p.name} className="group relative flex w-[76px] shrink-0 flex-col items-center text-center">
                    <button onClick={() => setWho(on ? "all" : p.name)} aria-pressed={on} className="flex w-full flex-col items-center">
                      <span className={cn("relative block size-[68px] overflow-hidden rounded-full bg-muted ring-2 ring-offset-2 ring-offset-background transition-all", on ? "ring-primary" : "ring-transparent group-hover:ring-border")}>
                        {p.hasFace ? (
                          <img src={`${API_URL}/people/${encodeURIComponent(p.name)}/face?size=160&v=${p.coverV ?? ""}`} alt={p.name} className="size-full object-cover" />
                        ) : (
                          <span className="grid size-full place-items-center text-muted-foreground"><UserRound className="size-6" /></span>
                        )}
                      </span>
                      <span className={cn("mt-1.5 w-full truncate text-xs", on ? "font-medium text-foreground" : "text-muted-foreground")}>{p.name}</span>
                      <span className="text-[10px] text-muted-foreground/70" title={p.auto ? `${p.count - p.auto} confirmed, ${p.auto} matched automatically` : undefined}>{p.count}</span>
                    </button>
                    <button aria-label={`Change ${p.name}'s cover picture`} title="Change cover picture" onClick={() => setCoverFor(p.name)} className="absolute right-0 top-0 grid size-6 place-items-center rounded-full border bg-card text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100">
                      <Pencil className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {(unnamedQ.data?.length ?? 0) > 0 && (
          <section aria-label="Who is this?">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">Who is this? <span className="font-normal">· faces not named yet</span></h2>
              {group ? (
                <button onClick={() => setGroup(null)} className="text-xs text-muted-foreground hover:underline">Show everyone</button>
              ) : (
                <span className="text-xs text-muted-foreground/70">Pick a face, type a name, and every photo in the group is named.</span>
              )}
            </div>
            {group && (
              <form onSubmit={(e) => { e.preventDefault(); void nameIt(); }} className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
                <Input list="known-names" autoFocus className="w-56" placeholder="Who is this?" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <datalist id="known-names">{peopleQ.data?.map((p) => <option key={p.name} value={p.name} />)}</datalist>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={saveToPhotos} onChange={(e) => setSaveToPhotos(e.target.checked)} />
                  Also save to the photos (digiKam)
                </label>
                <Button type="submit" disabled={naming || !newName.trim()}>{naming ? "Naming…" : `Name ${groupIds.size} photos`}</Button>
              </form>
            )}
            <div className="flex gap-5 overflow-x-auto pb-2">
              {unnamedQ.data!.map((g) => {
                const on = group === g.id;
                return (
                  <div key={g.id} className="group relative flex w-[76px] shrink-0 flex-col items-center text-center">
                    <button onClick={() => setGroup(on ? null : g.id)} aria-pressed={on} className="flex w-full flex-col items-center">
                      <span className={cn("block size-[68px] overflow-hidden rounded-full bg-muted ring-2 ring-offset-2 ring-offset-background transition-all", on ? "ring-primary" : "ring-transparent group-hover:ring-border")}>
                        <img src={`${API_URL}/people/unnamed/${g.id}/face?size=160`} alt="Unnamed face" className="size-full object-cover" />
                      </span>
                      <span className="mt-1.5 text-xs text-muted-foreground">Unknown</span>
                      <span className="text-[10px] text-muted-foreground/70">{g.count} photos</span>
                    </button>
                    <button aria-label="Hide this person" title="Not someone I care about. Hide" onClick={() => void dismiss(g.id)} className="absolute right-0 top-0 grid size-6 place-items-center rounded-full border bg-card text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100">
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div className="flex flex-wrap gap-3">
          <div className="relative min-w-[240px] flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search filenames or events" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {filtered.length > 0 && (
            <Button variant="outline" onClick={() => setSelected(selected.length === filtered.length ? [] : filtered.map((p) => p.id))}>
              {selected.length === filtered.length ? "Clear selection" : `Select all ${filtered.length.toLocaleString()}`}
            </Button>
          )}
          <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Show">
            {([["all", "All"], ["photo", "Photos"], ["video", "Videos"]] as const).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={cn("rounded px-3 py-1.5 text-sm transition-colors", kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>{label}</button>
            ))}
          </div>
        </div>

        {q.isError ? (
          <EmptyState icon={Images} title="Can't load the library" text={(q.error as Error).message} />
        ) : q.isLoading ? (
          <div className="grid grid-cols-3 gap-2 md:grid-cols-6">{Array.from({ length: 18 }).map((_, i) => <Skeleton key={i} className="aspect-square" />)}</div>
        ) : grouped.length === 0 ? (
          <EmptyState icon={Images} title="No photos match" text="Try a different search or clear the filters." />
        ) : (
          grouped.map(([y, evs]) => (
            <section key={y}>
              <h2 className="mb-4 text-4xl text-muted-foreground">{y === 0 ? "Date unknown" : y}</h2>
              <div className="space-y-6">
                {[...evs.entries()].sort().reverse().map(([ev, list]) => (
                  <div key={ev}>
                    <p className="mb-2 text-sm font-medium">
                      {ev === "unknown" ? "No date in the photo or file name" : new Date(`${ev}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}{" "}
                      <span className="text-muted-foreground">· {list.length}</span>
                      <button type="button" className="ml-3 text-xs text-primary hover:underline" onClick={() => setSelected((s) => (list.every((p) => s.includes(p.id)) ? s.filter((id) => !list.some((p) => p.id === id)) : [...new Set([...s, ...list.map((p) => p.id)])]))}>
                        {list.every((p) => selected.includes(p.id)) ? "Unselect" : "Select all"}
                      </button>
                    </p>
                    <div className="grid grid-cols-3 gap-2 md:grid-cols-6 xl:grid-cols-8">
                      {list.map((p) => {
                        const on = selected.includes(p.id);
                        return (
                          <div key={p.id} className={cn("group relative overflow-hidden rounded-lg ring-2 ring-transparent", on && "ring-primary")}>
                            <button onClick={() => (selected.length ? toggle(p.id) : setOpen(p))} className="block w-full">
                              <img src={p.thumb} alt={p.filename} loading="lazy" className="aspect-square w-full object-cover transition-transform group-hover:scale-105" />
                            </button>
                            {p.kind === "video" && <Video className="pointer-events-none absolute bottom-2 left-2 size-4 text-primary-foreground drop-shadow" />}
                            <button
                              aria-label="Select"
                              onClick={() => toggle(p.id)}
                              className={cn("absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full border border-card bg-card/70 opacity-0 group-hover:opacity-100", on && "bg-primary text-primary-foreground opacity-100")}
                            >
                              {on && <Check className="size-3.5" />}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <Dialog open={!!coverFor} onOpenChange={(o) => !o && setCoverFor(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>Cover picture for {coverFor}</DialogTitle></DialogHeader>
          {coverFacesQ.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (coverFacesQ.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No clear faces to choose from yet.</p>
          ) : (
            <div className="grid max-h-[55vh] grid-cols-4 gap-3 overflow-y-auto p-1 sm:grid-cols-6">
              {coverFacesQ.data!.map((f) => (
                <button key={`${f.rel}-${f.rect.x}-${f.rect.y}`} onClick={() => void chooseCover(f)} className="overflow-hidden rounded-full ring-2 ring-transparent hover:ring-primary focus:ring-primary">
                  <img loading="lazy" src={`${API_URL}/files/${f.id}/face?x=${f.rect.x}&y=${f.rect.y}&w=${f.rect.w}&h=${f.rect.h}&size=120`} alt="" className="aspect-square w-full object-cover" />
                </button>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => coverFor && api.clearCover(coverFor).then(async () => { setCoverFor(null); await qc.invalidateQueries({ queryKey: ["people"] }); toast.success("Back to the automatic picture"); }, (e: Error) => toast.error(e.message))}
            >
              Use automatic
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-5xl p-0 sm:max-w-5xl">
          {open && (
            <div className="grid md:grid-cols-[1fr_280px]">
              {open.kind === "video" ? (
                <video key={open.id} src={open.url} poster={open.thumb} controls autoPlay className="h-full max-h-[80vh] w-full rounded-l-lg bg-black object-contain" />
              ) : (
                <img src={open.url} alt={open.filename} className="h-full max-h-[80vh] w-full rounded-l-lg bg-muted object-contain" />
              )}
              <div className="space-y-4 p-6">
                <DialogHeader><DialogTitle className="break-all font-display">{open.filename}</DialogTitle></DialogHeader>
                <dl className="space-y-2 text-sm">
                  {[
                    ["Taken", open.takenKnown === false ? "Unknown" : `${formatDate(open.takenAt)}${open.takenEstimated ? " (estimated)" : ""}`],
                    ...(open.width ? [["Resolution", `${open.width} × ${open.height}`]] : []),
                    ["Size", formatBytes(open.sizeBytes)],
                    ["People", peopleLine(open)],
                    ["Imported by", open.person || "—"],
                    ["Event", open.event],
                    ["Folder", open.folder],
                  ].map(([k, v]) => (
                    <div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <MoveDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        folders={events}
        count={selected.length}
        onMove={async (folder) => {
          try {
            const r = await api.movePhotos(selected, `${folder.slice(0, 4)}/${folder}`);
            toast.success(`Moved ${r.moved} photos to ${folder}`);
            await qc.invalidateQueries({ queryKey: ["photos"] });
            setSelected([]);
            setMoveOpen(false);
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    </>
  );
}

function peopleLine(p: Photo) {
  const parts = [
    ...p.people,
    ...p.autoPeople.map((a) => a.score >= 1 ? a.name : `${a.name} (auto ${Math.round(a.score * 100)}%)`),
    ...p.maybePeople.map((m) => `maybe ${m.name} (${Math.round(m.score * 100)}%)`),
  ];
  return parts.length ? parts.join(", ") : "Not tagged yet";
}

function MoveDialog({ open, onOpenChange, folders, count, onMove }: {
  open: boolean; onOpenChange: (o: boolean) => void; folders: string[]; count: number; onMove: (f: string, isNew: boolean) => void | Promise<void>;
}) {
  const [pick, setPick] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const valid = /^\d{4}-\d{2} .+/.test(newName.trim());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle className="font-display">Move {count} photos</DialogTitle></DialogHeader>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {folders.map((f) => (
            <button key={f} onClick={() => { setPick(f); setNewName(""); }}
              className={cn("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted", pick === f && "bg-accent text-accent-foreground")}>
              <FolderInput className="size-4" /> {f}
            </button>
          ))}
        </div>
        <div className="space-y-1.5 border-t border-border pt-4">
          <p className="flex items-center gap-2 text-sm font-medium"><FolderPlus className="size-4" /> Or create a new event folder</p>
          <Input placeholder="2026-11 Wedding" value={newName} onChange={(e) => { setNewName(e.target.value); setPick(null); }} />
          {newName && !valid && <p className="text-xs text-destructive">Use the pattern “YYYY-MM Event”.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!pick && !valid} onClick={() => onMove(pick ?? newName.trim(), !pick)}>Move here</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
