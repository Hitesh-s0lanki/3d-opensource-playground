"use client";

/** One running (or finished) pipeline invocation: the current stage, the log
 * tail, and a Stop button while it is still alive.
 */

import { CircleCheck, CircleX, Clock, Loader2, OctagonX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import type { JobSnapshot } from "@/lib/types";

interface JobCardProps {
  job: JobSnapshot;
  onCancel: (id: string) => void;
}

export function JobCard({ job, onCancel }: JobCardProps) {
  const alive = job.state === "queued" || job.state === "running";
  const icon =
    job.state === "running" ? (
      <Loader2 className="size-3.5 animate-spin text-brand" />
    ) : job.state === "queued" ? (
      <Clock className="size-3.5 text-ink-muted" />
    ) : job.state === "done" ? (
      <CircleCheck className="size-3.5 text-moss" />
    ) : job.state === "failed" ? (
      <OctagonX className="size-3.5 text-danger" />
    ) : (
      <CircleX className="size-3.5 text-ink-muted" />
    );

  return (
    <div className="space-y-1.5 rounded-lg border bg-card p-2.5 text-xs shadow-xs">
      <div className="flex items-center gap-2">
        {icon}
        <span className="truncate font-medium">{job.image}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">{job.label}</span>
      </div>

      <div className="flex items-center gap-2 text-muted-foreground">
        <span
          className={cn(
            "truncate",
            job.state === "failed" && "text-danger",
            job.state === "done" && "text-moss",
          )}
        >
          {job.state === "queued"
            ? "queued"
            : job.stage || (job.state === "running" ? "starting…" : job.state)}
        </span>
        {job.elapsed > 0 && <span className="ml-auto shrink-0">{formatDuration(job.elapsed)}</span>}
        {alive && (
          <Button
            variant="destructive"
            size="xs"
            className="shrink-0"
            onClick={() => onCancel(job.id)}
          >
            Stop
          </Button>
        )}
      </div>

      {job.state === "failed" && job.error && (
        <p className="line-clamp-3 break-all font-mono text-[10px] text-danger">{job.error}</p>
      )}

      {job.log.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground">
            log
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            {job.log.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
