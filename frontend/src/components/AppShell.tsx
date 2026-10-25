import { Link, useRouterState } from "@tanstack/react-router";
import { Archive, HardDriveDownload, LayoutDashboard, Moon, PanelLeftClose, PanelLeftOpen, Sparkles, Sun, Images } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault-store";

const NAV = [
  { to: "/", label: "Library", icon: Images },
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/cleanup", label: "Clean Up", icon: Sparkles },
  { to: "/import", label: "Import & Backup", icon: HardDriveDownload },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const active = (to: string) => (to === "/" ? path === "/" : path.startsWith(to));

  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-all md:flex",
          collapsed ? "w-[72px]" : "w-60",
        )}
      >
        <div className="flex h-16 items-center gap-2 px-4">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary font-display text-lg text-primary-foreground">F</div>
          {!collapsed && <span className="font-display text-lg">Family Vault</span>}
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              title={n.label}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent",
                active(n.to) && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                collapsed && "justify-center px-0",
              )}
            >
              <n.icon className={cn("size-[18px] shrink-0", active(n.to) && "text-primary")} />
              {!collapsed && n.label}
            </Link>
          ))}
        </nav>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="m-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-sidebar-accent"
          aria-label="Toggle sidebar"
        >
          {collapsed ? <PanelLeftOpen className="mx-auto size-[18px]" /> : <><PanelLeftClose className="size-[18px]" /> Collapse</>}
        </button>
      </aside>

      <main className="min-w-0 flex-1 pb-20 md:pb-0">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card md:hidden">
        {NAV.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            className={cn("flex flex-1 flex-col items-center gap-1 py-2 text-[10px] text-muted-foreground", active(n.to) && "text-primary")}
          >
            <n.icon className="size-5" />
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border px-6 py-6 md:px-10">
      <div>
        <h1 className="text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <ThemeButton />
      </div>
    </div>
  );
}

function ThemeButton() {
  const { settings, setTheme } = useVault();
  const dark = (settings?.theme ?? "dark") === "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      className="grid size-9 place-items-center rounded-lg border text-muted-foreground transition-colors hover:text-foreground"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: typeof Archive; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="surface flex flex-col items-center px-6 py-16 text-center">
      <div className="grid size-14 place-items-center rounded-2xl bg-accent text-accent-foreground">
        <Icon className="size-6" />
      </div>
      <h3 className="mt-4 text-xl">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{text}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
