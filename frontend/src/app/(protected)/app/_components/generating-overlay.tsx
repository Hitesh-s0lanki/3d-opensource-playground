"use client";

/** The viewport while the cloud is still building a mesh.
 *
 * A generation runs for minutes, and the centre column used to say nothing at
 * all about it: the only sign of life was a shimmer bar in the sidebar, which
 * is the one panel a user collapses to look at their model. This is the
 * waiting room - the photo that was uploaded, under a scan sweep, so the wait
 * is visibly about *that* picture, plus the stage the pipeline last reported
 * and the clock it has been running against.
 *
 * The spinner is `ball-triangle` from Sam Herbert's SVG-Loaders
 * (github.com/SamHerbert/SVG-Loaders, MIT). It is inlined rather than served
 * out of `public/` so it inherits `currentColor` and reads on both grounds and
 * at any size - a raster GIF would be baked to one theme and one resolution,
 * and this palette flips its ink end to end at night.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import type { JobSnapshot } from "@/lib/types";
import { NotifyControl } from "./notify-control";

/** Three points trading places around a triangle. `still` drops the SMIL and
 * leaves the resting frame, for the reduced-motion readers that the stylesheet
 * cannot reach inside an SVG. */
function BallTriangle({ className, still }: { className?: string; still?: boolean }) {
  const orbit = { begin: "0s", dur: "2.2s", calcMode: "linear", repeatCount: "indefinite" };
  return (
    <svg
      viewBox="0 0 57 57"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
      className={className}
    >
      <g transform="translate(1 1)">
        <circle cx="5" cy="50" r="5">
          {!still && <animate attributeName="cx" values="5;27;49;5" {...orbit} />}
          {!still && <animate attributeName="cy" values="50;5;50;50" {...orbit} />}
        </circle>
        <circle cx="27" cy="5" r="5">
          {!still && <animate attributeName="cx" values="27;49;5;27" {...orbit} />}
          {!still && <animate attributeName="cy" values="5;50;50;5" {...orbit} />}
        </circle>
        <circle cx="49" cy="50" r="5">
          {!still && <animate attributeName="cx" values="49;5;27;49" {...orbit} />}
          {!still && <animate attributeName="cy" values="50;50;5;50" {...orbit} />}
        </circle>
      </g>
    </svg>
  );
}

/** Something to read on the third minute. Every line is a fact about the run
 * rather than filler - a hint that only says "hang tight" is worse than no
 * hint, because it takes the space where an answer could have been. */
const HINTS = [
  "The photo goes to a GPU that turns it into a watertight mesh — a couple of minutes is normal.",
  "First run in a while? The GPU has to cold-start; the ones after it pick up faster.",
  "Safe to switch away. Turn on alerts below and the model announces itself when it lands.",
  "Nothing to do meanwhile? Drop a .glb anywhere in this viewport to inspect it without touching the run.",
];
const HINT_INTERVAL = 7000;

/** Starts over for each job, because the caller keys this component by job id
 * - a new run gets the first hint, not whichever one the last run left up. */
function useRotatingHint(): string {
  const [at, setAt] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setAt((n) => (n + 1) % HINTS.length), HINT_INTERVAL);
    return () => clearInterval(timer);
  }, []);
  return HINTS[at];
}

/** The line the pipeline is on. `stage` is empty until the job has actually
 * been handed to the GPU, so queued and just-started both need their own word
 * rather than a blank. */
function stageLabel(job: JobSnapshot): string {
  if (job.state === "queued") return "waiting for a slot";
  return job.stage || "starting up";
}

interface GeneratingOverlayProps {
  job: JobSnapshot;
  /** How many other jobs are alive behind this one. */
  others: number;
  /** Compact mode: a model is already on the stage, so this is a pill in the
   * corner rather than a takeover of the viewport. */
  compact?: boolean;
}

export function GeneratingOverlay({ job, others, compact }: GeneratingOverlayProps) {
  const still = usePrefersReducedMotion();
  const hint = useRotatingHint();
  const stage = stageLabel(job);

  if (compact) {
    // Desktop only. On a phone the top strip already belongs to the stats chip,
    // and the header there carries its own live-job dot - two overlapping
    // badges over a 3D viewport is worse than one.
    return (
      <div
        className="pointer-events-none absolute left-1/2 top-3 z-10 hidden max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2 rounded-xl border border-line-strong bg-surface/90 px-3 py-1.5 text-[11px] shadow-sm backdrop-blur sm:flex"
        role="status"
        aria-live="polite"
      >
        <BallTriangle className="size-4 shrink-0 text-brand" still={still} />
        <span className="truncate font-medium text-ink">{job.image}</span>
        <span className="truncate text-ink-muted">{stage}</span>
        {job.elapsed > 0 && (
          <span className="shrink-0 tabular-nums text-ink-muted">
            {formatDuration(job.elapsed)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6 text-center"
      role="status"
      aria-live="polite"
    >
      {/* The source photo, being read. The sweep is the only thing on this
          screen that moves at a fixed rate, which is the point: the stage text
          below can sit still for a minute at a time and the panel still has to
          look like it is doing something. */}
      <div className="relative size-32 shrink-0 overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-sm sm:size-40">
        {job.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={job.image_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full bg-paper-deep" />
        )}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-1/2 animate-scan bg-gradient-to-b from-transparent to-brand/35">
            <span className="absolute inset-x-0 bottom-0 h-px bg-brand/80" />
          </div>
        </div>
      </div>

      <BallTriangle className="size-9 text-brand" still={still} />

      <div className="max-w-sm">
        <h2 className="font-display text-xl font-semibold text-ink sm:text-2xl">
          {job.state === "queued" ? "Queued for a GPU" : "Building your model"}
        </h2>
        <p className="mt-1 truncate text-sm text-ink-soft">{job.image}</p>
        <p className="mt-0.5 text-xs text-ink-muted">
          {stage}
          {job.elapsed > 0 && <span className="tabular-nums"> · {formatDuration(job.elapsed)}</span>}
        </p>
      </div>

      {/* The pipeline reports a stage, not a percentage, so the bar says "still
          moving" rather than pretending to know how far along it is - same
          bargain the job card in the sidebar strikes. */}
      <div
        className="h-1 w-52 overflow-hidden rounded-full bg-line-strong"
        role="progressbar"
        aria-label={`${job.image}: ${stage}`}
      >
        <div className={cn("h-full w-2/3 rounded-full bg-brand", !still && "animate-shimmer")} />
      </div>

      <p className="min-h-8 max-w-sm text-xs leading-relaxed tracking-wide text-ink-muted">{hint}</p>

      {/* Asked here rather than on page load, because here is where the
          question makes sense: the user is looking at a bar that will not move
          for another two minutes, and the answer to "can I go away" is yes. */}
      <NotifyControl />

      {others > 0 && (
        <p className="text-[11px] text-ink-muted">
          {others} other run{others === 1 ? "" : "s"} still going
        </p>
      )}
    </div>
  );
}
