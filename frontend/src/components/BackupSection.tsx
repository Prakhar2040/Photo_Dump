import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, HardDrive, Laptop, Loader2, MapPin, RefreshCw, Settings2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api, formatBytes, formatDate, type BackupTarget, type SyncPlan } from "@/services/api";
import { useVault } from "@/lib/vault-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const ICON = { master: Laptop, backup: HardDrive, offsite: MapPin };

export function BackupSection() {
  const qc = useQueryClient();
  const { settings, saveSettings } = useVault();
  const targets = useQuery({ queryKey: ["targets"], queryFn: api.getTargets });
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [verify, setVerify] = useState<number | null>(null);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [verifyOk, setVerifyOk] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [paths, setPaths] = useState<{ archive: string; backup: string; offsite: string } | null>(null);
  const form = paths ?? { archive: settings?.archivePath ?? "", backup: settings?.backupPath ?? "", offsite: settings?.offsitePath ?? "" };
  const savePaths = async () => {
    if (!settings) return;
    await saveSettings({ ...settings, archivePath: form.archive.trim() || settings.archivePath, backupPath: form.backup.trim(), offsitePath: form.offsite.trim() });
    await qc.invalidateQueries();
    setPaths(null);
    setChosen(null);
    await qc.invalidateQueries({ queryKey: ["targets"] });
  };

  const destinations = (targets.data ?? []).filter((t) => t.role !== "master");
  const [chosen, setChosen] = useState<string | null>(null);
  const targetId = chosen ?? destinations[0]?.id ?? null;
  const noTarget = !targets.isLoading && destinations.length === 0;
  const pending = destinations.find((t) => t.id === targetId)?.pending;

  const dryRun = async () => {
    if (!targetId) return;
    setPlanning(true);
    try {
      setPlan(await api.planSync(targetId));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPlanning(false);
    }
  };
  const confirmSync = async () => {
    if (!targetId) return;
    setSyncing(true);
    try {
      const r = await api.runSync(targetId);
      toast.success(`Backup complete · ${r.copied} files copied`);
      setPlan(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncing(false);
      qc.invalidateQueries({ queryKey: ["targets"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    }
  };
  const runVerify = async () => {
    if (!targetId) return;
    setVerifyResult(null);
    setVerify(0);
    try {
      const r = await api.verify(targetId, (pct) => setVerify(pct));
      setVerifyResult(`${r.checked.toLocaleString()} files checked · ${r.mismatched.length} mismatches · ${r.missing.length} missing`);
      setVerifyOk(r.ok);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setVerify(null);
    }
  };

  return (
    <section className="space-y-4" aria-label="Backup">
      <div className="surface space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <ShieldCheck className="size-5 text-primary" />
          <div className="mr-auto">
            <p className="font-medium">Back up your archive</p>
            <p className="text-sm text-muted-foreground">Copy everything to your backup drive and offsite folder. Nothing is copied until you confirm.</p>
          </div>
          {destinations.length > 1 && (
            <Select value={targetId ?? undefined} onValueChange={setChosen}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>{destinations.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
          <Button variant="outline" onClick={runVerify} disabled={verify !== null || !targetId}><ShieldCheck /> Verify integrity</Button>
          <Button onClick={dryRun} disabled={planning || !targetId}>{planning ? <Loader2 className="animate-spin" /> : <RefreshCw />} {pending ? `Back up ${pending.toLocaleString()} new file${pending === 1 ? "" : "s"}` : "Back up now"}</Button>
        </div>

        {(verify !== null || verifyResult) && (
          verify !== null ? (
            <div className="space-y-2"><p className="text-sm text-muted-foreground">Checking checksums… {verify}%</p><Progress value={verify} /></div>
          ) : (
            <p className="flex items-center gap-2 text-sm">{verifyOk ? <CheckCircle2 className="size-4 text-success" /> : <AlertTriangle className="size-4 text-warning" />} {verifyOk ? "Integrity verified" : "Problems found"}: {verifyResult}</p>
          )
        )}

        {pending !== undefined && (
          <p className="flex items-center gap-2 text-sm">
            {pending === 0
              ? <><CheckCircle2 className="size-4 text-success" /> Everything is backed up.</>
              : <><AlertTriangle className="size-4 text-warning" /> {pending.toLocaleString()} file{pending === 1 ? "" : "s"} added since the last backup ({formatBytes(destinations.find((t) => t.id === targetId)?.pendingBytes ?? 0)}). Nothing is copied until you confirm.</>}
          </p>
        )}

        {noTarget && (
          <p className="text-sm">No backup location is set yet. Type a folder on your SSD or another drive above, then Save.</p>
        )}

        {settings && (
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor="archive-path">Archive folder (where your photos live)</Label>
              <Input id="archive-path" placeholder="C:\Family Archive" value={form.archive} onChange={(e) => setPaths({ ...form, archive: e.target.value })} />
              <p className="text-xs text-muted-foreground">Changing this only points the app at another folder; it does not move your photos. Copy the folder to the new drive first.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="backup-path">Backup folder</Label>
              <Input id="backup-path" placeholder="E:\Family Archive Backup" value={form.backup} onChange={(e) => setPaths({ ...form, backup: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="offsite-path">Second copy (optional)</Label>
              <Input id="offsite-path" placeholder="F:\Family Archive Offsite" value={form.offsite} onChange={(e) => setPaths({ ...form, offsite: e.target.value })} />
            </div>
            <Button variant="outline" onClick={() => void savePaths()} disabled={!paths}>Save</Button>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          {targets.isLoading
            ? Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48 rounded-xl" />)
            : targets.data?.map((t) => <TargetCard key={t.id} t={t} />)}
        </div>

        {settings && (
          <div>
            <Button variant="ghost" size="sm" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
              <Settings2 /> Advanced settings <ChevronDown className={cn("transition-transform", advanced && "rotate-180")} />
            </Button>
            {advanced && (
              <div className="mt-3 grid gap-4 border-t pt-4 sm:grid-cols-2">
                <Reminder label="Remind me to import new photos every" value={settings.importReminderMonths} onChange={(v) => saveSettings({ ...settings, importReminderMonths: v })} />
                <Reminder label="Remind me to refresh the offsite copy every" value={settings.offsiteReminderMonths} onChange={(v) => saveSettings({ ...settings, offsiteReminderMonths: v })} />
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={!!plan} onOpenChange={(o) => !o && setPlan(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">Backup preview</DialogTitle>
            <DialogDescription>This is what will change on the backup. Nothing has been copied yet.</DialogDescription>
          </DialogHeader>
          {plan && (
            <div className="space-y-3 text-sm">
              {([["Add", plan.add, plan.counts.add, "text-success"], ["Update", plan.update, plan.counts.update, "text-warning"], ["Remove", plan.remove, plan.counts.remove, "text-destructive"]] as const)
                .filter(([k, , count]) => k !== "Remove" || count > 0) // "Remove" only exists for mirror-mode targets
                .map(([k, list, count, c]) => (
                  <div key={k}>
                    <p className={`font-medium ${c}`}>{k} · {count.toLocaleString()}{count > list.length ? ` (showing ${list.length})` : ""}</p>
                    <ul className="mt-1 max-h-28 overflow-y-auto rounded-md bg-muted p-2 font-mono text-xs">
                      {list.length ? list.map((f) => <li key={f} className="truncate">{f}</li>) : <li className="text-muted-foreground">Nothing</li>}
                    </ul>
                  </div>
                ))}
              {plan.remove.length > 0 && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground"><AlertTriangle className="size-3.5 text-warning" /> Removed files are moved to a .sync-trash folder on the backup, not deleted.</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlan(null)}>Cancel</Button>
            <Button onClick={confirmSync} disabled={syncing}>{syncing && <Loader2 className="animate-spin" />} Confirm backup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TargetCard({ t }: { t: BackupTarget }) {
  const Icon = ICON[t.role];
  return (
    <div className="rounded-xl border p-4">
      <div className="flex items-start justify-between">
        <div className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground"><Icon className="size-5" /></div>
        <Badge variant={t.status === "synced" ? "secondary" : "outline"} className={t.status === "synced" ? "text-success" : "text-warning"}>
          {t.status === "synced" ? "In sync" : t.status === "behind" ? "Behind" : "Offline"}
        </Badge>
      </div>
      <p className="mt-3 text-xs uppercase tracking-wider text-muted-foreground">{t.role}</p>
      <h3 className="text-lg">{t.name}</h3>
      <p className="truncate text-xs text-muted-foreground">{t.path}</p>
      <div className="mt-3 grid grid-cols-2 text-sm">
        <div><p className="text-xs text-muted-foreground">Last synced</p>{formatDate(t.lastSynced)}</div>
        <div><p className="text-xs text-muted-foreground">Files</p>{t.fileCount.toLocaleString()}</div>
        {t.pending ? <div className="col-span-2 mt-2 text-warning">{t.pending.toLocaleString()} waiting to be backed up</div> : null}
      </div>
    </div>
  );
}

function Reminder({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{[1, 3, 6, 12].map((m) => <SelectItem key={m} value={String(m)}>{m} month{m > 1 ? "s" : ""}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}
