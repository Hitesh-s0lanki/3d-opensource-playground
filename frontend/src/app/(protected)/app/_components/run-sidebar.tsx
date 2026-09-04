"use client";

/** The left column: one list of the account's work, newest first. A run that
 * has finished is a card you can open; a run still being generated is the same
 * card in its loading state, and it turns into the real one when it lands.
 * There is no separate queue to read, and no log to decipher.
 *
 * The same component is the phone layout's slide-over, so it fills its
 * container rather than setting its own width.
 */

import { useMemo, useState } from "react";
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { Box, Keyboard, Plus, Search, WifiOff, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatBytes, timeAgo } from "@/lib/format";
import type { CreditsSnapshot, JobSnapshot, Run, RunKind } from "@/lib/types";
import { JobCard } from "./job-card";
import { NotifyControl } from "./notify-control";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";

interface RunSidebarProps {
  runs: Run[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  jobs: JobSnapshot[];
  onCancelJob: (id: string) => void;
  onNew: () => void;
  /** Why a new run cannot be started, or null when it can. */
  generateBlocked: string | null;
  /** The free allowance, or null until the first poll answers. */
  credits: CreditsSnapshot | null;
  db: { enabled: boolean; synced: boolean };
  /** The first catalog read has not landed yet. */
  loading: boolean;
  /** Polling has been failing; the list on screen may be stale. */
  offline: boolean;
  onShowShortcuts: () => void;
}

const KIND_BADGE: Record<RunKind, string> = {
  room: "bg-brand/10 text-brand-deep",
  scene: "bg-honey/15 text-honey-ink",
  object: "bg-box/10 text-box",
  images: "bg-danger/10 text-danger",
};

const KIND_ORDER: RunKind[] = ["room", "scene", "object", "images"];

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

/** Everything about a run a search could reasonably mean: its id, its kind,
 * and the labels the detector put on the things inside it. Filtering on the id
 * alone meant you could see "chair" in the panel and not find it by typing it. */
function haystack(run: Run): string {
  const parts = [run.id, run.kind, run.photo?.name ?? ""];
  for (const item of run.items) {
    parts.push(item.name);
    if (item.label) parts.push(item.label);
  }
  return parts.join(" ").toLowerCase();
}

/** The allowance, spent left to right. Pips rather than a percentage: five is
 * few enough to count at a glance, and counting is what the user is doing. */
function CreditsMeter({ credits }: { credits: CreditsSnapshot }) {
  const { granted, remaining } = credits;
  const out = remaining <= 0;
  return (
    <div className="mt-2.5 rounded-lg border border-line-strong bg-surface px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="kicker text-ink-muted">Credits</span>
        <span
          className={cn(
            "text-[11px] font-semibold tabular-nums",
            out ? "text-danger" : "text-ink",
          )}
        >
          {remaining} of {granted} left
        </span>
      </div>
      <div className="mt-1.5 flex gap-1" aria-hidden>
        {granted <= 10 ? (
          Array.from({ length: granted }, (_, index) => (
            <span
              key={index}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors",
                index < remaining ? "bg-brand" : "bg-line-strong",
              )}
            />
          ))
        ) : (
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line-strong">
            <span
              className="block h-full rounded-full bg-brand"
              style={{ width: `${Math.round((remaining / granted) * 100)}%` }}
            />
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-tight text-ink-muted">
        {out
          ? "You have used every free generation on this account."
          : "One per generation. Failed and cancelled runs are refunded."}
      </p>
    </div>
  );
}

function RunSkeleton() {
  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-transparent p-2">
      <div className="size-12 shrink-0 animate-shimmer rounded-lg bg-line-strong" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="h-3 w-2/3 animate-shimmer rounded bg-line-strong" />
        <div className="h-2.5 w-full animate-shimmer rounded bg-line" />
        <div className="h-2.5 w-1/3 animate-shimmer rounded bg-line" />
      </div>
    </div>
  );
}

