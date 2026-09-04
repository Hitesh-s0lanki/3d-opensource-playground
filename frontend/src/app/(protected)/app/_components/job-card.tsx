"use client";

/** A generation that has not produced a run yet.
 *
 * It sits in the same list as the finished runs, in the same shape, so the
 * sidebar reads as one column of work rather than a queue plus a catalog:
 * this is what a run looks like while it is still being made. No stages, no
 * log - just the photo, the fact that it is moving, and a way to stop it.
 */

import { Loader2, ImageIcon, OctagonX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import type { JobSnapshot } from "@/lib/types";

interface JobCardProps {
  job: JobSnapshot;
  onCancel: (id: string) => void;
  /** Hide a failed card. Local to the browser: nothing server-side changes. */
  onDismiss: (id: string) => void;
}

/** The file name without its extension - `chair.heic` reads as `chair`. */
function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function JobCard({ job, onCancel, onDismiss }: JobCardProps) {
  const failed = job.state === "failed";

  return (
    <div
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border p-2",
        failed ? "border-danger/30 bg-danger/5" : "border-line bg-surface/60",
      )}
    >
      <div
        className={cn(
          "relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-paper-deep",
          failed ? "border-danger/25" : "border-line-strong",
        )}
      >
        {job.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={job.image_url}
            alt=""
            className={cn("h-full w-full object-cover", !failed && "opacity-55")}
            loading="lazy"
          />
        ) : (
          <ImageIcon className="size-5 text-ink-muted" strokeWidth={1.5} aria-hidden />
        )}
        {failed ? (
          <OctagonX
            className="absolute size-4 text-danger drop-shadow-sm"
            strokeWidth={2}
            aria-hidden
          />
        ) : (
          <Loader2 className="absolute size-4 animate-spin text-brand-deep" aria-hidden />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="font-display min-w-0 flex-1 truncate text-[15px] font-bold leading-tight text-ink">
            {stem(job.image)}
          </p>
          {!failed && job.elapsed > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-ink-muted">
              {formatDuration(job.elapsed)}
            </span>
          )}
        </div>

        <p
          className={cn(
            "mt-0.5 truncate text-[11px] leading-snug",
            failed ? "text-danger" : "text-ink-soft",
          )}
        >
          {failed ? (job.error || "generation failed") : "generating…"}
        </p>

        {/* The pipeline reports a stage, not a percentage, so the bar says
            "still moving" rather than pretending to know how far along it is. */}
        {!failed && (
          <div
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-line-strong"
            role="progressbar"
            aria-label={`${stem(job.image)}: generating`}
          >
            <div
              className={cn(
                "h-full rounded-full bg-brand",
                job.state === "running" ? "w-2/3 animate-shimmer" : "w-1/4 opacity-60",
              )}
            />
          </div>
        )}
        {failed && (
          <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">credit refunded</p>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-ink-muted hover:text-ink"
        aria-label={failed ? `Dismiss ${stem(job.image)}` : `Stop generating ${stem(job.image)}`}
        title={failed ? "Dismiss" : "Stop"}
        onClick={() => (failed ? onDismiss(job.id) : onCancel(job.id))}
      >
        <X />
      </Button>
    </div>
  );
}
