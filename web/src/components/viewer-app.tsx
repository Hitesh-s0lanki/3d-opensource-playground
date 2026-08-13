"use client";

/** The whole inspector: sidebar of runs, the 3D stage, and the detail column.
 * Polls /api/runs and /api/jobs, so new results appear on their own - no
 * refresh needed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { JobSnapshot, Run, RunsPayload } from "@/lib/types";
import { DetailPanel } from "./detail-panel";
import { NewRunDialog } from "./new-run-dialog";
import { RunSidebar } from "./run-sidebar";
import { Stage } from "./stage";

const RUNS_INTERVAL = 5000;
const JOBS_INTERVAL = 2000;

export function ViewerApp() {
  const [payload, setPayload] = useState<RunsPayload | null>(null);
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [droppedImage, setDroppedImage] = useState<File | null>(null);

  // A run to jump to once discovery sees it - set when its job finishes.
  const pendingJump = useRef<string | null>(null);
  const knownJobStates = useRef<Map<string, string>>(new Map());

  const refreshRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) return;
      const next = (await res.json()) as RunsPayload;
      setPayload(next);
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
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      if (!res.ok) return;
      const { jobs: next } = (await res.json()) as { jobs: JobSnapshot[] };
      setJobs(next);

      for (const job of next) {
        const before = knownJobStates.current.get(job.id);
        if (before === job.state) continue;
        knownJobStates.current.set(job.id, job.state);
        if (before === undefined) continue; // first sighting, not a transition
        if (job.state === "done") {
          toast.success(`${job.image} finished`, { description: job.label });
          pendingJump.current = job.run_id;
          void refreshRuns();
        } else if (job.state === "failed") {
          toast.error(`${job.image} failed`, { description: job.error || undefined });
        }
      }
    } catch {
      /* ditto */
    }
  }, [refreshRuns]);

  useEffect(() => {
    void refreshRuns();
    void refreshJobs();
    const runsTimer = setInterval(refreshRuns, RUNS_INTERVAL);
    const jobsTimer = setInterval(refreshJobs, JOBS_INTERVAL);
    return () => {
      clearInterval(runsTimer);
      clearInterval(jobsTimer);
    };
  }, [refreshRuns, refreshJobs]);

  const runs = useMemo(() => payload?.runs ?? [], [payload]);
  const run: Run | null =
    runs.find((candidate) => candidate.id === selectedRunId) ?? runs[0] ?? null;

  // What the stage shows: the selected object's mesh, else the whole render.
  const item = run?.items.find((candidate) => candidate.name === selectedItem) ?? null;
  const stageSrc = item?.mesh?.url ?? (item ? null : (run?.render?.url ?? null));
  const stageName = item ? `${run?.id} / ${item.name}` : (run?.render?.name ?? run?.id ?? null);

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
  }, []);

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

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <RunSidebar
        runs={runs}
        selectedId={run?.id ?? null}
        onSelect={selectRun}
        jobs={jobs}
        onCancelJob={cancelJob}
        onNew={() => {
          setDroppedImage(null);
          setDialogOpen(true);
        }}
        canGenerate={payload?.can_generate ?? false}
        db={payload?.db ?? { enabled: false, synced: false }}
      />

      <main className="flex min-w-0 flex-1">
        <Stage
          src={stageSrc}
          name={stageName}
          onStep={sequence.length > 1 ? onStep : null}
          onDropImage={onDropImage}
        />
      </main>

      {run && (
        <div className="hidden w-88 shrink-0 border-l bg-sidebar lg:block">
          <DetailPanel run={run} selected={selectedItem} onSelect={setSelectedItem} />
        </div>
      )}

      <NewRunDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialFile={droppedImage}
        onSubmitted={() => void refreshJobs()}
      />
    </div>
  );
}
