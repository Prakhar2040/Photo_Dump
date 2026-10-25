import { createFileRoute, redirect } from "@tanstack/react-router";

// Backup now lives on the Import page; keep old links working.
export const Route = createFileRoute("/backup")({
  beforeLoad: () => {
    throw redirect({ to: "/import" });
  },
});
