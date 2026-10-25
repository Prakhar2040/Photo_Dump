import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Copy, HardDrive, Image, Video, CalendarClock, ShieldCheck } from "lucide-react";
import { api, formatBytes, formatDate } from "@/services/api";
import { PageHeader, EmptyState } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard · Family Vault" },
      { name: "description", content: "Overview of your family photo archive, imports and backups." },
      { property: "og:title", content: "Dashboard · Family Vault" },
      { property: "og:description", content: "Overview of your family photo archive, imports and backups." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.getStats });
  const imports = useQuery({ queryKey: ["imports"], queryFn: api.listImports });
  const dups = useQuery({ queryKey: ["dups-count"], queryFn: api.getDuplicateSummary });

  const s = stats.data;
  const overdue = s?.backupOverdue ?? true;

  return (
    <>
      <PageHeader title="Good afternoon" subtitle="Here's how the family archive is doing." />
      <div className="space-y-6 px-6 py-6 md:px-10">
        {stats.isError && <EmptyState icon={AlertTriangle} title="Can't reach the backend" text={(stats.error as Error).message} />}
        {s ? (
          <div className={`surface flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${overdue ? "border-warning" : "border-success"}`}>
            <div className="flex items-center gap-3">
              {overdue ? <AlertTriangle className="size-5 text-warning" /> : <CheckCircle2 className="size-5 text-success" />}
              <div>
                <p className="font-medium">{overdue ? "Backup overdue" : "Backup up to date"}</p>
                <p className="text-sm text-muted-foreground">Last backup {formatDate(s.lastBackup)}</p>
              </div>
            </div>
            <Button asChild variant={overdue ? "default" : "outline"}>
              <Link to="/import">Go to Backup</Link>
            </Button>
          </div>
        ) : (
          <Skeleton className="h-[74px] rounded-xl" />
        )}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Stat icon={Image} label="Photos" value={s?.totalPhotos.toLocaleString()} />
          <Stat icon={Video} label="Videos" value={s?.totalVideos.toLocaleString()} />
          <div className="surface p-5">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><HardDrive className="size-4" /> Archive size</div>
            {s ? (
              <>
                <p className="mt-2 font-display text-3xl">{formatBytes(s.archiveBytes)}</p>
                <Progress className="mt-3" value={(s.archiveBytes / s.driveCapacityBytes) * 100} />
                <p className="mt-2 text-xs text-muted-foreground">of {formatBytes(s.driveCapacityBytes)} drive · {Math.round((s.archiveBytes / s.driveCapacityBytes) * 100)}% used</p>
              </>
            ) : <Skeleton className="mt-2 h-16" />}
          </div>
          <Stat icon={CalendarClock} label="Last import" value={s && formatDate(s.lastImport)} />
          <Stat icon={ShieldCheck} label="Last backup" value={s && formatDate(s.lastBackup)} />
          <Link to="/cleanup" className="surface block p-5 transition-shadow hover:shadow-lift">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Copy className="size-4" /> Duplicates waiting</div>
            {dups.data ? <p className="mt-2 font-display text-3xl">{dups.data.groups} groups</p> : <Skeleton className="mt-2 h-9 w-24" />}
            <p className="mt-1 text-xs text-primary">Review now →</p>
          </Link>
        </div>

        <section>
          <h2 className="mb-3 text-xl">Recent imports</h2>
          {imports.isLoading ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : imports.data?.length ? (
            <div className="surface divide-y divide-border">
              {imports.data.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5">
                  <div>
                    <p className="font-medium">Imports/{i.quarter}</p>
                    <p className="text-xs text-muted-foreground">{i.source}</p>
                  </div>
                  <div className="text-right text-sm">
                    <p>{i.photos} photos · {i.videos} videos</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(i.sizeBytes)} · {formatDate(i.importedAt)}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={CalendarClock} title="No imports yet" text="Bring in photos from a phone export to get started." action={<Button asChild><Link to="/import">Start an import</Link></Button>} />
          )}
        </section>
      </div>
    </>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Image; label: string; value?: string | undefined }) {
  return (
    <div className="surface p-5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="size-4" /> {label}</div>
      {value ? <p className="mt-2 font-display text-3xl">{value}</p> : <Skeleton className="mt-2 h-9 w-28" />}
    </div>
  );
}
