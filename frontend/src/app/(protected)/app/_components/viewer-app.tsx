"use client";

/** The whole inspector: sidebar of runs, the 3D stage, and the detail column.
 * Polls /api/runs and /api/jobs, so new results appear on their own - no
 * refresh needed. A generation in flight is shown as a loading run in that one
 * sidebar list, not as a separate queue.
 *
 * Three columns on a desktop, either of the side ones collapsible; on a phone
 * the same two panels become slide-overs so the viewport keeps the screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Info, Layers, PanelLeft, PanelRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CreditsSnapshot, JobSnapshot, JobsPayload, Run, RunsPayload } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import { chime, raiseAlert, useTitleBadge } from "@/lib/notify";
import { useMediaQuery } from "@/lib/use-media-query";
import { DetailPanel } from "./detail-panel";
import { Logo } from "@/components/logo";
import { NewRunDialog } from "./new-run-dialog";
import { RunSidebar } from "./run-sidebar";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { Stage } from "./stage";
import { ThemeToggle } from "@/components/theme-toggle";

const RUNS_INTERVAL = 5000;
const JOBS_INTERVAL = 2000;
/** How often a backgrounded tab still asks about a generation in flight.
 *
 * Not zero, which is what it used to be. GET /api/jobs is not only how the
 * viewer learns a job finished, it is what moves the finished Modal call into
 * blob storage - so a tab that stops polling is a run that stops finishing,
 * and switching away for a coffee meant coming back to a job that had waited
 * for you. Slow enough that a hidden tab costs a handful of requests a minute,
 * and only ticked while something is actually running. */
const HIDDEN_INTERVAL = 15000;
/** Consecutive failures before the sidebar admits the catalog may be stale. */
const OFFLINE_AFTER = 3;