export function RunSidebar({
  runs,
  selectedId,
  onSelect,
  jobs,
  onCancelJob,
  onNew,
  generateBlocked,
  credits,
  db,
  loading,
  offline,
  onShowShortcuts,
}: RunSidebarProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<RunKind | null>(null);
  /** Failed generations the user has waved away. Browser-local: the row stays
   * on the server, it just stops occupying the list. */
  const [dismissed, setDismissed] = useState<string[]>([]);

  /** Which kinds exist at all, so the filter row never offers a dead option. */
  const kinds = useMemo(() => {
    const counts = new Map<RunKind, number>();
    for (const run of runs) counts.set(run.kind, (counts.get(run.kind) ?? 0) + 1);
    return KIND_ORDER.filter((k) => counts.has(k)).map((k) => [k, counts.get(k)!] as const);
  }, [runs]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return runs.filter(
      (run) =>
        (kind === null || run.kind === kind) && (!needle || haystack(run).includes(needle)),
    );
  }, [runs, query, kind]);

  const totalMeshes = useMemo(
    () =>
      runs.reduce(
        (sum, run) => sum + (run.render ? 1 : 0) + run.items.filter((item) => item.mesh).length,
        0,
      ),
    [runs],
  );

  /** The jobs that still have something to say: the ones being generated, and
   * the ones that failed and have not been waved away. A finished job is not
   * one of them - its run is in the list below, which is the better card. */
  const pending = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...jobs]
      .reverse()
      .filter((job) => {
        if (job.state === "done" || job.state === "cancelled") return false;
        if (job.state === "failed" && dismissed.includes(job.id)) return false;
        if (kind !== null && kind !== job.kind) return false;
        return !needle || job.image.toLowerCase().includes(needle);
      })
      .sort((a, b) => {
        const weight = (job: JobSnapshot) =>
          job.state === "running" ? 0 : job.state === "queued" ? 1 : 2;
        return weight(a) - weight(b);
      });
  }, [jobs, dismissed, kind, query]);

  const generating = pending.filter(
    (job) => job.state === "running" || job.state === "queued",
  ).length;

  const filtering = query.trim().length > 0 || kind !== null;
  const outOfCredits = credits !== null && credits.remaining <= 0;

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-sidebar">
      {/* masthead */}
      {/* Inside the phone sheet the panel gains a close button in that corner,
          so the masthead controls step aside for it. */}
      <header className="border-b px-4 pb-3.5 pt-4 [[data-slot=sheet-content]_&]:pr-12">
        <div className="flex items-center gap-3">
          <Logo className="size-11 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[23px] font-bold leading-none tracking-[-0.02em] text-ink">
              dioramic
            </h1>
            <p className="mt-1 truncate text-[11px] font-medium tracking-wide text-ink-muted">
              turn photos into 3D scenes
            </p>
          </div>
          <ThemeToggle className="size-8 shrink-0 text-ink-muted" />
          {/* account: sign in / sign up while signed out, avatar menu once in */}
          <Show when="signed-in">
            <UserButton />
          </Show>
        </div>

        <Show when="signed-out">
          <div className="mt-3.5 flex gap-2">
            <SignInButton mode="modal">
              <Button size="sm" variant="outline" className="flex-1 shadow-xs">
                Sign in
              </Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <Button size="sm" className="flex-1 shadow-xs">
                Sign up
              </Button>
            </SignUpButton>
          </div>
        </Show>

        <Button
          size="lg"
          className="mt-3.5 w-full shadow-xs"
          onClick={onNew}
          disabled={Boolean(generateBlocked) || outOfCredits}
          title={generateBlocked ?? (outOfCredits ? "No credits left" : undefined)}
        >
          <Plus data-icon="inline-start" /> New run
        </Button>

        <Show when="signed-in">{credits && <CreditsMeter credits={credits} />}</Show>

        <div className="relative mt-2">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter runs by id, kind or detected object"
            placeholder="Filter runs, objects…"
            className="h-9 border-line bg-surface pl-8 pr-8 text-xs shadow-none"
          />
          {query && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear filter"
              className="absolute right-1 top-1/2 -translate-y-1/2 text-ink-muted"
              onClick={() => setQuery("")}
            >
              <X />
            </Button>
          )}
        </div>

        {kinds.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {kinds.map(([value, count]) => {
              const on = kind === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setKind(on ? null : value)}
                  className={cn(
                    "focus-ring rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                    on
                      ? "border-brand/40 bg-brand/10 text-brand-deep"
                      : "border-line-strong bg-surface text-ink-muted hover:text-ink",
                  )}
                >
                  {value} <span className="tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </header>

      {offline && (
        <p
          role="status"
          className="flex items-center gap-2 border-b bg-honey/10 px-4 py-2 text-[11px] text-honey-ink"
        >
          <WifiOff className="size-3.5 shrink-0" aria-hidden />
          Cannot reach the server — showing the last catalog it sent.
        </p>
      )}

      <div className="flex items-baseline gap-2 px-4 pb-1 pt-3">
        <p className="kicker">Runs</p>
        {generating > 0 && (
          <span className="rounded-full bg-brand/12 px-1.5 text-[10px] font-semibold tabular-nums text-brand-deep">
            {generating} generating
          </span>
        )}
        <span className="ml-auto text-[11px] tabular-nums text-ink-muted">
          {filtered.length === runs.length ? runs.length : `${filtered.length} / ${runs.length}`}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-2 pb-2">
          {/* Work in flight, in the place its finished run will appear. */}
          {pending.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onCancel={onCancelJob}
              onDismiss={(id) => setDismissed((ids) => [...ids, id])}
            />
          ))}

          {loading && (
            <div aria-hidden className="space-y-1">
              <RunSkeleton />
              <RunSkeleton />
              <RunSkeleton />
            </div>
          )}

          {!loading && filtered.length === 0 && pending.length === 0 && (
            <div className="px-2 py-8 text-center">
              <p className="text-xs leading-relaxed text-ink-muted">
                {runs.length === 0
                  ? `No runs yet.${generateBlocked ? "" : " Start one, or drop an image onto the viewport."}`
                  : "No run matches that filter."}
              </p>
              {runs.length === 0 && !generateBlocked && (
                <Button size="sm" variant="outline" className="mt-3" onClick={onNew}>
                  <Plus data-icon="inline-start" /> New run
                </Button>
              )}
              {runs.length > 0 && filtering && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-3"
                  onClick={() => {
                    setQuery("");
                    setKind(null);
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
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
                aria-current={active ? "true" : undefined}
                className={cn(
                  "focus-ring group flex w-full items-center gap-3 rounded-xl border p-2 text-left transition-colors",
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
                    <Box className="size-5 text-ink-muted" strokeWidth={1.5} aria-hidden />
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
                    <p className="mt-0.5 text-[11px] text-ink-muted">{timeAgo(stamp)}</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>

      <footer className="flex items-center justify-between gap-2 border-t px-4 py-2 text-[11px] text-ink-muted pb-safe">
        <span className="tabular-nums">
          {runs.length} run{runs.length === 1 ? "" : "s"} · {totalMeshes} mesh
          {totalMeshes === 1 ? "" : "es"}
        </span>
        <span className="flex items-center gap-2.5">
          {/* The same switch the waiting room offers, kept somewhere permanent
              so it can be turned back off without visiting site settings. */}
          <NotifyControl variant="footer" />
          <button
            type="button"
            onClick={onShowShortcuts}
            className="focus-ring flex items-center gap-1 rounded hover:text-ink"
          >
            <Keyboard className="size-3.5" aria-hidden /> keys
          </button>
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
          <span className="font-mono">blob</span>
        </span>
      </footer>

      {generateBlocked && (
        <p className="border-t p-3 text-[11px] leading-relaxed text-ink-muted">
          Browse-only: {generateBlocked}
        </p>
      )}
    </aside>
  );
}
