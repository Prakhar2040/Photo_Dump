import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { api, formatBytes, formatDate } from "@/services/api";
import { PageHeader } from "@/components/AppShell";
import { BackupSection } from "@/components/BackupSection";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/import")({
  head: () => ({
    meta: [
      { title: "Import & Backup · Family Vault" },
      { name: "description", content: "Copy photos from a phone export into the family archive." },
      { property: "og:title", content: "Import & Backup · Family Vault" },
      { property: "og:description", content: "Copy photos from a phone export into the family archive." },
    ],
  }),
  component: ImportPage,
});

function ImportPage() {
  return (
    <>
      <PageHeader title="Import & Backup" subtitle="Bring new photos in, then keep copies safe." />
      <div className="space-y-6 px-6 py-6 md:px-10">
        <PhoneUploadCard />
        <BackupSection />
      </div>
    </>
  );
}

function PhoneUploadCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["phone-upload"], queryFn: api.getPhoneUpload, refetchInterval: (query) => (query.state.data?.running ? 3000 : false) });
  const [busy, setBusy] = useState(false);
  const info = q.data;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["phone-upload"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const on = !!info?.running;
  return (
    <div className="surface p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Smartphone className="size-5 text-primary" />
        <div className="mr-auto">
          <p className="font-medium">Import from an iPhone over Wi-Fi</p>
          <p className="text-sm text-muted-foreground">Scan the code with the phone, pick photos, and they arrive here. Already-sent photos are skipped.</p>
        </div>
        {on && <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(api.stopPhoneUpload)}>Turn off</Button>}
      </div>

      <div className="mt-5 grid gap-6 md:grid-cols-[auto_1fr] md:items-center">
        {info?.qr ? (
          <button
            type="button"
            disabled={on || busy}
            onClick={() => void act(api.startPhoneUpload)}
            aria-label={on ? "QR code to open the upload page on your phone" : "Turn on phone upload"}
            className={cn("group relative size-[220px] shrink-0 overflow-hidden rounded-lg border bg-white p-2", !on && "cursor-pointer")}
          >
            <img src={info.qr} alt="" className={cn("size-full transition", !on && "opacity-20 blur-[1.5px] grayscale")} />
            {!on && (
              <span className="absolute inset-0 grid place-items-center bg-background/40 p-4 text-center text-sm font-medium text-foreground transition group-hover:bg-background/20">
                {busy ? <Loader2 className="size-5 animate-spin" /> : "Click to turn on"}
              </span>
            )}
          </button>
        ) : (
          <div className="grid size-[220px] place-items-center rounded-lg border p-4 text-center text-sm text-muted-foreground">
            {q.isLoading ? <Loader2 className="animate-spin" /> : "No Wi-Fi network found on this laptop."}
          </div>
        )}
        <div className="space-y-3 text-sm">
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Put the phone on the <strong className="text-foreground">same Wi-Fi</strong> as this laptop.</li>
            <li>Turn the code on (click it), then point the phone's Camera at it and tap the link.</li>
            <li>Tap <strong className="text-foreground">Choose photos &amp; videos</strong>, select, and upload. Keep the screen on.</li>
          </ol>
          {info?.last?.total ? (
            <p className="text-muted-foreground">Last upload: {info.last.lastAt ? formatDate(info.last.lastAt) : "—"} · {info.last.lastCount} files</p>
          ) : null}
          {on && info?.urls?.[0] &&<p className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">{info.urls[0]}</p>}
          {on && (
            <p>
              <span className="font-medium">{info?.received.files ?? 0}</span> received this session
              {(info?.received.files ?? 0) > 0 && <span className="text-muted-foreground"> ({formatBytes(info?.received.bytes ?? 0)}). digiKam opens when a batch finishes (if it is on this computer).</span>}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            It stays off until you turn it on, and only this page can be reached; nothing else in the app is shared. The first time, Windows may ask to allow Node.js on the network: choose <em>Private networks</em>.{" "}
            <button className="text-primary hover:underline" disabled={busy} onClick={() => void act(api.resetPhoneUploadLink)}>Make a new link</button>
          </p>
        </div>
      </div>
    </div>
  );
}
