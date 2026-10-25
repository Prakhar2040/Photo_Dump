import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, type BinEntry, type DuplicateGroup, type Photo, type Settings } from "@/services/api";

export type BinItem = BinEntry;

interface CleanupSession {
  groups: DuplicateGroup[];
  index: number;
  freed: number;
  decided: Record<string, "removed" | "kept" | "skipped">;
}

interface VaultState {
  settings: Settings | null;
  saveSettings: (s: Settings) => Promise<void>;
  setTheme: (t: Settings["theme"]) => void;
  bin: BinItem[];
  refreshBin: () => Promise<void>;
  addToBin: (items: Photo[], reason: string) => Promise<void>;
  restore: (ids: string[]) => Promise<void>;
  emptyBin: () => Promise<void>;
  session: CleanupSession | null;
  setSession: (s: CleanupSession | null | ((prev: CleanupSession | null) => CleanupSession | null)) => void;
}

const Ctx = createContext<VaultState | null>(null);

function applyTheme(theme: Settings["theme"]) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bin, setBin] = useState<BinItem[]>([]);
  const [session, setSession] = useState<CleanupSession | null>(null);

  const refreshBin = useCallback(async () => {
    try {
      setBin(await api.getBin());
    } catch {
      /* backend offline: keep the last known bin */
    }
  }, []);

  useEffect(() => {
    // Dark unless the user chose otherwise; applied before the settings arrive so the page does not flash light.
    try { applyTheme(JSON.parse(localStorage.getItem("fv-theme-pref") ?? "\"dark\"") as Settings["theme"]); } catch { applyTheme("dark"); }
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        applyTheme(s.theme);
      })
      .catch((e: Error) => toast.error(e.message));
    refreshBin();
  }, [refreshBin]);

  const saveSettings = useCallback(async (s: Settings) => {
    try {
      const saved = await api.saveSettings(s);
      setSettings(saved);
      applyTheme(saved.theme);
      toast.success("Settings saved");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  const setTheme = useCallback((t: Settings["theme"]) => {
    setSettings((s) => (s ? { ...s, theme: t } : s));
    try {
      localStorage.setItem("fv-theme-pref", JSON.stringify(t));
    } catch {
      /* storage unavailable */
    }
    applyTheme(t);
  }, []);

  const addToBin = useCallback(
    async (items: Photo[], reason: string) => {
      try {
        await api.moveToBin(items.map((p) => p.id), reason);
      } catch (e) {
        toast.error((e as Error).message);
      }
      await refreshBin();
    },
    [refreshBin],
  );
  const restore = useCallback(
    async (ids: string[]) => {
      try {
        await api.restoreFromBin(ids);
      } catch (e) {
        toast.error((e as Error).message);
      }
      await refreshBin();
    },
    [refreshBin],
  );
  const emptyBin = useCallback(async () => {
    try {
      await api.emptyBin();
    } catch (e) {
      toast.error((e as Error).message);
    }
    await refreshBin();
  }, [refreshBin]);

  return (
    <Ctx.Provider value={{ settings, saveSettings, setTheme, bin, refreshBin, addToBin, restore, emptyBin, session, setSession }}>
      {children}
    </Ctx.Provider>
  );
}

export function useVault() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useVault outside provider");
  return v;
}
