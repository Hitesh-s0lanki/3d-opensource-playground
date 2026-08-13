"use client";

/** The left column: every run under outputs/, newest first, plus the queue of
 * jobs currently producing new ones. Each card carries the run's story in one
 * glance - what it is, what came out of it, and when.
 */

import { useMemo, useState } from "react";
import { Box, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatBytes, timeAgo } from "@/lib/format";
import type { JobSnapshot, Run } from "@/lib/types";
import { JobCard } from "./job-card";
import { Logo } from "./logo";

interface RunSidebarProps {
  runs: Run[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  jobs: JobSnapshot[];
  onCancelJob: (id: string) => void;
  onNew: () => void;
  canGenerate: boolean;
  db: { enabled: boolean; synced: boolean };
}

const KIND_BADGE: Record<Run["kind"], string> = {
  room: "bg-brand/10 text-brand-deep",
  scene: "bg-honey/15 text-[#92610f]",
  object: "bg-box/10 text-box",
  images: "bg-danger/10 text-danger",
};

function thumbnail(run: Run): string | null {
  if (run.photo?.url) return run.photo.url;
  for (const item of run.items) if (item.crop?.url) return item.crop.url;
  return null;
}

function newest(run: Run): number {
  const stamps = run.render ? [run.render.mtime] : [];
  for (const item of run.items) if (item.mesh) stamps.push(item.mesh.mtime);
  return stamps.length ? Math.max(...stamps) : 0;
}

/** One line saying what this run actually is - the "model description". */
function describe(run: Run): string {
  const size = run.render ? formatBytes(run.render.bytes) : null;
  switch (run.kind) {
    case "room": {
      const placed = run.items.filter((item) => item.status === "placed").length;
      const dropped = run.items.filter((item) => item.status === "dropped").length;
      const objects = dropped ? `${placed} placed · ${dropped} dropped` : `${placed} objects placed`;
      return size ? `${objects} · ${size}` : `${objects} · not assembled`;
    }
    case "scene": {
      const objects = `${run.items.length} object${run.items.length === 1 ? "" : "s"}, hand-assembled`;
      return size ? `${objects} · ${size}` : objects;
    }
    case "object":
      return size ? `single mesh · ${size}` : "single mesh";
    case "images":
      return `${run.items.length} crop${run.items.length === 1 ? "" : "s"} · run did not finish`;
  }
}

export function RunSidebar({
  runs,
  selectedId,
  onSelect,
  jobs,
  onCancelJob,
  onNew,
  canGenerate,
  db,
}: RunSidebarProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter((run) => run.id.toLowerCase().includes(needle));
  }, [runs, query]);

  const totalMeshes = useMemo(
    () =>
      runs.reduce(
        (sum, run) => sum + (run.render ? 1 : 0) + run.items.filter((item) => item.mesh).length,
        0,
      ),
    [runs],
  );

  // Finished jobs stay visible (they explain where a run came from), but the
  // live ones matter most, so they sort first.
  const orderedJobs = [...jobs].reverse().sort((a, b) => {
    const weight = (job: JobSnapshot) =>
      job.state === "running" ? 0 : job.state === "queued" ? 1 : 2;
    return weight(a) - weight(b);
  });

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r bg-sidebar">
      {/* masthead */}
      <header className="border-b px-4 pb-3.5 pt-4">
        <div className="flex items-center gap-3">
          <Logo className="size-10 shrink-0 drop-shadow-sm" />
          <div className="min-w-0">
            <h1 className="font-display text-[23px] font-bold leading-none tracking-[0.01em] text-ink">
              diorama
            </h1>
            <p className="mt-1 text-[11px] font-medium tracking-wide text-ink-muted">
              turn photos into 3D scenes
            </p>
          </div>
        </div>

        <Button size="sm" className="mt-3.5 w-full shadow-xs" onClick={onNew} disabled={!canGenerate}>
          <Plus data-icon="inline-start" /> New run
        </Button>

        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter runs…"
            className="h-8 border-line bg-surface pl-8 text-xs shadow-none"
          />
        </div>
      </header>

      {orderedJobs.length > 0 && (
        <div className="space-y-2 border-b p-3">
          <p className="kicker text-brand">Jobs</p>
          {orderedJobs.slice(0, 4).map((job) => (
            <JobCard key={job.id} job={job} onCancel={onCancelJob} />
          ))}
        </div>
      )}

      <div className="flex items-baseline justify-between px-4 pb-1 pt-3">
        <p className="kicker">Runs</p>
        <span className="text-[10px] tabular-nums text-ink-muted">
          {filtered.length === runs.length ? runs.length : `${filtered.length} / ${runs.length}`}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-2 pb-2">
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-ink-muted">
              {runs.length === 0
                ? `Nothing under outputs/ yet.${canGenerate ? " Click New run, or drop an image onto the viewport." : ""}`
                : "No run matches that filter."}
            </p>
          )}
          {filtered.map((run) => {
            const thumb = thumbnail(run);
            const stamp = newest(run);
            const active = run.id === selectedId;
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelect(run.id)}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-xl border p-2 text-left transition-all",
                  active
                    ? "border-brand/35 bg-surface shadow-sm ring-1 ring-brand/25"
                    : "border-transparent hover:border-line hover:bg-surface/70",
                )}
              >
                <div
                  className={cn(
                    "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-paper-deep transition-colors",
                    active ? "border-brand/30" : "border-line-strong",
                  )}
                >
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <Box className="size-5 text-ink-muted" strokeWidth={1.5} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-display min-w-0 flex-1 truncate text-[15px] font-bold leading-tight text-ink">
                      {run.id}
                    </p>
                    <Badge
                      className={cn(
                        "shrink-0 border-transparent px-1.5 py-0 text-[10px]",
                        KIND_BADGE[run.kind],
                      )}
                    >
                      {run.kind}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] leading-snug text-ink-soft">
                    {describe(run)}
                  </p>
                  {stamp > 0 && (
                    <p className="mt-0.5 text-[10px] text-ink-muted">{timeAgo(stamp)}</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>

      <footer className="flex items-center justify-between border-t px-4 py-2 text-[10px] text-ink-muted">
        <span>
          {runs.length} run{runs.length === 1 ? "" : "s"} · {totalMeshes} mesh
          {totalMeshes === 1 ? "" : "es"}
        </span>
        <span className="flex items-center gap-2.5">
          {db.enabled && (
            <span
              className="flex items-center gap-1"
              title={db.synced ? "catalog synced to Neon" : "Neon sync failing - see server log"}
            >
              <span
                className={cn(
                  "inline-block size-1.5 rounded-full",
                  db.synced ? "bg-moss" : "bg-honey",
                )}
              />
              neon
            </span>
          )}
          <span className="font-mono">outputs/</span>
        </span>
      </footer>

      {!canGenerate && (
        <p className="border-t p-3 text-[11px] text-ink-muted">
          Browse-only: no Python venv found. Run setup.ps1 in the repo root to enable generation.
        </p>
      )}
    </aside>
  );
}