export function ViewerApp() {
  const [payload, setPayload] = useState<RunsPayload | null>(null);
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  // Rides along with the jobs poll, so a refund shows up within a tick of the
  // job that earned it turning red.
  const [credits, setCredits] = useState<CreditsSnapshot | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [droppedImage, setDroppedImage] = useState<File | null>(null);
  const [failures, setFailures] = useState(0);
  /** Runs that landed while the tab was in the background and have not been
   * looked at yet. Drives the count in the tab title, and is cleared the
   * moment the user comes back to the page. */
  const [unseen, setUnseen] = useState(0);

  // Panel visibility. The desktop pair are user preferences; the phone pair are
  // transient sheets, closed again as soon as there is room for real columns.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [detailOpen, setDetailOpen] = useState(true);
  const [runsSheet, setRunsSheet] = useState(false);
  const [detailSheet, setDetailSheet] = useState(false);
  const desktop = useMediaQuery("(min-width: 1024px)");

  // A run to jump to once the catalog has it - set when its job finishes.
  const pendingJump = useRef<string | null>(null);
  const knownJobStates = useRef<Map<string, string>>(new Map());
  /** Whether anything is still out at the GPU, read by the poll loop without
   * making it a dependency - a timer that restarts on every jobs answer is a
   * timer that never fires. */
  const anyLive = useRef(false);
  /** ?run=&item= is honoured once, against the first catalog that arrives. */
  const linkApplied = useRef(false);

  const refreshRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) return;
      const next = (await res.json()) as RunsPayload;
      setPayload(next);
      setFailures(0);
      if (!linkApplied.current) {
        linkApplied.current = true;
        const params = new URLSearchParams(window.location.search);
        const target = next.runs.find((run) => run.id === params.get("run"));
        const item = params.get("item");
        if (target) {
          setSelectedRunId(target.id);
          if (item && target.items.some((candidate) => candidate.name === item)) {
            setSelectedItem(item);
          }
        }
      }
      if (pendingJump.current) {
        const target = next.runs.find((run) => run.id === pendingJump.current);
        if (target) {
          pendingJump.current = null;
          setSelectedRunId(target.id);
          setSelectedItem(null);
        }
      }
    } catch {
      /* server briefly away; the next poll catches up */
      setFailures((count) => count + 1);
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      if (!res.ok) return;
      const { jobs: next, credits: balance } = (await res.json()) as JobsPayload;
      setJobs(next);
      setCredits(balance);
      anyLive.current = next.some((job) => job.state === "running" || job.state === "queued");

      for (const job of next) {
        const before = knownJobStates.current.get(job.id);
        if (before === job.state) continue;
        knownJobStates.current.set(job.id, job.state);
        if (before === undefined) continue; // first sighting, not a transition

        // A run that ends while the tab is elsewhere is the case this whole
        // path exists for: the toast lands in a page nobody is looking at, so
        // it also goes out through the OS, the tab title, and a chime.
        const away = document.hidden || !document.hasFocus();
        const open = () => {
          pendingJump.current = job.run_id;
          setSelectedRunId(job.run_id);
          setSelectedItem(null);
          setUnseen(0);
          void refreshRuns();
        };

        if (job.state === "done") {
          // Longer than the default four seconds: this one is worth reading
          // even if you looked back at the tab a moment after it appeared.
          toast.success(`${job.image} finished`, {
            description: job.label,
            duration: 10000,
            action: { label: "Open", onClick: open },
          });
          pendingJump.current = job.run_id;
          void refreshRuns();
          if (away) {
            setUnseen((count) => count + 1);
            raiseAlert({
              title: "Your model is ready",
              body: `${job.image} finished in ${formatDuration(job.elapsed)}. Click to open it.`,
              tag: job.id,
              image: job.image_url || undefined,
              onClick: open,
            });
            chime();
          }
        } else if (job.state === "failed") {
          const reason = job.error ? `${job.error} · credit refunded` : "credit refunded";
          toast.error(`${job.image} failed`, { description: reason, duration: 10000 });
          if (away) {
            raiseAlert({
              title: `${job.image} could not be generated`,
              body: reason,
              tag: job.id,
              image: job.image_url || undefined,
            });
          }
        }
      }
    } catch {
      /* ditto */
    }
  }, [refreshRuns]);

  // Self-scheduling rather than setInterval, because the cadence depends on
  // what the last tick found: polling a job queue every two seconds in a tab
  // nobody is looking at spends the user's battery on nothing, and stopping
  // dead was the other extreme - see HIDDEN_INTERVAL.
  useEffect(() => {
    let stopped = false;
    let runsTimer: ReturnType<typeof setTimeout> | undefined;
    let jobsTimer: ReturnType<typeof setTimeout> | undefined;
    /** Bumped whenever the loops are restarted. A tick that was already
     * awaiting its fetch when that happened must retire instead of scheduling
     * itself again, or coming back to the tab leaves two loops running. */
    let epoch = 0;

    // The catalog only changes when a job lands, and the job poll refreshes it
    // itself when one does - so a hidden tab can skip this entirely.
    const tickRuns = async (mine: number) => {
      if (!document.hidden) await refreshRuns();
      if (stopped || mine !== epoch) return;
      runsTimer = setTimeout(
        () => void tickRuns(mine),
        document.hidden ? HIDDEN_INTERVAL : RUNS_INTERVAL,
      );
    };

    const tickJobs = async (mine: number) => {
      if (!document.hidden || anyLive.current) await refreshJobs();
      if (stopped || mine !== epoch) return;
      jobsTimer = setTimeout(
        () => void tickJobs(mine),
        document.hidden ? HIDDEN_INTERVAL : JOBS_INTERVAL,
      );
    };

    // Back on screen: catch up now rather than at the end of a 15s wait, and
    // let whatever landed while away stop announcing itself.
    const onVisibility = () => {
      if (document.hidden) return;
      setUnseen(0);
      clearTimeout(runsTimer);
      clearTimeout(jobsTimer);
      epoch += 1;
      void tickRuns(epoch);
      void tickJobs(epoch);
    };

    void tickRuns(epoch);
    void tickJobs(epoch);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(runsTimer);
      clearTimeout(jobsTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, [refreshRuns, refreshJobs]);

  const runs = useMemo(() => payload?.runs ?? [], [payload]);

  const run: Run | null =
    runs.find((candidate) => candidate.id === selectedRunId) ?? runs[0] ?? null;

  // Keep the address bar in step, so a view can be shared or reloaded.
  useEffect(() => {
    if (!run) return;
    const params = new URLSearchParams();
    params.set("run", run.id);
    if (selectedItem) params.set("item", selectedItem);
    const next = `${window.location.pathname}?${params}`;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", next);
    }
  }, [run, selectedItem]);

  // What the stage shows: the selected object's mesh, else the whole render.
  const item = run?.items.find((candidate) => candidate.name === selectedItem) ?? null;
  const stageSrc = item?.mesh?.url ?? (item ? null : (run?.render?.url ?? null));
  const stageName = item ? `${run?.id} / ${item.name}` : (run?.render?.name ?? run?.id ?? null);
  const download = item?.mesh?.url
    ? { url: item.mesh.url, name: item.mesh.name }
    : !item && run?.render?.url
      ? { url: run.render.url, name: run.render.name }
      : null;

  // ↑/↓ walk the run: whole scene first, then each object that has a mesh.
  const sequence = useMemo(() => {
    if (!run) return [] as (string | null)[];
    const steps: (string | null)[] = run.render ? [null] : [];
    for (const candidate of run.items) if (candidate.mesh?.url) steps.push(candidate.name);
    return steps;
  }, [run]);

  const onStep = useCallback(
    (direction: 1 | -1) => {
      if (sequence.length < 2) return;
      const at = sequence.indexOf(selectedItem);
      const next = sequence[(at + direction + sequence.length) % sequence.length];
      setSelectedItem(next);
    },
    [sequence, selectedItem],
  );

  const selectRun = useCallback((id: string) => {
    setSelectedRunId(id);
    setSelectedItem(null);
    setRunsSheet(false);
  }, []);

  /** A click inside the 3D scene. Only meaningful while the whole assembled
   * render is on stage - once one object is isolated there is nothing to pick. */
  const onPickPart = useCallback(
    (name: string | null) => {
      if (!run) return;
      if (name && run.items.some((candidate) => candidate.name === name)) setSelectedItem(name);
      else if (!name) setSelectedItem(null);
    },
    [run],
  );

  const cancelJob = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      if (!res.ok) toast.error("Could not stop that job");
      void refreshJobs();
    },
    [refreshJobs],
  );

  const onDropImage = useCallback((file: File) => {
    setDroppedImage(file);
    setDialogOpen(true);
  }, []);

  const openNew = useCallback(() => {
    setDroppedImage(null);
    setDialogOpen(true);
    setRunsSheet(false);
  }, []);

  /** The runs still out at the GPU, newest first and running ahead of queued,
   * so the viewport's waiting room shows the one the user just started rather
   * than whichever row the API happened to hand back first. `sort` is stable,
   * so the reverse survives inside each group. */
  const liveJobs = useMemo(
    () =>
      [...jobs]
        .reverse()
        .filter((job) => job.state === "running" || job.state === "queued")
        .sort((a, b) => Number(a.state === "queued") - Number(b.state === "queued")),
    [jobs],
  );

  // The tab strip does the work the toast cannot: it is still there in an hour,
  // and it is visible from whatever the user switched to. What is cooking,
  // then what is ready and unread - which wins, because it is the news.
  useTitleBadge(
    unseen > 0
      ? `(${unseen}) ✅ ready`
      : liveJobs.length > 0
        ? `(${liveJobs.length}) generating…`
        : null,
  );

  const outOfCredits = credits !== null && credits.remaining <= 0;

  const sidebar = (
    <RunSidebar
      runs={runs}
      selectedId={run?.id ?? null}
      onSelect={selectRun}
      jobs={jobs}
      onCancelJob={cancelJob}
      onNew={openNew}
      // Until the first /api/runs answer lands - and if it never does,
      // because the catalog is down - the button stays live: submitting is a
      // separate path, and a real error beats a dead control.
      generateBlocked={payload ? payload.generate_blocked : null}
      credits={credits}
      db={payload?.db ?? { enabled: false, synced: false }}
      loading={payload === null && failures === 0}
      offline={failures >= OFFLINE_AFTER}
      onShowShortcuts={() => setShortcutsOpen(true)}
    />
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground lg:flex-row">
      {/* Phone chrome. The panels are one tap away rather than on screen,
          because a 320px column beside a 3D viewport leaves neither usable. */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b bg-sidebar px-2 lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="relative size-9"
          aria-label="Runs"
          onClick={() => setRunsSheet(true)}
        >
          <Layers />
          {liveJobs.length > 0 && (
            <span className="absolute right-1 top-1 size-2 rounded-full bg-brand ring-2 ring-sidebar" />
          )}
        </Button>
        <Logo className="size-7 shrink-0" />
        <span className="font-display min-w-0 flex-1 truncate text-lg font-bold leading-none text-ink">
          {run?.id ?? "dioramic"}
        </span>
        <ThemeToggle className="size-9 text-ink-muted" />
        {run && (
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Run details"
            onClick={() => setDetailSheet(true)}
          >
            <Info />
          </Button>
        )}
        <Button
          size="icon"
          className="size-9"
          aria-label="New run"
          onClick={openNew}
          disabled={Boolean(payload?.generate_blocked) || outOfCredits}
        >
          <Plus />
        </Button>
      </header>

      <div
        className={cn(
          "hidden shrink-0 overflow-hidden border-r transition-[width] duration-200 lg:block",
          sidebarOpen ? "w-80" : "w-0 border-r-0",
        )}
      >
        <div className="h-full w-80">{sidebar}</div>
      </div>

      <main className="relative flex min-h-0 min-w-0 flex-1">
        {/* Desktop column toggles. Collapsing both turns the page into a
            full-bleed viewer without leaving it. */}
        <div className="absolute left-3 top-3 z-20 hidden items-center gap-0.5 rounded-xl border border-line-strong bg-surface/90 p-1 shadow-sm backdrop-blur lg:flex">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={sidebarOpen ? "Hide the run list" : "Show the run list"}
                  aria-pressed={sidebarOpen}
                  onClick={() => setSidebarOpen((open) => !open)}
                />
              }
            >
              <PanelLeft />
            </TooltipTrigger>
            <TooltipContent>{sidebarOpen ? "Hide runs" : "Show runs"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={detailOpen ? "Hide the detail panel" : "Show the detail panel"}
                  aria-pressed={detailOpen}
                  disabled={!run}
                  onClick={() => setDetailOpen((open) => !open)}
                />
              }
            >
              <PanelRight />
            </TooltipTrigger>
            <TooltipContent>{detailOpen ? "Hide details" : "Show details"}</TooltipContent>
          </Tooltip>
        </div>

        <Stage
          src={stageSrc}
          name={stageName}
          activePart={selectedItem}
          onPickPart={onPickPart}
          onStep={sequence.length > 1 ? onStep : null}
          onDropImage={onDropImage}
          onNew={openNew}
          download={download}
          onShowShortcuts={() => setShortcutsOpen(true)}
          liveJobs={liveJobs}
        />
      </main>

      {run && (
        <div
          className={cn(
            "hidden shrink-0 overflow-hidden border-l bg-sidebar transition-[width] duration-200 lg:block",
            detailOpen ? "w-88" : "w-0 border-l-0",
          )}
        >
          <div className="h-full w-88">
            <DetailPanel run={run} selected={selectedItem} onSelect={setSelectedItem} />
          </div>
        </div>
      )}

      {/* Phone panels */}
      <Sheet open={runsSheet && !desktop} onOpenChange={setRunsSheet}>
        <SheetContent side="left" title="Runs" className="p-0">
          {sidebar}
        </SheetContent>
      </Sheet>

      <Sheet open={detailSheet && !desktop} onOpenChange={setDetailSheet}>
        <SheetContent side="bottom" title="Run details" className="p-0">
          {run && (
            <div className="min-h-0 flex-1 overflow-hidden pt-8">
              <DetailPanel run={run} selected={selectedItem} onSelect={setSelectedItem} />
            </div>
          )}
        </SheetContent>
      </Sheet>

      <NewRunDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialFile={droppedImage}
        roomAvailable={payload?.room_available ?? false}
        stylizeAvailable={payload?.stylize_blocked === null}
        credits={credits}
        onSubmitted={() => void refreshJobs()}
      />

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
